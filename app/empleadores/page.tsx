import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { getBrandConfig } from "@/lib/brand/registry";
import { getActiveBrandId } from "@/lib/brand/server";
import { originForZip, searchDirectorySafely } from "@/lib/services/talent-directory";
import { TalentSearchQuery } from "@/lib/validation/api-schemas";
import { TalentTable } from "@/components/talent/TalentTable";
import { TalentFilters } from "@/components/talent/TalentFilters";
import type { TalentSearchFilters } from "@/types";

export const dynamic = "force-dynamic";

/**
 * The employer side: a searchable directory of people who chose to be found.
 *
 * ── Indexing ────────────────────────────────────────────────────────────────
 * THIS page is indexable — it is how an employer discovers the directory at all,
 * and it lists nobody in particular above the fold that a crawler could harvest
 * as a person. Individual profiles at `/talento/[slug]` are `noindex`, so being
 * findable on Google never turns into being bulk-downloadable from it.
 *
 * ── Why the results are read server-side ───────────────────────────────────
 * Through `searchDirectorySafely`, which carries the same rate limit and the
 * same analytics as `/api/talent/search` — the page must not be a way around the
 * guard its own API has. "Safely" because this is a public URL: an unconfigured
 * directory or a tripped limit should render an explanation, not a 500.
 */

export function generateMetadata(): Metadata {
  const brand = getBrandConfig(getActiveBrandId());
  return {
    title: `Contrata talento | ${brand.name}`,
    description:
      "Busca personas capacitadas y listas para trabajar: por nombre, por oficio, habilidad o " +
      "certificación, por cercanía y por disponibilidad.",
  };
}

export default async function EmpleadoresPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Anything not on the schema is dropped rather than passed through; a bad
  // value falls back to an unfiltered search instead of erroring a public page.
  const parsed = TalentSearchQuery.safeParse(searchParams);
  const raw = parsed.success ? parsed.data : {};
  const { zip, radius, ...rest } = raw;

  const origin = originForZip(zip, radius);
  // A ZIP that was typed but not recognised: the search still runs without a
  // radius, and the page says so rather than showing an empty list that looks
  // like "nobody is near you".
  const badZip = Boolean(zip) && origin === null;

  const filters: TalentSearchFilters = { ...rest, ...(origin ?? {}) };
  const result = await searchDirectorySafely({ ...filters, limit: 24 }, headers());

  return (
    <main className="mx-auto flex min-h-page max-w-5xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
          Encuentra a quien necesitas
        </h1>
        {/*
          What this page searches is stated before the form, not left to the box.
          The previous wording pointed at a city filter that `0011` removed and
          promised an identification step that no longer exists, so the two
          sentences an employer read first described a different page.
        */}
        <p className="max-w-2xl text-base leading-snug text-text-secondary">
          Aquí se buscan <strong>personas</strong>, no empleos: cada una terminó su currículum y
          pidió aparecer en esta lista. Busca por su nombre si ya sabes a quién quieres, o por el
          oficio, la habilidad o la certificación que necesitas, y acota por cercanía y
          disponibilidad. Su currículum se descarga sin registrarte.
        </p>
      </header>

      <TalentFilters filters={filters} zip={zip ?? ""} radius={radius} />

      {badZip && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No reconocimos el código postal <strong>{zip}</strong>. Revísalo, o busca sin él.
        </p>
      )}

      {result === null ? (
        <EmptyState
          icon="⚠️"
          title="No pudimos cargar el directorio"
          body="Hubo un problema de nuestro lado. Vuelve a intentarlo en un momento."
        />
      ) : result.total === 0 ? (
        <EmptyState
          icon="🔍"
          title="No encontramos a nadie con esos filtros"
          body="Revisa cómo escribiste el nombre, prueba con menos filtros o una distancia mayor, o elige solo un área y mira quién hay."
        />
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {result.total === 1
              ? "1 persona encontrada"
              : `${result.total} personas encontradas`}
          </p>
          <TalentTable profiles={result.profiles} />
          {result.total > result.profiles.length && (
            <Pager
              filters={filters}
              zip={zip}
              radius={radius}
              shown={result.profiles.length}
              total={result.total}
            />
          )}
        </>
      )}

      {/*
        The only link between the two sides, and it points employer → builder,
        never the other way: nothing on the résumé builder links here.
      */}
      <footer className="mt-4 border-t border-border pt-6">
        <p className="text-sm text-text-secondary">
          ¿Buscas trabajo?{" "}
          <Link href="/" className="font-medium text-accent-dark hover:underline">
            Crea tu currículum gratis
          </Link>{" "}
          y aparece en esta lista.
        </p>
      </footer>
    </main>
  );
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-white px-6 py-12 text-center">
      <span className="text-3xl" aria-hidden>
        {icon}
      </span>
      <p className="text-base font-bold text-text-primary">{title}</p>
      <p className="max-w-md text-sm leading-snug text-text-secondary">{body}</p>
    </div>
  );
}

/**
 * Offset paging as plain links, matching the form above: the whole state of this
 * page lives in the query string, so a page of results can be shared as a URL.
 */
function Pager({
  filters,
  zip,
  radius,
  shown,
  total,
}: {
  filters: TalentSearchFilters;
  zip?: string;
  radius?: number;
  shown: number;
  total: number;
}) {
  const offset = filters.offset ?? 0;
  const params = (next: number) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      // `latitude`/`longitude` are derived from the ZIP on every request, so the
      // URL carries the ZIP the employer typed instead — shareable and readable.
      if (["offset", "limit", "latitude", "longitude", "radiusMiles"].includes(key)) continue;
      if (value === undefined || value === null || value === "") continue;
      q.set(key, String(value));
    }
    if (zip) q.set("zip", zip);
    if (radius) q.set("radius", String(radius));
    if (next > 0) q.set("offset", String(next));
    return `/empleadores?${q.toString()}`;
  };

  return (
    <nav className="flex items-center justify-between gap-4 text-sm">
      {offset > 0 ? (
        <Link href={params(Math.max(offset - 24, 0))} className="font-medium text-accent-dark hover:underline">
          ← Anteriores
        </Link>
      ) : (
        <span />
      )}
      <span className="text-text-secondary">
        {offset + 1}–{offset + shown} de {total}
      </span>
      {offset + shown < total ? (
        <Link href={params(offset + 24)} className="font-medium text-accent-dark hover:underline">
          Siguientes →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
