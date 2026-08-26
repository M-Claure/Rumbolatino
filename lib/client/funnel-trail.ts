/**
 * The funnel's client-side navigation: a TRAIL with a cursor.
 *
 * PURE — no React, no fetch. Extracted from the funnel page because every
 * navigation bug the funnel has had lived in this logic and none of it was
 * reachable from a test while it sat inside a component.
 *
 * ## Why a trail and not a stack
 * `steps` is every question the person has been shown, in the order they were
 * shown; `cursor` is where they are standing. Back is `cursor − 1`, forward is
 * `cursor + 1`, and nothing else moves it.
 *
 * The previous version was a stack that going back POPPED, which threw away the
 * rest of the walk. The next "Continuar" therefore had nowhere to go but the
 * SERVER's next question — and the server answers from the profile as it stands,
 * where every experience is already described. Backing from experience 4 to
 * experience 1 and pressing Continuar jumped straight back to 4, skipping 2 and
 * 3. Keeping the walk is what makes forward mean "the next question I was
 * actually asked" instead of "whatever is still outstanding".
 *
 * The server's plan is still what EXTENDS the trail — it is simply consulted at
 * the end of the walk rather than in the middle of it. So a question that a
 * re-answer newly opens is not lost; it is asked once the person reaches the
 * point where it is genuinely next.
 */
import type { AdaptiveQuestion } from "@/lib/ai/schemas";

/** What a step last sent. Restored into the field when the person comes back. */
export interface AnswerSent {
  answer: string | null;
  skipped: boolean;
}

/** One position in the walk. */
export interface TrailStep {
  question: AdaptiveQuestion;
  /**
   * The education/experience entry this step created, once it has one. Sent back
   * as `targetEntryId` on a re-answer, so re-answering experience 1 OVERWRITES
   * experience 1 rather than being adopted by whichever entry is still
   * undescribed (which, mid-walk, is a later one).
   */
  entryId: string | null;
  /** null until this step has been answered or skipped at least once. */
  sent: AnswerSent | null;
}

export interface FunnelTrail {
  steps: TrailStep[];
  cursor: number;
}

/** What the server returns after an answer, as far as the trail cares. */
export interface AnswerOutcome {
  affectedEntryId: string | null;
  nextQuestion: AdaptiveQuestion;
}

export const EMPTY_TRAIL: FunnelTrail = { steps: [], cursor: 0 };

/** A fresh walk, standing on its first question. */
export function startTrail(question: AdaptiveQuestion): FunnelTrail {
  return { steps: [{ question, entryId: null, sent: null }], cursor: 0 };
}

export function currentStep(trail: FunnelTrail): TrailStep | null {
  return trail.steps[trail.cursor] ?? null;
}

/** True while there is a question behind this one to go back to. */
export function canGoBack(trail: FunnelTrail): boolean {
  return trail.cursor > 0;
}

/** One step back. Nothing is discarded, so forward stays linear. */
export function stepBack(trail: FunnelTrail): FunnelTrail {
  return canGoBack(trail) ? { ...trail, cursor: trail.cursor - 1 } : trail;
}

/**
 * True when this answer is byte-for-byte what the step already sent AND there is
 * a walked step ahead to move into.
 *
 * Walking back to re-read an answer and pressing Continuar again must not cost
 * anything: the answer is already saved, and re-sending it would spend a model
 * call rewriting the same entry with the same words and log a second attempt at
 * a question nobody actually redid.
 */
export function canAdvanceWithoutSending(trail: FunnelTrail, sent: AnswerSent): boolean {
  const step = currentStep(trail);
  if (!step?.sent) return false;
  if (trail.cursor >= trail.steps.length - 1) return false; // nothing walked ahead
  return step.sent.skipped === sent.skipped && step.sent.answer === sent.answer;
}

/**
 * Record what this step sent and move to the next one.
 *
 * `outcome` is the server's reply, or null when the answer was unchanged and
 * nothing was sent. At the END of the walk the outcome's `nextQuestion` is what
 * extends the trail; anywhere else the next step is the one already walked, and
 * the server's plan is deliberately ignored — that is what keeps the walk
 * linear.
 */
export function recordAnswer(
  trail: FunnelTrail,
  sent: AnswerSent,
  outcome: AnswerOutcome | null,
): FunnelTrail {
  const step = currentStep(trail);
  if (!step) return trail;

  const steps = [...trail.steps];
  steps[trail.cursor] = {
    ...step,
    sent,
    // A re-answer returns the same id (we passed it as targetEntryId); a first
    // answer is what names it. Never cleared — a follow-up answer that touches
    // no entry must not unbind the step from the one it created.
    entryId: outcome?.affectedEntryId ?? step.entryId,
  };

  const atEnd = trail.cursor === steps.length - 1;
  if (atEnd) {
    // Without an outcome there is nothing to extend the walk with, so stay put
    // rather than stepping off the end. `canAdvanceWithoutSending` already
    // refuses this case; this is the belt to its braces.
    if (!outcome) return { steps, cursor: trail.cursor };
    steps.push({ question: outcome.nextQuestion, entryId: null, sent: null });
  }
  return { steps, cursor: trail.cursor + 1 };
}
