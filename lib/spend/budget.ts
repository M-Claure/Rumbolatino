/**
 * Is there budget left for a paid model call?
 *
 * Rate limits bound how OFTEN someone can ask; this bounds how much the asking is
 * allowed to cost. Both are needed: an attacker who stays under every request
 * limit can still spend real money, and the expensive calls are expensive per
 * call, not in aggregate.
 *
 * Three ceilings, each answering a different failure:
 *   - per résumé  — one profile in a runaway edit-and-regenerate loop;
 *   - per user    — one identity spreading the same spend across several résumés;
 *   - per day     — many identities at once, which is what "no login" makes cheap
 *                   and what neither of the other two can see.
 *
 * Pure module: no I/O, no env, no `server-only`. The caps arrive as an argument so
 * every decision below is testable with plain numbers.
 */

/** Which paid operation is being attempted. */
export type PaidOperation =
  | "generate"
  | "analyze"
  | "proofread"
  | "regenerate_section"
  /**
   * Translating a finished résumé. Deliberately NOT covered by the first-résumé
   * exemption below: the product's promise is the first Spanish PDF, and an English
   * version is an extra. Someone who has burned their whole budget should still be
   * refused this, the way they are refused an improvement.
   */
  | "translate"
  /** Model-assisted capture — interests, enrichment. Degrades rather than blocks. */
  | "assist";

export interface SpendCaps {
  readonly profileUsd: number;
  readonly userUsd: number;
  readonly dailyUsd: number;
}

/** What has been spent so far, from `ai_spend_state()`. */
export interface SpendState {
  readonly profileUsd: number;
  readonly userUsd: number;
  readonly globalDayUsd: number;
}

export type BudgetVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Which ceiling was hit — for the log line, never for the user. */
      readonly cap: "profile" | "user" | "daily";
      readonly spentUsd: number;
      readonly capUsd: number;
    };

/**
 * Decide whether a paid operation may run.
 *
 * `isFirstResume` is the one exemption, and it exists because a tight per-résumé
 * cap otherwise fails in the worst possible direction: refusing to produce the
 * résumé at all is worse for the person than refusing to *improve* it, and the
 * whole product is the first PDF. So the per-résumé and per-user ceilings do not
 * apply to the generation that has no predecessor.
 *
 * The DAILY ceiling has no exemption. It is the only one that sees a distributed
 * flood of fresh guest identities — where every request is somebody's "first" —
 * so exempting first generations there would exempt the attack.
 */
export function checkBudget(input: {
  operation: PaidOperation;
  state: SpendState;
  caps: SpendCaps;
  /** True when this profile has no generated résumé yet. */
  isFirstResume: boolean;
}): BudgetVerdict {
  const { state, caps } = input;

  if (state.globalDayUsd >= caps.dailyUsd) {
    return { allowed: false, cap: "daily", spentUsd: state.globalDayUsd, capUsd: caps.dailyUsd };
  }

  // Never refuse someone the résumé they came for.
  if (input.isFirstResume && input.operation === "generate") return { allowed: true };

  if (state.profileUsd >= caps.profileUsd) {
    return { allowed: false, cap: "profile", spentUsd: state.profileUsd, capUsd: caps.profileUsd };
  }
  if (state.userUsd >= caps.userUsd) {
    return { allowed: false, cap: "user", spentUsd: state.userUsd, capUsd: caps.userUsd };
  }
  return { allowed: true };
}

/**
 * One line for the server log when a call is refused.
 *
 * Deliberately separate from the user-facing message: the person is told to come
 * back later (`Errors.budgetExhausted`), while the operator needs the numbers and
 * which ceiling to raise. Amounts are money, so they are never sent to the client.
 */
export function describeRefusal(operation: PaidOperation, verdict: BudgetVerdict): string {
  if (verdict.allowed) return `${operation}: allowed`;
  const spent = verdict.spentUsd.toFixed(4);
  const cap = verdict.capUsd.toFixed(2);
  const which = {
    profile: "AI_SPEND_CAP_PROFILE_USD",
    user: "AI_SPEND_CAP_USER_USD",
    daily: "AI_SPEND_CAP_DAILY_USD",
  }[verdict.cap];
  return `${operation} refused: ${verdict.cap} spend $${spent} reached cap $${cap} (${which})`;
}
