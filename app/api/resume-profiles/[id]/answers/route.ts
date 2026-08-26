import { handleRoute, ok } from "@/lib/http";
import { readJson } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { enforceRateLimit, funnelProviderForBudget } from "@/lib/services/usage-guard";
import { processAnswer } from "@/lib/services/answer-pipeline";
import { AnswerBody } from "@/lib/validation/api-schemas";

export const dynamic = "force-dynamic";
// This route reaches the AI provider, so it needs the same ceiling as the other model-
// touching routes rather than the platform's ~10s default. Capture for the rich
// sections goes to the model (`HybridAIProvider`), and a long answer about a job is
// the slowest of them. `FUNCTION_BUDGET_MS` in `lib/request-deadline.ts` assumes this
// number: the shared deadline hands the model whatever is left of it, so a route that
// silently had a fraction of it was killed by the platform mid-call — a 504 with no
// envelope — while the deadline still believed it had most of a minute. Pinned by
// tests/unit/route-budgets.test.ts.
export const maxDuration = 60;

/**
 * POST /api/resume-profiles/:id/answers
 * Runs the full answer-processing pipeline (spec §9) and returns the updated
 * profile state, the next question, any interpretation to confirm, and newly
 * suggested skills.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const ctx = await getRequestContext(params.id);
    await loadOwnedProfile(ctx.store, params.id, ctx.userId);
    await enforceRateLimit("answer", { userId: ctx.userId });
    const body = AnswerBody.parse(await readJson(request));

    /*
     * Capture DEGRADES instead of blocking. Over budget this is the deterministic
     * provider, so the answer is still saved, the raw wording is still kept verbatim
     * and the funnel still advances — with zero model calls. Refusing here would
     * throw away the words someone just typed over a limit they cannot see.
     */
    const funnelAi = await funnelProviderForBudget({
      funnelAi: ctx.funnelAi,
      userId: ctx.userId,
      resumeProfileId: params.id,
    });

    const result = await processAnswer(
      { store: ctx.store, ai: funnelAi, analytics: ctx.analytics, userId: ctx.userId },
      {
        profileId: params.id,
        questionId: body.questionId,
        section: body.section,
        rawAnswer: body.rawAnswer,
        skipped: body.skipped,
        skillDecisions: body.skillDecisions,
        timeSpentMs: body.timeSpentMs,
        deviceCategory: body.deviceCategory,
        targetEntryId: body.targetEntryId,
        forceNewEntry: body.forceNewEntry,
      },
    );

    return ok({
      state: result.profileState,
      nextQuestion: result.nextQuestion,
      interpretation: result.interpretation,
      suggestedSkills: result.suggestedSkills,
      affectedEntryId: result.affectedEntryId,
    });
  });
}
