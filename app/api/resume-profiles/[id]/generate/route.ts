import { handleRoute, ok } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { assertWithinBudget, enforceRateLimit } from "@/lib/services/usage-guard";
import { generateResume } from "@/lib/resume/resume-generator";
import { countsAsImprovementRound } from "@/lib/resume/generation-round";
import { MAX_RESUME_ITERATIONS } from "@/lib/config/limits";
import { Errors } from "@/lib/errors";
import { assembleProfileState } from "@/lib/profile-state";
import { describeIncompleteEntries, incompleteEntries } from "@/lib/entry-required-fields";

export const dynamic = "force-dynamic";
// Chromium cold start + render, on top of the model call, comfortably exceeds
// Vercel's 10s default. 60s is the Hobby ceiling and is plenty for one résumé.
export const maxDuration = 60;
// This route renders the PDF too (via `resumeArtifacts`), so it needs the
// Node.js runtime and its filesystem — never Edge.
export const runtime = "nodejs";

/**
 * POST /api/resume-profiles/:id/generate
 * Generate a resume from confirmed data only. Returns 409 (not_ready) with the
 * missing critical fields if the profile isn't ready.
 *
 * The FIRST generation is free; each one after it is an improvement round and
 * counts against MAX_RESUME_ITERATIONS. That cap used to live only in the
 * browser's localStorage, so clearing site data reset it — it is server state
 * now (`funnel.iteration`) and is enforced here.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, ai, analytics, resumeArtifacts } = await getRequestContext(params.id);
    // Read BEFORE anything below overwrites it: `status` is how this route tells
    // "the user wants another round" from "the last attempt died and they pressed
    // the button again". See `countsAsImprovementRound`.
    const profileBefore = await loadOwnedProfile(store, params.id, userId);
    // The most expensive call in the product, so it carries both guards. The
    // budget check exempts a profile's FIRST résumé — nobody is refused the
    // document they came for (see lib/spend/budget.ts).
    await enforceRateLimit("generate", { userId });
    await assertWithinBudget({ operation: "generate", userId, resumeProfileId: params.id, store });

    // A résumé on file USED to be the whole test for "this is a regeneration",
    // and it was wrong in one case that really happens: a generation saves the
    // résumé several steps before it returns, so a request that died after
    // saving left one behind, and the retry was charged an improvement round for
    // our failure. `statusBefore` is what separates the two.
    const hasResume = (await store.getLatestGeneratedResume(params.id)) !== null;
    const isImprovementRound = countsAsImprovementRound({
      hasResume,
      statusBefore: profileBefore.status,
    });
    const completed = await store.getIteration(params.id);
    if (isImprovementRound && completed >= MAX_RESUME_ITERATIONS) {
      throw Errors.conflict(
        `Ya mejoraste tu currículum ${MAX_RESUME_ITERATIONS} veces. Revísalo y descárgalo.`,
      );
    }

    /*
     * The per-entry required-field rule, enforced where every client path meets it.
     *
     * It used to live only in `EditableReview`, which two of the three callers of
     * this route never render — the improvement round's "Regenerar" goes straight
     * here. So the rule held for a person's first résumé and silently stopped
     * holding for every regeneration after it.
     *
     * Ordered BEHIND readiness on purpose: when the basics are missing,
     * `generateResume` raises the canonical `missingCriticalFields` error, and
     * refusing here first would mask it with a narrower message.
     */
    const state = await assembleProfileState(store, params.id);
    if (state.completeness.readyToGenerate) {
      const incomplete = incompleteEntries(state);
      const problem = describeIncompleteEntries(incomplete);
      if (problem) throw Errors.notReady(problem, { incompleteEntries: incomplete });
    }

    analytics.track("resume_generation_started", { resumeProfileId: params.id }, userId);
    await store.updateResumeProfile(params.id, { status: "generating" });

    // `resumeArtifacts` renders the PDF and replaces the profile's stored one.
    const { resume } = await generateResume(store, ai, params.id, resumeArtifacts);

    // A freshly (re)generated résumé is not finalized — the user must review and
    // finalize the new version before downloading it. (`generateResume` has
    // already recorded the funnel as complete — see `runGeneration`.)
    await store.updateResumeProfile(params.id, { status: "generated", finalizedAt: null });
    const iteration = isImprovementRound
      ? await store.advanceIteration(params.id, MAX_RESUME_ITERATIONS)
      : completed;
    analytics.track("resume_generated", { resumeProfileId: params.id, version: resume.version }, userId);

    return ok({ resume, iteration });
  });
}
