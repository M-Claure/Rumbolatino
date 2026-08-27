# The English résumé

A finished Spanish résumé can be translated into English, once, when the user asks
for it. This document is the reasoning behind *when* that happens, because the
timing is the entire cost decision and it is not obvious from the code.

## Why on demand, and not after every improvement round

The alternative — translate automatically whenever a new résumé version exists —
is simpler to reason about and always ready instantly. It is also roughly forty
times more expensive, for a document most users never open.

A translation is one `reasoning.effort: "none"` call over prose that already
exists. On `gpt-5.3-codex` ($1.25/M input, $10/M output, $0.125/M cached input):

| | tokens | cost |
|---|---|---|
| input — stable instructions ~700 (cacheable) + id-keyed items ~1,400 | ~2,100 | $0.0026 |
| output — English JSON, ~10% shorter than the Spanish | ~1,400 | $0.0140 |
| **one translation** | | **~$0.017** |

Against the measured worst-case résumé of **$0.65–0.80** (see the note above
`AI_SPEND_CAP_*` in `lib/env.ts`), one translation is about 2%. That sounds cheap
enough to do eagerly. It is not, because the waste multiplies:

| policy | per 1,000 users, assuming 15% want English |
|---|---|
| translate every round | 1,000 × ~6 versions × $0.017 = **~$102** |
| translate once, on demand | 150 × $0.017 = **~$2.55** |

Two independent factors, each ~6×: a résumé goes through about six generations
(initial + three improvement rounds + a proofread, plus any section regenerate),
and only a minority of users want English at all.

Tokens are not the whole bill either. Eager translation adds a Chromium render per
round — the reason `export_pdf` is rate-limited at 40/hour is that a cold Chromium
start inside a 60s function is the cheapest way to exhaust concurrency — and it
multiplies the stored PDFs and the PII at rest for a document nobody asked for.

The decisive argument is not the money, though. **Every translation before the
last one is discarded work**: the user is still changing the Spanish résumé.

Two things would break this estimate if changed, so change them deliberately:

- **Raising `reasoning.effort` above `none`.** Reasoning tokens bill at the $10/M
  output rate and are never read back. There is no judgement to make here — the
  résumé is already written and approved.
- **Re-generating in English** through `buildResumeGenerationPrompt` instead of
  translating finished prose. That path resends the full confirmed-data JSON at
  `effort: "high"` with a 16,000-token ceiling: the single most expensive call in
  the product, and it lets the two documents disagree about what the person did.

## What is translated, and what is deliberately not

The model is shown the **finished résumé**, never the source data it was written
from. It therefore cannot introduce a fact the Spanish document does not make, and
every `entryId` and source trace survives untouched
(`tests/unit/translate-resume.test.ts` pins this).

**Sent**: the professional summary, every bullet, job titles, locations,
credentials and fields of study, skill-group categories and skill names, project
and certification names, language names and levels, the free-text dates
("marzo 2020"), the headline, and the interests.

**Never sent**: employers, institutions, certifying bodies, and the person's own
name and contact details. Not sending a proper noun is a stronger guarantee than
instructing a model to leave it alone, and it is why the prompt does not have to
police them.

**Never sent because it is not prose at all**: the section headings, the document
title, `<html lang>`, the "Present" marker and the experience-type fallback
labels. Those live in `LABELS` in `lib/resume/resume-renderer.ts` and cost nothing.
Keeping the furniture in code is also what stops a heading coming back
mistranslated or missing.

An id the model drops keeps its **original Spanish text**. One Spanish line in an
English résumé is a far better failure than a blank bullet.

## Staleness

`TranslatedResume.sourceVersion` records the `GeneratedResume.version` it was made
from. When the Spanish résumé moves ahead — a regenerate, a proofread, an edit —
the translation is *kept* (it is a real document the person asked for) but marked
stale, and the workspace button changes from "Descargar en inglés" to "Actualizar
versión en inglés".

It is never refreshed automatically. That would quietly reintroduce the per-round
cost this whole design exists to avoid, for anyone who translated once.

## Where it lives

- **Service**: `lib/resume/translate-resume.ts`, modelled on
  `lib/resume/proofread-resume.ts` — collect id-keyed strings, one model call,
  apply by id, re-render, store. The one deliberate divergence: a failed
  translation **throws**, where a failed proofread is swallowed. Proofreading is
  cosmetic polish on a résumé the user can already download; a translation is the
  entire thing they asked for.
- **Storage**: parallel `resume_en_*` columns on `funnel` (migration `0010`),
  following the precedent `0008` set when it collapsed `resume_pdfs` into columns.
  The PDF is **one** object, `<user_id>/<profile_id>/curriculum-en.pdf`, in the
  same folder as the Spanish ones so the 0006 Storage RLS policies (which
  authorize on the first path segment) keep working untouched. A re-translate
  overwrites it, so a profile tops out at five objects: four Spanish rounds plus
  one English.
- **Route**: `POST /api/resume-profiles/:id/translate`, gated on `finalizedAt`,
  behind `enforceRateLimit("translate")` (10/hour) and
  `assertWithinBudget({ operation: "translate" })`. `GET` on the same route
  returns the stored translation and whether it is current — free, no model call,
  so the workspace can pick the right button label on load.
- **Download**: `POST /api/resume-profiles/:id/export-pdf?lang=en`. It will
  re-render a missing PDF and back-fill it, but it will **never translate** on a
  miss — that would start a paid operation from a download button, behind the
  wrong rate limit and with no budget check.

## Adding a third language

`ResumeLang` (`types/domain.ts`) is the switch. Adding a member makes every
`Record<ResumeLang, …>` a compile error until it is handled — the `LABELS` table in
the renderer, `TARGET_LANGUAGE_NAMES` in `lib/ai/prompts.ts`, and the label maps in
`lib/experience-types.ts`. You also need its columns in a new migration, since
`translationColumnNames` in `lib/repositories/supabase-store.ts` derives
`resume_<lang>_*` names that have to exist.
