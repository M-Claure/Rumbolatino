import type { MailMessage } from "./types";

/**
 * The messages this product sends, as pure functions.
 *
 * No I/O, no env, no `server-only`: a template is a string transformation, and
 * keeping it pure is what lets `tests/unit/mail-templates.test.ts` assert the
 * things that actually go wrong — a link that lost its token, a body that leaked
 * a password, an expiry the copy contradicts.
 *
 * ── Both bodies are always built ────────────────────────────────────────────
 * `text` is not a courtesy. Sending HTML alone is one of the strongest spam
 * signals there is, and this is the one message the whole employer flow depends
 * on arriving; some corporate clients also strip HTML entirely, and a recipient
 * who sees an empty message cannot complete a sign-up. The plain-text part
 * carries the same link, unshortened, so it works when nothing renders.
 *
 * ── No images, no tracking, no external assets ──────────────────────────────
 * A remote image is a read receipt on a person's mailbox and another reason to
 * be filtered. These emails are text and one link.
 */

export interface BrandedEmail {
  /** Brand display name, e.g. "Rumbo Latino". */
  readonly brandName: string;
  /** Accent colour as a CSS value, for the button. */
  readonly accent: string;
  /** Contrasting text colour to sit on `accent`. */
  readonly accentText: string;
}

/**
 * Escape everything interpolated into the HTML body.
 *
 * The company name and the person's own name reach these templates from a
 * registration form. Unescaped, `Empresa <script>` in a company field would be
 * markup in whatever inbox opens it — and mail clients are a rendering surface we
 * do not control and cannot add a CSP to.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One shared shell, so every message looks like it came from the same product. */
function layout(brand: BrandedEmail, heading: string, bodyHtml: string): string {
  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;`,
    `max-width:32rem;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">`,
    `<p style="font-size:14px;font-weight:700;margin:0 0 24px;color:${brand.accent}">`,
    `${escapeHtml(brand.brandName)}</p>`,
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    `<p style="font-size:12px;color:#666;margin-top:32px;border-top:1px solid #e5e5e5;padding-top:16px">`,
    `Si no esperabas este mensaje, puedes ignorarlo.</p>`,
    `</div>`,
  ].join("");
}

function button(brand: BrandedEmail, url: string, label: string): string {
  // A table-free inline-block anchor: enough for every modern client, and the
  // plain-text part is the fallback for the ones that mangle it.
  return (
    `<p style="margin:24px 0"><a href="${escapeHtml(url)}" ` +
    `style="display:inline-block;background:${brand.accent};color:${brand.accentText};` +
    `text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">` +
    `${escapeHtml(label)}</a></p>`
  );
}

/**
 * The link is repeated as plain text under every button.
 *
 * Mail clients rewrite, wrap and sometimes break anchors, and this link is the
 * only way forward — so it is always visible in a form the recipient can copy by
 * hand.
 */
function fallbackLink(url: string): string {
  return (
    `<p style="font-size:13px;color:#666;word-break:break-all">` +
    `O copia y pega esta dirección en tu navegador:<br>${escapeHtml(url)}</p>`
  );
}

export function verifyEmailMessage(input: {
  brand: BrandedEmail;
  to: string;
  contactName: string;
  verifyUrl: string;
  expiresInHours: number;
}): MailMessage {
  const { brand, verifyUrl, expiresInHours } = input;
  const heading = "Confirma tu correo";
  const intro =
    `Hola ${input.contactName}: para entrar al directorio de talento de ` +
    `${brand.brandName}, confirma que este correo es tuyo.`;
  const expiry = `El enlace funciona una sola vez y caduca en ${expiresInHours} horas.`;

  return {
    to: input.to,
    // The From line carries the brand; one verified domain serves both.
    fromName: brand.brandName,
    // No brand prefix in the subject: inboxes already show the sender, and
    // "[Rumbo Latino] …" reads like a newsletter, which is where filters put it.
    subject: "Confirma tu correo para ver el directorio",
    html: layout(
      brand,
      heading,
      `<p>${escapeHtml(intro)}</p>` +
        button(brand, verifyUrl, "Confirmar mi correo") +
        `<p style="font-size:13px;color:#666">${escapeHtml(expiry)}</p>` +
        fallbackLink(verifyUrl),
    ),
    text: [heading, "", intro, "", verifyUrl, "", expiry].join("\n"),
  };
}

export function resetPasswordMessage(input: {
  brand: BrandedEmail;
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}): MailMessage {
  const { brand, resetUrl, expiresInMinutes } = input;
  const heading = "Cambia tu contraseña";
  const intro =
    `Pediste cambiar la contraseña de tu cuenta de empresa en ${brand.brandName}. ` +
    `Elige una nueva desde aquí.`;
  const expiry =
    `El enlace funciona una sola vez y caduca en ${expiresInMinutes} minutos. ` +
    `Si no fuiste tú, tu contraseña sigue igual y no hace falta que hagas nada.`;

  return {
    to: input.to,
    fromName: brand.brandName,
    subject: "Cambia tu contraseña",
    html: layout(
      brand,
      heading,
      `<p>${escapeHtml(intro)}</p>` +
        button(brand, resetUrl, "Elegir nueva contraseña") +
        `<p style="font-size:13px;color:#666">${escapeHtml(expiry)}</p>` +
        fallbackLink(resetUrl),
    ),
    text: [heading, "", intro, "", resetUrl, "", expiry].join("\n"),
  };
}

/**
 * Sent when someone registers with an address that already has an account.
 *
 * ── Why an email and not an error on screen ─────────────────────────────────
 * "Ya existe una cuenta con ese correo" on the form is an account-existence
 * oracle: it lets anyone test addresses against this directory's customer list.
 * The registration response is therefore identical either way, which leaves a
 * real person who forgot they had signed up with no explanation — so the
 * explanation goes to the mailbox, where only the actual owner can read it.
 */
export function accountExistsMessage(input: {
  brand: BrandedEmail;
  to: string;
  signInUrl: string;
  resetUrl: string;
}): MailMessage {
  const { brand } = input;
  const heading = "Ya tienes una cuenta";
  const intro =
    `Alguien intentó crear una cuenta de empresa en ${brand.brandName} con este ` +
    `correo, y ya existe una. No creamos ninguna cuenta nueva.`;
  const help = "Puedes entrar con tu contraseña, o pedir una nueva si no la recuerdas.";

  return {
    to: input.to,
    fromName: brand.brandName,
    subject: "Ya tienes una cuenta de empresa",
    html: layout(
      brand,
      heading,
      `<p>${escapeHtml(intro)}</p><p>${escapeHtml(help)}</p>` +
        button(brand, input.signInUrl, "Entrar a mi cuenta") +
        `<p style="font-size:13px"><a href="${escapeHtml(input.resetUrl)}" style="color:#666">` +
        `Olvidé mi contraseña</a></p>`,
    ),
    text: [heading, "", intro, help, "", `Entrar: ${input.signInUrl}`, `Cambiar contraseña: ${input.resetUrl}`].join("\n"),
  };
}
