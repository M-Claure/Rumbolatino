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
 * GET /api/talent/:slug/resume — the candidate's PDF, for an identified employer.
 *
 * ── Why a streamed download and not a signed storage URL ────────────────────
 * A signed URL is a bearer token for a file. It can be forwarded, pasted into a
 * group chat, captured by a corporate proxy, or simply kept after the listing
 * comes down — and none of that is visible to us or to the person whose résumé
 * it is. Streaming through this route means access is re-checked on every single
 * request, ends the moment the listing is unpublished, and stays attributable.
 * The cost is bytes through a function, which for a one-page PDF is nothing.
 *
 * The bucket's own RLS is untouched: it still authorizes on the OWNER's
 * `auth.uid()`. This route reaches past it with `getServiceResumeFileStore()`,
 * which is the single place in the codebase allowed to do that, and only after
 * `revealContact` has both authorized the access and written its audit row.
 */
export async function GET(request: Request, { params }: { params: { slug: string } }) {
  return handleRoute(async () => {
    const userId = await resolveExistingUserId();
    const talent = getTalentStore();

    const employer = userId ? await talent.getEmployer(userId) : null;
    if (!employer || !userId) {
      throw Errors.forbidden("Dinos quién eres antes de descargar el currículum.");
    }

    await enforceRateLimit("contact_reveal", { userId, ip: clientIp(request.headers) });

    // Goes through the same reveal function as the contact route, so a download
    // is logged exactly like a reveal — downloading the CV IS seeing the person's
    // details, and an access log with a hole in it is not an access log.
    const contact = await talent.revealContact({
      employerId: userId,
      slug: params.slug,
      ip: clientIp(request.headers),
    });
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
