import "server-only";
import type { MailMessage, MailSender } from "./types";

/**
 * Writes the message to the server log instead of sending it.
 *
 * ── This is the ONLY sender in the repo right now ───────────────────────────
 * The real provider was removed, so this is not a development convenience any
 * more — it is the whole of email delivery. Nothing reaches a mailbox, which
 * means employer verification cannot complete without an operator stamping
 * `employers.email_verified_at` by hand.
 *
 * It logs at ERROR level in production for exactly that reason. A warning is the
 * right level for a deliberate local choice; when this is the only transport a
 * deployment has, a message that was supposed to reach a customer and did not is
 * an incident, and it should appear wherever errors are collected rather than
 * scrolling past in a log nobody reads. That silence is what made the original
 * Supabase mailer unshippable, and shipping our own quiet version would be worse
 * for having chosen it.
 *
 * It prints the whole body, including the link. That is the point — it is how you
 * complete a sign-up locally — and it is also why it must never run anywhere the
 * logs are shared.
 */
export class LogMailSender implements MailSender {
  readonly name = "log";

  async send(message: MailMessage): Promise<void> {
    const log = process.env.NODE_ENV === "production" ? console.error : console.warn;
    log(
      `\n[mail:log] NOT SENT — no mail transport is configured. Printing instead.\n` +
        `  to:      ${message.to}\n` +
        `  subject: ${message.subject}\n` +
        `${message.text
          .split("\n")
          .map((line) => `  | ${line}`)
          .join("\n")}\n`,
    );
  }
}
