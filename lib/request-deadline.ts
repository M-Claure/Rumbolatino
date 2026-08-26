/**
 * How much of this serverless invocation's wall-clock budget is left.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Vercel kills a function at its `maxDuration` and answers **504** — with no JSON
 * body, so the browser shows a bare "Error 504" and no log line of ours explains
 * it. Work already done is lost and tokens already spent are still billed.
 *
 * Bounding each individual step is not enough: the steps share one budget. A
 * model call that finishes inside its own generous allowance can still leave
 * nothing for the Chromium render that follows it, and neither step is at fault
 * on its own. What was missing is a single clock every expensive step can read.
 *
 * ── The cold-start charge ───────────────────────────────────────────────────
 * The platform's clock starts when the runtime begins booting, not when the route
 * handler runs. On a COLD invocation several seconds are already gone by the time
 * anything here executes, which is precisely the case that fails — a first
 * request 504s and the retry, now warm, succeeds. `process.uptime()` is that boot
 * time on the first invocation of a process; on later (warm) invocations the
 * process has outlived many requests and uptime says nothing about this one, so
 * it is charged exactly once.
 *
 * Pure and dependency-free, so route handlers, `getRequestContext` and unit tests
 * can all use it.
 */

/**
 * The ceiling every route that reaches the model or Chromium declares
 * (`export const maxDuration = 60`). 60s is also the Vercel Hobby limit, so this
 * cannot simply be raised — see `docs/` and the route files.
 */
export const FUNCTION_BUDGET_MS = 60_000;

/**
 * Held back from every consumer: serialising the response, the analytics flush,
 * and the platform's own overhead all happen after the last expensive step.
 */
export const RESPONSE_MARGIN_MS = 3_000;

export interface RequestDeadline {
  /** Milliseconds of usable budget left. Never negative. */
  remainingMs(): number;
}

/**
 * True until the first deadline of this process is created. Module state is
 * per-instance, which is exactly the granularity a cold start has.
 */
let coldStart = true;

export function startRequestDeadline(budgetMs: number = FUNCTION_BUDGET_MS): RequestDeadline {
  const bootMs = coldStart ? Math.round(process.uptime() * 1000) : 0;
  coldStart = false;
  const startedAt = Date.now();
  const usable = budgetMs - RESPONSE_MARGIN_MS - bootMs;
  return {
    remainingMs: () => Math.max(0, usable - (Date.now() - startedAt)),
  };
}

/** A deadline that never runs out — for tests and any non-serverless caller. */
export const UNLIMITED_DEADLINE: RequestDeadline = {
  remainingMs: () => Number.POSITIVE_INFINITY,
};

/** Test seam: pretend this process has not served a request yet. */
export function resetColdStartForTests(): void {
  coldStart = true;
}
