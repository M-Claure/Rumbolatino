"use client";

import { useState } from "react";
import {
  ApiError,
  registerEmployer,
  requestEmployerPasswordReset,
  resendEmployerVerification,
  signInEmployer,
} from "@/lib/client/api";
import { MIN_PASSWORD_LENGTH, PASSWORD_RULE_TEXT } from "@/lib/employers/policy";

/**
 * The only sign-in surface in the product.
 *
 * ── Three panels, one component ─────────────────────────────────────────────
 * Sign in, register, and "email me a reset link" are one screen with a switch
 * rather than three routes, because the person arriving does not always know
 * which one they need — someone who registered a week ago and forgot may try all
 * three. Keeping them together means switching costs no page load and the email
 * they already typed follows them across.
 *
 * ── Why the "check your inbox" state is a panel, not a redirect ─────────────
 * After registering, the account exists but cannot be used until a link is
 * clicked in another application. That is a dead end for the tab they are in, so
 * it has to say so plainly and offer the one useful action (send it again).
 * Redirecting to the directory would show them a login wall a second time with
 * no explanation.
 */
type Panel = "signin" | "signup" | "reset" | "sent" | "check_inbox";

const field =
  "mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent";
const primary =
  "inline-flex w-full items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover disabled:opacity-60";
const link = "font-medium text-accent-dark hover:underline";

export function EmployerAuthForms({ initialNotice }: { initialNotice?: string }) {
  const [panel, setPanel] = useState<Panel>("signin");
  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);

  /** One place to run a call: clears the last error, and never leaves `busy` stuck. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Algo salió mal. Vuelve a intentarlo en un momento.",
      );
    } finally {
      setBusy(false);
    }
  }

  const submitSignIn = () =>
    run(async () => {
      const result = await signInEmployer({ email, password });
      if (result.status === "unverified") {
        setPanel("check_inbox");
        setNotice(
          "Tu cuenta existe, pero todavía no confirmaste tu correo. Busca el mensaje que te enviamos.",
        );
        return;
      }
      // A full navigation, not a router push: the session arrived as a cookie on
      // this response, and the gated page has to be rendered by the server with
      // it already in place.
      window.location.assign("/empleadores");
    });

  const submitSignUp = () =>
    run(async () => {
      await registerEmployer({ company, contactName, email, password });
      setPanel("check_inbox");
    });

  const submitReset = () =>
    run(async () => {
      await requestEmployerPasswordReset(email);
      setPanel("sent");
    });

  const resend = () =>
    run(async () => {
      await resendEmployerVerification(email);
      setNotice("Te enviamos el enlace otra vez. Puede tardar un par de minutos.");
    });

  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      {notice && (
        <p className="mb-4 rounded-xl border border-border bg-panel px-4 py-3 text-sm text-text-primary">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      {panel === "check_inbox" && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-bold text-text-primary">Revisa tu correo</h2>
          <p className="text-sm leading-snug text-text-secondary">
            Enviamos un enlace a <strong>{email}</strong>. Ábrelo para confirmar tu cuenta y entrar
            al directorio. Si no aparece, revisa tu carpeta de spam.
          </p>
          <button type="button" onClick={resend} disabled={busy} className={primary}>
            {busy ? "Enviando…" : "Enviar el enlace otra vez"}
          </button>
          <button type="button" onClick={() => setPanel("signin")} className={`text-sm ${link}`}>
            Volver a entrar
          </button>
        </div>
      )}

      {panel === "sent" && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-bold text-text-primary">Enlace enviado</h2>
          <p className="text-sm leading-snug text-text-secondary">
            Si <strong>{email}</strong> tiene una cuenta, ahí llegará un enlace para cambiar tu
            contraseña.
          </p>
          <button type="button" onClick={() => setPanel("signin")} className={`text-sm ${link}`}>
            Volver a entrar
          </button>
        </div>
      )}

      {(panel === "signin" || panel === "signup") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (panel === "signin") submitSignIn();
            else submitSignUp();
          }}
          className="flex flex-col gap-3"
        >
          <h2 className="text-lg font-bold text-text-primary">
            {panel === "signin" ? "Entra a tu cuenta" : "Crea tu cuenta de empresa"}
          </h2>

          {panel === "signup" && (
            <>
              <label className="block">
                <span className="text-sm font-semibold text-text-primary">Tu nombre</span>
                <input
                  className={field}
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  autoComplete="name"
                  maxLength={120}
                  required
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-text-primary">Empresa</span>
                <input
                  className={field}
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  autoComplete="organization"
                  maxLength={120}
                  required
                />
              </label>
            </>
          )}

          <label className="block">
            <span className="text-sm font-semibold text-text-primary">Correo</span>
            <input
              className={field}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              maxLength={160}
              required
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-text-primary">Contraseña</span>
            <input
              className={field}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // `new-password` on the register panel so a password manager offers
              // to generate one instead of filling an old one in.
              autoComplete={panel === "signup" ? "new-password" : "current-password"}
              minLength={panel === "signup" ? MIN_PASSWORD_LENGTH : undefined}
              required
            />
            {/*
              The full rule, stated BEFORE they type rather than after a rejected
              attempt. Supabase enforces the character classes server-side, so a
              hidden rule costs a round trip and an error message every time.
            */}
            {panel === "signup" && (
              <span className="mt-1 block text-xs text-text-secondary">{PASSWORD_RULE_TEXT}</span>
            )}
          </label>

          <button type="submit" disabled={busy} className={primary}>
            {busy ? "Un momento…" : panel === "signin" ? "Entrar" : "Crear cuenta"}
          </button>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              type="button"
              className={link}
              onClick={() => setPanel(panel === "signin" ? "signup" : "signin")}
            >
              {panel === "signin" ? "No tengo cuenta" : "Ya tengo cuenta"}
            </button>
            {panel === "signin" && (
              <button type="button" className={link} onClick={() => setPanel("reset")}>
                Olvidé mi contraseña
              </button>
            )}
          </div>
        </form>
      )}

      {panel === "reset" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitReset();
          }}
          className="flex flex-col gap-3"
        >
          <h2 className="text-lg font-bold text-text-primary">Cambiar tu contraseña</h2>
          <p className="text-sm leading-snug text-text-secondary">
            Escribe tu correo y te enviamos un enlace para elegir una nueva.
          </p>
          <label className="block">
            <span className="text-sm font-semibold text-text-primary">Correo</span>
            <input
              className={field}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              maxLength={160}
              required
            />
          </label>
          <button type="submit" disabled={busy} className={primary}>
            {busy ? "Enviando…" : "Enviarme el enlace"}
          </button>
          <button type="button" onClick={() => setPanel("signin")} className={`text-sm ${link}`}>
            Volver
          </button>
        </form>
      )}
    </div>
  );
}
