"use client";

import { useState } from "react";
import { ApiError, setEmployerPassword } from "@/lib/client/api";
import { MIN_PASSWORD_LENGTH, PASSWORD_RULE_TEXT } from "@/lib/employers/policy";

/**
 * The second half of a password reset. The authority to do this is the session
 * the emailed link already exchanged itself for, which is why there is no
 * current-password field — the person here is the one who does not know it.
 */
export function NewPasswordForm() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await setEmployerPassword(password);
          // Full navigation: the sign-in page reads the session server-side.
          window.location.assign("/empleadores");
        } catch (err) {
          setError(
            err instanceof ApiError ? err.message : "No pudimos cambiar tu contraseña.",
          );
          setBusy(false);
        }
      }}
    >
      <h2 className="text-lg font-bold text-text-primary">Elige tu nueva contraseña</h2>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      <label className="block">
        <span className="text-sm font-semibold text-text-primary">Contraseña</span>
        <input
          type="password"
          className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <span className="mt-1 block text-xs text-text-secondary">{PASSWORD_RULE_TEXT}</span>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex w-full items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? "Guardando…" : "Guardar y entrar"}
      </button>
    </form>
  );
}
