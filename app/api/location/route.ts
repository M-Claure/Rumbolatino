import { handleRoute, ok } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { resolveExistingUserId } from "@/lib/auth";
import { clientIp, } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { lookupZip, nearestZip } from "@/lib/geo/zip-lookup";

export const dynamic = "force-dynamic";

/**
 * GET /api/location?zip=77002  — or  ?lat=29.76&lng=-95.36
 *
 * Turns either form of "where am I" into the same answer: a ZIP with its city,
 * state and coordinates.
 *
 * ── Why the browser does not get the table ─────────────────────────────────
 * The lookup could run client-side, but the table is 1.8 MB and there is no
 * reason to ship a national address index to every visitor. It stays server-side
 * (`lib/geo/zip-lookup.ts` is `server-only`) and this route is the whole client
 * interface to it.
 *
 * ── Why no session is minted ──────────────────────────────────────────────
 * `resolveExistingUserId()` reads a session without creating one, like the
 * directory search. Both sides of the product call this — a job seeker in the
 * funnel and an employer filtering — and the employer side is anonymous.
 *
 * Coordinates are used and discarded. Nothing here writes anything: a person's
 * precise device location never reaches the database, only the ZIP it resolves
 * to, and only if they then answer the question with it.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const params = new URL(request.url).searchParams;

    const userId = await resolveExistingUserId();
    // Shares the directory's budget: this is a cheap in-memory lookup, but it is
    // an open endpoint and a loop over it is the one way to make it expensive.
    await enforceRateLimit("directory_search", { userId, ip: clientIp(request.headers) });

    const zipParam = params.get("zip");
    if (zipParam) {
      const found = lookupZip(zipParam);
      if (!found) throw Errors.notFound("No encontramos ese código postal.");
      return ok({ location: found });
    }

    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const found = nearestZip(lat, lng);
      // Deliberately a 404 rather than the closest ZIP at any distance: a device
      // reporting a location outside the US must not be snapped to an American
      // ZIP hundreds of miles away and told that is where they live.
      if (!found) throw Errors.notFound("No pudimos encontrar un código postal cerca de ti.");
      return ok({ location: found });
    }

    throw Errors.validation("Envía un código postal (zip) o una ubicación (lat y lng).");
  });
}
