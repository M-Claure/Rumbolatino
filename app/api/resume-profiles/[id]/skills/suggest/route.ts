import { handleRoute, ok } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { assembleProfileState } from "@/lib/profile-state";
import { inferAndPersistSkills } from "@/lib/skills/skill-inference";

export const dynamic = "force-dynamic";
// This route reaches the AI provider, so it needs the same ceiling as the other model-
// touching routes rather than the platform's ~10s default. Infers skills from the
// answers captured so far. `FUNCTION_BUDGET_MS` in `lib/request-deadline.ts` assumes
// this number: the shared deadline hands the model whatever is left of it, so a route
// that silently had a fraction of it was killed by the platform mid-call — a 504 with
// no envelope — while the deadline still believed it had most of a minute. Pinned by
// tests/unit/route-budgets.test.ts.
export const maxDuration = 60;

/**
 * POST /api/resume-profiles/:id/skills/suggest
 * Generate evidence-backed skill suggestions from the current experience.
 * Suggestions are persisted with status `suggested` (never auto-confirmed).
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const ctx = await getRequestContext(params.id);
    await loadOwnedProfile(ctx.store, params.id, ctx.userId);
    // Skill inference is deterministic today, so there is nothing to degrade — but it
    // reads and writes the whole profile, so it still gets a ceiling.
    await enforceRateLimit("assist", { userId: ctx.userId });

    const state = await assembleProfileState(ctx.store, params.id);
    // Deterministic skill inference — no paid-model call.
    const suggested = await inferAndPersistSkills(ctx.store, ctx.funnelAi, state);
    if (suggested.length > 0) {
      ctx.analytics.track(
        "skill_suggested",
        { resumeProfileId: params.id, skillCount: suggested.length },
        ctx.userId,
      );
    }
    return ok({ suggestedSkills: suggested });
  });
}
