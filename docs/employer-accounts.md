# Employer accounts

The talent directory is gated. An employer registers with their name, company and
email, clicks a link in that mailbox, and only then sees a candidate. This file is
the operator runbook and the reasoning behind the shape.

## What is gated

| Surface | Before | Now |
| --- | --- | --- |
| `/empleadores/acceso` | did not exist | **public, indexable** — the front door |
| `/empleadores` | public, indexable | verified session, `noindex` |
| `/talento/[slug]` | public, `noindex` | verified session, `noindex` |
| `GET /api/talent/search` | public | 401 without a session |
| `GET /api/talent/:slug/resume` | public | 401 without a session |

The indexable surface **moved** rather than disappearing. A gated page cannot be
crawled — a crawler has no account — and a login wall in a search index is worse
than useless, so `/empleadores/acceso` describes the service, lists nobody, and is
the page Google sees. Individual profiles were already `noindex` and stay that way.

## Required dashboard settings

Neither is code. The feature does not work without both.

1. **Authentication → Providers → Email → "Confirm email" ON.** With it off,
   `signUp` returns a live session immediately and the verification gate is
   bypassed entirely.
2. **Custom SMTP** (Project Settings → Authentication → SMTP Settings). Supabase's
   built-in sender is limited to a few messages an hour and is documented as
   unsuitable for production; without your own SMTP most sign-ups never receive a
   link and there is nothing in the app's logs to say so.
3. **Password Requirements → "Lowercase, uppercase letters, digits and symbols"**
   (Authentication → Providers → Email). This setting is the *authority*: the auth
   API enforces it regardless of what our code does.

### The password rule, and why it is written twice

A password must be **at least 10 characters and contain an uppercase letter, a
lowercase letter, a digit and a symbol.** Supabase enforces the four character
classes; the 10-character minimum is ours (Supabase's default is 6, and six
characters is inside brute-force range for an account that reaches other people's
phone numbers).

`lib/employers/policy.ts` mirrors the rule rather than deferring to the API,
because the API rejects in **English** — a message this product's Spanish-speaking
users cannot act on. Mirroring it lets `inspectPassword` name exactly which class
is missing, in Spanish, and name all of them at once so one fix does not take four
attempts. `PASSWORD_RULE_TEXT` is the single sentence both forms and the server's
fallback message use, so they cannot word the same rule differently.

The symbol set is GoTrue's own list, reproduced character for character rather
than approximated as "any non-alphanumeric": being more permissive would accept a
symbol Supabase does not count and produce the English error we are avoiding,
while being less permissive would refuse a password it would have taken.

**Keep the two in step.** A looser dashboard setting means we reject passwords
Supabase would accept; a stricter one means users hit an untranslated error. If
you change the dashboard, change `CHARACTER_CLASSES` and `MIN_PASSWORD_LENGTH`
with it — `tests/unit/employer-policy.test.ts` pins the current rule.

Also add the deployment's URL under **Authentication → URL Configuration →
Redirect URLs**. Otherwise the emailed link redirects to the project's Site URL
and the employer lands somewhere unrelated.

### Recommended: switch the email template to a token hash

By default Supabase's confirmation email uses `{{ .ConfirmationURL }}`, which
comes back to us as `?code=…` — a PKCE exchange that requires the code-verifier
cookie set during sign-up. That cookie only exists in the browser that signed up,
so **clicking the link on a different device fails**, which is the common case:
people sign up on a laptop and read mail on a phone.

Editing the template (Authentication → Email Templates → Confirm signup) to point
at

```
{{ .SiteURL }}/empleadores/verificar?token_hash={{ .TokenHash }}&type=signup
```

makes the link verifier-free and device-independent. `exchangeEmployerAuthCode`
accepts both shapes, so this is an improvement you can make at any time without a
deploy. Do the same for the recovery template, pointing at
`/empleadores/recuperar/confirmar` with `type=recovery`.

## How the pieces fit

```
/empleadores/acceso                 the only public page; sign in / register / reset
   │  POST /api/employers/registro  → Supabase signUp, company+name into user metadata
   ▼
(email)  →  /empleadores/verificar            exchanges the link for a session,
                                              then resolveEmployerSession() writes
                                              the `employers` row
   ▼
/empleadores, /talento/[slug]        gated pages
/api/talent/*                        gated JSON + PDF
```

- `lib/employers/policy.ts` — pure rules: which addresses and passwords are
  acceptable. Unit-tested, no I/O.
- `lib/employers/session.ts` — the gate. `resolveEmployerSession()` is the one
  function that decides whether somebody may see a candidate.
- `lib/services/employer-account.ts` — sign-up, sign-in, resend, reset.
- `lib/repositories/employer-store.ts` — the `employers` row, service-role only.

## Decisions worth not re-litigating

**The employer cookie is namespaced (`mcv-empleador-auth`).** Both roles
authenticate against the same Supabase project. Sharing one cookie would mean an
employer signing in *replaces* a job seeker's guest session — and that cookie is
the only handle on an in-progress résumé, with deliberately no recovery flow, so
signing in would silently destroy someone's work. It would also hand the builder
the employer's user id and start a résumé under their account. Separate names let
one person build a résumé in one tab and hire in another.

**Composition rules are required, against the usual advice.** NIST dropped
"must contain a symbol" requirements on the evidence that they push people toward
`Empresa1!` and a sticky note, where a long passphrase would be stronger. Matching
Supabase's strictest setting was chosen anyway — a deliberate decision, the same
way five Rumbo Latino colour pairs sit below WCAG AA on purpose. Do not "fix" it
back to length-only without also changing the dashboard.

**Free webmail is accepted; disposable inboxes are not.** The employers this
directory exists for are small local businesses, many with no domain at all.
Requiring a company domain would gate out the demand side of the marketplace to
buy a signal the verification link already provides. Throwaway domains are
refused because a mailbox someone held for ten minutes is not an accountable
party, and it makes `contact_reveals` worthless as a record. The blocklist is a
speed bump, not a wall — new throwaway domains appear daily.

**The `employers` row is written at the GATE, not at sign-up.** This is the
security-relevant one. With email confirmation on, `signUp` for an address that
already has an account deliberately does not say so — it returns a user-shaped
object with no identities, so the endpoint cannot be used to enumerate accounts.
That means a sign-up response cannot be trusted to describe a new user, and
writing our row from it would let an attacker register `ana@empresa.com` a second
time and overwrite the real Ana's company name. So sign-up stores the company and
contact name in the auth user's metadata and writes nothing; `ensureEmployerProfile`
creates the row from an authenticated session on the first gated request.

That also makes the gate self-repairing: an account whose row write once failed,
or one created directly in the dashboard, heals on its next page view instead of
being permanently locked out.

**The gate guarantees the row because a foreign key depends on it.**
`contact_reveals.employer_id` references `employers(id)`. A verified session with
no row would fail the audited reveal, so every downstream caller can pass
`employer.userId` to `revealContact` and know it holds.

**The session is a function PARAMETER, not a lookup.** `searchDirectory`,
`searchDirectorySafely` and `readPublicProfile` all take an `EmployerSession`.
Only `resolveEmployerSession` can produce one, so the gate is enforced by the type
checker rather than by remembering to call it — adding a new caller that skips the
check is a compile error, not a review catch.

**Sign-in distinguishes exactly one failure.** "Correct password, mailbox never
confirmed" is reported as `status: "unverified"` with a resend button, because
answering it with "wrong password" leaves someone with working credentials locked
out and no idea why. Every other failure is one generic message: saying "no
account with that address" would turn the login form into an account-existence
oracle. The resend and reset routes always answer 200 for the same reason.

**Rate limits.** `employer_email` (6/hour) is the tightest limit in the product,
because each hit sends mail from our domain to an address the caller typed —
loose limits there are a way to mail-bomb a third party and to burn the sending
reputation the whole flow depends on. `employer_login` is 20/hour, keyed by IP
because a failed login has no session to attribute. `directory_search` and
`contact_reveal` are now keyed by the **account**, so changing networks no longer
resets them and a shared office address no longer shares a quota.

## Troubleshooting

Every failure below has been hit for real. All three are configuration, not code.

### Sign-up succeeds but no email ever arrives

**Cause: Supabase's built-in email sender.** It is rate-limited to a handful of
messages per hour, and on current projects it will only deliver to addresses
belonging to members of your Supabase organization — so testing with any other
address produces exactly this: a cheerful "revisa tu correo" and nothing in the
inbox or the spam folder. Nothing appears in the app's logs either, because
`signUp` returned no error; the message was accepted and then dropped.

**Fix:** configure custom SMTP under **Project Settings → Authentication → SMTP
Settings**. Any transactional provider works — Resend, Postmark, SendGrid, Brevo,
AWS SES — and most have a free tier sufficient for this. You will also need to
verify a sending domain with whichever you pick.

**To keep testing before SMTP is ready:** confirm the account by hand in
**Authentication → Users** → the user → *Confirm email*. That sets
`email_confirmed_at`, which is exactly what the gate reads, so the rest of the
flow — sign-in, the directory, CV downloads, the reveal log — can all be
exercised without a single email being sent. Do NOT reach for turning "Confirm
email" off instead: that disables the entire verification gate for everyone.

### A verified employer is bounced back to the sign-in page

**Cause: `SUPABASE_SERVICE_ROLE_KEY` is not set** in the environment you are
running. `employers` has RLS on with no policies, so only the service role can
read or write it; without the key `getEmployerStore()` throws, the gate fails
closed, and the person is turned away *after* successfully verifying.

This used to be invisible — the gate reported it as "not signed in", which is
advice a verified employer cannot act on, and the real fault sat in a log nobody
was reading. The gate now returns `misconfigured` for this case and the page
renders `DirectoryUnavailable` ("es un problema de nuestro lado") instead of a
login prompt, with the specifics in the server log. API routes answer 503 rather
than 401 for the same reason.

On Vercel, note that Preview and Production have separate environment variables.

### "Ese enlace ya no sirve" after clicking the email link

Two causes, in order of likelihood:

1. **The redirect URL is not allow-listed.** Add the deployment's URL under
   **Authentication → URL Configuration → Redirect URLs**. Without it Supabase
   sends the browser to the project's Site URL and our route never sees a code.
2. **The link was opened on a different device than the one that signed up.** The
   default `?code=` form is a PKCE exchange that needs the code-verifier cookie,
   which only exists in the signing-up browser. This is the common case in
   practice — sign up on a laptop, read mail on a phone. Fix it permanently with
   the `{{ .TokenHash }}` template change described above; both shapes are already
   handled in code.

If neither applies, the exchange failure is logged with Supabase's own reason —
grep the server log for `[employers]`.

### Anything else

Every failure path in the employer flow logs with an `[employers]` prefix,
including cookie-write failures, which are no longer swallowed. Check the server
log before reading code — the two bugs found so far were both silent in the UI and
explicit in the log.

## Still missing

- **No admin view of accounts.** `employers` and `contact_reveals` are readable
  only with the service role, i.e. through the Supabase dashboard. There is no
  moderation UI, no way to disable an account in-product, and no way to answer a
  job seeker's "who has my details?" without running SQL.
- **No email change flow.** An employer who mistypes their address must register
  again with the correct one; the wrong one stays as an unverified account.
- **`ONLINE_ONLY` still breaks e2e.** These flows need real Supabase Auth, so they
  cannot be exercised in the mock/memory e2e mode at all — the unit tests cover
  the pure policy only.
