import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/repositories/memory-store";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { generateResume } from "@/lib/resume/resume-generator";
import { createResumePdfWriter } from "@/lib/resume/resume-artifacts";
import { isTranslationCurrent, translateResume } from "@/lib/resume/translate-resume";
import { MemoryResumeFileStore, resumePdfPath } from "@/lib/storage/resume-file-store";
import type { PdfGenerator } from "@/lib/resume/pdf-generator";
import type { AIProvider } from "@/lib/ai";
import type { TranslateResumeParams } from "@/lib/ai/provider";

/**
 * "Translate the finished résumé; never re-write it."
 *
 * The invariants under test:
 *  * the translation is the SAME document — every entryId, every source trace and
 *    every structural relationship survives, because a translation the résumé
 *    cannot be traced back to is not source-traced any more;
 *  * proper nouns are never sent to the model, so they cannot come back changed;
 *  * an id the model drops keeps its Spanish text rather than going blank;
 *  * the English PDF is one object that a re-translate overwrites, and it stays in
 *    the user's own folder so the Storage RLS policies still authorize it;
 *  * and a translation knows which résumé version it came from, so improving the
 *    Spanish résumé makes it visibly stale instead of silently wrong.
 */

const USER = "u1";
let store: MemoryStore;
const ai = new MockAIProvider();

beforeEach(() => {
  store = new MemoryStore();
});

async function seedGenerated(): Promise<string> {
  const profile = await store.createResumeProfile(USER, {
    careerGoal: "Vendedora",
    targetRole: "Vendedora",
    interests: ["Fútbol", "Cocina"],
  });
  await store.upsertPersonalInformation(profile.id, {
    firstName: "Ana",
    lastName: "Pérez",
    email: "a@e.com",
    city: "Ciudad de México",
    country: "México",
  });
  await store.createExperience(profile.id, {
    experienceType: "informal_work",
    title: "Encargada de ventas",
    organization: "Panadería La Esperanza",
    responsibilities: ["Vendía pan y atendía a los clientes", "Manejaba la caja"],
    tools: ["caja registradora"],
    peopleServed: "clientes de la tienda",
    startDate: "marzo 2020",
    isCurrent: true,
    confirmationStatus: "confirmed",
  });
  await store.createEducation(profile.id, {
    institution: "Colegio Benito Juárez",
    credential: "Bachillerato",
    confirmationStatus: "confirmed",
  });
  await store.createSkill(profile.id, { name: "Ventas", status: "confirmed" });
  await generateResume(store, ai, profile.id);
  return profile.id;
}

/**
 * The mock provider with `translateResume` swapped out.
 *
 * Delegation rather than object spread: `MockAIProvider`'s methods live on its
 * prototype, so `{ ...ai }` copies none of them and produces something that only
 * looks like an `AIProvider`.
 */
function withTranslator(translate: AIProvider["translateResume"]): AIProvider {
  return Object.assign(Object.create(ai) as AIProvider, { translateResume: translate });
}

/** A translator that uppercases everything, so translated text is unmistakable. */
function shoutingTranslator(): AIProvider & { seen: TranslateResumeParams["items"] } {
  const seen: TranslateResumeParams["items"] = [];
  const provider = withTranslator(async (params) => {
    seen.push(...params.items);
    return { items: params.items.map((i) => ({ id: i.id, text: i.text.toUpperCase() })) };
  });
  return Object.assign(provider, { seen });
}

function fakePdf(): PdfGenerator & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    available: true,
    async generate(html: string) {
      calls.push(html);
      return new TextEncoder().encode(`PDF#${calls.length}`);
    },
  };
}

describe("translateResume", () => {
  it("keeps every entryId and source trace, so the translation is still traceable", async () => {
    const id = await seedGenerated();
    const before = (await store.getLatestGeneratedResume(id))!;

    const { translation } = await translateResume(store, shoutingTranslator(), id, "en");

    expect(translation.experience.map((e) => e.entryId)).toEqual(
      before.experience.map((e) => e.entryId),
    );
    expect(translation.education.map((e) => e.entryId)).toEqual(
      before.education.map((e) => e.entryId),
    );
    const beforeBullets = before.experience.flatMap((e) => e.bullets);
    const afterBullets = translation.experience.flatMap((e) => e.bullets);
    expect(afterBullets).toHaveLength(beforeBullets.length);
    afterBullets.forEach((b, i) => {
      expect(b.sourceEntryIds).toEqual(beforeBullets[i]!.sourceEntryIds);
      expect(b.sourceFields).toEqual(beforeBullets[i]!.sourceFields);
      // ...and the prose really was translated, not merely copied.
      expect(b.text).toBe(beforeBullets[i]!.text.toUpperCase());
    });
    expect(translation.skills.map((g) => g.sourceSkillIds)).toEqual(
      before.skills.map((g) => g.sourceSkillIds),
    );
  });

  /*
   * The safety property that matters most. An employer's name is not translatable
   * text, and the cheapest way to guarantee a model cannot change it is to never
   * show it to the model.
   */
  it("never sends proper nouns to the model, and leaves them byte-identical", async () => {
    const id = await seedGenerated();
    const before = (await store.getLatestGeneratedResume(id))!;
    const provider = shoutingTranslator();

    const { translation } = await translateResume(store, provider, id, "en");

    const sent = provider.seen.map((i) => i.text);
    expect(sent).not.toContain("Panadería La Esperanza");
    expect(sent).not.toContain("Colegio Benito Juárez");
    expect(sent.join(" ")).not.toContain("Ana");

    expect(translation.experience[0]!.organization).toBe(before.experience[0]!.organization);
    expect(translation.education[0]!.institution).toBe(before.education[0]!.institution);
    // The name is not part of the translation at all — it is re-read at render time.
    expect(translation.html).toContain("Ana Pérez");
  });

  it("translates the labels the résumé prints but GeneratedResume does not hold", async () => {
    const id = await seedGenerated();
    const provider = shoutingTranslator();

    const { translation } = await translateResume(store, provider, id, "en");

    expect(translation.headline).toBe("VENDEDORA");
    expect(translation.location).toBe("CIUDAD DE MÉXICO, MÉXICO");
    expect(translation.interests).toEqual(["FÚTBOL", "COCINA"]);
  });

  it("renders English section headings, not Spanish ones", async () => {
    const id = await seedGenerated();
    const { translation } = await translateResume(store, shoutingTranslator(), id, "en");

    expect(translation.html).toContain('<html lang="en">');
    expect(translation.html).toContain("<h2>Experience</h2>");
    expect(translation.html).toContain("<h2>Professional Summary</h2>");
    expect(translation.html).not.toContain("<h2>Experiencia</h2>");
    expect(translation.html).not.toContain("<h2>Resumen profesional</h2>");
    // The ongoing-experience marker follows the document's language.
    expect(translation.html).toContain("Present");
    expect(translation.html).not.toContain("Actualidad");
  });

  /*
   * A partial reply must degrade to a mixed-language résumé, never to a blank one.
   * A missing bullet is a far worse outcome than a Spanish bullet.
   */
  it("keeps the original text for any id the model drops", async () => {
    const id = await seedGenerated();
    const before = (await store.getLatestGeneratedResume(id))!;
    const silent = withTranslator(async () => ({ items: [] }));

    const { translation } = await translateResume(store, silent, id, "en");

    expect(translation.professionalSummary).toBe(before.professionalSummary);
    expect(translation.experience[0]!.bullets[0]!.text).toBe(
      before.experience[0]!.bullets[0]!.text,
    );
    // Still a real, renderable document — just not translated.
    expect(translation.html).toContain("<h2>Experience</h2>");
  });

  it("records the résumé version it came from, and goes stale when that moves", async () => {
    const id = await seedGenerated();
    const resume = (await store.getLatestGeneratedResume(id))!;

    const { translation } = await translateResume(store, shoutingTranslator(), id, "en");
    expect(translation.sourceVersion).toBe(resume.version);
    expect(isTranslationCurrent(translation, resume)).toBe(true);

    // Regenerating the Spanish résumé bumps the version; the translation is now stale.
    await generateResume(store, ai, id);
    const newer = (await store.getLatestGeneratedResume(id))!;
    expect(newer.version).toBeGreaterThan(resume.version);
    const stored = await store.getTranslatedResume(id, "en");
    expect(isTranslationCurrent(stored, newer)).toBe(false);
  });

  it("refuses to 'translate' into the résumé's own language", async () => {
    const id = await seedGenerated();
    await expect(translateResume(store, ai, id, "es")).rejects.toThrow();
  });

  it("refuses when there is no résumé to translate", async () => {
    const profile = await store.createResumeProfile(USER, { careerGoal: "Vendedora" });
    await expect(translateResume(store, ai, profile.id, "en")).rejects.toThrow();
  });

  /*
   * Unlike the proofreader, a failed translation must NOT be swallowed: it is the
   * entire thing the user asked for, and handing back the Spanish résumé labelled
   * as English would be worse than an error they can retry.
   */
  it("propagates a model failure instead of silently returning Spanish", async () => {
    const id = await seedGenerated();
    const broken = withTranslator(async () => {
      throw new Error("model unavailable");
    });
    await expect(translateResume(store, broken, id, "en")).rejects.toThrow("model unavailable");
    expect(await store.getTranslatedResume(id, "en")).toBeNull();
  });
});

describe("the English PDF", () => {
  it("is one object in the user's own folder, and a re-translate replaces it", async () => {
    const id = await seedGenerated();
    const files = new MemoryResumeFileStore();
    const pdf = fakePdf();
    const artifacts = createResumePdfWriter({ userId: USER, store, pdf, files });

    const first = await translateResume(store, shoutingTranslator(), id, "en", artifacts);
    const expected = `${USER}/${id}/curriculum-en.pdf`;
    expect(first.translation.pdfPath).toBe(expected);
    // The user id must stay the FIRST segment — 0006's Storage RLS authorizes on it.
    expect(expected.split("/")[0]).toBe(USER);
    expect(resumePdfPath({ userId: USER, profileId: id, lang: "en" })).toBe(expected);

    await translateResume(store, shoutingTranslator(), id, "en", artifacts);
    expect(pdf.calls).toHaveLength(2); // rendered twice...
    expect(files.size).toBe(1); // ...into one object
  });

  it("does not collide with the Spanish PDFs of any round", async () => {
    const paths = new Set([
      resumePdfPath({ userId: USER, profileId: "p1", stage: 0 }),
      resumePdfPath({ userId: USER, profileId: "p1", stage: 1 }),
      resumePdfPath({ userId: USER, profileId: "p1", stage: 2 }),
      resumePdfPath({ userId: USER, profileId: "p1", stage: 3 }),
      resumePdfPath({ userId: USER, profileId: "p1", lang: "en" }),
    ]);
    expect(paths.size).toBe(5);
  });

  /*
   * A translation mirrors the CURRENT résumé and keeps no per-round history, so
   * `stage` must not create a second English object.
   */
  it("ignores stage, so a profile holds exactly one English PDF", () => {
    expect(resumePdfPath({ userId: USER, profileId: "p1", stage: 3, lang: "en" })).toBe(
      resumePdfPath({ userId: USER, profileId: "p1", stage: 0, lang: "en" }),
    );
  });

  it("losing the PDF never costs the user their translation", async () => {
    const id = await seedGenerated();
    const files = new MemoryResumeFileStore();
    const broken: PdfGenerator = {
      available: true,
      async generate() {
        throw new Error("chromium exploded");
      },
    };
    const artifacts = createResumePdfWriter({ userId: USER, store, pdf: broken, files });

    const { translation } = await translateResume(store, shoutingTranslator(), id, "en", artifacts);

    expect(translation.pdfPath).toBeNull();
    expect(translation.html).toContain("<h2>Experience</h2>");
    expect(await store.getTranslatedResume(id, "en")).not.toBeNull();
  });
});
