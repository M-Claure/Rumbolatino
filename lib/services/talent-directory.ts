import "server-only";
import type { TalentProfilePublic, TalentSearchFilters, TalentSearchResult } from "@/types";
import { getAnalytics } from "@/lib/analytics";
import { getTalentStore } from "@/lib/repositories";
import type { EmployerSession } from "@/lib/employers/session";
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
 * ── The employer session is a PARAMETER, not a lookup ───────────────────────
 * Every function that reads candidate data takes an `EmployerSession`, so the
 * gate is enforced by the type system rather than by remembering to check. There
 * is no code path from an anonymous request to a candidate's name: a caller
 * cannot invent one of these — only `requireEmployerSession` and
 * `resolveEmployerSession` produce them, and both demand a confirmed mailbox.
 *
 * This replaced `resolveExistingUserId()`, which was here to read a session
 * WITHOUT minting a guest, back when strangers and crawlers were expected to hit
 * this surface. They are not any more; the wall at `/empleadores/acceso` is.
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
  employer: EmployerSession,
): Promise<TalentSearchResult> {
  // Keyed by the account now, not the IP. That is the point of requiring one:
  // a shared office address no longer shares a quota, and an abusive account
  // cannot shed its counter by changing networks.
  await enforceRateLimit("directory_search", {
    userId: employer.userId,
    ip: clientIp(headers),
  });

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
    employer.userId,
  );

  return result;
}

/**
 * One public profile by slug. Null when it is unknown, unpublished or expired —
 * the three are deliberately indistinguishable to the caller, so the 404 page
 * cannot be used to confirm that a given person was ever listed.
 */
export async function readPublicProfile(
  slug: string,
  _employer: EmployerSession,
): Promise<TalentProfilePublic | null> {
  // The session is unused here beyond being required to have one — that IS the
  // check. Named with an underscore rather than dropped from the signature: the
  // parameter is what stops a future caller from reading a profile without one.
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
  employer: EmployerSession,
): Promise<TalentSearchResult | null> {
  try {
    return await searchDirectory(filters, headers, employer);
  } catch (error) {
    console.error("[talent] directory search failed:", error);
    return null;
  }
}
