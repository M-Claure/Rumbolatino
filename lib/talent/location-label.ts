import { stripDiacritics } from "./text";

/**
 * Whether a profile's metro area is worth printing next to its city.
 *
 * PURE: no I/O, no `server-only`. Imports this folder's accent folding and
 * nothing else.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * A profile header showed both, unconditionally, and for most people that reads
 * as the location written twice:
 *
 *     📍 Miami, FL, Estados Unidos   🧭 Miami-Fort Lauderdale-West Palm Beach, FL
 *
 * The metro is not redundant in general — it is the whole point of the metro
 * filter, and for somebody in Katy it is the fact an employer wants ("why is
 * this person in my Houston results?"). It is redundant exactly when the city
 * they live in is already the name the metro goes by:
 *
 *     📍 Katy, TX   🧭 Área de Houston-Pasadena-The Woodlands, TX   ← earns its place
 *     📍 Miami, FL  (metro hidden)                                  ← says nothing new
 *
 * ── Compared against the metro's LEAD city, not the whole title ────────────
 * A CBSA title names its secondary cities too, so testing the whole string
 * would hide the metro for anyone living in one of them — and those are the
 * people the metro is most informative for. Someone in The Woodlands should
 * still be told they are in the Houston metro, even though "The Woodlands" is
 * in that title. So only the first city counts.
 *
 * Containment in both directions, rather than equality, because a lead city can
 * itself be compound: `Winston-Salem, NC` splits to a lead of `Winston`, and
 * `Urban Honolulu, HI` has no hyphen at all but contains `Honolulu`. Both are
 * the same place as the city beside them and both should hide.
 */

/**
 * The first city in a CBSA title. `Houston-Pasadena-The Woodlands, TX` →
 * `houston`, accent-folded and lower-cased.
 *
 * The state suffix goes first: it is after the LAST comma, since a handful of
 * titles carry more than one state (`Chicago-Naperville-Elgin, IL-IN`), and the
 * hyphen split has to happen on the city half alone or `IL-IN` would join in.
 */
function leadCity(cbsaTitle: string): string {
  const lastComma = cbsaTitle.lastIndexOf(",");
  const cities = lastComma === -1 ? cbsaTitle : cbsaTitle.slice(0, lastComma);
  return fold(cities.split("-")[0] ?? "");
}

function fold(text: string): string {
  return stripDiacritics(text).toLocaleLowerCase("es").trim();
}

/**
 * True when the metro should be shown beside `city`.
 *
 * With no metro there is nothing to show. With no CITY the metro is the only
 * place we have, so it is always worth showing — that is a listing whose ZIP
 * resolved but whose city text is missing, and "somewhere in the Miami area"
 * beats no location at all.
 */
export function metroAddsPlace(
  city: string | null | undefined,
  cbsaTitle: string | null | undefined,
): boolean {
  const metro = (cbsaTitle ?? "").trim();
  if (!metro) return false;

  const own = fold(city ?? "");
  if (!own) return true;

  const lead = leadCity(metro);
  if (!lead) return true;

  return !(own === lead || own.includes(lead) || lead.includes(own));
}
