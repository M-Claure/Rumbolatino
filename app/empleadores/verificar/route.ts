import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /empleadores/verificar — where verification links used to land.
 *
 * ── A forwarding shim, kept on purpose ──────────────────────────────────────
 * Verification is Supabase's again, so the live callbacks are `/auth/confirm`
 * (a `token_hash`) and `/auth/callback` (a PKCE `code`). This path stays for two
 * reasons, both about links that are already out of our hands:
 *
 *   1. an email sent before this change is sitting in somebody's inbox, and its
 *      `?token=…` no longer means anything — this turns it into a clear "pide
 *      uno nuevo" instead of a 404;
 *   2. a Supabase email template may still be configured to point here. Rather
 *      than fail those, the Supabase-shaped parameters are forwarded intact to
 *      the callback that understands them.
 *
 * Everything is forwarded, so no credential is inspected, logged or dropped
 * here. Deleting this route would be safe once no old link can still be clicked
 * and the dashboard templates are confirmed to point at `/auth/confirm`.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  if (url.searchParams.has("token_hash")) {
    const forwarded = new URL("/auth/confirm", url.origin);
    forwarded.search = url.search;
    if (!forwarded.searchParams.get("type")) forwarded.searchParams.set("type", "signup");
    return NextResponse.redirect(forwarded);
  }

  if (url.searchParams.has("code")) {
    const forwarded = new URL("/auth/callback", url.origin);
    forwarded.search = url.search;
    return NextResponse.redirect(forwarded);
  }

  // A `?token=…` from the retired flow, or nothing at all. Either way the person
  // needs a fresh link, which the access page offers.
  return NextResponse.redirect(
    new URL("/empleadores/acceso?estado=enlace_invalido", url.origin),
  );
}
