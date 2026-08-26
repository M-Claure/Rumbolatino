/**
 * Client-side funnel navigation. The bug this exists for: backing up from
 * experience 4 to experience 1 and pressing Continuar jumped straight back to
 * experience 4, because going back popped the walk and forward then asked the
 * SERVER what was next — and the server answers from the profile as it stands.
 */
import { describe, expect, it } from "vitest";
import {
  canAdvanceWithoutSending,
  canGoBack,
  currentStep,
  recordAnswer,
  startTrail,
  stepBack,
  type FunnelTrail,
} from "@/lib/client/funnel-trail";
import { AdaptiveQuestionSchema, type AdaptiveQuestion } from "@/lib/ai/schemas";

/** A funnel question, minimally. `n` names the experience it is about. */
function describeExperience(n: number): AdaptiveQuestion {
  return AdaptiveQuestionSchema.parse({
    questionId: "experience_add",
    section: "experience",
    questionText: `Experiencia ${n} de 4: cuéntame de qué se trataba.`,
    inputType: "long_text",
    required: false,
    allowSkip: false,
    charLimit: 600,
    nextAction: "ask_question",
  });
}

const answered = (text: string) => ({ answer: text, skipped: false });

/** Walk four describe steps, answering each — what the person did before backing up. */
function walkFourExperiences(): FunnelTrail {
  let trail = startTrail(describeExperience(1));
  for (let n = 1; n <= 3; n += 1) {
    trail = recordAnswer(trail, answered(`respuesta ${n}`), {
      affectedEntryId: `entry-${n}`,
      nextQuestion: describeExperience(n + 1),
    });
  }
  return trail;
}

describe("moving through the walk", () => {
  it("stands on the first question and cannot go back from it", () => {
    const trail = startTrail(describeExperience(1));
    expect(currentStep(trail)?.question.questionText).toContain("1 de 4");
    expect(canGoBack(trail)).toBe(false);
    expect(stepBack(trail)).toEqual(trail);
  });

  it("appends the server's next question at the end of the walk", () => {
    const trail = walkFourExperiences();
    expect(trail.steps).toHaveLength(4);
    expect(trail.cursor).toBe(3);
    expect(currentStep(trail)?.question.questionText).toContain("4 de 4");
  });

  it("goes back ONE step at a time, keeping the rest of the walk", () => {
    let trail = walkFourExperiences();
    trail = stepBack(stepBack(stepBack(trail)));
    expect(trail.cursor).toBe(0);
    expect(trail.steps).toHaveLength(4); // nothing discarded
    expect(currentStep(trail)?.question.questionText).toContain("1 de 4");
  });

  it("goes forward ONE step at a time after backing up, never skipping ahead", () => {
    // The regression. From experience 1, three Continuars must land on 2, 3, 4 —
    // and the server's plan (experience 4, the only one still undescribed) is
    // ignored while there is walked trail ahead.
    let trail = stepBack(stepBack(stepBack(walkFourExperiences())));
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      trail = recordAnswer(trail, answered("corregido"), {
        affectedEntryId: null,
        nextQuestion: describeExperience(4),
      });
      seen.push(currentStep(trail)!.question.questionText);
    }
    expect(seen).toEqual([
      expect.stringContaining("2 de 4"),
      expect.stringContaining("3 de 4"),
      expect.stringContaining("4 de 4"),
    ]);
    expect(trail.steps).toHaveLength(4); // still the same four
  });
});

describe("what a step remembers", () => {
  it("restores exactly what was typed at that step", () => {
    const trail = stepBack(stepBack(stepBack(walkFourExperiences())));
    expect(currentStep(trail)?.sent?.answer).toBe("respuesta 1");
    // ...and the answer for the step in front of it is its own, not this one's.
    expect(stepBack(trail).steps[1]?.sent?.answer).toBe("respuesta 2");
  });

  it("leaves a step that has never been answered empty", () => {
    const trail = walkFourExperiences();
    // Experience 4 was appended by the server and not yet answered.
    expect(currentStep(trail)?.sent).toBeNull();
  });

  it("binds each step to the entry it created, so a re-answer overwrites it", () => {
    const trail = stepBack(stepBack(stepBack(walkFourExperiences())));
    expect(currentStep(trail)?.entryId).toBe("entry-1");
    // Re-answering it must not unbind it, even if the reply names no entry.
    const again = recordAnswer(trail, answered("corregido"), {
      affectedEntryId: null,
      nextQuestion: describeExperience(4),
    });
    expect(again.steps[0]?.entryId).toBe("entry-1");
  });
});

describe("re-sending an unchanged answer", () => {
  it("is skipped when the person only walked back to look", () => {
    const trail = stepBack(walkFourExperiences());
    expect(canAdvanceWithoutSending(trail, answered("respuesta 3"))).toBe(true);
  });

  it("still sends when the answer was edited", () => {
    const trail = stepBack(walkFourExperiences());
    expect(canAdvanceWithoutSending(trail, answered("otra cosa"))).toBe(false);
  });

  it("still sends when a skip replaces an answer, or the reverse", () => {
    const trail = stepBack(walkFourExperiences());
    expect(canAdvanceWithoutSending(trail, { answer: null, skipped: true })).toBe(false);
  });

  it("never skips the send at the end of the walk", () => {
    // There is no walked step ahead to move into, so the server must be asked.
    const trail = walkFourExperiences();
    expect(canAdvanceWithoutSending(trail, answered("lo que sea"))).toBe(false);
    // And a no-outcome record there must not step off the end.
    const stuck = recordAnswer(trail, answered("x"), null);
    expect(stuck.cursor).toBe(trail.cursor);
    expect(stuck.steps).toHaveLength(4);
  });
});
