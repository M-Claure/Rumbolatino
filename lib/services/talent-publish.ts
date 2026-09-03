import "server-only";
import { randomBytes } from "node:crypto";
import type { ResumeProfile, TalentAvailability, TalentListing } from "@/types";
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
import { lookupCbsaForZip } from "@/lib/geo/cbsa-lookup";

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
  /**
   * The availability already on the listing, so a RE-publish can send back what
   * the person chose the first time instead of asking again. Null when there is
   * no listing yet, and also for a listing published before the question
   * existed — in both cases the popup starts with nothing selected.
   *
   * Deliberately not a suggested default for a first publish: pre-selecting an
   * answer to "when could you start?" is how the placeholder got mistaken for
   * an answer in the first place.
   */
  availability: TalentAvailability | null;
}

export interface PublishTalentProfileInput {
  store: Store;
  talent: TalentDirectoryStore;
  analytics: Analytics;
  userId: string;
  profile: ResumeProfile;
  /**
   * When the person said they could start — the ONE thing the popup asks
   * besides the consent.
   *
   * REQUIRED, and required on purpose. It used to be hard-coded `flexible` here
   * to satisfy a not-null column, which meant every listing carried a start date
   * nobody had chosen and the profile page printed it as the candidate's own
   * words. Making it a parameter is what stops this function from being able to
   * invent one again: there is no default to fall back to, so a caller that does
   * not have a real answer cannot publish.
   *
   * A re-publish sends back what `PublishDefaults.availability` returned, so
   * fixing a résumé does not re-open the question.
   */
  availability: TalentAvailability;
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
    availability: existing?.profile.availability ?? null,
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

  // ── Where they are, resolved ONCE ────────────────────────────────────────
  // Straight from the résumé's own captured ZIP. The metro is a table lookup on
  // that ZIP (`lib/geo/cbsa-lookup.ts`), done HERE rather than at search time so
  // an employer's metro search is an indexed equality test — the spec's "resolve
  // once and store it, so employer searches are fast".
  //
  // Null for anyone outside the US and for a rural ZIP that OMB places in no
  // metro at all. Both are then simply absent from metro searches and from the
  // map, rather than being drawn at the nearest plausible point.
  //
  // Re-derived on every publish, so correcting a ZIP corrects the listing. What
  // it does NOT track is a change to the CBSA delineations themselves, which is
  // what `npm run geo:cbsa -- --backfill` is for.
  const metro = lookupCbsaForZip(personal?.postalCode);
  const location = {
    postalCode: personal?.postalCode ?? null,
    latitude: personal?.latitude ?? null,
    longitude: personal?.longitude ?? null,
    cbsaCode: metro?.code ?? null,
    cbsaTitle: metro?.title ?? null,
  };

  const projection = projectTalentProfile({
    resume,
    personal,
    profile: { targetRole: profile.targetRole, location: profile.location },
    category,
    // Straight from the popup. The one facet on a listing that is ANSWERED
    // rather than derived — category and seniority are read out of the finished
    // résumé, but no résumé says when somebody is free to start.
    availability: input.availability,
    yearsBucket: estimateYearsBucket(state.experience, now.getUTCFullYear()),
    // The same object reaches the store below, so the public projection and the
    // stored row cannot end up describing two different places.
    location,
    slug,
    publishedAt,
  });

  const listing = await talent.publish({
    funnelId: profile.id,
    userId,
    profile: projection.public,
    location,
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
      // Now worth recording: it is a real choice out of a closed set of four,
      // so the distribution says something about the supply side. It was
      // pointless while every listing was stamped `flexible`.
      ...(projection.public.availability ? { availability: projection.public.availability } : {}),
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
