# CLAUDE.md — Mi CV con IA

Guidance for AI agents (and humans) working in this repository.

## Product purpose

**Mi CV con IA** is a Spanish-language AI resume builder. It guides a user through
creating a truthful professional résumé by asking **adaptive** questions (not a
fixed script), inferring **evidence-backed** skills the user must confirm, and
generating a résumé that contains **only confirmed information**. A user with no
formal employment can still complete a résumé through education, projects,
volunteering, caregiving, entrepreneurship, or other transferable experience.

All user-facing text is **Spanish**. Structured data is normalized and stored in
English field names for code clarity.

> The source-of-truth design is a **Pencil file** (`aiCV.pen`). This repo is primarily
> the **backend + AI orchestration + server-rendered HTML/PDF résumé** (`app/api/*`),
> plus a **minimal working React UI** (`app/page.tsx`, `app/cv/[id]/page.tsx`,
> `components/*`) that consumes those APIs so the product is
> usable end-to-end. The UI is intentionally lean — a fuller build should follow the
> Pencil design.

## Architecture

Dependencies point downward; the domain never imports infrastructure.

```
middleware.ts  (online guard → brand resolution → Supabase session refresh)
   │
app/layout.tsx  (brand fonts + inlined :root theme + BrandProvider + header)
   │
app/api/*  (route handlers: auth → RATE LIMIT / SPEND CAP → validate → service → typed JSON)
   │
lib/services/usage-guard.ts  (lib/rate-limit/* · lib/spend/*)
   │
lib/services/answer-pipeline.ts · lib/resume/resume-generator.ts · lib/skills/*
lib/services/talent-publish.ts · lib/services/talent-directory.ts
   │                                             │
lib/talent/*  (taxonomy · classifier · projection · map-pins)  ← PURE, no I/O, no model
lib/geo/*     (ZIP + CBSA reference tables)  ← server-only, no network
   │
lib/question-engine/*  (completeness-engine, question-catalog, prioritizer, planner)  ← PURE, no I/O
   │                                             │
lib/repositories/*  (Store)  ·  lib/storage/*  (ResumeFileStore)   lib/ai/*  (AIProvider: mock ⇆ azure)
   │                                             │
Supabase (Postgres + Auth + RLS)          openai SDK → Azure OpenAI (server-only)
```

**Progress bar:** the number the user watches is `state.funnelProgress`
(`lib/question-engine/funnel-progress.ts`), **not**
`completeness.overallScore`. `overallScore` is a data-quality score — a weighted
average over five buckets — and it made a bad bar three ways: most funnel
questions land in an already-saturated bucket or inside `background`, which is a
`max()`, so it *stalled* (three consecutive questions moved it 0 points); the
education/experience buckets *average* over entries, so adding one moved it
*backwards*; and readiness fires while the optional buckets are empty, so
finishing the funnel left it in the seventies. `funnelProgress` measures questions
handled over questions handled plus questions left, against the same
`eligibleQuestions` pool the funnel itself follows. It reaches 100 only at a
terminus — the funnel running out of questions, or a résumé being generated
(`runGeneration`, for the user who becomes ready early and generates with optional
questions outstanding). `overallScore` keeps its old jobs: readiness, the review
dashboard, and the model prompt.

`estimateFunnelProgress` is pure and may dip when an answer opens follow-ups;
`assembleProfileState` floors it at the persisted value and `advanceFunnelProgress`
(write side, once per answer in the pipeline) guarantees at least a point of
movement, so the bar is monotone and never parks.

**The funnel is a SCRIPT.** `FUNNEL_SCRIPT` (`lib/question-engine/question-catalog.ts`)
is a literal ordered list of question ids and it is the only thing that decides
what is asked and when: name → contact → **postal code** → the job being sought
→ one education question → how many experiences → the skills the person names →
one description per experience → review. The experience loop ends the funnel; nothing is appended
after it. `question-prioritizer.ts` walks it
and returns the first step still *eligible*; `adaptive-planner.ts` pins the next
question to that step and asks the provider only to REWORD it. `questionId`,
`inputType`, `required`, `allowSkip` and `nextAction` come from the **catalog**,
never the model, and a `PlannerDecision` naming any other question is discarded.

Order used to be emergent — a per-question `priority`, plus a hoist of every
question whose section matched `completeness.recommendedSection`, plus the
planner picking one of the top six candidates. `recommendedSection` is a ladder
recomputed after **every** answer, so the hoist moved mid-funnel: describing two
experiences dropped the ladder into another section and the person was asked
where they lived and about studies they had already declined, then returned to
experience 3 and 4. Every input was individually reasonable and the ORDER was
nobody's decision. Hence: no `priority` field, no section hoist, one list you can
read top to bottom. `tests/unit/funnel-script.test.ts` pins both the list and the
walk.

What is still *derived*, because it is about the data and not the order:
1. `completeness-engine.ts` (deterministic, no LLM) computes the
   `CompletenessReport` + readiness, which gate a step's `precondition`, the
   review dashboard and the model prompt. `recommendedSection` survives for those
   two readers and no longer reorders anything.
2. Eligibility rules let the script SKIP a step, never reorder it: precondition
   false, already answered (unless `repeatable` — `experience_add` walks one entry
   per loop), or skipped (unless critical *and* still blocking readiness).

**A question in the catalog is not necessarily in the funnel.** The entries the
script leaves out — `education_details`, `education_dates`,
`experience_daily_tasks`, `experience_scope`, `experience_results`,
`experience_dates`, `skills_confirm`, and the four optional sections
(`certifications_any`, `languages_any`, `projects_any`, `achievements_any`) —
stay because the improvement loop (`FOLLOWUP_DEFS`), the entry deep-dives and the
Review screen's back-edit answer through the same pipeline and need their text,
`inputType` and `charLimit`.

The split is: the funnel captures what is needed to WRITE a résumé, and
everything that only IMPROVES one is asked after the first PDF exists, where the
person can see what it buys them and the analyzer asks only for what that résumé
is short of. The optional four were appended after the experience loop and cut
for exactly that reason — four "¿tienes…?" questions in a row, answered "No
tengo" four times, is a bad last impression of a funnel someone has almost
finished. Anything moved out of the script this way needs a `FOLLOWUP_DEFS` entry
or it is not asked anywhere at all; `achievements_any` had none until it left the
funnel, and `tests/unit/funnel-script.test.ts` now pins that the four are
reachable from the loop.

**`personal_location` stays in the script here, unlike in the sibling product
(aicv), and the difference is not cosmetic.** There the question asks for a city
and the résumé is no worse without one. Here it asks for a ZIP, that ZIP is the
only answer that yields coordinates, and those coordinates are what let employers
find someone by proximity in the talent directory — the city and state printed on
the résumé are looked up from it too (`lib/geo/location-answer.ts`, a
deterministic table lookup, which is why `POST /answers` intercepts this question
before the provider). It is also not a candidate for the improvement loop:
`FOLLOWUP_DEFS` deliberately excludes it, because the generic normalizer would
read a place name as a person's name. Drop it from the script and the ZIP is
captured nowhere. What DID change is its position — it is asked with the other
identity questions, never mid-experience-loop.

Two further consequences worth knowing: experience **dates** now arrive from the
Review screen rather than the funnel, so an undated entry sinks to the bottom of the
newest-first order (`lib/resume/experience-order.ts`); and `skills_add` is the
funnel's only source of a **confirmed** skill — inferred skills stay `suggested`
and reach nothing, since no funnel step confirms them any more.


**Funnel navigation is a TRAIL, client-side** (`lib/client/funnel-trail.ts`).
`steps` is every question this person has been shown, in order; `cursor` is where
they stand. "← Volver" is `cursor − 1`, "Continuar" is `cursor + 1`, and nothing
else moves it — in particular the server's freshly planned `nextQuestion` extends
the trail only at its END, and is ignored while there is walked trail ahead.

That last rule is the whole point. `nextQuestion` answers "what is still
outstanding for this profile", which is not "what did this person see next":
going back used to POP the walk, so backing from experience 4 to experience 1 and
pressing Continuar jumped straight back to 4 — the only entry still undescribed —
skipping 2 and 3. A question a re-answer newly opens is not lost, just deferred
to the end of the walk, where it genuinely is next.

Two invariants ride along, both pinned by `tests/unit/funnel-trail.test.ts`:
- **A step remembers what it sent.** `sent.answer` goes back into the field via
  `QuestionCard`'s `initialAnswer`, and `entryId` is passed as `targetEntryId` so
  re-answering experience 1 OVERWRITES experience 1 instead of being adopted by
  whichever entry is still undescribed. An unchanged answer is not re-sent at all
  (`canAdvanceWithoutSending`) — it is already saved, and re-posting it would
  spend a model call rewriting the same entry with the same words.
- **`QuestionCard` is keyed by trail POSITION, never by `questionId`.**
  `experience_add` is asked once per experience, so a questionId key had React
  reusing one card across all of them — carrying experience 1's text into
  experience 2's empty field. The remount is also why `initialAnswer` is read once
  at mount rather than through an effect, which could clear text mid-typing.

`lib/client/answer-fields.ts` owns both directions of the answer string
(`serializeAnswer` / `parseAnswer`) because restoring depends on them being exact
inverses — a `date_range` is two fields joined by an en dash and a `type_counts`
is a JSON payload, so a one-sided change shows the person something they never
typed.

**Provider split (cost control):** the paid model always handles **résumé
generation + analysis** (`ai`, the end of the funnel and each regenerate). The
**funnel provider** (`getFunnelProvider()`, exposed as `funnelAi`) is cost-aware:
- `AI_PROVIDER=mock` → a pure `MockAIProvider` (offline, tests, zero tokens).
- `AI_PROVIDER=azure` → a `HybridAIProvider` (`lib/ai/hybrid-provider.ts`) that
  sends the *narrative* capture that most affects résumé quality to the model —
  `normalizeAnswer` for the rich sections (`experience`, `projects`, `languages`,
  `achievements`, `certifications`, `education`) and `extractInterests` — while
  keeping cheap ops (question planning, skill inference, simple-field
  normalization: name/contact/career goal) on the deterministic mock. Individual
  question ids can opt back out of the model inside a rich section when the answer
  carries no narrative (`MECHANICAL_QUESTION_IDS`: the experience counter payload,
  and the experience/education date answers).

**The AI backend is Azure OpenAI** (`lib/ai/azure-openai-provider.ts`), reached with
the stock `openai` SDK pointed at the resource's **v1** endpoint
(`…/openai/v1`) — that surface speaks plain OpenAI wire format, so there is no
`api-version` parameter and no Azure-specific client. Requests use the **Responses**
API, the only surface the `*-codex` models are served on, and pass `store: false` so
the résumé text is not retained server-side. Cost is controlled per operation via
`reasoning.effort`: `none` for mechanical extraction (verified 0 reasoning tokens),
`high` for résumé generation, `medium` for the critique. Prompt caching is automatic
on this platform — no cache markers — which is why stable instructions go in
`instructions` and the variable input in `input`.

Because prompts drive model output shape, any prompt that returns JSON must
enumerate the **exact** schema field names + enum values (see
`buildResumeGenerationPrompt` / `buildNormalizerPrompt`); the corresponding Zod
schemas add a tolerant `z.preprocess` for common container-name drift
(`id`→`entryId`, `skills`→`skillIds`, `extractedData`→`updates`). Reasoning tokens
count against `max_output_tokens`, so funnel/generation calls use generous ceilings
to avoid truncation, and a truncated reply is retried with *more* room rather than
the same ceiling.

### Key modules

| Path | Responsibility |
| --- | --- |
| `types/` | Domain model + `ResumeProfileState` (model-safe, PII-redacted) |
| `lib/env.ts` | Zod-validated, `server-only` config. Secrets never reach the client |
| `lib/brand/` | multi-brand system: configs · registry · pure host resolution · `:root` theme emitter · server/client accessors |
| `components/marketing/` | branded surfaces: shared hero + per-brand headers, dispatched via a registry |
| `lib/client/` | browser-side, pure: the API client · the funnel **trail** (back/forward) · the answer wire format |
| `lib/repositories/` | `Store` interface + `MemoryStore` (dev/tests) + `SupabaseStore`; `TalentDirectoryStore` is separate — a cross-user query surface with service-role semantics |
| `lib/storage/` | `ResumeFileStore` interface + `MemoryResumeFileStore` + Supabase Storage impl — one saved résumé PDF per improvement round |
| `lib/profile-state.ts` | Assembles `ResumeProfileState`, redacts PII, computes completeness |
| `lib/question-engine/` | completeness · catalog · prioritizer · adaptive planner · funnel progress |
| `lib/ai/` | `AIProvider` abstraction, `MockAIProvider`, `AzureOpenAIProvider`, prompts, **Zod schemas** |
| `lib/skills/` | evidence-backed inference + confirm/reject/edit lifecycle |
| `lib/employers/` | the ONE login: the gate · the namespaced session clients · pure email/password policy · what both auth callbacks share |
| `lib/auth-redirect.ts` | pure open-redirect guard for `/auth/*` — allow-listed `?next=` |
| `app/auth/` | `confirm` (`token_hash` → `verifyOtp`, any device) · `callback` (PKCE `code`) |
| `lib/talent/` | directory taxonomy (code constants) · deterministic classifier · résumé→profile projection with the public/contact split · résumé delivery (preview vs download) · map pins (pure, grouped by ZIP area) · when a metro label adds information |
| `lib/geo/` | bundled ZIP table (city/state/centroid) · bundled ZIP→CBSA table · the location answer's deterministic resolver · metro autocomplete + `metro=` resolution |
| `lib/services/answer-pipeline.ts` | the spec §9 answer pipeline |
| `lib/resume/` | generator · HTML renderer (language-aware) · PDF (two renderers: puppeteer local, `@sparticuz/chromium` serverless) · **artifact writer** (saves the PDF on every generation, and on every translation) · source tracing · **analyzer** (improvement loop) · **proofreader** (final spelling/grammar/format pass before finalize) · **translator** (on-demand English version) |
| `lib/rate-limit/` | pure policy (limits + keys) · `RateLimiter` iface · memory/no-op/Postgres impls |
| `lib/spend/` | pure `checkBudget` · `SpendLedger` iface + impls · the provider's spend recorder |
| `lib/services/usage-guard.ts` | what routes call: `enforceRateLimit` · `assertWithinBudget` · `funnelProviderForBudget` |
| `lib/analytics/` | Amplitude (HTTP API) with PII allow-list; no-op when unconfigured |
| `lib/services/funnel-telemetry.ts` | Records a question as *shown* (event + `QuestionState.lastShownQuestionId`) so funnel exit points are visible — see `docs/funnel-analytics.md` |
| `lib/repositories/funnel-entities.ts` | entity construction shared by every `Store` impl, so `MemoryStore` and `SupabaseStore` cannot drift on defaults |
| `supabase/migrations/` | SQL schema + RLS |

## Brand system (multi-brand, one repo)

The app serves **two marketing brands from one build**: `rumbo-latino` (warm,
learner-facing, rumbolatino.com) and `aprende` (Aprende Institute — formal,
institutional). See
`docs/branding.md` for the design and `docs/switching-brands.md` for the operator
runbook; the rules that constrain code:

- **Only marketing is branded.** Palette, typography, header, landing hero,
  metadata and marketing copy. The funnel, question engine, AI orchestration,
  `Store` and analytics are shared and brand-agnostic. **The generated résumé is
  deliberately NOT themed** — it is the user's document, so
  `lib/resume/resume-renderer.ts` keeps its own neutral print palette.
- **The brand is chosen from the request host**, resolved once in `middleware.ts`
  and stamped on `x-brand`. Precedence: `?brand=` → cookie →
  `BRAND_HOST_OVERRIDES` → host match → `DEFAULT_BRAND` → `rumbo-latino`.
  `lib/brand/resolve.ts` is pure and holds the rules. The brand gates styling and
  copy only — never data access, never a permission. Note `DEFAULT_BRAND` sits
  *below* the host match: it cannot flip a domain a brand already claims (that is
  what `BRAND_HOST_OVERRIDES` is for), and an unregistered value throws rather than
  falling back silently.
- **`BrandConfig` is pure, serializable data** (`lib/brand/brands/*.ts`): no React,
  no `next/*`, no `server-only`, no I/O. That is what lets edge middleware,
  Server Components and Client Components all read the same object. Per-brand
  *components* are registered separately in `components/marketing/registry.tsx`,
  so configs never depend on the UI layer.
- **`tailwind.config.ts` contains no brand colours.** Every token resolves to
  `rgb(var(--c-…) / <alpha-value>)`, filled in by the `:root` block that
  `app/layout.tsx` inlines. Adding a brand touches no CSS and no shared component.
- **Tokens are semantic, not literal** — `accent`, `text-primary`, `border`; never
  `coral` or `plum`. Product components must use only semantic tokens. The literal
  values (`brand-strong`, `brand-mark`, `brand-support`) are for the marketing
  layer alone.
- **Contrast is enforced, not hoped for.** `tests/unit/brand-theme.test.ts` asserts
  WCAG AA (4.5:1) for every registered brand. Five Rumbo Latino pairs sit below AA
  — its white-on-coral CTA label (2.73:1) and its secondary grey — because those
  are rumbolatino.com's own values and brand fidelity was chosen over contrast by
  the product owner. They are *pinned* per brand and per pair, so they cannot
  widen and a new brand inherits no exemption. See `KNOWN_BELOW_AA` and
  `docs/branding.md`.
- **Reuse first, fork deliberately.** Prefer a shared config-driven component with
  a layout variant (`MarketingHero` serves both brands). Register a per-brand
  component only when one component would need a flag per visual decision (the two
  headers). A registered component must be presentational — `brand` as a prop, no
  server APIs.
- **Adding a brand** = a config file + one line in `lib/brand/registry.ts` + fonts
  in `app/fonts.ts` + assets in `public/brands/<id>/` (icons included — there is no
  `app/icon.*` convention file, since it would compete with the per-brand ones). `BrandId` is derived from the
  registry keys, so every `Record<BrandId, …>` becomes a compile error until the new
  brand is handled. The brand tests then cover it automatically.

## Coding conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`. `tsc --noEmit` must pass.
- Domain field names are English camelCase; user-facing strings are Spanish.
- Route handlers stay thin: resolve context → validate body (Zod) → call a
  service → return via `ok`/`created`. Wrap bodies in `handleRoute` for consistent
  error envelopes: `{ data }` on success, `{ error: { code, message, details? } }` on error.
- Services accept dependencies (`store`, `ai`, `analytics`) as parameters (DI) so
  they are testable without Next/Supabase.
- Never import `lib/env`, `lib/supabase`, `lib/ai` (index), or `lib/analytics`
  from pure domain code — they are `server-only`. Pure engines import only `types`.

## No accounts for JOB SEEKERS (no login, no sign-up)

The product never asks a job seeker for a password. A visitor reads the hero,
presses the CTA and is in the funnel; the identity the database needs is created
*for* them.

> **Employers are the exception, and the only one.** The directory at
> `/empleadores` is behind a real login with email verification — see **Employer
> accounts** below and `docs/employer-accounts.md`. The asymmetry is the point: a
> job seeker is giving us their information to get a résumé, while an employer is
> asking to read a list of real people's names, trades and phone numbers. Nothing
> in this section applies to that side, and the two sessions live in separate
> cookies so neither can evict the other.

- **`resolveUserId()` (`lib/auth.ts`) is the whole mechanism.** It returns the
  session's user when there is one, and otherwise **starts a guest session**:
  `signInAnonymously()` first, falling back to a service-role-provisioned account
  with random, never-stored credentials for projects that have anonymous sign-ins
  disabled. Either way the browser carries the normal Supabase session cookies.
- **The data model did not change.** A guest is a real `auth.users` row, so
  `funnel.user_id`'s foreign key, every `auth.uid()` RLS policy and the Storage
  folder rule all keep working untouched — per-user isolation is still enforced by
  Postgres, not by the absence of a login screen.
- **Mint the guest in a route handler only.** A Server Component cannot set cookies
  (`lib/supabase/server.ts` swallows the throw), so a session created there would not
  persist and every request would mint another guest — and another résumé. This is why
  `getRequestContext` is the only caller, and why middleware refreshes sessions but
  never creates them.
- **The cookie is the only handle on a résumé.** Clearing site data or switching
  device starts a fresh one; there is deliberately no recovery flow, because there is
  no identity left to prove ownership with. Accept that trade or add real accounts —
  do not add a half-way "enter your email to recover" path.
- **Operationally** this needs *either* "Allow anonymous sign-ins" enabled on the
  Supabase project (Authentication → Sign In / Providers) *or*
  `SUPABASE_SERVICE_ROLE_KEY` set. With neither, every request fails with a logged
  configuration error.
- There is no login, no sign-out and no browser-side Supabase client **on the
  job-seeker side**, and there must not be: a 401 from `/api/resume-profiles/*` is
  a bug, not a prompt to log in. The employer surfaces (`/empleadores/acceso`,
  `/api/employers/*`) are where a 401 IS meaningful, and they are a closed set —
  do not add a third kind of session.

## Usage limits (rate limiting + AI spend caps)

The product has **no login**, so an unauthenticated script can mint unlimited guest
identities and drive `POST …/generate`, which costs real money at
`reasoning.effort: high`. What existed before was *deduplication* (analysis cache,
generation lock) and *cost logging* — neither is a ceiling. Two independent controls
now bound it, and they are on or off together.

- **Request limits are CODE constants** (`lib/rate-limit/policy.ts`), one per
  operation, each carrying the reasoning for its number. A limit encodes a claim
  about legitimate use ("the funnel is ~40 questions"), which belongs in review and
  under test — the same argument `ONLINE_ONLY` is a constant for.
- **Spend caps are ENV** (`AI_SPEND_CAP_{PROFILE,USER,DAILY}_USD`) — money varies per
  deployment and raising a ceiling must not need a deploy. Three ceilings, each for a
  different failure: one résumé looping, one identity across résumés, and *many
  identities at once* — which only the daily cap can see, and which is exactly what
  "no login" makes cheap.
- **Over budget DEGRADES capture and BLOCKS production.** `funnelProviderForBudget`
  hands the funnel the deterministic provider, so answers still save and raw wording
  is still kept verbatim with zero model calls; `assertWithinBudget` refuses
  generate/analyze/proofread/regenerate with a 429, because there is no cheap version
  of writing a résumé. Being over a limit must not strand someone mid-résumé.
- **A profile's FIRST generation is never refused** by the per-résumé or per-user cap
  (`isFirstResume` in `lib/spend/budget.ts`). The whole product is the first PDF;
  refusing to *improve* a résumé is acceptable, refusing to produce one is not. The
  daily cap has no such exemption — in a flood of fresh guests every request is
  somebody's first.
- **Both need `SUPABASE_SERVICE_ROLE_KEY`.** The counters live in Postgres
  (`0009_usage_limits.sql`) behind functions granted **only** to `service_role`,
  because `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships to browsers: an anon-executable
  counter lets anyone burn another user's quota by passing their key, and write junk
  into the ledger to trip the daily cap for everybody. Postgres and not a KV service
  because Vercel runs many instances — an in-process counter multiplies the effective
  limit by the instance count.
- **Everything fails OPEN, loudly.** No service-role key, or an unreachable table,
  logs at error level and allows the request. One unhealthy counter must not refuse
  every résumé in the product. `USAGE_LIMITS=off` is the deliberate local-dev version
  of the same thing.
- **An unpriced model is charged at the most expensive known rate**
  (`estimateCostUsdForCap`). `estimateCostUsd` returns null so the log can say
  "configura tarifas"; a cap that read that as $0 would make every ceiling
  unreachable the moment someone swapped the deployment — the exact drift a cap
  exists to catch.
- **Spend is recorded fire-and-forget** from inside the provider
  (`CallSpendRecorder` → `lib/spend/recorder.ts`), including truncated retries, which
  bill just as much. A ledger row is bookkeeping; a résumé the user already paid for
  must not fail because the write was slow.

## Bolsa de Talento (the opt-in talent directory)

After a résumé is **finalized**, the user may publish a profile that employers can
search (`/empleadores`, `/talento/[slug]`). Both sides stay accountless: a job
seeker gives their information to get a résumé, an employer gives theirs to get a
contact. No payments, no matching, no messaging.

The job seeker's whole involvement is **one checkbox and one question** in a
popup after they finalize. Everything else is derived. Adding a question to that
moment is a regression *whenever the answer could have been derived* — it sits
between someone and the PDF they came for. Availability is the single exception,
and it earned it by not being derivable from anything: see the `availability`
bullet below before adding a second one.

**The profile is a PROJECTION, not a second capture surface.**
`lib/talent/talent-projection.ts` reads `GeneratedResume` — which has already been
filtered to `confirmed`/`edited` entries and skills and source-traced — plus
`PersonalInformation`. So the directory inherits every résumé safety invariant for
free, and there is no code path from raw capture to a public page. **Nothing in
the directory calls a model**: the category comes from a keyword classifier
(`lib/talent/classify.ts`), so publishing is free and keeps working when
`AI_SPEND_CAP_DAILY_USD` is reached.

- **Nothing is readable by `anon`.** Postgres RLS is ROW-level: it cannot say
  "these columns are public and those are not", so a table with a public select
  policy is an unauthenticated API over *every* column — including ones added
  later by someone who did not read the comment. Instead the public shape is a
  FUNCTION SIGNATURE. `talent_search` / `talent_profile_public` are
  security-definer functions whose `returns table` clause enumerates, by name,
  every field an employer may see, and they are granted to `service_role` alone.
  Adding a column to `talent_profiles` exposes nothing until someone also widens
  that clause — a visible, reviewable diff.
- **Contact PII is a separate table**, not more columns. `talent_contacts` (with
  `employers` and `contact_reveals`) has RLS on and **no policies at all**, the
  same pattern `0009_usage_limits.sql` uses. Only the reveal path can name the
  email column, so a bug in the search path cannot leak what the search path
  cannot select. The **manage token lives there too** — a credential that can take
  a listing down must not be one column-addition away from being public.
- **The public/contact split is a RETURN TYPE.** `projectTalentProfile` returns
  `{ public, contact }` as two objects for two tables; `TalentProfilePublic` has
  no contact field to write to. `tests/unit/talent-projection.test.ts` asserts the
  exact key set, so *any* new field on that type fails the test until someone
  decides, in a diff, that it is safe to show the whole internet.
  The FULL NAME is public (the popup says so plainly); the email, phone and PDF
  path are not, and leave `talent_contacts` only through an audited reveal.
- **Publishing is a SEPARATE consent.** `termsAcceptedAt` covers building a
  private document; `publishConsentAt` + `publishConsentVersion`
  (`PUBLISH_TERMS_VERSION`) cover putting a name and a work history where
  strangers can read it. Never infer one from the other. Consent is stamped only
  *after* the write succeeds.
- **Three gates, enforced in the service and not only in the UI**
  (`lib/services/talent-publish.ts`): the résumé must be finalized, must have been
  generated, and must have a contact channel. A listing nobody can reach is pure
  exposure — it discloses a name, a city and a work history and returns nothing.
- **The publish step is one checkbox plus ONE question.** A popup
  (`components/talent/PublishDialog.tsx`) appears once the résumé is finalized,
  names exactly what employers get — full name, email, phone, the PDF — and takes
  a single consent, then the user carries on to their download. "No, gracias" is
  weighted equally with "Continuar"; an opt-in that is awkward to decline is not
  an opt-in. A decline is remembered in `localStorage` per profile so it does not
  nag on reload.
- **The filter facets are DERIVED, not asked.** Category, seniority and
  availability come from the finished résumé (`suggestCategory`,
  `estimateYearsBucket`, and `flexible` respectively) because three more
  dropdowns at the download screen cost opt-ins. Both estimators are deliberately
  conservative — `suggestCategory` falls back to `otro` rather than guessing, and
  `estimateYearsBucket` understates when the free-text dates do not parse. A
  filter that is too broad costs an employer a scroll; one that overstates
  seniority is a false claim about a person. Re-publishing re-derives them, so
  fixing the résumé fixes the listing.
- **Location is a ZIP, and everything else is derived from it.** The funnel asks
  `¿Cuál es tu código postal?` — five digits are faster to type on a phone than a
  city, unambiguous where a city name is not, and the only answer that yields
  coordinates. `lib/geo/zip-lookup.ts` turns it into city, state and a centroid,
  so the résumé still prints "Houston, TX" and nobody is asked twice. A non-US
  answer is kept verbatim in `city` with null coordinates: those people are never
  mislocated, they are simply absent from radius searches. The PATCH route
  re-derives on every ZIP change, so the four fields cannot drift apart.
- **The ZIP table is bundled, not a geocoding API.** 41k rows / 1.8 MB from
  GeoNames (CC BY 4.0 — attribution in `docs/attributions.md`), `server-only` so
  it never reaches a browser. No API key, no per-request cost, no rate limit that
  bites when the product is busy, and no third party learning where users live.
- **Coordinates are ZIP-AREA CENTROIDS, never addresses.** We never ask for a
  street address. A distance is therefore between the middles of two postal
  areas and can be several miles off for any individual — right for ranking who
  is nearby, wrong to present as an exact distance to a person. The card rounds
  to whole miles for exactly this reason. Device geolocation
  (`components/UseMyLocation.tsx`) sends coordinates to `/api/location`, gets a
  ZIP back, and discards them; a device position is never stored.
- **Results are a TABLE, not cards** (`components/talent/TalentTable.tsx`): name,
  location, industry, experience, CV. An employer compares people on the same few
  attributes, and a card grid makes you re-find each one in a different spot per
  tile. The name links to the full profile; the CV column is a plain `<a>` — the
  route sets `Content-Disposition: attachment`, so the whole table needs no
  client JavaScript at all.
- **NOTHING is visible without a verified employer account.** This reverses the
  earlier decision to leave contact details and the CV open, which had been taken
  on the judgement that identifying employers was more friction than it was
  worth. Once the directory itself is gated there is no friction left to save by
  leaving the most revealing endpoint open — an open PDF would just be the hole
  every other gate is drilled around. See **Employer accounts** below and
  `docs/employer-accounts.md`; `PublishDialog` still names exactly what an
  employer will see before anyone opts in.
  What now stands between the directory and a bulk harvest, in the order that
  actually stops it: a confirmed mailbox is required at all; the
  `directory_search` and `contact_reveal` limits are keyed by the **account**, so
  changing networks no longer resets them; `contact_reveals` records every
  download against a named employer rather than an IP; and slug suffixes stay
  random, which still stops a *URL* from being guessed from a name even though
  `0012` lets a name be searched (below).
  The `employers` table from `0010` is finally the thing it was built for.
- **Employers filter by radius, not by city name.** `?zip=77002&radius=25` — the
  ZIP is resolved to a point server-side, which keeps the URL shareable and
  readable. The city and state text filters were REMOVED with `0011`: typing
  "Houston" missed everyone in Katy, Pasadena and Sugar Land, who are a short
  drive away and exactly who an employer wants. `talent_search` prefilters on a
  bounding box (indexed lat/lng) then trims the corners with haversine, so a
  "25 mile" search does not quietly reach 35 on the diagonal. Plain columns
  rather than PostGIS: this table holds thousands of rows, not millions.
  `mcv_distance_miles` in SQL and `distanceMiles` in TS must stay in agreement.
- **They ALSO filter by metro area, and the two controls are not the same
  question** (`0017`, `docs/talent-metro-search.md`). `?metro=` narrows to a
  **CBSA** — OMB's definition of one labour market, a county with an urban core
  plus every county that commutes into it, so `Houston-Pasadena-The Woodlands,
  TX` is nine counties. The radius answers "within this drive of *here*", which
  needs the employer to already know which ZIP to centre on; the metro answers
  "in this labour market", which is what somebody hiring across a city means.
  They compose as an AND.
  - **Strict equality, no radius merge.** A metro is not quietly widened by a
    radius around its own centre to catch people just past the boundary: a CBSA
    already reaches far past the city line, and the control for "a bit further
    out" is the one next to it, where the employer sets the number and can see
    what it did. A row with no metro is EXCLUDED from a metro search, never
    matched by every one — `t.cbsa_code = p.cbsa` with no `or ... is null`.
  - **Resolved at publish time, denormalized onto the row.** `cbsa_code`/
    `cbsa_title` come from `lib/geo/cbsa-lookup.ts` reading the ZIP the funnel
    already captured, so a metro search is an indexed equality test and never a
    join against 30,000 ZIPs. The cost is that a listing carries the delineation
    vintage it was published under, which is what `npm run geo:cbsa --
    --backfill` exists to fix. Regenerating the table without backfilling leaves
    listings on the old vintage.
  - **The reference table is BUNDLED, like the ZIP table** — `lib/geo/us-cbsa.json`,
    405 KB, `server-only`, built by `scripts/build-cbsa-table.ts` from the OMB
    July 2023 delineations and the 2020 ZCTA→county relationship file. Census
    and OMB only: the spec's first choice, HUD's ZIP→CBSA crosswalk, is the
    better dataset and needs a registered API token — a credential to provision
    and rotate for a file read once a year. A `zip_reference` table in Postgres
    would split one reference dataset across the database and the bundle and put
    the metro back into a query-time join.
  - **About 26% of US ZIPs are in NO metro, and that is the data, not a bug.**
    OMB leaves rural counties outside every CBSA. Those people are absent from
    metro search — never placed in the nearest one — and are reached by the ZIP
    radius or by browsing unfiltered. The one inclusiveness rule lives in the
    reference data, not the query: a ZCTA whose dominant county is in no metro is
    assigned to a metro county holding at least a third of it, because a commuter
    ZIP on a metro's rural edge would otherwise vanish from every metro search.
  - **The `metro=` parameter takes TEXT or a code, and resolution has FOUR
    outcomes** — absent, exact, ambiguous, unknown — each with its own sentence
    on the page. Ambiguous does not filter and offers the choices: Portland,
    Oregon and Portland, Maine are both real, and guessing would answer a
    question the employer did not ask. It takes text because `MetroPicker`
    submits the metro's own title, which is what keeps the filter working with no
    JavaScript and the URL readable. Resolution is against a CLOSED list of 928
    titles — picking a row from a fixed table, never free-text search, which is
    the same discipline `0014` applied to the name box.
  - **`resolveSearchFilters` is where both readers meet.** `/empleadores` and
    `/api/talent/search` must not be able to disagree about what a query string
    means, for the same reason the rate limit lives in the service and not the
    route.
  - **The autocomplete (`/api/talent/metros`) knows nothing about anybody.** The
    same 928 metros for every caller, whether or not a person is published in
    any of them. Filtering it to metros that HAVE candidates would let anyone
    with an account map, one keystroke at a time, which parts of the country have
    people listed — outside the limit that governs searching for them. It has its
    own limit, `metro_lookup`, rather than a share of `directory_search`: it is
    keystroke-driven, and spending the search allowance on typeahead would lock
    an employer out of the search they were typing towards.
- **The metro is shown on a profile only when it is not the city said twice.**
  Printed unconditionally it read as duplication for most people — "Miami, FL"
  beside "Miami-Fort Lauderdale-West Palm Beach, FL" is one fact in two lines.
  `metroAddsPlace` (`lib/talent/location-label.ts`, pure) compares the city
  against the metro's **lead** city, not the whole title: a CBSA title names its
  secondary cities too, and the person in The Woodlands or Fort Lauderdale is
  exactly who the metro is informative for. Hidden for Miami and Houston, shown
  for Katy and Sugar Land.
- **`availability` is the ONE facet that is ASKED, not derived** (`0018`). The
  publish popup asks "¿cuándo podrías empezar a trabajar?" and stores the answer,
  because no résumé contains it — category and seniority stay derived precisely
  because the résumé already answers those. It is a REQUIRED parameter of
  `publishTalentProfile` and a required field of `PublishTalentBody`, with no
  default on either side: it used to be hard-coded `flexible` in the service to
  satisfy a not-null column, and `/talento/[slug]` printed that placeholder as
  "Mi fecha de inicio es flexible" — first person, on a page an employer reads as
  the candidate's own words. Requiring it is what makes inventing one impossible
  rather than merely discouraged.
  - **NULL means NEVER ASKED, and it is not `flexible`.** The column is nullable
    and `0018` nulled every placeholder row. A null availability is rendered as
    NOTHING (`labelForAvailability` returns null, not a fallback label) and
    matched by NO filter — `t.availability = p_availability` is false for it, so
    `talent_search` needed no change. Chosen over a fifth enum value like
    `no_indicada`, which would put a non-answer in the same closed list as the
    four answers and have to be excluded by hand in every filter, dropdown and
    label lookup. The backfill runs ONCE, guarded on the column's own
    nullability, because after this migration `flexible` is a real answer people
    have chosen and a re-run of a naive `where availability = 'flexible'` would
    erase it.
  - **This ADDED a question to the publish popup, which the rest of this section
    calls a regression, and it was a deliberate reversal.** The rule stands for
    anything derivable; availability is not derivable, so the real choice was
    "ask, or make it up". It is kept to one more DECISION and not one more STEP:
    same popup, no new screen, four radios with nothing pre-selected (a default
    would be the placeholder moved into the UI), and `Continuar` waits on both
    the consent and the answer. "No, gracias" requires neither.
  - **The employer `Disponibilidad` dropdown is back** in `TalentFilters`, which
    is what the removal note asked for ("if the funnel ever asks for a start
    date, put the dropdown back"). Expect it to return few people at first:
    legacy listings are null and match nothing until their owners re-publish.
  Note `yearsBucket` is NOT in this position and was never removed: it is derived
  by `estimateYearsBucket` from the dates on the person's own résumé,
  deliberately understating when they do not parse. Derived from what someone
  told us is not the same as invented.
- **Results are also drawn on a MAP, one pin per ZIP AREA — never per person.**
  Leaflet + OpenStreetMap: free, no API key, no billing, nothing to provision,
  the same reasoning that keeps the ZIP table out of a geocoding API. Everyone in
  one ZIP shares an identical centroid, so a per-person marker is physically the
  same point; `groupByLocation` (pure, `lib/talent/map-pins.ts`) collapses them
  into one pin with a count whose popup lists the people there. That says the
  true thing — *this postal area holds four people* — and a pin labelled "4"
  cannot be read as anybody's house. Jitter was rejected outright: it invents a
  position that looks precise. Someone with no coordinates is left OFF the map,
  never placed somewhere plausible.
  A pin links to `/talento/[slug]` and never to a résumé: opening a résumé spends
  a `contact_reveal` and writes an audit row, and a map is a surface people click
  around on.
  **GeoNames and OpenStreetMap attribution is rendered as visible caption text**,
  not only in Leaflet's control — `docs/attributions.md` had already written down
  that a map is the case where the CC BY 4.0 credit has to become visible.
- **Publishing the per-person COORDINATE was a deliberate widening of
  `TalentProfilePublic`,** and the three things that justify it have to keep
  holding: it is a ZIP-area centroid and never an address (we never ask for one);
  it was already derivable, since `distanceMiles` from three origins
  trilaterates the point exactly; and it is the purpose the ZIP was collected
  for. `PublishDialog` now names the zone in the list of what employers see —
  that checkbox is the entire consent, so a disclosure not named there is not
  consented to. `postal_code` stays private: same information as the centroid,
  no use to the map, and a bare ZIP column is the shape that ends up in a
  spreadsheet.
- **Seniority is a BUCKET, never a number.** An exact figure plus a graduation
  year is an age, which this product refuses to collect at all. For the same
  reason the filter set is closed — a name, category, city, state,
  availability. No filter may proxy for a protected class; see
  `ALLOWED_FILTER_KEYS` and the discipline note in `lib/talent/taxonomy.ts`.
- **Browsing NEVER mints a guest session, and now never happens anonymously
  either.** Every job-seeker route calls `resolveUserId()`, which creates an
  `auth.users` row when there is none. The directory must not: it used to be the
  one surface strangers and crawlers were expected to hit. It now requires a
  verified employer session instead, so the anonymous read (`resolveExistingUserId`)
  is gone from `talent-directory.ts` and the rate limits are keyed by the employer
  account rather than by IP.
- **The search guard lives in the service, not the route.**
  `lib/services/talent-directory.ts` carries the rate limit and the analytics, and
  both `/api/talent/search` and the server-rendered `/empleadores` go through it —
  the page must not be a way around the guard its own API has.
- **Reveal and audit are ONE statement.** `talent_reveal_contact` inserts the
  `contact_reveals` row and returns the contact together, so contact data cannot
  be returned without the access being recorded. Two calls from a route could
  always drop the second. Still true after `0015`: every read writes a row, and
  `is_repeat` marks the ones that are a re-read rather than suppressing them.
- **The résumé is streamed, not signed.** `GET /api/talent/:slug/resume` re-checks
  the employer on every request rather than handing out a signed storage URL — a
  signed URL is a forwardable bearer token that outlives the session and the
  listing. It reaches past the bucket's RLS with `getServiceResumeFileStore()`,
  which is deliberately a separate function so `grep -rn
  getServiceResumeFileStore` lists every place that can read another user's file.
  The bucket's own policies are untouched.
- **Reading a résumé is the PRIMARY action; downloading is the secondary one.**
  `?inline=1` on that same route serves the résumé for reading in place, which is
  what `components/talent/ResumePreview.tsx` frames. Choosing whom to call takes
  ten seconds of looking at a résumé, and when downloading was the only way to
  look, an employer comparing six people collected six PDFs and wanted one — files
  that outlive the session, the listing, and any later decision to unpublish.
  **A preview is the same disclosure as a download and is treated identically**:
  same session gate, same `contact_reveal` allowance, same `contact_reveals` row,
  because it is the same person's name, email and phone whether rendered or saved.
  A cheaper preview would be a hole drilled through the one limit here that
  protects people. `lib/talent/resume-delivery.ts` is pure and holds the
  disposition, the filename (rebuilt from the slug, so a path segment can never
  reach a response header) and the header set. Because the frame renders a PAGE,
  the inline path returns an HTML refusal instead of the JSON envelope: a
  rate-limited employer must not read `{"error":…}` inside the preview.
  `attachment` stays the default so every link written before the preview existed
  is unchanged. Also worth knowing: the frame is mounted only when the employer
  opens it (never eagerly across a page of 24 results) and stays mounted once
  opened.
- **The preview is HTML; the download is the PDF. The browser decided that, not
  us** (`0015`). iOS Safari hands PDFs to the system viewer at the top-level
  navigation layer and does not expose that renderer to a subframe, so the framed
  PDF came up blank on an iPhone — and *silently*: the frame navigates fine,
  `onLoad` fires, and a native PDF handler has no DOM to probe for "did anything
  paint". There is no reliable feature test, so this was not detectable and could
  not be worked around client-side.
  What is served instead is `lib/resume/resume-renderer.ts`'s own output — the
  HTML Chromium prints to MAKE the PDF, so it is the same résumé, and its CSS is
  already a deliberate mirror of the printed sheet (800×1131px is A4 at 96dpi,
  `max-width:100%` so it scales on a phone). It renders everywhere and stays
  selectable and zoomable. Safe to serve as an active document because the
  renderer escapes every piece of user text through `esc()`, emits no script and
  references no external URL — and `resumeResponseHeaders` sends it under
  `default-src 'none'; style-src 'unsafe-inline'` so that stays true if the
  renderer changes. **No `sandbox` on the iframe**, deliberately: without
  `allow-scripts` it breaks the browser's own PDF viewer, which is still the
  fallback path. The CSP binds the document rather than the frame and leaves the
  PDF response alone.
  The HTML is a **snapshot on `talent_contacts`**, taken at publish time beside
  `resume_pdf_path` — the same disclosure class (it prints the name, email and
  phone), and a snapshot because reading `funnel.resume_html` live would let the
  preview and the download show different résumés the moment someone regenerates
  without re-publishing. A listing published before `0015` has `''` there and
  falls back to framing the PDF, which is why the "ábrelo en otra pestaña" link is
  KEPT and still shown unconditionally: the detection problem did not become
  solvable, it just stopped applying to most listings.
  **The safety claim moved from the media type to the header set.**
  `tests/unit/talent-resume-delivery.test.ts` used to assert the two modes differ
  by the disposition ALONE; that now holds per *format*, and `SECURITY_HEADER_NAMES`
  — `Cache-Control`, `X-Content-Type-Options`, `X-Frame-Options` — is what may
  never vary across either axis. The disclosure was never in the media type; it is
  in the gate, the limit and the audit row, all unchanged.
- **`contact_reveal` is the limit that matters** — the only one in the product
  protecting people rather than infrastructure. `employer_register` is capped at
  or below it so minting fresh "employers" is not a way around the per-identity
  reveal limit.
- **That limit counts PEOPLE, not page loads** (`REVEAL_DEDUPE_MINUTES`, 60, in
  `lib/rate-limit/policy.ts`). It used to charge per request, so reopening a
  résumé, reloading, or following the preview's new-tab escape hatch each spent
  another allowance for one look at one person — which fell hardest on exactly the
  browsers that NEED that escape hatch, halving an iOS employer's effective quota
  for the same work. A re-read of the same profile by the same employer inside the
  window is now free.
  This loosens nothing about reach: the first read of each new person still costs
  one, and that is the number that bounds a harvest. The order in the route is
  load-bearing — `hasRecentReveal` (a boolean, read-only, disclosing nothing) runs
  BEFORE the charge, because revealing first and refusing afterwards would leave
  an audit row claiming an employer received details they were denied. It fails
  CLOSED, unlike the rate limiter itself: this answer can only ever waive a charge
  against the limit that protects people, so an unreachable counter must mean
  "charge it". `p_dedupe_minutes` defaults to 0 in SQL for the same reason — a
  caller who forgets it charges everything.
- **The directory lives on the SAME deployment, at `/empleadores`.** It is simply
  not linked from anywhere in the builder — no header entry, no footer, no CTA —
  so a job seeker never stumbles into it, and an employer reaches it by being
  given the URL. An earlier version split the two by host (`EMPLOYER_HOSTS`, a
  middleware rewrite, a second header); it was removed as more moving parts than
  the separation was worth. If a dedicated domain is ever wanted, point it at the
  same Vercel project — no code change is needed for `/empleadores` to answer on it.
- **`/empleadores/acceso` is indexable; everything behind it is `noindex`.** The
  indexable surface MOVED when the directory was gated — it did not disappear. A
  gated page cannot be crawled (a crawler has no account) and a login wall in a
  search index is worse than useless, so the access page took over discovery: it
  describes the service and lists nobody. Being findable as a service must not
  make each listing a permanent cached record of a real person's employment
  situation, which is why `/talento/[slug]` was already `noindex` and stays so
  even now that the gate keeps crawlers out — it is the part that survives any
  future decision to reopen browsing. Unknown, unpublished and expired slugs all
  render the same 404; distinguishing them would confirm someone was once listed,
  which is what unpublishing is meant to undo.
- **Search is accent-insensitive, and Postgres does not do that for free.** The
  stock `spanish` config stems but does not fold accents, so `reposteria` would
  not find `Repostería` — a silent failure for an audience that mostly types
  without accents. `0010` creates a `spanish_unaccent` configuration (requires the
  `unaccent` extension, as does `simple_unaccent` in `0012`) and uses it on
  **both** the stored document and the query;
  folding one side only reintroduces the mismatch. `MemoryTalentStore` folds via
  `normalizeForMatch`, and `tests/unit/talent-directory.test.ts` pins the contract
  for both.
- **The free-text box searches NAMES, and nothing else** (`0014`). One box, one
  meaning. `0012` had added `name_tsv` beside `search_tsv` and ORed the two, so
  the box matched either a person's name or the résumé's own words; `0014` dropped
  the second half. An OR of two vocabularies cannot tell an employer *why* a row
  came back, and the two collide by construction in Spanish: `search_tsv` uses
  `spanish_unaccent`, which STEMS, and surnames are frequently trade words —
  `Herrera`→`herrer` is the `oficios` keyword for herrería, `Flores`→`flor` is
  floristry — so "Flores" returned the florists alongside the Flores family with
  no ranking rule able to make that legible. The résumé half also surfaced people
  for words they used in passing in a summary, which reads to an employer as a
  claim of skill. **Searching by trade moved to the control built for it**: the
  `Área` dropdown (`category`), a closed set derived from each résumé by
  `suggestCategory`. Name matching is unchanged from `0012` — **unstemmed**
  through `simple_unaccent`, by **prefix** (`gonz` finds González), ANDed across
  tokens, via `mcv_talent_name_query`, whose `nameSearchTokens` mirror in
  `lib/talent/text.ts` keeps `MemoryTalentStore` in agreement.
  What this gives up, and it is real: a specific skill or certification is no
  longer reachable as text, so an employer wanting an HVAC technician must pick
  the surrounding (broad) category and read. If that needs answering, the answer
  is a SECOND closed-list control, not free text merged back into the name box.
- **A query with no token of two characters matches NOBODY, not everybody.**
  `a:*` covers most of any name column, so answering `a` with the whole directory
  would be a page-out dressed up as a result set. `mcv_talent_name_query` returns
  NULL there and the predicate reads it as "no name matches"; a *blank* box still
  lists everyone deliberately. `/empleadores` renders its own message for the
  short-query case rather than an unexplained empty table, and
  `tests/unit/talent-directory.test.ts` pins both sides of the distinction.
- **Searching by name turns "is this person job-hunting?" into one query.** It
  exposes no new field — the full name is already on the table and the profile
  page, and `PublishDialog` says so before anyone opts in — but it makes a
  targeted lookup cheap, including one run by somebody's current employer. That
  was weighed and accepted when `0012` shipped; do not re-derive it as a bug. What
  still stands: slugs keep their random suffix, so a URL cannot be guessed from a
  name even once search has confirmed the name is listed.
- **`search_tsv` is KEPT, unused, as the rollback to `0012`.** The column, its GIN
  index and `mcv_talent_search_document` all remain; nothing queries them.
  Restoring résumé-text search is re-running `0012`'s `talent_search` with no
  backfill and no re-index, whereas dropping a generated column is the
  irreversible direction. An index nothing uses is the cost of that option.
- **`search_tsv` is generated by `mcv_talent_search_document`, not inline.** A
  generated column must be strictly IMMUTABLE, and `array_to_string` is declared
  **STABLE** (`provolatile => 's'`) because for a general `anyarray` the element
  output function need not be immutable. The inline expression therefore fails
  with `42P17: generation expression is not immutable`. The wrapper is honest
  rather than a trick — its parameters are concretely `text[]`, whose output
  function is immutable — so do not widen them to `anyarray`.
- **Listings expire after 90 days**, enforced in the read functions' `WHERE`
  clause rather than by a cron, so a profile disappears even if no scheduled job
  runs. Unpublishing sets a status instead of deleting: `contact_reveals`
  references the row, and a delete would erase the record of who already has the
  person's details. A re-publish keeps the slug (a URL already sent to an employer
  must not 404) and the manage token (it may already be in an email).
- **`getTalentStore()` fails CLOSED**, unlike the rate limiter and spend ledger,
  which fail open. An unenforced counter still serves the user correctly; a
  directory with no service role cannot write the contact row, so carrying on
  would publish a name and a work history with no way to reach the person and no
  token to take it down with.

**Still missing for the directory:** emailing the manage link. The token is still
shown once, on the publish response, so a user who never copies it and then clears
cookies cannot unpublish. Supabase now sends mail for the employer login, but
only AUTH mail to the address on an account — a manage link is neither, and its
recipient is a job seeker with no account at all. So this still needs a real
transport behind `MailSender`, which is the only reason that seam survives.
Also outstanding: the
`/perfil/gestionar?token=…` page, renewal, and moderation tooling for the
`blocked` status.

## Employer accounts (the directory's login)

The one real login in the product. Runbook in `AUTH_PRODUCTION_SETUP.md`; design
notes in `docs/employer-accounts.md`; email bodies in
`docs/auth-email-templates.md`. The rules that constrain code:

- **Supabase Auth owns ALL of it.** Account, password hashing, sessions, refresh
  — and the confirmation email, the recovery email and the tokens inside them.
  This app issues no credential of its own. Delivery is **Resend, configured as
  Supabase Custom SMTP**; nothing here calls the Resend API, and a
  `RESEND_API_KEY` in this app's environment would mean that invariant had been
  broken.
- **This REVERSED an earlier decision, and the reversal is load-bearing.**
  `0013` moved verification off GoTrue because it could not be shipped on it: the
  built-in sender is capped at a few messages an hour, only delivers to addresses
  in the Supabase organisation, and drops the rest with **no error anywhere**;
  and a PKCE link only worked in the browser that signed up. Custom SMTP answers
  the first; `token_hash` links answer the second. Neither was available when the
  custom tokens were written. Do not re-derive the old argument from `0013`'s
  comments without reading this.
- **Therefore Supabase's "Confirm email" must be ON** — the reverse of what
  `0013` required. With it on, `signUp` returns no session and
  `signInWithPassword` refuses an unconfirmed address, so confirmation is
  enforced by GoTrue and not merely by our gate. Turning it OFF makes the
  confirmation advisory.
- **The gate reads `auth.users.email_confirmed_at`**, through the session user.
  `employers.email_verified_at` is a MIRROR the gate repairs but never depends
  on: an employer who proved their mailbox must not be locked out by a failed
  bookkeeping write. (Also the reverse of what `0013` set up.)
- **`/auth/confirm` is the callback to configure; `/auth/callback` is the
  fallback.** A `token_hash` verified with `verifyOtp` carries no PKCE verifier
  and works on ANY device — which matters because this audience signs up on a
  shop computer and reads mail on a phone. The PKCE `code` route stays so a
  project with stock templates is not broken, limited to same-browser links.
- **Both callbacks write session cookies onto the RESPONSE they return**
  (`employerClientForRoute`). Writing through `next/headers` relies on Next.js
  merging those mutations into a handler-built redirect, and when that does not
  happen the exchange succeeds, the address is confirmed, and the browser gets no
  session — the employer is bounced to the login page with nothing explaining
  why. This was got wrong twice.
- **`?next=` is ALLOW-LISTED, not merely checked for being relative**
  (`lib/auth-redirect.ts`). The callbacks act on it right after minting a
  session, and it arrives from an email template edited in a dashboard, outside
  code review. "Same-origin" is not enough — that still covers `/api/…`, where a
  redirect performs an action. Rejects absolute, `//host`, `/\host`, traversal
  and control characters; falls back to `/empleadores`.
- **Registration cannot be used to enumerate accounts.** With confirmation on,
  Supabase returns a user-shaped object with a randomised id and an EMPTY
  `identities` array for an address that is taken; `isExistingAccount` reads
  exactly that, and the response is identical either way. It also must not write
  the `employers` row from that object — the id is not a real `auth.users` row.
- **`email_not_confirmed` on sign-in is NOT a leak.** GoTrue verifies the
  password BEFORE the confirmation state, so that outcome only reaches someone
  who already supplied the correct password. Every other credential failure is
  one generic sentence.
- **Password changes go through `updateUser`, on the session.** Not
  `auth.admin.updateUserById`, which the old flow needed because its recovery
  token produced no session — an API that will change ANY user's password, whose
  whole safety was our own token check running first. `updateUser` can only
  affect the caller.
- **The retired token machinery is KEPT, unused, as the rollback.**
  `lib/employers/tokens.ts`, `employer_email_tokens`,
  `mcv_consume_employer_token`. Reverting the switch restores a working flow with
  no migration and no data loss. Delete all three together, after native delivery
  is proven in production.
- **The employer cookie is NAMESPACED** (`mcv-empleador-auth`, in
  `lib/employers/constants.ts` so the edge middleware can read it without
  importing a `server-only` module). One shared cookie would mean an employer
  signing in *replaces* a job seeker's guest session — the only handle on an
  in-progress résumé, with deliberately no recovery flow — and would hand the
  builder the employer's user id.
- **Sign-out is `scope: "local"`.** `global` would revoke every refresh token for
  the account, so pressing "Salir" on a shared office machine would also sign the
  person out of their phone.
- **The gate has FOUR outcomes**: `ok`, `anonymous`, `unverified`,
  `misconfigured`. Each has a different fix, so each gets its own message — the
  same argument that keeps `rateLimited` and `budgetExhausted` separate.
  Collapsing the last two once told verified employers to "entra con tu cuenta"
  while a missing service-role key sat in an unread log. `unverified` is nearly
  unreachable with confirmation on, and is kept as defence in depth.
- **`EmployerSession` is a PARAMETER, not a lookup.** `searchDirectory`,
  `searchDirectorySafely` and `readPublicProfile` all take one, and only the gate
  produces one, so a new caller that skips the check is a compile error rather
  than something review has to catch. Do not add an overload making it optional.
- **`getUser()`, never `getSession()`** — it revalidates against the auth server,
  so a revoked session is refused rather than trusted because a cookie parsed.
- **The password rule MIRRORS a Supabase dashboard setting, deliberately.** At
  least 10 characters plus an uppercase, a lowercase, a digit and a symbol —
  Password Requirements → "Lowercase, uppercase letters, digits and symbols" is
  the authority, enforced by the auth API whatever `lib/employers/policy.ts`
  says. It is mirrored in code because the API rejects in ENGLISH:
  `inspectPassword` names which classes are missing, in Spanish, and names them
  all at once. `PASSWORD_RULE_TEXT` is the single sentence both forms and the
  server fallback share. The symbol list is GoTrue's own, character for character.
  This cuts against NIST's advice on composition rules; it was chosen, not
  overlooked, so change the dashboard and the code together.
- **Free webmail is ACCEPTED; disposable inboxes are not**
  (`lib/employers/policy.ts`). The employers this directory exists for are small
  local businesses, many with no domain at all — requiring a company domain would
  gate out the demand side of the marketplace to buy a signal the confirmation
  link already gives. `guest.invalid` is on the blocklist so a job seeker's
  provisioned guest identity can never become an employer.
- **`employer_email` (6/hour) is the tightest limit in the product.** Every hit
  causes mail to be sent from our domain to an address the caller typed, so a
  loose limit is a way to mail-bomb a third party and to burn the sending
  reputation the whole flow depends on. It also covers *consuming* a link, which
  is not brute-force defence — the credential is unguessable — but stops a mail
  scanner or prefetcher turning every hit into a database round trip.
- **CAPTCHA is NOT configured, and turning it on in the dashboard alone BREAKS
  sign-up.** Supabase Attack Protection makes `captchaToken` mandatory on
  `signUp`, `signInWithPassword`, `resend` and `resetPasswordForEmail`, and this
  app sends none. Enabling it is a code change too — see
  `AUTH_PRODUCTION_SETUP.md` § H.
- **`lib/mail/` is off the auth path.** It survives as the seam for the one
  message this product may still send itself — the talent directory's manage
  link, which goes to a job seeker with no account and which Supabase will never
  send. No transport implements it. `MAIL_FROM_ADDRESS` / `MAIL_REPLY_TO`
  describe that identity, NOT the auth sender, which is set in Supabase's SMTP
  Settings. Keep the two addresses in step anyway.

## Safety rules (enforced in CODE, not just prompts)

- Inferred skills are **always** created with status `suggested`; only an explicit
  user action makes them `confirmed`/`edited` (`lib/skills/`).
- Résumé generation reads only `confirmed`/`edited` skills and
  `confirmed`/`edited` entries; every generated bullet is **source-traced** and
  untraceable model output is dropped (`lib/resume/source-tracing.ts`).
- Prohibited inferences (leadership/management without evidence, language fluency,
  suggestions without evidence) are filtered in `isProhibitedSuggestion`.
- Approximate values are preserved verbatim; raw user wording is kept
  (`ConversationTurn.userAnswer`, `ExperienceEntry.rawDescription`).
- All AI output is validated with Zod before use (`lib/ai/schemas.ts`); the model
  can never return code/SQL/HTML through these shapes.
- Analytics never receives raw answers/PII — only allow-listed keys
  (`lib/analytics/events.ts`).
- We never request or store age, photo, marital status, religion, race, health,
  SSN, or immigration status.

## Saved résumé PDFs

Every generation renders a PDF and **replaces the one stored for its improvement
round**, so a user always has a current file, a download is a storage read rather
than a Chromium launch, and the rounds accumulate into a history you can open in
order to see the résumé improve (`0006_resume_pdf_storage.sql` created the bucket;
`0008_resume_pdf_per_stage.sql` introduced the per-round layout).

- **One object per round**, in the private `resumes` bucket, written with `upsert`:
  `<user_id>/<resume_profile_id>/curriculum.pdf` for the initial generation and
  `…/iteration-N.pdf` after round N. At most four per profile, since
  `MAX_RESUME_ITERATIONS` is 3. Stage 0 keeps the name `curriculum.pdf` so the
  objects written before 0008 are not orphaned.
- **`GeneratedResume.stage` is the ROUND, not the version.** It is derived in
  `resolveStage` (`lib/resume/resume-generator.ts`) as `iteration + 1` — the same
  expression `POST /iterations` uses to pick a table — which is what makes the PDF
  at stage N and the answers in `iteration_N` the same round. Deriving it from the
  version instead would let a mid-round `regenerate-section` or `proofread` consume
  the next round's object; those re-render the round on file (`proofreadAndRerender`
  passes `stage: resume.stage` explicitly).
- **Storage growth is bounded by the round cap, not by regenerations.** Within a
  round every write overwrites, so a user who regenerates twenty times still holds
  four PDFs. A PDF *per version* would be unbounded and would multiply PII at rest
  for no user-facing gain.
- **The user id must stay the first path segment** — the Storage RLS policies
  authorize on `(storage.foldername(name))[1] = auth.uid()`. Pinned by
  `tests/unit/resume-pdf-storage.test.ts`, along with the per-round file names.
- **The save is best-effort and never throws.** A PDF is derived data; losing a
  finished résumé because Chromium hiccuped would be far worse than a missing file
  the download path re-renders (and back-fills) anyway. Failures are logged and
  visible as the gap between `resume_generated` and `resume_pdf_stored`.
- **The render is HARD-CAPPED against the request deadline, and the estimate is
  not the protection.** `PDF_COLD_MS`/`PDF_WARM_MS` decide whether to *start* a
  render; `renderWithin` decides when to abandon one. The estimate alone was not
  enough and produced a real 504: a first generation's model call succeeded, the
  résumé was saved, the pre-check judged that a cold Chromium start fitted in the
  remaining budget, and it did not — so the platform killed the invocation and
  the response to an already-paid-for résumé was lost. An estimate is made before
  the work starts and can only ever be a guess about a cold instance; a cap
  cannot be wrong. On the cap the outcome is exactly a skipped PDF, which
  `POST /export-pdf` re-renders and back-fills.
  The abandoned render is deliberately left running with a `.catch` attached: a
  Chromium launch cannot be cancelled, and an unhandled rejection arriving after
  the response would turn a missing PDF into a dead instance.
- **The seam is `ResumeArtifactWriter`** (`lib/resume/resume-artifacts.ts`), injected
  into `generateResume` / `proofreadAndRerender` — the only two functions that create
  a résumé. Enforcing it there rather than in each of the four routes is what makes
  "every generation replaces its round's PDF" true by construction. It also stamps
  the path onto every `iteration_N` row of the round (`setIterationResumePdf`), which
  is what makes the history browsable from the table. The parameter is optional so
  unit tests run without Chromium; routes always pass `resumeArtifacts` from the
  request context.
- The render runs **inside the generation lock**, so concurrent requests cannot race
  to overwrite a round's stored file with different versions.

## The English résumé (translation, on demand)

A finished résumé can be translated into English. See `docs/english-resume.md` for
the full cost argument; the rules that constrain code:

- **It is a TRANSLATION of the finished résumé, never a second generation.** The
  model is shown the document the person already approved — never the source data
  it was written from — so it cannot introduce a fact the Spanish résumé does not
  make, and every `entryId` and source trace survives. Re-generating in English
  would produce untraced bullets and let the two documents disagree about what the
  person did, at 5–10× the cost.
- **It runs ONCE, when the user asks, after finalize** — not after every
  improvement round. A translation is ~$0.017, but a résumé goes through ~6
  generations and only a minority of users want English: translating eagerly costs
  ~40× more (~$102 vs ~$2.55 per 1,000 users at 15% uptake) and every translation
  before the last one is discarded work, because the user is still editing. It also
  adds a Chromium render per round, which is what `export_pdf`'s 40/hour limit
  exists to bound.
- **`reasoning.effort` stays `none`.** There is no judgement to make over text that
  is already written; reasoning bills at the $10/M output rate and is never read
  back. The task rules ride in `stableInstructions` so the ~700-token prefix caches
  at a tenth of the input rate.
- **Proper nouns are never SENT.** Employers, institutions, certifying bodies and
  the person's name are simply absent from the payload — a stronger guarantee than
  asking a model to leave them alone, and why the prompt does not police them.
- **The résumé's furniture is code, not prose.** Section headings, the title,
  `<html lang>`, "Present" and the experience-type fallbacks live in `LABELS`
  (`lib/resume/resume-renderer.ts`, threaded by a defaulted `lang` param) and cost
  nothing. Keeping them out of the model is also what stops a heading coming back
  missing.
- **`SYSTEM_FACTUALITY` could not be reused** — it mandates Spanish output. It is
  now composed from a shared `FACTUALITY_RULES` body alongside
  `SYSTEM_FACTUALITY_TRANSLATION`, so a new prohibition applies to both
  automatically. `SYSTEM_FACTUALITY`'s value is unchanged byte for byte.
- **A dropped id keeps its original Spanish text.** One Spanish line in an English
  résumé beats a blank bullet. But unlike `proofreadAndRerender`, a failed
  translation **throws**: proofreading is cosmetic polish on a résumé the user can
  already download, a translation is the entire thing they asked for.
- **Staleness is explicit, never auto-refreshed.** `TranslatedResume.sourceVersion`
  pins the `GeneratedResume.version` it came from; when the Spanish résumé moves
  ahead the translation is kept but marked stale and the button offers to update
  it. Refreshing automatically would reintroduce the per-round cost for anyone who
  translated once.
- **One PDF per language, in the same folder.** `<user_id>/<profile_id>/curriculum-en.pdf`,
  overwritten on re-translate — a translation mirrors the *current* résumé and keeps
  no per-round history, so `resumePdfPath` ignores `stage` for a non-`es` language.
  Same folder because the 0006 Storage RLS policies authorize on the first path
  segment. A profile tops out at five objects.
- **`POST /export-pdf?lang=en` will re-render a missing PDF but will NEVER
  translate** on a miss — that would start a paid operation from a download button,
  behind the wrong rate limit and with no budget check.
- **Adding a language** = a `ResumeLang` member (every `Record<ResumeLang, …>`
  becomes a compile error until handled) + its `resume_<lang>_*` columns in a
  migration (English is `0016_resume_english.sql` here, not 0010 — this repo's
  numbering diverged at the talent directory), since `translationColumnNames` derives the names.

## PDF rendering (two browsers, one interface)

`lib/resume/pdf-generator.ts` has two implementations of `PdfGenerator`, chosen by
runtime — not by `NODE_ENV`:

- **`PuppeteerPdfGenerator`** — full `puppeteer`, which downloads its own Chromium
  (~300 MB on disk). A **devDependency**: local development, CI, and any
  self-hosted server with a real filesystem.
- **`ServerlessPdfGenerator`** — `puppeteer-core` + `@sparticuz/chromium`, a
  Brotli-compressed Chromium built for Lambda-style runtimes. Vercel.

Why both are necessary: a Vercel function is capped at **250 MB uncompressed** and
full Chromium alone exceeds it, so that bundle can never contain it. Independently,
`puppeteer`'s postinstall — the step that fetches Chromium — is an install script,
and npm now skips those unless approved, so on Vercel the browser was never
downloaded either. Both failures are **silent**: `ResumeArtifactWriter` is
best-effort, so generation still looked fine and only the download surfaced it, at
the very last step of the product.

Rules that follow:

- **`resolvePdfRenderer` keys off the RUNTIME** (`VERCEL`, `AWS_LAMBDA_FUNCTION_VERSION`),
  overridable with `PDF_RENDERER=local|serverless`. `NODE_ENV=production` is not the
  signal — a container in production should use the full browser.
- **The two Chromium majors must match their client.** `puppeteer-core` and
  `@sparticuz/chromium` are both pinned to **148**; a protocol mismatch fails at
  render time, not at build time. Bump them together.
- **Launch flags come from `@sparticuz/chromium`, per its own version's README.**
  148 removed `chromium.headless` and `chromium.defaultViewport`, so the
  headless-**shell** flags are merged via `puppeteer.defaultArgs({ args, headless:
  "shell" })`. Check the installed README before changing this.
- **`@sparticuz/chromium` must stay in `serverComponentsExternalPackages`**
  (`next.config.mjs`) so its `bin/*.br` archives are traced as files instead of
  bundled. The traced `export-pdf` function is ~86 MB with it.
- **Every route that can render a PDF sets `maxDuration = 60` and `runtime =
  "nodejs"`** — generate, regenerate-section, proofread, export-pdf. A Chromium
  cold start plus a model call exceeds Vercel's 10s default.
- The serverless path **cannot be launch-tested off Linux**, so
  `tests/unit/pdf-renderer-selection.test.ts` pins the selection logic and asserts
  both packages resolve with the API the launch code uses. That is the guard against
  a deploy-only break.

## Database schema (4 résumé tables + 4 directory tables)

```
funnel        one row per résumé — profile columns + the eight capture sections,
              the funnel Q&A and the question state, all as JSONB, plus the
              CURRENT generated résumé (resume_id/_content/_html/_version/
              _stage/_pdf)
              and its English translation, if one was ever asked for
              (resume_en_content/_html/_pdf/_source_version/_created_at)
iteration_1   \
iteration_2    >  the improvement round's questions and answers, each row also
iteration_3   /   naming the PDF that round produced (resume_pdf)
```

Plus two infrastructure tables from `0009_usage_limits.sql` — `rate_limits` and
`ai_spend` — which hold no user content, have RLS on with **no policies**, and are
reachable only through functions granted to `service_role`. See **Usage limits**.

And four from `0010_talent_directory.sql` — `talent_profiles` (owner-only RLS; the
public view of it is two security-definer functions, never a policy),
`talent_contacts`, `employers` and `contact_reveals` (RLS on, no policies,
service-role only). See **Bolsa de Talento**. `0017` adds no table: two columns
(`talent_profiles.cbsa_code`/`cbsa_title`), an index, and four more fields on the
`returns table` clause of BOTH public read functions — the metro plus the
coordinates the map plots. Note it DROPS and recreates `talent_profile_public`
rather than replacing it: `create or replace function` cannot change a return
type, and for a `returns table` function the column list *is* the return type. `employers` is keyed to
`auth.users(id)` and holds a row per registered employer, plus its
`email_verified_at` — the directory gate's only input. `0013` adds
`employer_email_tokens` (RLS on, no policies) for verification and password-reset
links. See **Employer accounts**. `0015` adds no table: two columns
(`talent_contacts.resume_html`, `contact_reveals.is_repeat`) and
`talent_recent_reveal_exists`, which is the only read function here that returns a
boolean instead of a row — it runs before the rate limit, so there is deliberately
nothing in it to read.

`0007_simplified_schema.sql` collapsed 13 tables into five;
`0008_resume_pdf_per_stage.sql` dropped `resume_pdfs` for the fifth. The rules that
follow:

- **There is exactly ONE generated résumé per profile**, on the `funnel` row —
  plus at most one translation per language, in its own `resume_en_*` columns for
  the same reason (see **The English résumé** above).
  `resume_pdfs` was named for its path column but was really the résumé table
  (`content` + `html` are what the CV page, preview, analyzer, proofreader and
  download all read) and was joined 1:1 in every path that touched it, so it became
  columns. `getGeneratedResume(id)` therefore answers "is `id` still the current
  résumé?" — and `updateGeneratedResume` filters on `resume_id`, so a late PDF write
  from a superseded generation finds no row instead of clobbering a newer path.
- **`resume_version` counts generations; `resume_stage` is the round.** A proofread
  or section regeneration bumps the version without claiming a round. See **Saved
  résumé PDFs** above.
- **Dropping `resume_pdfs` gave up per-version content history.** What survives per
  round is the rendered PDF, not diffable JSON. That was the accepted trade for
  per-round history at bounded PII.
- **JSONB columns hold DOMAIN objects verbatim** — camelCase, exactly the shapes in
  `types/domain.ts`. What the Supabase editor shows is what the app sees, and there
  is no row↔domain mapping layer to keep in sync.
- **Entity defaults live in `lib/repositories/funnel-entities.ts`**, shared by both
  stores. That is what keeps the safety invariant structural: a skill is built
  `suggested`, so no store can default it to `confirmed`.
- **Editing one entry rewrites its array.** `SupabaseStore` does that
  read-modify-write under an optimistic `revision` guard and retries a lost race.
  Never bypass it with a raw update — a concurrent edit would be lost.
- **Entry lookups by id use JSONB containment**, backed by the GIN indexes the
  migration creates — and the filter value must be a **pre-serialized JSON
  string**: `.contains(column, JSON.stringify([{ id }]))`. Passing the array
  itself encodes as a Postgres *array* literal (`postgrest-js` does
  `value.join(',')`), which sends `cs.{[object Object]}` and fails every call with
  "invalid input syntax for type json". Both stores are exercised by unit tests on
  `MemoryStore`, so only `tests/unit/supabase-entry-lookup.test.ts` guards this.
- **Postgres no longer validates entry shape.** There are no per-entry FKs or CHECKs
  inside the JSONB; TypeScript and the Zod schemas at the AI boundary are the
  enforcement. The invariants that matter were always in code (`lib/skills/`,
  `lib/resume/source-tracing.ts`).
- **`MAX_RESUME_ITERATIONS` must stay 3** — there is one table per round, so a
  different cap would address a table that does not exist
  (`tests/unit/iterations.test.ts` pins this).
- **The improvement-round counter is server state** (`funnel.iteration`), enforced by
  `POST /generate`. It used to be localStorage, where clearing site data reset it.
- **A round is charged on `status`, NOT on "a résumé exists"**
  (`countsAsImprovementRound`). Those look equivalent and are not: a generation
  saves the résumé several steps before it returns, so a request that died after
  saving leaves one behind, and the person — who saw an error and no résumé —
  presses the button again. Counting that as an improvement round takes one of
  their three for our failure. Observed in production: a 504'd first generation
  left the profile on `iteration=1` with the model billed twice. `generating` is
  written before the model call and `generated` only after everything succeeds,
  so a profile still on `generating` means the last attempt never finished.
  The known cost is the right way round: `generating` is cleared only by success,
  so a profile abandoned mid-generation gets its next generation free. Being
  occasionally generous after a failure can be explained to someone; charging
  them for our timeout cannot.
- The `iteration_N` rows are an **audit log**: the answers are applied to `funnel`
  through the normal pipeline, so deleting one loses the record, not résumé content.
  Their `resume_pdf` is the exception worth knowing — it is the only pointer to the
  round's PDF, so deleting the rows orphans those bytes in the bucket.
- `users` is gone; `funnel.user_id` references `auth.users` directly.

## Database rules

- Every table has **RLS** enabled; a user can only touch rows under their own
  `funnel` row. `SupabaseStore` relies on RLS as defense-in-depth.
- Domain code touches the DB only through the `Store` interface — never raw SQL.
- The service-role key bypasses RLS and is **server-only** (used only for user
  provisioning). Schema changes go in a new `supabase/migrations/NNNN_*.sql`, and
  are appended to `supabase/apply_all.sql` for fresh-project setup.
- **Storage** follows the same rule: the `resumes` bucket is private and its
  `storage.objects` policies restrict every operation to the caller's own folder.
  Binary artifacts go through the `ResumeFileStore` interface, never a raw client.

## AI factuality requirements

See `lib/ai/prompts.ts` → `SYSTEM_FACTUALITY` (used on every résumé-related call).
Use only user-provided/confirmed facts; never invent employers, titles, dates,
degrees, certifications, tools, or metrics; ask a follow-up when a critical fact
is missing; improve wording without changing meaning; return valid JSON only.

## Testing expectations

- **Unit** (`tests/unit/`, Vitest): completeness, prioritization, no-repeat/skip,
  skill status/confirm/reject, prohibited inference, readiness, generation from
  confirmed-only data, no-invented-facts, AI schema validation, analytics scrubbing,
  brand resolution precedence, and per-brand palette completeness + WCAG contrast.
  For the directory: the projection's exact public key set (so a new field on
  `TalentProfilePublic` fails until someone decides it is publishable), the
  publish gates and consent stamping, taxonomy/classifier determinism, listing
  expiry, reveal auditing (including that a re-read is still logged, marked
  `is_repeat`, and scoped to one employer and one profile), the delivery header
  set across both formats and both modes, and the rate-limit policy. For employer accounts: the
  email and password rules in `lib/employers/policy.ts` and the three new limits.
  For authentication: the open-redirect guard (`safeNextPath` — absolute,
  scheme-relative, backslash, traversal, control characters, allow-list), the
  GoTrue error translation, Supabase's empty-`identities` duplicate signal, the
  accepted OTP types, and where a recovery link is allowed to land. The retired
  token lifecycle and the pure email templates are still covered, because the
  code is still there as the rollback.

  **The Supabase calls themselves are NOT unit-tested, deliberately.** Mocking
  `signUp` would assert that our mock behaves the way we assumed — which is
  precisely the assumption that breaks. They need a real project and a real
  mailbox: the checklist is `AUTH_PRODUCTION_SETUP.md` § I, and the single most
  valuable item on it is opening a confirmation link in a DIFFERENT browser than
  the one that signed up.
- **E2E** (`tests/e2e/`, Playwright): the seven flows in spec §19, driven through
  the API against a production build in mock/memory mode.
- Always mock the AI provider in tests (`MockAIProvider`) — it obeys the same
  safety invariants and validates its own output against the shared Zod schemas.
- `tsc --noEmit` and `vitest run` must pass before done. `playwright test` must too
  whenever it can run — while `ONLINE_ONLY` is `true` it cannot boot its mock-mode
  server, so e2e coverage is only meaningful with that flag flipped.

## Commands

```bash
npm install                # install deps
npm run dev                # dev server (http://localhost:3000)
npm run build && npm start  # production build + serve
npm run typecheck          # tsc --noEmit
npm test                   # unit tests (vitest)
npm run test:e2e           # e2e tests (playwright; builds + starts the app)
npm run lint               # next lint

npm run geo:cbsa           # rebuild lib/geo/us-cbsa.json (ZIP → metro area) from
                           # the Census/OMB files. Follow it with --backfill, which
                           # re-derives cbsa_code/title on published listings — the
                           # metro is denormalized at publish time, so without it a
                           # listing keeps the vintage it was published under.
                           # See docs/talent-metro-search.md

npm run resume:list        # what résumés exist in the Supabase project
npm run resume:delete      # delete one, picked from a numbered list — the funnel
                           # row cascades, but the bucket's PDFs and the ai_spend
                           # rows do not, so it removes those explicitly.
                           # See docs/deleting-resumes.md
```

**Online-only:** this app cannot run offline. `AI_PROVIDER=mock` and
`PERSISTENCE=memory` are rejected at startup (`ONLINE_ONLY` in `lib/env.ts`), and
a runtime connectivity guard (`lib/connectivity.ts`, wired into `middleware.ts`)
returns **503** on every request when the host has no network. You must set
`AI_PROVIDER=azure` (+ `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`) and
`PERSISTENCE=supabase` (+ Supabase URL/keys) — see `.env.example`. PDF export
requires a browser — see **PDF rendering** above. Note: this intentionally breaks the **e2e** suite,
which boots the app with `AI_PROVIDER=mock` + `PERSISTENCE=memory` (see
`playwright.config.ts`) — flip `ONLINE_ONLY` to `false` to run it. The **unit** suite
is unaffected: it injects `MockAIProvider`/`MemoryStore` directly and never parses the
environment, so `vitest run` passes as-is.

## Configuration (env)

All via environment variables; never commit secrets. See `.env.example`.
`AI_PROVIDER`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_MODEL`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `AMPLITUDE_API_KEY`, `PERSISTENCE`, `PDF_RENDERER`,
`DEFAULT_BRAND`, `BRAND_HOST_OVERRIDES`, `AI_SPEND_CAP_PROFILE_USD`,
`AI_SPEND_CAP_USER_USD`, `AI_SPEND_CAP_DAILY_USD`, `USAGE_LIMITS`,
`NEXT_PUBLIC_SITE_URL`.

Plus `MAIL_FROM_ADDRESS` and `MAIL_REPLY_TO`, which do **NOT** configure
authentication email — Supabase sends that, and its sender is set in the
dashboard. They describe the identity for the one message this product may still
send itself (the directory's manage link); no transport implements it.
`MAIL_FROM_ADDRESS` is a **bare** address serving both brands (Rumbo Latino is an
Aprende product with no mailbox of its own); the From display name comes from the
resolved brand, so a Rumbo Latino email is never signed "Aprende Institute".

**There is deliberately no `RESEND_API_KEY`.** This app never calls Resend —
Supabase does, over SMTP, with credentials held in the Supabase dashboard. A
Resend key in this environment would mean auth mail had started being sent from
here, which is the thing the design avoids.

**Several settings live in the Supabase dashboard and the app is wrong without
them** — "Confirm email" **ON** (the reverse of what it once was), the Site URL
and Redirect URLs, the password policy, the email templates, and Resend Custom
SMTP. All of them, plus the DNS records IT must add, are in
`AUTH_PRODUCTION_SETUP.md`.

## Out of scope (do not add in milestone 1)

Job applications, job **matching** or ranking, cover letters, interview
simulation, LinkedIn publishing, and decorative multi-template themes. Note the
talent directory is **not** matching: it is search over profiles their owners
chose to publish, with no scoring, no recommendations and no messaging — adding
any of those is a new product decision, not an extension of it. Payments and a
booking/scheduling flow are also out. (A minimal React UI exists, with no
login at all — see "No accounts" above; a polished, design-faithful UI is future
work.
Note: the **brand** system is not a "theme" system — it swaps marketing identity
per host, not résumé templates, which remain single and neutral.)
