/**
 * Month/year handling for experience dates.
 *
 * Dates in this product are stored as FREE TEXT, because the funnel asks for "una
 * fecha aproximada" and keeps whatever the person said ("marzo 2020", "2019", "de
 * junio 2021 a la actualidad"). The Review screen offers month + year dropdowns
 * instead — easier than typing a format, and it produces exactly the shape
 * `lib/resume/experience-order.ts` parses, so a date picked here always orders
 * correctly on the résumé.
 *
 * This module owns the canonical Spanish month names; the ordering parser builds
 * its lookup from the same list, so the two can never drift apart. Pure (no
 * imports, no I/O) so the browser and the server share it.
 */

/** Canonical Spanish month names, January first. Index 0 is enero (month 1). */
export const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** Dropdown options: value is the month number as a string, label is capitalized. */
export const MONTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = MONTHS_ES.map(
  (name, i) => ({
    value: String(i + 1),
    label: name.charAt(0).toLocaleUpperCase("es") + name.slice(1),
  }),
);

/** How far back the year dropdown reaches. A working life, not a calendar. */
const YEARS_BACK = 60;

/**
 * Year options, newest first — most experiences are recent, so the useful values
 * are at the top of the list rather than 60 scrolls down. Takes the current year
 * as an argument so the module stays pure and testable.
 */
export function yearOptions(currentYear: number): string[] {
  return Array.from({ length: YEARS_BACK + 1 }, (_, i) => String(currentYear - i));
}

/**
 * Builds the stored string from the two dropdowns: "marzo 2020", or just "2019"
 * when the person remembers the year but not the month. A month with no year is
 * not a date anyone can order by, so it yields "".
 */
export function formatExperienceDate(month: string, year: string): string {
  const y = year.trim();
  if (!y) return "";
  const monthIndex = Number(month) - 1;
  const name = MONTHS_ES[monthIndex];
  return name ? `${name} ${y}` : y;
}

/**
 * Reads a stored free-text date back into the two dropdowns, so opening Review
 * shows what was captured instead of blank selects.
 *
 * Deliberately forgiving about what it accepts, because the value may have been
 * typed by a person in the funnel rather than picked here: it takes the FIRST
 * month name and the FIRST 4-digit year it finds, in any order, and ignores the
 * rest ("de marzo 2020 a la actualidad" → marzo / 2020). Anything it cannot read
 * comes back empty, which leaves the field blank rather than guessing.
 */
export function parseExperienceDate(text: string | null | undefined): {
  month: string;
  year: string;
} {
  if (!text) return { month: "", year: "" };
  const lower = text.toLocaleLowerCase("es");
  const monthIndex = MONTHS_ES.findIndex((name) => lower.includes(name));
  const year = /\b(19\d{2}|20\d{2}|21\d{2})\b/.exec(lower)?.[1] ?? "";
  return { month: monthIndex >= 0 ? String(monthIndex + 1) : "", year };
}

/** Wording the renderer and the funnel both use for an ongoing experience. */
export const CURRENT_DATE_LABEL = "Actualidad";

/**
 * The same wording for a résumé rendered in another language.
 *
 * Only the renderer needs this — the funnel is Spanish-only, so `CURRENT_DATE_LABEL`
 * stays the plain constant every other caller already imports.
 */
export function currentDateLabel(lang: "es" | "en" = "es"): string {
  return lang === "en" ? "Present" : CURRENT_DATE_LABEL;
}

/**
 * "Still going on", in the words the funnel actually receives.
 *
 * Lives here rather than in `lib/resume/experience-order.ts` (which imports it)
 * because it is part of reading a date, and the ordering parser is not the only
 * thing that needs to know an answer said "a la actualidad" — so does the range
 * split below, and through it the Review screen's "Sigo en esta experiencia".
 */
export const PRESENT_MARKER =
  /\b(actualidad|actualmente|actual|presente|hoy|ahora|vigente|en\s+curso|sigo|todav[ií]a)\b/i;

/** One month/year pair found in a free-text date, with where it was found. */
interface DateToken {
  readonly index: number;
  readonly month: string;
  readonly year: string;
}

/**
 * Every month/year pair in a free-text date, in the order they appear.
 *
 * A bare year counts as a token with no month, but only when no month was read
 * for it — otherwise "marzo 2020" would yield both "marzo 2020" and "2020" and a
 * one-date answer would look like a range.
 */
function dateTokens(text: string): DateToken[] {
  const lower = text.toLocaleLowerCase("es");
  const months = MONTHS_ES as readonly string[];
  const tokens: DateToken[] = [];
  /** Positions of years a month was already read for. */
  const paired = new Set<number>();

  // "marzo 2020", "junio de 2018"
  for (const m of lower.matchAll(/([a-záéíóúñ]+)\.?\s+(?:de\s+)?(19\d{2}|20\d{2}|21\d{2})\b/g)) {
    const month = months.indexOf(m[1]!) + 1;
    if (month === 0) continue;
    paired.add(m.index + m[0].lastIndexOf(m[2]!));
    tokens.push({ index: m.index, month: String(month), year: m[2]! });
  }
  for (const m of lower.matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/g)) {
    if (paired.has(m.index)) continue;
    tokens.push({ index: m.index, month: "", year: m[1]! });
  }

  return tokens.sort((a, b) => a.index - b.index);
}

export interface ExperienceDateRange {
  start: { month: string; year: string };
  /** Empty when the experience is ongoing — "actualidad" IS the end. */
  end: { month: string; year: string };
  isCurrent: boolean;
}

const NO_DATE = { month: "", year: "" } as const;
const EMPTY_RANGE: ExperienceDateRange = { start: NO_DATE, end: NO_DATE, isCurrent: false };

/**
 * Splits ONE free-text answer into the two ends of a range.
 *
 * The funnel asks for both at once — "¿de cuándo a cuándo?", example answer "de
 * marzo 2020 a la actualidad" — so a single answer routinely carries the start,
 * the end, and "still there". Reading only the first date out of it (which is all
 * `parseExperienceDate` does) threw the second half away.
 *
 * First token is the start, LAST is the end; one token means only a start is
 * known. Anything unparseable comes back empty rather than guessed at, and the
 * caller keeps whatever it already had.
 */
export function parseExperienceDateRange(text: string | null | undefined): ExperienceDateRange {
  if (!text) return EMPTY_RANGE;
  const isCurrent = PRESENT_MARKER.test(text);
  const tokens = dateTokens(text);
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
  return {
    start: first ? { month: first.month, year: first.year } : NO_DATE,
    end: isCurrent || !last ? NO_DATE : { month: last.month, year: last.year },
    isCurrent,
  };
}

/**
 * The start/end/ongoing a STORED entry really has — the one reader for the Review
 * card's dropdowns and for the required-field rule that decides whether the person
 * may continue.
 *
 * Why it is not just two `parseExperienceDate` calls: the funnel writes its whole
 * date answer to `startDate` and leaves `endDate` null (see the mock provider's
 * `experience_dates`), so reading the fields independently reported "no end date"
 * for every experience the funnel ever captured — while the answer sitting in
 * `startDate` said "a la actualidad". Both callers now agree, and saving the card
 * writes the split values back, so an entry is only ever read this way once.
 *
 * A stored `endDate`, or an explicit "Sigo en esta experiencia", always wins: those
 * were chosen field by field on the Review screen and must not be second-guessed by
 * re-reading prose.
 */
export function effectiveExperienceDates(e: {
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
}): ExperienceDateRange {
  const range = parseExperienceDateRange(e.startDate);
  if (e.isCurrent) return { start: range.start, end: NO_DATE, isCurrent: true };
  const storedEnd = parseExperienceDate(e.endDate);
  if (storedEnd.year) return { start: range.start, end: storedEnd, isCurrent: false };
  return range;
}
