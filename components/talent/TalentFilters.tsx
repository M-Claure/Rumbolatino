"use client";

import { useState } from "react";
import { CATEGORY_OPTIONS } from "@/lib/talent/taxonomy";
import type { TalentSearchFilters } from "@/types";
import { UseMyLocation } from "@/components/UseMyLocation";

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
 *
 * No free-text search over the résumé itself, since `0014`. The box in this form
 * is a NAME box; searching by trade is the `Área` dropdown, a closed list derived from
 * each résumé rather than words the person happened to type. What that gives up
 * — a specific skill or certification is no longer reachable as text — is
 * written down in the migration. If it needs answering, the answer is a second
 * closed-list control, not free text merged back into the name box.
 *
 * No AVAILABILITY dropdown either, and that one is a different argument: it is
 * not unsafe, it is empty. `talent-publish.ts` stamps every listing `flexible`
 * because the publish step is one checkbox and nobody is asked for a start date,
 * so three of the four options returned nobody and the fourth returned everyone
 * — a control that looks like it narrows a search and does not. The filter still
 * exists below the UI (`TalentSearchQuery`, `talent_search`), so a URL carrying
 * `?availability=` keeps working; if the funnel ever asks for a start date, put
 * the dropdown back rather than inventing a second capture surface here.
 */
export function TalentFilters({
  filters,
  zip = "",
  radius,
}: {
  filters: TalentSearchFilters;
  /** The ZIP the current results were centred on, echoed back into the box. */
  zip?: string;
  radius?: number;
}) {
  // Held in state only so the locate button can fill it in; the form still
  // submits as a plain GET, so the search remains a shareable URL.
  const [zipValue, setZipValue] = useState(zip);
  const [place, setPlace] = useState<string | null>(null);

  const field =
    "mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent";

  return (
    <form method="GET" action="/empleadores" className="rounded-2xl border border-border bg-white p-4">
      <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {/*
          This box takes ONE thing: a person's name (`0014`). Saying so is not
          optional. A lone box labelled "Buscar" does not say what it searches,
          and the plausible guesses on a hiring site — empleos, empresas,
          personas — are all things it could plausibly hold; guessing wrong
          returns nothing, silently, which reads as an empty directory rather
          than a mis-aimed query. So the label names the input and the help text
          says where to search by trade instead, because that capability moved
          rather than disappearing: it is the `Área` dropdown to the right.

          The placeholder is a NAME, only. It used to read "María González,
          cocinera, HVAC…" and a stale example here is worse than none — it is an
          instruction to type something that now matches nobody.

          The help text promises whole names and delivers partials too
          (`mcv_talent_name_query` appends `:*` to every token, so `gonz` finds
          González). Keep that asymmetry in this direction if the copy changes
          again: promising less than the search does is safe, the reverse is not.
        */}
        <div className="lg:col-span-2">
          <label className="block">
            <span className="text-sm font-semibold text-text-primary">
              Buscar una persona por su nombre
            </span>
            <input
              type="search"
              name="query"
              defaultValue={filters.query ?? ""}
              placeholder="María González"
              maxLength={120}
              aria-describedby="talent-query-help"
              className={field}
            />
          </label>
          <p id="talent-query-help" className="mt-1 text-xs leading-snug text-text-secondary">
            Solo busca nombres y apellidos. Para buscar por oficio, deja esta casilla vacía y
            elige un <strong>Área</strong>.
          </p>
        </div>

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

        {/* ZIP + radius instead of a city name. Typing "Houston" used to miss
            everyone in Katy, Pasadena and Sugar Land — people who are a short
            drive away and are exactly who an employer wants to see. */}
        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Código postal</span>
          <input
            type="text"
            name="zip"
            inputMode="numeric"
            autoComplete="postal-code"
            value={zipValue}
            onChange={(e) => setZipValue(e.target.value)}
            placeholder="77002"
            maxLength={10}
            className={field}
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Distancia</span>
          <select name="radius" defaultValue={String(radius ?? 25)} className={field}>
            <option value="10">Hasta 10 millas</option>
            <option value="25">Hasta 25 millas</option>
            <option value="50">Hasta 50 millas</option>
            <option value="100">Hasta 100 millas</option>
            <option value="500">Cualquier distancia</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <button
          type="submit"
          className="inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover"
        >
          Buscar
        </button>
        <a href="/empleadores" className="px-3 py-3 text-sm font-medium text-accent-dark hover:underline">
          Limpiar
        </a>
        <div className="w-full">
          <UseMyLocation
            label="Usar mi ubicación"
            onResolved={({ postalCode, place: p }) => {
              setZipValue(postalCode);
              setPlace(p);
            }}
          />
          {place && (
            <p className="mt-1 text-sm text-text-secondary">
              Buscando cerca de <strong>{place}</strong>. Pulsa Buscar.
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
