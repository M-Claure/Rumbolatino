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
lib/talent/*  (taxonomy · classifier · projection)  ← PURE, no I/O, no model
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

**Two-layer questioning:**
1. `completeness-engine.ts` (deterministic, no LLM) decides *which* sections/fields
   are eligible and computes the `CompletenessReport` + readiness.
2. `adaptive-planner.ts` picks and personalizes a question from catalog-derived
   candidates. `questionId`, `inputType`, `required`, `allowSkip`, and
   `nextAction` come from the **catalog**, never the model.

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
| `lib/repositories/` | `Store` interface + `MemoryStore` (dev/tests) + `SupabaseStore`; `TalentDirectoryStore` is separate — a cross-user query surface with service-role semantics |
| `lib/storage/` | `ResumeFileStore` interface + `MemoryResumeFileStore` + Supabase Storage impl — one saved résumé PDF per improvement round |
| `lib/profile-state.ts` | Assembles `ResumeProfileState`, redacts PII, computes completeness |
| `lib/question-engine/` | completeness · catalog · prioritizer · adaptive planner · funnel progress |
| `lib/ai/` | `AIProvider` abstraction, `MockAIProvider`, `AzureOpenAIProvider`, prompts, **Zod schemas** |
| `lib/skills/` | evidence-backed inference + confirm/reject/edit lifecycle |
| `lib/talent/` | directory taxonomy (code constants) · deterministic classifier · résumé→profile projection with the public/contact split |
| `lib/services/answer-pipeline.ts` | the spec §9 answer pipeline |
| `lib/resume/` | generator · HTML renderer · PDF (two renderers: puppeteer local, `@sparticuz/chromium` serverless) · **artifact writer** (saves the PDF on every generation) · source tracing · **analyzer** (improvement loop) · **proofreader** (final spelling/grammar/format pass before finalize) |
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

## No accounts (no login, no sign-up)

The product never asks anyone for a password. A visitor reads the hero, presses the
CTA and is in the funnel; the identity the database needs is created *for* them.

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
- There is no `/login` route, no sign-out, and no browser-side Supabase client. Do
  not reintroduce one; a 401 from the API is now a bug, not a prompt to log in.

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

The job seeker's whole involvement is **one checkbox in a popup** after they
finalize. Everything else is derived. Any change that adds a question to that
moment is a regression — it sits between someone and the PDF they came for.

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
- **The publish step is ONE checkbox.** A popup
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
- **Contact details and the CV are OPEN — no employer identification.** This was
  a deliberate product decision after the identify-once form was judged not worth
  the friction. Be clear-eyed about what it means: the résumé carries the
  person's full name, email and phone, so any published profile's contact details
  are downloadable by anyone with the URL, and the directory can be walked by a
  script. What makes it honest rather than a surprise is that `PublishDialog`
  names exactly this before anyone opts in. What still stands between the
  directory and a bulk harvest: the `contact_reveal` rate limit (now IP-keyed,
  and the ONLY remaining ceiling), the `contact_reveals` log which still records
  every download with a timestamp and address, and random slug suffixes, which
  still stop a *URL* from being guessed from a name even though `0012` lets a
  name be searched (below).
  The `employers` table survives in `0010` but nothing reads or writes it.
- **Employers filter by radius, not by city name.** `?zip=77002&radius=25` — the
  ZIP is resolved to a point server-side, which keeps the URL shareable and
  readable. The city and state text filters were REMOVED with `0011`: typing
  "Houston" missed everyone in Katy, Pasadena and Sugar Land, who are a short
  drive away and exactly who an employer wants. `talent_search` prefilters on a
  bounding box (indexed lat/lng) then trims the corners with haversine, so a
  "25 mile" search does not quietly reach 35 on the diagonal. Plain columns
  rather than PostGIS: this table holds thousands of rows, not millions.
  `mcv_distance_miles` in SQL and `distanceMiles` in TS must stay in agreement.
- **Seniority is a BUCKET, never a number.** An exact figure plus a graduation
  year is an age, which this product refuses to collect at all. For the same
  reason the filter set is closed — free text, category, city, state,
  availability. No filter may proxy for a protected class; see
  `ALLOWED_FILTER_KEYS` and the discipline note in `lib/talent/taxonomy.ts`.
- **Browsing NEVER mints a guest session.** Every other route calls
  `resolveUserId()`, which creates an `auth.users` row when there is none. The
  directory is the one surface strangers and crawlers are expected to hit, so it
  uses `resolveExistingUserId()` (the read that does not mint) and falls back to
  an IP-keyed rate limit. `POST /api/employers` is the single exception, and only
  because someone just typed their name into it.
- **The search guard lives in the service, not the route.**
  `lib/services/talent-directory.ts` carries the rate limit and the analytics, and
  both `/api/talent/search` and the server-rendered `/empleadores` go through it —
  the page must not be a way around the guard its own API has.
- **Reveal and audit are ONE statement.** `talent_reveal_contact` inserts the
  `contact_reveals` row and returns the contact together, so contact data cannot
  be returned without the access being recorded. Two calls from a route could
  always drop the second.
- **The résumé is streamed, not signed.** `GET /api/talent/:slug/resume` re-checks
  the employer on every request rather than handing out a signed storage URL — a
  signed URL is a forwardable bearer token that outlives the session and the
  listing. It reaches past the bucket's RLS with `getServiceResumeFileStore()`,
  which is deliberately a separate function so `grep -rn
  getServiceResumeFileStore` lists every place that can read another user's file.
  The bucket's own policies are untouched.
- **`contact_reveal` is the limit that matters** — the only one in the product
  protecting people rather than infrastructure. `employer_register` is capped at
  or below it so minting fresh "employers" is not a way around the per-identity
  reveal limit.
- **The directory lives on the SAME deployment, at `/empleadores`.** It is simply
  not linked from anywhere in the builder — no header entry, no footer, no CTA —
  so a job seeker never stumbles into it, and an employer reaches it by being
  given the URL. An earlier version split the two by host (`EMPLOYER_HOSTS`, a
  middleware rewrite, a second header); it was removed as more moving parts than
  the separation was worth. If a dedicated domain is ever wanted, point it at the
  same Vercel project — no code change is needed for `/empleadores` to answer on it.
- **`/empleadores` is indexable; `/talento/[slug]` is `noindex`.** Being findable
  on Google must not make every listing a permanent cached record of a real
  person's employment situation. Unknown, unpublished and expired slugs all render
  the same 404 — distinguishing them would confirm someone was once listed, which
  is what unpublishing is meant to undo.
- **Search is accent-insensitive, and Postgres does not do that for free.** The
  stock `spanish` config stems but does not fold accents, so `reposteria` would
  not find `Repostería` — a silent failure for an audience that mostly types
  without accents. `0010` creates a `spanish_unaccent` configuration (requires the
  `unaccent` extension, as does `simple_unaccent` in `0012`) and uses it on
  **both** the stored document and the query;
  folding one side only reintroduces the mismatch. `MemoryTalentStore` folds via
  `normalizeForMatch`, and `tests/unit/talent-directory.test.ts` pins the contract
  for both.
- **The free-text box searches two things, and names are the SECOND one.**
  `0012` added `name_tsv` beside `search_tsv`, so an employer who knows who they
  want can type a name. It is a separate column and a separate matcher, ORed in
  `talent_search`, and it must stay that way: `search_tsv` uses
  `spanish_unaccent`, which STEMS, and Spanish surnames are frequently trade
  words — `Herrera`→`herrer` is the `oficios` keyword for herrería, `Flores`→`flor`
  is floristry. Merged into one document, "herrero" returns everyone named
  Herrera. So names are matched **unstemmed**, through a `simple_unaccent`
  configuration, and by **prefix** (`gonz` finds González) via
  `mcv_talent_name_query`, whose `nameSearchTokens` mirror in `lib/talent/text.ts`
  keeps `MemoryTalentStore` in agreement. Tokens under two characters are dropped
  rather than prefixed — `a:*` matches most of any name column, which would make
  one keystroke a way to page out the directory.
  Be clear about what this traded: it exposes no new field (the full name is
  already on the card, the table and the profile page), but it turns "is this
  particular person job-hunting?" from a paging exercise into one query, runnable
  by someone's current employer. That was weighed and accepted; do not re-derive
  it as a bug.
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

**Still missing (Phase 4):** emailing the manage link — today the token is shown
once, on the publish response, and a user who never copies it and then clears
cookies cannot unpublish. That needs a mail dependency the repo does not have and
should be treated as required, not polish. Also outstanding: the
`/perfil/gestionar?token=…` page, renewal, and moderation tooling for the
`blocked` status.

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
service-role only). See **Bolsa de Talento**.

`0007_simplified_schema.sql` collapsed 13 tables into five;
`0008_resume_pdf_per_stage.sql` dropped `resume_pdfs` for the fifth. The rules that
follow:

- **There is exactly ONE generated résumé per profile**, on the `funnel` row.
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
  expiry, reveal auditing, and the rate-limit policy.
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
`AI_SPEND_CAP_USER_USD`, `AI_SPEND_CAP_DAILY_USD`, `USAGE_LIMITS`.

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
