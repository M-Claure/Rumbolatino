import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { getTalentStore } from "@/lib/repositories";
import { requireEmployerSession } from "@/lib/employers/session";
import { getServiceResumeFileStore } from "@/lib/storage";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/talent/:slug/resume — the candidate's PDF.
 *
 * ── Verified employers only ─────────────────────────────────────────────────
 * This is the most sensitive route in the product: the PDF carries the person's
 * full name, email and phone. It requires a verified employer session, and the
 * download is recorded against that account.
 *
 * That is a reversal. For a while this was open to anyone with the URL, on the
 * judgement that identification was more friction than it was worth. What
 * changed is the decision to gate the directory itself — once an employer must
 * have an account to find anybody, there is no friction left to save by leaving
 * the most revealing endpoint open, and an open PDF would simply be the hole
 * every other gate is drilled around.
 *
 * What stands between the directory and a bulk harvest, in order of what
 * actually stops it:
 *   - the session requirement, which means a harvest needs a confirmed mailbox;
 *   - the rate limit below, now keyed by the ACCOUNT, so changing networks does
 *     not reset it;
 *   - `contact_reveals`, which records every download against that account, so
 *     "who has my résumé?" finally has a name in the answer;
 *   - slugs carrying a random suffix, so profiles cannot be enumerated by
 *     guessing names — the directory listing is the only way to find them.
 *
 * The bucket's own RLS is untouched: it still authorizes on the OWNER's
 * `auth.uid()`. This route reaches past it with `getServiceResumeFileStore()`,
 * the single place in the codebase allowed to do that, and only for a profile
 * that is currently published.
 */
export async function GET(request: Request, { params }: { params: { slug: string } }) {
  return handleRoute(async () => {
    const employer = await requireEmployerSession();
    const ip = clientIp(request.headers);
    // Keyed by the account. Still the limit that matters most — treat lowering
    // it as cheap and raising it as a real decision.
    await enforceRateLimit("contact_reveal", { userId: employer.userId, ip });

    // One statement in SQL: `talent_reveal_contact` inserts the audit row and
    // returns the contact together, so contact data cannot come back without the
    // access being recorded.
    const contact = await getTalentStore().revealContact({
      employerId: employer.userId,
      slug: params.slug,
      ip,
    });

    // Unknown, unpublished and expired are all this same 404 — distinguishing
    // them would confirm a given person was once listed, which is exactly what
    // unpublishing is meant to undo.
    if (!contact) throw Errors.notFound("Este perfil ya no está disponible.");
    if (!contact.resumePdfPath) {
      throw Errors.notFound("Este perfil no tiene un currículum guardado.");
    }

    const pdf = await getServiceResumeFileStore().getResumePdfByPath(contact.resumePdfPath);
    if (!pdf) throw Errors.notFound("No encontramos el archivo del currículum.");

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="curriculum-${params.slug}.pdf"`,
        "Content-Length": String(pdf.byteLength),
        // Never let a shared cache hold somebody's résumé.
        "Cache-Control": "private, no-store",
      },
    });
  });
}
