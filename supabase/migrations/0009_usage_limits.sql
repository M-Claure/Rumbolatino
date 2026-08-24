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
