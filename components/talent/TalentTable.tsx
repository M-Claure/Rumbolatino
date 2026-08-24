import Link from "next/link";
import type { TalentProfilePublic } from "@/types";
import { YEARS_BUCKET_LABELS, labelForCategory } from "@/lib/talent/taxonomy";

/**
 * The directory as a table — one row per candidate, scannable top to bottom.
 *
 * Cards were the wrong shape for this audience. An employer compares people on
 * the same handful of attributes, and a grid of tiles makes you re-find each one
 * in a different place on every card. Fixed columns let the eye run straight down.
 *
 * ── No client JavaScript at all ─────────────────────────────────────────────
 * The CV column is a plain `<a>`. The route sets `Content-Disposition:
 * attachment`, so the browser downloads it — no fetch, no blob, no state. This
 * component was a Client Component with a modal and an identify-first form until
 * downloads were opened to everyone; with the gate gone there is nothing left
 * for JavaScript to do, so it went back to being a Server Component.
 *
 * Be clear about the trade that made this possible: the résumé carries the
 * person's full name, email and phone, so this column hands those to anyone with
 * the page. That is the product decision (see the route's own note); the people
 * listed here are told exactly what employers will see before they opt in.
 */
export function TalentTable({ profiles }: { profiles: TalentProfilePublic[] }) {
  return (
    // Wide content scrolls inside its own container so the page body never
    // scrolls sideways on a phone.
    <div className="overflow-x-auto rounded-2xl border border-border bg-white">
      <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-panel">
            <Th>Nombre</Th>
            <Th>Ubicación</Th>
            <Th>Industria</Th>
            <Th>Experiencia</Th>
            <Th>Currículum</Th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => {
            const place = [p.city, p.state].filter(Boolean).join(", ");
            return (
              <tr key={p.slug} className="border-b border-border last:border-0 hover:bg-panel/50">
                <td className="px-4 py-3 align-top">
                  <Link
                    href={`/talento/${p.slug}`}
                    className="font-semibold text-accent-dark hover:underline"
                  >
                    {p.displayName}
                  </Link>
                  {p.headline && <div className="text-xs text-text-secondary">{p.headline}</div>}
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="text-text-primary">{place || "—"}</div>
                  {/* Rounded to whole miles on purpose: it is measured between
                      ZIP-area centroids, so "a 12 millas" is honest and
                      "a 12.4 millas" is not. */}
                  {typeof p.distanceMiles === "number" && (
                    <div className="text-xs text-text-secondary">
                      a {Math.round(p.distanceMiles)} millas
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 align-top text-text-primary">
                  {labelForCategory(p.category)}
                </td>
                <td className="px-4 py-3 align-top text-text-secondary">
                  {YEARS_BUCKET_LABELS[p.yearsBucket]}
                </td>
                <td className="px-4 py-3 align-top">
                  <a
                    href={`/api/talent/${encodeURIComponent(p.slug)}/resume`}
                    className="inline-block whitespace-nowrap rounded-full bg-accent px-4 py-2 text-xs font-semibold text-accent-on transition hover:bg-accent-hover"
                  >
                    Descargar PDF
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide text-text-secondary">
      {children}
    </th>
  );
}
