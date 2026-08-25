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
 * Reached only from `/empleadores/recuperar/confirmar`, which exchanges the
 * emailed code for a session first.
 *
 * The guard checks for a session but NOT for a confirmed email, which is the one
 * place in the employer flow that distinction matters: a reset is exactly how
 * someone who never clicked their original confirmation link recovers, and
 * `resolveEmployerSession` would turn them away for being unverified. Supabase
 * marks the address confirmed once the reset completes, so they leave here in the
 * same state as anyone else.
 */
export default async function NewEmployerPasswordPage() {
  const { data } = await getEmployerSupabaseClient().auth.getUser();
  if (!data.user) redirect("/empleadores/acceso?estado=enlace_invalido");

  return (
    <main className="mx-auto flex min-h-page max-w-md flex-col gap-6 px-6 py-10">
      <NewPasswordForm />
    </main>
  );
}
