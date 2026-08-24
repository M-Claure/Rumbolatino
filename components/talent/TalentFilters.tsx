import { CATEGORY_OPTIONS, AVAILABILITY_LABELS } from "@/lib/talent/taxonomy";
import { TALENT_AVAILABILITIES } from "@/types/talent";
import type { TalentSearchFilters } from "@/types";

/**
 * The directory's filter bar.
 *
 * A plain `<form method="GET">`, deliberately: it needs no client JavaScript, it
 * puts the search in the URL so a recruiter can bookmark or share one, and it
 * works on a slow connection and in a screen reader without a hydration step.
 * A directory is a set of links over a set of query parameters — that is what
 * the platform already does well.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 * No age range, no photo toggle, no "years since graduation", no nationality or
 * language-as-origin filter. This product does not collect any of that, and a
 * filter would be a back door into the same information — see the filter
 * discipline note in `lib/talent/taxonomy.ts` before adding a field.
 */
export function TalentFilters({ filters }: { filters: TalentSearchFilters }) {
  const field =
    "mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent";

  return (
    <form method="GET" action="/empleadores" className="rounded-2xl border border-border bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block lg:col-span-2">
          <span className="text-sm font-semibold text-text-primary">Buscar</span>
          <input
            type="search"
            name="query"
            defaultValue={filters.query ?? ""}
            placeholder="cocinera, electricista, manicure…"
            maxLength={120}
            className={field}
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Área</span>
          <select name="category" defaultValue={filters.category ?? ""} className={field}>
            <option value="">Todas</option>
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Ciudad</span>
          <input
            type="text"
            name="city"
            defaultValue={filters.city ?? ""}
            placeholder="Houston"
            maxLength={120}
            className={field}
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Estado</span>
          <input
            type="text"
            name="state"
            defaultValue={filters.state ?? ""}
            placeholder="TX"
            maxLength={60}
            className={field}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-[14rem] flex-1">
          <span className="text-sm font-semibold text-text-primary">Disponibilidad</span>
          <select name="availability" defaultValue={filters.availability ?? ""} className={field}>
            <option value="">Cualquiera</option>
            {TALENT_AVAILABILITIES.map((a) => (
              <option key={a} value={a}>
                {AVAILABILITY_LABELS[a]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover"
        >
          Buscar
        </button>
        <a href="/empleadores" className="px-3 py-3 text-sm font-medium text-accent-dark hover:underline">
          Limpiar
        </a>
      </div>
    </form>
  );
}
