/**
 * Where an authentication callback is allowed to send someone.
 *
 * ── Why this is a module, and pure ──────────────────────────────────────────
 * Every auth callback in this app takes a destination from the URL — `?next=…`
 * arrives from an email template, and an email template is a string an operator
 * edits in a dashboard, outside code review. That makes it user-controlled input
 * on the one route that has just minted a session. An open redirect there is not
 * a cosmetic bug: the victim clicks a link on our real domain, we authenticate
 * them, and then we hand them to an attacker's page that looks like ours and
 * asks for the password again.
 *
 * Pure — no I/O, no env, no `server-only` — for the same reason
 * `lib/employers/policy.ts` is: this is a rule with a security consequence, so it
 * belongs under test without a database or a request.
 */

/**
 * The paths a callback may land on, as PREFIXES.
 *
 * An allow-list rather than "any same-origin path", which is the usual advice
 * and is not enough here. Same-origin still covers `/api/…` — a redirect that
 * performs an action — and it covers any page a future contributor adds that
 * takes its own `?next=`, which is how a one-hop bounce becomes a two-hop one.
 * The set of places an email link should legitimately end is small and known, so
 * enumerate it.
 *
 * Employer surfaces only, because the employer login is the only login in this
 * product. A job seeker never receives an authentication email — there is no
 * account to confirm (see the "No accounts" section of CLAUDE.md).
 */
export const ALLOWED_REDIRECT_PREFIXES: readonly string[] = [
  "/empleadores",
  "/talento/",
];

/** Where a callback goes when it was given nothing usable. */
export const DEFAULT_REDIRECT = "/empleadores";

/**
 * CR, LF and the rest of the C0 controls, plus DEL.
 *
 * A code-point scan rather than a regex character class: the class would have
 * to contain literal control bytes or their escapes, and both are easy to
 * mangle silently in a way that leaves the check passing everything.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reduce a caller-supplied destination to a path this app will actually redirect
 * to, or fall back to `DEFAULT_REDIRECT`.
 *
 * Rejects, in order:
 *
 *   - anything that is not a string, or is empty;
 *   - control characters, including the CR/LF that split a `Location` header;
 *   - anything not starting with a single `/` — an absolute `https://evil.test`,
 *     a scheme-relative `//evil.test` (which browsers follow off-origin), and the
 *     `/\evil.test` variant that several browsers normalise back into a
 *     scheme-relative URL;
 *   - a destination whose path is not under an allowed prefix.
 *
 * The query string and fragment are preserved, because a legitimate destination
 * may carry one (`/empleadores?estado=…`), but they are re-serialised from a
 * parsed URL rather than concatenated, so a crafted `?` payload cannot smuggle a
 * second `Location` past the check.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string") return DEFAULT_REDIRECT;

  const raw = next.trim();
  if (raw.length === 0) return DEFAULT_REDIRECT;
  if (hasControlCharacter(raw)) return DEFAULT_REDIRECT;
  if (!raw.startsWith("/")) return DEFAULT_REDIRECT;
  // `//host` and `/\host` are both read as scheme-relative by real browsers.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_REDIRECT;

  // Parsed against a throwaway base so the pathname is normalised (`/a/../b`,
  // percent-encoding, a stray backslash) before it is matched. The base never
  // appears in the result — only `pathname + search + hash` is returned.
  let url: URL;
  try {
    url = new URL(raw, "https://redirect.invalid");
  } catch {
    return DEFAULT_REDIRECT;
  }
  // A parse that escaped the base origin means the input was not a plain path
  // after all.
  if (url.origin !== "https://redirect.invalid") return DEFAULT_REDIRECT;

  const path = url.pathname;
  const allowed = ALLOWED_REDIRECT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix),
  );
  if (!allowed) return DEFAULT_REDIRECT;

  return `${path}${url.search}${url.hash}`;
}

/**
 * An absolute URL on THIS origin, for the `emailRedirectTo` / `redirectTo`
 * options Supabase needs and for a `Location` header.
 *
 * The origin comes from the caller (`siteOrigin`), never from the path, so a
 * hostile destination cannot move the target to another host even if it somehow
 * passed `safeNextPath`.
 */
export function absoluteUrl(origin: string, path: string): string {
  return new URL(path, origin.endsWith("/") ? origin : `${origin}/`).toString();
}
