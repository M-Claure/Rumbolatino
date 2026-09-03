import { describe, expect, it } from "vitest";
import type { GeneratedResume, PersonalInformation, TalentProfilePublic } from "@/types";
import {
  buildTalentSlug,
  estimateYearsBucket,
  projectTalentProfile,
  publicDisplayName,
  splitLocation,
  TALENT_LIMITS,
  type TalentProjectionInput,
} from "@/lib/talent/talent-projection";

// ── Fixtures ────────────────────────────────────────────────────────────────

function resume(o: Partial<GeneratedResume> = {}): GeneratedResume {
  return {
    id: "res-1",
    resumeProfileId: "prof-1",
    version: 1,
    stage: 0,
    professionalSummary: "Cosmetóloga con formación en cuidado de la piel.",
    skills: [{ category: "Técnicas", skills: ["Manicure", "Pedicure"], sourceSkillIds: ["s1"] }],
    experience: [
      {
        entryId: "e1",
        title: "Estilista",
        organization: "Salón Bella",
        location: "Houston",
        startDate: "marzo 2019",
        endDate: null,
        isCurrent: true,
        experienceType: "formal_employment",
        bullets: [
          { text: "Atendía a 15 clientas por semana", sourceEntryIds: ["e1"], sourceFields: ["metrics"] },
        ],
      },
    ],
    education: [
      {
        entryId: "ed1",
        institution: "Aprende Institute",
        credential: "Certificado en Cosmetología",
        fieldOfStudy: "Cosmetología",
        startDate: null,
        endDate: "2021",
        isCurrent: false,
        details: [],
      },
    ],
    certifications: [
      { entryId: "c1", name: "Certificación en barbería", issuingOrganization: "Aprende", issueDate: "2022" },
    ],
    projects: [],
    languages: [{ entryId: "l1", name: "Inglés", level: "intermedio" }],
    html: "<html></html>",
    pdfPath: "user-1/prof-1/curriculum.pdf",
    createdAt: new Date().toISOString(),
    ...o,
  };
}

function personal(o: Partial<PersonalInformation> = {}): PersonalInformation {
  return {
    resumeProfileId: "prof-1",
    firstName: "María",
    lastName: "Gutiérrez",
    postalCode: "77002",
    city: "Houston",
    state: "TX",
    country: "Estados Unidos",
    phone: "555 123 4567",
    email: "maria@correo.com",
    linkedInUrl: "https://linkedin.com/in/maria",
    portfolioUrl: null,
    latitude: 29.7594,
    longitude: -95.3594,
    ...o,
  };
}

function input(o: Partial<TalentProjectionInput> = {}): TalentProjectionInput {
  return {
    resume: resume(),
    personal: personal(),
    profile: { targetRole: "Cosmetóloga", location: null },
    category: "belleza",
    availability: "inmediata",
    yearsBucket: "3_5",
    location: {
      postalCode: "77002",
      latitude: 29.7594,
      longitude: -95.3594,
      cbsaCode: "26420",
      cbsaTitle: "Houston-Pasadena-The Woodlands, TX",
    },
    slug: "maria-g-a1b2c3",
    publishedAt: "2026-08-24T00:00:00.000Z",
    ...o,
  };
}

// ── The invariant that matters ──────────────────────────────────────────────

describe("the public projection carries no contact PII", () => {
  /**
   * The exact key set, not a denylist. A denylist only catches the leaks someone
   * thought of; this fails the moment ANY field is added to TalentProfilePublic,
   * which forces the decision "is this safe to show the whole internet?" to be
   * made deliberately, in a diff, by a person.
   */
  it("has exactly the keys the public shape declares", () => {
    const expected: Array<keyof TalentProfilePublic> = [
      "slug", "displayName", "headline", "summary", "category", "skills",
      "certifications", "education", "experience", "languages", "yearsBucket",
      "availability", "city", "state", "country", "publishedAt",
      // Added for the metro filter and the map. The metro is COARSER than the
      // city already on this list; the coordinates are FINER, and that was the
      // one real widening — a ZIP-area centroid, never an address, and already
      // derivable from the `distanceMiles` these searches return. The argument
      // is written out on `TalentProfilePublic.latitude`; this line is the part
      // that made someone read it.
      "cbsaCode", "cbsaTitle", "latitude", "longitude",
    ];
    expect(Object.keys(projectTalentProfile(input()).public).sort()).toEqual([...expected].sort());
  });

  it("takes the map fields from the resolved location, and never re-derives them", () => {
    // The projection is pure and the ZIP tables are `server-only`, so it must
    // not attempt a lookup — `talent-publish.ts` resolves once and passes the
    // same object here and to the store, which is what stops the public row and
    // the stored row from describing two different places.
    //
    // `personal` here says Houston and the location says Dallas. That cannot
    // happen in production; the point is that the projection reports what it was
    // GIVEN rather than reaching for `personal.latitude`, which is the mistake
    // that would put someone on the map at coordinates the row does not hold.
    const { public: pub } = projectTalentProfile(
      input({
        location: {
          postalCode: "75201",
          latitude: 32.7876,
          longitude: -96.7995,
          cbsaCode: "19100",
          cbsaTitle: "Dallas-Fort Worth-Arlington, TX",
        },
      }),
    );
    expect(pub).toMatchObject({
      latitude: 32.7876,
      longitude: -96.7995,
      cbsaCode: "19100",
      cbsaTitle: "Dallas-Fort Worth-Arlington, TX",
    });
  });

  it("carries nulls through for someone with no US ZIP, rather than a guess", () => {
    // These people are absent from the metro filter and off the map. Both are
    // better than being drawn at a plausible-looking point: a marker is read as
    // a fact about where somebody is.
    const { public: pub } = projectTalentProfile(
      input({
        location: {
          postalCode: null,
          latitude: null,
          longitude: null,
          cbsaCode: null,
          cbsaTitle: null,
        },
      }),
    );
    expect(pub.latitude).toBeNull();
    expect(pub.longitude).toBeNull();
    expect(pub.cbsaCode).toBeNull();
    expect(pub.cbsaTitle).toBeNull();
  });

  it("keeps the POSTAL CODE out of the public half", () => {
    // The centroid and the ZIP carry the same information, and the map needs the
    // first. The second is the shape that ends up in a spreadsheet, and nothing
    // public has a use for it — see the note on `TalentLocation`.
    const { public: pub } = projectTalentProfile(input());
    expect(JSON.stringify(pub)).not.toContain("77002");
    expect(pub).not.toHaveProperty("postalCode");
  });

  it("never contains a contact channel anywhere in the tree", () => {
    // The name is public. The ways to reach the person are not — they live in
    // `talent_contacts` and only leave it through an audited reveal.
    const result = projectTalentProfile(input());
    const serialized = JSON.stringify(result.public);
    for (const secret of ["maria@correo.com", "555 123 4567", "linkedin.com", "curriculum.pdf"]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("routes every contact channel to the contact half", () => {
    const { contact } = projectTalentProfile(input());
    expect(contact).toEqual({
      fullName: "María Gutiérrez",
      email: "maria@correo.com",
      phone: "555 123 4567",
      linkedInUrl: "https://linkedin.com/in/maria",
      resumePdfPath: "user-1/prof-1/curriculum.pdf",
      // The rendered résumé is contact data too: it prints the full name, the
      // email and the phone on the page. It belongs on this side of the split
      // for the same reason the PDF path does.
      resumeHtml: "<html></html>",
    });
  });

  it("snapshots the résumé HTML rather than leaving the preview to read it live", () => {
    // The listing is a projection taken at publish time. If the preview read
    // `funnel.resume_html` instead, regenerating without re-publishing would
    // make the framed preview and the downloaded PDF two different résumés.
    const { contact } = projectTalentProfile(
      input({ resume: resume({ html: "<html>v2</html>" }) }),
    );
    expect(contact.resumeHtml).toBe("<html>v2</html>");
  });

  it("reports no HTML rather than empty markup when nothing was rendered", () => {
    // `''` is the column default for every listing published before `0015`, and
    // the route reads null as "fall back to framing the PDF". An empty string
    // would be served as a blank document instead.
    for (const html of ["", "   "]) {
      expect(projectTalentProfile(input({ resume: resume({ html }) })).contact.resumeHtml).toBeNull();
    }
  });

  it("drops the source traces from bullets — provenance stays server-side", () => {
    const { public: pub } = projectTalentProfile(input());
    expect(pub.experience[0]?.bullets).toEqual(["Atendía a 15 clientas por semana"]);
    expect(JSON.stringify(pub)).not.toContain("sourceEntryIds");
  });
});

// ── The résumé is the upper bound ───────────────────────────────────────────

describe("the projection reads only the generated résumé", () => {
  it("publishes nothing when the résumé has nothing", () => {
    const { public: pub } = projectTalentProfile(
      input({
        // targetRole lives on the profile, not the résumé, so it is nulled here
        // too — this case is about the headline's last-resort fallback.
        profile: { targetRole: null, location: null },
        resume: resume({
          skills: [],
          experience: [],
          education: [],
          certifications: [],
          languages: [],
          professionalSummary: "",
        }),
      }),
    );
    expect(pub.skills).toEqual([]);
    expect(pub.experience).toEqual([]);
    expect(pub.education).toEqual([]);
    expect(pub.certifications).toEqual([]);
    expect(pub.languages).toEqual([]);
    expect(pub.summary).toBe("");
    // A résumé with no role still gets a headline, from the category label.
    expect(pub.headline).toBe("Belleza y estética");
  });

  it("takes skills from the résumé's groups, deduped", () => {
    const { public: pub } = projectTalentProfile(
      input({
        resume: resume({
          skills: [
            { category: "A", skills: ["Manicure", "Corte"], sourceSkillIds: [] },
            { category: "B", skills: ["Manicure", "Tinte"], sourceSkillIds: [] },
          ],
        }),
      }),
    );
    expect(pub.skills).toEqual(["Manicure", "Corte", "Tinte"]);
  });
});

// ── Naming, slugs, location ─────────────────────────────────────────────────

describe("publicDisplayName", () => {
  it("shows the full name — what the publish popup says employers will see", () => {
    expect(publicDisplayName(personal())).toBe("María Gutiérrez");
  });
  it("degrades gracefully", () => {
    expect(publicDisplayName(personal({ lastName: null }))).toBe("María");
    expect(publicDisplayName(personal({ firstName: null, lastName: null }))).toBe("Candidato");
    expect(publicDisplayName(null)).toBe("Candidato");
  });
});

describe("buildTalentSlug", () => {
  it("folds accents and keeps the random suffix that stops enumeration", () => {
    expect(buildTalentSlug("María Gutiérrez", "a1b2c3")).toBe("maria-gutierrez-a1b2c3");
  });
  it("still produces a usable slug when the name contributes nothing", () => {
    expect(buildTalentSlug("...", "a1b2c3")).toBe("perfil-a1b2c3");
  });
});

describe("location", () => {
  it("splits a free-text location as a fallback", () => {
    expect(splitLocation("Houston, TX")).toEqual({ city: "Houston", state: "TX" });
    expect(splitLocation("Houston")).toEqual({ city: "Houston", state: null });
    expect(splitLocation(null)).toEqual({ city: null, state: null });
  });

  it("never lets the free-text fallback overwrite a captured field", () => {
    const { public: pub } = projectTalentProfile(
      input({
        personal: personal({ city: "Katy", state: "TX" }),
        profile: { targetRole: null, location: "Dallas, CA" },
      }),
    );
    expect(pub.city).toBe("Katy");
    expect(pub.state).toBe("TX");
  });

  it("uses the fallback only for what was never captured", () => {
    const { public: pub } = projectTalentProfile(
      input({
        personal: personal({ city: null, state: null, country: null }),
        profile: { targetRole: null, location: "Dallas, TX" },
      }),
    );
    expect(pub.city).toBe("Dallas");
    expect(pub.state).toBe("TX");
    expect(pub.country).toBeNull();
  });
});

// ── Seniority, stated conservatively ────────────────────────────────────────

describe("estimateYearsBucket", () => {
  it("reports no experience as no experience", () => {
    expect(estimateYearsBucket([], 2026)).toBe("sin_experiencia");
  });

  it("buckets by the earliest parseable start year", () => {
    expect(estimateYearsBucket([{ startDate: "marzo 2025" }], 2026)).toBe("0_2");
    expect(estimateYearsBucket([{ startDate: "2022" }], 2026)).toBe("3_5");
    expect(estimateYearsBucket([{ startDate: "junio 2015" }], 2026)).toBe("6_mas");
  });

  it("uses the earliest of several entries", () => {
    expect(
      estimateYearsBucket([{ startDate: "2024" }, { startDate: "2010" }], 2026),
    ).toBe("6_mas");
  });

  it("does not read an undated history as a short one — it understates and asks", () => {
    // Dates here are free text and often unparseable. The estimate only
    // pre-fills a dropdown the person then corrects, so understating is the
    // safe direction: it never publishes seniority the résumé cannot support.
    expect(estimateYearsBucket([{ startDate: null }], 2026)).toBe("0_2");
    expect(estimateYearsBucket([{ startDate: "hace mucho" }], 2026)).toBe("0_2");
  });

  it("ignores impossible years rather than trusting them", () => {
    expect(estimateYearsBucket([{ startDate: "1850" }], 2026)).toBe("0_2");
  });
});

// ── Bounds ──────────────────────────────────────────────────────────────────

describe("public text is bounded", () => {
  it("clamps a long summary on a word boundary", () => {
    const long = "palabra ".repeat(300);
    const { public: pub } = projectTalentProfile(
      input({ resume: resume({ professionalSummary: long }) }),
    );
    expect(pub.summary.length).toBeLessThanOrEqual(TALENT_LIMITS.summary + 1);
    expect(pub.summary.endsWith("…")).toBe(true);
  });

  it("caps how many experiences and bullets reach a card", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      entryId: `e${i}`,
      title: `Puesto ${i}`,
      organization: null,
      location: null,
      startDate: null,
      endDate: null,
      isCurrent: false,
      bullets: Array.from({ length: 9 }, (_, b) => ({
        text: `Tarea ${b}`,
        sourceEntryIds: [],
        sourceFields: [],
      })),
    }));
    const { public: pub } = projectTalentProfile(input({ resume: resume({ experience: many }) }));
    expect(pub.experience).toHaveLength(TALENT_LIMITS.experiences);
    expect(pub.experience[0]?.bullets).toHaveLength(TALENT_LIMITS.bulletsPerExperience);
  });
});
