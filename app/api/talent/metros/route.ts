import { handleRoute, ok } from "@/lib/http";
import { headers } from "next/headers";
import { requireEmployerSession } from "@/lib/employers/session";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { METRO_SUGGESTION_LIMIT, searchMetros } from "@/lib/geo/cbsa-lookup";
import { MetroQuery } from "@/lib/validation/api-schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/talent/metros?q=miami — metro-area suggestions for the filter bar.
 *
 * `[{ code, title, kind, latitude, longitude }]`, at most eight, best match
 * first. The employer picks one and the form submits its `code` as `metro=`.
 *
 * ── This returns REFERENCE DATA, and no data about anyone ──────────────────
 * The list is the same 928 OMB metro areas for every caller, whether or not a
 * single person is published in any of them. That is deliberate: filtering it to
 * metros that HAVE candidates would be a nicer autocomplete and a disclosure —
 * it would let anyone with an account map, one keystroke at a time, which parts
 * of the country have people listed, outside the rate limit that governs
 * searching for them. So the count comes from the search, and this endpoint
 * knows nothing.
 *
 * ── Still behind the employer gate ─────────────────────────────────────────
 * It discloses nothing, so the gate is not protecting candidates here; it is
 * keeping the surface consistent. Everything under `/api/talent/*` needs a
 * verified employer, this route exists only for a control on `/empleadores`,
 * and an exception would be one more thing to remember when the next reviewer
 * asks which of these routes are open.
 *
 * ── Its own rate limit, not the search budget ─────────────────────────────
 * `metro_lookup` rather than `directory_search`: this is typed into per
 * keystroke, and spending the search allowance on typeahead would lock an
 * employer out of the search they were typing towards. See the reasoning on the
 * limit itself.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const { q } = MetroQuery.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const employer = await requireEmployerSession();
    await enforceRateLimit("metro_lookup", {
      userId: employer.userId,
      ip: clientIp(headers()),
    });

    // A query too short to be one comes back as an empty list, not an error: the
    // combobox calls this while somebody is still typing, and a 400 on the first
    // letter would be a console full of red for normal use.
    return ok({ metros: searchMetros(q ?? "", METRO_SUGGESTION_LIMIT) });
  });
}
