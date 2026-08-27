import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/repositories/memory-store";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { generateResume } from "@/lib/resume/resume-generator";
import { isAppError } from "@/lib/errors";
import type { AIProvider } from "@/lib/ai";
import type { ResumeContent } from "@/lib/ai/schemas";

let store: MemoryStore;

async function seedReadyProfile() {
  const profile = await store.createResumeProfile("user-1", {
    careerGoal: "Asistente administrativa",
    targetRole: "Asistente administrativa",
  });
  await store.upsertPersonalInformation(profile.id, {
    firstName: "María",
    lastName: "García",
    email: "maria@example.com",
    city: "Lima",
  });
  const exp = await store.createExperience(profile.id, {
    experienceType: "family_business",
    organization: "Negocio familiar",
    responsibilities: ["Contestaba llamadas de clientes", "Organizaba las citas"],
    confirmationStatus: "confirmed",
  });
  await store.createEducation(profile.id, {
    institution: "Instituto Local",
    credential: "Secundaria",
    endDate: "2018",
    confirmationStatus: "confirmed",
  });
  // One confirmed, one rejected, one still-suggested skill.
  const confirmed = await store.createSkill(profile.id, {
    name: "Atención al cliente",
    category: "Servicio al cliente",
    status: "confirmed",
  });
  await store.createSkill(profile.id, { name: "Rechazada", status: "rejected" });
  await store.createSkill(profile.id, { name: "Sugerida", status: "suggested" });
  return { profileId: profile.id, expId: exp.id, confirmedSkill: confirmed };
}

beforeEach(() => {
  store = new MemoryStore();
});

describe("generateResume — only confirmed information", () => {
  it("generates a resume and includes only confirmed skills", async () => {
    const { profileId } = await seedReadyProfile();
    const { resume, renderModel } = await generateResume(store, new MockAIProvider(), profileId);

    expect(resume.professionalSummary.length).toBeGreaterThan(0);
    const skillNames = resume.skills.flatMap((g) => g.skills);
    expect(skillNames).toContain("Atención al cliente");
    expect(skillNames).not.toContain("Rechazada");
    expect(skillNames).not.toContain("Sugerida");

    // HTML contains the person's name and a section heading.
    expect(renderModel.fullName).toBe("María García");
    expect(resume.html).toContain("María García");
    expect(resume.html.toLowerCase()).toContain("experiencia");
  });

  it("traces every generated bullet to a real confirmed entry", async () => {
    const { profileId, expId } = await seedReadyProfile();
    const { resume } = await generateResume(store, new MockAIProvider(), profileId);
    const knownIds = new Set(resume.experience.map((e) => e.entryId));
    for (const block of resume.experience) {
      for (const bullet of block.bullets) {
        expect(bullet.sourceEntryIds.length).toBeGreaterThan(0);
        for (const id of bullet.sourceEntryIds) expect(knownIds.has(id)).toBe(true);
      }
    }
    expect(knownIds.has(expId)).toBe(true);
  });

  it("refuses to generate when the profile is not ready", async () => {
    const profile = await store.createResumeProfile("user-1", {});
    try {
      await generateResume(store, new MockAIProvider(), profile.id);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("not_ready");
    }
  });
});

describe("generateResume — experience order and curation", () => {
  /** Seeds a ready profile with three dated experiences, captured out of order. */
  async function seedThreeExperiences() {
    const { profileId } = await seedReadyProfile();
    const old = await store.createExperience(profileId, {
      experienceType: "informal_work",
      organization: "Tienda del barrio",
      startDate: "2012",
      endDate: "2014",
      responsibilities: ["Atendía la caja"],
      confirmationStatus: "confirmed",
    });
    const current = await store.createExperience(profileId, {
      experienceType: "caregiving",
      organization: "Familia",
      startDate: "2023",
      isCurrent: true,
      responsibilities: ["Cuido a una persona mayor"],
      confirmationStatus: "confirmed",
    });
    const middle = await store.createExperience(profileId, {
      experienceType: "volunteering",
      organization: "Parroquia",
      startDate: "junio de 2018",
      endDate: "marzo de 2021",
      responsibilities: ["Organizaba las donaciones"],
      confirmationStatus: "confirmed",
    });
    return { profileId, oldId: old.id, currentId: current.id, middleId: middle.id };
  }

  /** A provider that returns bullets only for the given entry ids. */
  function selectiveProvider(entryIds: string[]): AIProvider {
    return {
      name: "selective",
      planNextQuestion: () => {
        throw new Error("unused");
      },
      normalizeAnswer: () => {
        throw new Error("unused");
      },
      suggestSkills: async () => [],
      extractInterests: async () => ({ interests: [] }),
      proofreadResume: async () => ({ items: [], notes: [] }),
      translateResume: async () => ({ items: [] }),
      analyzeResume: () => {
        throw new Error("unused");
      },
      async generateResumeContent(): Promise<ResumeContent> {
        return {
          professionalSummary: "Resumen honesto.",
          experience: entryIds.map((id) => ({
            entryId: id,
            bullets: [{ text: "Atendí a clientes con responsabilidad", sourceEntryIds: [id], sourceFields: ["responsibilities"] }],
          })),
          education: [],
          projects: [],
          skillGroups: [],
        };
      },
    };
  }

  it("orders experience newest first, with an ongoing role at the top", async () => {
    const { profileId, oldId, currentId, middleId } = await seedThreeExperiences();
    const { resume } = await generateResume(store, new MockAIProvider(), profileId);

    const ids = resume.experience.map((e) => e.entryId);
    // The undated seed entry has no dates at all, so it sorts last.
    expect(ids.slice(0, 3)).toEqual([currentId, middleId, oldId]);
    // The HTML follows the same order.
    expect(resume.html.indexOf("Familia")).toBeLessThan(resume.html.indexOf("Parroquia"));
    expect(resume.html.indexOf("Parroquia")).toBeLessThan(resume.html.indexOf("Tienda del barrio"));
  });

  it("keeps only the experiences the model selected, in chronological order", async () => {
    const { profileId, oldId, currentId } = await seedThreeExperiences();
    // The model judges the volunteering + the undated entry unrelated to the role.
    const { resume } = await generateResume(store, selectiveProvider([oldId, currentId]), profileId);

    expect(resume.experience.map((e) => e.entryId)).toEqual([currentId, oldId]);
    // Excluded entries are only left off the résumé — the profile still has them.
    expect((await store.listExperience(profileId)).length).toBe(4);
  });

  it("keeps every experience when the model selects none", async () => {
    // A truncated or malformed generation must never erase the whole section.
    const { profileId } = await seedThreeExperiences();
    const { resume } = await generateResume(store, selectiveProvider([]), profileId);

    expect(resume.experience.length).toBe(4);
    expect(resume.html.toLowerCase()).toContain("experiencia");
  });
});

describe("generateResume — never surfaces invented facts", () => {
  it("drops content tied to entries that do not exist / are not confirmed", async () => {
    const { profileId, expId } = await seedReadyProfile();

    // A rogue provider that invents an experience block + bad source ids.
    const rogue: AIProvider = {
      name: "rogue",
      planNextQuestion: () => {
        throw new Error("unused");
      },
      normalizeAnswer: () => {
        throw new Error("unused");
      },
      suggestSkills: async () => [],
      extractInterests: async () => ({ interests: [] }),
      proofreadResume: async () => ({ items: [], notes: [] }),
      translateResume: async () => ({ items: [] }),
      analyzeResume: () => {
        throw new Error("unused");
      },
      async generateResumeContent(): Promise<ResumeContent> {
        return {
          professionalSummary: "Resumen honesto.",
          experience: [
            // Block for a non-existent entry — must NOT appear in the output.
            { entryId: "fake-entry", bullets: [{ text: "Dirigí una empresa Fortune 500", sourceEntryIds: ["fake-entry"], sourceFields: ["invented"] }] },
            // Real entry, but a bullet citing a bogus source id → re-traced to the real entry.
            { entryId: expId, bullets: [{ text: "Atendía a clientes", sourceEntryIds: ["ghost"], sourceFields: ["responsibilities"] }] },
          ],
          education: [],
          projects: [],
          skillGroups: [],
        };
      },
    };

    const { resume } = await generateResume(store, rogue, profileId);
    const entryIds = resume.experience.map((e) => e.entryId);
    expect(entryIds).not.toContain("fake-entry"); // invented entry dropped
    expect(entryIds).toContain(expId);

    const allBullets = resume.experience.flatMap((e) => e.bullets);
    expect(allBullets.some((b) => b.text.includes("Fortune 500"))).toBe(false);
    // The surviving bullet is re-traced to the real entry, never the ghost id.
    for (const b of allBullets) expect(b.sourceEntryIds).not.toContain("ghost");
  });
});
