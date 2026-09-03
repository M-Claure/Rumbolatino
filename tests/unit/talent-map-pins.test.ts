import { describe, expect, it } from "vitest";
import type { TalentProfilePublic } from "@/types";
import { groupByLocation } from "@/lib/talent/map-pins";

/**
 * One pin per ZIP AREA, not per person.
 *
 * The grouping is the map's whole design and the reason it is safe to publish a
 * coordinate at all, so it is tested here rather than left inside a Leaflet
 * effect no unit test can reach.
 */

function profile(o: Partial<TalentProfilePublic> = {}): TalentProfilePublic {
  return {
    slug: "maria-g-aaa111",
    displayName: "María Gutiérrez",
    headline: "Cosmetóloga",
    summary: "",
    category: "belleza",
    skills: [],
    certifications: [],
    education: [],
    experience: [],
    languages: [],
    yearsBucket: "3_5",
    availability: "flexible",
    city: "Houston",
    state: "TX",
    country: "Estados Unidos",
    cbsaCode: "26420",
    cbsaTitle: "Houston-Pasadena-The Woodlands, TX",
    latitude: 29.7594,
    longitude: -95.3594,
    publishedAt: "2026-08-24T00:00:00.000Z",
    ...o,
  };
}

describe("groupByLocation", () => {
  it("puts everyone who shares a ZIP centroid on ONE pin", () => {
    // They do not merely look close — a ZIP centroid is a property of the postal
    // area, so three people in 77002 have the identical coordinate. Three
    // markers would be one marker with two hidden underneath it.
    const pins = groupByLocation([
      profile({ slug: "a-1", displayName: "Ana" }),
      profile({ slug: "b-2", displayName: "Beto" }),
      profile({ slug: "c-3", displayName: "Carla" }),
    ]);

    expect(pins).toHaveLength(1);
    expect(pins[0]?.people.map((p) => p.displayName)).toEqual(["Ana", "Beto", "Carla"]);
    expect(pins[0]?.place).toBe("Houston, TX");
  });

  it("keeps different ZIP areas apart", () => {
    const pins = groupByLocation([
      profile({ slug: "a-1" }),
      profile({ slug: "b-2", latitude: 29.7445, longitude: -95.83, city: "Katy" }),
    ]);
    expect(pins).toHaveLength(2);
  });

  it("groups on four decimals, the precision the data actually has", () => {
    // Keying on the raw float works for two rows read from the same column and
    // stops working the moment a coordinate is re-derived or round-tripped
    // through JSON. Rounding makes the grouping a property of the ZIP.
    const pins = groupByLocation([
      profile({ slug: "a-1", latitude: 29.7594, longitude: -95.3594 }),
      profile({ slug: "b-2", latitude: 29.75941, longitude: -95.35939 }),
    ]);
    expect(pins).toHaveLength(1);
  });

  it("leaves a pin unlabelled when the people on it disagree about the place", () => {
    // A ZIP can straddle two municipalities, and one person's `city` may be
    // free text they typed. Blanking the label is honest; taking the first
    // would put a place name on a pin the others never claimed.
    const pins = groupByLocation([
      profile({ slug: "a-1", city: "Houston" }),
      profile({ slug: "b-2", city: "Bellaire" }),
    ]);
    expect(pins).toHaveLength(1);
    expect(pins[0]?.place).toBe("");
  });

  it("drops anyone with no coordinates instead of placing them somewhere", () => {
    // A rural ZIP outside every CBSA, or no US ZIP at all. A marker is read as a
    // fact about where somebody is, so there must be no fallback position —
    // they stay in the table below the map, and `TalentMap` says so when nobody
    // can be placed.
    const pins = groupByLocation([
      profile({ slug: "a-1" }),
      profile({ slug: "b-2", latitude: null, longitude: null, city: "Guadalajara" }),
    ]);
    expect(pins).toHaveLength(1);
    expect(pins[0]?.people.map((p) => p.slug)).toEqual(["a-1"]);
  });

  it("returns nothing at all when nobody can be placed", () => {
    expect(groupByLocation([profile({ latitude: null, longitude: null })])).toEqual([]);
    expect(groupByLocation([])).toEqual([]);
  });

  it("carries only what a pin displays", () => {
    // The pins cross from the server into the client, and a
    // `TalentProfilePublic` carries a summary and four experience blocks with
    // their bullets. Sending those would duplicate the whole result set into the
    // RSC payload beside the table that already rendered it.
    const [pin] = groupByLocation([profile({ summary: "un resumen largo" })]);
    expect(pin?.people[0]).toEqual({
      slug: "maria-g-aaa111",
      displayName: "María Gutiérrez",
      headline: "Cosmetóloga",
    });
  });

  it("preserves the search's own order within a pin", () => {
    // Nearest-first on a radius search, most-recent-first otherwise. The popup
    // lists people in the order the employer's search ranked them.
    const pins = groupByLocation([
      profile({ slug: "z-1", displayName: "Zoe" }),
      profile({ slug: "a-2", displayName: "Ana" }),
    ]);
    expect(pins[0]?.people.map((p) => p.displayName)).toEqual(["Zoe", "Ana"]);
  });
});
