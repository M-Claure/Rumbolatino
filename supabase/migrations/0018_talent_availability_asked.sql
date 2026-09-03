-- Availability becomes a real answer, so it needs a way to say "never asked".
--
-- The publish popup now asks "¿cuándo podrías empezar a trabajar?" and stores
-- what the person chose. Until now nobody was asked and `talent-publish.ts`
-- stamped every listing `flexible` purely to satisfy this column's `not null` —
-- a placeholder, not an answer. The profile page rendered that placeholder as
-- "Mi fecha de inicio es flexible", in the first person, which had the product
-- stating a fact about a person that they had never given us.
--
-- ── Why NULL rather than a fifth enum value ────────────────────────────────
-- "Not asked" is not one of the things somebody can be. Adding `no_indicada` to
-- the enum would put a non-answer in the same closed list as the four answers,
-- which then has to be excluded by hand in every filter, every label lookup and
-- every dropdown — and one of those places will forget. NULL is excluded from
-- equality by the language itself: `t.availability = p_availability` is already
-- false for a null row, so `talent_search` needed no change at all, and the
-- filter cannot accidentally match a listing that never answered.
--
-- ── The backfill is the whole point, and it runs ONCE ──────────────────────
-- Every existing row holds `flexible`, and none of it is user data — the service
-- wrote it unconditionally. So the first run clears all of them, and those
-- listings show no availability and match no availability filter until their
-- owners re-publish, which is the honest state.
--
-- That update MUST NOT run a second time: once the popup is live, `flexible` is
-- a legitimate answer that people have actually chosen, and a re-run of a naive
-- `update … set availability = null where availability = 'flexible'` would erase
-- real answers. The guard is the column's own nullability — `not null` can only
-- be true on the first run — so the whole block is skipped afterwards. This is
-- why it is a `do` block and not three plain statements.
--
-- Idempotent. Run once; re-running is a no-op.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'talent_profiles'
      and column_name  = 'availability'
      and is_nullable  = 'NO'
  ) then
    -- Order matters: the column has to accept null before the rows can be set
    -- to it, and the default has to go or the next insert re-introduces the
    -- placeholder this migration exists to remove.
    alter table talent_profiles alter column availability drop not null;
    alter table talent_profiles alter column availability drop default;

    -- Unconditional, and correct precisely because this branch runs only while
    -- the column was still `not null` — i.e. before any real answer could
    -- exist. Filtering on `= 'flexible'` would look safer and would be the bug.
    update talent_profiles set availability = null;
  end if;
end $$;

-- The 0010 CHECK constraint is left exactly as it is: a null passes a
-- `check (availability in (…))` because the comparison yields null, not false.
-- So the four values stay the only things that can be STORED, and "nothing" is
-- also allowed. Nothing to alter.

comment on column talent_profiles.availability is
  'When the person said they could start, from the publish popup. NULL means they were never asked — every listing published before 0018 — and must be neither rendered nor matched by an availability filter. Not the same as a chosen ''flexible''.';
