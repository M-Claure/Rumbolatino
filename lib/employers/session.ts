import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { Errors } from "@/lib/errors";
import { getEmployerStore } from "@/lib/repositories";
import { EMPLOYER_COOKIE_NAME } from "@/lib/employers/constants";

/**
 * Employer sessions — the ONE place in this product with a real login.
 *
 * ── Why this exists at all, next to "No accounts" ───────────────────────────
 * The job-seeker side has no login by design: a visitor answers a question and
 * their work is saved (see `lib/auth.ts`). That decision is about the person
 * giving us their information to get a résumé, and it stands.
 *
 * An employer is the opposite party. They are not giving us anything — they are
 * asking to read a list of real people's names, trades, locations and phone
 * numbers. So they identify themselves, and they prove they control the mailbox
 * they gave, before any of it is visible. `employers.id` in `0010` already
 * `references auth.users(id)`, which is exactly the shape this needs.
 *
 * ── The cookie is NAMESPACED, and that is load-bearing ──────────────────────
 * Both sides authenticate against the same Supabase project, so without this the
 * two roles would fight over one cookie:
 *
 *   - signing in as an employer would REPLACE a guest's session, and because the
 *     cookie is the only handle on a résumé (there is deliberately no recovery
 *     flow), that would destroy an in-progress résumé with no way back;
 *   - and a browser holding an employer session would then have `resolveUserId()`
 *     hand the builder that employer's user id, starting a résumé under the
 *     employer's account.
 *
 * A separate cookie name gives each role its own session, so a person can be
 * building a résumé in one tab and hiring in another with neither disturbing the
 * other. Nothing else in the app reads this cookie, and this module never reads
 * the default one. The name itself lives in `constants.ts` because the edge
 * middleware needs it and cannot import this file.
 */

/**
 * A Supabase client bound to the employer cookie namespace.
 *
 * Not memoized: it closes over the request's cookie jar, so one instance per
 * call is the only correct scope.
 */
export function getEmployerSupabaseClient(): SupabaseClient {
  const env = getEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("El acceso para empresas requiere Supabase configurado.");
  }
  const cookieStore = cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: EMPLOYER_COOKIE_NAME },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch (error) {
          // Expected in a Server Component, which cannot set cookies — the
          // middleware refresh covers that case. NOT expected anywhere the
          // session is being CREATED, and a silent failure there looks exactly
          // like "authentication is broken": the sign-in succeeds upstream and
          // the browser never receives the cookie. So it is logged, loudly.
          console.error(
            "[employers] could not write the session cookie. If this came from a " +
              "sign-in, verification or password reset, that session was lost:",
            error,
          );
        }
      },
    },
  });
}


/**
 * The two cookie jars a route handler holds, described structurally.
 *
 * Structural rather than `NextRequest`/`NextResponse` so this module needs no
 * `next/server` import — it is read by Server Components too, and the shape is
 * all that matters.
 *
 * Two interfaces and not one, because the two jars genuinely differ: the request
 * is READ-ONLY (its `set` exists but has a different signature and would write
 * nowhere the browser can see), and the response is where writes belong. One
 * combined type made a request jar look assignable to a sink.
 */
export interface CookieReader {
  getAll(): { name: string; value: string }[];
}

export interface CookieWriter {
  set(name: string, value: string, options?: Record<string, unknown>): void;
}

/**
 * An employer client whose cookie writes land on a RESPONSE the handler owns.
 *
 * ── Why this exists, and why `getEmployerSupabaseClient` is not enough ───────
 * That one writes through `cookies()` from `next/headers`, which relies on
 * Next.js merging the recorded mutations into whatever the handler returns. That
 * merge is not dependable for a response the handler CONSTRUCTS itself — a
 * `NextResponse.redirect(...)` most of all — and when it silently does not
 * happen the result is the worst possible failure shape: the code exchange
 * succeeds, Supabase marks the address confirmed, and the browser gets no
 * session. The employer clicks the link in their email, lands on the directory,
 * is bounced straight back to the login page, and nothing anywhere says why.
 *
 * Binding the writes to the response removes the dependency on that merge
 * entirely, which is the pattern Supabase's own docs use for a code-exchange
 * route. Reads still come from the request.
 */
export function employerClientForRoute(
  requestCookies: CookieReader,
  responseCookies: CookieWriter,
): SupabaseClient {
  const env = getEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("El acceso para empresas requiere Supabase configurado.");
  }
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: EMPLOYER_COOKIE_NAME },
    cookies: {
      getAll: () => requestCookies.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        toSet.forEach(({ name, value, options }) => responseCookies.set(name, value, options));
      },
    },
  });
}

export interface EmployerSession {
  readonly userId: string;
  readonly email: string;
  readonly contactName: string;
  readonly company: string;
}

/**
 * Why a request may not see the directory. FOUR outcomes, not two.
 *
 * ── Why each one is separate ────────────────────────────────────────────────
 * Because the fix differs, which is the same reason `Errors.rateLimited` and
 * `Errors.budgetExhausted` are separate codes: one is waiting, the other is an
 * operator changing a setting.
 *
 *   anonymous     no session. Sign in. The person can fix it.
 *   unverified    signed in, mailbox unproven. Click the link, or resend it.
 *                 With Supabase's "Confirm email" ON this is nearly unreachable
 *                 — GoTrue issues no session before confirmation — and it is
 *                 kept precisely for the cases where it is not: a session minted
 *                 while that setting was off, an account confirmed and then
 *                 changed to a new address, or the setting being turned off by
 *                 mistake. Defence in depth, not dead code.
 *   misconfigured Supabase or the service role is missing. Only an operator can
 *                 fix it, and it must never be reported as a login problem —
 *                 collapsing it into `anonymous` once cost real debugging time,
 *                 telling verified employers to "entra con tu cuenta" while the
 *                 actual fault sat in an unread log.
 */
export type EmployerGate =
  | { readonly status: "ok"; readonly session: EmployerSession }
  | { readonly status: "anonymous" }
  | { readonly status: "unverified"; readonly email: string }
  | { readonly status: "misconfigured" };

/**
 * The gate. Every surface that shows a candidate goes through here.
 *
 * Never throws. `ok` requires all three of:
 *
 *  1. a session on the employer cookie;
 *  2. a row in `employers` — the account was registered through this product,
 *     not merely created in Supabase Auth;
 *  3. `employers.email_verified_at` set.
 *
 * (3) reads `auth.users.email_confirmed_at`, through the session user — the
 * REVERSE of what this comment said while verification was ours. That column is
 * now the authority: GoTrue sets it, only a real confirmation sets it, and no
 * code in this repo can forge it. `employers.email_verified_at` is kept as a
 * MIRROR for operators and the reveal audit, and is repaired here when it has
 * fallen behind, but the gate must not depend on a write of ours succeeding —
 * an employer who has proved their mailbox would otherwise be locked out by a
 * failed bookkeeping update.
 *
 * (2) is also what makes the reveal audit safe: `contact_reveals.employer_id` is
 * a foreign key to `employers`, so guaranteeing the row here means every
 * downstream caller can pass `employer.userId` to `revealContact` and know it
 * holds. Note the gate no longer CREATES that row — registration does, which is
 * why a session with no row is now a refusal rather than a repair.
 *
 * Fails CLOSED, unlike the rate limiter: `getEmployerStore()` throws when the
 * service role is missing, and the safe reading of "I cannot confirm this is a
 * registered employer" is to show nobody's phone number.
 */
export async function checkEmployerGate(): Promise<EmployerGate> {
  const env = getEnv();
  if (env.PERSISTENCE !== "supabase") return { status: "misconfigured" };

  let supabase: SupabaseClient;
  try {
    supabase = getEmployerSupabaseClient();
  } catch (error) {
    console.error("[employers] Supabase is not configured for the employer login:", error);
    return { status: "misconfigured" };
  }

  // `getUser()` and not `getSession()`: it revalidates the token against the
  // auth server, so a revoked or tampered session is rejected here rather than
  // trusted because a cookie parsed cleanly.
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user?.email) return { status: "anonymous" };

  // The authority, checked before anything of ours is consulted.
  if (!user.email_confirmed_at) return { status: "unverified", email: user.email };

  let profile;
  try {
    profile = await getEmployerStore().get(user.id);
  } catch (error) {
    console.error(
      "[employers] the `employers` table could not be reached, so a session could not be " +
        "checked. This is almost always a missing SUPABASE_SERVICE_ROLE_KEY:",
      error,
    );
    return { status: "misconfigured" };
  }

  // A session with no row is not a registered employer. Treated as anonymous
  // rather than repaired: the row is created during registration and rebuilt by
  // `/auth/confirm`, so its absence here means this account never went through
  // either — an account made straight in the Supabase dashboard, or one whose
  // employer row was deleted. The gate must not be the third way in.
  if (!profile) return { status: "anonymous" };

  // Bring the mirror forward once, and only once — the update filters on
  // `email_verified_at is null`, so a confirmed employer costs no extra write on
  // subsequent requests. Failure is logged and ignored: the gate has already
  // decided on Supabase's answer, and bookkeeping must not deny access.
  if (!profile.emailVerifiedAt) {
    void getEmployerStore()
      .markEmailVerified(user.id)
      .catch((error) =>
        console.error("[employers] could not mirror the confirmation onto employers:", error),
      );
  }

  return {
    status: "ok",
    session: {
      userId: user.id,
      email: profile.email,
      contactName: profile.contactName,
      company: profile.company,
    },
  };
}

/**
 * The gate, flattened to "who is this, if anyone".
 *
 * For callers that treat every failure the same way. Anything that renders a
 * candidate should use `checkEmployerGate`, so a configuration fault does not
 * masquerade as a login prompt and an unverified employer is told which of the
 * two things they need to do.
 */
export async function resolveEmployerSession(): Promise<EmployerSession | null> {
  const gate = await checkEmployerGate();
  return gate.status === "ok" ? gate.session : null;
}

/**
 * The session as a REQUIREMENT, for API routes and the directory service.
 *
 * In the service and not only the route, for the same reason `searchDirectory`
 * carries its own rate limit: `/empleadores` reads the directory directly rather
 * than calling its own API, and the page must not be a way around the guard the
 * API has.
 */
export async function requireEmployerSession(): Promise<EmployerSession> {
  const gate = await checkEmployerGate();
  if (gate.status === "ok") return gate.session;

  // A 503, not a 401. Telling a caller to authenticate when the server cannot
  // check anyone's credentials sends them in a circle, and hides an outage
  // behind a message that reads like their mistake.
  if (gate.status === "misconfigured") {
    throw Errors.serviceUnavailable(
      "El acceso para empresas no está disponible en este momento. Ya estamos avisados.",
    );
  }

  if (gate.status === "unverified") {
    throw Errors.forbidden(
      "Confirma tu correo para ver el directorio. Te enviamos un enlace cuando te registraste.",
    );
  }

  throw Errors.unauthorized("Entra con tu cuenta de empresa para ver el directorio.");
}
