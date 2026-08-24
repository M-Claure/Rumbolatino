import "server-only";
import type { TalentProfilePublic, TalentSearchFilters, TalentSearchResult } from "@/types";
import { getAnalytics } from "@/lib/analytics";
import { resolveExistingUserId } from "@/lib/auth";
import { getTalentStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { lookupZip } from "@/lib/geo/zip-lookup";

/**
 * The guarded read path for the public directory.
 *
 * ── Why this is a service and not just a store call ─────────────────────────
 * The directory is read from TWO places: the JSON route (`/api/talent/search`)
 * and the server-rendered page (`/empleadores`), which loads its first page of
 * results directly rather than paying for a round trip to its own API. Those are
 * the same enumeration surface, so they must carry the same rate limit and emit
 * the same analytics — and "remember to add the limit in both" is not a control.
 * Putting the guard here means the only way to read the directory is through it.
 *
 * ── Why no guest session is minted ──────────────────────────────────────────
 * `resolveExistingUserId()` reads a session without creating one. Browsing is
 * the one surface strangers and crawlers are expected to hit, and minting an
 * `auth.users` row per anonymous visitor would fill the table with junk and hand
 * anyone a way to inflate the guest population from outside. See `lib/auth.ts`.
 */
/**
 * Turn `?zip=77002&radius=25` into the coordinates the store filters on.
 *
 * An unknown ZIP yields NO origin rather than an error or an empty result: the
 * employer still sees the rest of their search, and the page tells them the ZIP
 * was not recognised. Silently returning zero matches would look like "nobody
 * works near me" when it actually means "you typed five digits wrong".
 */
export function originForZip(
  zip: string | null | undefined,
  radiusMiles: number | undefined,
): { latitude: number; longitude: number; radiusMiles: number } | null {
  const found = lookupZip(zip);
  if (!found) return null;
  return {
    latitude: found.latitude,
    longitude: found.longitude,
    radiusMiles: radiusMiles ?? 25,
  };
}

export async function searchDirectory(
  filters: TalentSearchFilters,
  headers: Headers,
): Promise<TalentSearchResult> {
  const userId = await resolveExistingUserId();
  await enforceRateLimit("directory_search", { userId, ip: clientIp(headers) });

  const result = await getTalentStore().search(filters);

  getAnalytics().track(
    "talent_search",
    {
      ...(filters.category ? { talentCategory: filters.category } : {}),
      ...(filters.availability ? { availability: filters.availability } : {}),
      resultCount: result.total,
      // Whether someone typed something, never WHAT they typed — people put
      // names into search boxes. See the analytics allow-list.
      hasQuery: Boolean(filters.query?.trim()),
    },
    userId ?? undefined,
  );

  return result;
}

/**
 * One public profile by slug. Null when it is unknown, unpublished or expired —
 * the three are deliberately indistinguishable to the caller, so the 404 page
 * cannot be used to confirm that a given person was ever listed.
 */
export async function readPublicProfile(slug: string): Promise<TalentProfilePublic | null> {
  return getTalentStore().getPublicBySlug(slug);
}

/**
 * The same search, but never throwing — for a server-rendered page, where an
 * unconfigured directory or a tripped rate limit should degrade to an empty
 * state rather than a 500 on a public URL.
 *
 * Returns `null` for "could not read", which the page renders differently from
 * "read fine, found nobody". Those two must not look the same: one is our
 * problem and one is the search being too narrow.
 */
export async function searchDirectorySafely(
  filters: TalentSearchFilters,
  headers: Headers,
): Promise<TalentSearchResult | null> {
  try {
    return await searchDirectory(filters, headers);
  } catch (error) {
    console.error("[talent] directory search failed:", error);
    return null;
  }
}
