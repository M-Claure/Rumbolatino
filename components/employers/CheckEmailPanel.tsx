"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, resendEmployerVerification } from "@/lib/client/api";

/**
 * "Revisa tu correo" — the dead end that has to feel like a step.
 *
 * After registering, the account exists but nothing can be done with it until a
 * link is opened in a different application. That is a hard stop for the tab the
 * person is in, so this screen states it plainly, shows the address so a typo is
 * visible immediately, and offers the single useful action.
 *
 * ── The cooldown is UX, not a control ───────────────────────────────────────
 * The real ceilings are server-side: `employer_email` (6/hour, the tightest
 * limit in the product) and Supabase's own send limits under it. Sixty seconds
 * here just stops someone pressing the button four times while the first message
 * is still in flight and then being locked out of the flow they are trying to
 * complete. Anything that pretends to be security in a client component is not.
 */
const COOLDOWN_SECONDS = 60;

export function CheckEmailPanel({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = useCallback(async () => {
    // Guard the handler as well as the disabled attribute: a double-submit can
    // land between the click and the re-render, and `disabled` alone has lost
    // that race before.
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await resendEmployerVerification(email);
      setNotice("Te enviamos el enlace otra vez. Puede tardar un par de minutos en llegar.");
      setCooldown(COOLDOWN_SECONDS);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "No pudimos enviar el correo. Vuelve a intentarlo en un momento.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, cooldown, email]);

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-6">
      <h2 className="text-lg font-bold text-text-primary">Revisa tu correo</h2>

      <p className="text-sm leading-snug text-text-secondary">
        Enviamos un enlace de confirmación a{" "}
        <strong className="text-text-primary">{email}</strong>. Ábrelo para activar tu cuenta y
        entrar al directorio.
      </p>
      <p className="text-sm leading-snug text-text-secondary">
        Puedes abrirlo desde cualquier dispositivo — por ejemplo desde tu teléfono. Si no lo ves
        en unos minutos, revisa tu carpeta de spam o de correo no deseado.
      </p>

      {notice && (
        <p className="rounded-xl border border-border bg-panel px-4 py-3 text-sm text-text-primary">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={resend}
        disabled={busy || cooldown > 0}
        className="inline-flex w-full items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover disabled:opacity-60"
      >
        {busy
          ? "Enviando…"
          : cooldown > 0
            ? `Puedes reenviarlo en ${cooldown} s`
            : "Enviar el enlace otra vez"}
      </button>

      {/*
        `aria-live` so the countdown and the confirmation are announced. A screen
        reader user pressing a button that then says "Puedes reenviarlo en 59 s"
        gets no feedback at all otherwise.
      */}
      <span className="sr-only" aria-live="polite">
        {notice ?? error ?? ""}
      </span>

      <p className="text-sm text-text-secondary">
        ¿Ya confirmaste tu correo?{" "}
        <a href="/empleadores/acceso" className="font-medium text-accent-dark hover:underline">
          Entra a tu cuenta
        </a>
      </p>
    </div>
  );
}
