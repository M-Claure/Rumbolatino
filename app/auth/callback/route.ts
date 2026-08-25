import { NextResponse, type NextRequest } from "next/server";
import {
  callbackClient,
  callbackDestination,
  callbackFailure,
  failureFromQuery,
  guardCallbackRate,
  parseOtpType,
  syncEmployerRecord,
} from "@/lib/employers/auth-callback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /auth/callback?code=…&next=… — the PKCE code exchange.
 *
 * ── Why this exists alongside `/auth/confirm` ───────────────────────────────
 * Supabase's STOCK email templates send `{{ .ConfirmationURL }}`, which routes
 * through the project's auth endpoint and arrives back here as a `code`. A
 * deployment whose templates have not been customised yet must still work, and
 * this is the address every `emailRedirectTo` in the service points at, so the
 * out-of-the-box configuration is functional before anyone touches the dashboard.
 *
 * ── Its limitation, stated plainly ──────────────────────────────────────────
 * A PKCE code is only redeemable by the browser that started the flow, because
 * the verifier is a cookie set on that browser at sign-up. Someone who registers
 * on a laptop and opens the mail on their phone gets a link that cannot work,
 * and no message here can fix it. That is precisely why
 * `docs/auth-email-templates.md` moves every template to the `token_hash` links
 * that `/auth/confirm` handles — this route is the fallback, not the target.
 *
 * ── Cookies go on THIS response ─────────────────────────────────────────────
 * `exchangeCodeForSession` writes the session through the client's cookie sink,
 * which is bound to the redirect being returned. A session written through
 * `next/headers` instead can silently fail to attach to a handler-constructed
 * redirect, which confirms the address and leaves the browser signed out.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  const reported = failureFromQuery(url);
  if (reported) return callbackFailure(request, reported);

  const code = url.searchParams.get("code");
  if (!code) {
    // No code and no error means the link came back with the credential in the
    // URL FRAGMENT — the implicit flow, which a server never sees. `@supabase/ssr`
    // uses PKCE, so this indicates a project or template configured for the older
    // flow; the link cannot be completed server-side.
    console.warn(
      "[auth] /auth/callback reached with no code. If this is a real link, the project " +
        "is issuing implicit-flow URLs — see docs/auth-email-templates.md.",
    );
    return callbackFailure(request, "enlace_invalido");
  }

  const limited = await guardCallbackRate(request);
  if (limited) return callbackFailure(request, limited);

  const destination = callbackDestination(
    url.searchParams.get("next"),
    parseOtpType(url.searchParams.get("type")),
  );
  const response = NextResponse.redirect(new URL(destination, url.origin));

  let supabase;
  try {
    supabase = callbackClient(request, response);
  } catch (error) {
    console.error("[auth] Supabase is not configured, so the callback cannot run:", error);
    return callbackFailure(request, "configuracion");
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    // The overwhelmingly common cause is a link opened in a different browser
    // from the one that started the flow. The access page says so.
    console.warn(`[auth] code exchange failed: ${error?.message ?? "no user returned"}`);
    return callbackFailure(request, "enlace_otro_navegador");
  }

  await syncEmployerRecord(data.user);
  return response;
}
