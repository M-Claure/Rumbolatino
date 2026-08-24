import "server-only";
import { randomBytes } from "node:crypto";
import type { ResumeProfile, TalentListing } from "@/types";
import type { Analytics } from "@/lib/analytics";
import { Errors } from "@/lib/errors";
import { PUBLISH_TERMS_VERSION } from "@/lib/legal/terms";
import type { Store } from "@/lib/repositories";
import type { TalentDirectoryStore } from "@/lib/repositories/talent-store";
import { talentExpiryFrom } from "@/lib/repositories/talent-store";
import { suggestCategory } from "@/lib/talent/classify";
import {
  buildTalentSlug,
  estimateYearsBucket,
  projectTalentProfile,
  publicDisplayName,
} from "@/lib/talent/talent-projection";
import { assembleProfileState } from "@/lib/profile-state";

/**
 * Publishing a finished résumé to the talent directory, and taking it back down.
 *
 * ── The gates, and why each one is here rather than only in the UI ──────────
 * Three conditions must ALL hold before anything is written. Each corresponds to
 * a way a listing can be worse than no listing at all:
 *
 *   1. The résumé is FINALIZED. Publishing a draft puts a half-answered work
 *      history in front of employers, and the person never chose to show it.
 *   2. A résumé has actually been GENERATED. There is nothing to project from
 *      otherwise, and the generated document is the only thing guaranteed to
 *      contain confirmed-only data.
 *   3. There is a way to CONTACT them. A directory entry nobody can reach is
 *      pure exposure: it discloses a name, a city and a work history and returns
 *      nothing to the person who disclosed them.
 *
 * The publish screen checks the same three, but a disabled button is not a
 * control — anything reachable by fetch has to hold on its own.
 *
 * ── Nothing here calls a model ──────────────────────────────────────────────
 * Publishing is free. No `assertWithinBudget`, no provider, no tokens: the
 * projection is a pure function over a résumé that was already paid for, and the
 * category is a keyword classifier. That is deliberate — a directory that stops
 * accepting listings when `AI_SPEND_CAP_DAILY_USD` is reached would fail exactly
 * when the product is busiest.
 */

/** What the popup needs to know before it renders. */
export interface PublishDefaults {
  /** The name employers will see. Shown so the person can check it is right. */
  displayName: string;
  /** Their email, as captured. Shown for the same reason. */
  email: string | null;
  phone: string | null;
  /** True when this résumé is already listed — the popup then does not appear. */
  published: boolean;
}

export interface PublishTalentProfileInput {
  store: Store;
  talent: TalentDirectoryStore;
  analytics: Analytics;
  userId: string;
  profile: ResumeProfile;
  now?: Date;
}

/**
 * Suggest what the publish form should show. Read-only: calling this must not
 * create, change or reserve anything, because the form may be opened and
 * abandoned.
 */
export async function getPublishDefaults(
  store: Store,
  talent: TalentDirectoryStore,
  profileId: string,
): Promise<PublishDefaults> {
  const [personal, existing] = await Promise.all([
    store.getPersonalInformation(profileId),
    talent.getByFunnelId(profileId),
  ]);

  return {
    displayName: publicDisplayName(personal),
    email: personal?.email?.trim() || null,
    phone: personal?.phone?.trim() || null,
    published: existing?.status === "published",
  };
}

export async function publishTalentProfile(
  input: PublishTalentProfileInput,
): Promise<TalentListing> {
  const { store, talent, analytics, userId, profile } = input;
  const now = input.now ?? new Date();

  if (!profile.finalizedAt) {
    throw Errors.notReady("Finaliza tu currículum antes de publicarlo.");
  }

  const [resume, personal, existing, state] = await Promise.all([
    store.getLatestGeneratedResume(profile.id),
    store.getPersonalInformation(profile.id),
    talent.getByFunnelId(profile.id),
    assembleProfileState(store, profile.id),
  ]);

  if (!resume) {
    throw Errors.notReady("Genera tu currículum antes de publicarlo.");
  }

  const hasContact = Boolean(personal?.email?.trim() || personal?.phone?.trim());
  if (!hasContact) {
    throw Errors.notReady(
      "Agrega tu correo o tu teléfono antes de publicar, para que las empresas puedan escribirte.",
    );
  }

  const publishedAt = now.toISOString();
  const displayName = publicDisplayName(personal);

  // A re-publish KEEPS the slug and the manage token. The slug because a URL
  // someone has already sent to an employer must not 404 after an edit; the
  // token because it may already be in an email, and rotating it would quietly
  // take away the only way to unpublish that survives clearing cookies.
  const slug = existing?.profile.slug ?? buildTalentSlug(displayName, randomSuffix());
  const manageToken = existing?.manageToken || newManageToken();

  // ── The three facets, derived rather than asked ──────────────────────────
  // These exist so employers can FILTER. Asking three extra questions at the
  // moment someone is trying to download their finished CV is how you lose them,
  // so all three come from the résumé they already completed. Re-publishing
  // re-derives them, so fixing the résumé fixes the listing.
  //
  // Both estimators are deliberately conservative — `suggestCategory` falls back
  // to `otro` rather than guessing, and `estimateYearsBucket` understates when
  // the free-text dates do not parse. A filter that is too broad costs an
  // employer one extra scroll; one that overstates someone's seniority is a false
  // claim about them, which this product does not make anywhere else either.
  const category = suggestCategory({
    targetRole: state.targetRole ?? null,
    careerGoal: state.careerGoal ?? null,
    // CONFIRMED skills only — a `suggested` skill is not yet a fact.
    skills: state.confirmedSkills.map((s) => s.name),
    certifications: state.certifications.map((c) => c.name),
    education: state.education,
    experience: state.experience,
  });

  const projection = projectTalentProfile({
    resume,
    personal,
    profile: { targetRole: profile.targetRole, location: profile.location },
    category,
    // Nobody was asked, so the listing promises nothing it cannot keep.
    availability: "flexible",
    yearsBucket: estimateYearsBucket(state.experience, now.getUTCFullYear()),
    slug,
    publishedAt,
  });

  const listing = await talent.publish({
    funnelId: profile.id,
    userId,
    profile: projection.public,
    // Straight from the résumé's own captured ZIP. Null for anyone outside the
    // US, who is then simply absent from radius searches rather than misplaced.
    location: {
      postalCode: personal?.postalCode ?? null,
      latitude: personal?.latitude ?? null,
      longitude: personal?.longitude ?? null,
    },
    contact: projection.contact,
    manageToken,
    expiresAt: talentExpiryFrom(publishedAt),
  });

  // Consent is stamped only AFTER the write succeeds. A record saying someone
  // consented to a publication that never happened is worse than no record: it
  // is the wrong answer to "did they agree to this?".
  await store.updateResumeProfile(profile.id, {
    publishConsentAt: publishedAt,
    publishConsentVersion: PUBLISH_TERMS_VERSION,
  });

  analytics.track(
    "talent_profile_published",
    {
      resumeProfileId: profile.id,
      talentCategory: projection.public.category,
      yearsBucket: projection.public.yearsBucket,
    },
    userId,
  );

  return listing;
}

/**
 * Take a listing down.
 *
 * Sets `unpublished` rather than deleting the row, for two reasons: the audit
 * trail in `contact_reveals` references it, so a delete would erase the record
 * of who already has this person's details; and re-publishing later should
 * return the same URL rather than mint a new one.
 *
 * Idempotent — unpublishing something that was never published is a no-op, not
 * an error. The user's intent ("I am not listed") is satisfied either way.
 */
export async function unpublishTalentProfile(input: {
  talent: TalentDirectoryStore;
  analytics: Analytics;
  userId: string;
  profileId: string;
}): Promise<void> {
  await input.talent.setStatus(input.profileId, "unpublished");
  input.analytics.track(
    "talent_profile_unpublished",
    { resumeProfileId: input.profileId },
    input.userId,
  );
}

/**
 * The opaque tail of a slug. Present so `/talento/maria-g` is not guessable —
 * without it the directory can be walked by generating common names, which turns
 * a set of individually-consented listings back into a scrapeable dump.
 */
function randomSuffix(): string {
  return randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

/**
 * The unpublish credential. 32 bytes because it is a bearer token that can take
 * somebody's listing down and is never rate-limited by a login — it has to be
 * unguessable on its own.
 */
function newManageToken(): string {
  return randomBytes(32).toString("base64url");
}
