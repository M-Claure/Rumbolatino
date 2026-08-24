import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { resolveExistingUserId } from "@/lib/auth";
import { getTalentStore } from "@/lib/repositories";
import { getServiceResumeFileStore } from "@/lib/storage";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/talent/:slug/resume — the candidate's PDF.
 *
 * ── Open to anyone, by product decision ─────────────────────────────────────
 * This used to require an employer to say who they were first. That was removed
 * deliberately: the friction was judged not worth it. Be clear-eyed about what
 * it means — the résumé carries the person's full name, email and phone, so any
 * published profile's contact details are now downloadable by anyone who has the
 * URL, and the directory can be walked by a script. The people listed here are
 * told exactly this before they opt in (`PublishDialog`), which is what makes it
 * an honest trade rather than a surprise.
 *
 * What still stands between the directory and a bulk harvest:
 *   - the rate limit below, now keyed by IP since there is no identity;
 *   - `contact_reveals`, which still records every download with a timestamp and
 *     an address, so "who has my résumé?" has at least a partial answer;
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
    const ip = clientIp(request.headers);
    // Keyed by IP now, and it is the only ceiling left on bulk collection —
    // treat lowering it as cheap and raising it as a real decision.
    await enforceRateLimit("contact_reveal", {
      userId: await resolveExistingUserId(),
      ip,
    });

    // Still goes through the reveal function, so every download is recorded in
    // `contact_reveals` — with a null employer, because there is no longer one.
    const contact = await getTalentStore().revealContact({
      employerId: null,
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
