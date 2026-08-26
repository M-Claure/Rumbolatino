-- Talent directory: an HTML résumé preview, and a reveal log that counts people
-- instead of page loads.
--
-- ── Why the preview needs HTML at all ────────────────────────────────────────
-- `components/talent/ResumePreview.tsx` frames the candidate's PDF so an
-- employer can read a résumé without collecting a file. That works everywhere a
-- browser will render `application/pdf` inside an iframe — and iOS does not.
-- WebKit hands PDFs to the system viewer at the top-level navigation layer and
-- does not expose that renderer to a subframe, so on an iPhone the frame shows a
-- blank box or a non-scrollable first page. It fails SILENTLY: the frame
-- navigates fine, `onLoad` fires, and there is no DOM inside a native PDF
-- handler to probe. A large share of this audience is on exactly that browser.
--
-- The fix is not to render a PDF harder. `lib/resume/resume-renderer.ts` already
-- produces the HTML that Chromium prints to MAKE the PDF — self-contained, one
-- inline <style>, no scripts, every piece of user text through `esc()` — and its
-- CSS is a deliberate mirror of the printed sheet (800x1131px is A4 at 96dpi,
-- with `max-width:100%` so it scales down on a phone). Serving that for the
-- preview renders in every browser, keeps the text selectable and zoomable, and
-- retires the whole class of "PDF in an iframe" problem instead of detecting it.
--
-- ── Why the HTML is a SNAPSHOT here, not a join to funnel ────────────────────
-- `funnel.resume_html` is the CURRENT résumé. A listing is a projection taken at
-- publish time, and `talent_contacts.resume_pdf_path` is already a snapshot
-- pointer, so reading the HTML live would let the preview and the download show
-- different versions the moment someone regenerates without re-publishing. It
-- goes in `talent_contacts` — beside the PDF path, not on `talent_profiles` —
-- because it is the same disclosure class: it carries the person's full name,
-- email and phone. That table has RLS on with no policies, so the column is
-- reachable only through the reveal function below.
--
-- ── Why the reveal log gains a column instead of dropping rows ───────────────
-- A preview and a download spend the same `contact_reveal` allowance, which is
-- correct — same bytes, same disclosure. But the escape-hatch tab, a reload, or
-- reopening the frame in a new tab each spent ANOTHER one and wrote another
-- audit row for the same person, so an employer on iOS burned the limit at twice
-- the rate of one on a laptop, and `contact_reveals` counted page loads where it
-- meant to count disclosures.
--
-- Every row is still written. `is_repeat` marks the ones that are a re-read
-- inside the dedupe window, which is strictly MORE information than before —
-- "who has my résumé?" reads first disclosures, and "how often did they look?"
-- is still answerable. What changes is only what the rate limit charges for; see
-- `talent_recent_reveal_exists` and `REVEAL_DEDUPE_MINUTES` in
-- `lib/rate-limit/policy.ts`.
--
-- Idempotent. Run once; re-running is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The résumé HTML, snapshotted beside the PDF path
-- ─────────────────────────────────────────────────────────────────────────────
alter table talent_contacts add column if not exists resume_html text not null default '';

comment on column talent_contacts.resume_html is
  'The rendered résumé HTML, snapshotted at publish time, served as the employer preview. Lives here and not on talent_profiles because it carries the full name, email and phone — the same disclosure class as resume_pdf_path. Empty for listings published before 0015; the route falls back to framing the PDF.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Reveal audit: mark a re-read as a re-read
-- ─────────────────────────────────────────────────────────────────────────────
alter table contact_reveals add column if not exists is_repeat boolean not null default false;

comment on column contact_reveals.is_repeat is
  'True when this employer had already been given this profile''s contact inside the dedupe window. The row is written either way; only the rate limit treats the two differently.';

-- The dedupe check is "has THIS employer seen THIS profile recently", which the
-- existing (employer_id, revealed_at desc) index can only answer by scanning
-- every profile that employer has ever opened.
create index if not exists contact_reveals_dedupe_idx
  on contact_reveals (employer_id, talent_profile_id, revealed_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Has this employer already been given this contact?
-- ─────────────────────────────────────────────────────────────────────────────
-- Read-only, and deliberately returns a BOOLEAN and nothing else: it runs BEFORE
-- the rate limit, which is before the caller has earned the right to any contact
-- data. It cannot become a way to read a contact without being logged, because
-- there is nothing here to read.
--
-- It has to be a separate call rather than a flag on the reveal, because the
-- order matters: charge the limit, then disclose. Revealing first and refusing
-- afterwards would write an audit row saying an employer received details they
-- were never given.
--
-- A window boundary crossed between this call and the reveal is harmless in both
-- directions — one uncharged re-read, or one charged first read.
create or replace function talent_recent_reveal_exists(
  p_employer uuid,
  p_slug text,
  p_within_minutes integer
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from contact_reveals r
    join talent_profiles t on t.id = r.talent_profile_id
    where r.employer_id = p_employer
      and t.slug = p_slug
      and coalesce(p_within_minutes, 0) > 0
      and r.revealed_at > now() - make_interval(mins => p_within_minutes)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The reveal, still ONE statement, now carrying the HTML
-- ─────────────────────────────────────────────────────────────────────────────
-- Unchanged in the part that matters: the insert and the select are one
-- statement, so contact data cannot come back without the access being recorded.
-- Two callers could always drop the second of two calls.
--
-- The signature changes, so the old one is dropped first — `create or replace`
-- with different parameters OVERLOADS rather than replaces, and the stale
-- overload would keep its grant. Same reason 0011 dropped `talent_search`.
--
-- `p_dedupe_minutes` defaults to 0, meaning "count nothing as a repeat". That is
-- the conservative direction: a caller who forgets it marks every read as a
-- first disclosure, rather than silently deciding one was free.
drop function if exists talent_reveal_contact(uuid, text, text);

create or replace function talent_reveal_contact(
  p_employer uuid,
  p_slug text,
  p_ip text default null,
  p_dedupe_minutes integer default 0
)
returns table (
  full_name text,
  email text,
  phone text,
  linkedin_url text,
  resume_pdf_path text,
  resume_html text,
  is_repeat boolean
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile uuid;
  v_repeat boolean;
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

  select exists (
    select 1
    from contact_reveals r
    where r.employer_id = p_employer
      and r.talent_profile_id = v_profile
      and coalesce(p_dedupe_minutes, 0) > 0
      and r.revealed_at > now() - make_interval(mins => p_dedupe_minutes)
  ) into v_repeat;

  insert into contact_reveals (employer_id, talent_profile_id, ip, is_repeat)
  values (p_employer, v_profile, p_ip, v_repeat);

  return query
    select c.full_name, c.email, c.phone, c.linkedin_url, c.resume_pdf_path,
           c.resume_html, v_repeat
    from talent_contacts c
    where c.talent_profile_id = v_profile;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Grants: service role only
-- ─────────────────────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC by default, so the revokes are load-bearing.
-- A `security definer` function left executable by PUBLIC runs as its owner and
-- ignores RLS — strictly worse than a public table.
revoke execute on function talent_recent_reveal_exists(uuid, text, integer) from public;
revoke execute on function talent_reveal_contact(uuid, text, text, integer) from public;

grant execute on function talent_recent_reveal_exists(uuid, text, integer) to service_role;
grant execute on function talent_reveal_contact(uuid, text, text, integer) to service_role;
