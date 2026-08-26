import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/repositories/memory-store";
import { MockAIProvider } from "@/lib/ai/mock-provider";
import { assembleProfileState } from "@/lib/profile-state";
import { parseLocationAnswer } from "@/lib/personal-contact";
import { stepInstruction } from "@/components/instructions";
import { AdaptiveQuestionSchema } from "@/lib/ai/schemas";

const ai = new MockAIProvider();

async function stateWithName() {
  const store = new MemoryStore();
  const profile = await store.createResumeProfile("u1", {});
  await store.upsertPersonalInformation(profile.id, {
    firstName: "Ana",
    lastName: "Ruiz",
    email: "ana@example.com",
  });
  return assembleProfileState(store, profile.id);
}

describe("parseLocationAnswer", () => {
  it("buckets by comma, keeping every part", () => {
    expect(parseLocationAnswer("Miami")).toEqual({ city: "Miami", state: null, country: null });
    expect(parseLocationAnswer("Miami, Estados Unidos")).toEqual({
      city: "Miami",
      state: null,
      country: "Estados Unidos",
    });
    expect(parseLocationAnswer("Houston, Texas, Estados Unidos")).toEqual({
      city: "Houston",
      state: "Texas",
      country: "Estados Unidos",
    });
  });

  it("survives stray whitespace and empty input", () => {
    expect(parseLocationAnswer("  Lima ,  Perú ")).toEqual({
      city: "Lima",
      state: null,
      country: "Perú",
    });
    expect(parseLocationAnswer("   ")).toEqual({ city: null, state: null, country: null });
  });
});

describe("answering the location question", () => {
  // The reported bug: "Miami" landed in firstName, the location was dropped, and
  // the planner then greeted every later question with "Miami, cuéntame sobre…".
  it("writes the location and never touches the name", async () => {
    const state = await stateWithName();
    const norm = await ai.normalizeAnswer({
      questionId: "personal_location",
      section: "personal_information",
      questionText: "¿En qué ciudad y país vives?",
      rawAnswer: "Miami",
      state,
    });

    expect(norm.updates.personalInformation).toEqual({
      city: "Miami",
      state: null,
      country: null,
    });
    expect(norm.updates.personalInformation).not.toHaveProperty("firstName");
  });

  it("does not turn the location into the greeting on the next question", async () => {
    const state = await stateWithName();
    const decision = await ai.planNextQuestion({
      state,
      candidates: [
        {
          questionId: "experience_formal",
          section: "experience",
          defaultText: "Cuéntame sobre tu empleo formal.",
          inputType: "long_text",
          required: false,
          allowSkip: true,
        },
      ],
      recommendedSection: "experience",
    });
    // Greets with the person's actual name, which the location answer left alone.
    expect(decision.questionText).toBe("Ana, cuéntame sobre tu empleo formal.");
  });
});

describe("the instruction banner", () => {
  const question = (questionId: string) =>
    AdaptiveQuestionSchema.parse({
      questionId,
      section: "personal_information",
      questionText: "…",
      inputType: "short_text",
      required: false,
      allowSkip: true,
      charLimit: 80,
      nextAction: "ask_question",
    });

  it("tells the person what THIS question asks, not what the section covers", () => {
    // All three live in `personal_information`, whose section banner says
    // "Escribe tu nombre y cómo pueden encontrarte" — shown verbatim over the
    // location question, it told people to write their name.
    expect(stepInstruction(question("personal_location")).title).toBe("¿Cuál es tu código postal?");
    expect(stepInstruction(question("personal_name")).title).toBe("¿Cómo te llamas?");
    expect(stepInstruction(question("personal_contact")).title).toBe("¿Cómo te pueden contactar?");
  });

  it("still falls back to the section banner for everything else", () => {
    expect(stepInstruction(question("something_unlisted")).title).toBe("Tus datos");
  });
});
