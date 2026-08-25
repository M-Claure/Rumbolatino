# Employer accounts

The talent directory is gated. An employer registers with their name, company and
email, confirms that address, and only then sees a candidate. This file is the
reasoning behind the shape.

**For configuration — dashboard settings, SMTP, DNS, the testing checklist and
rollback — see [`AUTH_PRODUCTION_SETUP.md`](../AUTH_PRODUCTION_SETUP.md).** For
the email bodies, see [`auth-email-templates.md`](./auth-email-templates.md).

## What is gated

| Surface | Before | Now |
| --- | --- | --- |
| `/empleadores/acceso` | did not exist | **public, indexable** — the front door |
| `/empleadores/verifica-tu-correo` | did not exist | `noindex` — the check-your-email screen |
| `/empleadores` | public, indexable | verified session, `noindex` |
| `/talento/[slug]` | public, `noindex` | verified session, `noindex` |
| `GET /api/talent/search` | public | 401 without a session |
| `GET /api/talent/:slug/resume` | public | 401 without a session |
| `GET /api/talent/:slug/resume?inline=1` | did not exist | 401 without a session — the preview frame |

Both modes of the résumé route are the **same disclosure**, so they are gated,
counted and audited identically — a preview spends a `contact_reveal` and writes a
`contact_reveals` row exactly as a download does. Reading in place is offered
first because it is the option that leaves no copy behind: a PDF on somebody's
laptop outlives the session, the listing and any later decision to unpublish, and
an employer comparing six candidates only wanted one of them. See
`components/talent/ResumePreview.tsx` and `lib/talent/resume-delivery.ts`.

The indexable surface **moved** rather than disappearing. A gated page cannot be
crawled — a crawler has no account — and a login wall in a search index is worse
than useless, so `/empleadores/acceso` describes the service, lists nobody, and is
the page Google sees. Individual profiles were already `noindex` and stay that way.

## Authentication is Supabase's, end to end

**Supabase Auth owns all of it**: the account, password hashing, sessions, refresh
tokens, the confirmation email, the recovery email and the tokens inside them.
This application issues no credential of its own. Delivery is **Resend, configured
as Supabase Custom SMTP** — this codebase never calls Resend.

### This reverses an earlier decision, and the reversal is deliberate

An earlier version of this document argued the opposite, and it was right at the
time. Verification was moved **off** GoTrue because it could not be shipped on it:

- the built-in sender is capped at a handful of messages an hour and only
  delivers to addresses inside your Supabase organisation. Every other sign-up
  produced a cheerful "revisa tu correo" and an empty inbox, **with no error
  anywhere** — `signUp` returned success and the message was dropped downstream;
- a PKCE confirmation link only worked in the browser that signed up, which is
  the wrong browser for most of this audience: they register on a shop computer
  and read mail on a phone.

Both are now answered:

- **Resend as Custom SMTP** replaces the built-in sender entirely, along with its
  caps and its silent drops.
- **`token_hash` links to `/auth/confirm`** are verified server-side with
  `verifyOtp`, carry no PKCE verifier, and work on any device.

Neither was true when the custom tokens were written. What the switch buys is not
just less code: reset-token generation, single-use enforcement, expiry and replay
protection stop being ours to get right, and the password change no longer needs
`auth.admin.updateUserById` — an API that will change *any* user's password and
was previously guarded only by our own token check running first.

**Consequence: Supabase's "Confirm email" must be ON.** That is the reverse of
what migration `0013` required. With it on, `signUp` returns no session and
`signInWithPassword` refuses an unconfirmed address, so the confirmation is
enforced by GoTrue rather than only by our gate.

### The retired token machinery is still here

`lib/employers/tokens.ts`, `employer_email_tokens` and
`mcv_consume_employer_token` are unused and deliberately retained. They are the
**rollback**: reverting the switch restores a working flow with no database
migration and no data loss. Delete all three together, once native delivery has
been observed in production.

## How the pieces fit

```
/empleadores/acceso                     the only public page
   │  POST /api/employers/registro      signUp(emailRedirectTo, metadata)
   │                                      → employers row (service role)
   │                                      → Supabase sends the confirmation
   ▼
/empleadores/verifica-tu-correo         "revisa tu correo", 60 s resend cooldown
   │                                      POST /api/employers/reenviar → auth.resend()
   ▼
(email) → /auth/confirm?token_hash=…&type=signup
   │        verifyOtp → session on THIS response → mirror employers.email_verified_at
   ▼                    (works in any browser, on any device)
/empleadores, /talento/[slug]           gated
/api/talent/*                           gated JSON + PDF

reset:  POST /api/employers/recuperar   → auth.resetPasswordForEmail()
        → /auth/confirm?token_hash=…&type=recovery
        → /empleadores/nueva-contrasena  requires the recovery session
        → POST /api/employers/contrasena → auth.updateUser({ password })
```

- `lib/employers/policy.ts` — pure rules for addresses and passwords.
- `lib/employers/session.ts` — the gate, and the two client factories.
- `lib/employers/auth-callback.ts` — what both callbacks share.
- `lib/auth-redirect.ts` — the open-redirect guard. Pure, allow-listed, tested.
- `lib/services/employer-account.ts` — the flows, and GoTrue error translation.
- `lib/repositories/employer-store.ts` — `employers`, service-role only.
- `lib/employers/tokens.ts`, `lib/mail/` — **retired**; see above.

`/empleadores/verificar` and `/empleadores/recuperar/confirmar` survive as
forwarding shims, so links already sitting in mailboxes land somewhere sensible.

## Troubleshooting

The full table is in
[`AUTH_PRODUCTION_SETUP.md` § J](../AUTH_PRODUCTION_SETUP.md#j-rollback-and-troubleshooting).
The three that come up most:

**No email arrives.** Custom SMTP is not configured, so Supabase's built-in sender
is still in use and only delivers inside your Supabase organisation. Check Resend
→ Logs: no entry at all means Supabase never handed the message over.

**The link works in one browser but not another.** The stock
`{{ .ConfirmationURL }}` template is still in place, which is the PKCE flow. Paste
the `token_hash` templates.

**A verified employer is bounced back to the sign-in page.**
`SUPABASE_SERVICE_ROLE_KEY` is not set. `employers` has RLS on with no policies,
so only the service role can reach it. The gate returns `misconfigured` and the
page renders `DirectoryUnavailable` ("es un problema de nuestro lado") rather than
a login prompt; the specifics are in the log. API routes answer 503, not 401. On
Vercel, Preview and Production have separate environment variables.

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
way five Rumbo Latino colour pairs sit below WCAG AA on purpose. The dashboard is
the authority; `lib/employers/policy.ts` mirrors it so the rejection arrives in
Spanish naming every missing class at once, instead of in English. Change both
together.

**Free webmail is accepted; disposable inboxes are not.** The employers this
directory exists for are small local businesses, many with no domain at all.
Requiring a company domain would gate out the demand side of the marketplace to
buy a signal the confirmation link already provides. Throwaway domains are refused
because a mailbox someone held for ten minutes is not an accountable party, and it
makes `contact_reveals` worthless as a record. The blocklist is a speed bump, not
a wall — new throwaway domains appear daily. `guest.invalid` is on it so a job
seeker's provisioned guest identity can never become an employer.

**Registration answers identically whether or not the address is taken.**
"Ya existe una cuenta con ese correo" on the form lets anyone test addresses
against this directory's customer list. With confirmation on, Supabase declines to
say so too: it returns a user-shaped object with a randomised id and an **empty
`identities` array**. `isExistingAccount` reads exactly that, and the response is
the same either way.

Detecting it is not only about disclosure — the `employers` row must not be
written from that object. The id is not a real `auth.users` row, so the write
would either fail the foreign key or, if Supabase ever returned the genuine id,
overwrite a stranger's company name with whatever this caller typed.

An earlier version emailed the existing account holder a "you already have an
account" message. That is gone with our mail transport. Someone who forgot they
had registered finds their way back through "¿Olvidaste tu contraseña?", which
exists for exactly that and discloses nothing either.

**Sign-in reports `unverified` without leaking anything.** GoTrue verifies the
**password before** it checks confirmation state, so `email_not_confirmed` only
ever reaches someone who already supplied the correct password for that address.
They have proved more than the account's existence. Every other credential
failure — no such user, wrong password — is one generic sentence.

**The gate reads `auth.users.email_confirmed_at`, not our column.** That is the
reverse of the previous design, and it follows from the reversal above: GoTrue
sets that column, only a real confirmation sets it, and no code here can forge it.
`employers.email_verified_at` is kept as a **mirror** — it is what operators
query and what the reveal audit reads alongside — and the gate repairs it when it
has fallen behind, but never depends on that write succeeding. An employer who has
proved their mailbox must not be locked out by a failed bookkeeping update.

**The gate has FOUR outcomes: `ok`, `anonymous`, `unverified`, `misconfigured`.**
Collapsing the last two cost real debugging time once — a deployment with no
service-role key told verified employers to "entra con tu cuenta de empresa",
advice they could not act on, while the actual fault sat in an unread log. Each
one has a different fix, so each gets its own message, the same way
`Errors.rateLimited` and `Errors.budgetExhausted` are separate codes.

`unverified` is now nearly unreachable — GoTrue issues no session before
confirmation — and it is kept precisely for the cases where it is not: a session
minted while the setting was off, an account whose address was changed, or the
setting being turned off by mistake. Defence in depth, not dead code.

**The session is a function PARAMETER, not a lookup.** `searchDirectory`,
`searchDirectorySafely` and `readPublicProfile` all take an `EmployerSession`.
Only the gate can produce one, so a new caller that skips the check is a compile
error rather than something review has to catch.

**`getUser()`, never `getSession()`.** It revalidates the token against the auth
server, so a revoked or tampered session is refused rather than trusted because a
cookie parsed cleanly. This is what makes "sign out user" in the Supabase
dashboard actually end a session.

**Callbacks write cookies onto the response they return.**
`employerClientForRoute` binds the Supabase cookie sink to the redirect being
constructed. Writing through `next/headers` instead relies on Next.js merging
those mutations into a handler-built response, and when that does not happen the
failure is the worst possible shape: the exchange succeeds, Supabase marks the
address confirmed, and the browser receives no session — so the employer clicks
the link, lands on the directory, is bounced to the login page, and nothing says
why. This was got wrong twice before it was written down.

**`?next=` is allow-listed, not merely required to be relative.** The callbacks
take a destination from the URL and act on it immediately *after* minting a
session, and that value arrives from an email template edited in a dashboard,
outside code review. `safeNextPath` rejects absolute URLs, scheme-relative
`//host`, the `/\host` variants browsers normalise back into them, traversal, and
control characters — then checks the normalised path against a short list of
employer paths. "Same-origin" would not be enough: it still covers `/api/…`,
where a redirect performs an action.

**Verification creates a session; the link is the proof.** This changed with the
switch, and it is worth being explicit. The old flow deliberately did *not* sign
anyone in from a link, on the grounds that forwarding the email would then be
equivalent to handing over the account. Supabase's `verifyOtp` mints a session,
and that is the standard behaviour of every confirmation link on the web: the
recipient of the mailbox is the account holder. Forwarding a confirmation email is
now equivalent to forwarding a password reset — which was already true of the
reset link in the old design.

**Sign-out is `scope: "local"`.** It clears this browser's session only. `global`
would revoke every refresh token for the account, so pressing "Salir" on a shared
office machine would sign the person out of their phone as well.

**Rate limits.** `employer_email` (6/hour) is the tightest limit in the product,
because each hit causes mail to be sent from our domain to an address the caller
typed — loose limits there are a way to mail-bomb a third party and to burn the
sending reputation the whole flow depends on. `employer_login` is 20/hour and
`employer_register` 10/hour, both keyed by IP because those routes run before
there is a session to attribute. Supabase enforces its own send limits underneath,
which is a backstop and not a substitute. `directory_search` and `contact_reveal`
are keyed by the **account**, so changing networks no longer resets them.

The 60-second cooldown on the resend button is **UX, not a control** — it stops
someone pressing it four times while the first message is in flight and then being
locked out of the flow they are trying to complete. Anything that pretends to be
security in a client component is not.

## Still missing

- **CAPTCHA is not configured, and enabling it in the dashboard alone will break
  sign-up.** With Supabase Attack Protection on, GoTrue requires a `captchaToken`
  on every `signUp`, `signInWithPassword`, `resend` and `resetPasswordForEmail`,
  and this app sends none. It is a code change as well as a setting — see
  `AUTH_PRODUCTION_SETUP.md` § H.
- **No admin view of accounts.** `employers` and `contact_reveals` are readable
  only with the service role, i.e. through the Supabase dashboard. There is no
  moderation UI, no way to disable an account in-product, and no way to answer a
  job seeker's "who has my details?" without running SQL.
- **No email change flow.** An employer who mistypes their address must register
  again; the wrong one stays as an unconfirmed account. Note the loose end before
  building it: nothing mirrors a changed address onto `employers.email`, so the
  reveal audit would name an address the person no longer uses.
- **No bounce or complaint handling.** Resend records them, but nothing here
  reads that back — an address that permanently rejects mail keeps being retried,
  which quietly damages the sending reputation the whole flow depends on.
- **No unsubscribe or preference handling**, which is correct for purely
  transactional mail and becomes required the moment any of these messages turns
  into marketing. Do not add a newsletter to this sender.
- **One SMTP sender identity for two brands.** Supabase has one per project, so
  an employer arriving from an Aprende host receives a confirmation signed "Rumbo
  Latino". Decide before the Aprende domain goes live — accept it, use neutral
  copy, or run a second project.
- **Sign-in still can't be exercised in e2e.** The mock/memory e2e mode has no
  Supabase Auth, so the covered surface is the unit tests: the policy rules, the
  redirect guard, the Supabase seams, and the retired token lifecycle against
  `MemoryEmployerStore`. The rest is the manual checklist in
  `AUTH_PRODUCTION_SETUP.md` § I, which needs a real project and a real mailbox.
