-- Bolsa de Talento — the opt-in talent directory.
--
-- ── What this adds ───────────────────────────────────────────────────────────
-- After a résumé is finalized the user may PUBLISH a profile that employers can
-- search. The profile is a PROJECTION of data the funnel already holds, filtered
-- to the same confirmed/edited entities the résumé itself is built from
-- (see lib/talent/talent-projection.ts) — no new capture, and no model call.
--
--   talent_profiles   the searchable projection. One row per published résumé.
--   talent_contacts   the contact PII + the manage token. Service role only.
--   employers         who asked to see a contact. Service role only.
--   contact_reveals   audit log of every reveal. Service role only.
--
-- ── Why NOTHING here is readable by `anon` ───────────────────────────────────
-- `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships inside the browser bundle, so any table
-- with a policy granting `anon` a select is a public, unauthenticated API over
-- every column of that table — including columns added later by someone who did
-- not read this comment.
--
-- Postgres RLS is ROW-level. It cannot say "these columns are public and those
-- are not". So a directory built on a public select policy would hold the line
-- "no PII on the public table" only by everybody remembering it forever, and the
-- first `alter table talent_profiles add column …` that forgets publishes that
-- column to the internet.
--
-- Instead the public shape is a FUNCTION SIGNATURE. `talent_search` and
-- `talent_profile_public` are security-definer functions whose `returns table`
-- clause enumerates, by name, every field an employer may see. Adding a column to
-- `talent_profiles` exposes nothing until someone also adds it to that clause,
-- which is a visible, reviewable diff. They are granted to `service_role` alone,
-- so the whole directory is reachable only through this app's route handlers —
-- where the rate limits live (`lib/rate-limit/policy.ts`).
--
-- This is the same reasoning as `0009_usage_limits.sql`, one step further: 0009
-- keeps `anon` away from infrastructure counters, this keeps `anon` away from
-- other people's names.
--
-- ── Why contact PII is a SEPARATE TABLE, not more columns ────────────────────
-- `talent_profiles` is read on every search and rendered into a public page.
-- `talent_contacts` is read only by the one route that has already identified an
-- employer and written an audit row. Different tables means the reveal path is
-- the only code that can name the email column at all, and a bug in the search
-- path cannot leak what the search path cannot select.
--
-- Idempotent. Run once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0a. Accent-insensitive Spanish search
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The stock `spanish` text search configuration STEMS but does not fold accents,
-- so `to_tsvector('spanish','Repostería')` yields `reposteri` and
-- `plainto_tsquery('spanish','reposteria')` yields `reposteria` — and they do not
-- match. A user who types "reposteria" finds nobody.
--
-- That is not an edge case for this product. The audience writes Spanish on phone
-- keyboards, where the accented vowel is a long-press away, and plenty of people
-- simply do not use accents when typing. Shipping accent-sensitive search here
-- would mean the directory quietly fails for a large share of real queries, with
-- no error and nothing in a log to notice.
--
-- So we build `spanish_unaccent`: the same configuration with `unaccent` in front
-- of `spanish_stem`. Both sides of the comparison — the stored document in the
-- generated column and the query in `talent_search` — must use it, or the fold
-- happens on one side only and the mismatch comes back.
--
-- `to_tsvector(regconfig, text)` stays IMMUTABLE whichever configuration OID is
-- passed, so a generated column can still use it. (The `unaccent()` FUNCTION is
-- stable, but a dictionary inside a configuration is a different thing, and this
-- is the standard recipe.)
--
-- The DO block exists because `create extension` puts the dictionary wherever the
-- installation puts it — Supabase's dashboard uses an `extensions` schema, a plain
-- `create extension` normally lands in `public`. Rather than assume, we look up
-- where it actually is and schema-qualify the reference.
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
      'Accent-insensitive search cannot be configured without it.';
  end if;

  if not exists (select 1 from pg_ts_config where cfgname = 'spanish_unaccent') then
    execute 'create text search configuration public.spanish_unaccent (copy = spanish)';
  end if;

  execute format(
    'alter text search configuration public.spanish_unaccent '
    'alter mapping for hword, hword_part, word with %I.unaccent, spanish_stem',
    v_schema
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Publish consent on the funnel row
-- ─────────────────────────────────────────────────────────────────────────────
-- `terms_accepted_at` records consent to BUILD a résumé. Publishing a name and a
-- work history to a page strangers can read is a different act, so it gets its
-- own timestamp and its own version string (lib/legal/terms.ts →
-- PUBLISH_TERMS_VERSION). Never infer one consent from the other.
alter table funnel add column if not exists publish_consent_at timestamptz;
alter table funnel add column if not exists publish_consent_version text;

comment on column funnel.publish_consent_at is
  'When the user consented to publishing a directory profile. Separate from terms_accepted_at, which only covers building the résumé.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1a. The search document, as an IMMUTABLE function
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `search_tsv` below is a generated column, and Postgres requires a generated
-- expression to be strictly IMMUTABLE. The obvious inline expression is not,
-- and the reason is easy to miss:
--
--   `array_to_string(anyarray, text)` is declared **STABLE**, not immutable
--   (`provolatile => 's'` in pg_proc). It has to be: for a general `anyarray` it
--   calls the element type's output function, and some of those genuinely are
--   not immutable — `timestamptz` output depends on the session `TimeZone`.
--
-- So writing the document inline fails with
-- `ERROR: 42P17: generation expression is not immutable`, naming the whole
-- to_tsvector() call rather than the one function inside it that caused it.
--
-- Wrapping it here and declaring the wrapper IMMUTABLE is honest, not a trick,
-- because the argument types are CONCRETE: `text[]`, whose element output
-- function is `textout`, which is immutable. The volatility that makes
-- `array_to_string` stable in general cannot arise for a text array. Postgres
-- takes a declared volatility on trust, so the burden is on this comment — do
-- not widen these parameters to `anyarray`, and do not add a column of any other
-- type to the document without re-checking that its output is immutable too.
--
-- `'spanish'::regconfig` is cast explicitly for the same class of reason: the
-- two-argument `to_tsvector(regconfig, text)` is immutable while the
-- one-argument form is only stable (it reads `default_text_search_config`), and
-- an explicit cast makes it impossible to resolve to the wrong one.
--
-- Caveat worth knowing: stored tsvectors are snapshots. Changing the `spanish`
-- text search configuration later does NOT rewrite existing rows — that is true
-- of every tsvector index and is the normal, accepted trade. Re-run an
-- `UPDATE talent_profiles SET headline = headline` to rebuild if it ever matters.
create or replace function mcv_talent_search_document(
  p_headline text,
  p_summary text,
  p_skills text[],
  p_certifications text[],
  p_city text,
  p_state text
)
returns tsvector
language sql
immutable
parallel safe
as $$
  select to_tsvector(
    'spanish_unaccent'::regconfig,
    coalesce(p_headline, '') || ' ' ||
    coalesce(p_summary, '') || ' ' ||
    coalesce(array_to_string(p_skills, ' '), '') || ' ' ||
    coalesce(array_to_string(p_certifications, ' '), '') || ' ' ||
    coalesce(p_city, '') || ' ' ||
    coalesce(p_state, '')
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. talent_profiles — the projection employers search
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists talent_profiles (
  id uuid primary key default gen_random_uuid(),
  -- One directory profile per résumé. `unique` is what makes publishing
  -- idempotent: re-publishing after an edit updates in place rather than
  -- littering the directory with stale copies of the same person.
  funnel_id uuid not null unique references funnel(id) on delete cascade,
  -- Denormalized from funnel so the owner policy is a column comparison instead
  -- of a join. Never returned by the public functions.
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Public URL segment. Generated app-side with a random suffix so directory
  -- entries cannot be enumerated by guessing names.
  slug text not null unique,

  -- "María G." — first name plus last initial. The full name is contact data and
  -- lives in talent_contacts.
  display_name text not null,
  headline text not null default '',
  summary text not null default '',

  -- From lib/talent/taxonomy.ts. Text rather than an enum so adding a category is
  -- a code change plus a data backfill, not a migration that locks the table.
  category text not null,
  skills text[] not null default '{}',
  certifications text[] not null default '{}',
  -- [{ institution, credential, fieldOfStudy }] and [{ title, organization,
  -- experienceType, startDate, endDate, bullets }] — the same shapes the résumé
  -- renders, already confirmed-only and source-traced.
  education jsonb not null default '[]'::jsonb,
  experience jsonb not null default '[]'::jsonb,
  languages jsonb not null default '[]'::jsonb,

  -- A BUCKET, never a number of years and never a graduation date: an exact
  -- figure is a proxy for age, which this product refuses to collect at all.
  years_bucket text not null default 'sin_experiencia'
    check (years_bucket in ('sin_experiencia', '0_2', '3_5', '6_mas')),
  availability text not null default 'flexible'
    check (availability in ('inmediata', 'dos_semanas', 'un_mes', 'flexible')),

  -- City/state/country only. Never a street address — an employer needs to know
  -- whether someone is commutable, not where they sleep.
  city text,
  state text,
  country text,

  status text not null default 'published'
    check (status in ('published', 'unpublished', 'expired', 'blocked')),
  published_at timestamptz not null default now(),
  -- Listings go stale. Expiry is enforced in the read functions' WHERE clause, so
  -- a profile disappears on its own even if no cron job ever runs.
  expires_at timestamptz not null default now() + interval '90 days',

  -- Spanish stemming AND accent folding: 'cocinera' must find 'cocinero', and
  -- 'reposteria' must find 'Repostería' — see `spanish_unaccent` above. The document is built by an
  -- IMMUTABLE helper because the inline expression is not — see the long note on
  -- `mcv_talent_search_document` above, which is the whole reason it exists.
  search_tsv tsvector generated always as (
    mcv_talent_search_document(headline, summary, skills, certifications, city, state)
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists talent_profiles_search_idx on talent_profiles using gin (search_tsv);
-- The directory's default query is "published, in this category, in this state,
-- newest first", so the filter columns lead and the sort column trails.
create index if not exists talent_profiles_browse_idx
  on talent_profiles (status, category, state, published_at desc);
create index if not exists talent_profiles_expiry_idx on talent_profiles (status, expires_at);
create index if not exists talent_profiles_user_idx on talent_profiles (user_id);
create index if not exists talent_profiles_skills_idx on talent_profiles using gin (skills);

drop trigger if exists talent_profiles_updated_at on talent_profiles;
create trigger talent_profiles_updated_at before update on talent_profiles
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. talent_contacts — everything an employer must ask for
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists talent_contacts (
  talent_profile_id uuid primary key references talent_profiles(id) on delete cascade,
  full_name text,
  email text,
  phone text,
  linkedin_url text,
  -- Object path in the private `resumes` bucket. The reveal route turns this into
  -- a short-lived signed URL; the bucket's own RLS is never relaxed.
  resume_pdf_path text,
  -- The ONLY way to unpublish after the session cookie is gone. It lives here
  -- rather than on talent_profiles for the same reason the email does: a token
  -- that can delete someone's listing must not be one column-addition away from
  -- being handed to every visitor.
  manage_token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


drop trigger if exists talent_contacts_updated_at on talent_contacts;
create trigger talent_contacts_updated_at before update on talent_contacts
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. employers — the demand side, still without an account
-- ─────────────────────────────────────────────────────────────────────────────
-- Symmetric with the job seeker: they give us their information to get a résumé,
-- an employer gives us theirs to get a contact. `id` is the guest auth.users id
-- that `resolveUserId()` already mints, so this reuses the whole cookie/session
-- mechanism and adds no new auth machinery.
create table if not exists employers (
  id uuid primary key references auth.users(id) on delete cascade,
  company text not null,
  contact_name text not null,
  email text not null,
  -- Best-effort, for abuse triage only. Never shown to anyone.
  ip text,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. contact_reveals — who looked up whom
-- ─────────────────────────────────────────────────────────────────────────────
-- Not analytics. This is the record that answers "who has my phone number?" when
-- a user asks, and the signal that shows a scraper working through the directory
-- one profile at a time.
create table if not exists contact_reveals (
  id uuid primary key default gen_random_uuid(),
  -- `set null` on both sides: the fact that a reveal happened must survive the
  -- deletion of either party, or the log stops being evidence.
  employer_id uuid references employers(id) on delete set null,
  talent_profile_id uuid references talent_profiles(id) on delete set null,
  ip text,
  revealed_at timestamptz not null default now()
);

create index if not exists contact_reveals_employer_idx on contact_reveals (employer_id, revealed_at desc);
create index if not exists contact_reveals_profile_idx on contact_reveals (talent_profile_id, revealed_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS
-- ─────────────────────────────────────────────────────────────────────────────
alter table talent_profiles enable row level security;
alter table talent_contacts enable row level security;
alter table employers       enable row level security;
alter table contact_reveals enable row level security;

-- The owner may read and manage their OWN listing through the normal authenticated
-- client — that is the unpublish button in the workspace. Everyone else, including
-- every anonymous visitor, gets nothing from this table directly; the public view
-- of it is the two functions below.
drop policy if exists talent_profiles_owner on talent_profiles;
create policy talent_profiles_owner on talent_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- talent_contacts / employers / contact_reveals get RLS with NO policies at all,
-- which denies every role that respects RLS. The service role bypasses it, so the
-- functions below still work. Same pattern as rate_limits / ai_spend in 0009.

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The public read surface
-- ─────────────────────────────────────────────────────────────────────────────
-- These two `returns table` clauses ARE the directory's public contract. A field
-- that is not named here cannot reach an employer, whatever gets added to the
-- table later.

create or replace function talent_search(
  p_query text default null,
  p_category text default null,
  p_state text default null,
  p_city text default null,
  p_availability text default null,
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
  total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with filtered as (
    select t.*
    from talent_profiles t
    where t.status = 'published'
      and t.expires_at > now()
      and (p_category     is null or t.category = p_category)
      and (p_state        is null or t.state ilike p_state)
      and (p_city         is null or t.city ilike p_city)
      and (p_availability is null or t.availability = p_availability)
      and (
        p_query is null
        or btrim(p_query) = ''
        or t.search_tsv @@ plainto_tsquery('spanish_unaccent', p_query)
      )
  )
  select
    f.slug, f.display_name, f.headline, f.summary, f.category, f.skills,
    f.certifications, f.education, f.experience, f.languages, f.years_bucket,
    f.availability, f.city, f.state, f.country, f.published_at,
    -- The total travels on each row so the UI can paginate without a second
    -- round trip that would have to repeat this whole WHERE clause.
    count(*) over () as total_count
  from filtered f
  order by
    -- Relevance first when there is a query; recency is the tiebreak and the sole
    -- ordering when someone is just browsing a category.
    case
      when p_query is null or btrim(p_query) = '' then 0
      else ts_rank(f.search_tsv, plainto_tsquery('spanish_unaccent', p_query))
    end desc,
    f.published_at desc
  -- Hard ceiling on page size INSIDE the function: a caller cannot ask for the
  -- whole directory in one request by passing a large limit.
  limit least(coalesce(p_limit, 24), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

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
    t.availability, t.city, t.state, t.country, t.published_at
  from talent_profiles t
  where t.slug = p_slug
    and t.status = 'published'
    and t.expires_at > now();
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. The reveal — audit and read in one statement
-- ─────────────────────────────────────────────────────────────────────────────
-- The insert and the select are one function so a reveal cannot be logged without
-- returning contact data, and — the direction that matters — contact data cannot
-- be returned without being logged. Two round trips from the route handler could
-- always drop the second one.
create or replace function talent_reveal_contact(
  p_employer uuid,
  p_slug text,
  p_ip text default null
)
returns table (
  full_name text,
  email text,
  phone text,
  linkedin_url text,
  resume_pdf_path text
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile uuid;
begin
  select t.id into v_profile
  from talent_profiles t
  where t.slug = p_slug
    and t.status = 'published'
    and t.expires_at > now();

  -- No row: an unpublished, expired or unknown slug. Return nothing and log
  -- nothing — there is no contact to reveal, so there is no access to record.
  if v_profile is null then
    return;
  end if;

  insert into contact_reveals (employer_id, talent_profile_id, ip)
  values (p_employer, v_profile, p_ip);

  return query
    select c.full_name, c.email, c.phone, c.linkedin_url, c.resume_pdf_path
    from talent_contacts c
    where c.talent_profile_id = v_profile;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Manage-token lookup (unpublish / renew without an account)
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns the slug the token controls, or nothing. Deliberately returns no
-- profile content: this answers "is this token valid, and for which listing",
-- and the caller then acts through the normal owner path.
create or replace function talent_profile_by_manage_token(p_token text)
returns table (slug text, status text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.slug, t.status, t.expires_at
  from talent_contacts c
  join talent_profiles t on t.id = c.talent_profile_id
  where c.manage_token = p_token;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Grants: service role only
-- ─────────────────────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC by default, so the revokes are load-bearing,
-- not decoration. A `security definer` function left executable by PUBLIC is
-- strictly worse than a public table: it runs as its owner and ignores RLS.
revoke execute on function talent_search(text, text, text, text, text, integer, integer) from public;
revoke execute on function talent_profile_public(text) from public;
revoke execute on function talent_reveal_contact(uuid, text, text) from public;
revoke execute on function talent_profile_by_manage_token(text) from public;

grant execute on function talent_search(text, text, text, text, text, integer, integer) to service_role;
grant execute on function talent_profile_public(text) to service_role;
grant execute on function talent_reveal_contact(uuid, text, text) to service_role;
grant execute on function talent_profile_by_manage_token(text) to service_role;
