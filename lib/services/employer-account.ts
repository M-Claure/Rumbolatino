import "server-only";
import { getEnv } from "@/lib/env";
import { Errors } from "@/lib/errors";
import { getEmployerStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { getEmployerSupabaseClient } from "@/lib/employers/session";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EMAIL_REJECTION_MESSAGES,
  PASSWORD_RULE_TEXT,
  inspectEmployerEmail,
  inspectPassword,
} from "@/lib/employers/policy";

/**
 * Sign-up, sign-in and the two email flows for employer accounts.
 *
 * ── Where the account actually lives ────────────────────────────────────────
 * In Supabase Auth. We do not hash a password, mint a verification token, or
 * time one out — `auth.users` already does all of that, correctly, and
 * `employers.id` was declared `references auth.users(id)` in `0010` precisely so
 * this would be the shape. What this module owns is the policy around it and the
 * profile row.
 *
 * ── The profile row is written at VERIFICATION, not at sign-up ──────────────
 * This is the important decision in the file, and it is a security one.
 *
 * With email confirmation on, `signUp` for an address that ALREADY has an
 * account deliberately does not say so — it returns a user-shaped object with no
 * identities, so the endpoint cannot be used to enumerate who has an account.
 * That means a sign-up response cannot be trusted to identify a new user. If we
 * wrote `employers` from it, then signing up as `ana@empresa.com` a second time
 * would let an attacker overwrite the real Ana's company and contact name — an
 * unauthenticated write to another account's row.
 *
 * So sign-up stores the company and the person's name in the auth user's
 * metadata and writes NOTHING to our table. `ensureEmployerProfile` in
 * `lib/employers/session.ts` writes the row from an authenticated session, on the
 * first gated request after the link has been clicked — one writer, and it can
 * only ever write the row belonging to the session in front of it.
 */

/** What the client is told after a sign-up. Deliberately identical either way. */
export interface EmployerSignUpResult {
  /** The address the link went to, echoed so the UI can show it. */
  readonly email: string;
}

/**
 * Absolute base URL for the links we ask Supabase to email.
 *
 * Header-derived by default so preview deployments and both brand domains each
 * send links back to themselves. `NEXT_PUBLIC_SITE_URL` overrides for the case
 * where a proxy rewrites the host — see the note on it in `lib/env.ts`.
 */
export function siteOrigin(headers: Headers): string {
  const configured = getEnv().NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    // Not recoverable: a relative redirect in an email is useless, and guessing
    // localhost would send production users to their own machine.
    throw Errors.internal(
      "No pudimos construir el enlace de confirmación. Configura NEXT_PUBLIC_SITE_URL.",
    );
  }
  const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function assertAcceptableCredentials(email: string, password: string): string {
  const verdict = inspectEmployerEmail(email);
  if (verdict.rejection) {
    throw Errors.validation(EMAIL_REJECTION_MESSAGES[verdict.rejection]);
  }
  const passwordProblem = inspectPassword(password);
  if (passwordProblem) throw Errors.validation(passwordProblem.message);
  return verdict.normalized;
}

export async function registerEmployer(
  input: { company: string; contactName: string; email: string; password: string },
  headers: Headers,
): Promise<EmployerSignUpResult> {
  const ip = clientIp(headers);
  // Two limits, because this one request does two costly things: it creates an
  // account and it sends mail to an address the caller chose.
  await enforceRateLimit("employer_register", { ip });
  await enforceRateLimit("employer_email", { ip });

  const email = assertAcceptableCredentials(input.email, input.password);
  const supabase = getEmployerSupabaseClient();

  const { error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: {
      emailRedirectTo: `${siteOrigin(headers)}/empleadores/verificar`,
      // Carried on the auth user until the link is clicked — see the note above
      // on why this is not written to `employers` yet.
      data: { company: input.company, contact_name: input.contactName },
    },
  });

  if (error) {
    // Supabase's own messages are English and sometimes internal. A password it
    // rejects under its project policy is the one case worth translating, and the
    // message must restate the WHOLE rule: `inspectPassword` already checked
    // length and character classes, so reaching here means the project setting is
    // stricter than this code — telling them "usa una más larga" would be a guess,
    // and a wrong one if what is missing is a symbol.
    if (/password/i.test(error.message)) {
      throw Errors.validation(`Esa contraseña no cumple los requisitos. ${PASSWORD_RULE_TEXT}`);
    }
    console.error(`[employers] sign-up failed: ${error.status ?? "?"} ${error.message}`);
    throw Errors.internal("No pudimos crear tu cuenta. Vuelve a intentarlo en un momento.");
  }

  // Never branch the response on whether the address was already registered:
  // that is exactly the enumeration Supabase is avoiding by not telling us.
  return { email };
}

export type SignInOutcome =
  | { readonly status: "ok" }
  /** Correct credentials, mailbox never confirmed. A resend fixes it. */
  | { readonly status: "unverified"; readonly email: string };

export async function signInEmployer(
  input: { email: string; password: string },
  headers: Headers,
): Promise<SignInOutcome> {
  const ip = clientIp(headers);
  await enforceRateLimit("employer_login", { ip });

  const email = inspectEmployerEmail(input.email).normalized;
  const supabase = getEmployerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: input.password });

  if (error) {
    // The ONE distinction worth making. Answering this with "wrong password"
    // would leave someone with correct credentials locked out and no idea why.
    if (error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message)) {
      return { status: "unverified", email };
    }
    // Everything else is deliberately one message: saying "this email has no
    // account" turns the login form into an account-existence oracle.
    throw Errors.unauthorized("Correo o contraseña incorrectos.");
  }

  // The `employers` row is NOT written here. `resolveEmployerSession` creates it
  // on the first gated request, so there is exactly one place that does — see the
  // note on `ensureEmployerProfile` for why it must be an authenticated read.
  return { status: "ok" };
}

/** Re-send the confirmation link. Rate limited hard: it sends mail. */
export async function resendEmployerVerification(email: string, headers: Headers): Promise<void> {
  await enforceRateLimit("employer_email", { ip: clientIp(headers) });
  const normalized = inspectEmployerEmail(email).normalized;

  const { error } = await getEmployerSupabaseClient().auth.resend({
    type: "signup",
    email: normalized,
    options: { emailRedirectTo: `${siteOrigin(headers)}/empleadores/verificar` },
  });
  // Errors are logged, not surfaced: whether an address has a pending
  // confirmation is the same fact the sign-up path refuses to reveal.
  if (error) console.error(`[employers] resend failed: ${error.status ?? "?"} ${error.message}`);
}

/** Start a password reset. Same silence, for the same reason. */
export async function requestEmployerPasswordReset(
  email: string,
  headers: Headers,
): Promise<void> {
  await enforceRateLimit("employer_email", { ip: clientIp(headers) });
  const normalized = inspectEmployerEmail(email).normalized;

  const { error } = await getEmployerSupabaseClient().auth.resetPasswordForEmail(normalized, {
    redirectTo: `${siteOrigin(headers)}/empleadores/nueva-contrasena`,
  });
  if (error) console.error(`[employers] reset failed: ${error.status ?? "?"} ${error.message}`);
}

/**
 * Set a new password for whoever holds the recovery session.
 *
 * The authorization here IS the session: clicking the emailed link exchanges a
 * one-time code for one, so possession of a session on the employer cookie is
 * proof the mailbox was reached. There is deliberately no "current password"
 * field — the person using this flow is the one who does not know it.
 */
export async function setEmployerPassword(password: string): Promise<void> {
  const problem = inspectPassword(password);
  if (problem) throw Errors.validation(problem.message);

  const supabase = getEmployerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    throw Errors.unauthorized(
      "El enlace para cambiar tu contraseña ya no es válido. Pide uno nuevo.",
    );
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error(`[employers] password update failed: ${error.status ?? "?"} ${error.message}`);
    throw Errors.validation("No pudimos cambiar tu contraseña. Intenta con otra.");
  }

  // A reset also confirms the address (Supabase marks it so), so someone who
  // never clicked their sign-up link but did reset their password arrives at the
  // directory verified, and the gate writes their profile row there.
}

export async function signOutEmployer(): Promise<void> {
  await getEmployerSupabaseClient().auth.signOut();
}

/**
 * Turn the one-time credential in an emailed link into a session.
 *
 * TWO shapes are accepted, and both are necessary:
 *
 *   ?code=…                      the PKCE exchange. This is what Supabase sends
 *                                back by default, because the sign-up that
 *                                started the flow was server-side with PKCE. It
 *                                requires the code-verifier cookie set at
 *                                sign-up, so it only works in the SAME browser.
 *
 *   ?token_hash=…&type=signup    the verifier-free path, which works when the
 *                                link is opened anywhere. This is the common
 *                                case — people read mail on a phone and signed
 *                                up on a laptop — but it only appears in the URL
 *                                if the project's email template is changed to
 *                                use `{{ .TokenHash }}` instead of
 *                                `{{ .ConfirmationURL }}`. See docs.
 *
 * Handling only the first would strand every cross-device click on an error
 * page, which is why both are here even though one needs an operator step.
 */
export async function exchangeEmployerAuthCode(
  url: URL,
  /**
   * REQUIRED, and deliberately not defaulted to `getEmployerSupabaseClient()`.
   * This call creates a session, so its cookie writes have to land on the
   * response the caller is about to return — see `employerClientForRoute`. A
   * default here would make the broken form the easy one to reach for.
   */
  supabase: SupabaseClient,
): Promise<boolean> {
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return true;
    console.error(`[employers] code exchange failed: ${error.message}`);
    return false;
  }

  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (tokenHash && (type === "signup" || type === "email" || type === "recovery")) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return true;
    console.error(`[employers] otp verify failed: ${error.message}`);
    return false;
  }

  // Supabase puts its own failures here — an expired or already-used link.
  const described = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (described) console.error(`[employers] link rejected upstream: ${described}`);
  return false;
}
