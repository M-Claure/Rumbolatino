"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Read a candidate's résumé without collecting a file.
 *
 * ── Why a preview is the primary action now ─────────────────────────────────
 * Deciding whether to call somebody takes ten seconds of looking at their
 * résumé, and the only way to do that used to be to download it. So an employer
 * comparing six people ended up with six PDFs in their Downloads folder, five of
 * which they did not want — and every one of those files outlives the listing,
 * the session and any decision the person later makes to unpublish. Reading in
 * place leaves nothing behind. "Descargar PDF" is still one click away, for the
 * employer who is actually going to keep it.
 *
 * ── It costs a reveal anyway, and that is on purpose ────────────────────────
 * The frame fetches the same bytes as the download, so it spends the same
 * `contact_reveal` allowance and writes the same `contact_reveals` row. A
 * preview that was cheaper than a download would be a way around the one limit
 * in this product that protects people rather than infrastructure. What follows
 * is that the frame is mounted only when the employer actually opens it — never
 * eagerly on a page of 24 results — and stays mounted once opened, so closing
 * and reopening the same résumé does not spend a second one.
 *
 * Re-reading the same person no longer costs anything anyway: `0015` made the
 * route waive the charge when this employer was already given this profile
 * within `REVEAL_DEDUPE_MINUTES`, so the footer's new-tab link, a reload and a
 * second look are all free. The limit counts PEOPLE. That mattered most here —
 * charging per request meant an employer on a browser that needed the escape
 * hatch paid twice for one look.
 *
 * ── One dialog per row, not one per table ───────────────────────────────────
 * Keeping the state here is what lets `TalentTable` and `/talento/[slug]` remain
 * Server Components: they render this and nothing else changes. A single lifted
 * dialog would be a tidier DOM and would make the whole results table a Client
 * Component for it.
 *
 * ── The frame holds HTML, not a PDF, and the browser decided that ──────────
 * iOS Safari will not render a PDF inside an iframe. It hands PDFs to the system
 * viewer at the top-level navigation layer and does not expose that renderer to a
 * subframe, so this dialog used to come up blank on an iPhone — silently, because
 * the frame navigates fine, `onLoad` fires on schedule, and a native PDF handler
 * has no DOM to probe for "did anything paint". There is no reliable feature test
 * for it either.
 *
 * So `0015` stopped serving a PDF here. `?inline=1` now returns the résumé's own
 * HTML — literally what Chromium printed to make the PDF, snapshotted onto the
 * listing at publish time — which renders in every browser, stays selectable and
 * zoomable on a phone, and reflows instead of demanding a pinch. "Descargar PDF"
 * is untouched: that is the document an employer keeps.
 *
 * ── The escape hatch is still not decoration ───────────────────────────────
 * A listing published before `0015` has no HTML snapshot, so its preview is
 * still a framed PDF and can still fail the old way. The footer link is
 * therefore kept and still shown unconditionally rather than on a guess — the
 * detection problem did not become solvable, it just stopped applying to most
 * listings. Following it costs no extra reveal — see the reveal note above.
 *
 * ── No `sandbox` attribute, deliberately ───────────────────────────────────
 * The obvious hardening for a framed document built from user text, and the
 * wrong tool here: `sandbox` without `allow-scripts` breaks the browser's own
 * PDF viewer, which is precisely the fallback path above. The protection lives
 * on the response instead — `resumeResponseHeaders` sends the HTML with
 * `default-src 'none'; style-src 'unsafe-inline'`, which binds the document
 * itself rather than the frame around it, and leaves the PDF response alone.
 */
export function ResumePreview({
  slug,
  name,
  variant = "full",
}: {
  slug: string;
  name: string;
  /** `compact` is the directory table's cell; `full` is the profile page. */
  variant?: "full" | "compact";
}) {
  /** Has it ever been opened? Gates whether the frame exists at all. */
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const base = `/api/talent/${encodeURIComponent(slug)}/resume`;
  const previewUrl = `${base}?inline=1`;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    // The page behind must not scroll under the overlay — on a phone the frame
    // fills the screen and a stray swipe otherwise moves the results list.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function show() {
    setMounted(true);
    setOpen(true);
  }

  function hide() {
    setOpen(false);
    // Back to the button that opened it, or a keyboard user is dropped at the
    // top of the document with their place in the table lost.
    openerRef.current?.focus();
  }

  const compact = variant === "compact";

  return (
    <>
      <div className={compact ? "flex flex-col items-start gap-1" : "mt-4 flex flex-wrap gap-2"}>
        <button
          ref={openerRef}
          type="button"
          onClick={show}
          className={
            compact
              ? "whitespace-nowrap rounded-full bg-accent px-4 py-2 text-xs font-semibold text-accent-on transition hover:bg-accent-hover"
              : "inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover"
          }
        >
          Ver currículum
        </button>
        <a
          href={base}
          className={
            compact
              ? "whitespace-nowrap px-1 text-xs font-medium text-accent-dark hover:underline"
              : "inline-flex items-center justify-center rounded-full border border-border bg-white px-6 py-3 text-sm font-semibold text-text-primary transition hover:bg-gray-50"
          }
        >
          Descargar PDF
        </a>
      </div>

      {/* No JavaScript: the preview URL is a page in its own right, so the
          résumé is still reachable without the button. */}
      <noscript>
        <a href={previewUrl} className="text-xs font-medium text-accent-dark hover:underline">
          Ver el currículum
        </a>
      </noscript>

      {mounted && (
        <div
          className={`fixed inset-0 z-50 flex flex-col bg-black/60 sm:p-6 ${open ? "" : "hidden"}`}
          role="dialog"
          aria-modal="true"
          aria-label={`Currículum de ${name}`}
          // Clicking the darkened area closes, the way every other dialog on the
          // web does. Guarded on the target so a click inside the panel — or a
          // drag that ends on the backdrop while selecting text — does not.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) hide();
          }}
        >
          <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden bg-white sm:rounded-2xl sm:shadow-xl">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-text-primary">{name}</p>
                <p className="text-xs text-text-secondary">Currículum</p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={base}
                  className="whitespace-nowrap rounded-full border border-border bg-white px-4 py-2 text-xs font-semibold text-text-primary transition hover:bg-gray-50"
                >
                  Descargar PDF
                </a>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={hide}
                  className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-xs font-semibold text-accent-on transition hover:bg-accent-hover"
                >
                  Cerrar
                </button>
              </div>
            </header>

            <div className="relative min-h-0 flex-1 bg-panel">
              {!loaded && (
                <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-text-secondary">
                  Cargando el currículum…
                </p>
              )}
              <iframe
                src={previewUrl}
                title={`Currículum de ${name}`}
                onLoad={() => setLoaded(true)}
                className="h-full w-full border-0"
              />
            </div>

            <footer className="border-t border-border px-4 py-2 text-xs leading-snug text-text-secondary">
              ¿No se muestra aquí?{" "}
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-dark hover:underline"
              >
                Ábrelo en otra pestaña
              </a>
              . No cuenta como una segunda consulta.
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
