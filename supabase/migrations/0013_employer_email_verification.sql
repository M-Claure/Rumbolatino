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
