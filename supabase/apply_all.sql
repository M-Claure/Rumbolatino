-- Mi CV con IA — full database setup
-- Paste this whole file into the Supabase SQL Editor and Run.
-- Combines migrations 0001 + 0002 + 0003 + 0004 + 0005 + 0006 + 0007 (run once on a fresh
-- project). Every statement is idempotent from 0002 onward, so re-running this
-- file on an existing project safely applies only what is missing.

-- ============ 0001_init.sql ============
-- ─────────────────────────────────────────────────────────────────────────────
-- Mi CV con IA — initial schema
-- Postgres (Supabase). Row-Level Security is enabled on every table so a user
-- can only read/write rows belonging to their own resume profiles.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────────────────────
create type resume_status as enum (
  'draft', 'collecting_information', 'ready_for_review',
  'generating', 'generated', 'archived'
);

create type resume_section as enum (
  'career_goal', 'personal_information', 'education', 'experience',
  'skills', 'certifications', 'languages', 'projects', 'achievements', 'review'
);

create type experience_type as enum (
  'formal_employment', 'self_employment', 'business_owner', 'freelance',
  'informal_work', 'family_business', 'volunteering', 'internship',
  'school_project', 'caregiving', 'personal_project', 'other'
);

create type skill_origin as enum (
  'user_entered', 'education_inference', 'experience_inference',
  'project_inference', 'certification_inference'
);

create type skill_status as enum ('suggested', 'confirmed', 'rejected', 'edited');

create type confirmation_status as enum ('confirmed', 'needs_review', 'edited', 'rejected');

create type entry_source as enum ('user_entered', 'ai_extracted');

create type proficiency_level as enum ('basic', 'intermediate', 'advanced', 'expert');

create type language_level as enum ('basico', 'intermedio', 'avanzado', 'nativo');

create type project_type as enum ('personal', 'academic', 'professional', 'volunteer', 'other');

-- ── updated_at helper ─────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── users (app profile, 1:1 with auth.users) ───────────────────────────────────
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  preferred_language text not null default 'es',
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_updated_at before update on users
  for each row execute function set_updated_at();

-- ── resume_profiles ─────────────────────────────────────────────────────────
create table resume_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  status resume_status not null default 'draft',
  target_role text,
  career_goal text,
  location text,
  progress_percentage int not null default 0 check (progress_percentage between 0 and 100),
  current_section resume_section,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index resume_profiles_user_id_idx on resume_profiles(user_id);
create trigger resume_profiles_updated_at before update on resume_profiles
  for each row execute function set_updated_at();

-- ── personal_information (1:1) ────────────────────────────────────────────────
create table personal_information (
  resume_profile_id uuid primary key references resume_profiles(id) on delete cascade,
  first_name text,
  last_name text,
  city text,
  state text,
  country text,
  phone text,
  email text,
  linkedin_url text,
  portfolio_url text
);

-- ── education_entries ─────────────────────────────────────────────────────────
create table education_entries (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  institution text,
  credential text,
  field_of_study text,
  location text,
  start_date text,
  end_date text,
  is_current boolean not null default false,
  relevant_coursework text[] not null default '{}',
  projects text[] not null default '{}',
  achievements text[] not null default '{}',
  source entry_source not null default 'user_entered',
  confirmation_status confirmation_status not null default 'confirmed',
  created_at timestamptz not null default now()
);
create index education_entries_profile_idx on education_entries(resume_profile_id);

-- ── experience_entries ────────────────────────────────────────────────────────
create table experience_entries (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  experience_type experience_type not null default 'other',
  title text,
  organization text,
  location text,
  start_date text,
  end_date text,
  is_current boolean not null default false,
  raw_description text,
  responsibilities text[] not null default '{}',
  accomplishments text[] not null default '{}',
  tools text[] not null default '{}',
  people_served text,
  metrics text[] not null default '{}',
  source entry_source not null default 'user_entered',
  confirmation_status confirmation_status not null default 'confirmed',
  created_at timestamptz not null default now()
);
create index experience_entries_profile_idx on experience_entries(resume_profile_id);

-- ── skills ────────────────────────────────────────────────────────────────────
create table skills (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  name text not null,
  category text not null default 'general',
  proficiency proficiency_level,
  origin skill_origin not null default 'user_entered',
  evidence text,
  source_entry_id uuid,
  status skill_status not null default 'suggested',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index skills_profile_idx on skills(resume_profile_id);
-- Prevent duplicate suggestions of the same skill within a profile.
create unique index skills_profile_name_uidx on skills(resume_profile_id, lower(name));
create trigger skills_updated_at before update on skills
  for each row execute function set_updated_at();

-- ── certifications ────────────────────────────────────────────────────────────
create table certifications (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  name text not null,
  issuing_organization text,
  issue_date text,
  expiration_date text,
  credential_id text,
  credential_url text,
  confirmation_status confirmation_status not null default 'confirmed',
  created_at timestamptz not null default now()
);
create index certifications_profile_idx on certifications(resume_profile_id);

-- ── languages ─────────────────────────────────────────────────────────────────
create table languages (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  name text not null,
  speaking_level language_level,
  reading_level language_level,
  writing_level language_level,
  include_on_resume boolean not null default true,
  created_at timestamptz not null default now()
);
create index languages_profile_idx on languages(resume_profile_id);

-- ── projects ──────────────────────────────────────────────────────────────────
create table projects (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  name text not null,
  project_type project_type,
  organization text,
  start_date text,
  end_date text,
  description text,
  responsibilities text[] not null default '{}',
  outcomes text[] not null default '{}',
  tools text[] not null default '{}',
  confirmation_status confirmation_status not null default 'confirmed',
  created_at timestamptz not null default now()
);
create index projects_profile_idx on projects(resume_profile_id);

-- ── achievements ──────────────────────────────────────────────────────────────
create table achievements (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  title text not null,
  organization text,
  date text,
  description text,
  confirmation_status confirmation_status not null default 'confirmed',
  created_at timestamptz not null default now()
);
create index achievements_profile_idx on achievements(resume_profile_id);

-- ── conversation_turns ────────────────────────────────────────────────────────
create table conversation_turns (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  question_id text not null,
  section resume_section not null,
  assistant_message text not null,
  user_answer text,
  normalized_answer jsonb,
  skipped boolean not null default false,
  created_at timestamptz not null default now()
);
create index conversation_turns_profile_idx on conversation_turns(resume_profile_id, created_at);

-- ── question_states (1:1) ─────────────────────────────────────────────────────
create table question_states (
  resume_profile_id uuid primary key references resume_profiles(id) on delete cascade,
  asked_question_ids text[] not null default '{}',
  skipped_question_ids text[] not null default '{}',
  completed_sections resume_section[] not null default '{}',
  active_section resume_section,
  last_question_id text,
  last_updated_at timestamptz not null default now()
);

-- ── generated_resumes ─────────────────────────────────────────────────────────
create table generated_resumes (
  id uuid primary key default gen_random_uuid(),
  resume_profile_id uuid not null references resume_profiles(id) on delete cascade,
  version int not null default 1,
  professional_summary text not null default '',
  skills jsonb not null default '[]',
  experience jsonb not null default '[]',
  education jsonb not null default '[]',
  certifications jsonb not null default '[]',
  projects jsonb not null default '[]',
  languages jsonb not null default '[]',
  html text not null default '',
  pdf_url text,
  created_at timestamptz not null default now()
);
create index generated_resumes_profile_idx on generated_resumes(resume_profile_id, version);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table users enable row level security;
alter table resume_profiles enable row level security;
alter table personal_information enable row level security;
alter table education_entries enable row level security;
alter table experience_entries enable row level security;
alter table skills enable row level security;
alter table certifications enable row level security;
alter table languages enable row level security;
alter table projects enable row level security;
alter table achievements enable row level security;
alter table conversation_turns enable row level security;
alter table question_states enable row level security;
alter table generated_resumes enable row level security;

-- users: a user sees only their own row.
create policy users_self on users
  for all using (id = auth.uid()) with check (id = auth.uid());

-- resume_profiles: owned by user_id.
create policy resume_profiles_owner on resume_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Child tables: access allowed when the parent profile belongs to the user.
-- (Applied via a helper predicate repeated per table.)
create policy personal_information_owner on personal_information for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy education_entries_owner on education_entries for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy experience_entries_owner on experience_entries for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy skills_owner on skills for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy certifications_owner on certifications for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy languages_owner on languages for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy projects_owner on projects for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy achievements_owner on achievements for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy conversation_turns_owner on conversation_turns for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy question_states_owner on question_states for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

create policy generated_resumes_owner on generated_resumes for all
  using (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()))
  with check (resume_profile_id in (select id from resume_profiles where user_id = auth.uid()));

-- ── Auto-provision public.users row on signup ──────────────────────────────────
create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ============ 0002_interests.sql ============
-- Personal interests / hobbies as a lightweight list on the resume profile.
alter table resume_profiles
  add column if not exists interests text[] not null default '{}';

-- ============ 0003_finalized_at.sql ============
-- Finalization: records when the user finalized (locked) the résumé for download.
-- NULL = not finalized. Regenerating/editing clears it so the CV must be
-- re-finalized before it can be downloaded again.
alter table resume_profiles
  add column if not exists finalized_at timestamptz;

-- ============ 0004_terms_consent.sql ============
-- Terms & conditions consent: proof the user agreed before starting the builder.
-- terms_accepted_at = when they accepted (server stamped); terms_version = the
-- exact text version accepted (see lib/legal/terms.ts). NULL = legacy profile.
alter table resume_profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text;

-- ============ 0005_funnel_telemetry.sql ============
-- Funnel telemetry: makes "where did the user quit" and "where do users
-- struggle" answerable in SQL. time_spent_ms + attempt_number are the per-answer
-- effort signals; last_shown_question_id is the real exit point (last_question_id
-- only records questions that got a response). See docs/funnel-analytics.md.
alter table conversation_turns
  add column if not exists time_spent_ms int
    check (time_spent_ms is null or time_spent_ms >= 0),
  add column if not exists attempt_number int not null default 1;

alter table question_states
  add column if not exists last_shown_question_id text,
  add column if not exists last_shown_at timestamptz;

create index if not exists conversation_turns_question_idx
  on conversation_turns(question_id);

create index if not exists question_states_last_shown_idx
  on question_states(last_shown_at);

-- ============ 0006_resume_pdf_storage.sql ============
-- Saved résumé PDFs.
--
-- Until now the PDF was rendered on every download and never persisted: the
-- `generated_resumes.pdf_url` column existed but was never written. Résumés are
-- now rendered and stored on every generation, so a user always has a current
-- file and a download is a storage read rather than a Chromium launch.
--
-- ── One object per profile ───────────────────────────────────────────────────
-- The object path is `<user_id>/<resume_profile_id>/curriculum.pdf` and each
-- generation OVERWRITES it. A profile therefore holds exactly one PDF — the
-- render of its latest generation. Consequences, both intended:
--   * storage cannot grow without bound as a user iterates on their CV;
--   * a download can never return a stale version;
--   * older generated_resumes rows are not individually downloadable. Nothing in
--     the product offers version history, and a PDF per version would multiply
--     PII at rest for no user-facing gain.
--
-- ── Why the user id is the FIRST path segment ────────────────────────────────
-- The policies below authorize on `(storage.foldername(name))[1] = auth.uid()`,
-- which is the standard Supabase Storage ownership pattern. `resumePdfPath()` in
-- lib/storage/resume-file-store.ts must keep producing that layout — changing it
-- silently changes who can read the file, so it is pinned by a unit test.
--
-- Everything here is idempotent; safe to re-run.

-- ── Bucket ───────────────────────────────────────────────────────────────────
-- Private. There is no public URL for a résumé: reads go through the API, which
-- re-checks profile ownership before streaming bytes.
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

-- ── RLS on the objects ───────────────────────────────────────────────────────
-- Defense-in-depth behind the API's own ownership check: even a bug that
-- computed the wrong path cannot write into, or read from, another user's folder.
drop policy if exists "resumes_read_own" on storage.objects;
create policy "resumes_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "resumes_insert_own" on storage.objects;
create policy "resumes_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Upsert of an existing object is an UPDATE, so replacement needs this one too.
drop policy if exists "resumes_update_own" on storage.objects;
create policy "resumes_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "resumes_delete_own" on storage.objects;
create policy "resumes_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Column rename ────────────────────────────────────────────────────────────
-- `pdf_url` was scaffolding that never held a value; what we store is a storage
-- object PATH (signed URLs expire, so a URL would rot in the row). Renaming is
-- safe precisely because the column has always been null.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'generated_resumes'
      and column_name = 'pdf_url'
  ) then
    alter table generated_resumes rename column pdf_url to pdf_path;
  end if;
end $$;

comment on column generated_resumes.pdf_path is
  'Storage object path in the private "resumes" bucket. One PDF per profile: '
  'every generation overwrites it, so only the latest version''s path is current.';

-- ============ 0007_simplified_schema.sql ============
-- Schema simplification: 13 tables → 5.
--
--   funnel        everything captured during the funnel, one row per résumé
--   resume_pdfs   every generated résumé and its stored PDF
--   iteration_1   \
--   iteration_2    >  the improvement round's questions and answers
--   iteration_3   /
--
-- ── What changed and why ─────────────────────────────────────────────────────
-- The old schema normalized eight capture sections (personal_information,
-- education_entries, experience_entries, skills, certifications, languages,
-- projects, achievements) plus conversation_turns and question_states into their
-- own tables. That buys per-row querying nobody was doing: a profile is a single
-- user's small, capped document (≤4 experiences, ≤2 education entries) that the
-- app always loads whole, via `assembleProfileState`. The cost was 13 tables, 13
-- RLS policies and ~700 lines of row↔domain mapping.
--
-- They are now JSONB columns on `funnel`, holding the DOMAIN objects verbatim
-- (camelCase keys, exactly the shapes in types/domain.ts). That is deliberate:
-- what you see in the Supabase editor is precisely what the app sees, and the
-- mapping layer disappears instead of being rewritten.
--
-- ── What this costs, stated plainly ──────────────────────────────────────────
--  * No per-entry foreign keys or CHECK constraints inside the JSONB. Entry
--    shape is enforced in TypeScript and by the Zod schemas on the AI boundary,
--    not by Postgres. The safety invariants that matter (skills start as
--    `suggested`; only confirmed/edited data reaches a résumé) were always
--    enforced in code — see lib/skills/ and lib/resume/source-tracing.ts.
--  * Updating one entry rewrites the row's array. `SupabaseStore` does that
--    read-modify-write under an optimistic `revision` guard so a concurrent
--    write cannot silently clobber another.
--  * `users` is gone. It mirrored auth.users and was kept in sync by a trigger;
--    funnel.user_id now references auth.users directly.
--
-- Everything is idempotent, and existing rows are migrated before the old tables
-- are dropped. Run it once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- Conversion helpers (dropped at the end — they exist only for the backfill)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mcv_snake_to_camel(txt text)
returns text language sql immutable as $$
  select string_agg(case when i = 1 then part else initcap(part) end, '')
  from unnest(string_to_array(txt, '_')) with ordinality as t(part, i);
$$;

-- Rewrites a row's snake_case keys to the camelCase the domain model uses.
-- `linkedin_url` is the one field whose domain name is not a mechanical
-- transform (`linkedInUrl`, capital I), so it is special-cased.
create or replace function mcv_camelize(obj jsonb)
returns jsonb language sql immutable as $$
  select coalesce(
    jsonb_object_agg(
      case key when 'linkedin_url' then 'linkedInUrl' else mcv_snake_to_camel(key) end,
      value
    ),
    '{}'::jsonb
  )
  from jsonb_each(obj);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. funnel — everything from the funnel
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists funnel (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- profile
  status resume_status not null default 'draft',
  target_role text,
  career_goal text,
  location text,
  interests text[] not null default '{}',
  progress_percentage int not null default 0 check (progress_percentage between 0 and 100),
  current_section resume_section,
  finalized_at timestamptz,
  terms_accepted_at timestamptz,
  terms_version text,

  -- captured sections, as domain objects (was 8 tables)
  personal_information jsonb not null default '{}'::jsonb,
  education jsonb not null default '[]'::jsonb,
  experience jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  certifications jsonb not null default '[]'::jsonb,
  languages jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  achievements jsonb not null default '[]'::jsonb,

  -- funnel Q&A + progress (was conversation_turns + question_states)
  conversation jsonb not null default '[]'::jsonb,
  question_state jsonb not null default '{}'::jsonb,

  -- Improvement-loop position, 0–3. Previously kept in the browser's
  -- localStorage, which meant the cap reset on a new device or a cleared cache.
  -- It is server state now, and MAX_RESUME_ITERATIONS is enforced against it.
  iteration int not null default 0 check (iteration between 0 and 3),

  -- Optimistic-concurrency guard. Every write to a JSONB list bumps this and
  -- asserts the value it read, so two concurrent edits cannot lose one another.
  revision bigint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists funnel_user_id_idx on funnel(user_id);
-- Entry lookups arrive with only an entry id (updateExperience(entryId, …)), so
-- the store finds the owning row by JSONB containment. GIN makes that an index
-- scan rather than a sequential one.
create index if not exists funnel_education_gin on funnel using gin (education jsonb_path_ops);
create index if not exists funnel_experience_gin on funnel using gin (experience jsonb_path_ops);
create index if not exists funnel_skills_gin on funnel using gin (skills jsonb_path_ops);
create index if not exists funnel_certifications_gin on funnel using gin (certifications jsonb_path_ops);
create index if not exists funnel_languages_gin on funnel using gin (languages jsonb_path_ops);
create index if not exists funnel_projects_gin on funnel using gin (projects jsonb_path_ops);
create index if not exists funnel_achievements_gin on funnel using gin (achievements jsonb_path_ops);

drop trigger if exists funnel_updated_at on funnel;
create trigger funnel_updated_at before update on funnel
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. resume_pdfs — every generated résumé and its stored PDF
-- ─────────────────────────────────────────────────────────────────────────────
-- `content` holds the whole generated document (summary + the six section
-- blocks, each bullet still carrying its source trace) as one object, rather
-- than the seven separate columns it used to occupy.
create table if not exists resume_pdfs (
  id uuid primary key default gen_random_uuid(),
  funnel_id uuid not null references funnel(id) on delete cascade,
  version int not null default 1,
  content jsonb not null default '{}'::jsonb,
  html text not null default '',
  pdf_path text,
  created_at timestamptz not null default now()
);
create index if not exists resume_pdfs_funnel_idx on resume_pdfs(funnel_id, version desc);

comment on column resume_pdfs.pdf_path is
  'Storage object path in the private "resumes" bucket. One PDF per funnel row: '
  'every generation overwrites it, so only the latest version''s path is current.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3–5. iteration_1 / iteration_2 / iteration_3
-- ─────────────────────────────────────────────────────────────────────────────
-- One table per improvement round, as requested, each holding the question that
-- was asked and the answer that came back. They are an audit log of the round:
-- the answers are also applied to `funnel` through the normal pipeline, so
-- deleting a row here loses the record, not the résumé content.
--
-- Note the shape is identical three times over. That is a deliberate, accepted
-- trade for having three browsable tabs: a fourth round would need a migration,
-- and any column change has to be made three times. MAX_RESUME_ITERATIONS in
-- lib/config/limits.ts must stay at 3 to match.
do $$
declare
  n int;
begin
  for n in 1..3 loop
    execute format($fmt$
      create table if not exists iteration_%s (
        id uuid primary key default gen_random_uuid(),
        funnel_id uuid not null references funnel(id) on delete cascade,
        question_id text not null,
        question text not null,
        answer text,
        created_at timestamptz not null default now()
      );
      create index if not exists iteration_%s_funnel_idx on iteration_%s(funnel_id);
    $fmt$, n, n, n);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill from the old schema, then drop it
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.resume_profiles') is null then
    return; -- fresh project: nothing to migrate
  end if;

  -- 0006 renames generated_resumes.pdf_url -> pdf_path. Repeat it here rather
  -- than assume it ran: applying this file to a database still at 0005 would
  -- otherwise fail deep inside the backfill, with the old tables already half
  -- read. Both are no-ops once the column has its new name.
  if to_regclass('public.generated_resumes') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'generated_resumes'
         and column_name = 'pdf_url'
     ) then
    alter table generated_resumes rename column pdf_url to pdf_path;
  end if;

  insert into funnel (
    id, user_id, status, target_role, career_goal, location, interests,
    progress_percentage, current_section, finalized_at, terms_accepted_at,
    terms_version, personal_information, education, experience, skills,
    certifications, languages, projects, achievements, conversation,
    question_state, created_at, updated_at
  )
  select
    p.id, p.user_id, p.status, p.target_role, p.career_goal, p.location,
    coalesce(p.interests, '{}'), p.progress_percentage, p.current_section,
    p.finalized_at, p.terms_accepted_at, p.terms_version,
    coalesce((select mcv_camelize(to_jsonb(x)) from personal_information x
              where x.resume_profile_id = p.id), '{}'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.id) from education_entries x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.id) from experience_entries x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.created_at) from skills x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.id) from certifications x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.id) from languages x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.id) from projects x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.id) from achievements x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select jsonb_agg(mcv_camelize(to_jsonb(x)) order by x.created_at) from conversation_turns x
              where x.resume_profile_id = p.id), '[]'::jsonb),
    coalesce((select mcv_camelize(to_jsonb(x)) from question_states x
              where x.resume_profile_id = p.id), '{}'::jsonb),
    p.created_at, p.updated_at
  from resume_profiles p
  on conflict (id) do nothing;

  if to_regclass('public.generated_resumes') is not null then
    insert into resume_pdfs (id, funnel_id, version, content, html, pdf_path, created_at)
    select
      g.id, g.resume_profile_id, g.version,
      jsonb_build_object(
        'professionalSummary', coalesce(g.professional_summary, ''),
        'skills',         coalesce(g.skills, '[]'::jsonb),
        'experience',     coalesce(g.experience, '[]'::jsonb),
        'education',      coalesce(g.education, '[]'::jsonb),
        'certifications', coalesce(g.certifications, '[]'::jsonb),
        'projects',       coalesce(g.projects, '[]'::jsonb),
        'languages',      coalesce(g.languages, '[]'::jsonb)
      ),
      coalesce(g.html, ''), g.pdf_path, g.created_at
    from generated_resumes g
    where exists (select 1 from funnel f where f.id = g.resume_profile_id)
    on conflict (id) do nothing;
  end if;
end $$;

drop table if exists generated_resumes cascade;
drop table if exists question_states cascade;
drop table if exists conversation_turns cascade;
drop table if exists achievements cascade;
drop table if exists projects cascade;
drop table if exists languages cascade;
drop table if exists certifications cascade;
drop table if exists skills cascade;
drop table if exists experience_entries cascade;
drop table if exists education_entries cascade;
drop table if exists personal_information cascade;
drop table if exists resume_profiles cascade;

-- `users` mirrored auth.users and was maintained by a trigger; funnel.user_id
-- references auth.users directly now, so both go.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_auth_user() cascade;
drop table if exists users cascade;

drop function if exists mcv_camelize(jsonb);
drop function if exists mcv_snake_to_camel(text);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table funnel enable row level security;
alter table resume_pdfs enable row level security;
alter table iteration_1 enable row level security;
alter table iteration_2 enable row level security;
alter table iteration_3 enable row level security;

drop policy if exists funnel_owner on funnel;
create policy funnel_owner on funnel
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists resume_pdfs_owner on resume_pdfs;
create policy resume_pdfs_owner on resume_pdfs
  for all
  using (exists (select 1 from funnel f where f.id = funnel_id and f.user_id = auth.uid()))
  with check (exists (select 1 from funnel f where f.id = funnel_id and f.user_id = auth.uid()));

do $$
declare
  n int;
begin
  for n in 1..3 loop
    execute format($fmt$
      drop policy if exists iteration_%s_owner on iteration_%s;
      create policy iteration_%s_owner on iteration_%s
        for all
        using (exists (select 1 from funnel f where f.id = funnel_id and f.user_id = auth.uid()))
        with check (exists (select 1 from funnel f where f.id = funnel_id and f.user_id = auth.uid()));
    $fmt$, n, n, n, n);
  end loop;
end $$;


-- ============ 0008_resume_pdf_per_stage.sql ============

-- Drop `resume_pdfs`; put the résumé on `funnel`, and a PDF path on every stage.
--
-- ── What this is for ─────────────────────────────────────────────────────────
-- The product has three improvement rounds (`iteration_1..3`), but only ever had
-- ONE stored PDF: `<user_id>/<funnel_id>/curriculum.pdf`, overwritten by every
-- generation. So there was no way to see how a user's résumé actually changed as
-- they answered more questions — the only artifact was the final state.
--
-- Now each ROUND owns its own object, and the row that produced it names it:
--
--   funnel.resume_pdf        <user_id>/<funnel_id>/curriculum.pdf    (initial)
--   iteration_1.resume_pdf   <user_id>/<funnel_id>/iteration-1.pdf   (after round 1)
--   iteration_2.resume_pdf   <user_id>/<funnel_id>/iteration-2.pdf   (after round 2)
--   iteration_3.resume_pdf   <user_id>/<funnel_id>/iteration-3.pdf   (after round 3)
--
-- `funnel.resume_pdf` always names the CURRENT résumé's object, whichever round
-- that is; the `iteration_N` columns are the historical snapshots. Open them in
-- order and you see the résumé improve.
--
-- ── What this costs, stated plainly ──────────────────────────────────────────
--  * Up to FOUR PDFs per user instead of one. 0006 deliberately kept a single
--    object so storage could not grow as a user iterated and PII at rest stayed
--    minimal; that trade is now reversed, on purpose, because per-round history
--    is the point. The cap is still hard (4), since MAX_RESUME_ITERATIONS is 3.
--  * No per-version content history. `resume_pdfs` accumulated one row per
--    generation with its own `content` + `html`; those columns move to `funnel`
--    and hold only the CURRENT résumé. What survives per round is the rendered
--    PDF, not diffable JSON.
--
-- ── Why the résumé moves onto `funnel` ───────────────────────────────────────
-- `resume_pdfs` was named for its path column but was really the generated-résumé
-- table: `content` (professionalSummary + the six section blocks, each bullet
-- still carrying its source trace) and `html` are what the CV page, the preview,
-- the analyzer, the proofreader and the download all read. There is exactly one
-- current résumé per funnel row, so the table was a 1:1 join in every code path
-- that touched it. It collapses into columns.
--
-- Idempotent. Run it once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The current résumé, on `funnel`
-- ─────────────────────────────────────────────────────────────────────────────
alter table funnel
  -- Identity of the current generated résumé, carried over from `resume_pdfs.id`.
  -- Kept because it changes on every generation, which is what makes it usable
  -- as the analysis cache key (`lib/resume/analysis-cache.ts`) — and what lets a
  -- write from a superseded generation find no row instead of clobbering a newer
  -- résumé's PDF path.
  add column if not exists resume_id uuid,
  -- The whole generated document, exactly the shape `resume_pdfs.content` held.
  add column if not exists resume_content jsonb not null default '{}'::jsonb,
  add column if not exists resume_html    text   not null default '',
  -- Monotonic per-generation counter, carried over from `resume_pdfs.version`.
  -- Counts EVERY generation, including proofreads and section regenerations —
  -- which is why it is not the same thing as the round below.
  add column if not exists resume_version int    not null default 0,
  -- Which improvement round the current résumé belongs to, and therefore which
  -- object holds it: 0 = the initial generation, 1..3 = after that round.
  -- Distinct from `iteration` (rounds COMPLETED): a regeneration mid-round
  -- re-renders the open round's PDF without consuming a round.
  add column if not exists resume_stage   int    not null default 0,
  -- Storage object path of the current résumé's PDF; null until one is stored.
  add column if not exists resume_pdf     text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'funnel_resume_stage_range'
  ) then
    alter table funnel
      add constraint funnel_resume_stage_range check (resume_stage between 0 and 3);
  end if;
end $$;

comment on column funnel.resume_content is
  'The current generated résumé: professionalSummary + the six section blocks, '
  'camelCase, exactly types/domain.ts GeneratedResume. Bullets keep their source traces.';
comment on column funnel.resume_pdf is
  'Storage path of the CURRENT résumé''s PDF in the private "resumes" bucket. '
  'Points at curriculum.pdf before the first improvement round and at '
  'iteration-N.pdf after round N — the same object iteration_N.resume_pdf names.';
comment on column funnel.resume_stage is
  'Improvement round the current résumé belongs to (0 = initial). Selects the PDF object.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. A PDF path on each round
-- ─────────────────────────────────────────────────────────────────────────────
-- `iteration_N` holds one row per QUESTION, not one per round, so every row of a
-- round carries that round's path: the generation that closes the round stamps
-- them all. Repeating the value beats a nullable-except-the-last-row column —
-- any row you happen to open tells you which PDF that round produced.
do $$
declare
  n int;
begin
  for n in 1..3 loop
    execute format(
      'alter table iteration_%s add column if not exists resume_pdf text', n
    );
    execute format(
      'comment on column iteration_%s.resume_pdf is %L', n,
      'Storage path of the PDF rendered when this round closed. Same value on '
      'every row of the round; null until the round''s regeneration runs.'
    );
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Move the latest résumé across, then drop the table
-- ─────────────────────────────────────────────────────────────────────────────
-- Only the latest version moves: it is the only one the app ever read, and it is
-- the only one whose `pdf_path` still names live bytes (every generation
-- overwrote the single object).
--
-- `resume_stage` is left at its 0 default for migrated rows. Existing PDFs all
-- live at curriculum.pdf regardless of which round produced them, so claiming a
-- round here would name an object that was never written. Pre-existing profiles
-- therefore have no per-round history — there is none to recover — and their next
-- generation starts populating it.
do $$
begin
  if to_regclass('public.resume_pdfs') is null then
    return; -- already migrated
  end if;

  update funnel f
     set resume_id      = r.id,
         resume_content = coalesce(r.content, '{}'::jsonb),
         resume_html    = coalesce(r.html, ''),
         resume_version = coalesce(r.version, 0),
         resume_pdf     = r.pdf_path
    from (
      select distinct on (funnel_id) funnel_id, id, content, html, version, pdf_path
        from resume_pdfs
       order by funnel_id, version desc, created_at desc
    ) r
   where r.funnel_id = f.id;
end $$;

drop table if exists resume_pdfs cascade;


-- ============ 0009_usage_limits.sql ============
-- Rate limiting + AI spend caps.
--
-- ── Why this exists ──────────────────────────────────────────────────────────
-- The product has no login: `resolveUserId()` mints a guest session for whoever
-- shows up. That is deliberate, but it means an unauthenticated script can create
-- unlimited identities, and every one of them can drive `POST …/generate`, which
-- costs real money on Azure at `reasoning.effort: high`. Nothing bounded that.
--
-- What existed before was DEDUPLICATION (the analysis cache, the generation lock)
-- and COST LOGGING (`lib/ai/pricing.ts` prints an estimate per call). Neither is a
-- ceiling: they make the same work cheaper, not the total finite.
--
-- ── Why Postgres and not a KV service ───────────────────────────────────────
-- Vercel runs many instances, so an in-process counter is per-instance and the
-- effective limit multiplies by the instance count. This database is already a
-- required dependency, so it is the only shared state the app has that costs
-- nothing new to operate.
--
-- ── Why the service role, and nothing else, may touch these ─────────────────
-- `NEXT_PUBLIC_SUPABASE_ANON_KEY` is in the browser bundle, so anything an
-- anonymous caller may execute, an attacker may execute directly against
-- PostgREST. A rate-limit counter takes an opaque key, so a `grant execute` to
-- `anon` would let anyone burn *another* user's quota by passing their key — and
-- write junk into the spend ledger to trip the daily cap for everybody. So:
-- execute is revoked from public and granted only to `service_role`, which lives
-- exclusively in server-side code (`SUPABASE_SERVICE_ROLE_KEY`).
--
-- This makes `SUPABASE_SERVICE_ROLE_KEY` REQUIRED for enforcement. Without it the
-- app still runs and logs a loud configuration error, but the limits do not bite
-- (see `lib/rate-limit/index.ts`) — a missing key must not take the product down.

-- ── 1. Rate limits: one row per key, fixed window reset in place ─────────────
--
-- One row per key rather than one per (key, window) so the table is bounded by
-- the number of distinct keys ever seen instead of growing with every window. A
-- key is `<scope>:<id>:<operation>` — see `lib/rate-limit/policy.ts`.
create table if not exists rate_limits (
  key text primary key,
  window_started_at timestamptz not null default now(),
  hits integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table rate_limits is
  'Fixed-window request counters keyed by <scope>:<id>:<operation>. Written only by the service role, through rate_limit_hit().';

-- Lets an operator sweep abandoned keys: `delete from rate_limits where updated_at < now() - interval '30 days'`.
create index if not exists rate_limits_updated_idx on rate_limits (updated_at);

-- ── 2. AI spend ledger ──────────────────────────────────────────────────────
--
-- One row per model call. `usd_estimate` is exactly what `[ai-usage]` logs, so the
-- caps are enforced against the same number an operator sees in the logs — Azure's
-- own billing remains the source of truth for actual cost.
create table if not exists ai_spend (
  id uuid primary key default gen_random_uuid(),
  -- `set null`, not `cascade`: deleting a profile or a user must not erase the
  -- record of money already spent, and must not silently reopen the daily cap.
  user_id uuid references auth.users(id) on delete set null,
  resume_profile_id uuid references funnel(id) on delete set null,
  /* Which call: generate_resume, analyze_resume, proofread, normalize_answer, … */
  operation text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  usd_estimate numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

comment on column ai_spend.usd_estimate is
  'Estimated USD from lib/ai/pricing.ts — the number the caps compare against. Azure billing is authoritative for real cost.';

create index if not exists ai_spend_day_idx on ai_spend (created_at desc);
create index if not exists ai_spend_profile_idx on ai_spend (resume_profile_id, created_at desc);
create index if not exists ai_spend_user_idx on ai_spend (user_id, created_at desc);

-- ── 3. RLS: on, with NO policies ────────────────────────────────────────────
--
-- Enabling RLS without any policy denies every role that respects it, which is the
-- intent: these tables are infrastructure, not user data. The service role bypasses
-- RLS, so the functions below still work.
alter table rate_limits enable row level security;
alter table ai_spend enable row level security;

-- ── 4. rate_limit_hit(): atomic fixed-window counter ────────────────────────
--
-- Returns the hit count INSIDE the current window (1 on the first request). The
-- LIMIT lives in application code (`lib/rate-limit/policy.ts`) so it is testable
-- and reviewable next to the reason for it; this function only counts.
--
-- Single statement on purpose: `insert … on conflict do update … returning` is
-- atomic, so two concurrent requests cannot both read "1" and both be allowed.
create or replace function rate_limit_hit(p_key text, p_window_seconds integer)
returns integer
language sql
volatile
set search_path = public, pg_temp
as $$
  insert into rate_limits (key, window_started_at, hits, updated_at)
  values (p_key, now(), 1, now())
  on conflict (key) do update set
    hits = case
      when rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds)
      then 1
      else rate_limits.hits + 1
    end,
    window_started_at = case
      when rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds)
      then now()
      else rate_limits.window_started_at
    end,
    updated_at = now()
  returning hits;
$$;

-- ── 5. record_ai_spend(): append one call to the ledger ─────────────────────
create or replace function record_ai_spend(
  p_user uuid,
  p_profile uuid,
  p_operation text,
  p_model text,
  p_input integer,
  p_output integer,
  p_cached integer,
  p_usd numeric
)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  insert into ai_spend (
    user_id, resume_profile_id, operation, model,
    input_tokens, output_tokens, cached_tokens, usd_estimate
  )
  values (
    p_user, p_profile, p_operation, p_model,
    coalesce(p_input, 0), coalesce(p_output, 0), coalesce(p_cached, 0), coalesce(p_usd, 0)
  );
$$;

-- ── 6. ai_spend_state(): the three totals a budget decision needs ───────────
--
-- One round trip for all three, because they are always wanted together and a
-- budget check sits in front of the most latency-sensitive route in the app.
--
-- `global_day_usd` is the UTC calendar day, not a rolling 24h: an operator
-- comparing it against an Azure daily total wants the same day boundary Azure
-- reports on.
create or replace function ai_spend_state(p_user uuid, p_profile uuid)
returns table (profile_usd numeric, user_usd numeric, global_day_usd numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    coalesce((select sum(usd_estimate) from ai_spend where resume_profile_id = p_profile), 0),
    coalesce((select sum(usd_estimate) from ai_spend where user_id = p_user), 0),
    coalesce((
      select sum(usd_estimate) from ai_spend
      -- Explicitly UTC. Bare `date_trunc('day', now())` truncates in the SESSION
      -- time zone, so on a non-UTC connection the "day" would silently shift and
      -- stop matching both this file's comment and MemorySpendLedger.
      where created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
    ), 0);
$$;

-- ── 7. Grants: service role only ────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC by default, so revoking is not optional here.
revoke execute on function rate_limit_hit(text, integer) from public;
revoke execute on function record_ai_spend(uuid, uuid, text, text, integer, integer, integer, numeric) from public;
revoke execute on function ai_spend_state(uuid, uuid) from public;

grant execute on function rate_limit_hit(text, integer) to service_role;
grant execute on function record_ai_spend(uuid, uuid, text, text, integer, integer, integer, numeric) to service_role;
grant execute on function ai_spend_state(uuid, uuid) to service_role;


-- ============ 0010_talent_directory.sql ============

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


-- ============ 0011_talent_proximity.sql ============

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


-- ============ 0012_talent_name_search.sql ============

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


-- ============ 0013_employer_email_verification.sql ============

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  SUPERSEDED — read this before following anything below.                   ║
-- ║                                                                           ║
-- ║  This migration's DDL is still LIVE and must not be reverted: the table    ║
-- ║  and function it creates are retained deliberately as the rollback path.   ║
-- ║  What is superseded is its INSTRUCTION and its reasoning.                  ║
-- ║                                                                           ║
-- ║  Verification and password recovery are Supabase Auth's again, delivered   ║
-- ║  over Resend Custom SMTP. Nothing in the application issues or consumes    ║
-- ║  the tokens below any more.                                               ║
-- ║                                                                           ║
-- ║  >>> "Confirm email" must now be ON, not OFF. <<<                          ║
-- ║                                                                           ║
-- ║  Turning it OFF, as the text below instructs, makes email confirmation     ║
-- ║  advisory: signUp would return a working session immediately and an        ║
-- ║  unconfirmed address could sign in. See AUTH_PRODUCTION_SETUP.md.          ║
-- ║                                                                           ║
-- ║  The two objections recorded below were real and are now answered:         ║
-- ║  Custom SMTP replaces the capped, org-only built-in sender, and            ║
-- ║  token_hash links to /auth/confirm work in any browser where a PKCE link   ║
-- ║  did not. Neither was available when this was written.                     ║
-- ║                                                                           ║
-- ║  Everything below is kept as the record of why the detour happened, and    ║
-- ║  so that reverting the switch needs no database change.                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- Employer email verification, owned by this application.
--
-- ── Why verification moved off Supabase Auth ────────────────────────────────
-- It was built on GoTrue's confirmation email, and that could not be shipped:
--
--   * the built-in sender is rate-limited to a handful of messages an hour and,
--     on current projects, only delivers to addresses belonging to the Supabase
--     organization — so every real sign-up produced a cheerful "revisa tu
--     correo" and an empty inbox, with NO error anywhere, because `signUp`
--     returned success and the message was dropped downstream;
--   * even with custom SMTP configured, the template, the token lifetime, the
--     link shape and the retry behaviour all stay inside GoTrue, so the two
--     failures we actually hit (a PKCE link that only works in the browser that
--     signed up, and an unconfigurable redirect) remain unfixable from here.
--
-- So the token is ours now. Supabase Auth still owns the ACCOUNT — password
-- hashing, sessions, refresh — which is the part it does well and the part we
-- must not reimplement. What we own is the one thing it could not deliver: a
-- message to an arbitrary mailbox, and the proof that it was received.
--
-- **This requires "Confirm email" to be turned OFF** in the Supabase dashboard.
-- With it on, GoTrue blocks sign-in until ITS confirmation happens, which we can
-- no longer complete. Verification is now `employers.email_verified_at`, which is
-- what the gate reads.
--
-- Idempotent. Run once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Verification state on the employer row
-- ─────────────────────────────────────────────────────────────────────────────
alter table employers add column if not exists email_verified_at timestamptz;

comment on column employers.email_verified_at is
  'When this employer proved they control their mailbox, via a token we issued. NULL means unverified: the account can sign in but sees no candidates. Replaces auth.users.email_confirmed_at as the gate''s input.';

-- Anyone who made it through the old Supabase-email flow is already verified;
-- do not make them do it twice. Reads `auth.users` directly, which is safe in a
-- migration (it runs as the owner) and is the last time this column is consulted.
update employers e
   set email_verified_at = u.email_confirmed_at
  from auth.users u
 where u.id = e.id
   and e.email_verified_at is null
   and u.email_confirmed_at is not null;

-- ── One employer row per address, enforced ──────────────────────────────────
-- `auth.users` already makes an email unique, and `employers.id` references it,
-- so duplicates cannot arise through the app. They CAN arise from a row inserted
-- by hand in the dashboard, and the consequence is disproportionate: the resend
-- and password-reset flows look an employer up by address with `maybeSingle()`,
-- which ERRORS when two rows match, so one stray duplicate turns every reset for
-- that person into a 500.
--
-- `lower(email)` rather than `email`, because the lookup is case-insensitive
-- (`ilike`) while the column is not — otherwise `Ana@x.com` and `ana@x.com`
-- coexist happily in the table and match the same query.
--
-- This CREATE will fail loudly if duplicates already exist. That is correct:
-- resolving them is a decision about which row is real, not something a migration
-- should guess at.
create unique index if not exists employers_email_lower_idx on employers (lower(email));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The tokens
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ── Only the HASH is stored ─────────────────────────────────────────────────
-- The row holds `sha256(token)`, never the token. The same reasoning that
-- applies to passwords applies here: a verification link is a bearer credential,
-- and a reset link is enough to take over an account. Anyone who can read this
-- table — a leaked backup, a support query, a future `select *` in a log — must
-- get nothing usable. Lookups are BY hash, so this costs nothing: the hash is
-- the index key, and there is no comparison to time-attack.
--
-- ── Purpose is part of the row, not implied by the caller ────────────────────
-- A token issued to confirm an address must not be usable to change a password.
-- Storing the purpose and matching on it makes that structural rather than a
-- property of whichever handler happens to look the token up.
--
-- ── Expiry and single use are both enforced in the QUERY ─────────────────────
-- Same choice as the talent listings' 90-day expiry: a `where` clause cannot be
-- skipped by a cron that did not run. `consumed_at` is set in the same statement
-- that accepts the token, so a link cannot be replayed even in a race.
create table if not exists employer_email_tokens (
  id uuid primary key default gen_random_uuid(),
  employer_id uuid not null references employers(id) on delete cascade,
  purpose text not null check (purpose in ('verify', 'reset')),
  token_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- Best-effort, for abuse triage only. Never shown to anyone.
  ip text,
  created_at timestamptz not null default now()
);

-- The lookup is always "this exact hash, for this purpose", so one unique index
-- serves it and simultaneously stops the same token existing twice.
create unique index if not exists employer_email_tokens_hash_idx
  on employer_email_tokens (token_hash);

-- Used when re-issuing: the previous outstanding tokens for a purpose are
-- invalidated, so a resend does not leave two working links in two inboxes.
create index if not exists employer_email_tokens_employer_idx
  on employer_email_tokens (employer_id, purpose, consumed_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS: on, with NO policies
-- ─────────────────────────────────────────────────────────────────────────────
-- The same pattern as `talent_contacts`, `rate_limits` and `ai_spend`, and for
-- the strongest version of the reason: `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships to
-- browsers, and a readable policy here would publish password-reset credentials
-- to the internet. Only the service role can see this table.
alter table employer_email_tokens enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Consume a token, atomically
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE statement, for the same reason `talent_reveal_contact` is one statement:
-- the check and the state change cannot be separated. Two calls from a route
-- could always drop the second, and here that would leave a reset link that
-- works twice — enough for a stale link in a mailbox to be replayed after the
-- password has already been changed.
--
-- Returns the employer id when the token was valid AND unused AND unexpired AND
-- of the right purpose; nothing otherwise. The caller cannot tell those apart,
-- which is deliberate: "expired" and "already used" and "never existed" are all
-- one message to whoever is holding the link.
create or replace function mcv_consume_employer_token(
  p_token_hash text,
  p_purpose text
)
returns table (employer_id uuid)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update employer_email_tokens
     set consumed_at = now()
   where token_hash = p_token_hash
     and purpose = p_purpose
     and consumed_at is null
     and expires_at > now()
  returning employer_id;
$$;

revoke execute on function mcv_consume_employer_token(text, text) from public;
grant execute on function mcv_consume_employer_token(text, text) to service_role;
