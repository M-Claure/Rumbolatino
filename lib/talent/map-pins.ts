import type { TalentProfilePublic } from "@/types";

/**
 * Search results → map pins.
 *
 * PURE: no I/O, no Leaflet, no DOM. It lives here rather than inside
 * `TalentMap.tsx` so the rule that matters can be unit-tested without a browser
 * — the rule being that people who share a coordinate share a pin.
 *
 * ── Why grouping is the point, not a nicety ─────────────────────────────────
 * A published coordinate is the centroid of a ZIP AREA. Everyone in one ZIP has
 * the *same* coordinate, to the fourth decimal place, because it is a property
 * of the postal area and not of the person. So a map cannot show them as
 * separate points however it tries: they are one point. Grouping makes the map
 * say what is true — this postal area holds four people — instead of stacking
 * four identical markers and hiding three of them under the top one.
 *
 * That also happens to be the privacy-preserving shape. A pin labelled "4"
 * cannot be read as anybody's house, and nothing about the rendering invites
 * the reader to try.
 */

export interface TalentPinPerson {
  slug: string;
  displayName: string;
  headline: string;
}

export interface TalentPin {
  /** The shared ZIP-area centroid. */
  latitude: number;
  longitude: number;
  /** "Houston, TX" when everyone at this pin agrees on it; empty when they do not. */
  place: string;
  /** In the order the search returned them — nearest first on a radius search. */
  people: TalentPinPerson[];
}

/**
 * Four decimal places, matching how `us-zips.json` stores centroids.
 *
 * Keying on the raw floats would work for two rows read from the same column,
 * and would silently stop working the moment a coordinate arrived from anywhere
 * else — a re-derived centroid, a different rounding, a JSON round trip. Rounding
 * to the precision the data actually has makes the grouping a property of the
 * ZIP rather than of the float.
 */
function key(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

export function groupByLocation(profiles: readonly TalentProfilePublic[]): TalentPin[] {
  const pins = new Map<string, TalentPin>();

  for (const profile of profiles) {
    const { latitude, longitude } = profile;
    // No coordinates — a rural or non-US ZIP. Left OFF the map rather than
    // placed at a plausible-looking point; the table below it still lists them,
    // and `TalentMap` says so when nobody can be placed at all.
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const id = key(latitude, longitude);
    const person: TalentPinPerson = {
      slug: profile.slug,
      displayName: profile.displayName,
      headline: profile.headline,
    };

    const existing = pins.get(id);
    if (existing) {
      existing.people.push(person);
      // Two people can share a centroid and still carry different city text —
      // a ZIP that straddles two municipalities, or one person's free-text
      // location. Blanking it is honest; picking the first would label the pin
      // with a place the others did not claim.
      if (existing.place !== placeOf(profile)) existing.place = "";
    } else {
      pins.set(id, {
        latitude,
        longitude,
        place: placeOf(profile),
        people: [person],
      });
    }
  }

  return [...pins.values()];
}

function placeOf(profile: TalentProfilePublic): string {
  return [profile.city, profile.state].filter(Boolean).join(", ");
}
