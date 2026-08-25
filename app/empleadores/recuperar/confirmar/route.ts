import { NextResponse, type NextRequest } from "next/server";
import { exchangeEmployerAuthCode } from "@/lib/services/employer-account";
import { employerClientForRoute } from "@/lib/employers/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /empleadores/recuperar/confirmar — where the password-reset email lands.
 *
 * Splitting the exchange from the form is what makes the flow work at all: the
 * link carries a one-time code that must be turned into a session (a cookie
 * write, so a route handler), and the form that follows is a page. Pointing the
 * email straight at the form would leave the code unexchanged and the page with
 * no authority to change anything.
 *
 * The response is constructed before the exchange and the cookies are written
 * onto it, for the same reason as `/empleadores/verificar` — see the long note
 * there. Without it the recovery session never reaches the browser and the form
 * turns everyone away with "el enlace ya no es válido".
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const ready = NextResponse.redirect(new URL("/empleadores/nueva-contrasena", url.origin));

  const supabase = employerClientForRoute(request.cookies, ready.cookies);
  const exchanged = await exchangeEmployerAuthCode(url, supabase);

  if (!exchanged) {
    return NextResponse.redirect(new URL("/empleadores/acceso?estado=enlace_invalido", url.origin));
  }
  return ready;
}
