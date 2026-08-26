# Deleting a résumé from Supabase

`scripts/delete-resume.ts` removes a résumé and everything that hangs off it —
the `funnel` row, its improvement rounds, its stored PDFs, its directory listing
and its contact details. It exists because there is **no delete path in the
product**: a job seeker has no account, no login and deliberately no recovery
flow, so nothing in the UI can retire a résumé, and a developer testing the funnel
accumulates rows and private-bucket PDFs with no way to clear them.

```bash
npm run resume:list                          # what is in there
npm run resume:delete                        # numbered list → type a number → confirm
npm run resume:delete -- --profile=8f3a      # by id; a prefix is enough
npm run resume:delete -- --user=alguien@correo.com
npm run resume:delete -- --all               # the whole project
npm run resume:orphans                       # PDFs whose funnel row is already gone
```

It talks to whatever `.env.local` points at, with the service-role key, so it
bypasses RLS entirely. **There is no undo.** The project host is printed before
anything happens and `--dry-run` prints the full plan without writing.

---

## What "everything" means

| Where | How it goes |
| --- | --- |
| `funnel` | deleted — the one row this is all keyed to |
| `iteration_1`, `iteration_2`, `iteration_3` | Postgres cascade |
| `talent_profiles` | Postgres cascade (`funnel_id` is `on delete cascade`) |
| `talent_contacts` | Postgres cascade, via `talent_profiles` |
| `resumes` bucket — `<user_id>/<funnel_id>/*.pdf` | **deleted explicitly** |
| `ai_spend` | **deleted explicitly** (unless `--keep-spend`) |
| `rate_limits` | deleted only with `--reset-limits` or `--delete-user` |
| `contact_reveals` | **left alone, on purpose** |
| `auth.users` | only with `--delete-user`, and only behind two guards |
| `employers` | never touched |

### Two things do not cascade, and both would be silent

**Storage.** Postgres does not cascade into Storage. Skipping the bucket leaves up
to four résumés' worth of PII — name, email, phone, work history — as orphaned
objects that no row names any more, in a bucket whose whole design is that only
the owner can read it. Nothing would ever surface them again.

**`ai_spend`.** Its FKs are `on delete set null`, not `cascade`, and
`0009_usage_limits.sql` says why in as many words: deleting a profile or a user
must not erase the record of money already spent, and must not silently reopen the
daily cap. That is right in production and wrong for a dev reset — a nulled row
still counts against `AI_SPEND_CAP_DAILY_USD` — so the script deletes them and
`--keep-spend` restores the production behaviour when you want the ledger intact.

### `contact_reveals` is deliberately kept

Its FKs are `set null` too, so the rows survive with the employer and profile
references blanked. They are not deleted, because they are the record that a named
employer downloaded a specific real person's contact details. That record is not
ours to erase along with the listing — it is the audit trail the reveal limit
exists to produce. If you are wiping a project to start over, delete the rows
yourself and know what you are deleting.

---

## Choosing what to delete

**Interactively** — `npm run resume:delete` with no arguments lists the 40 most
recent résumés, numbered, and asks. Answer with a number, several separated by
commas, `todos`, or Enter to walk away.

```
  # id        nombre                estado      cv      pdf  rondas  bolsa       gasto    creado
  1 ed5661db  Matias Claure         generating  v1/r0   0    0       —           —        2026-08-25
  2 86fafd6b  Miguel Castillo       generated   v1/r0   1    0       published   —        2026-08-25
```

The columns are the ones that tell you whether a row matters: `cv` is
`v<version>/r<round>` (or `—` for a résumé never generated), `pdf` is how many
objects are actually in the bucket, `rondas` counts `iteration_N` rows, `bolsa` is
the directory status, and `gasto` is the summed `ai_spend` estimate.

**`--profile=<id>`** takes an id **prefix** — the eight characters `--list` shows
are plenty — so nobody has to paste a UUID. Several are comma-separated. An
ambiguous prefix is an error naming the collisions, never a guess.

**`--user=<uuid|email>`** takes every résumé belonging to one identity. An email is
resolved against `auth.users`, which is how you find a guest whose only handle was
a cookie.

**`--all`** takes the whole project and always requires typing `BORRAR TODO`, even
with `--yes`. It is the one invocation that can empty a project, and one typed
phrase is cheap next to that.

### Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | print the plan, write nothing |
| `--yes`, `-y` | skip the confirmation (not honoured for `--all`) |
| `--delete-user` | also delete the `auth.users` identity; implies `--reset-limits` |
| `--keep-spend` | keep the `ai_spend` rows (they keep counting against the caps) |
| `--reset-limits` | delete this user's `rate_limits` counters |
| `--orphans` | sweep the bucket instead: see below |
| `--limit=<n>` | how many to list (default 40) |
| `--env=<file>` | another env file (default `.env.local`) |
| `--help`, `-h` | the same summary, in Spanish |

---

## Order of operations, and why it is that order

1. **The PDFs.** First, while the row that tells us who owns them still exists.
   The objects are **listed** from `<user_id>/<funnel_id>/` rather than assembled
   from the four canonical names, so an object written under a name this script
   does not know about is still removed instead of surviving forever in a private
   bucket. `resumePdfPath` for stages 0–3 is used only as a fallback when the list
   call itself fails, and a failure here warns loudly but does not stop the
   delete — the operator needs to know there are bytes left behind.
2. **`ai_spend`.** Before the row, because the FK is `set null`: afterwards the
   rows are still there and no longer say which résumé they belonged to.
3. **The `funnel` row.** Which cascades to the rounds, the listing and the
   contact.

## The guards

`--delete-user` deletes an `auth.users` row, and that cascades to **every**
`funnel` row the identity owns. So it refuses in three cases:

- **the user still owns other résumés** — otherwise a wipe of one résumé would
  silently take résumés nobody asked about;
- **the user has an `employers` row** — an employer account is a real credential
  with a confirmed mailbox behind it, and has nothing to do with the résumé being
  deleted;
- **the employer check itself failed** — an unreadable `employers` table means the
  guard cannot be evaluated, so the identity stays.

## Orphaned PDFs

`npm run resume:orphans` walks the `resumes` bucket, finds every
`<user_id>/<funnel_id>/` folder whose `funnel` row no longer exists, and offers to
delete what is in it. `--dry-run` lists without deleting; `--yes` skips the
question.

This is the cleanup for **rows deleted any other way** — a hand delete in the
Supabase dashboard being the usual one. Postgres does not cascade into Storage, so
what survives is a résumé PDF (a full name, an email, a phone and a work history)
in a private bucket that nothing references and no page can ever surface again.
Nothing else in the product will ever find those objects: the download path reads
`funnel.resume_pdf`, and that row is what was deleted.

Both projects had some when this was written, which is what prompted the mode. A
folder listing that comes back at its 1000-entry cap says so out loud rather than
reporting a partial sweep as a clean one.

It is also the check that tells you **what deleted a row**. This script always
removes the objects *before* the row, so a missing row whose PDF is still in the
bucket was deleted by something else.

## What it needs

`.env.local` (or `--env=`) must have `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Nothing else: the script runs outside Next, reads the
two variables with a five-line parser, and never loads `lib/env.ts` — so it works
against a project whose Azure or Amplitude configuration is missing or wrong.

**A project without `0009_usage_limits.sql` is normal and handled.** `ai_spend`
and `rate_limits` come back as `PGRST205` there; the script treats that as
"nothing to clean" and says so once in the plan, rather than printing warnings
nobody can act on. Any *other* error reading `ai_spend` warns loudly instead —
a spend row it cannot see is a spend row it will not delete, and a silent `$0`
would read as "there was nothing".

## Troubleshooting

**"Ningún curriculum empieza por …"** — the prefix matched nothing. Run
`npm run resume:list`; the id column is the first eight characters.

**"… coincide con N curriculums"** — an ambiguous prefix. Use more characters.

**"no borro la identidad, le quedan N curriculum(s)"** — `--delete-user` hit its
first guard. Either delete those too (`--user=<id>`) or drop the flag.

**"no pude borrar N PDF(s)"** — the row is gone and the objects are not. The paths
are in the warning; remove them from the Storage browser.

**The list is empty but you know there are résumés** — you are pointed at the
wrong project. The host is printed on the first line.

## What it does not do

- **No undo, and no soft delete.** Unpublishing a directory listing is a status
  change precisely so it can be reversed; this is not that.
- **It does not touch the `profile_create` rate limit**, which is keyed by IP
  rather than by user (`lib/rate-limit/policy.ts`), so a wipe does not hand that
  allowance back.
- **It is not a moderation tool.** To take a listing out of the directory while
  keeping the résumé, use the `unpublished` status — see
  [`../CLAUDE.md`](../CLAUDE.md) § Bolsa de Talento.
