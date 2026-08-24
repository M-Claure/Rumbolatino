import { beforeEach, describe, expect, it } from "vitest";
import type { TalentLocation, TalentProfilePublic } from "@/types";
import { MemoryTalentStore, talentExpiryFrom } from "@/lib/repositories/talent-store";
import { LIMITS, isOverLimit, rateLimitKey } from "@/lib/rate-limit/policy";

let talent: MemoryTalentStore;

const HOUR = 3600_000;

function profile(o: Partial<TalentProfilePublic> = {}): TalentProfilePublic {
  return {
    slug: "maria-g-aaa111",
    displayName: "María G.",
    headline: "Cosmetóloga",
    summary: "Cuidado de la piel y manicure.",
    category: "belleza",
    skills: ["Manicure", "Pedicure"],
    certifications: [],
    education: [],
    experience: [],
    languages: [],
    yearsBucket: "3_5",
    availability: "inmediata",
    city: "Houston",
    state: "TX",
    country: "Estados Unidos",
    publishedAt: new Date(Date.now() - HOUR).toISOString(),
    ...o,
  };
}

/** Real ZIP centroids, so the distances below are the true ones. */
const PLACES = {
  houston: { postalCode: "77002", latitude: 29.7594, longitude: -95.3594 },
  katy: { postalCode: "77494", latitude: 29.7445, longitude: -95.83 },
  dallas: { postalCode: "75201", latitude: 32.7876, longitude: -96.7995 },
  miami: { postalCode: "33125", latitude: 25.7825, longitude: -80.2341 },
  nowhere: { postalCode: null, latitude: null, longitude: null },
};

async function seed(
  o: Partial<TalentProfilePublic> = {},
  over: { expiresAt?: string; location?: TalentLocation } = {},
) {
  const p = profile(o);
  return talent.publish({
    funnelId: `funnel-${p.slug}`,
    userId: `user-${p.slug}`,
    profile: p,
    location: over.location ?? PLACES.houston,
    contact: {
      fullName: "María Gutiérrez",
      email: "maria@correo.com",
      phone: "555 123 4567",
      linkedInUrl: null,
      resumePdfPath: "u/p/curriculum.pdf",
    },
    manageToken: `token-${p.slug}`,
    expiresAt: over.expiresAt ?? talentExpiryFrom(p.publishedAt),
  });
}

beforeEach(() => {
  talent = new MemoryTalentStore();
});

// ── Expiry ──────────────────────────────────────────────────────────────────

describe("listings go stale on their own", () => {
  it("hides an expired listing from search and from its own URL", async () => {
    await seed({ slug: "vieja-aaa111" }, { expiresAt: new Date(Date.now() - HOUR).toISOString() });

    // Expiry is enforced in the read path, not by a cron, so a listing
    // disappears even if no scheduled job ever runs.
    expect((await talent.search({})).total).toBe(0);
    expect(await talent.getPublicBySlug("vieja-aaa111")).toBeNull();
  });

  it("still shows the owner their own expired listing, so they can renew it", async () => {
    const listing = await seed(
      { slug: "vieja-aaa111" },
      { expiresAt: new Date(Date.now() - HOUR).toISOString() },
    );
    expect(await talent.getByFunnelId(listing.funnelId)).toBeTruthy();
  });

  it("defaults to a 90-day life", async () => {
    const published = "2026-08-24T00:00:00.000Z";
    expect(talentExpiryFrom(published)).toBe("2026-11-22T00:00:00.000Z");
  });
});

// ── Search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  beforeEach(async () => {
    await seed({ slug: "a-1", category: "belleza", city: "Houston", state: "TX" });
    await seed(
      {
        slug: "b-2",
        category: "gastronomia",
        headline: "Cocinera",
        skills: ["Repostería"],
        city: "Dallas",
        state: "TX",
        availability: "un_mes",
      },
      { location: PLACES.dallas },
    );
    await seed({ slug: "c-3", category: "belleza", city: "Miami", state: "FL" }, {
      location: PLACES.miami,
    });
  });

  it("filters by category and availability", async () => {
    expect((await talent.search({ category: "belleza" })).total).toBe(2);
    expect((await talent.search({ availability: "un_mes" })).total).toBe(1);
  });

  it("matches free text against the headline and the skills", async () => {
    expect((await talent.search({ query: "cocinera" })).total).toBe(1);
    expect((await talent.search({ query: "reposteria" })).total).toBe(1);
  });

  it("finds the same person whether or not the accent was typed", async () => {
    // Not a nicety. This audience writes Spanish on phone keyboards, where the
    // accented vowel is a long-press away, and many people simply do not use
    // accents. Postgres does NOT do this for free: the stock `spanish` text
    // search config stems but does not fold accents, so the migration builds a
    // `spanish_unaccent` configuration and uses it on BOTH the stored document
    // and the query. This test pins the same contract for the memory store, so
    // the two implementations cannot disagree about it.
    for (const typed of ["reposteria", "repostería", "REPOSTERIA", "Repostería"]) {
      expect((await talent.search({ query: typed })).total, typed).toBe(1);
    }
  });

  // ── Name search (0012) ────────────────────────────────────────────────────
  // Typing a name used to find nobody and say nothing about why: the name is not
  // in `search_tsv`. `name_tsv` is a second, UNSTEMMED matcher, ORed with it.
  //
  // The three rows seeded above are all named "María G.", which is what the
  // counts here are against: these tests use `Lucía`/`Lucio` so a first-name
  // query is unambiguous.
  describe("by name", () => {
    beforeEach(async () => {
      await seed({ slug: "n-1", displayName: "Lucía Fuentes" }, { location: PLACES.katy });
      await seed({ slug: "n-2", displayName: "Lucio Ferrer" }, { location: PLACES.katy });
    });

    it("finds a person by their full name, either half of it, or both", async () => {
      for (const typed of ["Lucía Fuentes", "Fuentes", "Fuentes Lucía"]) {
        const { profiles, total } = await talent.search({ query: typed });
        expect(total, typed).toBe(1);
        expect(profiles[0]?.displayName, typed).toBe("Lucía Fuentes");
      }
    });

    it("ignores the accent and the case, in both directions", async () => {
      for (const typed of ["lucia fuentes", "LUCÍA FUENTES", "LuCia Fuentes"]) {
        expect((await talent.search({ query: typed })).total, typed).toBe(1);
      }
    });

    it("matches the beginning of a name, so a half-typed surname works", async () => {
      expect((await talent.search({ query: "fuen" })).total).toBe(1);
      // ANDed, not ORed: "luc fuen" must not fall back to every Luc…
      expect((await talent.search({ query: "luc fuen" })).total).toBe(1);
      // …and a prefix the two of them share still returns both.
      expect((await talent.search({ query: "luc" })).total).toBe(2);
    });

    it("matches a name only from its start, never from the middle", async () => {
      // The distinction between the two matchers behind one box: résumé text is
      // matched by containment, a name by PREFIX. Without that, "ere" would list
      // Ferrer, and a name box that matches word interiors returns strangers.
      expect((await talent.search({ query: "errer" })).total).toBe(0);
      expect((await talent.search({ query: "ferrer" })).total).toBe(1);
    });

    it("drops one-character tokens instead of prefixing them", async () => {
      // `a:*` would match a large share of any name column, which turns a single
      // keystroke into a way to page out the directory. Nothing survives the
      // floor here, so this is an unfiltered search, not a match-everything one.
      expect((await talent.search({ query: "a" })).total).toBe(3 + 2);
    });

    it("still finds people by what they do, which is the other half of the box", async () => {
      expect((await talent.search({ query: "cocinera" })).total).toBe(1);
    });

    it("obeys the other filters, so a name cannot reach past them", async () => {
      // A name match is not a bypass: the category and the radius still apply.
      expect((await talent.search({ query: "Fuentes", category: "gastronomia" })).total).toBe(0);
      expect(
        (
          await talent.search({
            query: "Fuentes",
            latitude: PLACES.miami.latitude,
            longitude: PLACES.miami.longitude,
            radiusMiles: 25,
          })
        ).total,
      ).toBe(0);
    });

    it("keeps an expired listing unfindable by name", async () => {
      await seed(
        { slug: "n-9", displayName: "Rosa Vieja" },
        { expiresAt: new Date(Date.now() - HOUR).toISOString() },
      );
      expect((await talent.search({ query: "Rosa Vieja" })).total).toBe(0);
    });
  });

  it("returns everything when no filter is given", async () => {
    expect((await talent.search({})).total).toBe(3);
  });

  it("returns no contact data on any result", async () => {
    const { profiles } = await talent.search({});
    const serialized = JSON.stringify(profiles);
    for (const secret of ["maria@correo.com", "555 123 4567", "Gutiérrez", "curriculum.pdf"]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("paginates, and reports the full total rather than the page size", async () => {
    const page = await talent.search({ limit: 2, offset: 0 });
    expect(page.profiles).toHaveLength(2);
    expect(page.total).toBe(3);
    expect((await talent.search({ limit: 2, offset: 2 })).profiles).toHaveLength(1);
  });

  it("caps the page size, so the directory cannot be pulled in one request", async () => {
    // Mirrors `least(coalesce(p_limit, 24), 60)` inside `talent_search`. The cap
    // belongs in the store, not the route: a caller must not be able to opt out
    // of it by hand-crafting a request.
    const { profiles } = await talent.search({ limit: 10_000 });
    expect(profiles.length).toBeLessThanOrEqual(60);
  });
});

// ── Contact reveal ──────────────────────────────────────────────────────────

describe("revealing a contact", () => {
  it("hands over the contact and records the access, together", async () => {
    await seed({ slug: "a-1" });

    // Downloads are open to anyone, so there is no employer to attribute this
    // to — but the row is still written, which is what keeps a timestamp trail.
    const contact = await talent.revealContact({ employerId: null, slug: "a-1" });

    expect(contact?.email).toBe("maria@correo.com");
    expect(contact?.resumePdfPath).toBe("u/p/curriculum.pdf");
    expect(talent.reveals).toHaveLength(1);
    expect(talent.reveals[0]).toMatchObject({ employerId: null, slug: "a-1" });
  });

  it("reveals nothing, and logs nothing, for a slug that is not live", async () => {
    await seed({ slug: "a-1" });
    await talent.setStatus("funnel-a-1", "unpublished");

    expect(await talent.revealContact({ employerId: null, slug: "a-1" })).toBeNull();
    expect(await talent.revealContact({ employerId: null, slug: "no-existe" })).toBeNull();
    // No access happened, so there is no access to record.
    expect(talent.reveals).toHaveLength(0);
  });

  it("stops revealing once a listing expires", async () => {
    await seed({ slug: "a-1" }, { expiresAt: new Date(Date.now() - HOUR).toISOString() });
    expect(await talent.revealContact({ employerId: null, slug: "a-1" })).toBeNull();
  });
});

// ── Proximity ───────────────────────────────────────────────────────────────

describe("proximity search", () => {
  beforeEach(async () => {
    await seed({ slug: "houston", city: "Houston", state: "TX" }, { location: PLACES.houston });
    await seed({ slug: "katy", city: "Katy", state: "TX" }, { location: PLACES.katy });
    await seed({ slug: "dallas", city: "Dallas", state: "TX" }, { location: PLACES.dallas });
    await seed({ slug: "sin-zip", city: null, state: null }, { location: PLACES.nowhere });
  });

  const near = (p: { latitude: number | null; longitude: number | null }, radiusMiles: number) =>
    talent.search({ latitude: p.latitude, longitude: p.longitude, radiusMiles });

  it("returns only people inside the radius", async () => {
    // Katy is genuinely ~28 miles from downtown Houston, so 25 excludes it and
    // 40 includes it. These are real ZIP centroids, not invented numbers.
    expect((await near(PLACES.houston, 25)).total).toBe(1);
    expect((await near(PLACES.houston, 40)).total).toBe(2);
  });

  it("orders nearest first", async () => {
    const { profiles } = await near(PLACES.katy, 500);
    expect(profiles.map((p) => p.slug)).toEqual(["katy", "houston", "dallas"]);
  });

  it("reports the distance on each result", async () => {
    const { profiles } = await near(PLACES.houston, 40);
    expect(Math.round(profiles[0]!.distanceMiles!)).toBe(0);
    expect(Math.round(profiles[1]!.distanceMiles!)).toBe(28);
  });

  it("trims the corners — a radius is a circle, not a box", async () => {
    // Dallas is ~218 miles from Houston. A bounding box alone would let it
    // through at 200 on the diagonal; the distance check must not.
    expect((await near(PLACES.houston, 200)).total).toBe(2);
    expect((await near(PLACES.houston, 250)).total).toBe(3);
  });

  it("excludes anyone with no coordinates from a radius search", async () => {
    // Someone outside the US has no ZIP and therefore no point on the map. They
    // must not be silently placed anywhere — they simply do not match.
    const { profiles } = await near(PLACES.houston, 500);
    expect(profiles.map((p) => p.slug)).not.toContain("sin-zip");
  });

  it("includes them again when there is no radius, with no distance", async () => {
    const { profiles, total } = await talent.search({});
    expect(total).toBe(4);
    expect(profiles.every((p) => p.distanceMiles === undefined)).toBe(true);
  });

  it("clamps an absurd radius instead of scanning the world", async () => {
    // Mirrors `least(greatest(radius,1),500)` inside `talent_search`.
    expect((await near(PLACES.houston, 100_000)).total).toBe(3);
  });

  it("combines the radius with the other filters", async () => {
    // The four rows above are all the fixture's default category (belleza), so
    // this adds the only gastronomia one — in Houston — and a second in Dallas
    // that the radius must exclude even though the category matches.
    await seed({ slug: "houston-cocina", category: "gastronomia" }, { location: PLACES.houston });
    await seed({ slug: "dallas-cocina", category: "gastronomia" }, { location: PLACES.dallas });

    const { profiles } = await talent.search({
      category: "gastronomia",
      latitude: PLACES.houston.latitude,
      longitude: PLACES.houston.longitude,
      radiusMiles: 10,
    });
    expect(profiles.map((p) => p.slug)).toEqual(["houston-cocina"]);
  });
});

// ── Rate-limit policy ───────────────────────────────────────────────────────

describe("directory rate limits", () => {
  it("defines every directory operation with a documented reason", () => {
    for (const op of ["talent_publish", "directory_search", "contact_reveal"] as const) {
      expect(LIMITS[op].limit).toBeGreaterThan(0);
      expect(LIMITS[op].windowSeconds).toBeGreaterThan(0);
      expect(LIMITS[op].reason.length).toBeGreaterThan(40);
    }
  });

  it("keeps contact_reveal the tightest", () => {
    // Since the employer form was removed this is the ONLY ceiling left on bulk
    // collection of people's contact details — everything else here protects
    // infrastructure, this protects people.
    expect(LIMITS.contact_reveal.limit).toBeLessThan(LIMITS.directory_search.limit);
    expect(isOverLimit("contact_reveal", LIMITS.contact_reveal.limit)).toBe(false);
    expect(isOverLimit("contact_reveal", LIMITS.contact_reveal.limit + 1)).toBe(true);
  });

  it("keys reveals by address, since downloads are anonymous now", () => {
    expect(rateLimitKey("contact_reveal", { ip: "1.2.3.4" })).toBe("ip:1.2.3.4:contact_reveal");
    // A proxy stripping the address must not become a way to opt out of counting.
    expect(rateLimitKey("contact_reveal", {})).toBe("ip:unknown:contact_reveal");
  });

});
