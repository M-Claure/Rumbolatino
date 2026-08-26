import { describe, expect, it, vi } from "vitest";
import { buildCandidates } from "@/lib/question-engine/question-prioritizer";
import { QUESTION_CATALOG, getCatalogQuestion } from "@/lib/question-engine/question-catalog";
import { planNextQuestion } from "@/lib/question-engine/adaptive-planner";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import type { ResumeProfileState } from "@/types";
import { completenessInput, educationState, experienceState, personalState, profileState, readyProfile, skillState } from "../helpers/factories";

function state(overrides = {}): ResumeProfileState {
  return profileState(overrides);
}

const provider = new MockAIProvider();
const ids = (s: ResumeProfileState) => buildCandidates(s).map((c) => c.questionId);

/*
 * Identity fully captured — name, contact AND postal code.
 *
 * `personal_location` is part of the script in this product (the ZIP feeds the
 * talent directory's proximity search), so a fixture that stops at name + email
 * is still standing on the identity questions and every "what comes next?"
 * assertion below would just be re-asserting that.
 */
const identified = (o: Parameters<typeof personalState>[0] = {}) =>
  personalState({ hasEmail: true, postalCode: "77002", city: "Houston", state: "TX", ...o });

describe("buildCandidates — ordering & preconditions", () => {
  it("leads with the name for an empty profile", () => {
    expect(ids(state())[0]).toBe("personal_name");
  });

  it("asks education once identity and objective are captured", () => {
    const s = state({
      careerGoal: "Diseñadora",
      personalInformation: identified({ firstName: "Rosa" }),
    });
    const order = ids(s);
    expect(order[0]).toBe("education_highest");
  });

  it("pending skill suggestions do not divert the funnel", () => {
    // Suggestions used to make `recommendedSection` return "skills", which the
    // prioritizer hoisted to the front — one of the ways the order moved
    // mid-funnel. The script decides now, so the next step is unchanged.
    const base = {
      careerGoal: "Vendedor",
      personalInformation: identified({ firstName: "Ana" }),
      education: [educationState({ institution: "Colegio", credential: "Secundaria" })],
    };
    const withoutSuggestions = ids(state(base));
    const withSuggestions = ids(
      state({ ...base, suggestedSkills: [skillState({ name: "Ventas", status: "suggested" })] }),
    );
    expect(withSuggestions).toEqual(withoutSuggestions);
    expect(withSuggestions[0]).toBe("experience_type_counts");
  });
});

describe("buildCandidates — no repeats (spec §7)", () => {
  it("does not re-offer an answered, non-repeatable question", () => {
    const s = state({
      careerGoal: "Diseñadora",
      answeredQuestionIds: ["career_goal_target"],
    });
    expect(ids(s)).not.toContain("career_goal_target");
  });

  it("still offers a repeatable question after it was answered", () => {
    // experience_add repeats to describe each experience. One is described,
    // another is still empty (e.g. created by the type-counts step), so the
    // describe step must reappear even though it was already answered once.
    const s = state({
      careerGoal: "Diseñadora",
      personalInformation: personalState({ firstName: "Rosa", hasEmail: true }),
      education: [educationState({ institution: "Instituto", credential: "Técnico" })],
      experience: [
        experienceState({ responsibilities: ["Diseñaba folletos"] }),
        experienceState({ responsibilities: [] }),
      ],
      answeredQuestionIds: ["experience_add"],
    });
    expect(ids(s)).toContain("experience_add");
  });
});

describe("buildCandidates — skip behavior (spec §7)", () => {
  it("does not immediately re-ask a skipped optional question", () => {
    const s = state({
      careerGoal: "Diseñadora",
      personalInformation: personalState({ firstName: "Rosa", hasEmail: true }),
      education: [educationState({ institution: "Instituto", credential: "Técnico" })],
      skippedQuestionIds: ["experience_add"],
    });
    expect(ids(s)).not.toContain("experience_add");
  });

  it("re-asks a skipped CRITICAL question while the profile is not ready", () => {
    // career goal is critical; skipping it must not permanently remove it.
    const s = state({ skippedQuestionIds: ["career_goal_target"] });
    expect(ids(s)).toContain("career_goal_target");
  });
});

describe("experience questions are never skippable", () => {
  it("no experience catalog question offers a skip", () => {
    const skippable = QUESTION_CATALOG.filter((q) => q.section === "experience" && q.allowSkip);
    expect(skippable.map((q) => q.id)).toEqual([]);
  });

  it("still allows skipping questions outside the experience section", () => {
    // Guards against a blanket allowSkip:false sweep — optional sections keep it.
    expect(getCatalogQuestion("certifications_any")?.allowSkip).toBe(true);
    expect(getCatalogQuestion("personal_location")?.allowSkip).toBe(true);
  });

  it("planNextQuestion reports allowSkip:false for the counter step", async () => {
    const s = state({
      careerGoal: "Recepcionista",
      personalInformation: identified({ firstName: "Rosa" }),
      education: [educationState({ institution: "Instituto", credential: "Técnico" })],
    });
    const q = await planNextQuestion(s, provider);
    expect(q.section).toBe("experience");
    expect(q.allowSkip).toBe(false);
  });

  it("stops asking about experience once the person answered the counter with none", () => {
    // "Todo en 0" is the escape hatch that replaces the missing skip button; the
    // describe question must not then trap them on an experience they don't have.
    const s = state({
      careerGoal: "Recepcionista",
      personalInformation: personalState({ firstName: "Rosa", hasEmail: true }),
      education: [educationState({ institution: "Instituto", credential: "Técnico" })],
      experience: [],
      answeredQuestionIds: ["experience_type_counts"],
    });
    const order = ids(s);
    expect(order).not.toContain("experience_add");
    expect(order).not.toContain("experience_type_counts");
    expect(order.length).toBeGreaterThan(0); // the funnel still has somewhere to go
  });

  it("keeps offering the describe step while an entry is still undescribed", () => {
    const s = state({
      careerGoal: "Recepcionista",
      personalInformation: personalState({ firstName: "Rosa", hasEmail: true }),
      experience: [experienceState({ responsibilities: [], rawDescription: null })],
      answeredQuestionIds: ["experience_type_counts"],
    });
    expect(ids(s)).toContain("experience_add");
  });
});

describe("buildCandidates — the tail of the script", () => {
  it("ends a ready profile at review, with no optional questions appended", () => {
    // Readiness reorders nothing — this is simply what is left of the script.
    // Certificates, languages, projects and achievements are the improvement
    // loop's job now, so the funnel has nothing to add after the experiences.
    const order = ids(state(readyProfile()));
    expect(order).toEqual(["skills_add", "review_summary"]);
  });

  it("does not offer review before the profile is ready", () => {
    expect(ids(state())).not.toContain("review_summary");
  });
});

describe("planNextQuestion — end to end with mock provider", () => {
  it("returns a valid AdaptiveQuestion for an empty profile", async () => {
    const q = await planNextQuestion(state(), provider);
    expect(q.questionId).toBe("personal_name");
    expect(q.section).toBe("personal_information");
    expect(q.required).toBe(true);
    expect(q.nextAction).toBe("ask_question");
  });

  it("ignores a provider that answers about a different question", async () => {
    // The provider only rewords; the question is already decided. A decision
    // naming another id is discarded rather than followed.
    const rogue = new MockAIProvider();
    vi.spyOn(rogue, "planNextQuestion").mockResolvedValue({
      questionId: "achievements_any",
      section: "achievements",
      questionText: "¿Tienes algún logro?",
      contextUsed: [],
      nextAction: "ask_question",
    });
    const q = await planNextQuestion(state(), rogue);
    expect(q.questionId).toBe("personal_name");
    // Falling back to the catalog wording, not the text written for another question.
    expect(q.questionText).toBe("¿Cuál es tu nombre completo?");
  });
});
