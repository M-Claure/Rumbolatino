/**
 * What a gated page renders when the gate came back `misconfigured`.
 *
 * ── Why this is not a redirect to the login page ────────────────────────────
 * Because the visitor may be a perfectly valid, verified employer, and the fault
 * is ours. Sending them to a sign-in form tells them to fix something they
 * cannot fix, and it hides an outage behind a message that reads like their
 * mistake. It also sends whoever is debugging into the auth code looking for a
 * bug that is really a missing environment variable.
 *
 * ── Why it says so little ───────────────────────────────────────────────────
 * The specifics — which key is missing, which table could not be read — go to
 * the server log, where the operator can act on them. A public page must not
 * enumerate its own configuration: that tells an attacker exactly which control
 * is currently absent.
 */
export function DirectoryUnavailable() {
  return (
    <main className="mx-auto flex min-h-page max-w-xl flex-col gap-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-bold text-text-primary">
        El directorio no está disponible
      </h1>
      <p className="text-base leading-snug text-text-secondary">
        Es un problema de nuestro lado, no de tu cuenta. Vuelve a intentarlo en un rato.
      </p>
      <p className="text-sm text-text-secondary">
        Si administras este sitio: la causa está en el registro del servidor —
        revisa <code className="rounded bg-panel px-1 py-0.5">SUPABASE_SERVICE_ROLE_KEY</code> y
        la configuración de Supabase en <code className="rounded bg-panel px-1 py-0.5">docs/employer-accounts.md</code>.
      </p>
    </main>
  );
}
