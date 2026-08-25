import { NextResponse, type NextRequest } from "next/server";
import { exchangeEmployerAuthCode } from "@/lib/services/employer-account";
import { employerClientForRoute, ensureEmployerProfile } from "@/lib/employers/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /empleadores/verificar — where the confirmation email lands.
 *
 * A route handler rather than a page, because this step has to WRITE cookies
 * (the session) and a Server Component cannot — the same constraint that keeps
 * guest minting in route handlers on the job-seeker side (`lib/auth.ts`).
 *
 * ── The response is built FIRST, and the cookies are written onto it ─────────
 * This is the whole correctness of the route, and getting it wrong is silent.
 * Writing the session through `cookies()` from `next/headers` and then returning
 * a freshly constructed `NextResponse.redirect(...)` depends on Next.js merging
 * those mutations into a response it did not create, which is not dependable.
 * When it does not happen, the failure looks like this: the exchange succeeds,
 * Supabase marks the address confirmed, and the browser receives no session — so
 * the employer clicks the link, lands on the directory, is bounced back to the
 * login page, and nothing explains why. The account is verified and unusable.
 *
 * So the redirect exists before the exchange does, and `employerClientForRoute`
 * writes straight onto it.
 *
 * The profile row is written here too, from the live client rather than by
 * re-resolving the session: `resolveEmployerSession()` reads `next/headers`,
 * which at this moment does NOT contain the session that only exists on the
 * outgoing response — so it would find nobody and skip the write, silently.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const verified = NextResponse.redirect(new URL("/empleadores?estado=verificado", url.origin));

  const supabase = employerClientForRoute(request.cookies, verified.cookies);
  const exchanged = await exchangeEmployerAuthCode(url, supabase);

  if (!exchanged) {
    return NextResponse.redirect(new URL("/empleadores/acceso?estado=enlace_invalido", url.origin));
  }

  try {
    const { data } = await supabase.auth.getUser();
    const user = data.user;
    if (user?.email && user.email_confirmed_at) {
      await ensureEmployerProfile(
        user.id,
        user.email,
        (user.user_metadata ?? {}) as Record<string, unknown>,
      );
    }
  } catch (error) {
    // The session is valid and the address is confirmed; only our own row
    // failed. Send them on — the gate writes it on the next request — because
    // stranding a verified employer here would be strictly worse.
    console.error("[employers] could not write the profile row after verification:", error);
  }

  return verified;
}
