import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getEmployerSupabaseClient } from "@/lib/employers/session";
import { NewPasswordForm } from "@/components/employers/NewPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nueva contraseña",
  // Nothing here is worth indexing and the URL only makes sense mid-flow.
  robots: { index: false, follow: false },
};

/**
 * The second half of a password recovery.
 *
 * ── The guard is a real session check, on the server ────────────────────────
 * Reached from `/auth/confirm`, which exchanged the emailed `token_hash` for a
 * session. So the question this page asks is the only one that means anything:
 * does this request carry a session Supabase will accept? `getUser()` puts that
 * to the auth server rather than trusting a parsed cookie, and no session means
 * the link was expired, already used, or never valid — one message, because they
 * are one situation to the person holding it.
 *
 * This is not the security boundary and does not need to be: `POST
 * /api/employers/contrasena` re-checks the session server-side before changing
 * anything. Hiding the form is a courtesy, not a control.
 *
 * The previous version checked for the presence of an httpOnly cookie holding
 * our own reset token. That is gone with the token.
 */
export default async function NewEmployerPasswordPage() {
  let signedIn = false;
  try {
    const { data } = await getEmployerSupabaseClient().auth.getUser();
    signedIn = Boolean(data.user);
  } catch (error) {
    console.error("[employers] could not read the recovery session:", error);
  }

  if (!signedIn) redirect("/empleadores/acceso?estado=enlace_invalido");

  return (
    <main className="mx-auto flex min-h-page max-w-md flex-col gap-6 px-6 py-10">
      <NewPasswordForm />
    </main>
  );
}
