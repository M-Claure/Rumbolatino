/**
 * Accent handling, shared by the classifier, the slug builder and name search.
 *
 * Spanish text arrives however the person typed it — `diseño` from one keyboard,
 * `diseno` from another, `DISEÑO` from a phone that capitalizes. Matching and
 * slugging both have to see through that, and they have to do it the SAME way:
 * if the classifier folded accents and the slug builder did not, two profiles
 * that read identically would sort and match differently.
 *
 * The combining range is written as explicit `\u` escapes on purpose. Spelled as
 * literal combining marks it is invisible in most editors, survives a copy-paste
 * only by luck, and silently degrades to matching nothing if the file is ever
 * normalized — a bug with no error message and no failing test.
 *
 * Pure: no imports, safe on the client and the server alike.
 */

/** Decompose, drop the combining marks, recompose. `café` → `cafe`. */
export function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Tokenize what an employer typed into a NAME query.
 *
 * The TypeScript mirror of `mcv_talent_name_query` in
 * `supabase/migrations/0012_talent_name_search.sql`, used by
 * `MemoryTalentStore`. The two must agree, so the rules are the same three:
 *
 *  1. fold accents and case — `Gonzálvez` and `gonzalvez` are one name;
 *  2. treat every non-alphanumeric run as a separator, so `García-López`,
 *     `O'Brien` and a stray comma all tokenize the way a person expects;
 *  3. DROP tokens shorter than two characters rather than prefix-matching them.
 *     A single letter prefixes a large share of any name column, and a query
 *     that matches most of the directory is a way to page it out.
 *
 * Returns the tokens; matching them as PREFIXES is the caller's job (in SQL it
 * is `:*`), because only the caller knows what it is matching against.
 */
export function nameSearchTokens(query: string): string[] {
  return stripDiacritics(query.toLocaleLowerCase("es"))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 2);
}
