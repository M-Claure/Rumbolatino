/**
 * The funnel is a SCRIPT, and this file is what makes that claim testable.
 *
 * The bug it was written for: after describing experience 1 and 2, the funnel
 * asked where the person lived and about studies they had already said they did
 * not have, then went back to experience 3 and 4. Nothing was broken in
 * isolation — the completeness ladder hoisted whichever section it recommended,
 * and that recommendation is recomputed after every answer, so the order was an
 * emergent property of two components rather than a decision. See FUNNEL_SCRIPT.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/repositories/memory-store";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { NoopAnalytics } from "@/lib/analytics";
import { processAnswer, type PipelineContext } from "@/lib/services/answer-pipeline";
import { planNextQuestion } from "@/lib/question-engine/adaptive-planner";
import { assembleProfileState } from "@/lib/profile-state";
import {
  FUNNEL_SCRIPT,
  QUESTION_CATALOG,
  getCatalogQuestion,
} from "@/lib/question-engine/question-catalog";
import { FOLLOWUP_DEFS } from "@/lib/resume/resume-analyzer";

let store: MemoryStore;
let ctx: PipelineContext;
let profileId: string;

beforeEach(async () => {
  store = new MemoryStore();
  ctx = { store, ai: new MockAIProvider(), analytics: new NoopAnalytics(), userId: "user-1" };
  profileId = (await store.createResumeProfile("user-1", {})).id;
});

/** What the person types (or skips) at each step, keyed by question id. */
const ANSWERS: Record<string, string | null> = {
  personal_name: "Rosa Martínez",
  personal_contact: "rosa@example.com",
  // A real ZIP, so it resolves through the postal table rather than falling back
  // to free text — this step is why Rumbo Latino keeps the question.
  personal_location: "77002",
  career_goal_target: "Cajera",
  // "No estudié" — the skip that the old funnel kept walking back into.
  education_highest: null,
  experience_type_counts: JSON.stringify({ formal_employment: 2, caregiving: 1 }),
  skills_add: "Puntualidad, orden",
  experience_add: "Atendía la caja y acomodaba la mercancía de la tienda",
};

/**
 * Walks the funnel the way a person does — always answering whatever it just
 * asked — and returns the ids in the order they were shown.
 */
async function walkFunnel(): Promise<string[]> {
  const shown: string[] = [];
  let next = await planNextQuestion(await assembleProfileState(store, profileId), ctx.ai);

  // Generous ceiling: a runaway loop must fail loudly here, not hang the suite.
  for (let step = 0; step < 40; step += 1) {
    shown.push(next.questionId);
    if (next.questionId === "review_summary") return shown;
    if (!(next.questionId in ANSWERS)) throw new Error(`unscripted question: ${next.questionId}`);
    const raw = ANSWERS[next.questionId] ?? null;
    const res = await processAnswer(ctx, {
      profileId,
      questionId: next.questionId,
      section: next.section,
      rawAnswer: raw,
      skipped: raw === null,
    });
    next = res.nextQuestion;
  }
  throw new Error(`funnel did not terminate: ${shown.join(" → ")}`);
}

describe("FUNNEL_SCRIPT — the list itself", () => {
  it("is exactly this, in this order", () => {
    expect([...FUNNEL_SCRIPT]).toEqual([
      "personal_name",
      "personal_contact",
      // Rumbo Latino only: the ZIP feeds the talent directory's proximity search
      // and the city/state printed on the résumé, so it is asked with the other
      // identity questions instead of being left to the improvement loop.
      "personal_location",
      "career_goal_target",
      "career_goal_unknown",
      "education_highest",
      "experience_type_counts",
      "skills_add",
      "experience_add",
      "review_summary",
    ]);
  });

  it("names only questions the catalog actually has", () => {
    const missing = FUNNEL_SCRIPT.filter((id) => !getCatalogQuestion(id));
    expect(missing).toEqual([]);
  });

  it("names each question at most once", () => {
    expect(new Set(FUNNEL_SCRIPT).size).toBe(FUNNEL_SCRIPT.length);
  });

  it("keeps the catalog entries the improvement loop still answers through", () => {
    // These left the funnel; they did not leave the product. `FOLLOWUP_DEFS` and
    // the entry deep-dives route them through the same pipeline, and both need
    // the catalog's text, inputType and charLimit.
    for (const id of ["experience_scope", "experience_results", "education_details", "skills_confirm"]) {
      expect(QUESTION_CATALOG.some((q) => q.id === id)).toBe(true);
      expect(FUNNEL_SCRIPT).not.toContain(id);
    }
  });

  it("hands the four optional sections to the improvement loop, not the funnel", () => {
    // The funnel ends at the experience loop. These are asked afterwards, and
    // only when the analyzer judges the résumé short of them — so each one must
    // be a follow-up the loop actually knows how to ask.
    for (const id of ["certifications_any", "languages_any", "projects_any", "achievements_any"]) {
      expect(FUNNEL_SCRIPT).not.toContain(id);
      expect(FOLLOWUP_DEFS[id]).toBeDefined();
      expect(QUESTION_CATALOG.some((q) => q.id === id)).toBe(true);
    }
  });
});

describe("the funnel a person actually walks", () => {
  it("asks the script in order and ends on review", async () => {
    expect(await walkFunnel()).toEqual([
      "personal_name",
      "personal_contact",
      "personal_location",
      "career_goal_target",
      "education_highest",
      "experience_type_counts",
      "skills_add",
      // Three experiences were counted, so the describe step runs three times —
      // back to back, with nothing wedged between them.
      "experience_add",
      "experience_add",
      "experience_add",
      // Nothing between the last experience and the review screen.
      "review_summary",
    ]);
  });

  it("never returns to education after the person said they did not study", async () => {
    const shown = await walkFunnel();
    expect(shown.filter((id) => id === "education_highest")).toHaveLength(1);
    expect(shown).not.toContain("education_details");
    expect(shown).not.toContain("education_dates");
  });

  it("never interrupts the experience loop", async () => {
    const shown = await walkFunnel();
    const first = shown.indexOf("experience_add");
    const last = shown.lastIndexOf("experience_add");
    // Everything between the first and last describe step is a describe step.
    expect(shown.slice(first, last + 1).every((id) => id === "experience_add")).toBe(true);
    // The location question is asked — but with identity, never mid-loop, which
    // is where it used to surface.
    expect(shown.indexOf("personal_location")).toBeLessThan(first);
  });

  it("is the same walk every time", async () => {
    const once = await walkFunnel();
    // Second run, fresh profile, same answers.
    profileId = (await store.createResumeProfile("user-1", {})).id;
    expect(await walkFunnel()).toEqual(once);
  });
});
