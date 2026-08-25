import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getBrandConfig } from "@/lib/brand/registry";
import { getActiveBrandId } from "@/lib/brand/server";
import { checkEmployerGate } from "@/lib/employers/session";
import { EmployerAuthForms } from "@/components/employers/EmployerAuthForms";

export const dynamic = "force-dynamic";

/**
 * The employer front door, and the ONLY public page on this side of the product.
 *
 * ── Indexable, deliberately, while the directory is not ─────────────────────
 * Gating the directory removed the page Google used to index, and with it the
 * only way an employer discovered this at all. So the wall itself is the
 * indexable surface: it describes what is behind it and lists nobody. That keeps
 * discovery working without a single candidate's name being crawlable — which
 * `/empleadores` and `/talento/[slug]` now both refuse.
 */
export function generateMetadata(): Metadata {
  const brand = getBrandConfig(getActiveBrandId());
  return {
    title: `Acceso para empresas | ${brand.name}`,
    description:
      "Crea una cuenta de empresa para buscar y contactar personas capacitadas y listas para trabajar.",
  };
}

/**
 * Reasons a redirect can land here, as Spanish the visitor can act on.
 *
 * Each entry names what happened AND what to do about it. A bare "error" leaves
 * someone holding a dead link with nothing to press — and these are the messages
 * every authentication callback falls back to, so they are the whole of the
 * error handling a user ever sees.
 */
const NOTICES: Record<string, string> = {
  enlace_invalido:
    "Ese enlace ya no sirve — los enlaces caducan y solo se pueden usar una vez. Pide uno nuevo.",
  // An expired link is not one problem but two, and they need different
  // buttons: a stale CONFIRMATION link is replaced by signing in (which sends
  // the person to the resend screen), while a stale RECOVERY link is replaced
  // from "olvidaste tu contraseña". Naming both beats a generic "pide uno nuevo"
  // next to a form that offers three different actions.
  enlace_expirado:
    "Ese enlace ya caducó. Entra con tu correo y contraseña y te enviamos uno nuevo — o usa " +
    "«¿Olvidaste tu contraseña?» si el enlace era para cambiarla.",
  // The PKCE case: a genuine, unexpired link opened somewhere other than where
  // it was requested. Worth its own sentence, because "pide uno nuevo" would
  // send them round the same loop.
  enlace_otro_navegador:
    "Ese enlace hay que abrirlo en el mismo navegador donde lo pediste. Ábrelo ahí, o pide uno " +
    "nuevo desde este dispositivo.",
  demasiados_intentos:
    "Hiciste esto muchas veces seguidas. Espera unos minutos y vuelve a intentarlo.",
  configuracion:
    "El acceso para empresas no está disponible en este momento. Ya estamos avisados.",
  sesion_requerida: "Entra con tu cuenta de empresa para ver el directorio.",
  sesion_expirada: "Tu sesión caducó por seguridad. Entra otra vez para seguir.",
  contrasena_lista: "Tu contraseña quedó lista. Ya puedes entrar con ella.",
  correo_confirmado: "¡Listo! Confirmamos tu correo. Ya puedes entrar con tu contraseña.",
  sesion_cerrada: "Cerraste tu sesión. Puedes entrar otra vez cuando quieras.",
};

export default async function EmployerAccessPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Already in? Don't show a login form — that reads as "your session broke".
  const gate = await checkEmployerGate();
  if (gate.status === "ok") redirect("/empleadores");
  // Signed in but the address is unconfirmed. There is exactly one thing that
  // person can do, and it has its own screen; showing them a login form they
  // have already used would be a loop.
  if (gate.status === "unverified") {
    redirect(`/empleadores/verifica-tu-correo?correo=${encodeURIComponent(gate.email)}`);
  }

  const state = searchParams.estado;
  const notice = typeof state === "string" ? NOTICES[state] : undefined;

  return (
    <main className="mx-auto flex min-h-page max-w-xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
          Contrata talento capacitado
        </h1>
        <p className="text-base leading-snug text-text-secondary">
          Personas que terminaron su currículum y pidieron que las empresas las encuentren. Crea
          una cuenta y confirma tu correo para ver el directorio.
        </p>
      </header>

      <EmployerAuthForms
        initialNotice={notice}
        initialPanel={state === "recuperar" ? "reset" : undefined}
      />

      {/*
        Said before the form, not in a policy page nobody opens: the people in
        this directory consented to employers seeing their details, and "an
        employer" now means a confirmed mailbox attached to a company name. Being
        explicit that reveals are logged is what keeps that promise honest.
      */}
      <section className="rounded-2xl border border-border bg-panel p-4">
        <h2 className="text-sm font-bold text-text-primary">Por qué pedimos una cuenta</h2>
        <ul className="mt-2 flex flex-col gap-1.5 text-sm leading-snug text-text-secondary">
          <li>
            Cada perfil trae el nombre, el teléfono y el currículum de una persona real. No los
            mostramos a quien no se identifique.
          </li>
          <li>
            Guardamos un registro de qué cuenta descarga cada currículum, para poder responder
            cuando alguien pregunta quién tiene sus datos.
          </li>
          <li>Es gratis. No pedimos datos de pago y no cobramos por contactar a nadie.</li>
        </ul>
      </section>

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
