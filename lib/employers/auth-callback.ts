import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType, User } from "@supabase/supabase-js";
import { getEmployerStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { employerClientForRoute } from "@/lib/employers/session";
import { DEFAULT_REDIRECT, safeNextPath } from "@/lib/auth-redirect";

/**
 * The shared half of the two authentication callbacks.
 *
 * `/auth/confirm` (a `token_hash`, verified with `verifyOtp`) and
 * `/auth/callback` (a PKCE `code`, traded with `exchangeCodeForSession`) differ
 * in exactly one line — the call that turns the credential into a session.
 * Everything around it is identical and is the part that is easy to get wrong:
 * writing the session cookies onto the response the handler returns, refusing an
 * attacker-supplied destination, and keeping our mirror of the verification
 * timestamp in step. So that lives here once.
 *
 * ── Both exist on purpose ───────────────────────────────────────────────────
 * `/auth/confirm` is the one to configure, because a `token_hash` link works in
 * ANY browser: it carries no PKCE verifier, so the employer who signs up on a
 * laptop and opens the mail on their phone still lands signed in. That
 * cross-device failure is the one this repo previously judged unfixable and
 * built its own token system to escape.
 *
 * `/auth/callback` stays because Supabase's STOCK templates send
 * `{{ .ConfirmationURL }}`, which comes back as a `code`. Until the templates in
 * the dashboard are replaced (see `docs/auth-email-templates.md`) that is the
 * link real users will click, and a project with no custom templates must still
 * work — same browser only, which is the documented caveat.
 */

/** Reasons a callback can end badly, as the `estado` the access page explains. */
export type CallbackFailure =
  | "enlace_invalido"
  | "enlace_expirado"
  /**
   * A PKCE code redeemed from a different browser than the one that requested
   * it. Its own reason because the fix is unlike every other one here: the link
   * is genuine and unexpired, and the person has to open it where they started
   * — or, better, the operator has to move the templates to `token_hash`.
   */
  | "enlace_otro_navegador"
  | "demasiados_intentos"
  | "configuracion";

/**
 * Every failure lands on the access page with a reason, never on a blank error.
 *
 * A person holding a link that did not work needs one of two actions — sign in,
 * or send a new link — and both are on that page. Rendering a dead end here
 * would leave them with nothing to press.
 */
export function callbackFailure(request: NextRequest, reason: CallbackFailure): NextResponse {
  const url = new URL(`/empleadores/acceso?estado=${reason}`, request.nextUrl.origin);
  return NextResponse.redirect(url);
}

/**
 * Supabase reports a dead link by redirecting to us with `error=…` rather than
 * with a credential, so the query string has to be inspected before anything
 * else. `otp_expired` is the common one — a link older than the project's OTP
 * lifetime — and it deserves its own message, because the fix ("pide uno nuevo")
 * differs from a link that was never valid.
 */
export function failureFromQuery(url: URL): CallbackFailure | null {
  const error = url.searchParams.get("error") ?? url.searchParams.get("error_code");
  if (!error) return null;
  const code = `${error} ${url.searchParams.get("error_description") ?? ""}`.toLowerCase();
  return /expired/.test(code) ? "enlace_expirado" : "enlace_invalido";
}

/** The OTP types this app can be sent. Anything else is treated as a bad link. */
const ACCEPTED_OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

export function parseOtpType(value: string | null): EmailOtpType | null {
  if (!value) return null;
  return ACCEPTED_OTP_TYPES.includes(value as EmailOtpType) ? (value as EmailOtpType) : null;
}

/** Where the reset form lives, so a `recovery` link cannot end anywhere else. */
export const RECOVERY_DESTINATION = "/empleadores/nueva-contrasena";

/**
 * The destination, sanitised, with one correction.
 *
 * A `recovery` link that arrives with no explicit `next` — a stock template, or
 * one edited without the parameter — would otherwise drop someone on the
 * directory holding a recovery session and never show them the password form
 * they clicked the link for. So recovery overrides the default. An explicit,
 * allowed `next` is still honoured, because the template is entitled to choose.
 */
export function callbackDestination(next: string | null, type: EmailOtpType | null): string {
  const path = safeNextPath(next);
  if (type === "recovery" && path === DEFAULT_REDIRECT) return RECOVERY_DESTINATION;
  return path;
}

/**
 * Guard the callback itself.
 *
 * Not brute-force defence — the credential in the link is unguessable — but a
 * link in a mailbox gets followed by scanners, prefetchers and "safe link"
 * rewriters, sometimes dozens of times, and each hit is an auth round trip plus
 * a database write. `employer_email` is the right bucket: it is the counter that
 * already covers issuing and consuming these links.
 *
 * Returns the failure to render, or null to continue.
 */
export async function guardCallbackRate(request: NextRequest): Promise<CallbackFailure | null> {
  try {
    await enforceRateLimit("employer_email", { ip: clientIp(request.headers) });
    return null;
  } catch (error) {
    console.warn("[auth] callback refused by the rate limiter:", error);
    return "demasiados_intentos";
  }
}

/**
 * A Supabase client whose cookie writes land on THIS response.
 *
 * Deliberately not `getEmployerSupabaseClient()`, which writes through
 * `next/headers` and depends on Next.js merging those mutations into a response
 * the handler constructed itself. When that merge does not happen the failure is
 * the worst possible shape: the exchange succeeds, Supabase marks the address
 * confirmed, and the browser receives no session — so the employer clicks the
 * link, lands on the directory, is bounced to the login page, and nothing says
 * why. Binding the writes to the response removes the dependency entirely.
 */
export function callbackClient(request: NextRequest, response: NextResponse) {
  return employerClientForRoute(request.cookies, response.cookies);
}

/**
 * Keep `employers` in step with what Supabase Auth now says.
 *
 * ── Supabase owns the truth; this column is a MIRROR ────────────────────────
 * With native confirmation the authority is `auth.users.email_confirmed_at`,
 * which GoTrue sets and which no code here can forge.
 * `employers.email_verified_at` is kept written because it is what operators
 * query, what the reveal audit reads alongside, and what makes a revert to the
 * previous token-based flow a code change rather than a data migration.
 *
 * ── It also REPAIRS a missing row ───────────────────────────────────────────
 * The row is written during registration, from the service role. If that write
 * failed — a transient outage, a service-role key added after the fact — the
 * account would exist in Auth, confirm successfully, and then be refused by the
 * gate forever with no way for the person to fix it. So the row is (re)created
 * here from the metadata registration stored on the user. This is still the
 * registration FLOW creating it, not the gate: `checkEmployerGate` continues to
 * refuse a session with no row rather than repairing one, so a bare Supabase
 * account never becomes an employer by visiting a page.
 *
 * Best-effort and never throws. A person who has just proved control of their
 * mailbox must not be shown an error because a mirror write was slow; the gate
 * would refuse them on the next request anyway, which is the safe direction.
 */
export async function syncEmployerRecord(user: User): Promise<void> {
  if (!user.email) return;
  try {
    const store = getEmployerStore();
    const existing = await store.get(user.id);

    if (!existing) {
      const metadata = user.user_metadata ?? {};
      const company = typeof metadata.company === "string" ? metadata.company.trim() : "";
      const contactName =
        typeof metadata.contact_name === "string" ? metadata.contact_name.trim() : "";
      // No metadata means this account was not created by our registration form
      // (a row made by hand in the dashboard, say). Do not invent an employer.
      if (!company || !contactName) return;
      await store.save({
        id: user.id,
        company,
        contactName,
        email: user.email.toLowerCase(),
        emailVerifiedAt: null,
        ip: null,
      });
    }

    if (user.email_confirmed_at) await store.markEmailVerified(user.id);
  } catch (error) {
    console.error(
      "[auth] could not mirror the confirmation onto the employers row. The account is " +
        "confirmed in Supabase Auth; the gate will refuse it until this succeeds:",
      error,
    );
  }
}
