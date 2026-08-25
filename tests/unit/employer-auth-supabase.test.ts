import { describe, expect, it } from "vitest";
import { AuthError } from "@supabase/supabase-js";
import { isAppError } from "@/lib/errors";
import {
  RECOVERY_DESTINATION,
  callbackDestination,
  failureFromQuery,
  parseOtpType,
} from "@/lib/employers/auth-callback";
import { isExistingAccount, translateAuthError } from "@/lib/services/employer-account";
import { DEFAULT_REDIRECT } from "@/lib/auth-redirect";

/**
 * The seams where this app meets Supabase Auth.
 *
 * Everything here is a pure function on Supabase's *answers* — which type of OTP
 * arrived, what a GoTrue error means, whether `signUp` just described an account
 * that already existed. The network calls themselves are not unit-tested, and
 * deliberately: mocking `signUp` would assert that our mock behaves the way we
 * assumed, which is precisely the assumption that breaks. Those are covered by
 * the manual checklist in `AUTH_PRODUCTION_SETUP.md`, against a real project.
 */

/** Build an `AuthError` the way the SDK does, so the field names match. */
function authError(message: string, code?: string, status = 400): AuthError {
  const error = new AuthError(message, status, code);
  return error;
}

// ── Duplicate sign-up ───────────────────────────────────────────────────────

describe("detecting an address that already has an account", () => {
  it("reads Supabase's empty-identities signal", () => {
    // With "Confirm email" ON, Supabase refuses to say the address is taken. It
    // returns a user-shaped object with a randomised id and NO identities. That
    // is the only signal available, and getting it wrong has two consequences:
    // the endpoint becomes an enumeration oracle, or we write an `employers` row
    // keyed to a user id that does not exist.
    expect(isExistingAccount({ identities: [] })).toBe(true);
  });

  it("treats a genuinely new user as new", () => {
    expect(isExistingAccount({ identities: [{ provider: "email" }] })).toBe(false);
  });

  it("does not claim 'existing' when Supabase told us nothing", () => {
    // `identities` absent or null is not the same as empty. Reading it as
    // "existing" would silently stop writing the employers row for every new
    // sign-up, and the account would then be refused by the gate forever.
    expect(isExistingAccount({ identities: null })).toBe(false);
    expect(isExistingAccount({})).toBe(false);
    expect(isExistingAccount(null)).toBe(false);
  });
});

// ── Error translation ───────────────────────────────────────────────────────

describe("translating GoTrue errors", () => {
  /** Run the translator and hand back the AppError it threw. */
  function thrownBy(error: AuthError) {
    try {
      translateAuthError(error, "test");
    } catch (caught) {
      if (isAppError(caught)) return caught;
      throw caught;
    }
    throw new Error("translateAuthError must always throw");
  }

  it("maps a weak password to a validation error carrying the Spanish rule", () => {
    // The whole reason this function exists: Supabase rejects in English, with
    // advice a Spanish-speaking user cannot act on.
    const error = thrownBy(authError("Password should contain at least one character of...", "weak_password", 422));
    expect(error.code).toBe("validation_error");
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/mayúscula/);
  });

  it("maps an email send rate limit to a 429 that says to wait", () => {
    const error = thrownBy(
      authError("email rate limit exceeded", "over_email_send_rate_limit", 429),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/minutos/);
  });

  it("maps a malformed address to the same message the shared policy uses", () => {
    const error = thrownBy(authError("Unable to validate email address: invalid format", "email_address_invalid"));
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("Escribe un correo electrónico válido.");
  });

  it("maps disabled sign-ups to a 503, not a user error", () => {
    // An operator turned sign-ups off. Telling the visitor their data was wrong
    // would send them round a form that cannot succeed.
    const error = thrownBy(authError("Signups not allowed for this instance", "signup_disabled", 422));
    expect(error.code).toBe("service_unavailable");
  });

  it("never leaks an unrecognised upstream message to the user", () => {
    const error = thrownBy(authError("pq: relation \"auth.users\" does not exist", undefined, 500));
    expect(error.code).toBe("internal_error");
    expect(error.message).not.toMatch(/pq:|auth\.users/);
    expect(error.message).toBe(
      "No pudimos completar la operación. Vuelve a intentarlo en un momento.",
    );
  });
});

// ── Callback parameters ─────────────────────────────────────────────────────

describe("parseOtpType", () => {
  it("accepts the types Supabase actually sends", () => {
    for (const type of ["signup", "recovery", "email_change", "email", "magiclink", "invite"]) {
      expect(parseOtpType(type)).toBe(type);
    }
  });

  it("rejects anything else, so a crafted link cannot pick its own verification path", () => {
    expect(parseOtpType("sms")).toBeNull();
    expect(parseOtpType("phone_change")).toBeNull();
    expect(parseOtpType("")).toBeNull();
    expect(parseOtpType(null)).toBeNull();
  });
});

describe("callbackDestination", () => {
  it("sends a recovery link to the password form even with no next", () => {
    // A stock template carries no `next`. Without this, someone clicking "cambiar
    // mi contraseña" would land on the directory holding a recovery session and
    // never see the form they clicked for.
    expect(callbackDestination(null, "recovery")).toBe(RECOVERY_DESTINATION);
    expect(callbackDestination(DEFAULT_REDIRECT, "recovery")).toBe(RECOVERY_DESTINATION);
  });

  it("still honours an explicit, allowed next on a recovery link", () => {
    expect(callbackDestination("/empleadores/nueva-contrasena", "recovery")).toBe(
      "/empleadores/nueva-contrasena",
    );
  });

  it("sends a confirmation to the directory", () => {
    expect(callbackDestination(null, "signup")).toBe(DEFAULT_REDIRECT);
    expect(callbackDestination("/empleadores?zip=77002", "signup")).toBe("/empleadores?zip=77002");
  });

  it("refuses a hostile next regardless of type", () => {
    expect(callbackDestination("https://evil.test", "signup")).toBe(DEFAULT_REDIRECT);
    // Recovery is the dangerous one: the session it mints can change a password.
    expect(callbackDestination("//evil.test", "recovery")).toBe(RECOVERY_DESTINATION);
  });
});

describe("failureFromQuery", () => {
  it("recognises an expired link from Supabase's own error parameters", () => {
    // Supabase reports a dead link by redirecting to us with `error=…` and NO
    // credential, so this has to be checked before looking for a token.
    const url = new URL(
      "https://rumbolatino.com/auth/confirm?error=access_denied&error_code=otp_expired" +
        "&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(failureFromQuery(url)).toBe("enlace_expirado");
  });

  it("treats any other reported error as an invalid link", () => {
    const url = new URL("https://rumbolatino.com/auth/confirm?error=access_denied");
    expect(failureFromQuery(url)).toBe("enlace_invalido");
  });

  it("says nothing when there is no error to report", () => {
    const url = new URL("https://rumbolatino.com/auth/confirm?token_hash=abc&type=signup");
    expect(failureFromQuery(url)).toBeNull();
  });
});
