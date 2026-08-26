import { handleRoute, ok, readJson } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { enforceRateLimit, funnelProviderForBudget } from "@/lib/services/usage-guard";
import { enrichEntry } from "@/lib/resume/entry-enrichment";
import { EnrichEntryBody } from "@/lib/validation/api-schemas";

export const dynamic = "force-dynamic";
// This route reaches the AI provider, so it needs the same ceiling as the other model-
// touching routes rather than the platform's ~10s default. Re-reads one entry through
// the model to fill in its missing fields. `FUNCTION_BUDGET_MS` in `lib/request-
// deadline.ts` assumes this number: the shared deadline hands the model whatever is
// left of it, so a route that silently had a fraction of it was killed by the platform
// mid-call — a 504 with no envelope — while the deadline still believed it had most of
// a minute. Pinned by tests/unit/route-budgets.test.ts.
export const maxDuration = 60;

/**
 * POST /api/resume-profiles/:id/enrich-entry
 * Appends a deep-dive answer to a specific experience/project entry (improvement loop).
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, funnelAi } = await getRequestContext(params.id);
    await loadOwnedProfile(store, params.id, userId);
    await enforceRateLimit("assist", { userId });
    const { entryType, entryId, rawAnswer } = EnrichEntryBody.parse(await readJson(request));
    // Capture, so it degrades rather than blocks when the budget is spent.
    const ai = await funnelProviderForBudget({ funnelAi, userId, resumeProfileId: params.id });
    // Capturing the deep-dive detail is deterministic; the model polishes on regenerate.
    const result = await enrichEntry(store, ai, params.id, entryType, entryId, rawAnswer);
    return ok(result);
  });
}
