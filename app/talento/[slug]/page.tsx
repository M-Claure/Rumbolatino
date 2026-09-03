import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readPublicProfile } from "@/lib/services/talent-directory";
import { checkEmployerGate, resolveEmployerSession } from "@/lib/employers/session";
import { EmployerBar } from "@/components/employers/EmployerBar";
import { DirectoryUnavailable } from "@/components/employers/DirectoryUnavailable";
import { ResumePreview } from "@/components/talent/ResumePreview";
import { TalentMap } from "@/components/talent/TalentMap";
import { groupByLocation } from "@/lib/talent/map-pins";
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
 * ── Signed-in employers only ────────────────────────────────────────────────
 * A verified employer session is required, so a shared profile URL is no longer
 * a way around the directory's wall. Anyone without one is redirected to
 * `/empleadores/acceso`, not 404'd: a 404 here would imply the listing does not
 * exist, which is a different and false statement.
 *
 * ── noindex, still, and for its own reason ──────────────────────────────────
 * The gate already keeps crawlers out, so `noindex` is now belt and braces — but
 * it stays, because it is the part that survives a future decision to reopen
 * browsing. Being discoverable as a SERVICE must not make every individual
 * listing a permanent, cached, searchable record of a real person's employment
 * situation. Someone who takes their listing down after a week should not still
 * be the top result for their own name a year later.
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
  // Metadata renders for signed-out visitors too (they are about to be
  // redirected), so it must not read a profile without a session — the title
  // would otherwise leak the person's name and trade to anyone with the URL.
  const employer = await resolveEmployerSession();
  const profile = employer
    ? await readPublicProfile(params.slug, employer).catch(() => null)
    : null;
  return {
    title: profile ? `${profile.displayName} — ${profile.headline}` : "Perfil no disponible",
    robots: { index: false, follow: false },
  };
}

export default async function TalentProfilePage({ params }: { params: { slug: string } }) {
  const gate = await checkEmployerGate();
  if (gate.status === "misconfigured") return <DirectoryUnavailable />;
  if (gate.status === "anonymous") redirect("/empleadores/acceso?estado=sesion_requerida");
  // Signed in but the address is unconfirmed. A distinct destination from
  // "anonymous": telling someone to sign in when they already are is a loop.
  // There is exactly one thing that person can do, and it has its own screen.
  if (gate.status === "unverified") {
    redirect(`/empleadores/verifica-tu-correo?correo=${encodeURIComponent(gate.email)}`);
  }
  const employer = gate.session;

  const profile = await readPublicProfile(params.slug, employer).catch(() => null);
  if (!profile) notFound();

  const place = [profile.city, profile.state, profile.country].filter(Boolean).join(", ");
  const pins = groupByLocation([profile]);

  // Read through `revealContact` rather than a plain select, so viewing this
  // panel is written to `contact_reveals` — and now with a real `employerId`,
  // which is what makes the log able to answer "who has my phone number?" with a
  // name instead of an IP address.
  const contact = await getTalentStore()
    .revealContact({ employerId: employer.userId, slug: profile.slug, ip: clientIp(headers()) })
    .catch(() => null);

  return (
    <main className="mx-auto flex min-h-page max-w-3xl flex-col gap-6 px-6 py-10">
      <EmployerBar email={employer.email} />

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
          {/* The metro, when the ZIP resolved to one. Beside the city rather
              than instead of it: the city is where they say they are, the metro
              is the labour market that contains it, and an employer scanning
              this page wants to know both. */}
          {profile.cbsaTitle && <span>🧭 {profile.cbsaTitle}</span>}
          <span>🗂️ {YEARS_BUCKET_LABELS[profile.yearsBucket]}</span>
          <span>🕒 {AVAILABILITY_LABELS[profile.availability]}</span>
        </div>
      </header>

      {/*
        One pin, on the same terms as the search map: the centroid of this
        person's postal area, never an address. Mounted only when there IS a
        coordinate — a rural or non-US ZIP renders no map rather than an empty
        one centred on nothing, which is why `groupByLocation` is checked here
        instead of leaving it to the component.
      */}
      {pins.length > 0 && <TalentMap pins={pins} compact />}

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
        {/* Read it here, or keep a copy — in that order. See `ResumePreview`:
            both spend a reveal, so the cheaper-for-the-candidate option is the
            one that leaves no file behind. */}
        {contact?.resumePdfPath && (
          <ResumePreview slug={profile.slug} name={profile.displayName} />
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
