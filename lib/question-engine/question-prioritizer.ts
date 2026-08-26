/**
 * Deterministic question selection (spec §7).
 *
 * The funnel walks `FUNNEL_SCRIPT` (`./question-catalog.ts`) in order and asks the
 * first step that is still eligible. Nothing reorders it: not the completeness
 * ladder, not the model, not a per-question priority number. Two people who give
 * the same answers are asked the same questions in the same order.
 *
 * What this module still decides is ELIGIBILITY — the rules that let the script
 * skip a step rather than reorder it:
 *   - a question whose precondition is false is not asked (already answered in
 *     substance, or not applicable),
 *   - an answered question is not re-asked unless it is repeatable
 *     (`experience_add` walks one entry per loop),
 *   - a skipped question is not re-asked, unless it is critical for generation
 *     and the profile is still not ready.
 */
import type { ResumeProfileState } from "@/types";
import type { QuestionCandidate } from "@/lib/ai/provider";
import { FUNNEL_SCRIPT, getCatalogQuestion, type CatalogQuestion } from "./question-catalog";

const MAX_CANDIDATES = 6;

export function buildCandidates(state: ResumeProfileState): QuestionCandidate[] {
  return eligibleQuestions(state)
    .slice(0, MAX_CANDIDATES)
    .map((q) => toCandidate(q, state));
}

/**
 * Every funnel step still outstanding, in script order and NOT truncated to
 * `MAX_CANDIDATES`.
 *
 * `buildCandidates` slices this down to what the planner is shown; the full list
 * is what "how much is left?" has to be measured against, which is why the two
 * are separated (`lib/question-engine/funnel-progress.ts`). Reusing one pool for
 * both is the point: a progress bar computed from a different eligibility rule
 * than the one the funnel actually follows would drift from what the user is
 * asked.
 *
 * The head of this list is the next question. `adaptive-planner.ts` takes it
 * without asking the model which one to use.
 */
export function eligibleQuestions(state: ResumeProfileState): CatalogQuestion[] {
  const answered = new Set(state.answeredQuestionIds);
  const skipped = new Set(state.skippedQuestionIds);
  const ready = state.completeness.readyToGenerate;

  const out: CatalogQuestion[] = [];
  for (const id of FUNNEL_SCRIPT) {
    const q = getCatalogQuestion(id);
    // A script id with no catalog entry is a bug, pinned by tests/unit/funnel-script.test.ts.
    if (!q) continue;
    if (!q.precondition(state)) continue;
    if (answered.has(q.id) && !q.repeatable) continue;
    if (skipped.has(q.id)) {
      // Skipped questions come back only if critical AND still blocking readiness.
      const revisit = q.criticalForGeneration === true && !ready;
      if (!revisit) continue;
    }
    out.push(q);
  }
  return out;
}

function toCandidate(q: CatalogQuestion, state: ResumeProfileState): QuestionCandidate {
  return {
    questionId: q.id,
    section: q.section,
    // Catalog text may be a function of state (e.g. "tu voluntariado 2 de 3").
    defaultText: typeof q.text === "function" ? q.text(state) : q.text,
    inputType: q.inputType,
    required: q.required,
    allowSkip: q.allowSkip,
    options: q.options,
    intent: q.intent,
  };
}
