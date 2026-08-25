import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { checkEmployerGate } from "@/lib/employers/session";
import { inspectEmployerEmail } from "@/lib/employers/policy";
import { CheckEmailPanel } from "@/components/employers/CheckEmailPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirma tu correo",
  // Mid-flow and personal to whoever is looking at it. Nothing to index.
  robots: { index: false, follow: false },
};

/**
 * The dedicated "check your email" screen, reached after registering and after a
 * sign-in that turns out to be unconfirmed.
 *
 * ── Its own route, not a panel inside the login form ────────────────────────
 * Registration ends somewhere the person cannot act: the next step happens in
 * another application, possibly on another device. A URL they can return to,
 * reload, or reach from their phone is worth more than a state flag that a
 * refresh throws away — which is what a panel inside the form was.
 *
 * ── Why the address comes from the query string ─────────────────────────────
 * There is no session to read it from: with confirmation required, Supabase
 * issues none until the link is clicked. So it is passed along from the form.
 * It is checked for SHAPE before being displayed, so a crafted URL cannot use
 * this page to render arbitrary text next to our branding — and if it fails that
 * check the page still works, just without the address. React escapes it either
 * way; the check is about what the sentence claims, not about markup.
 *
 * Nothing here confirms that the address has an account. The page reads the same
 * whether it does or not, which is the same rule the registration and resend
 * responses follow.
 */
export default async function CheckYourEmailPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Already confirmed and signed in? Send them where they were going. Making a
  // verified employer look at "revisa tu correo" reads as though something is
  // broken.
  const gate = await checkEmployerGate();
  if (gate.status === "ok") redirect("/empleadores");

  const raw = searchParams.correo;
  const candidate = typeof raw === "string" ? raw : "";
  const verdict = inspectEmployerEmail(candidate);
  // `unverified` beats the query string: that address came from a real session.
  const email =
    gate.status === "unverified"
      ? gate.email
      : verdict.rejection === null
        ? verdict.normalized
        : null;

  return (
    <main className="mx-auto flex min-h-page max-w-xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
          Falta un paso: confirma tu correo
        </h1>
        <p className="text-base leading-snug text-text-secondary">
          Pedimos esto porque cada perfil del directorio trae el nombre, el teléfono y el
          currículum de una persona real, y solo los mostramos a empresas que podemos identificar.
        </p>
      </header>

      {email ? (
        <CheckEmailPanel email={email} />
      ) : (
        // No usable address — someone opened this URL directly. Send them to the
        // one place that can help, rather than showing a resend button with
        // nothing to resend to.
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-6">
          <h2 className="text-lg font-bold text-text-primary">Revisa tu correo</h2>
          <p className="text-sm leading-snug text-text-secondary">
            Abre el enlace de confirmación que te enviamos. Si no llegó, entra con tu cuenta y te
            lo enviamos otra vez.
          </p>
          <Link
            href="/empleadores/acceso"
            className="inline-flex w-full items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover"
          >
            Ir a mi cuenta
          </Link>
        </div>
      )}

      <footer className="mt-2 border-t border-border pt-6">
        <p className="text-sm text-text-secondary">
          ¿Buscas trabajo?{" "}
          <Link href="/" className="font-medium text-accent-dark hover:underline">
            Crea tu currículum gratis
          </Link>{" "}
          y aparece en este directorio.
        </p>
      </footer>
    </main>
  );
}
