import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * The credentials inside verification and password-reset links.
 *
 * ── RETIRED, AND KEPT ON PURPOSE ────────────────────────────────────────────
 * Nothing in the running application calls this any more. Verification and
 * password recovery are Supabase Auth's again, delivered over Resend Custom
 * SMTP — see the header of `lib/services/employer-account.ts` for why that
 * became possible and `AUTH_PRODUCTION_SETUP.md` for the configuration.
 *
 * It stays, together with `employer_email_tokens` and
 * `mcv_consume_employer_token`, because it IS the rollback: reverting the
 * switch restores a working flow with no database migration and no data loss.
 * Delete all three once native delivery has been observed in production for
 * long enough to trust it — and delete them together, in one change.
 *
 * Everything below describes how it worked and still works if called.
 *
 * ── Only the hash is ever stored ────────────────────────────────────────────
 * `issueToken` returns the secret to put in the link and the hash to put in the
 * database, and nothing keeps the two together. A reset link is enough to take
 * over an account, so the table must be worthless to anyone who reads it — a
 * leaked backup, a support query, a stray `select *` in a log. Same reasoning as
 * passwords; the difference is only that these expire on their own.
 *
 * Lookups are BY hash, so there is no secret comparison anywhere and no timing
 * side channel to think about: the hash is the index key.
 *
 * ── Why SHA-256 and not bcrypt/argon2 ───────────────────────────────────────
 * Those exist to make GUESSING expensive, which matters for a human-chosen
 * password with maybe 40 bits of entropy. This token has 256 bits from a CSPRNG;
 * there is nothing to guess, and a slow hash would only add latency to every
 * click of a link. A fast cryptographic digest is the right tool for a
 * high-entropy secret.
 */

/** 32 bytes, base64url — URL-safe with no escaping, and no `+/=` to be mangled by a mail client. */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Goes in the link. Never stored, never logged. */
  readonly token: string;
  /** Goes in the database. */
  readonly tokenHash: string;
}

export function issueToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * ── Lifetimes ───────────────────────────────────────────────────────────────
 * Verification is generous and reset is short, because what a stolen link can do
 * differs. A verification link only proves an address was reached — a day lets
 * someone sign up at work and finish from their phone that evening. A reset link
 * takes over the account, so it lives about as long as the person's attention
 * does; anything left in a mailbox overnight should be dead.
 */
export const VERIFY_TOKEN_HOURS = 24;
export const RESET_TOKEN_MINUTES = 60;

export function verifyTokenExpiry(now = new Date()): string {
  return new Date(now.getTime() + VERIFY_TOKEN_HOURS * 3600_000).toISOString();
}

export function resetTokenExpiry(now = new Date()): string {
  return new Date(now.getTime() + RESET_TOKEN_MINUTES * 60_000).toISOString();
}

export type TokenPurpose = "verify" | "reset";
