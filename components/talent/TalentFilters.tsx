"use client";

import { useState } from "react";
import { CATEGORY_OPTIONS, AVAILABILITY_LABELS } from "@/lib/talent/taxonomy";
import { TALENT_AVAILABILITIES } from "@/types/talent";
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
