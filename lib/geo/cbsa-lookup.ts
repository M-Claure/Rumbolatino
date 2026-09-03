import "server-only";
import rawCbsa from "./us-cbsa.json";
import { stripDiacritics } from "@/lib/talent/text";
import type { MetroArea, MetroMatch } from "@/types";

/**
 * US ZIP code → metro area (CBSA), and metro area → name.
 *
 * A CBSA — Core-Based Statistical Area — is OMB's definition of "one labour
 * market": a county with an urban core, plus every surrounding county that
 * commutes into it. That is the unit an employer actually thinks in. "Houston"
 * as a city name is a boundary that stops before Katy, Pasadena and Sugar Land;
 * `Houston-Pasadena-The Woodlands, TX` is the nine counties people commute
 * across, and it is a definition somebody else maintains rather than one we
 * invent.
 *
 * ── Why this sits beside `zip-lookup.ts` instead of in Postgres ─────────────
 * Same argument, one file further: no API key, no per-request cost, no rate
 * limit that bites when the product is busy, no third party learning where our
 * users live. `us-cbsa.json` is 405 KB and `server-only`, so it never reaches a
 * browser. See `scripts/build-cbsa-table.ts` for how it is generated, from which
 * Census and OMB files, and what the join gives up.
 *
 * ── The metro is RESOLVED ONCE, at publish time ─────────────────────────────
 * Nothing on the search path calls this. `talent-publish.ts` reads the metro out
 * of here when a listing is written and denormalizes the code and the title onto
 * `talent_profiles`, so a metro search is an indexed equality test and never a
 * join against 30,000 ZIPs. The consequence is that a listing carries the
 * delineation vintage it was published under until it is re-published — which is
 * what `npm run geo:cbsa -- --backfill` exists to fix.
 *
 * ── Coverage, stated plainly ────────────────────────────────────────────────
 * About 26% of US ZIPs belong to no CBSA at all. That is not a gap in the data;
 * it is rural America, which OMB deliberately leaves outside every metro and
 * micro area. Those people are simply absent from a metro search — never
 * silently placed in the nearest one — and the ZIP + radius filter is how an
 * employer reaches them. Anyone outside the US has no ZIP, so no metro either.
 */

interface CbsaTable {
  vintage: string;
  /** `[code, title, type, latitude, longitude]`, sorted by title. */
  cbsas: Array<[string, string, "M1" | "M2", number, number]>;
  /** ZIP → index into `cbsas`. A ZIP in no metro is absent, not null. */
  zips: Record<string, number>;
}

const TABLE = rawCbsa as unknown as CbsaTable;

/** How many suggestions the autocomplete offers before it stops. */
export const METRO_SUGGESTION_LIMIT = 8;

function toMetro(index: number): MetroArea | null {
  const row = TABLE.cbsas[index];
  if (!row) return null;
  return {
    code: row[0],
    title: row[1],
    kind: row[2] === "M1" ? "metropolitan" : "micropolitan",
    latitude: row[3],
    longitude: row[4],
  };
}

const BY_CODE = new Map<string, number>(TABLE.cbsas.map((row, index) => [row[0], index]));

/**
 * Fold a metro title or an employer's query into comparable tokens.
 *
 * Deliberately NOT `nameSearchTokens`, which looks identical and is not: that
 * function is documented as the TypeScript mirror of `mcv_talent_name_query`,
 * and the two are required to agree because one runs in `MemoryTalentStore` and
 * the other in Postgres. Metro matching happens only here, in memory, and it is
 * free to diverge — so borrowing that function would quietly make a promise
 * about Postgres that this code has no way to keep. The accent folding itself IS
 * shared (`stripDiacritics`), because there is exactly one right way to do it.
 *
 * The two-character floor is here for the same reason it is there: a single
 * letter prefixes a large share of the column, so `a` would "match" most metros
 * in the country, which is not a search result.
 */
function metroTokens(text: string): string[] {
  return stripDiacritics(text.toLocaleLowerCase("es"))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 2);
}

/** The whole query as one folded string, for the "is this an exact title?" test. */
function fold(text: string): string {
  return metroTokens(text).join(" ");
}

/**
 * Every title's tokens, computed once at module load.
 *
 * `searchMetros` is a linear scan and the autocomplete calls it per keystroke,
 * so the alternative is re-running `normalize("NFD")` plus a Unicode regex over
 * 928 titles on every request to tell an employer that "hous" means Houston.
 * The table is immutable and 928 rows, so this is a few hundred kilobytes held
 * for the process — the same trade `BY_CODE` above makes.
 */
const TITLE_TOKENS: string[][] = TABLE.cbsas.map((row) => metroTokens(row[1]));

/** The metro a ZIP belongs to. Null for a rural ZIP, a bad ZIP, or a non-US one. */
export function lookupCbsaForZip(zip: string | null | undefined): MetroArea | null {
  const digits = (zip ?? "").trim().replace(/\D/g, "");
  if (digits.length < 5) return null;
  const index = TABLE.zips[digits.slice(0, 5)];
  return index === undefined ? null : toMetro(index);
}

/** One metro by its CBSA code. Null when the code is unknown to this vintage. */
export function getMetro(code: string | null | undefined): MetroArea | null {
  const index = BY_CODE.get((code ?? "").trim());
  return index === undefined ? null : toMetro(index);
}

/**
 * Metros whose title matches what the employer is typing.
 *
 * Every query token must PREFIX some token of the title, ANDed — so `hous tx`
 * finds Houston and `woodlands` finds it too, because a CBSA title names its
 * secondary cities and those are what a lot of people call home. Ordering puts
 * a title the query begins to spell first, then metropolitan areas ahead of
 * micropolitan ones (a micro area shares a name with a metro often enough that
 * showing the small one first would look like a bug), then alphabetically.
 *
 * ── This searches REFERENCE DATA, never the directory ───────────────────────
 * The suggestion list is the same 928 metros for every employer, whether or not
 * anybody is published there. Filtering it to metros that HAVE candidates would
 * be a nicer autocomplete and a disclosure: it would let anyone with an account
 * map, one keystroke at a time, which parts of the country have people listed —
 * a fact about our users, offered outside the rate limit that governs searching
 * for them. So the list is static and the count comes from the search itself.
 */
export function searchMetros(query: string, limit = METRO_SUGGESTION_LIMIT): MetroArea[] {
  const tokens = metroTokens(query);
  if (tokens.length === 0) return [];

  const matches: Array<{ metro: MetroArea; rank: number }> = [];
  for (let index = 0; index < TABLE.cbsas.length; index++) {
    const row = TABLE.cbsas[index]!;
    const titleTokens = TITLE_TOKENS[index]!;
    const everyTokenMatches = tokens.every((token) =>
      titleTokens.some((titleToken) => titleToken.startsWith(token)),
    );
    if (!everyTokenMatches) continue;

    const startsTitle = titleTokens[0]?.startsWith(tokens[0]!) ?? false;
    matches.push({
      metro: toMetro(index)!,
      // Lower sorts first. The table is already alphabetical, so a stable sort
      // on this rank alone gives alphabetical order within each tier.
      rank: (startsTitle ? 0 : 2) + (row[2] === "M1" ? 0 : 1),
    });
  }

  return matches
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((m) => m.metro);
}

/**
 * Turn the `metro=` parameter into something the search can filter on.
 *
 * ── Why this takes free text and not only a code ────────────────────────────
 * `TalentFilters` fills a hidden CBSA code when its combobox is used, and the
 * combobox needs JavaScript. The rest of that form is a plain GET on purpose —
 * it works with no JS, in a screen reader, on a slow connection — and one
 * control that silently does nothing without hydration would be a hole in that.
 * So the parameter also accepts what a person would type, and the resolution is
 * against a CLOSED list of 928 titles: this is not free-text search over
 * anything, it is picking a row from a fixed table.
 *
 * Three outcomes because they need three different answers on the page:
 *
 *   - `exact`     — filter by it, and name the metro that was used, since
 *                   "Houston" is not what the results are actually filtered by.
 *   - `ambiguous` — do NOT filter, and offer the candidates as links. Guessing
 *                   between "Portland, OR" and "Portland, ME" would answer a
 *                   question the employer did not ask, and they would read the
 *                   result as though it had.
 *   - `unknown`   — do not filter, and say the words were not recognised. Same
 *                   shape as the unrecognised-ZIP message: an empty table would
 *                   read as "nobody works there".
 */
export function resolveMetroQuery(input: string | null | undefined): MetroMatch {
  const raw = (input ?? "").trim();
  if (!raw) return { status: "absent" };

  // A CBSA code — what the combobox submits, and what a shared URL carries.
  const byCode = getMetro(raw);
  if (byCode) return { status: "exact", metro: byCode };

  const folded = fold(raw);
  if (!folded) return { status: "unknown", typed: raw };

  const found = searchMetros(raw, METRO_SUGGESTION_LIMIT);
  if (found.length === 0) return { status: "unknown", typed: raw };

  // A title typed or pasted in full wins outright, even when it prefixes others.
  const exactTitle = found.find((metro) => fold(metro.title) === folded);
  if (exactTitle) return { status: "exact", metro: exactTitle };

  if (found.length === 1) return { status: "exact", metro: found[0]! };
  return { status: "ambiguous", typed: raw, options: found };
}

/** Table sanity, for the tests: a truncated file is otherwise invisible. */
export function cbsaTableStats(): { vintage: string; metros: number; zips: number } {
  return {
    vintage: TABLE.vintage,
    metros: TABLE.cbsas.length,
    zips: Object.keys(TABLE.zips).length,
  };
}
