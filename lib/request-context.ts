import "server-only";
import type { ResumeProfile } from "@/types";
import { getAIProvider, getFunnelProvider, type AIProvider } from "@/lib/ai";
import { getAnalytics, type Analytics } from "@/lib/analytics";
import { getEnv } from "@/lib/env";
import { Errors } from "@/lib/errors";
import { getStore, type Store } from "@/lib/repositories";
import { getResumeFileStore, type ResumeFileStore } from "@/lib/storage";
import { getSpendLedger } from "@/lib/spend";
import { createCallSpendRecorder } from "@/lib/spend/recorder";
import { getPdfGenerator } from "@/lib/resume/pdf-generator";
import { createResumePdfWriter, type ResumeArtifactWriter } from "@/lib/resume/resume-artifacts";
import { resolveUserEmail, resolveUserId } from "@/lib/auth";
import { startRequestDeadline } from "@/lib/request-deadline";

export interface RequestContext {
  userId: string;
  store: Store;
  /** Configured provider (Azure OpenAI when enabled) — generation + analysis only. */
  ai: AIProvider;
  /** Deterministic provider — per-step funnel/capture ops (never the paid model). */
  funnelAi: AIProvider;
  analytics: Analytics;
  /** Binary artifact storage for the profile's saved résumé PDF. */
  resumeFiles: ResumeFileStore;
  /**
   * Pass this to `generateResume` / `proofreadAndRerender` so every new résumé
   * version replaces the profile's stored PDF. Pre-bound to this request's user.
   */
  resumeArtifacts: ResumeArtifactWriter;
}

/**
 * Build the per-request dependency bundle: authenticated user + persistence +
 * AI provider + analytics. Throws 401 when no user can be resolved. In memory
 * mode the app-level user row is provisioned on the fly (Supabase does this via
 * a DB trigger).
 *
 * @param resumeProfileId The résumé this request is about, when it is about one.
 *   Only used to attribute AI spend, so the per-résumé cap can exist at all — a
 *   ledger row with no profile can be counted against the user and the day, but
 *   never against one résumé. Pass `params.id` from any route that may reach the
 *   model; ownership is still checked separately by `loadOwnedProfile`, which runs
 *   before any call can happen.
 */
export async function getRequestContext(resumeProfileId?: string): Promise<RequestContext> {
  /*
   * Started FIRST, before the auth round trip below, so the clock covers the whole
   * handler and not just the part after the context exists. The two expensive
   * steps of a generation — the model call and the Chromium render — then read the
   * same countdown, which is what stops either of them from spending budget the
   * other needed. See `lib/request-deadline.ts`.
   */
  const deadline = startRequestDeadline();
  const userId = await resolveUserId();
  if (!userId) throw Errors.unauthorized();

  const store = getStore();
  const env = getEnv();

  if (env.PERSISTENCE === "memory") {
    const existing = await store.getUser(userId);
    if (!existing) {
      const email = (await resolveUserEmail()) ?? `${userId}@local.dev`;
      await store.upsertUser({ id: userId, email });
    }
  }

  const analytics = getAnalytics();
  const resumeFiles = getResumeFileStore();
  // Charges every model call this request makes against the spend caps. Bound to
  // the user (and résumé, when known) here because that is the only place both are
  // in scope — see `createCallSpendRecorder`.
  const spend = createCallSpendRecorder({
    ledger: getSpendLedger(),
    userId,
    resumeProfileId: resumeProfileId ?? null,
  });

  return {
    userId,
    store,
    ai: getAIProvider(spend, deadline),
    funnelAi: getFunnelProvider(spend, deadline),
    analytics,
    resumeFiles,
    resumeArtifacts: createResumePdfWriter({
      userId,
      store,
      pdf: getPdfGenerator(),
      files: resumeFiles,
      analytics,
      deadline,
    }),
  };
}

/**
 * Load a resume profile and assert the caller owns it. Returns notFound (not
 * forbidden) on mismatch so profile existence is never leaked across accounts.
 */
export async function loadOwnedProfile(
  store: Store,
  profileId: string,
  userId: string,
): Promise<ResumeProfile> {
  const profile = await store.getResumeProfile(profileId);
  if (!profile || profile.userId !== userId) throw Errors.notFound("Perfil no encontrado");
  return profile;
}

/**
 * Assert the caller owns the profile a child entity belongs to. Used by the
 * flat entity routes (/api/education/:id, /api/skills/:id, ...).
 */
export async function assertOwnsProfileId(
  store: Store,
  profileId: string,
  userId: string,
): Promise<void> {
  await loadOwnedProfile(store, profileId, userId);
}
