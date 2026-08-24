import "server-only";
import { lookupZip, normalizeZip, type ZipLocation } from "./zip-lookup";

/**
 * What the location question's answer means.
 *
 * `personal_location` asks for a ZIP, but the answer arrives as free text from a
 * person, so it has to cope with three real cases:
 *
 *   1. A valid US ZIP — the intended answer. We fill the city, the state and the
 *      coordinates from it, so the résumé still prints "Houston, TX" and the
 *      profile can be found by proximity.
 *   2. Five digits that are not a real ZIP (a typo, or a Mexican código postal).
 *      We keep what they typed as free text rather than discarding it, and the
 *      profile simply never matches a radius search.
 *   3. A place name — "Houston", "Guadalajara". Someone outside the US, or
 *      someone who ignored the question. Kept verbatim in `city`.
 *
 * Deliberately DETERMINISTIC: no model call. A ZIP is a lookup, not an
 * interpretation, and asking a language model to geocode is both slower and a
 * way to invent a city that does not exist. This is the same split the funnel
 * already makes — the model handles narrative, code handles facts.
 */

export interface ResolvedLocation {
  postalCode: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  /** True when the answer resolved to a real ZIP we can place on a map. */
  matched: boolean;
}

/** Nothing usable in the answer — every field cleared rather than half-set. */
const UNRESOLVED: ResolvedLocation = {
  postalCode: null,
  city: null,
  state: null,
  country: null,
  latitude: null,
  longitude: null,
  matched: false,
};

export function resolveLocationAnswer(rawAnswer: string | null | undefined): ResolvedLocation {
  const raw = (rawAnswer ?? "").trim();
  if (!raw) return UNRESOLVED;

  const zip = lookupZip(raw);
  if (zip) return fromZip(zip);

  // Not a ZIP we know. Keep the person's own words — the funnel's rule
  // everywhere else — and leave the map fields null so nothing is invented.
  return {
    ...UNRESOLVED,
    // A five-digit non-ZIP is still a postal code somewhere, so record it as
    // one; anything else is a place name.
    postalCode: normalizeZip(raw),
    city: normalizeZip(raw) ? null : raw.slice(0, 120),
  };
}

/** A confirmed ZIP → the fields we store. Shared with the geolocation path. */
export function fromZip(zip: ZipLocation): ResolvedLocation {
  return {
    postalCode: zip.postalCode,
    city: zip.city,
    state: zip.state,
    // Hard-coded, and correct: the table is US-only, territories included.
    country: "Estados Unidos",
    latitude: zip.latitude,
    longitude: zip.longitude,
    matched: true,
  };
}
