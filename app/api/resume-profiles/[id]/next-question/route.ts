import { handleRoute, ok } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { assembleProfileState } from "@/lib/profile-state";
import { planNextQuestion } from "@/lib/question-engine/adaptive-planner";
import { recordQuestionShown } from "@/lib/services/funnel-telemetry";

export const dynamic = "force-dynamic";
// This route reaches the AI provider, so it needs the same ceiling as the other model-
// touching routes rather than the platform's ~10s default. Plans the next question;
// deterministic today, but it runs through the same provider seam.
// `FUNCTION_BUDGET_MS` in `lib/request-deadline.ts` assumes this number: the shared
// deadline hands the model whatever is left of it, so a route that silently had a
// fraction of it was killed by the platform mid-call — a 504 with no envelope — while
// the deadline still believed it had most of a minute. Pinned by tests/unit/route-
// budgets.test.ts.
export const maxDuration = 60;

/** GET /api/resume-profiles/:id/next-question — the most useful next question. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const ctx = await getRequestContext();
    await loadOwnedProfile(ctx.store, params.id, ctx.userId);
    const state = await assembleProfileState(ctx.store, params.id);
    // Next-question planning is deterministic — no paid-model call per step.
    const nextQuestion = await planNextQuestion(state, ctx.funnelAi);
    await recordQuestionShown(ctx, params.id, nextQuestion);
    return ok({ nextQuestion, state });
  });
}
