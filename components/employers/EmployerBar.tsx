"use client";

import { useState } from "react";
import { signOutEmployer } from "@/lib/client/api";

/**
 * Who you are signed in as, and the way out.
 *
 * Small, but not optional: every page behind the wall shows real people's
 * contact details, and an employer needs to be able to see which account is
 * accumulating that in the reveal log — and to end the session on a shared
 * office machine. A gated area with no visible identity and no sign-out is how
 * one person's downloads end up attributed to a colleague.
 */
export function EmployerBar({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-panel px-4 py-2.5 text-sm">
      <span className="text-text-secondary">
        Entraste como <strong className="text-text-primary">{email}</strong>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await signOutEmployer();
          } finally {
            // Full navigation either way: the cookie changed server-side, so the
            // next render has to come from the server. On failure this lands on
            // the access page, which is the honest result of "not signed in".
            window.location.assign("/empleadores/acceso?estado=sesion_cerrada");
          }
        }}
        className="font-medium text-accent-dark hover:underline disabled:opacity-60"
      >
        {busy ? "Saliendo…" : "Salir"}
      </button>
    </div>
  );
}
