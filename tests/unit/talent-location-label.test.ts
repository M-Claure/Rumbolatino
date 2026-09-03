import { describe, expect, it } from "vitest";
import { metroAddsPlace } from "@/lib/talent/location-label";

/**
 * When the metro area is worth printing beside the city, and when it is the
 * location written twice.
 *
 * The profile header printed both unconditionally, which read as duplication
 * for most people — the whole reason this function exists. The cases below are
 * the ones that decide it: the metro named after the city it is in (hide), and
 * the suburb whose metro is named after somewhere else (show, because that is
 * the fact the metro filter exists to surface).
 */

const HOUSTON = "Houston-Pasadena-The Woodlands, TX";
const MIAMI = "Miami-Fort Lauderdale-West Palm Beach, FL";

describe("metroAddsPlace", () => {
  it("hides the metro when the city is already its name", () => {
    // The reported bug: "📍 Miami, FL, Estados Unidos" beside
    // "🧭 Miami-Fort Lauderdale-West Palm Beach, FL" is one fact twice.
    expect(metroAddsPlace("Miami", MIAMI)).toBe(false);
    expect(metroAddsPlace("Houston", HOUSTON)).toBe(false);
  });

  it("SHOWS it for a suburb, which is who the metro filter is for", () => {
    // Katy and Sugar Land are the people a city-name search misses. An employer
    // looking at this profile after a Houston metro search needs to see why it
    // came back.
    expect(metroAddsPlace("Katy", HOUSTON)).toBe(true);
    expect(metroAddsPlace("Sugar Land", HOUSTON)).toBe(true);
  });

  it("shows it for a SECONDARY city in the title, not just an absent one", () => {
    // The reason the comparison is against the metro's lead city rather than
    // the whole string. "The Woodlands" and "Fort Lauderdale" both appear in
    // their titles, and someone there still wants to be told which metro they
    // are in — testing the full title would hide it from exactly those people.
    expect(metroAddsPlace("The Woodlands", HOUSTON)).toBe(true);
    expect(metroAddsPlace("Fort Lauderdale", MIAMI)).toBe(true);
  });

  it("ignores accents and case on both sides", () => {
    // Spanish typed on a phone keyboard, and city text the person wrote
    // themselves. `San Juan-Bayamón-Caguas, PR` has to match a city of "san
    // juan" written either way.
    expect(metroAddsPlace("san juan", "San Juan-Bayamón-Caguas, PR")).toBe(false);
    expect(metroAddsPlace("BAYAMON", "San Juan-Bayamón-Caguas, PR")).toBe(true);
    expect(metroAddsPlace("Bayamón", "San Juan-Bayamón-Caguas, PR")).toBe(true);
  });

  it("handles a compound lead city", () => {
    // `Winston-Salem, NC` splits to a lead of "Winston", so equality alone
    // would show the metro to somebody living in Winston-Salem. Containment in
    // both directions is what stops that.
    expect(metroAddsPlace("Winston-Salem", "Winston-Salem, NC")).toBe(false);
    // And one with no hyphen at all to split on.
    expect(metroAddsPlace("Honolulu", "Urban Honolulu, HI")).toBe(false);
  });

  it("does not let a multi-state suffix become the lead city", () => {
    // `Chicago-Naperville-Elgin, IL-IN` — splitting the whole string on "-"
    // before dropping the state would make `IL` a city. The state comes off at
    // the LAST comma first.
    expect(metroAddsPlace("Chicago", "Chicago-Naperville-Elgin, IL-IN")).toBe(false);
    expect(metroAddsPlace("Naperville", "Chicago-Naperville-Elgin, IL-IN")).toBe(true);
  });

  it("shows the metro when there is no city text at all", () => {
    // A listing whose ZIP resolved but whose city text is missing. "Somewhere in
    // the Miami area" beats no location at all.
    expect(metroAddsPlace(null, MIAMI)).toBe(true);
    expect(metroAddsPlace("", MIAMI)).toBe(true);
    expect(metroAddsPlace("   ", MIAMI)).toBe(true);
  });

  it("shows nothing when there is no metro", () => {
    // A rural ZIP outside every CBSA, or nobody with a US ZIP at all.
    expect(metroAddsPlace("Bearcreek", null)).toBe(false);
    expect(metroAddsPlace("Guadalajara", null)).toBe(false);
    expect(metroAddsPlace("Miami", "")).toBe(false);
  });
});
