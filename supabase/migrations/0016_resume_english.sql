-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — English translation of the generated résumé
--
-- A finished résumé can be translated into English on demand, once, after the
-- user finalizes it. The translation is a second DOCUMENT for the same profile,
-- so it lands as parallel columns on `funnel` rather than as a new table —
-- following the precedent 0008 set when it collapsed `resume_pdfs` into columns:
-- there is exactly one translation per language per profile, so a table would be
-- a 1:1 join in every path that touched it.
--
-- Why on demand and not per round: a translation is ~$0.017, but a résumé goes
-- through ~6 generations, and every translation before the last one is discarded
-- work on a document most users never open. See CLAUDE.md → "English résumé".
--
-- RLS: `funnel_owner` (0007) is a single `for all` policy on the row, so new
-- columns are covered with no policy change.
-- ─────────────────────────────────────────────────────────────────────────────

alter table funnel
  -- The translated document, same shape as `resume_content`. Kept alongside the
  -- HTML so a future template change can re-render English with no model call.
  add column if not exists resume_en_content jsonb not null default '{}'::jsonb,
  add column if not exists resume_en_html    text   not null default '',
  -- Storage object path of the English PDF; null until one is stored. ONE object
  -- per profile (`curriculum-en.pdf`) — a translation mirrors only the CURRENT
  -- résumé, so unlike the Spanish PDFs it keeps no per-round history.
  add column if not exists resume_en_pdf     text,
  -- The `resume_version` this translation was made from. Null = never translated.
  -- When it trails `resume_version` the English résumé is stale, which is what
  -- makes re-translation an explicit user action instead of a silent cost.
  add column if not exists resume_en_source_version int,
  add column if not exists resume_en_created_at timestamptz;
