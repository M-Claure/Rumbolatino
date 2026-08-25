/**
 * The mail seam.
 *
 * Pure types, no I/O, no `server-only` — so templates and tests can build a
 * message without pulling in a provider or the env schema.
 */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /** Both bodies are REQUIRED. See the note in `templates.ts`. */
  readonly html: string;
  readonly text: string;
  /**
   * Display name for the From line — the BRAND, not the company that owns the
   * mailbox.
   *
   * One sending domain serves both brands, because Rumbo Latino is an Aprende
   * product rather than a separate company and has no mailbox of its own. The
   * address is therefore fixed configuration and the name travels with the
   * message, so a Rumbo Latino email does not arrive signed "Aprende Institute"
   * over a body that says Rumbo Latino — a mismatch recipients read as phishing.
   */
  readonly fromName?: string;
}

/**
 * One method, deliberately.
 *
 * No queue, no scheduling, no templating in the interface. Every message this
 * product sends is a transactional message a person is waiting for, so there is
 * nothing to batch and nothing to defer — and a queue we cannot observe would
 * only turn "the email never arrived" from a visible failure into an invisible
 * one, which is the exact failure mode that made Supabase's sender unusable.
 *
 * Resolves on accepted-for-delivery. THROWS on anything else, so a caller can
 * tell the user the truth instead of "revisa tu correo".
 *
 * NOTE: no transport currently implements this beyond `LogMailSender`, so nothing
 * is delivered today. See `lib/mail/index.ts`.
 */
export interface MailSender {
  /** Human-readable, for logs and the startup banner. */
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}
