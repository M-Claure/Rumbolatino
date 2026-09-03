import { handleRoute, ok, readJson } from "@/lib/http";
import { getRequestContext, loadOwnedProfile } from "@/lib/request-context";
import { getTalentStore } from "@/lib/repositories";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import {
  getPublishDefaults,
  publishTalentProfile,
  unpublishTalentProfile,
} from "@/lib/services/talent-publish";
import { PublishTalentBody } from "@/lib/validation/api-schemas";

export const dynamic = "force-dynamic";

/**
 * The résumé owner's control over their directory listing.
 *
 * `getTalentStore()` is called here rather than being handed out by
 * `getRequestContext`, because it THROWS when the service role is not configured
 * (see the fail-closed note on it). Building it in the shared request context
 * would make a directory misconfiguration break every route in the product,
 * including writing a résumé — which has nothing to do with the directory.
 *
 * No budget check on any of these: publishing calls no model. See
 * `lib/services/talent-publish.ts`.
 */

/**
 * GET — what the publish form should show: the public display name, the contact
 * channels employers will get, whether there is already a listing, and the
 * availability that listing holds (so a re-publish sends back the person's own
 * earlier answer rather than re-asking).
 *
 * Read-only and side-effect free, so opening the form and walking away leaves
 * nothing behind. Not rate-limited beyond the usual: it writes nothing and
 * returns only the caller's own data.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, analytics } = await getRequestContext();
    await loadOwnedProfile(store, params.id, userId);
    const defaults = await getPublishDefaults(store, getTalentStore(), params.id);

    // Fired here rather than on publish, because this is the request the popup
    // makes when it renders — which is what "was the offer seen?" means, and
    // therefore the denominator the opt-in rate needs.
    if (!defaults.published) {
      analytics.track("talent_publish_offered", { resumeProfileId: params.id }, userId);
    }

    return ok({ defaults });
  });
}

/**
 * POST — publish, or re-publish after an edit.
 *
 * Idempotent per résumé: the listing is keyed on the funnel row, so this updates
 * one row rather than adding another, and it keeps the existing slug so a URL
 * already shared with an employer keeps working.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, analytics } = await getRequestContext();
    const profile = await loadOwnedProfile(store, params.id, userId);
    await enforceRateLimit("talent_publish", { userId });

    // The consent AND the one answer the popup collects.
    // `acceptPublishTerms: literal(true)` means the publish below is unreachable
    // without consent; `availability` has no default, so it is equally
    // unreachable without a real answer — the service takes it as a required
    // parameter precisely so this route cannot invent one.
    const body = PublishTalentBody.parse(await readJson(request));

    const listing = await publishTalentProfile({
      store,
      talent: getTalentStore(),
      analytics,
      userId,
      profile,
      availability: body.availability,
    });

    // The manage token is deliberately NOT returned. It is stored (so the
    // Phase-4 email can send it) but there is no longer a screen that shows it,
    // and handing the browser a credential nothing renders is pure exposure.
    // Unpublishing from this device goes through DELETE below, which needs no
    // token because the session already proves ownership.
    return ok({
      listing: {
        slug: listing.profile.slug,
        status: listing.status,
        expiresAt: listing.expiresAt,
      },
    });
  });
}

/**
 * DELETE — take the listing down.
 *
 * Not rate-limited, and deliberately so. Every other write here is bounded, but
 * withdrawing consent must never be refused because someone clicked too often:
 * "come back in an hour" is not an acceptable answer to "take my name off that
 * page". Idempotent, so a retry is harmless.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  return handleRoute(async () => {
    const { userId, store, analytics } = await getRequestContext();
    await loadOwnedProfile(store, params.id, userId);

    await unpublishTalentProfile({
      talent: getTalentStore(),
      analytics,
      userId,
      profileId: params.id,
    });

    return ok({ status: "unpublished" });
  });
}
