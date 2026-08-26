import { handleRoute, ok } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { assertWithinBudget, enforceRateLimit } from "@/lib/services/usage-guard";
import { analyzeResume } from "@/lib/resume/resume-analyzer";

export const dynamic = "force-dynamic";
// This route reaches the AI provider, so it needs the same ceiling as the other model-
// touching routes rather than the platform's ~10s default. The critique is a
// `reasoning.effort: medium` model call over the whole résumé. `FUNCTION_BUDGET_MS` in
// `lib/request-deadline.ts` assumes this number: the shared deadline hands the model
// whatever is left of it, so a route that silently had a fraction of it was killed by
// the platform mid-call — a 504 with no envelope — while the deadline still believed
// it had most of a minute. Pinned by tests/unit/route-budgets.test.ts.
export const maxDuration = 60;

/**
 * POST /api/resume-profiles/:id/analyze
 * Critiques the latest generated résumé and returns targeted follow-up
 * questions to improve it (the improvement loop).
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, ai } = await getRequestContext(params.id);
    await loadOwnedProfile(store, params.id, userId);
    await enforceRateLimit("analyze", { userId });
    await assertWithinBudget({ operation: "analyze", userId, resumeProfileId: params.id, store });
    const analysis = await analyzeResume(store, ai, params.id);
    return ok({ analysis });
  });
}
