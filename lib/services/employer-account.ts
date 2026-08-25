import "server-only";
import type { AuthError, SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { Errors } from "@/lib/errors";
import { getEmployerStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { getEmployerSupabaseClient } from "@/lib/employers/session";
import { RECOVERY_DESTINATION } from "@/lib/employers/auth-callback";
import { absoluteUrl } from "@/lib/auth-redirect";
import {
  EMAIL_REJECTION_MESSAGES,
  PASSWORD_RULE_TEXT,
  inspectEmployerEmail,
  inspectPassword,
} from "@/lib/employers/policy";

/**
 * Employer accounts: registration, sign-in, verification, recovery, sign-out.
 *
 * ── Supabase Auth owns ALL of it now ────────────────────────────────────────
 * Account, password hashing, sessions, refresh — and, as of this change, the
 * confirmation email, the recovery email, the tokens inside them and their
 * lifetimes. This module validates input, calls the right Supabase method, and
 * translates the answer into Spanish. It mints no credentials of its own.
 *
 * ── This REVERSES the design in `0013` and the older half of ────────────────
 *    `docs/employer-accounts.md`, and the reason is worth keeping
 * That design moved verification off GoTrue because it could not be shipped on
 * it: the built-in sender is capped at a handful of messages an hour and only
 * delivers to addresses inside the Supabase organisation, so real sign-ups got
 * "revisa tu correo" and an empty inbox with no error anywhere. A second
 * objection was that a PKCE confirmation link only worked in the browser that
 * signed up, which is the wrong browser for most of this audience.
 *
 * Both are now answered, which is what makes native flows correct here rather
 * than merely conventional:
 *
 *   - **Resend as Supabase Custom SMTP** replaces the built-in sender entirely.
 *     Delivery, throughput and bounce visibility become Resend's, and the
 *     silent-drop failure mode goes with it.
 *   - **`token_hash` links to `/auth/confirm`** carry no PKCE verifier, so they
 *     work on any device. See `docs/auth-email-templates.md`.
 *
 * What that buys is not just less code: password-reset tokens, single-use
 * enforcement, expiry and replay protection stop being ours to get right, and
 * `setEmployerPassword` no longer needs `auth.admin.updateUserById` — an API
 * that will change ANY user's password and was previously guarded only by our
 * own token check.
 *
 * ── Consequence for configuration, stated once ──────────────────────────────
 * **Supabase's "Confirm email" must now be ON**, the reverse of what `0013`
 * required. With it on, `signUp` returns no session and `signInWithPassword`
 * refuses an unconfirmed address, so the confirmation is enforced by GoTrue and
 * not merely by our gate. See `AUTH_PRODUCTION_SETUP.md`.
 *
 * The previous token machinery (`lib/employers/tokens.ts`, the
 * `employer_email_tokens` table, `mcv_consume_employer_token`) is deliberately
 * left in place and unused. It is the rollback: reverting this commit restores a
 * working flow with no database migration. Drop it only once native delivery has
 * been observed in production.
 */

/**
 * Absolute base URL for the links Supabase emails on our behalf.
 *
 * Header-derived by default so preview deployments and both brand domains each
 * send links back to themselves; `NEXT_PUBLIC_SITE_URL` overrides for the case
 * where a proxy rewrites the host.
 *
 * Whatever this resolves to must ALSO be on Supabase's redirect allow-list
 * (Authentication → URL Configuration → Redirect URLs). A destination that is
 * not on that list is silently replaced by the project's Site URL, and the
 * employer lands on the home page instead of the directory with no error to see.
 */
export function siteOrigin(headers: Headers): string {
  const configured = getEnv().NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    // Not recoverable: a relative link in an email is useless, and guessing
    // localhost would send production users to their own machine.
    throw Errors.internal(
      "No pudimos construir el enlace de confirmación. Configura NEXT_PUBLIC_SITE_URL.",
    );
  }
  const proto =
    headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The URL Supabase is told to send people back to.
 *
 * Only reached by the STOCK templates, which use `{{ .ConfirmationURL }}` and
 * come back as a PKCE code. The recommended templates ignore this and point at
 * `/auth/confirm` themselves — but this still has to be right, because it is
 * also the value Supabase checks against the redirect allow-list.
 */
function callbackUrl(headers: Headers, next: string): string {
  const origin = siteOrigin(headers);
  return absoluteUrl(origin, `/auth/callback?next=${encodeURIComponent(next)}`);
}

function assertAcceptableCredentials(email: string, password: string): string {
  const verdict = inspectEmployerEmail(email);
  if (verdict.rejection) throw Errors.validation(EMAIL_REJECTION_MESSAGES[verdict.rejection]);
  const problem = inspectPassword(password);
  if (problem) throw Errors.validation(problem.message);
  return verdict.normalized;
}

/**
 * Turn a GoTrue failure into something a Spanish-speaking user can act on,
 * without echoing an implementation detail.
 *
 * Supabase answers in English, with messages that change between releases, so
 * this matches on the stable `code` first and falls back to the text. Anything
 * unrecognised becomes one generic sentence and a server-side log — a raw
 * upstream error in the UI tells an attacker about the stack and tells the user
 * nothing.
 */
export function translateAuthError(error: AuthError, context: string): never {
  const code = error.code ?? "";
  const message = error.message ?? "";

  if (code === "over_email_send_rate_limit" || /rate limit|too many requests/i.test(message)) {
    throw Errors.rateLimited(
      "Enviamos demasiados correos a esta dirección. Espera unos minutos e inténtalo otra vez.",
    );
  }
  if (code === "weak_password" || /password/i.test(message)) {
    throw Errors.validation(`Esa contraseña no cumple los requisitos. ${PASSWORD_RULE_TEXT}`);
  }
  if (code === "email_address_invalid" || /invalid.*email/i.test(message)) {
    throw Errors.validation(EMAIL_REJECTION_MESSAGES.malformed);
  }
  if (code === "signup_disabled" || /signups? not allowed|disabled/i.test(message)) {
    console.error(`[employers] ${context}: sign-ups are disabled on the Supabase project.`);
    throw Errors.serviceUnavailable(
      "Ahora mismo no podemos crear cuentas nuevas. Vuelve a intentarlo más tarde.",
    );
  }

  console.error(`[employers] ${context}: ${error.status ?? "?"} ${code} ${message}`);
  throw Errors.internal("No pudimos completar la operación. Vuelve a intentarlo en un momento.");
}

/**
 * Did `signUp` just describe an account that ALREADY existed?
 *
 * With "Confirm email" on, Supabase deliberately refuses to tell a caller that
 * an address is taken — it returns a user-shaped object with a randomised id and
 * an EMPTY `identities` array instead of an error. That is the documented signal
 * and the only one available.
 *
 * Detecting it matters for two separate reasons:
 *
 *   1. the response must stay identical to a real registration, or this endpoint
 *      becomes the account-enumeration oracle the whole flow avoids being;
 *   2. the `employers` row must NOT be written from it. The id is not a real
 *      `auth.users` row, so the write would either fail the foreign key or — if
 *      Supabase ever returns the genuine id — overwrite a stranger's company
 *      name with whatever this caller typed.
 */
export function isExistingAccount(user: { identities?: unknown[] | null } | null): boolean {
  return Boolean(user && Array.isArray(user.identities) && user.identities.length === 0);
}

export interface EmployerSignUpResult {
  /** The address the link went to, echoed so the check-your-email screen can show it. */
  readonly email: string;
}

/**
 * Create an account and let Supabase send the confirmation.
 *
 * Answers the same way whether the address was new or already registered. The
 * person who already had an account gets nothing new in their inbox — Supabase
 * only re-sends for an address that is still unconfirmed — and finds their way
 * back through "Olvidé mi contraseña", which is the flow that exists for exactly
 * that and discloses nothing either.
 */
export async function registerEmployer(
  input: { company: string; contactName: string; email: string; password: string },
  headers: Headers,
): Promise<EmployerSignUpResult> {
  const ip = clientIp(headers);
  // Two limits: this one request creates an account AND causes mail to be sent
  // to an address the caller chose.
  await enforceRateLimit("employer_register", { ip });
  await enforceRateLimit("employer_email", { ip });

  const email = assertAcceptableCredentials(input.email, input.password);
  const supabase = getEmployerSupabaseClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: {
      emailRedirectTo: callbackUrl(headers, "/empleadores"),
      // Carried on the auth user so the confirmation callback can rebuild the
      // `employers` row if the write below never landed. Not a source of truth:
      // the row written here is, and this is only ever read when there is none.
      data: { company: input.company, contact_name: input.contactName },
    },
  });

  if (error) {
    // ── An explicit "already registered" must NOT become an error response ──
    // Supabase normally hides this behind the empty-`identities` object handled
    // below, but it says so plainly when "Confirm email" is off — and a
    // deployment can end up in that state by a dashboard mistake or a rollback
    // in progress. Letting it fall through to `translateAuthError` would return
    // a 500 for taken addresses and a 200 for free ones, which is a working
    // account-enumeration oracle assembled out of two correct-looking branches.
    // So it takes the same silent path as every other "this address is taken".
    if (
      error.code === "user_already_exists" ||
      error.code === "email_exists" ||
      /already registered|already exists/i.test(error.message)
    ) {
      return { email };
    }
    translateAuthError(error, "sign-up failed");
  }

  const user = data.user;
  if (!user) {
    console.error("[employers] sign-up returned no user and no error");
    throw Errors.internal("No pudimos crear tu cuenta. Vuelve a intentarlo en un momento.");
  }

  // Already registered. Identical response, no write, no email of our own.
  if (isExistingAccount(user)) {
    // Logged because this path is INVISIBLE from the outside — by design — and
    // that makes it the hardest failure to diagnose during setup: re-testing
    // with an address you already used shows the check-your-email screen and
    // sends nothing, which looks exactly like a broken mail transport.
    //
    // The address itself is NOT logged. It belongs to a customer, and a server
    // log is read by more people than their mailbox is.
    console.info(
      "[employers] sign-up for an address that already has an account. No email was " +
        "sent, and the response is deliberately identical to a new registration. If " +
        "you are testing delivery, use an address that has never been registered.",
    );
    return { email };
  }

  // Written from the service role, so it exists before the person ever comes
  // back from their mailbox. A failure here is NOT fatal: `/auth/confirm`
  // rebuilds the row from the metadata above, so a transient outage costs
  // nothing the employer can see.
  try {
    await getEmployerStore().save({
      id: user.id,
      company: input.company,
      contactName: input.contactName,
      email,
      emailVerifiedAt: null,
      ip,
    });
  } catch (storeError) {
    console.error(
      "[employers] the account was created in Supabase Auth but the employers row was not " +
        "written. /auth/confirm will rebuild it from user metadata:",
      storeError,
    );
  }

  return { email };
}

export type SignInOutcome =
  | { readonly status: "ok" }
  /** Correct credentials, address unconfirmed. GoTrue refuses; a resend fixes it. */
  | { readonly status: "unverified"; readonly email: string };

/**
 * Sign in with a password.
 *
 * ── Why `unverified` is not an enumeration leak ─────────────────────────────
 * GoTrue verifies the PASSWORD before it checks confirmation, so
 * `email_not_confirmed` only ever comes back to someone who already supplied the
 * correct password for that address. They have proved more than the existence of
 * the account. Every other failure — no such user, wrong password — collapses
 * into one message.
 */
export async function signInEmployer(
  input: { email: string; password: string },
  headers: Headers,
): Promise<SignInOutcome> {
  await enforceRateLimit("employer_login", { ip: clientIp(headers) });

  const email = inspectEmployerEmail(input.email).normalized;
  const supabase = getEmployerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: input.password,
  });

  if (error) {
    if (error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message)) {
      return { status: "unverified", email };
    }
    if (error.code === "over_request_rate_limit" || /rate limit/i.test(error.message)) {
      throw Errors.rateLimited(
        "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.",
      );
    }
    // Deliberately ONE message. "This email has no account" would turn the login
    // form into the oracle registration is careful not to be.
    throw Errors.unauthorized("Correo o contraseña incorrectos.");
  }
  if (!data.user) throw Errors.unauthorized("Correo o contraseña incorrectos.");

  // Belt and braces: if the project's "Confirm email" were ever turned off, a
  // session would arrive for an unconfirmed address and this is the only place
  // left that would notice.
  if (!data.user.email_confirmed_at) return { status: "unverified", email };

  return { status: "ok" };
}

/**
 * Send the confirmation email again, through Supabase.
 *
 * ── The response never varies ───────────────────────────────────────────────
 * Whether the address has an account, has a *confirmed* account, or has none at
 * all, this resolves the same way. Supabase's own errors here are informative —
 * "User already confirmed" is a clean statement that someone has an account —
 * so they are logged and swallowed rather than returned. Rate limits are the one
 * exception, because the caller genuinely needs to be told to wait.
 */
export async function resendEmployerVerification(email: string, headers: Headers): Promise<void> {
  await enforceRateLimit("employer_email", { ip: clientIp(headers) });
  const normalized = inspectEmployerEmail(email).normalized;

  const supabase = getEmployerSupabaseClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: normalized,
    options: { emailRedirectTo: callbackUrl(headers, "/empleadores") },
  });

  if (!error) return;
  if (error.code === "over_email_send_rate_limit" || /rate limit/i.test(error.message)) {
    throw Errors.rateLimited(
      "Enviamos demasiados correos a esta dirección. Espera unos minutos e inténtalo otra vez.",
    );
  }
  // Swallowed on purpose — see above — but never silent in the LOG. An SMTP
  // failure surfaces here and nowhere the user can see, so this line is what
  // says whether delivery is configured at all.
  console.warn(
    `[employers] resend returned ${error.status ?? "?"} ${error.code ?? ""} ${error.message}. ` +
      "A 5xx mentioning SMTP means Supabase could not hand the message to Resend: check " +
      "Project Settings -> Authentication -> SMTP Settings, and that the Resend domain " +
      "shows as Verified.",
  );
}

/**
 * Start a password recovery. Same silence, for the same reason.
 *
 * `resetPasswordForEmail` does not disclose whether the address exists, which is
 * what lets the UI answer "si existe una cuenta, te enviamos…" honestly rather
 * than as a polite fiction.
 */
export async function requestEmployerPasswordReset(
  email: string,
  headers: Headers,
): Promise<void> {
  await enforceRateLimit("employer_email", { ip: clientIp(headers) });
  const normalized = inspectEmployerEmail(email).normalized;

  const supabase = getEmployerSupabaseClient();
  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: callbackUrl(headers, RECOVERY_DESTINATION),
  });

  if (!error) return;
  if (error.code === "over_email_send_rate_limit" || /rate limit/i.test(error.message)) {
    throw Errors.rateLimited(
      "Enviamos demasiados correos a esta dirección. Espera unos minutos e inténtalo otra vez.",
    );
  }
  console.warn(
    `[employers] password reset returned ${error.status ?? "?"} ${error.code ?? ""} ${error.message}`,
  );
}

/**
 * Set a new password for the CURRENT session.
 *
 * ── The authority is the session, and only the session ──────────────────────
 * Reached in two ways, both of which mean Supabase has already decided this
 * caller may act as this user: a recovery link exchanged for a session by
 * `/auth/confirm`, or an employer already signed in. There is no token parameter
 * to pass and none to forge.
 *
 * This replaced `auth.admin.updateUserById`, which the previous flow needed
 * because its recovery token was ours and produced no session. That call changes
 * ANY user's password given an id, so the whole of its safety was our own token
 * check happening first — a single misordering away from an account takeover.
 * `updateUser` can only ever affect the caller.
 */
export async function setEmployerPassword(password: string): Promise<void> {
  const problem = inspectPassword(password);
  if (problem) throw Errors.validation(problem.message);

  const supabase: SupabaseClient = getEmployerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    throw Errors.unauthorized(
      "Ese enlace ya no sirve — caducan y solo se pueden usar una vez. Pide uno nuevo.",
    );
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "same_password" || /should be different/i.test(error.message)) {
      throw Errors.validation("Elige una contraseña distinta a la que ya tenías.");
    }
    if (error.code === "weak_password" || /password/i.test(error.message)) {
      throw Errors.validation(`Esa contraseña no cumple los requisitos. ${PASSWORD_RULE_TEXT}`);
    }
    if (error.code === "session_not_found" || error.status === 401) {
      throw Errors.unauthorized(
        "Tu sesión de recuperación caducó. Pide un enlace nuevo e inténtalo otra vez.",
      );
    }
    console.error(
      `[employers] password update failed: ${error.status ?? "?"} ${error.code ?? ""} ${error.message}`,
    );
    throw Errors.validation(
      "No pudimos cambiar tu contraseña. Pide un enlace nuevo e inténtalo otra vez.",
    );
  }

  // A completed recovery also proves the mailbox, and Supabase confirms the
  // address as part of it. Mirror that onto our row so the operator view and the
  // audit trail agree with Auth.
  try {
    await getEmployerStore().markEmailVerified(userData.user.id);
  } catch (storeError) {
    console.error("[employers] could not mirror verification after a reset:", storeError);
  }
}

export async function signOutEmployer(): Promise<void> {
  const supabase = getEmployerSupabaseClient();
  // `local` clears this browser's session only. `global` would revoke every
  // refresh token for the account, signing the person out of their other devices
  // as a side effect of pressing "Salir" on a shared office machine.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) {
    // Not fatal, and never surfaced: the cookie is cleared either way, so the
    // browser is signed out even when revoking upstream failed.
    console.warn(`[employers] sign-out returned ${error.status ?? "?"} ${error.message}`);
  }
}
