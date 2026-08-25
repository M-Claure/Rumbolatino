import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isOnline } from "@/lib/connectivity";
import { BRAND_COOKIE, BRAND_HEADER, BRAND_QUERY } from "@/lib/brand/constants";
import { brandEnv, resolveBrand, type BrandResolution } from "@/lib/brand/resolve";
import { EMPLOYER_COOKIE_NAME } from "@/lib/employers/constants";

/**
 * Builds the 503 response returned to every request while the host is offline.
 * API routes get the standard JSON error envelope; page requests get a minimal
 * Spanish HTML page so users aren't shown raw JSON.
 */
function offlineResponse(request: NextRequest): NextResponse {
  const message =
    "Sin conexión a internet. Esta aplicación requiere conexión para funcionar.";
  if (request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json(
      { error: { code: "service_unavailable", message } },
      { status: 503 },
    );
  }
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Sin conexión</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;text-align:center;color:#111">` +
    `<h1 style="font-size:1.25rem">Sin conexión a internet</h1>` +
    `<p style="color:#555">${message}</p>` +
    `</body></html>`;
  return new NextResponse(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Resolve the marketing brand for this request. Done in middleware because it is
 * the earliest point that sees the host, so the whole render tree — layout,
 * `generateMetadata`, every Server Component — reads one already-resolved value
 * instead of each re-deriving it. See `lib/brand/resolve.ts` for the precedence.
 */
function resolveBrandForRequest(request: NextRequest): BrandResolution {
  const { envDefault, hostOverrides } = brandEnv();
  return resolveBrand({
    host: request.headers.get("host"),
    cookie: request.cookies.get(BRAND_COOKIE)?.value ?? null,
    query: request.nextUrl.searchParams.get(BRAND_QUERY),
    envDefault,
    hostOverrides,
  });
}

/**
 * Persist an explicitly chosen brand so the rest of the session keeps it —
 * `?brand=…` is a one-off on a single URL, and the visitor would otherwise snap
 * back to the host's brand on the next click.
 *
 * Only an *explicit* override is persisted. Writing a host-resolved brand to a
 * cookie would be a bug: the cookie outranks the host, so a visitor who saw one
 * brand's domain would keep seeing it after navigating to the other one.
 *
 * `?brand=auto` (or any unrecognised value) clears the override and returns to
 * host-based resolution.
 */
function persistBrandCookie(
  request: NextRequest,
  response: NextResponse,
  resolution: BrandResolution,
): void {
  const requested = request.nextUrl.searchParams.get(BRAND_QUERY);
  if (requested === null) return;

  if (resolution.source === "query") {
    response.cookies.set(BRAND_COOKIE, resolution.brandId, {
      path: "/",
      sameSite: "lax",
      // The browser never reads this — the brand reaches the client as resolved
      // props — so keep it off `document.cookie`.
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    return;
  }

  response.cookies.delete(BRAND_COOKIE);
}

/**
 * Runs on every request (except static assets and the health probe — see
 * `config.matcher`). Three responsibilities:
 *   1. Online-only guard: block the request with a 503 when the host has no
 *      connectivity to the app's external services (see `lib/connectivity.ts`).
 *   2. Brand resolution: stamp the resolved brand on the request so the render
 *      tree can read it (see `lib/brand/server.ts`).
 *   3. Refresh the Supabase session so Server Components and route handlers see
 *      a valid one. On the job-seeker side there is no login — the session belongs
 *      to a guest created on the first request that needs it (see `lib/auth.ts`) —
 *      but it still expires, so it still has to be refreshed here.
 *   4. Refresh the EMPLOYER session, which lives in its own cookie and is the one
 *      real login in the product (see `lib/employers/session.ts`). Only on the
 *      paths that can use it, because it is a second round trip to the auth
 *      server and most requests are not employer requests.
 */
export async function middleware(request: NextRequest) {
  // Online-only guard: the app must not function without a connection.
  if (!(await isOnline())) {
    return offlineResponse(request);
  }

  const brand = resolveBrandForRequest(request);
  // Forward the brand on the *request* headers, which is what `headers()` reads
  // inside Server Components.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(BRAND_HEADER, brand.brandId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  persistBrandCookie(request, response, brand);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Still return `response`: it carries the brand header and cookie even when
  // Supabase is unconfigured.
  if (!url || !anon) return response;

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Touching getUser() refreshes the session token cookie when needed. It never
  // *creates* a session: a guest is minted lazily in a route handler, which is the
  // only place a cookie write survives (see `lib/auth.ts`).
  await supabase.auth.getUser();

  await refreshEmployerSession(request, response, url, anon);
  return response;
}

/**
 * Keep the employer login alive across the pages that use it.
 *
 * Scoped to the employer surfaces on purpose. This is a network call to the auth
 * server, and doing it on every request in the app would pay for a second one on
 * the whole job-seeker funnel, which cannot use this session at all.
 *
 * Skipped entirely when the employer cookie is absent — the overwhelmingly common
 * case, since nearly everyone here is a job seeker — so a signed-out visitor to
 * `/empleadores/acceso` costs nothing extra. Like the guest refresh above, this
 * never CREATES a session.
 */
async function refreshEmployerSession(
  request: NextRequest,
  response: NextResponse,
  supabaseUrl: string,
  anonKey: string,
): Promise<void> {
  const path = request.nextUrl.pathname;
  const isEmployerSurface =
    // `/auth/*` is the confirmation and recovery callback pair. They build their
    // own response-bound client and do not need this refresh, but a stale session
    // arriving there should still be renewed rather than silently ignored.
    path.startsWith("/auth") ||
    path.startsWith("/empleadores") ||
    path.startsWith("/talento") ||
    path.startsWith("/api/talent") ||
    path.startsWith("/api/employers");
  if (!isEmployerSurface) return;

  // `getAll()` names are prefixed by @supabase/ssr, so match on the stem rather
  // than an exact name — a chunked session arrives as `<name>.0`, `<name>.1`.
  const hasEmployerCookie = request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith(EMPLOYER_COOKIE_NAME));
  if (!hasEmployerCookie) return;

  const employerClient = createServerClient(supabaseUrl, anonKey, {
    cookieOptions: { name: EMPLOYER_COOKIE_NAME },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  await employerClient.auth.getUser();
}

export const config = {
  // Skip static assets and the health probe.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
