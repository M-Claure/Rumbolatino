/**
 * Accent handling, shared by the classifier and the slug builder.
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
