/**
 * What counts as an acceptable employer account, as pure rules.
 *
 * ── Why a module and not four `if`s in a route handler ──────────────────────
 * Every rule here is a claim about who is allowed to see a list of real people
 * looking for work, and each one is a decision someone will want to revisit
 * under pressure ("this customer can't sign up"). That belongs next to its
 * reasoning and under test — the same argument `lib/rate-limit/policy.ts` makes
 * for request limits and `lib/talent/taxonomy.ts` makes for the category list.
 *
 * Pure: no I/O, no env, no `server-only`, so both sides of the wire can read the
 * same rules and the tests need no database.
 */

/**
 * ── Free webmail is ACCEPTED, on purpose ────────────────────────────────────
 * There is no company-domain requirement, and adding one would be a product
 * decision rather than a security improvement. The employers this directory
 * exists for are small local businesses — a taquería hiring a cook, a family
 * hiring a niñera, a two-truck HVAC shop — and a large share of them have no
 * domain at all. Rejecting `@gmail.com` would gate out the demand side of the
 * marketplace to buy a signal we get anyway by making them click a link.
 *
 * What IS rejected is a throwaway inbox. A disposable address defeats the whole
 * point of verifying: it proves someone controlled a mailbox for ten minutes,
 * which is not an accountable party, and it makes the `contact_reveals` log
 * worthless as a record of who downloaded whose résumé.
 *
 * This list is deliberately SHORT and covers the well-known services rather than
 * chasing the long tail. A blocklist of throwaway domains is unwinnable — new
 * ones appear daily — so treat it as a speed bump that raises the cost of a bulk
 * signup, never as a wall. The real ceilings are the rate limits and the reveal
 * audit.
 */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mintemail.com",
  "mohmal.com",
  "tempinbox.com",
  "spam4.me",
  "grr.la",
  "email-temp.com",
  // Reserved by RFC 2606, and the domain `lib/auth.ts` gives guest accounts.
  // A job seeker's throwaway identity must never be able to become an employer.
  "guest.invalid",
  "example.com",
  "test.com",
];

/**
 * Minimum password length.
 *
 * Ten rather than Supabase's default six because what sits behind this account
 * is other people's phone numbers, and six characters is inside brute-force
 * range for anyone who cares.
 *
 * Supabase enforces its own project-level minimum as well. If that is raised
 * above this number, the API's rejection wins and the message the user sees will
 * be Supabase's, not ours — keep this at or above the project setting.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** Supabase rejects anything over 72 bytes outright, so we say so first. */
export const MAX_PASSWORD_LENGTH = 72;

/**
 * ── Composition IS required: upper, lower, digit, symbol ─────────────────────
 * This mirrors the Supabase project setting **Authentication → Providers →
 * Email → Password Requirements → "Lowercase, uppercase letters, digits and
 * symbols"**, which is the authority — it is enforced server-side by the auth
 * API whatever this file says.
 *
 * Be honest about the trade, because it cuts against the usual advice: NIST
 * dropped composition rules on the evidence that they push people toward
 * `Empresa1!` and a sticky note, where a long passphrase would be stronger. The
 * product owner chose to match Supabase's strictest setting anyway. That is a
 * decision, not an oversight — the same way five Rumbo Latino colour pairs sit
 * below WCAG AA on purpose.
 *
 * What matters for the CODE is that this check exists at all. Without it the
 * only enforcement is Supabase's, which rejects in ENGLISH with a message this
 * product's Spanish-speaking users cannot act on — and the fallback we would
 * otherwise show ("usa una más larga") is actively wrong advice for a password
 * that is long but has no symbol. So mirror the rule, name the missing pieces in
 * Spanish, and keep this list in step with the dashboard.
 *
 * The symbol set is GoTrue's own, reproduced exactly rather than approximated as
 * "any non-alphanumeric". Being MORE permissive here would accept a character
 * Supabase does not count and hand the user the English error we are trying to
 * avoid; being LESS permissive would reject a password it would have taken.
 */
export const PASSWORD_SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`";

export type EmailRejection = "malformed" | "disposable";

export interface EmailVerdict {
  /** Lowercased and trimmed — what to store and what to hand to Supabase. */
  readonly normalized: string;
  readonly rejection: EmailRejection | null;
}

/**
 * Deliberately conservative: one `@`, something either side, a dot in the
 * domain, no whitespace. Not RFC 5322 — that grammar accepts addresses no mail
 * provider will issue, and the authoritative check is whether the verification
 * link is ever clicked. This only catches typing mistakes early.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The domain part, or "" when there isn't one. */
export function emailDomain(email: string): string {
  const at = normalizeEmail(email).lastIndexOf("@");
  return at === -1 ? "" : normalizeEmail(email).slice(at + 1);
}

export function inspectEmployerEmail(email: string): EmailVerdict {
  const normalized = normalizeEmail(email);
  if (!EMAIL_SHAPE.test(normalized)) return { normalized, rejection: "malformed" };

  const domain = emailDomain(normalized);
  // Subdomain match too (`foo.mailinator.com`), which is how most of these
  // services hand out unlimited addresses.
  const disposable = DISPOSABLE_EMAIL_DOMAINS.some(
    (blocked) => domain === blocked || domain.endsWith(`.${blocked}`),
  );
  return { normalized, rejection: disposable ? "disposable" : null };
}

/** Spanish, and specific about what to do next — never just "inválido". */
export const EMAIL_REJECTION_MESSAGES: Record<EmailRejection, string> = {
  malformed: "Escribe un correo electrónico válido.",
  disposable:
    "Usa un correo permanente. No aceptamos correos temporales, porque las personas del " +
    "directorio necesitan poder saber quién vio sus datos.",
};

export type PasswordRejection = "too_short" | "too_long" | "missing_classes";

/** The whole rule in one Spanish sentence. Shown next to the field, before anyone types. */
export const PASSWORD_RULE_TEXT =
  `Al menos ${MIN_PASSWORD_LENGTH} caracteres, con una mayúscula, una minúscula, ` +
  `un número y un símbolo (por ejemplo ! @ # $ % & * ?).`;

export interface PasswordProblem {
  readonly rejection: PasswordRejection;
  /** Ready to show. Built here so the server and the form cannot word it differently. */
  readonly message: string;
}

const CHARACTER_CLASSES = [
  { label: "una minúscula", test: (p: string) => /\p{Ll}/u.test(p) },
  { label: "una mayúscula", test: (p: string) => /\p{Lu}/u.test(p) },
  { label: "un número", test: (p: string) => /\p{Nd}/u.test(p) },
  // Membership test rather than a regex: the set contains `\`, `"`, `[`, `]` and
  // backtick, and escaping those into a character class is exactly the kind of
  // fiddly that silently stops matching one of them.
  { label: "un símbolo", test: (p: string) => [...PASSWORD_SYMBOLS].some((c) => p.includes(c)) },
] as const;

export function inspectPassword(password: string): PasswordProblem | null {
  // Byte length, not character count: Supabase's 72 is bytes, and an accented
  // or emoji-bearing passphrase reaches it sooner than it looks.
  const bytes = new TextEncoder().encode(password).length;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      rejection: "too_short",
      message: `Tu contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    };
  }
  if (bytes > MAX_PASSWORD_LENGTH) {
    return {
      rejection: "too_long",
      message: `Tu contraseña no puede pasar de ${MAX_PASSWORD_LENGTH} caracteres.`,
    };
  }

  // Every missing class in ONE message. Reporting them one at a time turns a
  // single fix into four rejected attempts.
  const missing = CHARACTER_CLASSES.filter((c) => !c.test(password)).map((c) => c.label);
  if (missing.length > 0) {
    const list =
      missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(", ")} y ${missing[missing.length - 1]}`;
    return {
      rejection: "missing_classes",
      message: `A tu contraseña le falta ${list}. ${PASSWORD_RULE_TEXT}`,
    };
  }
  return null;
}
