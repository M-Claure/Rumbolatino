"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type EmployerIdentity, type RevealedContact } from "@/lib/client/api";

/**
 * "¿Cómo contacto a esta persona?" — the one place a candidate's details are
 * handed over.
 *
 * ── Why there is a form here at all ─────────────────────────────────────────
 * Everything else on this page is public and anonymous, and that is on purpose:
 * browsing costs nobody anything. Contact details are different. Handing them to
 * whoever loads the page would make the directory a scrapeable list of names,
 * cities and phone numbers — which is not what any of these people agreed to
 * when they pressed "publicar".
 *
 * So the ask is deliberately the smallest one that still means something: who
 * are you, and where do you work. No password, no verification email, no
 * account. It will not stop someone determined to lie. What it does is make
 * every disclosure attributable in `contact_reveals`, so that "who has my
 * number?" has an answer — and make bulk collection something a person has to
 * choose to do rather than something that happens by default.
 *
 * The gate is honest about that limit in its own copy, on both sides: the
 * candidate is told we record who asked, and the employer is told the same.
 */
export function ContactGate({ slug, displayName }: { slug: string; displayName: string }) {
  const [checking, setChecking] = useState(true);
  const [employer, setEmployer] = useState<EmployerIdentity | null>(null);
  const [revealed, setRevealed] = useState<RevealedContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .currentEmployer()
      .then((res) => !cancelled && setEmployer(res.employer))
      // Not being identified yet is the normal first-visit state, so a failure
      // here just leaves the form showing.
      .catch(() => undefined)
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setRevealed(await api.revealContact(slug));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "No se pudo obtener el contacto. Intenta de nuevo.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function identify() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.registerEmployer({
        company: company.trim(),
        contactName: contactName.trim(),
        email: email.trim(),
      });
      setEmployer(res.employer);
      // Straight through to the reveal: they pressed a button that said "ver
      // datos de contacto", and making them press it twice is just friction.
      setRevealed(await api.revealContact(slug));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo continuar. Intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "mt-1 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm outline-none focus:border-accent";
  const canIdentify =
    company.trim().length > 0 && contactName.trim().length > 0 && email.trim().length > 0;

  // ── Unlocked ──────────────────────────────────────────────────────────────
  if (revealed) {
    const { contact, hasResume } = revealed;
    return (
      <section className="rounded-2xl border-2 border-accent bg-white p-5">
        <h2 className="text-base font-bold text-text-primary">Datos de contacto</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          {contact.fullName && <Row label="Nombre" value={contact.fullName} />}
          {contact.email && <Row label="Correo" value={contact.email} href={`mailto:${contact.email}`} />}
          {contact.phone && <Row label="Teléfono" value={contact.phone} href={`tel:${contact.phone}`} />}
          {contact.linkedInUrl && (
            <Row label="LinkedIn" value={contact.linkedInUrl} href={contact.linkedInUrl} />
          )}
        </dl>

        {hasResume && (
          <a
            href={api.talentResumeUrl(slug)}
            className="mt-4 inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover"
          >
            Descargar currículum (PDF)
          </a>
        )}

        <p className="mt-3 text-xs leading-snug text-text-secondary">
          Guardamos que tu empresa vio estos datos. Úsalos solo para ofrecerle trabajo a esta
          persona.
        </p>
      </section>
    );
  }

  if (checking) {
    return <section className="rounded-2xl border border-border bg-white p-5 text-sm text-text-secondary">Cargando…</section>;
  }

  // ── Identified already: one button ────────────────────────────────────────
  if (employer) {
    return (
      <section className="rounded-2xl border-2 border-accent bg-white p-5">
        <h2 className="text-base font-bold text-text-primary">
          ¿Quieres contactar a {displayName}?
        </h2>
        <p className="mt-1 text-sm leading-snug text-text-secondary">
          Verás su nombre completo, su correo o teléfono y podrás descargar su currículum.
          Quedará registrado que <strong>{employer.company}</strong> pidió estos datos.
        </p>
        <button
          type="button"
          onClick={reveal}
          disabled={busy}
          className="mt-3 inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Abriendo…" : "Ver datos de contacto"}
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>
    );
  }

  // ── Not identified yet: the ask ───────────────────────────────────────────
  return (
    <section className="rounded-2xl border-2 border-accent bg-white p-5">
      <h2 className="text-base font-bold text-text-primary">
        ¿Quieres contactar a {displayName}?
      </h2>
      <p className="mt-1 text-sm leading-snug text-text-secondary">
        Dinos quién eres y te damos sus datos de contacto y su currículum. No necesitas crear
        una cuenta ni contraseña. Guardamos quién pidió los datos de cada persona.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canIdentify && !busy) identify();
        }}
        className="mt-4 grid gap-3 sm:grid-cols-3"
      >
        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Empresa</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Tu nombre</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={120} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-text-primary">Tu correo</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} className={field} />
        </label>

        <div className="sm:col-span-3">
          <button
            type="submit"
            disabled={!canIdentify || busy}
            className="inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Un momento…" : "Ver datos de contacto"}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-secondary">{label}</dt>
      <dd className="text-sm font-medium text-text-primary">
        {href ? (
          <a href={href} className="text-accent-dark hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
