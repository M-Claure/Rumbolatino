import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_EMAIL_DOMAINS,
  EMAIL_REJECTION_MESSAGES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULE_TEXT,
  PASSWORD_SYMBOLS,
  emailDomain,
  inspectEmployerEmail,
  inspectPassword,
  normalizeEmail,
} from "@/lib/employers/policy";
import { LIMITS, isOverLimit, rateLimitKey } from "@/lib/rate-limit/policy";

// ── Which addresses may hold an employer account ────────────────────────────

describe("employer email policy", () => {
  it("ACCEPTS free webmail, which is the whole point of the rule", () => {
    // Not an oversight to tighten later. The employers this directory exists for
    // are small local businesses — a taquería, a family hiring a niñera, a
    // two-truck HVAC shop — and many have no domain at all. Requiring a company
    // domain would gate out the demand side of the marketplace.
    for (const email of [
      "ana.ruiz@gmail.com",
      "ana@hotmail.com",
      "ana@yahoo.com.mx",
      "ana@outlook.com",
      "ana@icloud.com",
    ]) {
      expect(inspectEmployerEmail(email).rejection, email).toBeNull();
    }
  });

  it("accepts a company domain just the same", () => {
    expect(inspectEmployerEmail("ana@taqueriaelsol.com").rejection).toBeNull();
    expect(inspectEmployerEmail("ana@sub.empresa.com.mx").rejection).toBeNull();
  });

  it("rejects throwaway inboxes, including their subdomains", () => {
    expect(inspectEmployerEmail("x@mailinator.com").rejection).toBe("disposable");
    // Most of these services hand out unlimited addresses on subdomains, so
    // matching the bare domain only would be trivially bypassed.
    expect(inspectEmployerEmail("x@inbox.mailinator.com").rejection).toBe("disposable");
    expect(inspectEmployerEmail("x@yopmail.com").rejection).toBe("disposable");
  });

  it("rejects the guest domain, so a job seeker's throwaway id cannot become an employer", () => {
    // `lib/auth.ts` provisions guest accounts at `@guest.invalid`. Those exist to
    // give an anonymous résumé an `auth.users` row; they must never be a way in
    // to other people's contact details.
    expect(inspectEmployerEmail("guest-abc@guest.invalid").rejection).toBe("disposable");
    expect(DISPOSABLE_EMAIL_DOMAINS).toContain("guest.invalid");
  });

  it("rejects malformed addresses before anything is sent", () => {
    for (const bad of ["ana", "ana@", "@empresa.com", "ana@empresa", "a b@empresa.com", ""]) {
      expect(inspectEmployerEmail(bad).rejection, bad).toBe("malformed");
    }
  });

  it("normalizes case and whitespace, so one mailbox is one account", () => {
    expect(normalizeEmail("  Ana@Empresa.COM ")).toBe("ana@empresa.com");
    expect(inspectEmployerEmail("  ANA@EMPRESA.com ").normalized).toBe("ana@empresa.com");
    // A rejected address is still normalized, so the UI can echo back what it read.
    expect(inspectEmployerEmail(" X@MAILINATOR.com ").normalized).toBe("x@mailinator.com");
  });

  it("reads the domain from the LAST @, not the first", () => {
    expect(emailDomain("weird@name@empresa.com")).toBe("empresa.com");
  });

  it("has a Spanish message for every rejection", () => {
    // A rejection with no message reaches the user as "undefined".
    for (const reason of ["malformed", "disposable"] as const) {
      expect(EMAIL_REJECTION_MESSAGES[reason].length).toBeGreaterThan(10);
    }
  });
});

// ── Passwords ───────────────────────────────────────────────────────────────

describe("employer password policy", () => {
  // The rule MIRRORS the Supabase project setting "Lowercase, uppercase letters,
  // digits and symbols". Supabase enforces it server-side whatever this file
  // says, so the value of checking here is a Spanish message that names what is
  // missing instead of an English one the user cannot act on.
  const VALID = "Taqueria99!";

  it("accepts a password with all four character classes", () => {
    expect(inspectPassword(VALID)).toBeNull();
  });

  it("requires each of the four classes, and says which one is missing", () => {
    const cases: Array<[string, string]> = [
      ["TAQUERIA99!", "una minúscula"],
      ["taqueria99!", "una mayúscula"],
      ["TaqueriaAA!", "un número"],
      ["Taqueria999", "un símbolo"],
    ];
    for (const [password, expected] of cases) {
      const problem = inspectPassword(password);
      expect(problem?.rejection, password).toBe("missing_classes");
      expect(problem?.message, password).toContain(expected);
    }
  });

  it("names EVERY missing class in one message, not one per attempt", () => {
    // Reporting them one at a time turns a single fix into four rejected tries.
    const problem = inspectPassword("aaaaaaaaaaaa");
    expect(problem?.message).toContain("una mayúscula");
    expect(problem?.message).toContain("un número");
    expect(problem?.message).toContain("un símbolo");
  });

  it("checks length before composition, so the message is the useful one", () => {
    // "Ab1!" is missing nothing but length; saying "te falta un símbolo" would be
    // false, and saying nothing about length would be useless.
    expect(inspectPassword("Ab1!")?.rejection).toBe("too_short");
  });

  it("counts BYTES against the maximum, not characters", () => {
    // Supabase's 72 is bytes. An accented passphrase reaches it sooner than it
    // looks, and letting it through here means the API rejects it instead — with
    // an English message the user cannot act on.
    const accented = `A1!${"ñ".repeat(40)}`; // 83 bytes, 43 characters
    expect(accented.length).toBeLessThanOrEqual(MAX_PASSWORD_LENGTH);
    expect(inspectPassword(accented)?.rejection).toBe("too_long");
  });

  it("stays inside the ceiling Supabase enforces", () => {
    expect(MAX_PASSWORD_LENGTH).toBeLessThanOrEqual(72);
    expect(MIN_PASSWORD_LENGTH).toBeLessThan(MAX_PASSWORD_LENGTH);
  });

  it("uses GoTrue's own symbol set, character for character", () => {
    // Not approximated as "any non-alphanumeric": accepting a symbol Supabase
    // does not count would hand the user the English error this check exists to
    // avoid, and rejecting one it does count would refuse a valid password.
    for (const symbol of "!@#$%^&*()_+-=[]{};':\"|<>?,./`\\") {
      expect(PASSWORD_SYMBOLS, symbol).toContain(symbol);
      expect(inspectPassword(`Taqueria99${symbol}`), symbol).toBeNull();
    }
    // A character outside the set does not satisfy the symbol requirement.
    expect(inspectPassword("Taqueria99€")?.rejection).toBe("missing_classes");
  });

  it("states the whole rule in the text shown next to the field", () => {
    // One sentence, shared by both forms and the server's fallback message, so
    // they cannot word the same rule differently.
    for (const fragment of ["mayúscula", "minúscula", "número", "símbolo"]) {
      expect(PASSWORD_RULE_TEXT).toContain(fragment);
    }
    expect(PASSWORD_RULE_TEXT).toContain(String(MIN_PASSWORD_LENGTH));
  });
});

// ── The limits in front of the account routes ───────────────────────────────

describe("employer rate limits", () => {
  it("counts registration, login and outbound email separately", () => {
    for (const op of ["employer_register", "employer_login", "employer_email"] as const) {
      expect(LIMITS[op].limit).toBeGreaterThan(0);
      expect(LIMITS[op].reason.length).toBeGreaterThan(40);
    }
  });

  it("keeps the mail-sending limit the tightest of the three", () => {
    // Every hit sends a message from our domain to an address someone else
    // typed. Loose limits here are a way to mail-bomb a third party and to burn
    // the sending reputation the verification link depends on.
    expect(LIMITS.employer_email.limit).toBeLessThan(LIMITS.employer_register.limit);
    expect(LIMITS.employer_email.limit).toBeLessThan(LIMITS.employer_login.limit);
  });

  it("keeps login attempts far below a dictionary attack", () => {
    expect(LIMITS.employer_login.limit).toBeLessThanOrEqual(20);
    expect(isOverLimit("employer_login", LIMITS.employer_login.limit + 1)).toBe(true);
  });

  it("falls back to an IP key, because a failed login has no user", () => {
    // The counter has to attribute an attempt that never produced a session, or
    // password guessing would be counted against nobody.
    expect(rateLimitKey("employer_login", { ip: "203.0.113.7" })).toBe(
      "ip:203.0.113.7:employer_login",
    );
    expect(rateLimitKey("employer_login", { userId: null, ip: null })).toBe(
      "ip:unknown:employer_login",
    );
  });

  it("keys the reveal limit by ACCOUNT now that there is always one", () => {
    // The gate guarantees an employer session on every reveal, so this limit no
    // longer degrades to a shared-IP bucket — changing networks does not reset it.
    expect(rateLimitKey("contact_reveal", { userId: "emp-1", ip: "203.0.113.7" })).toBe(
      "user:emp-1:contact_reveal",
    );
  });
});
