import Link from "next/link";
import type { TalentProfilePublic } from "@/types";
import { YEARS_BUCKET_LABELS, labelForCategory } from "@/lib/talent/taxonomy";
import { ResumePreview } from "@/components/talent/ResumePreview";

/**
 * The directory as a table — one row per candidate, scannable top to bottom.
 *
 * Cards were the wrong shape for this audience. An employer compares people on
 * the same handful of attributes, and a grid of tiles makes you re-find each one
 * in a different place on every card. Fixed columns let the eye run straight down.
 *
 * ── Still a Server Component; the CV column is the one exception ────────────
 * The résumé cell renders `ResumePreview`, which is a Client Component because
 * reading a résumé in place needs a dialog. Nothing else here does: the rest of
 * the row is text and links, so the table itself stays server-rendered and the
 * interactive part is scoped to one cell.
 *
 * ── Reading beats downloading, so it is the primary button ──────────────────
 * Choosing whom to call takes ten seconds of looking at a résumé. When the only
 * way to look was to download, an employer comparing six people collected six
 * PDFs and wanted one — and those files outlive the listing and any later
 * decision to unpublish. "Ver currículum" leaves nothing behind; "Descargar PDF"
 * is still right there for the résumé they mean to keep. Both spend the same
 * `contact_reveal` allowance and are logged the same way, because both hand over
 * the same bytes — see `ResumePreview` and the route.
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
                  <ResumePreview slug={p.slug} name={p.displayName} variant="compact" />
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
