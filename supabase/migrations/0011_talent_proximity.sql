-- Proximity search for the talent directory.
--
-- Employers do not think in cities, they think in "who can get here". A person
-- in a neighbouring town is a better match than someone the far side of the same
-- sprawling city, and city-name matching cannot express that — it also fails on
-- every metro that spans a dozen municipalities, which in the US is most of them.
--
-- ── Where the coordinates come from ─────────────────────────────────────────
-- The funnel now asks for a ZIP instead of a city, and `lib/geo/zip-lookup.ts`
-- turns it into the ZIP AREA'S CENTROID. That is important to state plainly: we
-- never ask for or store a street address, so a "distance" here is between the
-- middles of two postal areas and can be several miles out for any individual.
-- Right for ranking who is nearby; wrong to present as an exact distance.
--
-- ── Why plain columns and not PostGIS ───────────────────────────────────────
-- PostGIS would be the textbook answer, and it would mean an extension, a
-- geography type, and a GiST index for a table that will hold thousands of rows,
-- not millions. A bounding-box prefilter on indexed lat/lng columns narrows the
-- candidates to a small set, and haversine then runs over those. Same results,
-- nothing new to operate. Revisit if this table ever gets very large.
--
-- Idempotent. Run once; re-running is a no-op.

alter table talent_profiles add column if not exists postal_code text;
alter table talent_profiles add column if not exists latitude double precision;
alter table talent_profiles add column if not exists longitude double precision;

comment on column talent_profiles.latitude is
  'Centroid of the profile''s ZIP area, never a street address. Null for anyone outside the US, who is excluded from radius searches.';

-- The bounding-box prefilter reads both columns together, so one composite index
-- serves it. Partial: only published rows are ever searched, and it keeps the
-- index off the expired and unpublished rows that accumulate over time.
create index if not exists talent_profiles_geo_idx
  on talent_profiles (latitude, longitude)
  where status = 'published' and latitude is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Distance, in miles
-- ─────────────────────────────────────────────────────────────────────────────
-- Haversine, matching `distanceMiles` in `lib/geo/zip-lookup.ts` — the two must
-- agree, because the API filters with this one and the UI may label results with
-- the other. A flat-earth approximation would not: the continental US spans some
-- 25° of latitude, so a degree of longitude is ~69 miles in south Texas and ~48
-- in Washington state, and a "50 mile" radius would mean different things in each.
create or replace function mcv_distance_miles(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
)
returns double precision
language sql
immutable
parallel safe
as $$
  select 2 * 3958.7613 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- talent_search, with radius
-- ─────────────────────────────────────────────────────────────────────────────
-- Replaces the 0010 signature. The city/state text filters are GONE: they were
-- what proximity is here to replace, and leaving both would let a caller filter
-- by a typed city string, which is exactly the brittle behaviour being removed.
--
-- `distance_miles` rides on every row so the UI can say "a 12 millas" without a
-- second query, and is null when the search had no origin.
drop function if exists talent_search(text, text, text, text, text, integer, integer);

create or replace function talent_search(
  p_query text default null,
  p_category text default null,
  p_availability text default null,
  -- Origin of the radius. Both null => no distance filter, and the directory
  -- behaves exactly as it did before this migration.
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
      -- Clamp before it is used as a box: an unbounded radius would turn the
      -- prefilter into a sequential scan of the whole table.
      least(greatest(coalesce(p_radius_miles, 25), 1), 500) as radius
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
      and (
        p_query is null
        or btrim(p_query) = ''
        or t.search_tsv @@ plainto_tsquery('spanish_unaccent', p_query)
      )
      and (
        not p.has_origin
        or (
          t.latitude is not null
          and t.longitude is not null
          -- Bounding box FIRST, so the index does the work and haversine only
          -- runs on the survivors. 69 miles per degree of latitude; longitude
          -- degrees shrink toward the poles, hence the cos() term. Guarded at
          -- 0.01 so the box cannot collapse to zero at extreme latitudes and
          -- silently exclude everyone.
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
  -- The box is a square and the radius is a circle, so the corners have to be
  -- trimmed here or a "25 mile" search quietly reaches 35 on the diagonal.
  where not p.has_origin or f.distance <= p.radius
  order by
    -- Nearest first when there is an origin: that IS the question being asked.
    -- Otherwise relevance, then recency, exactly as before.
    case when p.has_origin then f.distance end asc nulls last,
    case
      when p_query is null or btrim(p_query) = '' then 0
      else ts_rank(f.search_tsv, plainto_tsquery('spanish_unaccent', p_query))
    end desc,
    f.published_at desc
  limit least(coalesce(p_limit, 24), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke execute on function talent_search(text, text, text, double precision, double precision, double precision, integer, integer) from public;
grant execute on function talent_search(text, text, text, double precision, double precision, double precision, integer, integer) to service_role;
