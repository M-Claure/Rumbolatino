/**
 * Pure helpers for the personal_information capture: a person's name, their
 * contact channels, and where they live.
 *
 * Two different shapes exist on purpose:
 *
 *  - `isEmail` / `isPhone` validate a SINGLE dedicated field. The start screen
 *    asks for the email and the phone separately, so there is nothing to guess:
 *    each value is checked whole, which is why they are the only validators the
 *    create-profile path uses.
 *  - `parseContact` / `parsePersonalInformation` EXTRACT details out of one
 *    free-text answer. Only the funnel's `personal_contact` question still needs
 *    this (it asks for "correo o teléfono" in a single box), and it is reached
 *    only by profiles that predate up-front capture.
 *
 * No I/O and no imports, so this is safe from route handlers, validation
 * schemas, and the browser alike.
 */

/** TLD constrained to letters so trailing punctuation never lands in the value. */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/;
/** Anchored on digits at both ends, so punctuation can't lead or trail. */
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;

const EMAIL_EXACT_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
/** Digits plus the punctuation people actually type: + ( ) - . and spaces. */
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;
/** E.164 allows at most 15 digits; 7 is the shortest realistic local number. */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

export interface ParsedContact {
  email: string | null;
  phone: string | null;
}

export interface ParsedName {
  firstName: string | null;
  lastName: string | null;
}

/** Whole-value check for a dedicated email field. */
export function isEmail(value: string): boolean {
  return EMAIL_EXACT_RE.test(value.trim());
}

/** Whole-value check for a dedicated phone field. */
export function isPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!PHONE_CHARS_RE.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "").length;
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

/** Pull an email and/or a phone number out of free text. */
export function parseContact(raw: string): ParsedContact {
  const email = raw.match(EMAIL_RE)?.[0] ?? null;
  // Strip the email first so its digits can't be mistaken for a phone number.
  const phone = raw.replace(EMAIL_RE, "").match(PHONE_RE)?.[0]?.trim() ?? null;
  return { email, phone };
}

/** First token is the given name; everything after it is the family name. */
export function parseFullName(raw: string): ParsedName {
  const parts = raw
    .replace(/[,;]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

/**
 * Parse the answer to "¿En qué ciudad y país vives?" into the three fields the
 * résumé renderer joins back together.
 *
 * Deliberately positional and dumb. The renderer emits
 * `[city, state, country].filter(Boolean).join(", ")`, so a mis-bucketed middle
 * part costs nothing — "Miami, Florida" reads identically whether Florida landed
 * in `state` or `country`. What matters is that the answer lands in the LOCATION
 * fields at all: routed through `parseFullName` instead, "Miami" became the
 * person's first name and the location was lost entirely.
 *
 *   "Miami"                          → city
 *   "Miami, Estados Unidos"          → city, country
 *   "Houston, Texas, Estados Unidos" → city, state, country
 */
export function parseLocationAnswer(raw: string): {
  city: string | null;
  state: string | null;
  country: string | null;
} {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { city: null, state: null, country: null };
  if (parts.length === 1) return { city: parts[0]!, state: null, country: null };
  if (parts.length === 2) return { city: parts[0]!, state: null, country: parts[1]! };
  // Anything beyond the third part is still part of the country name
  // ("Ciudad de México, CDMX, Estados Unidos Mexicanos" splits oddly otherwise).
  return { city: parts[0]!, state: parts[1]!, country: parts.slice(2).join(", ") };
}

/**
 * Parse a single free-text answer that may carry both the name and the contact
 * details (the shape the funnel's personal_information question produces).
 */
export function parsePersonalInformation(raw: string): ParsedContact & ParsedName {
  const contact = parseContact(raw);
  const withoutContact = raw.replace(EMAIL_RE, "").replace(PHONE_RE, "");
  return { ...contact, ...parseFullName(withoutContact) };
}
