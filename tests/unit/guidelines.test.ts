import { describe, expect, it } from "vitest";
import { getResumeGuidelines } from "@/lib/resume/guidelines";
import { buildResumeGenerationPrompt } from "@/lib/ai/prompts";
import { generateResume } from "@/lib/resume/resume-generator";
import { MemoryStore } from "@/lib/repositories/memory-store";
import type { AIProvider, ResumeGenerationInput } from "@/lib/ai";
import type { ResumeContent } from "@/lib/ai/schemas";

describe("resume guidelines", () => {
  it("loads non-trivial guidelines (from the user-editable file or fallback)", () => {
    // The file content is user-editable, so assert shape/length, not wording.
    const g = getResumeGuidelines();
    expect(typeof g).toBe("string");
    expect(g.trim().length).toBeGreaterThan(50);
  });

  it("injects guidelines into the generation prompt, under the factuality rules", () => {
    const prompt = buildResumeGenerationPrompt({
      careerGoal: "x",
      targetRole: "x",
      experience: [],
      education: [],
      projects: [],
      skills: [],
      guidelines: "MARCA_UNICA_DE_PAUTA",
    });
    expect(prompt).toContain("MARCA_UNICA_DE_PAUTA");
    expect(prompt).toContain("PAUTAS DE ESTILO");
    // The factuality precedence must be stated alongside the guidelines.
    expect(prompt.toLowerCase()).toContain("veracidad");
  });

  it("generateResume passes the guidelines to the provider", async () => {
    const store = new MemoryStore();
    const profile = await store.createResumeProfile("u1", {
      careerGoal: "Asistente",
      targetRole: "Asistente",
    });
    await store.upsertPersonalInformation(profile.id, { firstName: "María", email: "m@e.com" });
    await store.createExperience(profile.id, {
      experienceType: "family_business",
      responsibilities: ["Contestaba llamadas"],
      confirmationStatus: "confirmed",
    });
    await store.createSkill(profile.id, { name: "Atención al cliente", status: "confirmed" });

    let captured: ResumeGenerationInput | null = null;
    const spy: AIProvider = {
      name: "spy",
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
      async generateResumeContent(input): Promise<ResumeContent> {
        captured = input;
        return { professionalSummary: "ok", experience: [], education: [], projects: [], skillGroups: [] };
      },
    };

    await generateResume(store, spy, profile.id);
    expect(captured).not.toBeNull();
    expect(captured!.guidelines).toBeDefined();
    expect(captured!.guidelines!.length).toBeGreaterThan(0);
  });
});
