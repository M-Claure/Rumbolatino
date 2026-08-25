# Authentication — production setup

The employer login for the Rumbo Latino talent directory, made production-ready
on Supabase Auth with Resend as the SMTP delivery provider.

This document is the whole configuration story. It contains **no secrets and no
real credentials**, and must not be given any.

| Section | |
| --- | --- |
| [A. What was implemented in code](#a-what-was-implemented-in-code) | |
| [B. Environment variables](#b-environment-variables) | placeholders only |
| [C. Supabase dashboard settings](#c-supabase-dashboard-settings) | **needs your access** |
| [D. URL configuration](#d-url-configuration) | **needs your access** |
| [E. Enabling email confirmation](#e-enabling-email-confirmation) | **needs your access** |
| [F. Resend Custom SMTP](#f-resend-custom-smtp-in-supabase) | **needs your access** |
| [G. DNS — for Aprende / Rumbo Latino IT](#g-dns--what-it-must-do) | **needs IT** |
| [H. Still requires administrative access](#h-what-still-requires-administrative-access) | |
| [I. Pre-production testing checklist](#i-pre-production-testing-checklist) | |
| [J. Rollback and troubleshooting](#j-rollback-and-troubleshooting) | |
| [K. Database authorization review](#k-database-authorization-review) | |

---

## The decision this change encodes

Authentication is **entirely Supabase's**. Account, password hashing, sessions,
refresh tokens, the confirmation email, the recovery email, and the tokens inside
them. This application issues no credential of its own.

That reverses the previous design, and the reversal is deliberate rather than an
oversight. Migration `0013` and the older half of `docs/employer-accounts.md`
moved verification **off** GoTrue because it could not be shipped on it:

- Supabase's built-in sender is capped at a handful of messages an hour and, on
  current projects, only delivers to addresses inside the Supabase organisation.
  Every other sign-up produced a cheerful "revisa tu correo" and an empty inbox,
  **with no error anywhere** — `signUp` returned success and the message was
  dropped downstream.
- A PKCE confirmation link only worked in the browser that signed up, which is
  the wrong browser for most of this audience.

Both objections are now answered, which is what makes native flows correct here
and not merely conventional:

- **Resend as Custom SMTP** replaces the built-in sender entirely. Throughput,
  deliverability and bounce visibility become Resend's.
- **`token_hash` links to `/auth/confirm`** carry no PKCE verifier, so they work
  on any device.

What that buys is not just less code. Reset-token generation, single-use
enforcement, expiry and replay protection stop being ours to get right, and the
password change no longer needs `auth.admin.updateUserById` — an API that will
change *any* user's password and was previously guarded only by our own token
check running first.

**The job-seeker side is untouched.** There is still no login, no sign-up and no
password anywhere in the résumé builder; a visitor answers a question and a guest
identity is created for them (`lib/auth.ts`). Nothing in this document applies to
it. The two sessions live in separate cookies so neither can evict the other.

---

## A. What was implemented in code

### New files

| File | Purpose |
| --- | --- |
| `app/auth/confirm/route.ts` | **The callback to configure.** Verifies a `token_hash` with `verifyOtp` — works in any browser, on any device. |
| `app/auth/callback/route.ts` | PKCE `code` exchange, for Supabase's stock templates. Same-browser only; the documented fallback. |
| `lib/auth-redirect.ts` | Open-redirect guard. Pure, allow-listed, unit-tested. |
| `lib/employers/auth-callback.ts` | The half both callbacks share: response-bound cookies, failure mapping, the `employers` mirror. |
| `app/empleadores/verifica-tu-correo/page.tsx` | The dedicated "check your email" screen. |
| `components/employers/CheckEmailPanel.tsx` | Resend action with a 60-second cooldown. |
| `docs/auth-email-templates.md` | Template content to paste into the dashboard. |
| `tests/unit/auth-redirect.test.ts` | 13 tests on the redirect guard. |
| `tests/unit/employer-auth-supabase.test.ts` | 17 tests on the Supabase seams. |

### Rewritten

- **`lib/services/employer-account.ts`** — every flow now calls Supabase:
  `signUp` (with `emailRedirectTo` and company metadata), `signInWithPassword`,
  `resend({ type: 'signup' })`, `resetPasswordForEmail`, `updateUser({ password })`,
  `signOut({ scope: 'local' })`. Adds `translateAuthError`, which turns GoTrue's
  English into actionable Spanish and never echoes an unrecognised upstream
  message to a user.
- **`lib/employers/session.ts`** — the gate now treats
  `auth.users.email_confirmed_at` as the authority and `employers.email_verified_at`
  as a mirror it repairs. Previously the mirror *was* the gate, which is only
  correct while confirmation is ours.
- **`app/api/employers/contrasena/route.ts`** — authorized by the session, not by
  a token in a cookie of ours.
- **`app/empleadores/nueva-contrasena/page.tsx`** — requires a recovery session.
- **`components/employers/EmployerAuthForms.tsx`** — sign-up and unverified
  sign-in navigate to the check-email screen; shared client-side validation;
  double-submit guard using a ref as well as `disabled`.

### Kept as forwarding shims

`/empleadores/verificar` and `/empleadores/recuperar/confirmar` no longer consume
anything. They forward Supabase-shaped parameters to the real callbacks and turn
a stale link from the old flow into "pide uno nuevo" rather than a 404. Links
already sitting in mailboxes therefore land somewhere sensible.

### Kept, unused, on purpose

`lib/employers/tokens.ts`, the `employer_email_tokens` table and
`mcv_consume_employer_token` are **the rollback**. Reverting the switch restores a
working flow with no database migration and no data loss. Drop them only after
native delivery has been observed in production — and drop all three together.

### Security properties

| Property | How |
| --- | --- |
| No open redirect | `safeNextPath` — allow-list of path prefixes, rejects absolute, scheme-relative (`//host`), backslash (`/\host`), traversal and control characters. Falls back to `/empleadores`. |
| No account enumeration | Registration answers identically for a new and an existing address (`isExistingAccount` reads Supabase's empty-`identities` signal). Resend and recovery always resolve. The login form has one message for every credential failure. |
| `email_not_confirmed` is not a leak | GoTrue verifies the **password before** the confirmation state, so that outcome only reaches someone who already supplied the correct password. |
| Server-side session boundary | Every gated surface calls `checkEmployerGate()`; `searchDirectory` / `readPublicProfile` take an `EmployerSession` as a **parameter**, so a caller that skips the check is a compile error. |
| Session validated, not parsed | `getUser()`, never `getSession()` — the token is revalidated against the auth server. |
| No secret in the browser | `SUPABASE_SERVICE_ROLE_KEY` is read only through `server-only` modules. No `NEXT_PUBLIC_*` holds a secret. |
| Cookies land on the response | Both callbacks bind the Supabase cookie sink to the redirect they return. |
| Namespaced session | `mcv-empleador-auth`, so signing in as an employer cannot evict a job seeker's guest session — the only handle on an in-progress résumé. |
| Sign-out is POST | A GET logout can be triggered by any page that embeds it as an image. |
| Rate limits | `employer_register` 10/h, `employer_login` 20/h, `employer_email` 6/h, all by IP, in Postgres so they hold across instances (`lib/rate-limit/policy.ts`). |

---

## B. Environment variables

Placeholders only. Real values go in Vercel's environment settings (or your
host's), **never in a file in this repository**.

```bash
# Supabase — public, safe in the browser
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>

# Supabase — SERVER ONLY. Bypasses RLS. Never NEXT_PUBLIC_, never in Git.
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# Public origin of this deployment. Optional (derived from request headers),
# but set it in production so email redirects cannot drift.
NEXT_PUBLIC_SITE_URL=https://rumbolatino.com

PERSISTENCE=supabase
```

**There is no `RESEND_API_KEY`, and there must not be.** This application does not
call Resend. Supabase does, over SMTP, using credentials stored in the Supabase
dashboard. A Resend key in this app's environment would mean auth mail was being
sent from here, which is exactly what this design avoids.

`MAIL_FROM_ADDRESS` / `MAIL_REPLY_TO` remain in `.env.example` but **do not
configure authentication email** — that sender is set in Supabase. They describe
the identity for the one message this product may eventually send itself (the
talent directory's manage link, which goes to a job seeker with no account).
Keep them in step with the Supabase sender anyway: two different From addresses
give a customer two identities to trust instead of one.

---

## C. Supabase dashboard settings

> **These require your access. They cannot be done from this repository.**

| # | Where | Setting | Value |
| --- | --- | --- | --- |
| 1 | Authentication → Providers → Email | **Confirm email** | **ON** |
| 2 | Authentication → Providers → Email | **Secure email change** | ON |
| 3 | Authentication → Providers → Email → Password Requirements | Minimum length | `10` |
| 4 | Authentication → Providers → Email → Password Requirements | Required characters | **Lowercase, uppercase letters, digits and symbols** |
| 5 | Authentication → Providers → Email | Enable Email provider | ON |
| 6 | Authentication → URL Configuration | Site URL | `https://rumbolatino.com` |
| 7 | Authentication → URL Configuration | Redirect URLs | see [section D](#d-url-configuration) |
| 8 | Authentication → Emails → Templates | All templates | see `docs/auth-email-templates.md` |
| 9 | Project Settings → Authentication → SMTP Settings | Custom SMTP | Resend — see [section F](#f-resend-custom-smtp-in-supabase) |
| 10 | Authentication → Sessions | Email OTP Expiration | 3600 s (1 h) is fine; ≤ 24 h |
| 11 | Authentication → Sign In / Providers | **Allow anonymous sign-ins** | **ON** — leave as it is |

**#3 and #4 must match `lib/employers/policy.ts`.** The Supabase setting is the
authority — it is enforced by the auth API whatever the code says. The code
mirrors it only so the rejection arrives in Spanish naming every missing
character class at once, rather than in English.

**#11 is not part of this change, and turning it off would break the résumé
builder.** Job seekers have no accounts; `resolveUserId()` mints an anonymous
session for each visitor. (If it must be off, `SUPABASE_SERVICE_ROLE_KEY`
provides a fallback path — see `lib/auth.ts`.)

**Do not enable CAPTCHA yet.** See [section H](#h-what-still-requires-administrative-access).

---

## D. URL configuration

**Authentication → URL Configuration.** Two settings, and they do different jobs.
Getting either wrong fails *silently* — no error, no log line, just a link that
lands somewhere useless — so this section is longer than its two text boxes
suggest.

### D0. Which one actually matters, and when

| | Used by | Consequence if wrong |
| --- | --- | --- |
| **Site URL** | `{{ .SiteURL }}` in the email templates; the fallback when a redirect is rejected | The confirmation link in every email points at the wrong host. **Nothing works.** |
| **Redirect URLs** | the allow-list Supabase checks `emailRedirectTo` / `redirectTo` against | Links silently land on the Site URL instead of where they should |

Once you paste the `token_hash` templates (§C step 8), the confirmation link goes
**directly** from the email to `{{ .SiteURL }}/auth/confirm?token_hash=…`. It never
passes through Supabase's `/auth/v1/verify` endpoint, so the Redirect URLs
allow-list is **not consulted on the normal path at all**.

That has two consequences worth holding onto:

1. **Site URL is the load-bearing setting.** It is pasted verbatim into every
   email. Treat it with the care you would give a hardcoded production hostname,
   because that is exactly what it is.
2. **Redirect URLs still have to be right**, because they cover the PKCE fallback
   (`/auth/callback`, which stock templates use and which this app still passes as
   `emailRedirectTo` on every `signUp`, `resend` and `resetPasswordForEmail`). If
   the templates are ever reverted, or someone triggers a stock flow from the
   dashboard, this list is what stands between a working link and a broken one.

---

### D1. Site URL

**One value. No trailing slash. No path.**

```
https://rumbolatino.com
```

> **The trailing slash is a real trap.** The templates build their link as
> `{{ .SiteURL }}/auth/confirm?…`. If you enter `https://rumbolatino.com/` — which
> is what a browser gives you when you copy from the address bar — every
> confirmation link in every email becomes
> `https://rumbolatino.com//auth/confirm?…`, with a doubled slash. Whether that
> resolves depends on how the host normalises paths, and you will find out from
> customers rather than from a test. Delete the trailing slash.

**Pick the host your employers actually land on.** If `rumbolatino.com` redirects
to `www.rumbolatino.com` (or the reverse), put the **destination** here, not the
one that redirects. A 301 in the middle of an auth link is one more place for a
query string to be dropped.

Site URL is also the fallback: when Supabase rejects a `redirectTo` for not being
on the allow-list, it sends the user here instead of erroring. That is the
mechanism behind "the link just goes to the home page".

---

### D2. Redirect URLs

The allow-list. Add each entry with **Add URL**; they are stored one per line.

**Paste all four for production:**

```
https://rumbolatino.com/auth/callback
https://rumbolatino.com/auth/callback**
https://rumbolatino.com/auth/confirm
https://rumbolatino.com/auth/confirm**
```

Add the same four for `www.` if that host serves the app too.

#### Why the `**` duplicates are not redundant

This application never sends a bare callback URL. It sends the destination as a
query parameter:

```
https://rumbolatino.com/auth/callback?next=%2Fempleadores
https://rumbolatino.com/auth/callback?next=%2Fempleadores%2Fnueva-contrasena
```

(See `callbackUrl()` in `lib/services/employer-account.ts`.)

Supabase matches allow-list entries against the **whole URL, query string
included**, using glob patterns — not against the path alone. So the plain entry
`https://rumbolatino.com/auth/callback` does not necessarily match a URL that
carries `?next=…`. The `**` form does: it matches any sequence of characters,
separators included.

Both forms are listed because the cost of the redundant entry is nothing and the
cost of guessing wrong is a silent failure discovered by a customer.

#### The glob rules, so the patterns you write mean what you think

| Pattern | Matches |
| --- | --- |
| `*` | any run of characters that are **not** `.` or `/` |
| `**` | any sequence at all, including `.` and `/` |
| `?` | exactly one non-separator character |

Two consequences people trip over:

- **`*` does not cross a dot or a slash.** `https://*.rumbolatino.com/**` matches
  `https://app.rumbolatino.com/…` but **not** `https://a.b.rumbolatino.com/…`.
- **`?` is a wildcard, not a literal question mark.** Never write a query string
  into a pattern — `…/auth/callback?next=*` does not mean what it looks like. Use
  `**` instead.

#### Scope the wildcards

`**` after a full origin and path prefix is fine — it can only ever match deeper
on a host you control. What is **not** fine is a wildcard in the host part broad
enough to include somebody else's:

```
https://*/auth/callback          <-- NO. Any host on the internet.
https://**.vercel.app/**         <-- NO. Anyone's Vercel deployment.
```

Either one turns your project into a redirector that authenticates a user and
then hands them to a stranger's page. Keep wildcards to the path, and to hostname
patterns that are unambiguously yours.

---

### D3. Local development

Add these so you can run the flow on your machine:

```
http://localhost:3000/auth/callback**
http://localhost:3000/auth/confirm**
```

`http://`, not `https://`. Note that local development uses the **same Supabase
project and therefore the same Site URL**, so a `token_hash` template will build
links pointing at production even when you triggered them locally. Two ways
around it, in order of preference:

1. Use a separate Supabase project for local work, with its own Site URL.
2. Trigger the stock `{{ .ConfirmationURL }}` (PKCE) flow locally, which honours
   the `emailRedirectTo` this app sends from the request host and therefore comes
   back to `localhost`.

This is not a bug in the setup — it is what "the Site URL is baked into the
email" means, and it is the same reason the value has to be exactly right.

---

### D4. Vercel preview deployments

Preview builds get a new hostname per deploy, so they cannot be listed
individually. Use a pattern anchored to your own team slug:

```
https://*-<your-vercel-team-slug>.vercel.app/auth/callback**
https://*-<your-vercel-team-slug>.vercel.app/auth/confirm**
```

Find the slug in any preview URL: `my-app-git-branch-<slug>.vercel.app`.

Previews have the same Site URL problem as localhost (D3). Treat preview
authentication as a smoke test of the code path, and do the real verification
against production.

---

### D5. Verify it, do not assume it

The failure mode here is silence, so check rather than trust.

**Site URL — read it out of a real email.** Register a test account and look at
the link in the message that arrives. It must read:

```
https://rumbolatino.com/auth/confirm?token_hash=…&type=signup&next=/empleadores
```

Check specifically for: the right host, **one** slash before `auth`, and the
`type` and `next` parameters present. This one message tells you whether Site URL
and the templates are both correct.

**Redirect URLs — check the PKCE path.** Temporarily restore Supabase's stock
"Confirm signup" template (just `{{ .ConfirmationURL }}`), register another test
account, and confirm the link lands on `/empleadores` rather than on the home
page. Landing on the home page means the `emailRedirectTo` was rejected and
replaced by the Site URL — the exact symptom this list exists to prevent. Restore
the `token_hash` template afterwards.

If you would rather not touch the templates, the same check works from the SQL
editor or any HTTP client by calling the recover endpoint and reading the link
that arrives.

---

### D6. Set `NEXT_PUBLIC_SITE_URL` to match

In Vercel → Settings → Environment Variables, for **Production**:

```
NEXT_PUBLIC_SITE_URL=https://rumbolatino.com
```

Same value as Site URL, same no-trailing-slash rule. Without it the app derives
its origin from the request headers, which is correct in most deployments and
wrong the moment a proxy rewrites the host. Setting it explicitly in production
removes the question.

Leave it **unset** on Preview, so preview deployments build redirects back to
themselves rather than to production.

---

### D7. Retire the old entries

If the allow-list still carries the pre-switch paths, leave them for about 24
hours — the old verification token's lifetime — so links already sitting in
mailboxes keep resolving through the forwarding shims. Then remove:

```
https://rumbolatino.com/empleadores/verificar
https://rumbolatino.com/empleadores/recuperar/confirmar
```

---

## E. Enabling email confirmation

**Authentication → Providers → Email → "Confirm email" → ON.**

This is the **reverse** of what `0013` and the current `docs/employer-accounts.md`
require, and the reverse of the setting the project is on today. Turning it on is
part of this change, not optional with it.

What changes when it goes on:

- `signUp` returns **no session**. The account exists but cannot be used.
- `signInWithPassword` refuses an unconfirmed address with `email_not_confirmed`.
  The app maps that to the check-email screen rather than a login failure.
- `auth.users.email_confirmed_at` is set only by a real confirmation, which is
  what makes it safe for the gate to read.

**Order matters.** Turn it on **after** Custom SMTP is working (section F).
Between the two, new sign-ups would be blocked on a confirmation nothing can
deliver.

**Existing accounts:** anyone already verified under the old flow has
`employers.email_verified_at` set, and `0013` backfilled
`auth.users.email_confirmed_at` from it — so they keep working. Verify before
flipping the switch:

```sql
-- Accounts that will be locked out by turning "Confirm email" on.
-- Expect zero rows. Each one is a real person who can no longer sign in.
select e.email, e.created_at, e.email_verified_at, u.email_confirmed_at
  from employers e
  join auth.users u on u.id = e.id
 where u.email_confirmed_at is null;
```

If rows come back, either confirm them by hand (below) or accept that they must
use "¿Olvidaste tu contraseña?", which confirms the address as a side effect.

```sql
-- Confirm one account by hand. Requires the SQL editor; use sparingly.
update auth.users set email_confirmed_at = now()
 where email = 'ana@empresa.com' and email_confirmed_at is null;

update employers set email_verified_at = now()
 where lower(email) = 'ana@empresa.com' and email_verified_at is null;
```

---

## F. Resend Custom SMTP in Supabase

Two systems, in this order: **Resend first** (you need the credentials), then
Supabase.

### F1. In Resend — what you do

1. **Add the domain.** Resend dashboard → **Domains → Add Domain** →
   `auth.rumbolatino.com`.

   A **subdomain**, not the apex. Sending reputation is tracked per domain, so a
   dedicated subdomain keeps transactional mail isolated from anything marketing
   ever sends from `rumbolatino.com`, and a reputation problem on one does not
   sink the other. It also means IT adds records to a name nothing else uses,
   which is a smaller ask and a safer change.

2. **Copy the DNS records Resend shows you.** There will be three or four: a DKIM
   `TXT`, an SPF `TXT` on a `send.` subdomain, an `MX` for the same, and
   optionally a DMARC `TXT`. **Send them to IT verbatim** — see
   [section G](#g-dns--what-it-must-do).

3. **Wait for Verified.** Nothing sends until Resend shows the domain as
   verified. This is where the project sits until IT acts.

4. **Create an SMTP credential.** Resend → **API Keys → Create API Key**, with
   **Sending access** permission. Resend's SMTP username is the literal string
   `resend` and the password is this API key.

   Give it a name that says where it is used — `supabase-smtp-production` — so it
   can be revoked without guessing what breaks.

5. Note the SMTP host and port: `smtp.resend.com`, port `465` (implicit TLS).

### F2. In Supabase — what you do

**Project Settings → Authentication → SMTP Settings → Enable Custom SMTP.**

| Field | Value |
| --- | --- |
| Sender email | `no-reply@auth.rumbolatino.com` |
| Sender name | `Rumbo Latino` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | *the Resend API key from F1.4* |
| Minimum interval between emails | `60` seconds |

Then **Authentication → Rate Limits** → raise "Emails per hour" from the default
(a handful) to something real — 100/hour is generous for this product's volume
and still a ceiling.

**One sender name for two brands, and this is a known limitation.** The app
serves Rumbo Latino and Aprende Institute from one deployment, and Supabase has
one SMTP sender identity per project. So an employer arriving from an Aprende
host receives a confirmation signed "Rumbo Latino". Options, in order of cost:
accept it (the directory is a Rumbo Latino product); or use a neutral sender name
and neutral template copy; or run a second Supabase project for the Aprende
brand. Decide before the Aprende domain goes live, not after.

### F3. Verify

Register a test account against production and confirm:

- the message arrives (check spam on the first send);
- the From line reads `Rumbo Latino <no-reply@auth.rumbolatino.com>`;
- Resend's **Logs** show it as delivered;
- the link opens in **a different browser** and lands signed in.

---

## G. DNS — what IT must do

> **Nobody on this project has DNS access. This section is the whole ask.**
> Until it is done, no authentication email can be delivered and the employer
> directory cannot be opened to the public.

Send Aprende / Rumbo Latino IT the following. **Fill in the values from the
Resend dashboard first** — the ones below are shapes, not real records, and the
DKIM key in particular is unique to your domain.

---

**Request: DNS records for transactional email on `auth.rumbolatino.com`**

We are enabling account confirmation and password-reset email for the Rumbo
Latino employer directory. Mail is sent by Resend. We are requesting records on
the subdomain **`auth.rumbolatino.com`** only — no change to `rumbolatino.com`
itself, its website, or its existing mail.

Please add:

| Type | Name / Host | Value | TTL |
| --- | --- | --- | --- |
| `TXT` | `resend._domainkey.auth` | *(DKIM public key from Resend — one long string)* | 3600 |
| `MX` | `send.auth` | `feedback-smtp.us-east-1.amazonses.com` (priority `10`) | 3600 |
| `TXT` | `send.auth` | `v=spf1 include:amazonses.com ~all` | 3600 |
| `TXT` | `_dmarc.auth` | `v=DMARC1; p=none; rua=mailto:<a monitored mailbox>` | 3600 |

Notes for IT:

- Host names are shown **relative** to the zone (`rumbolatino.com`). If your DNS
  panel wants fully-qualified names, append `.rumbolatino.com`, e.g.
  `resend._domainkey.auth.rumbolatino.com`.
- The Resend region in the `MX` value may differ — **use exactly what the Resend
  dashboard shows**, not the example above.
- **Do not** add these to the apex `rumbolatino.com`. Doing so would put a second
  SPF record on the apex, and two SPF records on one name is a permanent error
  that breaks *all* mail from that domain, including existing corporate mail.
- The DMARC policy starts at `p=none` (monitor only) deliberately. It reports
  without rejecting anything, so it cannot break existing mail. Tighten to
  `p=quarantine` after a few weeks of clean reports.
- No changes to `MX` on the apex. Existing mail is untouched.

Propagation is usually minutes and at most a few hours. Please confirm when
added, so we can complete verification in Resend.

---

**Also confirm with IT:**

- Does a mailbox exist for `MAIL_REPLY_TO`? A `no-reply@` sender that silently
  discards replies is poor for this audience — small business owners answer
  emails — so a monitored address is worth asking for.
- Is there an existing DMARC record on the apex? If `p=reject` is already set at
  `rumbolatino.com` without `sp=none`, it applies to subdomains and will reject
  this mail until the subdomain record above is in place.

---

## H. What still requires administrative access

Everything in this table is **outside this repository**. Nothing in the code can
complete it, and the feature is not production-ready until it is done.

| # | Task | Who | Blocks |
| --- | --- | --- | --- |
| 1 | Add `auth.rumbolatino.com` in Resend, get DNS records | You (Resend) | everything below |
| 2 | Add the DNS records | **IT** | all email delivery |
| 3 | Confirm domain Verified in Resend | You (Resend) | all email delivery |
| 4 | Create the Resend SMTP API key | You (Resend) | Supabase SMTP |
| 5 | Configure Custom SMTP in Supabase | You (Supabase) | all email delivery |
| 6 | Raise the Supabase email rate limit | You (Supabase) | sign-ups at volume |
| 7 | Paste the email templates | You (Supabase) | cross-device links |
| 8 | Set Site URL and Redirect URLs | You (Supabase) | every callback |
| 9 | Set the password policy (length 10 + 4 classes) | You (Supabase) | policy parity |
| 10 | **Turn "Confirm email" ON** — after #5 | You (Supabase) | the whole gate |
| 11 | Run the pre-flight query in section E | You (Supabase) | existing accounts |

### Recommended production hardening, not done here

- **CAPTCHA / Cloudflare Turnstile is NOT configured**, and enabling it in the
  Supabase dashboard alone **will break sign-up and sign-in**: with Attack
  Protection on, GoTrue requires a `captchaToken` on every `signUp`,
  `signInWithPassword`, `resend` and `resetPasswordForEmail` call, and this app
  sends none. Enabling it is a code change too — a Turnstile widget in
  `EmployerAuthForms`, the token through the API routes, and
  `options: { captchaToken }` on each Supabase call. Do that as its own piece of
  work. Until then the IP-keyed rate limits are the protection, and they are
  real but forgeable (`x-forwarded-for` can be spoofed; see the note in
  `lib/rate-limit/policy.ts`).
- **Leaked-password protection** — Authentication → Providers → Email → "Prevent
  use of leaked passwords" (HaveIBeenPwned). Safe to turn on now; it rejects in
  English, so consider adding a Spanish mapping in `translateAuthError` when you
  do.
- **MFA** — not implemented and probably not wanted for this audience.
- **Session lifetime** — Authentication → Sessions. The default refresh token
  never expires while in use. A shop-counter computer is a shared device;
  consider a 30-day inactivity timeout.
- **Auth webhooks / log drain** — nothing currently alerts on a spike in failed
  sign-ins.

---

## I. Pre-production testing checklist

Run against a **staging or production** Supabase project with SMTP configured.
Automated tests cover the pure logic (`npm test` — 720 tests, including 30 on the
auth seams); everything below needs a real mailbox and a real browser and cannot
be faked.

Use two browsers — call them **A** (where you sign up) and **B** (a different
browser or a phone) — because the single most valuable check here is that a link
works in B.

### Sign-up

- [ ] Register with a fresh address → lands on `/empleadores/verifica-tu-correo`, showing that address.
- [ ] The confirmation email arrives within a minute. From line reads `Rumbo Latino <no-reply@auth.rumbolatino.com>`.
- [ ] Both an HTML and a plain-text body are present (view source in the client).
- [ ] **Duplicate:** register the *same* address again → identical screen, no error, no hint that the account exists.
- [ ] Register with a duplicate address and a *different* company name → the original `employers` row is unchanged (`select company from employers where email = …`).
- [ ] **Invalid email:** `notanemail` → Spanish rejection, no request sent.
- [ ] **Disposable email:** `x@mailinator.com` → rejected with the explanation about permanent addresses.
- [ ] **Weak password:** `corta` → names the minimum length. `contraseñalarga` → names uppercase, digit and symbol *in one message*.
- [ ] **Double submit:** double-click "Crear cuenta" → one account, one email.
- [ ] Sign-up does **not** create a session (no directory access before confirming).

### Email verification

- [ ] Open the link in browser **B** → lands on `/empleadores` **signed in**. *(This is the check that proves the `token_hash` template is live.)*
- [ ] `employers.email_verified_at` and `auth.users.email_confirmed_at` are both set.
- [ ] **Re-use:** open the same link again → `/empleadores/acceso` with "ese enlace ya no sirve".
- [ ] **Tampered:** change one character in `token_hash` → same message, no session.
- [ ] **Expired:** wait past the OTP expiry (or set it to 60 s temporarily) → "ese enlace ya caducó".
- [ ] **Open redirect:** append `&next=https://example.com` → lands on `/empleadores`, never on `example.com`. Repeat with `&next=//example.com` and `&next=/api/employers/salir`.

### Resend

- [ ] From the check-email screen, "Enviar el enlace otra vez" → success notice, button shows a 60-second countdown.
- [ ] The newest link works; confirm with it.
- [ ] Resend for an address with **no** account → same success message, no email sent, no disclosure.
- [ ] Resend for an **already confirmed** address → same success message, no error shown.
- [ ] Press it seven times in an hour → a 429 in Spanish, not a crash.

### Login

- [ ] Correct credentials on a confirmed account → `/empleadores`, with the correct address in the top bar.
- [ ] **Wrong password** → "Correo o contraseña incorrectos."
- [ ] **Non-existent address** → *the same sentence, character for character.*
- [ ] **Unverified account** → redirected to the check-email screen, not an error.
- [ ] Signed in already, visit `/empleadores/acceso` → redirected to `/empleadores` (no needless re-login).

### Logout

- [ ] "Salir" → `/empleadores/acceso` with "cerraste tu sesión".
- [ ] Back button then reload → still signed out (server-rendered, not cached).
- [ ] `/empleadores` now redirects to the access page.
- [ ] **Cross-role:** start a résumé at `/` in the same browser, then sign in as an employer, then sign out → the résumé is still there. *(The namespaced cookie is what protects this; a regression here destroys users' work.)*

### Forgot / reset password

- [ ] "¿Olvidaste tu contraseña?" with a real address → "Si … tiene una cuenta, ahí llegará un enlace".
- [ ] With an address that has **no** account → *the same message*, no email.
- [ ] The email arrives; the link opens in **B** and lands on `/empleadores/nueva-contrasena`.
- [ ] Weak new password → rejected in Spanish, still on the form.
- [ ] Valid new password → `/empleadores`, signed in.
- [ ] The **old** password no longer works.
- [ ] The recovery link, re-used → "ese enlace ya no sirve".
- [ ] `/empleadores/nueva-contrasena` with no session → redirected to the access page.
- [ ] A recovery on an account that never confirmed → also confirms it.

### Protected routes

- [ ] Signed out, `curl -i https://…/api/talent/search?q=cocina` → **401**, no profile data.
- [ ] Signed out, `curl -i https://…/api/talent/<slug>/resume` → **401**, no PDF.
- [ ] Signed out, `/empleadores` → redirect to the access page. `/talento/<slug>` → same.
- [ ] Signed in and confirmed → all four work.
- [ ] With **JavaScript disabled**, `/empleadores` still redirects. *(The boundary must be the server, not a React component.)*

### Another user's data

- [ ] Build two résumés in two browsers. With A's session cookie, request B's profile id → 404/403, never B's content.
- [ ] With A's cookie, `GET /api/resume-profiles/<B's id>` → refused.
- [ ] With A's cookie, try B's stored PDF path in Supabase Storage → refused by the bucket policy.
- [ ] An employer session cannot read any `funnel` row (`employers` and `funnel` share no path).
- [ ] The anon key cannot select from `employers`, `talent_contacts`, `contact_reveals` or `employer_email_tokens` — see [section K](#k-database-authorization-review).

### Session refresh and expiry

- [ ] Sign in, wait past the access-token lifetime (default 1 h), reload `/empleadores` → still signed in (middleware refreshed it).
- [ ] Delete the `mcv-empleador-auth` cookie, reload → redirect to the access page with "entra con tu cuenta".
- [ ] Corrupt that cookie's value, reload → redirect with "tu sesión caducó", no 500.
- [ ] Revoke the session in the Supabase dashboard (Authentication → Users → sign out user), reload → signed out. *(This is what `getUser()` buys over `getSession()`.)*

### Configuration failure modes

- [ ] Temporarily unset `SUPABASE_SERVICE_ROLE_KEY` → `/empleadores` renders "no disponible", **not** a login prompt and not a stack trace.
- [ ] Check the deploy logs for `[auth]` or `[employers]` errors after a full pass.

---

## J. Rollback and troubleshooting

### Rollback

The switch is one commit and one dashboard setting, and they must move together.

1. **Turn "Confirm email" OFF** in Supabase. *(Do this first. The old flow cannot
   complete a GoTrue confirmation, so leaving it on locks out every new account.)*
2. `git revert <commit>` and deploy.

No database migration is needed either way: `employer_email_tokens`,
`mcv_consume_employer_token` and `lib/employers/tokens.ts` were deliberately left
in place for exactly this. `employers.email_verified_at` is written by both
designs, so accounts confirmed under either remain confirmed under the other.

The old flow has no mail transport (`LogMailSender` prints to the log), so after a
rollback the employer side is **admin-provisioned** again: an operator stamps
`employers.email_verified_at` by hand. That is a real workflow for a handful of
pilot customers and not one for public launch — which is the situation this
change exists to end.

**Partial rollback — templates only.** If the `token_hash` templates misbehave,
restore Supabase's stock templates without touching the code. `/auth/callback`
handles the code flow, so everything keeps working, limited to same-browser
links. This is the safest first move if links start failing.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No email arrives at all | Custom SMTP not configured; Supabase's built-in sender only delivers inside your Supabase org | Section F. Check Resend → Logs: no entry means Supabase never handed it over. |
| Email to some addresses only | Same — the built-in sender is still in use | Section F |
| "Email rate limit exceeded" | Supabase's per-hour email cap | Authentication → Rate Limits |
| Link works in one browser, not another | Stock `{{ .ConfirmationURL }}` template (PKCE) | Paste the `token_hash` templates — `docs/auth-email-templates.md` |
| Link lands on the home page | Destination not on the Redirect URLs allow-list | Section D |
| `?estado=enlace_invalido` on a fresh link | Wrong `type=` in the template, or the token was already consumed by a mail scanner prefetching the link | Check `type` matches the template; consider that some corporate mail scanners follow links |
| `?estado=enlace_otro_navegador` | PKCE code redeemed elsewhere | Same as the cross-browser row |
| Confirmed employer still refused | No `employers` row (registration's write failed *and* the metadata repair did not run) | `select * from employers where email = …`; check logs for `[employers] the account was created in Supabase Auth but the employers row was not written` |
| Every employer sees "no disponible" | `SUPABASE_SERVICE_ROLE_KEY` missing or wrong | The gate fails **closed** by design. Check the env var. |
| Sign-in fails for everyone after go-live | "Confirm email" turned on before SMTP worked | Section E, and run the pre-flight query |
| Sign-up returns 400 with no useful message | Supabase CAPTCHA (Attack Protection) enabled without code support | Turn it off — see section H |
| Employer sign-in wiped a résumé | Cookie namespacing regression | `EMPLOYER_COOKIE_NAME` must stay distinct from the default Supabase cookie. This is a serious bug — there is no résumé recovery flow. |

**Where to look:** every failure path logs with a `[auth]` or `[employers]`
prefix. Failed callbacks log the GoTrue message at `warn`; configuration faults
log at `error`. In Supabase, Authentication → Logs shows the auth-server side;
in Resend, Logs shows delivery.

---

## K. Database authorization review

Reviewed as part of this work. **No policy was changed** — the existing RLS is
sound, and altering it without cause risks breaking a working product for no
security gain.

### What exists

| Table | RLS | Policy | Reachable by |
| --- | --- | --- | --- |
| `funnel` | on | `funnel_owner`: `user_id = auth.uid()` (using **and** with check) | the owner only |
| `iteration_1..3` | on | owner via `exists (select 1 from funnel …)` | the owner only |
| `talent_profiles` | on | `talent_profiles_owner`: `user_id = auth.uid()` | the owner; the public view is two security-definer functions |
| `talent_contacts` | on | **none** | `service_role` only |
| `employers` | on | **none** | `service_role` only |
| `contact_reveals` | on | **none** | `service_role` only |
| `employer_email_tokens` | on | **none** | `service_role` only |
| `rate_limits`, `ai_spend` | on | **none** | `service_role` only |
| `storage.objects` (`resumes`) | on | four policies on `(storage.foldername(name))[1] = auth.uid()::text` | the owner's folder only |

RLS-on-with-no-policies denies every role that respects RLS, which includes
`anon` and `authenticated`. The service role bypasses RLS, which is why those
tables are reachable only from server code holding
`SUPABASE_SERVICE_ROLE_KEY` — a value that lives in `server-only` modules and has
no `NEXT_PUBLIC_` twin.

`talent_search` and `talent_profile_public` are security-definer functions whose
`returns table` clause enumerates, by name, every field an employer may see.
`EXECUTE` is revoked from `public` and granted to `service_role` alone. This is
what makes the public shape a **function signature** rather than a table: adding
a column to `talent_profiles` exposes nothing until someone also widens that
clause, in a reviewable diff.

### Verify it yourself

```sql
-- Every table with RLS off, or with RLS on and no policy. Read the list and
-- confirm each one is intended: "no policy" is correct for the service-role
-- tables and a hole for anything else.
select c.relname                                as table_name,
       c.relrowsecurity                         as rls_enabled,
       count(p.polname)                         as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy p on p.polrelid = c.oid
 where n.nspname = 'public' and c.relkind = 'r'
 group by c.relname, c.relrowsecurity
 order by c.relrowsecurity, policies, c.relname;

-- Nothing here should be executable by anon or authenticated.
select p.proname, array_agg(a.rolname order by a.rolname) as can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select rolname from pg_roles) a
 where n.nspname = 'public'
   and p.proname in ('talent_search','talent_profile_public','talent_reveal_contact',
                     'mcv_consume_employer_token','rate_limit_hit','record_ai_spend')
   and has_function_privilege(a.rolname, p.oid, 'execute')
 group by p.proname;
```

A quick negative test with the **anon** key, which is what ships to browsers:

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/employers?select=*" \
     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
# Expected: []  — RLS denies the read. Any row here is a serious finding.
```

### Flagged for manual review — not changed

1. **`auth.uid()` is re-evaluated per row** in `funnel_owner` and the iteration
   policies. Supabase recommends `(select auth.uid())` so the planner hoists it
   to an InitPlan. This is a **performance** matter, not a security one, and
   rewriting working policies during an auth change is the wrong time. Worth
   doing when the tables grow.
2. **Policies do not name a role** (`to authenticated`). They apply to `anon`
   too, which is harmless because `auth.uid()` is `null` for `anon` and
   `user_id = null` never matches — but adding `to authenticated` would make the
   intent explicit and cheaper to evaluate.
3. **`employers` has no self-read policy**, so an employer cannot read their own
   row with the anon key. That is intentional (all access is server-side through
   the service role) and should stay that way unless a client-side profile page
   is ever built.
4. **`contact_reveals.employer_id` is `on delete set null`.** Deleting an
   employer keeps the reveal record but loses who it was — deliberate, so the log
   survives, but it means account deletion degrades the audit trail. Worth a
   decision before offering account deletion.
5. **`employer_email_tokens` is retained but unused.** Its rows are now dead
   credentials. Consider a one-line cleanup when the table is eventually
   dropped — after the rollback window has closed:
   `delete from employer_email_tokens where expires_at < now();`

### Not applicable

The job-seeker side has no login and needs none: every visitor gets a real
`auth.users` row, so `funnel.user_id`'s foreign key and every `auth.uid()` policy
work unchanged. Per-user isolation is enforced by Postgres, not by the absence of
a login screen. Nothing in this change touches it.
