/**
 * Question planner (spec §6 Layer 2, §8).
 *
 * WHICH question comes next is not a decision made here, and not one the model
 * makes: it is the head of `eligibleQuestions`, which walks `FUNNEL_SCRIPT` in
 * order. The provider is asked only to REWORD that question — greet the person by
 * name, adapt the phrasing to what they already told us — and even that is
 * discarded unless it came back about the same question.
 *
 * Letting the model pick from the candidate list is what made the funnel wander:
 * the choice was re-made from scratch on every answer, so the order emerged from
 * six ranked options rather than from a script anyone had read.
 *
 * So:
 *   1. build the outstanding steps deterministically,
 *   2. PIN the next question to the first one,
 *   3. ask the provider to personalize its wording (validated PlannerDecision),
 *   4. fill inputType/options/required/allowSkip/nextAction from the CATALOG,
 *      never from the model,
 *   5. return a strict AdaptiveQuestion.
 */
import type { ResumeProfileState } from "@/types";
import type { AIProvider } from "@/lib/ai";
import { AdaptiveQuestionSchema, type AdaptiveQuestion, type NextAction } from "@/lib/ai/schemas";
import { answerCharLimitForQuestion } from "@/lib/answer-limits";
import { buildCandidates } from "./question-prioritizer";
import { getCatalogQuestion } from "./question-catalog";

export async function planNextQuestion(
  state: ResumeProfileState,
  provider: AIProvider,
): Promise<AdaptiveQuestion> {
  const candidates = buildCandidates(state);

  // Nothing left to ask — go straight to review or generation.
  if (candidates.length === 0) {
    return AdaptiveQuestionSchema.parse({
      questionId: "review_summary",
      section: "review",
      questionText: state.completeness.readyToGenerate
        ? "Tienes suficiente información para generar tu currículum. ¿Quieres revisarlo y generarlo?"
        : "Repasemos lo que falta para completar tu currículum.",
      inputType: "review",
      required: false,
      allowSkip: true,
      charLimit: answerCharLimitForQuestion("review_summary"),
      nextAction: state.completeness.readyToGenerate ? "generate_resume" : "review_profile",
    });
  }

  // The next question IS the first outstanding step of the script. The provider
  // never gets to change that.
  const candidate = candidates[0]!;
  const chosenId = candidate.questionId;
  const catalog = getCatalogQuestion(chosenId);

  const decision = await provider.planNextQuestion({
    state,
    candidates,
    recommendedSection: state.completeness.recommendedSection,
  });

  const inputType = catalog?.inputType ?? candidate.inputType;
  const nextAction = deriveNextAction(inputType, candidate.section);

  const suggestedSkills =
    inputType === "skill_confirmation"
      ? state.suggestedSkills.map((s) => ({
          name: s.name,
          category: s.category,
          evidence: s.evidence ?? "",
        }))
      : [];

  return AdaptiveQuestionSchema.parse({
    questionId: chosenId,
    section: candidate.section,
    // Personalized wording is kept only when it is wording for THIS question; a
    // decision about any other one is answering a question we are not asking.
    questionText: decision.questionId === chosenId ? decision.questionText : candidate.defaultText,
    supportingText: decision.supportingText ?? catalog?.supportingText,
    reasonForAsking: decision.reasonForAsking ?? catalog?.intent,
    exampleAnswer: decision.exampleAnswer ?? catalog?.exampleAnswer,
    inputType,
    options: catalog?.options ?? candidate.options,
    required: catalog?.required ?? candidate.required,
    allowSkip: catalog?.allowSkip ?? candidate.allowSkip,
    skipLabel: catalog?.skipLabel,
    // Same rule as inputType: the limit is the catalog's, never the model's.
    charLimit: answerCharLimitForQuestion(chosenId),
    contextUsed: decision.contextUsed,
    suggestedSkills,
    nextAction,
  });
}

function deriveNextAction(inputType: string, section: string): NextAction {
  if (inputType === "skill_confirmation") return "confirm_skills";
  if (section === "review") return "review_profile";
  return "ask_question";
}
