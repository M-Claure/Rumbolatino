/**
 * The hard cap of MAX_EXPERIENCE_ENTRIES experiences, enforced in CODE at every
 * write path — not only in the counter UI's copy.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/repositories/memory-store";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { NoopAnalytics } from "@/lib/analytics";
import {
  MAX_EDUCATION_ENTRIES,
  MAX_EDUCATION_ENTRIES_PER_ANSWER,
  MAX_EXPERIENCE_ENTRIES,
} from "@/lib/config/limits";
import { processAnswer, type PipelineContext } from "@/lib/services/answer-pipeline";
import type { AIProvider } from "@/lib/ai";
import type { AnswerNormalization } from "@/lib/ai/schemas";

let store: MemoryStore;
let ctx: PipelineContext;
let profileId: string;

beforeEach(async () => {
  store = new MemoryStore();
  ctx = { store, ai: new MockAIProvider(), analytics: new NoopAnalytics(), userId: "user-1" };
  const profile = await store.createResumeProfile("user-1", {});
  profileId = profile.id;
});

/** A provider that always asks for `count` brand-new experience entries. */
function greedyProvider(count: number): AIProvider {
  const mock = new MockAIProvider();
  return {
    name: "greedy",
    planNextQuestion: (p) => mock.planNextQuestion(p),
    suggestSkills: () => Promise.resolve([]),
    extractInterests: (p) => mock.extractInterests(p),
    generateResumeContent: (p) => mock.generateResumeContent(p),
    analyzeResume: (p) => mock.analyzeResume(p),
    proofreadResume: (p) => mock.proofreadResume(p),
    translateResume: (p) => mock.translateResume(p),
    async normalizeAnswer(): Promise<AnswerNormalization> {
      return {
        interpretationSummary: "Anoté tus experiencias.",
        needsConfirmation: false,
        suggestedSkills: [],
        updates: {
          experienceEntries: Array.from({ length: count }, (_, i) => ({
            experienceType: "informal_work" as const,
            rawDescription: `Experiencia ${i + 1}`,
            responsibilities: [`Tarea ${i + 1}`],
          })),
        },
      };
    },
  };
}

describe("experience cap — counter step", () => {
  it("creates at most MAX_EXPERIENCE_ENTRIES entries from a counts answer", async () => {
    // Asks for 9 across three types; only the cap's worth may be created.
    await processAnswer(ctx, {
      profileId,
      questionId: "experience_type_counts",
      section: "experience",
      rawAnswer: JSON.stringify({ formal_employment: 3, caregiving: 4, volunteering: 2 }),
    });

    const list = await store.listExperience(profileId);
    expect(list.length).toBe(MAX_EXPERIENCE_ENTRIES);
  });

  it("caps a single type asking for more than the limit", async () => {
    await processAnswer(ctx, {
      profileId,
      questionId: "experience_type_counts",
      section: "experience",
      rawAnswer: JSON.stringify({ caregiving: 20 }),
    });

    expect((await store.listExperience(profileId)).length).toBe(MAX_EXPERIENCE_ENTRIES);
  });

  it("keeps counts under the limit untouched", async () => {
    await processAnswer(ctx, {
      profileId,
      questionId: "experience_type_counts",
      section: "experience",
      rawAnswer: JSON.stringify({ caregiving: 2 }),
    });

    expect((await store.listExperience(profileId)).length).toBe(2);
  });
});

describe("experience cap — the pipeline is the gate, not the provider", () => {
  it("drops the entries that do not fit when the model returns too many", async () => {
    const greedy = greedyProvider(MAX_EXPERIENCE_ENTRIES + 3);
    const result = await processAnswer(
      { ...ctx, ai: greedy },
      { profileId, questionId: "experience_add", section: "experience", rawAnswer: "Varias cosas" },
    );

    const list = await store.listExperience(profileId);
    expect(list.length).toBe(MAX_EXPERIENCE_ENTRIES);
    // The answer still succeeds — what fit was captured, nothing 500s.
    expect(result.interpretation?.summary).toBeTruthy();
    expect(result.affectedEntryId).not.toBeNull();
  });

  it("creates nothing more once the profile is already at the cap", async () => {
    for (let i = 0; i < MAX_EXPERIENCE_ENTRIES; i++) {
      await store.createExperience(profileId, {
        experienceType: "informal_work",
        rawDescription: `Existente ${i + 1}`,
        responsibilities: ["Ya descrita"],
      });
    }

    await processAnswer(
      { ...ctx, ai: greedyProvider(2) },
      { profileId, questionId: "experience_add", section: "experience", rawAnswer: "Una más" },
    );

    const list = await store.listExperience(profileId);
    expect(list.length).toBe(MAX_EXPERIENCE_ENTRIES);
    expect(list.map((x) => x.rawDescription)).not.toContain("Experiencia 1");
  });
});

describe("education cap", () => {
  /** A provider that always asks for `count` brand-new education entries. */
  function greedyEducationProvider(count: number): AIProvider {
    const mock = new MockAIProvider();
    return {
      name: "greedy-education",
      planNextQuestion: (p) => mock.planNextQuestion(p),
      suggestSkills: () => Promise.resolve([]),
      extractInterests: (p) => mock.extractInterests(p),
      generateResumeContent: (p) => mock.generateResumeContent(p),
      analyzeResume: (p) => mock.analyzeResume(p),
      proofreadResume: (p) => mock.proofreadResume(p),
      translateResume: (p) => mock.translateResume(p),
      async normalizeAnswer(): Promise<AnswerNormalization> {
        return {
          interpretationSummary: "Anoté tus estudios.",
          needsConfirmation: false,
          suggestedSkills: [],
          updates: {
            educationEntries: Array.from({ length: count }, (_, i) => ({
              credential: `Estudio ${i + 1}`,
              relevantCoursework: [],
            })),
          },
        };
      },
    };
  }

  it("opens one education slot per answer, with room to add a second by hand", () => {
    // The funnel asks one education question, so one answer must never open a
    // second slot — but a person may still add one on the review screen. Both
    // numbers are pinned: they are the whole mechanism, since `education` is a
    // rich-capture section and the model can split one sentence into several
    // entries.
    expect(MAX_EDUCATION_ENTRIES_PER_ANSWER).toBe(1);
    expect(MAX_EDUCATION_ENTRIES).toBe(2);
  });

  it("creates ONE education entry from one answer, however many the model returns", async () => {
    // The reported bug: "Terminé la secundaria y estudié seis meses de
    // administración" is split by the model into two studies, and both were
    // created — filling the cap from a single question and leaving a second,
    // half-empty card on the review screen.
    await processAnswer(
      { ...ctx, ai: greedyEducationProvider(MAX_EDUCATION_ENTRIES + 3) },
      {
        profileId,
        questionId: "education_highest",
        section: "education",
        rawAnswer: "Secundaria, un curso técnico y otro de computación",
      },
    );

    const list = await store.listEducation(profileId);
    expect(list.length).toBe(MAX_EDUCATION_ENTRIES_PER_ANSWER);
    expect(list.length).toBeLessThan(MAX_EDUCATION_ENTRIES); // room left to add one
    expect(list[0]?.credential).toBe("Estudio 1"); // the first mentioned, not the last
  });

  it("lets a second entry be added by hand, up to the cap", async () => {
    // What "+ Agregar" on the review screen does, and where it stops.
    await processAnswer(ctx, {
      profileId,
      questionId: "education_highest",
      section: "education",
      rawAnswer: "Terminé la secundaria",
    });
    await store.createEducation(profileId, { credential: "Curso de administración" });

    const list = await store.listEducation(profileId);
    expect(list.length).toBe(MAX_EDUCATION_ENTRIES);
    expect(list.map((e) => e.credential)).toEqual(["Terminé la secundaria", "Curso de administración"]);
  });

  it("creates nothing more once the profile is already at the cap", async () => {
    for (let i = 0; i < MAX_EDUCATION_ENTRIES; i++) {
      await store.createEducation(profileId, { credential: `Existente ${i + 1}` });
    }

    await processAnswer(
      { ...ctx, ai: greedyEducationProvider(2) },
      { profileId, questionId: "education_highest", section: "education", rawAnswer: "Otro más" },
    );

    const list = await store.listEducation(profileId);
    expect(list.length).toBe(MAX_EDUCATION_ENTRIES);
    expect(list.map((e) => e.credential)).not.toContain("Estudio 1");
  });

  it("still updates an existing entry instead of creating when at the cap", async () => {
    // education_details targets the most recent entry — capping creation must not
    // break the enrichment path that walks entries already captured. Filled to the
    // cap rather than to a fixed 2, so this keeps testing the same thing whatever
    // MAX_EDUCATION_ENTRIES is.
    let latest = await store.createEducation(profileId, { credential: "Secundaria" });
    for (let i = 1; i < MAX_EDUCATION_ENTRIES; i++) {
      latest = await store.createEducation(profileId, { credential: `Curso ${i}` });
    }

    const res = await processAnswer(ctx, {
      profileId,
      questionId: "education_details",
      section: "education",
      rawAnswer: "Instituto Local. Aprendí computación básica.",
    });

    const list = await store.listEducation(profileId);
    expect(list.length).toBe(MAX_EDUCATION_ENTRIES); // enriched, not appended
    expect(res.affectedEntryId).toBe(latest.id); // the latest entry, not a new one
  });
});

describe("counter step with no experience at all", () => {
  it("accepts an all-zeros answer and moves the funnel on", async () => {
    // With no "Omitir" on experience questions, {} is how someone says "ninguna".
    const res = await processAnswer(ctx, {
      profileId,
      questionId: "experience_type_counts",
      section: "experience",
      rawAnswer: "{}",
    });

    expect((await store.listExperience(profileId)).length).toBe(0);
    // Must not land back on an experience question they cannot answer or skip.
    expect(res.nextQuestion.questionId).not.toBe("experience_type_counts");
    expect(res.nextQuestion.questionId).not.toBe("experience_add");
    expect(res.nextQuestion.questionId).toBeTruthy();
  });
});

describe("experience cap — the funnel stops asking", () => {
  it("does not offer another experience question once the cap is described", async () => {
    await processAnswer(ctx, {
      profileId,
      questionId: "experience_type_counts",
      section: "experience",
      rawAnswer: JSON.stringify({ caregiving: MAX_EXPERIENCE_ENTRIES }),
    });

    let last;
    for (let i = 0; i < MAX_EXPERIENCE_ENTRIES; i++) {
      last = await processAnswer(ctx, {
        profileId,
        questionId: "experience_add",
        section: "experience",
        rawAnswer: `Cuidaba a una persona mayor, turno ${i + 1}. Le daba sus medicamentos.`,
      });
    }

    expect((await store.listExperience(profileId)).length).toBe(MAX_EXPERIENCE_ENTRIES);
    expect(last!.nextQuestion.questionId).not.toBe("experience_add");
    expect(last!.nextQuestion.questionId).not.toBe("experience_type_counts");
  });
});
