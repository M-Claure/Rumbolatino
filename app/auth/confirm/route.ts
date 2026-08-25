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
 * GET /auth/confirm?token_hash=…&type=…&next=… — the callback to configure.
 *
 * ── Why this one and not the PKCE code flow ─────────────────────────────────
 * A `token_hash` is verified server-side with `verifyOtp` and carries no PKCE
 * verifier, so the link works in ANY browser on ANY device. That matters more
 * here than almost anywhere: the employers this directory exists for sign up on
 * a shop computer and read their mail on a phone, and a link that only works in
 * the browser that submitted the form fails for most of them. Supabase's stock
 * `{{ .ConfirmationURL }}` is the code flow and has exactly that limitation,
 * which is why `docs/auth-email-templates.md` replaces every template with a
 * `{{ .TokenHash }}` link pointing here.
 *
 * This is Supabase's own current recommendation for the App Router, and it is
 * what makes native confirmation shippable for this product — the failure the
 * previous, self-issued token system was built to escape.
 *
 * ── Supabase is the security boundary, not this handler ─────────────────────
 * The handler never decides that anyone is verified. It hands the credential to
 * GoTrue, which either returns a session or does not. `employers.email_verified_at`
 * is written afterwards as a mirror for operators and the audit trail, and the
 * gate treats `auth.users.email_confirmed_at` as the truth.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  // A dead link comes back as `?error=…`, with no credential to try.
  const reported = failureFromQuery(url);
  if (reported) return callbackFailure(request, reported);

  const tokenHash = url.searchParams.get("token_hash");
  const type = parseOtpType(url.searchParams.get("type"));
  if (!tokenHash || !type) return callbackFailure(request, "enlace_invalido");

  const limited = await guardCallbackRate(request);
  if (limited) return callbackFailure(request, limited);

  // Built BEFORE the exchange so the session cookies have somewhere to land.
  const destination = callbackDestination(url.searchParams.get("next"), type);
  const response = NextResponse.redirect(new URL(destination, url.origin));

  let supabase;
  try {
    supabase = callbackClient(request, response);
  } catch (error) {
    console.error("[auth] Supabase is not configured, so the callback cannot run:", error);
    return callbackFailure(request, "configuracion");
  }

  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error || !data.user) {
    // Unknown, already used and expired are ONE message on purpose: they are the
    // same situation to whoever is holding a link that does not work, and telling
    // them apart would confirm that an address has an account here.
    console.warn(`[auth] verifyOtp(${type}) failed: ${error?.message ?? "no user returned"}`);
    return callbackFailure(request, /expired/i.test(error?.message ?? "") ? "enlace_expirado" : "enlace_invalido");
  }

  await syncEmployerRecord(data.user);
  return response;
}
