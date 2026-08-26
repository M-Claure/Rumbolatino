import { stripDiacritics } from "@/lib/talent/text";

/**
 * How a candidate's PDF reaches an employer: shown in place, or saved to disk.
 *
 * `GET /api/talent/:slug/resume` serves both, and the difference is one header.
 * It gets a named mode and a pure module anyway, because three separate things
 * hang off it:
 *
 *  - **A preview is exactly as much of a disclosure as a download.** The bytes
 *    are the same bytes, carrying the same name, email and phone. So the two
 *    modes share the session gate, the `contact_reveal` limit and the
 *    `contact_reveals` audit row — see the route. A cheaper preview would be a
 *    hole drilled straight through the one limit in this product that protects
 *    people rather than infrastructure.
 *  - **The filename is the employer's copy.** It is built from the slug, not
 *    from the route parameter as it arrived, so a path segment can never reach a
 *    response header.
 *  - **Framing is only a question in inline mode**, and the answer has to be
 *    "our own pages, nobody else's".
 *
 * ── Two axes now: delivery AND format ───────────────────────────────────────
 * `0015` added an HTML preview, because iOS Safari will not render a PDF inside
 * an iframe — it hands PDFs to the system viewer at the top-level navigation
 * layer and does not expose that renderer to a subframe, so the frame showed a
 * blank box and did it silently. The résumé HTML that Chromium printed to make
 * the PDF renders in every browser, so `inline` serves that when the listing has
 * it and falls back to the PDF when it does not (anything published before
 * `0015`).
 *
 * That splits one question into two: `attachment` is always a PDF, `inline` is
 * either. What must NOT split is the safety argument. The claim is that a
 * preview is the same disclosure as a download — same person, same name, email
 * and phone — and that lives in the session gate, the `contact_reveal` limit and
 * the `contact_reveals` row, all of which are identical in both modes and for
 * both formats. So `resumeResponseHeaders` may differ between formats only in
 * the headers that DESCRIBE the format, and `SECURITY_HEADER_NAMES` names the
 * ones that may never vary. `tests/unit/talent-resume-delivery.test.ts` pins
 * both halves of that.
 *
 * Pure: no I/O, no `server-only`, no Next imports — which is what makes the
 * header set testable at all. The route itself needs a session, a service role
 * and a stored résumé before it reaches any of this.
 */

/** `inline` renders in the browser's own viewer; `attachment` downloads. */
export type ResumeDelivery = "inline" | "attachment";

/**
 * What is actually served.
 *
 * `pdf` is the document the candidate downloads and the one an employer keeps.
 * `html` is the same résumé as markup — `lib/resume/resume-renderer.ts`'s own
 * output, snapshotted onto the listing at publish time — used for the preview
 * because it renders in browsers that refuse to frame a PDF, and because it
 * stays selectable and zoomable on a phone.
 *
 * It is safe to serve as an active document for reasons that are worth stating
 * rather than assuming: the renderer puts every piece of user text through
 * `esc()`, emits no script tags, and references no external URL — no `@import`,
 * no `url()`, fonts named in a family stack with system fallbacks. `HTML_CSP`
 * below is what keeps that true if the renderer ever changes.
 */
export type ResumeFormat = "pdf" | "html";

/**
 * The headers that carry the safety argument, and therefore may never differ
 * between the two formats or the two delivery modes.
 *
 * `no-store` because a shared cache must never hold somebody's résumé,
 * `nosniff` because the only correct reading of these bytes is the one we
 * declared, and `SAMEORIGIN` because the preview frame is ours and nobody
 * else's. A preview being a lighter disclosure than a download would be a hole
 * drilled through the one limit here that protects people, and these three are
 * the part of that claim a response header can express.
 */
export const SECURITY_HEADER_NAMES = [
  "Cache-Control",
  "X-Content-Type-Options",
  "X-Frame-Options",
] as const;

/**
 * The résumé HTML is a document built from user-derived text, so it gets a
 * policy that makes "no scripts, no external requests" enforced rather than
 * merely true today. `style-src 'unsafe-inline'` is required — the renderer's
 * whole stylesheet is one inline `<style>` block — and is not a weakening worth
 * avoiding: inline CSS is the thing being allowed, and nothing else is.
 *
 * Applied to the HTML response ALONE. `default-src 'none'` on a PDF response is
 * inert in principle, but the browser's internal PDF viewer is exactly the kind
 * of embedded renderer a restrictive policy has historically interfered with,
 * and the download path is not the one with a problem to fix.
 */
const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
  "frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/**
 * Read the mode off a request's query string.
 *
 * **`attachment` is the default, deliberately.** Every link written before the
 * preview existed omits the parameter, and a silent switch to inline would have
 * turned "Descargar PDF" into "open a viewer" everywhere at once. Opting in is
 * also the honest default for a bare URL pasted into an address bar: the caller
 * did not ask to render anything.
 */
export function resumeDeliveryFromQuery(params: URLSearchParams): ResumeDelivery {
  return params.get("inline") === "1" ? "inline" : "attachment";
}

/**
 * The name the file lands under.
 *
 * Rebuilt from scratch rather than interpolated: `slug` is a URL path segment,
 * so it is whatever the caller sent — already percent-decoded by the time a
 * route handler sees it, which means a quote or a CRLF in it would be a quote or
 * a CRLF inside `Content-Disposition`. Real slugs are `[a-z0-9-]` by
 * construction (`buildTalentSlug`), so this strips nothing from an honest one.
 *
 * The extension follows the FORMAT rather than being fixed, so a browser viewer's
 * own save button never offers to write markup into a `.pdf`.
 */
export function resumeFileName(slug: string, format: ResumeFormat = "pdf"): string {
  const stem = stripDiacritics(slug.toLocaleLowerCase("es"))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem ? `curriculum-${stem}.${format}` : `curriculum.${format}`;
}

/**
 * The response headers for a served résumé.
 *
 * Everything in `SECURITY_HEADER_NAMES` is identical for every combination of
 * delivery and format, because those three are where "a preview is the same
 * disclosure as a download" is expressed. Only the two headers that describe the
 * bytes — the media type and the disposition — are allowed to vary, plus the CSP
 * that the HTML format alone carries.
 */
export function resumeResponseHeaders(input: {
  slug: string;
  delivery: ResumeDelivery;
  format: ResumeFormat;
  byteLength: number;
}): Record<string, string> {
  // The filename rides along in inline mode too: it is what the browser viewer's
  // own save button suggests, which is the whole point of not needing ours.
  const disposition = `${input.delivery}; filename="${resumeFileName(input.slug, input.format)}"`;
  const headers: Record<string, string> = {
    "Content-Type": input.format === "html" ? "text/html; charset=utf-8" : "application/pdf",
    "Content-Disposition": disposition,
    "Content-Length": String(input.byteLength),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  };
  // Only the HTML is an active document, and only it needs the policy. See the
  // note on HTML_CSP for why this is not put on the PDF "just in case".
  if (input.format === "html") headers["Content-Security-Policy"] = HTML_CSP;
  return headers;
}

/**
 * A refusal an employer can read, for the inline path only.
 *
 * The preview is an `<iframe>`, so its content is rendered as a PAGE. The JSON
 * envelope every other route returns would appear inside the frame as literal
 * `{"error":{"code":"rate_limited",…}}` — and the 429 is the refusal an honest
 * employer is most likely to meet, since a preview now spends a reveal the same
 * way a download does. Hence HTML, and hence self-contained: the frame is a
 * separate document with none of the app's CSS.
 */
export function resumePreviewRefusalHtml(message: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Currículum no disponible</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f7f7f5;color:#1f2933;
       font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  div{max-width:26rem;padding:2rem;text-align:center}
  p{margin:0}
</style></head>
<body><div><p>${escapeHtml(message)}</p></div></body></html>`;
}

/** Minimal escaping. The message is ours, but it is not worth being one edit away. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
