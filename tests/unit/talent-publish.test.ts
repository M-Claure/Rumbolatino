import { beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsEvent, AnalyticsProps } from "@/lib/analytics/events";
import type { Analytics } from "@/lib/analytics";
import type { TalentAvailability } from "@/types";
import { MemoryStore } from "@/lib/repositories/memory-store";
import { MemoryTalentStore } from "@/lib/repositories/talent-store";
import { PUBLISH_TERMS_VERSION } from "@/lib/legal/terms";
import {
  getPublishDefaults,
  publishTalentProfile,
  unpublishTalentProfile,
} from "@/lib/services/talent-publish";

class RecordingAnalytics implements Analytics {
  readonly events: Array<{ event: AnalyticsEvent; props: AnalyticsProps }> = [];
  track(event: AnalyticsEvent, props: AnalyticsProps): void {
    this.events.push({ event, props });
  }
}

let store: MemoryStore;
let talent: MemoryTalentStore;
let analytics: RecordingAnalytics;

const USER = "user-1";

/** A résumé that is ready to publish: finalized, generated, reachable. */
async function readyProfile(
  o: {
    finalize?: boolean;
    generate?: boolean;
    contact?: boolean;
    /** The ZIP the funnel captured. `null` = somebody outside the US. */
    postalCode?: string | null;
  } = {},
) {
  const { finalize = true, generate = true, contact = true, postalCode = "77002" } = o;
  const profile = await store.createResumeProfile(USER, {
    targetRole: "Cosmetóloga",
    location: "Houston, TX",
  });
  await store.upsertPersonalInformation(profile.id, {
    firstName: "María",
    lastName: "Gutiérrez",
    city: "Houston",
    state: "TX",
    // Derived from the ZIP by `lib/geo/location-answer.ts` in the funnel, so a
    // fixture that set the ZIP without them would be a state the funnel cannot
    // produce.
    ...(postalCode
      ? { postalCode, latitude: 29.7594, longitude: -95.3594 }
      : { postalCode: null, latitude: null, longitude: null }),
    ...(contact ? { email: "maria@correo.com", phone: "555 123 4567" } : {}),
  });
  if (generate) {
    await store.createGeneratedResume(profile.id, {
      professionalSummary: "Cosmetóloga con formación en cuidado de la piel.",
      skills: [{ category: "Técnicas", skills: ["Manicure"], sourceSkillIds: [] }],
      experience: [],
      education: [],
      certifications: [],
      projects: [],
      languages: [],
      html: "<html></html>",
      pdfPath: `${USER}/${profile.id}/curriculum.pdf`,
    });
  }
  if (finalize) {
    await store.updateResumeProfile(profile.id, { finalizedAt: new Date().toISOString() });
  }
  return (await store.getResumeProfile(profile.id))!;
}

/**
 * `availability` is a REQUIRED parameter, so every call has to state one. That
 * is the point of it: it used to be hard-coded `flexible` inside the service,
 * and a required argument is what stops that from happening again silently.
 */
function publish(
  profile: Awaited<ReturnType<typeof readyProfile>>,
  availability: TalentAvailability = "dos_semanas",
) {
  return publishTalentProfile({ store, talent, analytics, userId: USER, profile, availability });
}

beforeEach(() => {
  store = new MemoryStore();
  talent = new MemoryTalentStore();
  analytics = new RecordingAnalytics();
});

// ── The three gates ─────────────────────────────────────────────────────────

describe("publishing is gated on the résumé being finishable and reachable", () => {
  it("refuses a résumé that was never finalized", async () => {
    const profile = await readyProfile({ finalize: false });
    await expect(publish(profile)).rejects.toThrow(/Finaliza tu currículum/);
    expect(await talent.getByFunnelId(profile.id)).toBeNull();
  });

  it("refuses a profile with no generated résumé to project from", async () => {
    const profile = await readyProfile({ generate: false });
    await expect(publish(profile)).rejects.toThrow(/Genera tu currículum/);
  });

  it("refuses when there is no way to contact the person", async () => {
    // A listing nobody can reach is pure exposure: it discloses a name, a city
    // and a work history and returns nothing to the person who disclosed them.
    const profile = await readyProfile({ contact: false });
    await expect(publish(profile)).rejects.toThrow(/correo o tu teléfono/);
    expect(await talent.getByFunnelId(profile.id)).toBeNull();
  });

  it("accepts a phone alone, since either channel is enough", async () => {
    const profile = await readyProfile({ contact: false });
    await store.upsertPersonalInformation(profile.id, { phone: "555 123 4567" });
    await expect(publish(profile)).resolves.toBeTruthy();
  });
});

// ── Consent ─────────────────────────────────────────────────────────────────

describe("publish consent", () => {
  it("stamps its own timestamp and version, not the sign-up terms", async () => {
    const profile = await readyProfile();
    expect(profile.publishConsentAt).toBeNull();

    await publish(profile);

    const after = (await store.getResumeProfile(profile.id))!;
    expect(after.publishConsentAt).toBeTruthy();
    expect(after.publishConsentVersion).toBe(PUBLISH_TERMS_VERSION);
    // The résumé-building consent is a separate field and must be untouched.
    expect(after.termsVersion).toBe(profile.termsVersion);
  });

  it("records no consent when the publish is refused", async () => {
    const profile = await readyProfile({ finalize: false });
    await expect(publish(profile)).rejects.toThrow();
    const after = (await store.getResumeProfile(profile.id))!;
    expect(after.publishConsentAt).toBeNull();
    expect(after.publishConsentVersion).toBeNull();
  });
});

// ── What actually lands in the directory ────────────────────────────────────

describe("the published listing", () => {
  it("keeps the email, phone and PDF path out of the public row", async () => {
    const profile = await readyProfile();
    await publish(profile);

    const found = await talent.getPublicBySlug(
      (await talent.getByFunnelId(profile.id))!.profile.slug,
    );
    const serialized = JSON.stringify(found);
    // The NAME is public now — the popup says so plainly. The contact channels
    // and the PDF path still are not: those come from `talent_contacts`, through
    // a reveal that records who asked.
    for (const secret of ["maria@correo.com", "555 123 4567", "curriculum.pdf"]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
    expect(found?.displayName).toBe("María Gutiérrez");
  });

  it("derives the filter facets from the résumé instead of asking", async () => {
    // Nobody is asked about their trade or their seniority at the download
    // screen, because the résumé they just finished already answers both.
    const profile = await readyProfile();
    await publish(profile);
    const listing = (await talent.getByFunnelId(profile.id))!;
    expect(listing.profile.category).toBe("belleza"); // targetRole "Cosmetóloga"
    expect(listing.profile.yearsBucket).toBeTruthy();
  });

  it("stores the availability the person CHOSE, never a default", async () => {
    // The bug this replaced: the service wrote `flexible` on every listing to
    // satisfy a not-null column, and the profile page printed it as the
    // candidate's own words. Availability is now the one facet that is answered
    // rather than derived — no résumé says when somebody is free to start.
    for (const chosen of ["inmediata", "dos_semanas", "un_mes", "flexible"] as const) {
      talent = new MemoryTalentStore();
      const profile = await readyProfile();
      await publish(profile, chosen);
      expect((await talent.getByFunnelId(profile.id))!.profile.availability).toBe(chosen);
    }
  });

  it("reports the chosen availability to analytics", async () => {
    // Worth recording now that it is a real choice out of a closed set; it was
    // pointless while every listing said the same thing.
    const profile = await readyProfile();
    await publish(profile, "inmediata");
    const event = analytics.events.find((e) => e.event === "talent_profile_published");
    expect(event?.props.availability).toBe("inmediata");
  });

  it("resolves the metro from the captured ZIP, once, at publish time", async () => {
    // The spec's "resolve once and store it, so employer searches are fast".
    // Nobody is asked which metro they live in — it is a table lookup on the ZIP
    // the funnel already captured, written onto the row the search reads.
    const profile = await readyProfile();
    await publish(profile);
    const listing = (await talent.getByFunnelId(profile.id))!;
    expect(listing.profile.cbsaCode).toBe("26420");
    expect(listing.profile.cbsaTitle).toBe("Houston-Pasadena-The Woodlands, TX");
  });

  it("publishes the ZIP-area centroid as the map coordinate", async () => {
    const profile = await readyProfile();
    await publish(profile);
    const listing = (await talent.getByFunnelId(profile.id))!;
    expect(listing.profile.latitude).toBe(29.7594);
    expect(listing.profile.longitude).toBe(-95.3594);
  });

  it("leaves the metro and the coordinates null for someone with no US ZIP", async () => {
    // They are then absent from metro search and off the map, rather than being
    // placed at a plausible-looking point. The listing itself still works: the
    // name, trade and résumé are all there and an unfiltered search finds them.
    const profile = await readyProfile({ postalCode: null });
    await publish(profile);
    const listing = (await talent.getByFunnelId(profile.id))!;
    expect(listing.profile.cbsaCode).toBeNull();
    expect(listing.profile.cbsaTitle).toBeNull();
    expect(listing.profile.latitude).toBeNull();
    expect((await talent.search({})).total).toBe(1);
    expect((await talent.search({ cbsaCode: "26420" })).total).toBe(0);
  });

  it("shows the full name, which is what the popup says employers will see", async () => {
    const profile = await readyProfile();
    await publish(profile);
    expect((await talent.getByFunnelId(profile.id))!.profile.displayName).toBe("María Gutiérrez");
  });

  it("gives the slug an unguessable suffix", async () => {
    const profile = await readyProfile();
    const listing = await publish(profile);
    expect(listing.profile.slug).toMatch(/^maria-gutierrez-[a-z0-9]{4,}$/);
  });

  it("issues a manage token long enough to be a bearer credential", async () => {
    const listing = await publish(await readyProfile());
    expect(listing.manageToken.length).toBeGreaterThanOrEqual(32);
  });

  it("reports the publish to analytics with closed-set properties only", async () => {
    const profile = await readyProfile();
    await publish(profile);
    const event = analytics.events.find((e) => e.event === "talent_profile_published");
    expect(event?.props).toEqual({
      resumeProfileId: profile.id,
      talentCategory: "belleza",
      // The fixture has no experience entries, so the estimator says so
      // rather than inventing a range.
      yearsBucket: "sin_experiencia",
      // The `publish` helper's default. Every value here is a closed-set id or
      // an opaque profile id — no free text, which is what this assertion is
      // really pinning. See the analytics allow-list.
      availability: "dos_semanas",
    });
  });
});

// ── Re-publishing ───────────────────────────────────────────────────────────

describe("re-publishing after an edit", () => {
  it("updates the one listing instead of adding a second", async () => {
    const profile = await readyProfile();
    await publish(profile);
    await publish(profile);
    expect((await talent.search({})).total).toBe(1);
  });

  it("re-derives the facets, so fixing the résumé fixes the listing", async () => {
    const profile = await readyProfile();
    await publish(profile);
    expect((await talent.getByFunnelId(profile.id))!.profile.category).toBe("belleza");

    await store.updateResumeProfile(profile.id, { targetRole: "Cocinera de restaurante" });
    const updated = (await store.getResumeProfile(profile.id))!;
    // A re-publish re-sends the availability the person already chose, which is
    // what `PublishDefaults.availability` hands the popup. It is DERIVED facets
    // that change here; the answered one is carried, not recomputed.
    await publishTalentProfile({
      store,
      talent,
      analytics,
      userId: USER,
      profile: updated,
      availability: "dos_semanas",
    });

    expect((await talent.getByFunnelId(profile.id))!.profile.category).toBe("gastronomia");
    expect((await talent.getByFunnelId(profile.id))!.profile.availability).toBe("dos_semanas");
  });

  it("keeps the slug, so a URL already sent to an employer keeps working", async () => {
    const profile = await readyProfile();
    const first = await publish(profile);
    const second = await publish(profile);
    expect(second.profile.slug).toBe(first.profile.slug);
  });

  it("keeps the manage token, which may already be in someone's email", async () => {
    const profile = await readyProfile();
    const first = await publish(profile);
    const second = await publish(profile);
    expect(second.manageToken).toBe(first.manageToken);
    expect(await talent.findByManageToken(first.manageToken)).toEqual({
      slug: first.profile.slug,
      funnelId: profile.id,
    });
  });
});

// ── Unpublishing ────────────────────────────────────────────────────────────

describe("unpublishing", () => {
  it("removes the listing from the directory without destroying the row", async () => {
    const profile = await readyProfile();
    const listing = await publish(profile);

    await unpublishTalentProfile({ talent, analytics, userId: USER, profileId: profile.id });

    expect(await talent.getPublicBySlug(listing.profile.slug)).toBeNull();
    expect((await talent.search({})).total).toBe(0);
    // The row survives: `contact_reveals` references it, so deleting would erase
    // the record of who already has this person's details.
    expect((await talent.getByFunnelId(profile.id))?.status).toBe("unpublished");
  });

  it("is idempotent — withdrawing consent must never fail on a retry", async () => {
    const profile = await readyProfile();
    const args = { talent, analytics, userId: USER, profileId: profile.id };
    await expect(unpublishTalentProfile(args)).resolves.toBeUndefined();
    await expect(unpublishTalentProfile(args)).resolves.toBeUndefined();
  });

  it("can be re-published, returning to the same URL", async () => {
    const profile = await readyProfile();
    const first = await publish(profile);
    await unpublishTalentProfile({ talent, analytics, userId: USER, profileId: profile.id });
    const again = await publish(profile);
    expect(again.profile.slug).toBe(first.profile.slug);
    expect(await talent.getPublicBySlug(first.profile.slug)).toBeTruthy();
  });
});

// ── Defaults for the form ───────────────────────────────────────────────────

describe("getPublishDefaults", () => {
  it("hands a re-publish back the answer already on the listing", async () => {
    // So that fixing a résumé does not re-open a question the person has
    // already answered. Null before there is a listing, because the popup must
    // start with NOTHING selected — a pre-chosen answer to "when can you start?"
    // is how the old placeholder got mistaken for an answer.
    const profile = await readyProfile();
    expect((await getPublishDefaults(store, talent, profile.id)).availability).toBeNull();

    await publish(profile, "un_mes");
    expect((await getPublishDefaults(store, talent, profile.id)).availability).toBe("un_mes");
  });

  it("returns what the popup shows, and nothing it does not need", async () => {
    const profile = await readyProfile();
    const defaults = await getPublishDefaults(store, talent, profile.id);
    // The popup names the exact data employers get, so it needs those values to
    // show them back — and the person can check they are right before agreeing.
    expect(defaults).toEqual({
      displayName: "María Gutiérrez",
      email: "maria@correo.com",
      phone: "555 123 4567",
      published: false,
      // Null, not a suggestion: the popup opens with nothing selected. An exact
      // shape here so a field added to `PublishDefaults` has to be looked at.
      availability: null,
    });
    // Reading it must not create anything: the popup may be declined.
    expect(await talent.getByFunnelId(profile.id)).toBeNull();
  });

  it("reports an existing listing, so the popup does not reappear over one", async () => {
    const profile = await readyProfile();
    await publish(profile);
    expect((await getPublishDefaults(store, talent, profile.id)).published).toBe(true);
  });

  it("reports not-published after the listing is taken down", async () => {
    const profile = await readyProfile();
    await publish(profile);
    await unpublishTalentProfile({ talent, analytics, userId: USER, profileId: profile.id });
    expect((await getPublishDefaults(store, talent, profile.id)).published).toBe(false);
  });
});
