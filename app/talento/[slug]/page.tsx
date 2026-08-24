import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readPublicProfile } from "@/lib/services/talent-directory";
import {
  AVAILABILITY_LABELS,
  YEARS_BUCKET_LABELS,
  labelForCategory,
} from "@/lib/talent/taxonomy";
import { labelForType } from "@/lib/experience-types";
import { headers } from "next/headers";
import { getTalentStore } from "@/lib/repositories";
import { clientIp } from "@/lib/rate-limit/policy";

export const dynamic = "force-dynamic";

/**
 * One person's public profile.
 *
 * ── noindex, and why it is not a contradiction ─────────────────────────────
 * `/empleadores` is indexable so employers can find the directory. This page is
 * not, and the difference is the point: being discoverable as a SERVICE must not
 * make every individual listing a permanent, cached, searchable record of a real
 * person's employment situation. Someone who takes their listing down after a
 * week should not still be the top result for their own name a year later, and
 * `noindex` is the only part of that we control.
 *
 * ── Missing, unpublished and expired all render the same 404 ───────────────
 * `readPublicProfile` cannot distinguish them for the caller, so this page
 * cannot either. If an unpublished profile 404'd differently from an unknown
 * slug, the difference would confirm that a given person was once listed — which
 * is exactly what unpublishing is meant to undo.
 */

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const profile = await readPublicProfile(params.slug).catch(() => null);
  return {
    title: profile ? `${profile.displayName} — ${profile.headline}` : "Perfil no disponible",
    robots: { index: false, follow: false },
  };
}

export default async function TalentProfilePage({ params }: { params: { slug: string } }) {
  const profile = await readPublicProfile(params.slug).catch(() => null);
  if (!profile) notFound();

  const place = [profile.city, profile.state, profile.country].filter(Boolean).join(", ");

  // Contact details are open — the same decision that opened the PDF download,
  // and the PDF contains them anyway, so gating this panel beside a free
  // download would protect nothing. Read through `revealContact` rather than a
  // plain select so the view is still written to `contact_reveals`.
  const contact = await getTalentStore()
    .revealContact({ employerId: null, slug: profile.slug, ip: clientIp(headers()) })
    .catch(() => null);

  return (
    <main className="mx-auto flex min-h-page max-w-3xl flex-col gap-6 px-6 py-10">
      <Link href="/empleadores" className="self-start text-sm font-medium text-accent-dark hover:underline">
        ← Volver a la búsqueda
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
            {profile.displayName}
          </h1>
          <span className="rounded-full bg-accent-light px-2.5 py-0.5 text-xs font-medium text-accent-dark">
            {labelForCategory(profile.category)}
          </span>
        </div>
        <p className="text-lg font-semibold text-text-primary">{profile.headline}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-secondary">
          {place && <span>📍 {place}</span>}
          <span>🗂️ {YEARS_BUCKET_LABELS[profile.yearsBucket]}</span>
          <span>🕒 {AVAILABILITY_LABELS[profile.availability]}</span>
        </div>
      </header>

      <section className="rounded-2xl border-2 border-accent bg-white p-5">
        <h2 className="text-base font-bold text-text-primary">Cómo contactar</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          {contact?.fullName && <Row label="Nombre" value={contact.fullName} />}
          {contact?.email && (
            <Row label="Correo" value={contact.email} href={`mailto:${contact.email}`} />
          )}
          {contact?.phone && (
            <Row label="Teléfono" value={contact.phone} href={`tel:${contact.phone}`} />
          )}
          {contact?.linkedInUrl && (
            <Row label="LinkedIn" value={contact.linkedInUrl} href={contact.linkedInUrl} />
          )}
        </dl>
        {contact?.resumePdfPath && (
          <a
            href={`/api/talent/${encodeURIComponent(profile.slug)}/resume`}
            className="mt-4 inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-on transition hover:bg-accent-hover"
          >
            Descargar currículum (PDF)
          </a>
        )}
      </section>

      {profile.summary && (
        <Section title="Resumen">
          <p className="text-sm leading-relaxed text-text-primary">{profile.summary}</p>
        </Section>
      )}

      {profile.skills.length > 0 && (
        <Section title="Lo que sabe hacer">
          <ul className="flex flex-wrap gap-1.5">
            {profile.skills.map((skill) => (
              <li
                key={skill}
                className="rounded-full border border-border bg-white px-2.5 py-1 text-sm text-text-primary"
              >
                {skill}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {profile.experience.length > 0 && (
        <Section title="Experiencia">
          <ul className="flex flex-col gap-4">
            {profile.experience.map((entry, i) => (
              <li key={i}>
                <p className="text-sm font-semibold text-text-primary">
                  {/* Many people here have neither a job title nor an employer
                      ("cuidaba a mi abuela"). The experience TYPE is what makes
                      such an entry legible, exactly as on the résumé itself. */}
                  {entry.title ??
                    (entry.experienceType
                      ? labelForType(entry.experienceType).replace(/^./, (c) => c.toUpperCase())
                      : "Experiencia")}
                  {entry.organization && (
                    <span className="font-normal text-text-secondary"> · {entry.organization}</span>
                  )}
                </p>
                {(entry.startDate || entry.endDate || entry.isCurrent) && (
                  <p className="text-xs text-text-secondary">
                    {[entry.startDate, entry.isCurrent ? "Actualidad" : entry.endDate]
                      .filter(Boolean)
                      .join(" – ")}
                  </p>
                )}
                {entry.bullets.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-sm text-text-primary">
                    {entry.bullets.map((b, bi) => (
                      <li key={bi}>{b}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {profile.education.length > 0 && (
        <Section title="Estudios">
          <ul className="flex flex-col gap-2">
            {profile.education.map((entry, i) => (
              <li key={i} className="text-sm text-text-primary">
                <span className="font-semibold">{entry.credential ?? entry.fieldOfStudy}</span>
                {entry.institution && (
                  <span className="text-text-secondary"> · {entry.institution}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {profile.certifications.length > 0 && (
        <Section title="Certificaciones">
          <ul className="list-disc pl-5 text-sm text-text-primary">
            {profile.certifications.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Section>
      )}

      {profile.languages.length > 0 && (
        <Section title="Idiomas">
          <ul className="flex flex-wrap gap-3 text-sm text-text-primary">
            {profile.languages.map((l) => (
              <li key={l.name}>
                {l.name}
                {l.level && <span className="text-text-secondary"> · {l.level}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </main>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-white p-5">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-text-secondary">
        {title}
      </h2>
      {children}
    </section>
  );
}
