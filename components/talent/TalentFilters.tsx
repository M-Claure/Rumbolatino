"use client";

import { useState } from "react";
import { AVAILABILITY_LABELS, CATEGORY_OPTIONS } from "@/lib/talent/taxonomy";
import { TALENT_AVAILABILITIES } from "@/types";
import type { TalentSearchFilters } from "@/types";
import { UseMyLocation } from "@/components/UseMyLocation";
import { MetroPicker } from "@/components/talent/MetroPicker";

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
 * ── The two location controls, and why there are two ───────────────────────
 * `Ciudad o área metropolitana` and `Código postal` + `Distancia` answer
 * different questions and compose as an AND. The metro is a labour market — OMB
 * defines it from commuting data, so "the Houston area" is nine counties and
 * needs no distance chosen. The radius is "within this drive of here", which is
 * what somebody hiring for one shop floor actually means. An employer who fills
 * in both wants the intersection and gets it.
 *
 * The metro deliberately does NOT quietly add a radius of its own around the
 * metro's centre to catch people just outside the boundary. That was considered
 * and rejected: a CBSA already reaches well past the city line, and the control
 * for "a bit further out" is the one right next to it, where the employer sets
 * the number and can see what it did.
 *
 * ── The availability dropdown is BACK, because the data is now real ────────
 * It was removed for being empty rather than unsafe: `talent-publish.ts` used to
 * stamp every listing `flexible` to satisfy a not-null column, so three of the
 * four options returned nobody and the fourth returned everyone — a control that
 * looks like it narrows a search and does not. The instruction left behind was
 * "if the funnel ever asks for a start date, put the dropdown back rather than
 * inventing a second capture surface here", and that is what happened: the
 * publish popup asks it.
 *
 * One thing to expect while this beds in. Listings published before the question
 * existed hold NULL, not `flexible` (`0018`), and NULL matches no availability
 * filter — `t.availability = p_availability` is false for them. So choosing any
 * option hides every legacy listing until its owner re-publishes. That is the
 * honest behaviour and the reason the column is nullable: the alternative was
 * leaving those rows claiming a start date nobody gave us. Expect this filter to
 * return few people at first and more over time.
 */
export function TalentFilters({
  filters,
  zip = "",
  radius,
  metro = "",
}: {
  filters: TalentSearchFilters;
  /** The ZIP the current results were centred on, echoed back into the box. */
  zip?: string;
  radius?: number;
  /**
   * The metro to echo back — the RESOLVED title when it resolved, otherwise the
   * words the employer typed. Either way it is what they should see in the box:
   * replacing "Houston" with nothing would hide the input the page is about to
   * comment on.
   */
  metro?: string;
}) {
  // Held in state only so the locate button can fill it in; the form still
  // submits as a plain GET, so the search remains a shareable URL.
  const [zipValue, setZipValue] = useState(zip);
  const [place, setPlace] = useState<string | null>(null);

  const field =
    "mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent";

  return (
    <form method="GET" action="/empleadores" className="rounded-2xl border border-border bg-white p-4">
      {/* Six columns, filled as 3+3 then 2+2+2: the two free-text boxes get the
          width they need on the first row, and the three narrow controls share
          the second. Nothing here should wrap to a stray third row. */}
      <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
        <div className="lg:col-span-3">
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

        {/*
          A metro area, by name. This is the control that answers "who works in
          the Houston area" — the question `0011` left with no answer when it
          removed the city text filters, correctly, because a CITY name is a
          municipal boundary that stops before Katy, Pasadena and Sugar Land. A
          CBSA does not: it is the whole commuting region, maintained by OMB.

          It submits the metro's own TITLE, not a code, so the box works with no
          JavaScript and the resulting URL says what it filtered by — see
          `MetroPicker`.
        */}
        <div className="lg:col-span-3">
          <label className="block">
            <span className="text-sm font-semibold text-text-primary">
              Ciudad o área metropolitana
            </span>
            <MetroPicker defaultValue={metro} className={field} />
          </label>
          <p className="mt-1 text-xs leading-snug text-text-secondary">
            Escribe una ciudad y elige el área que aparezca. Incluye a las poblaciones
            vecinas desde donde se viaja a trabajar.
          </p>
        </div>

        <label className="block lg:col-span-2">
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

        {/* ZIP + radius: "within this drive of here", which is a different
            question from "in this labour market" and composes with it. */}
        <label className="block lg:col-span-2">
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

        <label className="block lg:col-span-2">
          <span className="text-sm font-semibold text-text-primary">Disponibilidad</span>
          <select
            name="availability"
            defaultValue={filters.availability ?? ""}
            className={field}
          >
            <option value="">Cualquiera</option>
            {TALENT_AVAILABILITIES.map((option) => (
              <option key={option} value={option}>
                {AVAILABILITY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <label className="block lg:col-span-2">
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
