-- Search the talent directory BY NAME.
--
-- Until now the free-text box matched `search_tsv`, which is built from the
-- résumé's own words — headline, summary, skills, certifications, city, state.
-- A name was deliberately absent, so typing one found nobody and did so
-- silently: an employer who had a candidate's name in hand read the empty state
-- as "this directory has no one", not as "this box does not take names".
--
-- ── What this changes about exposure, stated plainly ────────────────────────
-- It discloses no NEW field. A listing's full name is already public — it is
-- rendered in the results table and on the profile page, `publicDisplayName`
-- returns first + last in full, and `PublishDialog` says so before anyone opts
-- in. What changes is the COST of a targeted lookup: "is this particular person
-- job-hunting?" was previously a question you answered by paging the directory,
-- and is now one query. An employer can therefore run it against their own
-- staff. That was weighed and accepted as a product decision.
--
-- What still stands: slugs keep their random suffix, so a profile URL cannot be
-- guessed from a name even once search has confirmed the name is listed; the
-- search rate limit is IP-keyed; `contact_reveals` still records every résumé
-- download. And the two-character floor below means a one-letter query cannot
-- be used to page out the whole table.
--
-- Idempotent. Run once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A text search configuration that folds accents but does NOT stem
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The name canNOT go into `search_tsv`, and the reason is specific to Spanish:
-- that column uses `spanish_unaccent`, which STEMS. Spanish surnames are very
-- often occupation words, so stemming them collides the two vocabularies in
-- both directions —
--
--   `Herrera`  stems to `herrer`  … which is the `oficios` keyword for herrería
--   `Flores`   stems to `flor`    … floristry
--   `Pastor`, `Vaquero`, `Molinero`, `Zapatero`, `Guerrero` … all the same trap
--
-- Folded into one document, a search for `herrero` would return everyone named
-- Herrera, and a search for `Flores` would return florists. Neither is a near
-- miss an employer can interpret. So names get their own column, matched
-- UNSTEMMED: `simple_unaccent` is `simple` (lowercase, no stemmer, no stopwords)
-- with `unaccent` in front, which is what makes `gonzalez` find `González`.
--
-- Same DO-block shape as `spanish_unaccent` in 0010, and for the same reason:
-- `create extension` puts the dictionary wherever the installation puts it, so
-- we look up the schema instead of assuming `public`.
create extension if not exists unaccent;

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
  from pg_ts_dict d
  join pg_namespace n on n.oid = d.dictnamespace
  where d.dictname = 'unaccent'
  limit 1;

  if v_schema is null then
    raise exception
      'The unaccent dictionary was not found after CREATE EXTENSION unaccent. '
      'Name search cannot be configured without it.';
  end if;

  if not exists (select 1 from pg_ts_config where cfgname = 'simple_unaccent') then
    execute 'create text search configuration public.simple_unaccent (copy = simple)';
  end if;

  -- `asciiword` is left on plain `simple`: a token with no accent in it has
  -- nothing for unaccent to do. `hword`/`hword_part` cover hyphenated surnames
  -- like García-López, which the parser splits into parts.
  execute format(
    'alter text search configuration public.simple_unaccent '
    'alter mapping for hword, hword_part, word with %I.unaccent, simple',
    v_schema
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The name document, as an IMMUTABLE function
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Wrapped for the same class of reason `mcv_talent_search_document` is wrapped
-- in 0010, though not the identical one: there it was `array_to_string` being
-- declared STABLE. Here the hazard is the `regconfig` cast — a generated column
-- must be strictly IMMUTABLE, Postgres takes a declared volatility on trust,
-- and a named function keeps that decision in one reviewable place instead of
-- inline in a DDL statement. The argument is concretely `text`, so nothing in
-- here can actually vary.
create or replace function mcv_talent_name_document(p_display_name text)
returns tsvector
language sql
immutable
parallel safe
as $$
  select to_tsvector('simple_unaccent'::regconfig, coalesce(p_display_name, ''));
$$;

alter table talent_profiles
  add column if not exists name_tsv tsvector
  generated always as (mcv_talent_name_document(display_name)) stored;

comment on column talent_profiles.name_tsv is
  'The public display name, accent-folded and UNSTEMMED. Separate from search_tsv because the Spanish stemmer collides surnames with trade words (Herrera/herrería, Flores/floristry).';

-- Partial, matching `talent_profiles_geo_idx`: only published rows are ever
-- searched, so the index stays off the expired and unpublished rows that
-- accumulate as listings age out.
create index if not exists talent_profiles_name_idx
  on talent_profiles using gin (name_tsv)
  where status = 'published';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Turning what an employer typed into a name query
-- ─────────────────────────────────────────────────────────────────────────────
--
-- PREFIX matching, which `plainto_tsquery` cannot express: people type part of a
-- name. `gonz` has to find `González`, and `mar gonz` has to find
-- `María González` — so each token becomes `token:*` and they are ANDed.
-- ANDed, not ORed: `mar gonz` means both, or every María in the table comes back.
-- Order does not matter, so "González María" works as well as "María González".
--
-- `to_tsquery` parses `& | ! ( ) : *`, so the input is reduced to alphanumeric
-- tokens FIRST and only then decorated. That is the whole injection surface, and
-- after this replacement there is nothing left in the string that the tsquery
-- parser treats as syntax. Accents survive the scrub — `[:alnum:]` is
-- encoding-aware — and are folded a step later by the configuration itself,
-- which is why this function does not (and must not) call `unaccent` directly:
-- that function is STABLE and would forfeit the immutability declared here.
--
-- Tokens shorter than two characters are DROPPED rather than turned into a
-- prefix. `a:*` matches a large share of any name column, which would make a
-- single keystroke a way to page out the directory — see the exposure note at
-- the top. A query with nothing left after the floor returns NULL, and the
-- caller must treat that as "no name matching", not as "match everything".
--
-- `nameSearchTokens` in `lib/talent/text.ts` is the TypeScript mirror of this,
-- used by `MemoryTalentStore`. The two must stay in agreement.
create or replace function mcv_talent_name_query(p_query text)
returns tsquery
language sql
immutable
parallel safe
as $$
  select case
    when t.joined is null or t.joined = '' then null
    else to_tsquery('simple_unaccent'::regconfig, t.joined)
  end
  from (
    select string_agg(tok || ':*', ' & ') as joined
    from unnest(
      regexp_split_to_array(
        regexp_replace(coalesce(p_query, ''), '[^[:alnum:]]+', ' ', 'g'),
        '\s+'
      )
    ) as tok
    where length(tok) >= 2
  ) t;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. talent_search: match the résumé document OR the name
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Same signature as 0011, so this is a replacement and existing grants survive
-- (re-issued below anyway, to keep the file runnable on its own). The public
-- shape — the `returns table` clause — is UNCHANGED: this migration adds a way
-- to find a row, not a new field to read off it. `name_tsv` is deliberately not
-- returned; it is an index, not content.
--
-- The free-text box is now an OR of two matchers, which is the honest shape of
-- "search for a person": an employer either knows what they need done, or knows
-- who they want. `cocinera` still means the résumé document.
create or replace function talent_search(
  p_query text default null,
  p_category text default null,
  p_availability text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_miles double precision default 25,
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  slug text,
  display_name text,
  headline text,
  summary text,
  category text,
  skills text[],
  certifications text[],
  education jsonb,
  experience jsonb,
  languages jsonb,
  years_bucket text,
  availability text,
  city text,
  state text,
  country text,
  published_at timestamptz,
  distance_miles double precision,
  total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_lat is not null and p_lng is not null as has_origin,
      least(greatest(coalesce(p_radius_miles, 25), 1), 500) as radius,
      -- Built once here rather than per row: it is the same query text for the
      -- whole scan, and it is NULL when nothing survived the length floor.
      mcv_talent_name_query(p_query) as name_query,
      plainto_tsquery('spanish_unaccent', coalesce(p_query, '')) as text_query
  ),
  filtered as (
    select
      t.*,
      case when p.has_origin
        then mcv_distance_miles(p_lat, p_lng, t.latitude, t.longitude)
      end as distance,
      p.name_query is not null and t.name_tsv @@ p.name_query as name_hit
    from talent_profiles t
    cross join params p
    where t.status = 'published'
      and t.expires_at > now()
      and (p_category     is null or t.category = p_category)
      and (p_availability is null or t.availability = p_availability)
      and (
        p_query is null
        or btrim(p_query) = ''
        or t.search_tsv @@ p.text_query
        or (p.name_query is not null and t.name_tsv @@ p.name_query)
      )
      and (
        not p.has_origin
        or (
          t.latitude is not null
          and t.longitude is not null
          and t.latitude between p_lat - (p.radius / 69.0) and p_lat + (p.radius / 69.0)
          and t.longitude between
                p_lng - (p.radius / (69.0 * greatest(cos(radians(p_lat)), 0.01)))
            and p_lng + (p.radius / (69.0 * greatest(cos(radians(p_lat)), 0.01)))
        )
      )
  )
  select
    f.slug, f.display_name, f.headline, f.summary, f.category, f.skills,
    f.certifications, f.education, f.experience, f.languages, f.years_bucket,
    f.availability, f.city, f.state, f.country, f.published_at,
    f.distance,
    count(*) over () as total_count
  from filtered f
  cross join params p
  where not p.has_origin or f.distance <= p.radius
  order by
    case when p.has_origin then f.distance end asc nulls last,
    case
      when p_query is null or btrim(p_query) = '' then 0
      -- A name hit outranks any résumé-text hit for the same word. Someone who
      -- typed a name is looking for a person, not for the trade that shares its
      -- spelling, and `ts_rank` returns well under 1 — so the flat +1 decides it
      -- without needing the two scores to be commensurable.
      else (case when f.name_hit then 1 else 0 end) + ts_rank(f.search_tsv, p.text_query)
    end desc,
    f.published_at desc
  limit least(coalesce(p_limit, 24), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke execute on function talent_search(text, text, text, double precision, double precision, double precision, integer, integer) from public;
grant execute on function talent_search(text, text, text, double precision, double precision, double precision, integer, integer) to service_role;
