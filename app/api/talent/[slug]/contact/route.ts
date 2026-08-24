import { handleRoute, ok } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { getAnalytics } from "@/lib/analytics";
import { resolveExistingUserId } from "@/lib/auth";
import { getTalentStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/talent/:slug/contact — unlock one candidate's contact details.
 *
 * This is the route that hands out a real person's phone number, so it is the
 * most carefully guarded one in the directory:
 *
 *  1. It requires an identified employer. `resolveExistingUserId()` does NOT
 *     mint a session, so an anonymous caller gets a 403 with a code the UI turns
 *     into "tell us who you are" — rather than being silently given an identity
 *     it never chose and never named.
 *  2. It is rate limited on `contact_reveal`, the tightest limit in the product.
 *  3. The reveal and its audit row are ONE database statement
 *     (`talent_reveal_contact`), so contact data cannot be returned without the
 *     access being recorded. Two calls from here could always drop the second.
 *
 * The résumé itself is not returned as a storage URL. A signed URL is a bearer
 * token that can be forwarded, posted, or logged by a proxy, and it outlives the
 * session it was issued to. Instead the response says whether a résumé exists and
 * the employer fetches it back through `…/resume`, which re-checks who they are
 * on every request.
 */
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  return handleRoute(async () => {
    const userId = await resolveExistingUserId();
    const talent = getTalentStore();

    const employer = userId ? await talent.getEmployer(userId) : null;
    if (!employer || !userId) {
      throw Errors.forbidden("Dinos quién eres antes de ver los datos de contacto.");
    }

    await enforceRateLimit("contact_reveal", { userId, ip: clientIp(request.headers) });

    const contact = await talent.revealContact({
      employerId: userId,
      slug: params.slug,
      ip: clientIp(request.headers),
    });

    // Unknown, unpublished and expired are all this same 404 — see the note on
    // the profile page. Distinguishing them would confirm that a given person
    // was once listed, which is precisely what unpublishing is meant to undo.
    if (!contact) throw Errors.notFound("Este perfil ya no está disponible.");

    // No identifier for either side: `contact_reveals` in Postgres is the record
    // of who saw whom, and it is an access log rather than a product metric.
    getAnalytics().track("talent_contact_revealed", {}, userId);

    return ok({
      contact: {
        fullName: contact.fullName,
        email: contact.email,
        phone: contact.phone,
        linkedInUrl: contact.linkedInUrl,
      },
      // A flag, not a path. The employer never learns where the file lives.
      hasResume: Boolean(contact.resumePdfPath),
    });
  });
}
