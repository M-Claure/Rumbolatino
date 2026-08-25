import "server-only";
import { LogMailSender } from "./log-sender";
import type { MailSender } from "./types";

export type { MailMessage, MailSender } from "./types";

/**
 * The configured sender.
 *
 * ── NO LONGER ON THE AUTHENTICATION PATH ────────────────────────────────────
 * Nothing in the authentication flow calls this. Confirmation and password
 * recovery emails are composed, addressed and SENT BY SUPABASE, which delivers
 * them through Resend as Custom SMTP. That is deliberate: it puts the tokens,
 * their lifetimes and their single-use enforcement inside GoTrue instead of
 * inside this repo. See `AUTH_PRODUCTION_SETUP.md`.
 *
 * So the absence of a transport here is no longer a launch blocker — it is just
 * an unused seam. `LogMailSender` remains the only implementation.
 *
 * ── What it is still FOR ────────────────────────────────────────────────────
 * The one email this product may still want to send itself is the talent
 * directory's manage link (see the "Still missing" note in CLAUDE.md), which is
 * not an auth email and which Supabase will never send: it goes to a job
 * seeker who has no account. That is the reason to keep the seam rather than
 * delete it — adding a transport stays one file plus one line here.
 *
 * ── Why the SEAM survived the provider ──────────────────────────────────────
 * `MailSender` is four lines and every caller is written against it, so adding a
 * transport is one new file plus one line here — no route, service or template
 * changes. Deleting the interface along with the provider would have pushed
 * `fetch` calls back into the service, which is what made the original delivery
 * problem hard to see.
 */
let sender: MailSender | null = null;

export function getMailSender(): MailSender {
  if (!sender) sender = new LogMailSender();
  return sender;
}
