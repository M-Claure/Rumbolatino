import { NextResponse, type NextRequest } from "next/server";
import { RECOVERY_DESTINATION } from "@/lib/employers/auth-callback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /empleadores/recuperar/confirmar — where reset links used to land.
 *
 * The same forwarding shim as `/empleadores/verificar`, for the same reason:
 * reset emails sent before this change are still in mailboxes, and a template in
 * the dashboard may still point here. Supabase-shaped parameters are handed to
 * the callback that understands them, with the destination pinned to the
 * password form; anything else becomes "pide un enlace nuevo".
 *
 * What this route no longer does is move a token of ours into an httpOnly
 * cookie. There is no token of ours: `/auth/confirm` exchanges Supabase's
 * `token_hash` for a recovery session, and the session is the authority.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  if (url.searchParams.has("token_hash")) {
    const forwarded = new URL("/auth/confirm", url.origin);
    forwarded.search = url.search;
    forwarded.searchParams.set("type", "recovery");
    forwarded.searchParams.set("next", RECOVERY_DESTINATION);
    return NextResponse.redirect(forwarded);
  }

  if (url.searchParams.has("code")) {
    const forwarded = new URL("/auth/callback", url.origin);
    forwarded.search = url.search;
    forwarded.searchParams.set("next", RECOVERY_DESTINATION);
    return NextResponse.redirect(forwarded);
  }

  return NextResponse.redirect(
    new URL("/empleadores/acceso?estado=enlace_invalido", url.origin),
  );
}
