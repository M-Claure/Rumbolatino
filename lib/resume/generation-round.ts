import type { ResumeStatus } from "@/types";

/**
 * Does a `POST /generate` close an improvement ROUND, or is it finishing one
 * that never finished?
 *
 * PURE: no I/O. Extracted from the route so the rule is testable and stated
 * once, rather than living as an expression nothing can reach.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 * The route decided this from one fact: does a résumé already exist? If yes, the
 * request was an improvement round, so it consumed one of `MAX_RESUME_ITERATIONS`.
 *
 * That conflates two different situations, because a generation saves the résumé
 * several steps before it returns. When a request died after saving — a 504 from
 * an over-running PDF render, a dropped connection, a closed laptop — it left a
 * résumé behind. The person, who had seen an error and no résumé, pressed the
 * button again. That second request found a résumé, concluded the user was
 * asking to improve one, and spent a round on it. Observed in production: a
 * first generation that 504'd left the profile on `iteration=1` with two rounds
 * remaining instead of three, and the model was billed twice.
 *
 * ── The signal ─────────────────────────────────────────────────────────────
 * `status`. The route sets `generating` before the model call and `generated`
 * after everything has succeeded, so a profile still sitting at `generating`
 * means the previous attempt never got to the end. A person deliberately asking
 * for another round always starts from `generated` — they are looking at the
 * résumé when they press the button.
 *
 * ── What it gives up, and why that is the right direction ──────────────────
 * `generating` is only cleared by a SUCCESS, so a profile abandoned mid-generation
 * keeps it indefinitely, and that person's next generation is free. So a failed
 * generation can hand back a round it should not have.
 *
 * That is the correct way round. The alternative — the behaviour this replaces —
 * charges a round for our timeout, which takes something from someone who did
 * nothing wrong and cannot be explained to them. Being occasionally generous
 * after a failure can.
 */
export function countsAsImprovementRound(input: {
  /** A generated résumé already exists for this profile. */
  hasResume: boolean;
  /** The profile's status as read BEFORE this request set it to `generating`. */
  statusBefore: ResumeStatus;
}): boolean {
  return input.hasResume && input.statusBefore !== "generating";
}
