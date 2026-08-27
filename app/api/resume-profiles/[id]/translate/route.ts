import { handleRoute, ok } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { assertWithinBudget, enforceRateLimit } from "@/lib/services/usage-guard";
import { isTranslationCurrent, translateResume } from "@/lib/resume/translate-resume";

export const dynamic = "force-dynamic";
// Chromium cold start + render, on top of the model call, comfortably exceeds
// Vercel's 10s default. 60s is the Hobby ceiling and is plenty for one résumé.
export const maxDuration = 60;
// This route renders the PDF too (via `resumeArtifacts`), so it needs the
// Node.js runtime and its filesystem — never Edge.
export const runtime = "nodejs";

/**
 * GET /api/resume-profiles/:id/translate
 * The stored English translation and whether it still matches the current
 * résumé. Free — no model call — so the workspace can render the right button
 * ("Descargar en inglés" vs "Actualizar versión en inglés") on load.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store } = await getRequestContext(params.id);
    await loadOwnedProfile(store, params.id, userId);

    const [translation, resume] = await Promise.all([
      store.getTranslatedResume(params.id, "en"),
      store.getLatestGeneratedResume(params.id),
    ]);

    return ok({
      translation,
      current: isTranslationCurrent(translation, resume),
    });
  });
}

/**
 * POST /api/resume-profiles/:id/translate
 * Translate the finished résumé into English and save it alongside the Spanish
 * one. Uses the paid model (ctx.ai), at `reasoning.effort: none` — see
 * `lib/resume/translate-resume.ts` for the cost argument.
 *
 * Gated on finalization for the same reason the download is: translating a
 * résumé the person is still editing spends a model call on a document that is
 * about to change. Re-running when a translation already exists is allowed and
 * is how a stale one is refreshed — it is always an explicit user action, never
 * automatic.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, ai, analytics, resumeArtifacts } = await getRequestContext(params.id);
    const profile = await loadOwnedProfile(store, params.id, userId);
    await enforceRateLimit("translate", { userId });
    await assertWithinBudget({ operation: "translate", userId, resumeProfileId: params.id, store });

    if (!profile.finalizedAt) {
      throw Errors.notReady("Finaliza tu currículum antes de traducirlo.");
    }

    const { translation, sourceVersion } = await translateResume(
      store,
      ai,
      params.id,
      "en",
      resumeArtifacts,
    );

    analytics.track(
      "resume_translated",
      { resumeProfileId: params.id, version: sourceVersion, language: "en" },
      userId,
    );
    return ok({ translation, current: true });
  });
}
