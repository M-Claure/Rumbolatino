import { handleRoute, ok } from "@/lib/http";
import { headers } from "next/headers";
import { resolveSearchFilters, searchDirectory } from "@/lib/services/talent-directory";
import { TalentSearchQuery } from "@/lib/validation/api-schemas";
import { requireEmployerSession } from "@/lib/employers/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/talent/search — the directory, as JSON, for a signed-in employer.
 *
 * A 401 without a verified employer session. Not "public" any more: this used to
 * answer anyone, which made it the cheapest way to enumerate every listed
 * person. `requireEmployerSession` throws before any filter is read.
 *
 * A thin wrapper: the rate limit, the analytics and the store call all live in
 * `searchDirectory`, because `/empleadores` reads the same data server-side and
 * the two must not be able to drift apart on what they enforce.
 *
 * Nothing that could identify anyone comes back. The store calls `talent_search`,
 * whose `returns table` clause has no contact column in it, so this response
 * cannot carry an email even if this handler tried to send one.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const url = new URL(request.url);
    const params = TalentSearchQuery.parse(Object.fromEntries(url.searchParams));
    const employer = await requireEmployerSession();

    // `?zip=` → an origin and `?metro=` → a CBSA code both resolve inside the
    // service, which `/empleadores` also goes through: the page and its own API
    // must not be able to disagree about what a query string means.
    const { filters, metro, badZip } = resolveSearchFilters(params);
    const result = await searchDirectory(filters, headers(), employer);

    // A filter that could not be applied is REPORTED rather than swallowed. A
    // caller reads this response as the answer to what it asked, and returning
    // the whole country under a mistyped metro — with nothing saying so — is a
    // wrong answer dressed as a result set. Only present when there is something
    // to say, so an ordinary search keeps its exact previous shape.
    const unresolved = {
      ...(badZip ? { zip: params.zip } : {}),
      ...(metro.status === "unknown" ? { metro: metro.typed } : {}),
      ...(metro.status === "ambiguous"
        ? { metro: metro.typed, metroOptions: metro.options }
        : {}),
    };

    return ok(Object.keys(unresolved).length > 0 ? { ...result, unresolved } : result);
  });
}
