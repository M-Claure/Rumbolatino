import "server-only";
import rawZips from "./us-zips.json";

/**
 * US ZIP code → place and coordinates.
 *
 * ── Why a bundled table and not a geocoding API ─────────────────────────────
 * Every alternative costs something this one does not: an API key to manage, a
 * per-request charge, a rate limit that bites exactly when the product is busy,
 * a third party that can be down while Supabase and Azure are fine, and one more
 * service seeing where our users live. A 1.8 MB table answers in microseconds,
 * has no failure mode, and never leaves the server.
 *
 * ── Source and licence ──────────────────────────────────────────────────────
 * `us-zips.json` is generated from the GeoNames postal-code export
 * (https://download.geonames.org/export/zip/), which is licensed **CC BY 4.0** —
 * attribution is required, and lives in `docs/attributions.md`. It merges US.txt
 * with the territory files (PR, VI, GU, AS, MP); those put a numeric
 * municipality code where the 50 states carry a 2-letter abbreviation, so the
 * territory files are keyed on the country code instead, which is the correct US
 * postal form ("San Juan, PR").
 *
 * Coordinates are the ZIP's centroid at 4 decimal places (~11 m). That precision
 * is far finer than the data means: a ZIP is an area, sometimes a large rural
 * one, so "distance" here is between the CENTRES of two ZIPs and can be several
 * miles off for any individual. Fine for "who is near me"; never present it as an
 * exact distance to a person.
 *
 * `server-only`: the table must never be shipped to a browser, both for bundle
 * size and because the client has no reason to hold a national address index.
 */

/** `[city, stateCode, latitude, longitude]` — the shape stored in the JSON. */
type ZipRow = [string, string, number, number];

const ZIPS = rawZips as unknown as Record<string, ZipRow>;

export interface ZipLocation {
  postalCode: string;
  city: string;
  /** Two-letter state or territory code, e.g. `TX`, `PR`. */
  state: string;
  latitude: number;
  longitude: number;
}

/** Five digits, nothing else. `77002-1234` is trimmed to its first five. */
export function normalizeZip(input: string | null | undefined): string | null {
  const digits = (input ?? "").trim().replace(/\D/g, "");
  // ZIP+4 is common on forms; the extra four narrow to a delivery route and are
  // irrelevant here, so take the leading five rather than rejecting the value.
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

/** Resolve a ZIP. Null when it is malformed or not a real US postal code. */
export function lookupZip(input: string | null | undefined): ZipLocation | null {
  const postalCode = normalizeZip(input);
  if (!postalCode) return null;
  const row = ZIPS[postalCode];
  if (!row) return null;
  return { postalCode, city: row[0], state: row[1], latitude: row[2], longitude: row[3] };
}

/** True when this is a ZIP we can place on a map. */
export function isKnownZip(input: string | null | undefined): boolean {
  return lookupZip(input) !== null;
}

const EARTH_RADIUS_MILES = 3958.7613;
const toRadians = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in miles.
 *
 * Haversine rather than a flat-earth approximation: the continental US spans
 * ~25° of latitude, and treating a degree of longitude as constant makes a
 * "50 mile" radius noticeably wrong in Miami versus Seattle.
 */
export function distanceMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * The ZIP whose centroid is nearest a coordinate — how a device's "use my
 * location" becomes a postal code.
 *
 * A linear scan of ~41k rows, which measures in single-digit milliseconds and
 * needs no spatial index for a lookup that happens once per person. `maxMiles`
 * exists so a browser reporting a location in the middle of the Pacific (or in
 * another country) yields nothing rather than confidently snapping to the
 * closest American ZIP hundreds of miles away.
 */
export function nearestZip(
  latitude: number,
  longitude: number,
  maxMiles = 60,
): ZipLocation | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  let best: ZipLocation | null = null;
  let bestDistance = Infinity;
  const origin = { latitude, longitude };

  for (const [postalCode, row] of Object.entries(ZIPS)) {
    const candidate = { latitude: row[2], longitude: row[3] };
    const d = distanceMiles(origin, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = { postalCode, city: row[0], state: row[1], ...candidate };
    }
  }

  return bestDistance <= maxMiles ? best : null;
}

/** How many ZIPs the table holds. Used by the tests to catch a truncated file. */
export function zipCount(): number {
  return Object.keys(ZIPS).length;
}
