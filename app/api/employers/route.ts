import { handleRoute, ok } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { resolveExistingUserId, resolveUserId } from "@/lib/auth";
import { getTalentStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import { CreateEmployerBody } from "@/lib/validation/api-schemas";

export const dynamic = "force-dynamic";

/**
 * Who is asking to see people's contact details.
 *
 * ── Still no account, on both sides ─────────────────────────────────────────
 * The job seeker gives us a name and a way to reach them before we build their
 * résumé. An employer gives us the same before we hand over anyone's phone
 * number. Neither is asked for a password. This is IDENTIFICATION, not
 * authentication — nothing here is verified, and it is not meant to be. Its job
 * is to put a name next to every row in `contact_reveals`, so that "who has my
 * details?" has an answer and a scraper has to at least type something.
 *
 * Under the hood an employer is a guest session that happens to have an
 * `employers` row: `resolveUserId()` is the same mechanism the résumé side uses,
 * so there is no second cookie, no second session format and no second thing to
 * get wrong.
 *
 * This is the ONE directory route that mints a session, and that is deliberate —
 * it runs on an explicit action by someone who just typed their name in, not on
 * a pageview. Browsing stays anonymous (see `lib/services/talent-directory.ts`).
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ip = clientIp(request.headers);
    // Keyed by IP: this route runs BEFORE an identity exists, exactly like
    // `profile_create` on the résumé side.
    await enforceRateLimit("employer_register", { userId: await resolveExistingUserId(), ip });

    const body = CreateEmployerBody.parse(await request.json().catch(() => ({})));

    const userId = await resolveUserId();
    if (!userId) throw Errors.internal("No se pudo iniciar tu sesión. Intenta de nuevo.");

    const employer = await getTalentStore().upsertEmployer({
      id: userId,
      company: body.company,
      contactName: body.contactName,
      email: body.email,
      ip,
    });

    // The row, minus the address we keep only for abuse triage.
    return ok({
      employer: {
        company: employer.company,
        contactName: employer.contactName,
        email: employer.email,
      },
    });
  });
}

/** GET — "have I already said who I am?", so the UI knows whether to show the form. */
export async function GET() {
  return handleRoute(async () => {
    const userId = await resolveExistingUserId();
    const employer = userId ? await getTalentStore().getEmployer(userId) : null;
    return ok({
      employer: employer
        ? { company: employer.company, contactName: employer.contactName, email: employer.email }
        : null,
    });
  });
}
