import { handleRoute, ok } from "@/lib/http";
import { headers } from "next/headers";
import { originForZip, searchDirectory } from "@/lib/services/talent-directory";
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
    const { zip, radius, ...rest } = TalentSearchQuery.parse(
      Object.fromEntries(url.searchParams),
    );
    const employer = await requireEmployerSession();
    const origin = originForZip(zip, radius);
    return ok(await searchDirectory({ ...rest, ...(origin ?? {}) }, headers(), employer));
  });
}
