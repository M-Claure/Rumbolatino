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
 *    `contact_reveals` audit row — see the route. Only the disposition differs.
 *    A cheaper preview would be a hole drilled straight through the one limit in
 *    this product that protects people rather than infrastructure.
 *  - **The filename is the employer's copy.** It is built from the slug, not
 *    from the route parameter as it arrived, so a path segment can never reach a
 *    response header.
 *  - **Framing is only a question in inline mode**, and the answer has to be
 *    "our own pages, nobody else's".
 *
 * Pure: no I/O, no `server-only`, no Next imports.
 * `tests/unit/talent-resume-delivery.test.ts` pins the header set, which is the
 * only practical guard on it — the route itself needs a session, a service role
 * and a stored PDF to reach this point.
 */

/** `inline` renders in the browser's own viewer; `attachment` downloads. */
export type ResumeDelivery = "inline" | "attachment";

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
 */
export function resumeFileName(slug: string): string {
  const stem = stripDiacritics(slug.toLocaleLowerCase("es"))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem ? `curriculum-${stem}.pdf` : "curriculum.pdf";
}

/**
 * The response headers for a served résumé.
 *
 * `no-store` because a shared cache must never hold somebody's résumé, and
 * `nosniff` because the only correct reading of these bytes is the one we
 * declared. `SAMEORIGIN` allows the preview frame on our own pages and refuses
 * to let another site put a candidate's PDF inside its own chrome.
 */
export function resumeResponseHeaders(input: {
  slug: string;
  delivery: ResumeDelivery;
  byteLength: number;
}): Record<string, string> {
  // The filename rides along in inline mode too: it is what the browser viewer's
  // own save button suggests, which is the whole point of not needing ours.
  const disposition = `${input.delivery}; filename="${resumeFileName(input.slug)}"`;
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": disposition,
    "Content-Length": String(input.byteLength),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  };
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
