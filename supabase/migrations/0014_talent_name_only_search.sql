-- The free-text box searches NAMES, and nothing else.
--
-- 0012 made the box an OR of two matchers: the résumé document (`search_tsv` —
-- headline, summary, skills, certifications, city, state) and the display name
-- (`name_tsv`). This drops the first half. One box, one meaning: type a person's
-- name.
--
-- ── Why one matcher beats two ───────────────────────────────────────────────
-- An OR of two vocabularies cannot tell an employer why a row came back. Both
-- halves were reasonable alone and the union was not:
--
--   * Spanish surnames ARE trade words, and stemming collides them. 0012 kept
--     the two columns apart for exactly that reason, but ORing them at query
--     time puts the collision back at the level the employer sees: `Flores`
--     returns the florists as well as the Flores family, and no ranking rule
--     makes that legible — the two groups are both "correct".
--   * The résumé half searched free text the person never chose as a keyword.
--     Matching a summary means a candidate surfaces for a word they used in
--     passing, which reads to the employer as a claim of skill.
--   * "Nothing found" was ambiguous in a way that cost real searches. An
--     employer who typed a name and got nobody could not tell whether the
--     person is not listed or the box does not take names — which is precisely
--     the failure 0012 was written to fix, half-fixed by making the box mean two
--     things at once.
--
-- Searching BY TRADE is not gone; it moved to the control built for it. The
-- `Área` dropdown (`p_category`) is a closed set derived from each résumé by
-- `suggestCategory`, so it cannot return somebody for a word they merely typed.
--
-- ── What this gives up, stated plainly ─────────────────────────────────────
-- Specific skills and certifications are no longer reachable as text. An
-- employer who wants an HVAC technician or a phlebotomist must now pick the
-- surrounding category and read the results, because `Área` is broad where
-- `search_tsv` was precise. That is a real loss in findability and it was the
-- accepted price of a box with one meaning. If it needs answering later, the
-- answer is a SECOND control (a skill filter over a closed list, the way
-- category works) — not free text merged back into this one.
--
-- ── `search_tsv` is KEPT, unused ───────────────────────────────────────────
-- The column, its GIN index and `mcv_talent_search_document` all stay. Nothing
-- queries them after this migration. They are the rollback: restoring the old
-- behaviour is re-running 0012's `talent_search` with no data migration, no
-- backfill and no re-index. Dropping a generated column is the irreversible
-- direction, so it waits until this decision has been lived with. Anyone
-- reading the schema and finding an index nothing uses has found this comment,
-- which is the point.
--
-- `name_tsv`, `simple_unaccent` and `mcv_talent_name_query` are unchanged: the
-- accent folding, the prefix matching, the AND across tokens and the
-- two-character floor are all still 0012's, and `nameSearchTokens` in
-- `lib/talent/text.ts` still mirrors them.
--
-- Idempotent. Run once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- talent_search: the free-text predicate is now the name alone
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Same signature as 0011 and 0012, so this is a replacement and existing grants
-- survive (re-issued below anyway, to keep the file runnable on its own). The
-- public shape — the `returns table` clause — is UNCHANGED: this migration
-- removes a way to find a row, not a field.
--
-- A query with nothing left after the two-character floor returns NO ROWS, not
-- every row. `mcv_talent_name_query` yields NULL there, and the predicate reads
-- it as "no name matches" — the reading 0012 asked callers for. It matters more
-- now that the floor is the only thing between a one-letter query and the whole
-- table: an empty box lists everybody on purpose, but `a` is somebody trying to
-- search, and answering it with the entire directory would be a page-out dressed
-- up as a result set. `/empleadores` says so in words rather than showing an
-- unexplained empty table.
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
      mcv_talent_name_query(p_query) as name_query
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
  -- The relevance tier 0012 needed is gone with the second matcher. Every row
  -- here is a name hit, so `ts_rank` would be ranking name prefixes against each
  -- other — `luc` matches Lucía and Lucio equally well, and it genuinely does.
  -- Nearest first when a ZIP was given, most recent otherwise: both are answers
  -- to a question the employer actually asked.
  order by
    case when p.has_origin then f.distance end asc nulls last,
    f.published_at desc
  limit least(coalesce(p_limit, 24), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke execute on function talent_search(text, text, text, double precision, double precision, double precision, integer, integer) from public;
grant execute on function talent_search(text, text, text, double precision, double precision, double precision, integer, integer) to service_role;

comment on column talent_profiles.search_tsv is
  'The résumé document, stemmed and accent-folded. UNUSED since 0014, which narrowed the free-text box to names; kept, with its index, as the rollback path to 0012.';
