import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/http";
import { Errors, isAppError } from "@/lib/errors";
import { getTalentStore } from "@/lib/repositories";
import { requireEmployerSession } from "@/lib/employers/session";
import { getServiceResumeFileStore } from "@/lib/storage";
import { clientIp } from "@/lib/rate-limit/policy";
import { enforceRateLimit } from "@/lib/services/usage-guard";
import {
  resumeDeliveryFromQuery,
  resumePreviewRefusalHtml,
  resumeResponseHeaders,
  type ResumeDelivery,
} from "@/lib/talent/resume-delivery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/talent/:slug/resume — the candidate's PDF.
 *
 * ── Two modes, one disclosure ───────────────────────────────────────────────
 * `?inline=1` serves the same bytes with `Content-Disposition: inline`, which is
 * what makes the preview frame in `components/talent/ResumePreview.tsx` possible:
 * an employer can read a résumé without collecting a file. That is the ONLY
 * difference. The session gate, the `contact_reveal` limit and the
 * `contact_reveals` row are identical in both modes, because the PDF carries the
 * person's full name, email and phone whether it is rendered or saved — a
 * cheaper preview would be a hole drilled straight through the one limit here
 * that protects people rather than infrastructure. See
 * `lib/talent/resume-delivery.ts`.
 *
 * ── Verified employers only ─────────────────────────────────────────────────
 * This is the most sensitive route in the product. It requires a verified
 * employer session, and every hit — preview or download — is recorded against
 * that account.
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
 *   - `contact_reveals`, which records every read against that account, so
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
  const delivery = resumeDeliveryFromQuery(new URL(request.url).searchParams);

  // Inline mode answers a browser FRAME, so a refusal has to be a page. Wrapped
  // in `handleRoute` it would render inside the preview as the literal text
  // `{"error":{"code":"rate_limited",…}}` — and 429 is the refusal an honest
  // employer is most likely to meet, now that a preview spends a reveal.
  if (delivery === "inline") {
    try {
      return await serveResume(request, params.slug, delivery);
    } catch (error) {
      return refusalPage(error);
    }
  }

  return handleRoute(() => serveResume(request, params.slug, delivery));
}

async function serveResume(
  request: Request,
  slug: string,
  delivery: ResumeDelivery,
): Promise<NextResponse> {
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
    slug,
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
    headers: resumeResponseHeaders({ slug, delivery, byteLength: pdf.byteLength }),
  });
}

/** The inline path's error envelope: HTML, because the reader is an `<iframe>`. */
function refusalPage(error: unknown): NextResponse {
  const known = isAppError(error) ? error : null;
  // Same discipline as `handleRoute`: an unknown failure is logged in full and
  // described generically, never leaked into the response.
  if (!known) console.error("[talent resume preview]", error);
  const message =
    known?.message ?? "Hubo un problema de nuestro lado. Vuelve a intentarlo en un momento.";

  return new NextResponse(resumePreviewRefusalHtml(message), {
    status: known?.status ?? 500,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
