import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getBrandConfig } from "@/lib/brand/registry";
import { getActiveBrandId } from "@/lib/brand/server";
import { resolveSearchFilters, searchDirectorySafely } from "@/lib/services/talent-directory";
import { TalentSearchQuery, type TalentSearchParams } from "@/lib/validation/api-schemas";
import { TalentTable } from "@/components/talent/TalentTable";
import { TalentFilters } from "@/components/talent/TalentFilters";
import { TalentMap } from "@/components/talent/TalentMap";
import { groupByLocation } from "@/lib/talent/map-pins";
import { EmployerBar } from "@/components/employers/EmployerBar";
import { DirectoryUnavailable } from "@/components/employers/DirectoryUnavailable";
import { checkEmployerGate } from "@/lib/employers/session";
import { EMPLOYER_COOKIE_NAME } from "@/lib/employers/constants";
import { nameSearchTokens } from "@/lib/talent/text";
import type { TalentSearchFilters } from "@/types";

export const dynamic = "force-dynamic";

/**
 * The employer side: a searchable directory of people who chose to be found.
 *
 * ── Signed-in employers only ────────────────────────────────────────────────
 * Every request here needs a verified employer session; without one it redirects
 * to `/empleadores/acceso`. The redirect happens before `searchDirectorySafely`
 * is reached, and that function requires the session object anyway, so there is
 * no ordering mistake that can render a candidate to a stranger.
 *
 * ── Indexing: this page is now noindex, the WALL is indexable ────────────────
 * It used to be the indexable discovery surface. It cannot be both gated and
 * crawlable — a crawler has no account — and a page that renders a login wall to
 * Google is worse than useless in an index. So `/empleadores/acceso` took over
 * that job: it describes the service and lists nobody. Individual profiles at
 * `/talento/[slug]` were already `noindex` and stay that way.
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
    robots: { index: false, follow: false },
    description:
      "Busca personas capacitadas y listas para trabajar: por su nombre, por área de trabajo, " +
      "por área metropolitana y por cercanía.",
  };
}

export default async function EmpleadoresPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // The gate. `anonymous` gets a `redirect()` rather than a 404 or a wall
  // rendered in place: the employer may simply have been signed out by an
  // expired session, and the access page can say so and take them straight back.
  // `misconfigured` must NOT redirect there — see `DirectoryUnavailable`.
  const gate = await checkEmployerGate();
  if (gate.status === "misconfigured") return <DirectoryUnavailable />;
  if (gate.status === "anonymous") {
    // "Never signed in" and "signed in, and it lapsed" are the same refusal but
    // not the same message. A returning employer whose session simply aged out
    // reads "entra con tu cuenta" as though their account were gone; saying the
    // session expired tells them nothing is wrong and they only have to type a
    // password. The cookie's presence is the tell, and it is only a hint — an
    // expired or revoked session leaves the cookie behind, which is exactly the
    // case being named.
    const lapsed = cookies()
      .getAll()
      .some((cookie) => cookie.name.startsWith(EMPLOYER_COOKIE_NAME));
    redirect(
      `/empleadores/acceso?estado=${lapsed ? "sesion_expirada" : "sesion_requerida"}`,
    );
  }
  // Signed in but the mailbox is unproven. A distinct destination from
  // "anonymous": telling someone to sign in when they already are is a loop, and
  // the access page can offer to send the link again instead.
  if (gate.status === "unverified") {
    redirect(`/empleadores/verifica-tu-correo?correo=${encodeURIComponent(gate.email)}`);
  }
  const employer = gate.session;

  // Anything not on the schema is dropped rather than passed through. A bad
  // value costs the employer THAT filter and nothing else — see the note on
  // `parseFilters`, which is where this page's search box was quietly broken.
  const { filters: raw, ignored } = parseFilters(searchParams);
  const { zip, radius } = raw;

  // ZIP → origin and `metro=` → a CBSA code both happen in the service, so this
  // page and `/api/talent/search` cannot end up disagreeing about what a query
  // string means. `metro` comes back with three possible readings, each of which
  // gets its own sentence below.
  const { filters, metro, badZip } = resolveSearchFilters(raw);
  const result = await searchDirectorySafely({ ...filters, limit: 24 }, headers(), employer);

  // "Nobody matched what you asked for" and "nobody has published yet" are the
  // same empty table and completely different news. Telling an employer to try
  // fewer filters when they used none sends them looking for a mistake they did
  // not make; a typed ZIP counts even when it did not resolve, since that is
  // still someone having narrowed the search.
  const searched = Boolean(raw.query || raw.category || raw.availability || zip || raw.metro);

  // A query where nothing survives the two-character floor in
  // `mcv_talent_name_query` matches nobody, deliberately — a one-letter prefix
  // covers most of any name column, so answering it with the whole directory
  // would be a page-out dressed up as a result (see `0014`). Without this branch
  // the employer reads the generic "no encontramos a nadie", goes looking for
  // someone who is in fact listed, and never learns that one letter is not a
  // search.
  const tooShort = Boolean(raw.query) && nameSearchTokens(raw.query ?? "").length === 0;

  return (
    <main className="mx-auto flex min-h-page max-w-5xl flex-col gap-6 px-6 py-10">
      <EmployerBar email={employer.email} />

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
          Encuentra a quien necesitas
        </h1>
        {/*
          What this page searches is stated before the form, not left to the box.
          The previous wording pointed at a city filter that `0011` removed and
          promised an identification step that no longer exists, so the two
          sentences an employer read first described a different page. It named
          "disponibilidad" for the same reason and it went the same way when that
          dropdown was removed, and it promised free-text search over trades and
          certifications until `0014` narrowed the box to names — see the note in
          `TalentFilters`. This paragraph and `generateMetadata`'s description
          must both describe only what the bar actually does.
        */}
        <p className="max-w-2xl text-base leading-snug text-text-secondary">
          Aquí se buscan <strong>personas</strong>, no empleos: cada una terminó su currículum y
          pidió aparecer en esta lista. Si ya sabes a quién quieres, escribe su nombre; si no,
          elige un área de trabajo, una ciudad o área metropolitana, y acota por cercanía. Cada
          currículum que abras o descargues queda registrado a nombre de tu cuenta.
        </p>
      </header>

      <TalentFilters
        filters={filters}
        zip={zip ?? ""}
        radius={radius}
        /* The RESOLVED title when it resolved, so the box shows what the results
           were actually filtered by rather than the abbreviation typed. */
        metro={metro.status === "exact" ? metro.metro.title : (raw.metro ?? "")}
      />

      {ignored.length > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No entendimos {ignored.length === 1 ? "el filtro" : "los filtros"}{" "}
          <strong>{ignored.join(", ")}</strong>, así que {ignored.length === 1 ? "lo" : "los"}{" "}
          ignoramos. El resto de tu búsqueda sí se aplicó.
        </p>
      )}

      {badZip && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No reconocimos el código postal <strong>{zip}</strong>. Revísalo, o busca sin él.
        </p>
      )}

      {/*
        The metro, in the employer's own words back to them. Three outcomes and
        three messages, because they are three different situations and one
        shared message would misdescribe two of them:

          · resolved  — say WHICH area, since "Houston" is not what the results
                        were filtered by; `Houston-Pasadena-The Woodlands, TX` is,
                        and the difference is what tells them Katy is included.
          · ambiguous — offer the choices as links. Picking one for them would
                        answer a question they did not ask, and they would read
                        the results as though it had been theirs.
          · unknown   — admit it, exactly like the ZIP message above. Filtering
                        by nothing and showing the whole country would read as an
                        answer.
      */}
      {metro.status === "exact" && (
        <p className="rounded-xl border border-border bg-panel px-4 py-3 text-sm text-text-secondary">
          Mostrando el área de <strong className="text-text-primary">{metro.metro.title}</strong>,
          que incluye las poblaciones vecinas desde donde se viaja a trabajar.{" "}
          {/*
            A plain `<a>`, not `next/link`, and the same for the options below.
            `TalentFilters` is a native GET form, so a search is a document
            navigation and its inputs remount with the values the server just
            resolved. A client-side `Link` would update the results and leave the
            metro box holding whatever was typed before — "portland" above a
            table filtered to Portland, Oregon. `Limpiar` inside that form is a
            plain anchor for the same reason.
          */}
          <a href={clearParam(searchParams, "metro")} className="font-medium text-accent-dark hover:underline">
            Quitar
          </a>
        </p>
      )}

      {metro.status === "ambiguous" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p>
            Hay varias áreas que coinciden con <strong>{metro.typed}</strong>. Elige una — por
            ahora la búsqueda no está limitada por zona:
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {metro.options.map((option) => (
              <li key={option.code}>
                <a
                  href={withParam(searchParams, "metro", option.title)}
                  className="font-medium text-accent-dark hover:underline"
                >
                  {option.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {metro.status === "unknown" && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No reconocimos <strong>{metro.typed}</strong> como una ciudad o área metropolitana de
          Estados Unidos. Escribe el nombre de la ciudad y elige una de las opciones que
          aparezcan, o busca sin ese filtro.
        </p>
      )}

      {result === null ? (
        <EmptyState
          icon="⚠️"
          title="No pudimos cargar el directorio"
          body="Hubo un problema de nuestro lado. Vuelve a intentarlo en un momento."
        />
      ) : result.total === 0 && !searched ? (
        <EmptyState
          icon="🌱"
          title="Todavía no hay perfiles publicados"
          body="Cuando alguien termine su currículum y pida aparecer en la bolsa de talento, lo verás aquí."
        />
      ) : result.total === 0 ? (
        <EmptyState
          icon="🔍"
          /* The query is echoed back because "no encontramos a nadie" on its own
             reads as "the directory is empty". Seeing the words they typed is
             also how someone catches their own typo without re-opening the box.

             Three cases, not two: too short to be a search, a name nobody has,
             and filters that matched nobody. The first two used to share one
             message, and it sent an employer hunting for a typo in a query that
             was never run. Neither ever suggests typing a TRADE into this box —
             it has only searched names since `0014`, and the way to search by
             trade is the Área dropdown. */
          title={
            tooShort
              ? "Escribe al menos dos letras"
              : raw.query
                ? `No encontramos a nadie que se llame “${raw.query}”`
                : "No encontramos a nadie con esos filtros"
          }
          body={
            tooShort
              ? "Esta casilla busca nombres y apellidos, y necesita al menos dos letras. También puedes dejarla vacía y elegir un área de trabajo."
              : raw.query
                ? "Revisa cómo se escribe el nombre, prueba solo con el apellido, o borra el nombre y busca por área de trabajo."
                : "Prueba con menos filtros o una distancia mayor, o elige solo un área y mira quién hay."
          }
          action={{ href: "/empleadores", label: "Ver a todas las personas" }}
        />
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {result.total === 1
              ? "1 persona encontrada"
              : `${result.total} personas encontradas`}
          </p>
          {/*
            The map goes ABOVE the table, and does not replace it. The table is
            still how an employer compares people on the same few attributes —
            that argument has not changed. The map answers the one question a
            table is bad at: *where* are they, relative to each other and to the
            place hiring. Both read the same result set, so the count above
            describes both.
          */}
          {/* Grouped on the SERVER, so only the pins cross to the client — see
              the note in `TalentMap`. */}
          <TalentMap pins={groupByLocation(result.profiles)} />
          <TalentTable profiles={result.profiles} />
          {result.total > result.profiles.length && (
            <Pager
              filters={filters}
              zip={zip}
              radius={radius}
              metro={raw.metro}
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

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body: string;
  /** A way out of the empty state — never make clearing a search a back-button job. */
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-white px-6 py-12 text-center">
      <span className="text-3xl" aria-hidden>
        {icon}
      </span>
      <p className="text-base font-bold text-text-primary">{title}</p>
      <p className="max-w-md text-sm leading-snug text-text-secondary">{body}</p>
      {action && (
        <Link
          href={action.href}
          className="mt-2 font-medium text-accent-dark hover:underline"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}

/**
 * The current query string with one parameter replaced, or removed.
 *
 * Used by the metro messages: "Quitar" and each "did you mean" option have to
 * preserve the rest of the search, because dropping the category an employer
 * chose in order to answer a question about the city would be its own bug. The
 * offset goes with them — a new filter set starts at page one.
 */
function editedParams(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
  value: string | null,
): string {
  const q = new URLSearchParams();
  for (const [name, raw] of Object.entries(searchParams)) {
    if (name === key || name === "offset") continue;
    const single = Array.isArray(raw) ? raw[0] : raw;
    if (single) q.set(name, single);
  }
  if (value) q.set(key, value);
  const query = q.toString();
  return query ? `/empleadores?${query}` : "/empleadores";
}

const withParam = (
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
  value: string,
) => editedParams(searchParams, key, value);

const clearParam = (
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
) => editedParams(searchParams, key, null);

/**
 * Parse the query string, dropping ONLY the parameters that are genuinely bad.
 *
 * This used to be `parsed.success ? parsed.data : {}`, and that one line made the
 * search box unusable. `TalentFilters` is a plain GET form, so it submits every
 * control it renders — including `category=` when "Todas" is selected, which is
 * the default. That failed the schema, the fallback threw away the whole filter
 * set, and the page ran an UNFILTERED search: type a name nobody has, get the
 * entire directory back. Nothing errored and nothing was ever empty, which is
 * why it survived. `blankAsAbsent` in the schema is the actual fix; this is the
 * blast radius, and it is worth fixing separately.
 *
 * Widening a search on bad input is the wrong failure for this page. An employer
 * reads whatever comes back as the answer to what they asked, so showing them
 * everybody is worse than showing them nothing. Keep what parsed, drop what did
 * not, and say which — a bad `radius` should cost a radius, not a query.
 */
function parseFilters(searchParams: Record<string, string | string[] | undefined>): {
  filters: TalentSearchParams;
  /** Parameter names that were thrown away, so the page can admit to it. */
  ignored: string[];
} {
  const parsed = TalentSearchQuery.safeParse(searchParams);
  if (parsed.success) return { filters: parsed.data, ignored: [] };

  const ignored = [
    ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? ""))),
  ].filter(Boolean);

  const retry = TalentSearchQuery.safeParse(
    Object.fromEntries(
      Object.entries(searchParams).filter(([key]) => !ignored.includes(key)),
    ),
  );
  // A second failure would mean an issue with no path to attribute it to, which
  // this schema cannot produce. Falling back to no filters is right for that
  // case: it is the only remaining honest answer.
  return { filters: retry.success ? retry.data : {}, ignored };
}

/**
 * Offset paging as plain links, matching the form above: the whole state of this
 * page lives in the query string, so a page of results can be shared as a URL.
 */
function Pager({
  filters,
  zip,
  radius,
  metro,
  shown,
  total,
}: {
  filters: TalentSearchFilters;
  zip?: string;
  radius?: number;
  /** The metro as TYPED, not the resolved code — see the note inside. */
  metro?: string;
  shown: number;
  total: number;
}) {
  const offset = filters.offset ?? 0;
  const params = (next: number) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      // Derived filters are rebuilt from the raw parameters on every request, so
      // the URL carries what the employer typed instead: the ZIP rather than a
      // lat/lng pair, and the metro's name rather than its CBSA code. Shareable,
      // and readable by the person it is shared with.
      if (
        ["offset", "limit", "latitude", "longitude", "radiusMiles", "cbsaCode"].includes(key)
      ) {
        continue;
      }
      if (value === undefined || value === null || value === "") continue;
      q.set(key, String(value));
    }
    if (zip) q.set("zip", zip);
    if (radius) q.set("radius", String(radius));
    if (metro) q.set("metro", metro);
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
