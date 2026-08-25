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
 * Create the `employers` row for a verified session that has none.
 *
 * ── Why the row is written HERE and not at sign-up ──────────────────────────
 * With email confirmation on, `signUp` for an address that already has an
 * account deliberately does not say so — it answers with a user-shaped object
 * and no identities, so the endpoint cannot be used to enumerate accounts. That
 * means a sign-up response cannot be trusted to describe a NEW user, and writing
 * our row from it would let someone register `ana@empresa.com` a second time and
 * overwrite the real Ana's company name: an unauthenticated write to another
 * account's row.
 *
 * So sign-up puts the company and contact name on the auth user's metadata and
 * writes nothing. This function reads them back from an AUTHENTICATED session,
 * so the row is always created by the person who proved they hold the mailbox.
 *
 * It is also a repair path. It runs on every gated request, which means an
 * account whose row write once failed — or one created straight in the Supabase
 * dashboard — heals on its next page view instead of being permanently unable to
 * reach the directory.
 */
export async function ensureEmployerProfile(
  userId: string,
  email: string,
  metadata: Record<string, unknown>,
): Promise<{ company: string; contactName: string }> {
  const store = getEmployerStore();
  const existing = await store.get(userId);
  if (existing) return { company: existing.company, contactName: existing.contactName };

  const company = typeof metadata.company === "string" ? metadata.company.trim() : "";
  const contactName = typeof metadata.contact_name === "string" ? metadata.contact_name.trim() : "";
  // Both columns are NOT NULL, and a session that reaches this point is
  // legitimately signed in — so fall back to something usable rather than
  // failing the insert and locking the person out of an account they verified.
  const profile = {
    company: company || "Sin especificar",
    contactName: contactName || email,
  };

  await store.save({ id: userId, email, ...profile, ip: null });
  return profile;
}

/**
 * Why a request may not see the directory. THREE outcomes, not two.
 *
 * ── Why "misconfigured" is not folded into "anonymous" ──────────────────────
 * Because the fix is different, which is the same reason `Errors.rateLimited`
 * and `Errors.budgetExhausted` are separate codes: one is waiting, the other is
 * an operator changing a setting.
 *
 * Collapsing them cost real debugging time once already. A deployment with no
 * `SUPABASE_SERVICE_ROLE_KEY` turned every verified employer away with "entra
 * con tu cuenta de empresa" — advice that cannot work, addressed to someone who
 * had just clicked a verification link, while the actual fault sat in a log
 * nobody was reading. A gate that cannot tell "you are not signed in" from "this
 * environment is not set up" will send the operator hunting through auth code
 * for a missing environment variable.
 */
export type EmployerGate =
  | { readonly status: "ok"; readonly session: EmployerSession }
  /** No session, or one whose mailbox is unconfirmed. The person can fix this. */
  | { readonly status: "anonymous" }
  /** Supabase or the service role is missing. Only an operator can fix this. */
  | { readonly status: "misconfigured" };

/**
 * The gate. Every surface that shows a candidate goes through here.
 *
 * Never throws. All three conditions are required for `ok`:
 *
 *  1. a session on the employer cookie;
 *  2. `email_confirmed_at` set on that user — the verification gate, read from
 *     the auth user rather than mirrored into `employers`, so there is one
 *     source of truth and no copy that can drift into claiming "verified" when
 *     Supabase disagrees;
 *  3. a row in `employers`, created here if it is missing.
 *
 * (3) is not ceremony. `contact_reveals.employer_id` is a foreign key to
 * `employers`, so a session without a row would fail the audited reveal and the
 * employer could not download anything — the FK would turn a bookkeeping gap
 * into a broken product. Guaranteeing the row at the gate means every downstream
 * caller can pass `employer.userId` to `revealContact` and know it holds.
 *
 * Fails CLOSED, unlike the rate limiter: `getEmployerStore()` throws when the
 * service role is missing, and the safe reading of "I cannot confirm this is a
 * registered employer" is to show nobody's phone number. But it now fails closed
 * *legibly* — as `misconfigured`, not as `anonymous`.
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

  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user?.email) return { status: "anonymous" };
  // An unverified account is not a session as far as every gate is concerned.
  if (!user.email_confirmed_at) return { status: "anonymous" };

  try {
    const profile = await ensureEmployerProfile(
      user.id,
      user.email,
      (user.user_metadata ?? {}) as Record<string, unknown>,
    );
    return { status: "ok", session: { userId: user.id, email: user.email, ...profile } };
  } catch (error) {
    // Reached with a VALID, verified session — so this is never the person's
    // fault and must not be reported to them as a login problem.
    console.error(
      "[employers] a verified employer was turned away because the `employers` table " +
        "could not be reached. This is almost always a missing SUPABASE_SERVICE_ROLE_KEY:",
      error,
    );
    return { status: "misconfigured" };
  }
}

/**
 * The gate, flattened to "who is this, if anyone".
 *
 * For callers that treat both failure modes the same way — chiefly
 * `/empleadores/acceso`, which only needs to know whether to skip its own form.
 * Anything that renders a candidate should use `checkEmployerGate` instead, so a
 * configuration fault does not masquerade as a login prompt.
 */
export async function resolveEmployerSession(): Promise<EmployerSession | null> {
  const gate = await checkEmployerGate();
  return gate.status === "ok" ? gate.session : null;
}

/**
 * The session as a REQUIREMENT: throws `unauthorized` when there isn't one.
 *
 * This is what gated API routes and the directory service call. The service and
 * not only the route, for the same reason `searchDirectory` carries its own rate
 * limit: `/empleadores` reads the directory directly rather than calling its own
 * API, and the page must not be a way around the guard the API has.
 */
export async function requireEmployerSession(): Promise<EmployerSession> {
  const gate = await checkEmployerGate();
  if (gate.status === "ok") return gate.session;

  // A 503 and not a 401. Telling a caller to authenticate when the server cannot
  // check anyone's credentials sends them in a circle, and it hides an outage
  // behind a message that reads like their mistake.
  if (gate.status === "misconfigured") {
    throw Errors.serviceUnavailable(
      "El acceso para empresas no está disponible en este momento. Ya estamos avisados.",
    );
  }

  throw Errors.unauthorized(
    "Entra con tu cuenta de empresa para ver el directorio. Si ya te registraste, " +
      "confirma tu correo primero.",
  );
}

/**
 * True when a session exists but the mailbox has not been confirmed.
 *
 * The sign-in flow needs to tell these apart: "wrong password" and "you never
 * clicked the link" have completely different fixes, and answering both with
 * "no autorizado" leaves someone with a working password locked out and no idea
 * why. This deliberately re-reads the user, ignoring the confirmation gate that
 * `resolveEmployerSession` applies.
 */
export async function isAwaitingVerification(): Promise<boolean> {
  const env = getEnv();
  if (env.PERSISTENCE !== "supabase") return false;
  try {
    const { data } = await getEmployerSupabaseClient().auth.getUser();
    return Boolean(data.user?.email) && !data.user?.email_confirmed_at;
  } catch {
    return false;
  }
}
