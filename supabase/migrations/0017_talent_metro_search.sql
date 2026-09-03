-- Metro-area (CBSA) search for the talent directory, and coordinates on the map.
--
-- Employers think in metro areas. `0011` replaced the city/state text filters
-- with a ZIP and a radius, on the argument that typing "Houston" misses everyone
-- in Katy, Pasadena and Sugar Land — which was right, and left a gap: an
-- employer who does not have a ZIP in mind, or who hires across a whole labour
-- market, has no control that says "the Houston area". A radius is a circle
-- centred on a point they had to pick; a metro is the shape the labour market
-- actually has.
--
-- ── What a CBSA is, and why it is not our definition ───────────────────────
-- A Core-Based Statistical Area is OMB's: a county with an urban core, plus
-- every surrounding county that commutes into it. `Houston-Pasadena-The
-- Woodlands, TX` is nine counties. That means the boundary is maintained by
-- somebody else, from commuting data, and revised on a published schedule —
-- rather than being a radius we chose and would have to defend.
--
-- ── The metro is DENORMALIZED, not joined ──────────────────────────────────
-- `cbsa_code` and `cbsa_title` are resolved from the ZIP by
-- `lib/geo/cbsa-lookup.ts` at publish time and written onto the row. A metro
-- search is then an indexed equality test. The alternative — a 30,000-row ZIP →
-- CBSA table in Postgres, joined on every search — would put half of one
-- reference dataset in the database and half in the bundle (`us-zips.json` is
-- already the other half) and buy nothing: the mapping changes once every few
-- years, and the app has the table in memory already.
--
-- The cost of denormalizing is that a listing carries the delineation vintage it
-- was published under. `npm run geo:cbsa -- --backfill` re-derives every
-- published row, and is the step that goes with regenerating the table.
--
-- ── Strict matching, no radius merge ───────────────────────────────────────
-- `p_cbsa` is equality and nothing else. It deliberately does NOT also sweep a
-- radius around the metro's centre to catch people just outside the boundary:
-- CBSAs are county-based and already reach well past the city line, and this
-- directory already ships the radius search as its own control, where the
-- employer picks the distance and can see what it did. An implicit merge would
-- return people the employer did not ask for and cannot switch off.
--
-- A row with no metro — a rural ZIP outside every CBSA, or anyone with no US ZIP
-- — is EXCLUDED from a metro search rather than matching every one. Those people
-- are found through the ZIP + radius filter, or by browsing with no filter at
-- all.
--
-- ── Coordinates are now public, and that was a decision ────────────────────
-- `latitude`/`longitude` join the `returns table` clauses so the results can be
-- drawn on a map. They are ZIP-AREA CENTROIDS, the same numbers `0011` added for
-- radius search: several miles coarse, identical for everyone in one ZIP, and
-- never an address — we have never asked for one. They were also already
-- derivable from what these functions return, since `distance_miles` from three
-- different origins trilaterates the point exactly. Publishing them stops
-- pretending otherwise. See the note on `TalentProfilePublic.latitude` in
-- `types/talent.ts` for the full argument, and `PublishDialog`, which tells a
-- person their area will be shown before they opt in.
--
-- `postal_code` stays out of both clauses. The map has no use for the ZIP string
-- and a bare ZIP column is the shape that ends up in a spreadsheet.
--
-- Idempotent. Run once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The columns
-- ─────────────────────────────────────────────────────────────────────────────

alter table talent_profiles add column if not exists cbsa_code  text;
alter table talent_profiles add column if not exists cbsa_title text;

comment on column talent_profiles.cbsa_code is
  'OMB Core-Based Statistical Area code, resolved from postal_code at publish time by lib/geo/cbsa-lookup.ts. Null for a rural ZIP in no CBSA and for anyone with no US ZIP; both are excluded from metro search rather than matched by every one.';
comment on column talent_profiles.cbsa_title is
  'The metro''s own name, e.g. "Houston-Pasadena-The Woodlands, TX". Stored beside the code so a result can be labelled without a second lookup, and so a listing keeps the name it was published under until it is re-published or backfilled.';

-- Partial, for the same reason as `talent_profiles_geo_idx`: only published,
-- unexpired rows are ever searched, and this keeps the index off the
-- unpublished and expired rows that accumulate.
create index if not exists talent_profiles_cbsa_idx
  on talent_profiles (cbsa_code)
  where status = 'published' and cbsa_code is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. talent_search — one more filter, four more public columns
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `p_cbsa` is inserted after the other equality filters, which changes the
-- positional signature, so the 0011/0012/0014 function is dropped by its exact
-- argument list rather than replaced. Callers use named arguments (PostgREST
-- always does), so nothing depends on the position.
drop function if exists talent_search(text, text, text, double precision, double precision, double precision, integer, integer);

create or replace function talent_search(
  p_query text default null,
  p_category text default null,
  p_availability text default null,
  -- A CBSA code. Null => no metro filter, and the directory behaves exactly as
  -- it did before this migration.
  p_cbsa text default null,
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
  cbsa_code text,
  cbsa_title text,
  -- The pin on the map. A ZIP-area centroid; see the header note.
  latitude double precision,
  longitude double precision,
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
      mcv_talent_name_query(p_query) as name_query,
      nullif(btrim(coalesce(p_cbsa, '')), '') as cbsa
  ),
  filtered as (
    select
      t.*,
      case when p.has_origin
        then mcv_distance_miles(p_lat, p_lng, t.latitude, t.longitude)
      end as distance
    from talent_profiles t
    cross join params p
    where t.status = 'published'
      and t.expires_at > now()
      and (p_category     is null or t.category = p_category)
      and (p_availability is null or t.availability = p_availability)
      -- Equality, and note there is no `or t.cbsa_code is null`: a listing with
      -- no metro must be absent from a metro search, not present in all of them.
      and (p.cbsa is null or t.cbsa_code = p.cbsa)
      and (
        p_query is null
        or btrim(p_query) = ''
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
    f.availability, f.city, f.state, f.country,
    f.cbsa_code, f.cbsa_title, f.latitude, f.longitude,
    f.published_at,
    f.distance,
    count(*) over () as total_count
  from filtered f
  cross join params p
  where not p.has_origin or f.distance <= p.radius
  order by
    case when p.has_origin then f.distance end asc nulls last,
    f.published_at desc
  limit least(coalesce(p_limit, 24), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke execute on function talent_search(text, text, text, text, double precision, double precision, double precision, integer, integer) from public;
grant  execute on function talent_search(text, text, text, text, double precision, double precision, double precision, integer, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. talent_profile_public — the same four columns
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The two public read functions have to expose the SAME shape: `rowToPublic` in
-- `lib/repositories/talent-store.ts` maps both, so a column present in one and
-- absent from the other silently becomes null on half the paths. The profile
-- page draws a one-pin map of its own, which is the immediate reason it needs
-- the coordinates.
--
-- DROPPED and recreated even though the argument list is unchanged. `create or
-- replace function` cannot change a function's RETURN type, and for a `returns
-- table` function the column list IS the return type — so replacing it in place
-- fails with `42P13: cannot change return type of existing function`. Dropping
-- also drops the 0010 grants, which is why they are re-issued below; that is
-- required here, not just tidiness for running the file alone.
drop function if exists talent_profile_public(text);

create or replace function talent_profile_public(p_slug text)
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
  cbsa_code text,
  cbsa_title text,
  latitude double precision,
  longitude double precision,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.slug, t.display_name, t.headline, t.summary, t.category, t.skills,
    t.certifications, t.education, t.experience, t.languages, t.years_bucket,
    t.availability, t.city, t.state, t.country,
    t.cbsa_code, t.cbsa_title, t.latitude, t.longitude,
    t.published_at
  from talent_profiles t
  where t.slug = p_slug
    and t.status = 'published'
    and t.expires_at > now();
$$;

revoke execute on function talent_profile_public(text) from public;
grant  execute on function talent_profile_public(text) to service_role;
