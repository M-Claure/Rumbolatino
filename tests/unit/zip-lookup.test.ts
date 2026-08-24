import { describe, expect, it } from "vitest";
import {
  distanceMiles,
  isKnownZip,
  lookupZip,
  nearestZip,
  normalizeZip,
  zipCount,
} from "@/lib/geo/zip-lookup";
import { resolveLocationAnswer } from "@/lib/geo/location-answer";

describe("the bundled table", () => {
  it("holds the whole country, not a truncated file", () => {
    // A partial write or a bad regeneration is otherwise invisible: lookups for
    // whatever survived keep working and everyone else silently vanishes.
    expect(zipCount()).toBeGreaterThan(40_000);
  });

  it("includes Puerto Rico, which GeoNames ships in a separate file", () => {
    // Easy to miss and squarely in this product's audience.
    expect(lookupZip("00901")).toMatchObject({ city: "San Juan", state: "PR" });
  });
});

describe("normalizeZip", () => {
  it("takes the leading five digits of a ZIP+4", () => {
    expect(normalizeZip("77002-1234")).toBe("77002");
    expect(normalizeZip(" 77002 ")).toBe("77002");
  });

  it("keeps a leading zero", () => {
    // The reason the input is text and not a number anywhere in this feature.
    expect(normalizeZip("07030")).toBe("07030");
  });

  it("rejects anything shorter than five digits", () => {
    expect(normalizeZip("770")).toBeNull();
    expect(normalizeZip("")).toBeNull();
    expect(normalizeZip(null)).toBeNull();
  });
});

describe("lookupZip", () => {
  it("resolves a real ZIP to its place and centroid", () => {
    expect(lookupZip("77002")).toMatchObject({ city: "Houston", state: "TX" });
    expect(lookupZip("10001")).toMatchObject({ city: "New York", state: "NY" });
  });

  it("returns null for five digits that are not a US ZIP", () => {
    // A Mexican código postal is also five digits, so this cannot be assumed.
    expect(lookupZip("00000")).toBeNull();
    expect(isKnownZip("99999")).toBe(false);
  });
});

describe("distanceMiles", () => {
  it("measures real distances", () => {
    const houston = { latitude: 29.7594, longitude: -95.3594 };
    const dallas = { latitude: 32.7876, longitude: -96.7995 };
    expect(Math.round(distanceMiles(houston, dallas))).toBeGreaterThan(210);
    expect(Math.round(distanceMiles(houston, dallas))).toBeLessThan(230);
    expect(distanceMiles(houston, houston)).toBeCloseTo(0);
  });
});

describe("nearestZip", () => {
  it("snaps a device location to the ZIP it is in", () => {
    expect(nearestZip(29.7594, -95.3594)?.state).toBe("TX");
  });

  it("returns null rather than guessing for a location far outside the US", () => {
    // A browser reporting mid-Atlantic, or a user in another country, must not
    // be told they live in the nearest American ZIP hundreds of miles away.
    expect(nearestZip(0, 0)).toBeNull();
    expect(nearestZip(19.4326, -99.1332)).toBeNull(); // Mexico City
  });

  it("ignores nonsense coordinates", () => {
    expect(nearestZip(NaN, NaN)).toBeNull();
  });
});

describe("resolveLocationAnswer", () => {
  it("fills city, state and coordinates from a valid ZIP", () => {
    const r = resolveLocationAnswer("77002");
    expect(r).toMatchObject({ postalCode: "77002", city: "Houston", state: "TX", matched: true });
    expect(r.latitude).toBeCloseTo(29.76, 1);
  });

  it("keeps an unrecognised five-digit code without inventing a place", () => {
    // Someone in Mexico typing their código postal. We store what they said and
    // leave the map fields null rather than guessing at a US city.
    const r = resolveLocationAnswer("06700");
    expect(r.matched).toBe(false);
    expect(r.city).toBeNull();
    expect(r.latitude).toBeNull();
  });

  it("keeps a place name verbatim", () => {
    const r = resolveLocationAnswer("Guadalajara");
    expect(r).toMatchObject({ city: "Guadalajara", postalCode: null, matched: false });
  });

  it("clears everything for a blank answer", () => {
    expect(resolveLocationAnswer("  ")).toMatchObject({ city: null, postalCode: null });
  });
});
