import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getBrandConfig } from "@/lib/brand/registry";
import { getActiveBrandId } from "@/lib/brand/server";
import { resolveEmployerSession } from "@/lib/employers/session";
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

/** Reasons a redirect can land here, as Spanish the visitor can act on. */
const NOTICES: Record<string, string> = {
  enlace_invalido:
    "Ese enlace ya no sirve — los enlaces caducan y solo se pueden usar una vez. Pide uno nuevo.",
  sesion_requerida: "Entra con tu cuenta de empresa para ver el directorio.",
  contrasena_lista: "Tu contraseña quedó lista. Ya puedes entrar con ella.",
};

export default async function EmployerAccessPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Already in? Don't show a login form — that reads as "your session broke".
  if (await resolveEmployerSession()) redirect("/empleadores");

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

      <EmployerAuthForms initialNotice={notice} />

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
