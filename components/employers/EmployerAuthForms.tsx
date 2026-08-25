"use client";

import { useRef, useState } from "react";
import {
  ApiError,
  registerEmployer,
  requestEmployerPasswordReset,
  signInEmployer,
} from "@/lib/client/api";
import {
  EMAIL_REJECTION_MESSAGES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULE_TEXT,
  inspectEmployerEmail,
  inspectPassword,
} from "@/lib/employers/policy";

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
 * ── "Check your email" is a ROUTE now, not a panel here ─────────────────────
 * It used to be a fourth panel. It is a page — `/empleadores/verifica-tu-correo`
 * — because registration ends somewhere the person cannot act: the next step
 * happens in a different application, often on a different device. A URL they
 * can reload and come back to survives that; a state flag in this component does
 * not.
 *
 * ── Validation happens here AND on the server ───────────────────────────────
 * The rules come from `lib/employers/policy.ts`, which is pure and shared, so
 * the message a user sees before submitting is the same string the server would
 * have sent back. This is purely to save a round trip and an error banner —
 * `registerEmployer` re-checks everything, and Supabase checks the password
 * again after that.
 */
type Panel = "signin" | "signup" | "reset" | "sent";

const field =
  "mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent";
const primary =
  "inline-flex w-full items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover disabled:opacity-60";
const link = "font-medium text-accent-dark hover:underline";

export function EmployerAuthForms({
  initialNotice,
  initialPanel,
}: {
  initialNotice?: string;
  initialPanel?: Panel;
}) {
  const [panel, setPanel] = useState<Panel>(initialPanel ?? "signin");
  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);

  /**
   * A ref as well as the `busy` state, because they answer different questions.
   * `busy` drives the disabled attribute on the next render; this blocks a
   * second submit that arrives BEFORE that render — a double-click, or Enter
   * held down — which `disabled` alone has always lost.
   */
  const inFlight = useRef(false);

  /** One place to run a call: clears the last error, and never leaves `busy` stuck. */
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** Shared pre-flight. Returns the normalized address, or null after showing why not. */
  function acceptEmail(): string | null {
    const verdict = inspectEmployerEmail(email);
    if (verdict.rejection) {
      setError(EMAIL_REJECTION_MESSAGES[verdict.rejection]);
      return null;
    }
    return verdict.normalized;
  }

  /** A full navigation, never a router push: the session lives in a cookie the server must read. */
  function goTo(path: string) {
    window.location.assign(path);
  }

  const submitSignIn = () =>
    run(async () => {
      const result = await signInEmployer({ email, password });
      if (result.status === "unverified") {
        goTo(`/empleadores/verifica-tu-correo?correo=${encodeURIComponent(result.email)}`);
        return;
      }
      goTo("/empleadores");
    });

  const submitSignUp = () =>
    run(async () => {
      const normalized = acceptEmail();
      if (!normalized) return;
      const problem = inspectPassword(password);
      if (problem) {
        setError(problem.message);
        return;
      }
      const result = await registerEmployer({ company, contactName, email: normalized, password });
      goTo(`/empleadores/verifica-tu-correo?correo=${encodeURIComponent(result.email)}`);
    });

  const submitReset = () =>
    run(async () => {
      const normalized = acceptEmail();
      if (!normalized) return;
      await requestEmployerPasswordReset(normalized);
      setPanel("sent");
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

      {panel === "sent" && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-bold text-text-primary">Revisa tu correo</h2>
          {/*
            Deliberately conditional wording. Saying "te enviamos un enlace"
            outright would confirm that this address has an account here, which
            is the one thing every response in this flow refuses to disclose.
          */}
          <p className="text-sm leading-snug text-text-secondary">
            Si <strong>{email}</strong> tiene una cuenta, ahí llegará un enlace para elegir una
            contraseña nueva. El enlace caduca, así que úsalo pronto.
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

          {panel === "signup" && (
            <p className="text-xs leading-snug text-text-secondary">
              Te enviaremos un correo para confirmar tu dirección. Tendrás que abrir ese enlace
              antes de ver el directorio.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              type="button"
              className={link}
              onClick={() => {
                setError(null);
                setNotice(null);
                setPanel(panel === "signin" ? "signup" : "signin");
              }}
            >
              {panel === "signin" ? "No tengo cuenta" : "Ya tengo cuenta"}
            </button>
            {panel === "signin" && (
              <button
                type="button"
                className={link}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setPanel("reset");
                }}
              >
                ¿Olvidaste tu contraseña?
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
