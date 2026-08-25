/**
 * Seed the Bolsa de Talento with ten FICTIONAL published profiles, so the
 * directory can be demonstrated before real users have published anything.
 *
 *   npm run demo:seed          # create (idempotent — re-running updates in place)
 *   npm run demo:seed:clean    # remove every trace of it
 *
 * ── This is a DEMO fixture, not a fixture for tests ─────────────────────────
 * It writes to whatever Supabase project `.env.local` points at. Point it at a
 * staging project if you have one. The data is marked (see DEMO_MARKER) and
 * `--clean` removes it completely, which is the only reason running it against a
 * production project is defensible at all.
 *
 * ── It goes through the real projection, not around it ──────────────────────
 * Each person's résumé is built as a `GeneratedResume` and then handed to
 * `projectTalentProfile`, `suggestCategory` and `estimateYearsBucket` — the same
 * three functions `publishTalentProfile` uses. So the categories, seniority
 * buckets and public/contact split in the demo are what the product would
 * actually produce, and a change that breaks the projection breaks this too.
 *
 * What it does NOT reuse is `publishTalentProfile` itself, because that needs a
 * cookie-bound Supabase client (the `talent_profiles` RLS policy checks
 * `auth.uid()`) and a request context that does not exist in a CLI. The inserts
 * below mirror `SupabaseTalentStore.publish` column for column; if that method
 * grows a column, add it here too.
 *
 * ── Why it creates real auth users ──────────────────────────────────────────
 * `funnel.user_id` and `talent_profiles.user_id` are foreign keys into
 * `auth.users`. There is no way to place a row in the directory without one.
 * They are created with a random unguessable password, marked in
 * `user_metadata`, and deleting them cascades the funnel row, the listing and
 * the contact row in one step.
 *
 * ── The PDFs are real ───────────────────────────────────────────────────────
 * The employer table's CV column streams `talent_contacts.resume_pdf_path` out
 * of the private `resumes` bucket. A seeded listing with no object there gives a
 * 404 at the exact moment of the demo, so this renders each résumé with the
 * product's own renderer and Chromium and uploads it to the same per-round path
 * the app writes (`<user_id>/<funnel_id>/curriculum.pdf`). Pass `--no-pdf` to
 * skip that (faster, but the CV links will 404).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import type {
  Certification,
  EducationEntry,
  ExperienceEntry,
  GeneratedBullet,
  GeneratedResume,
  Language,
  PersonalInformation,
  Skill,
} from "@/types";
import { PUBLISH_TERMS_VERSION, TERMS_VERSION } from "@/lib/legal/terms";
import { lookupZip } from "@/lib/geo/zip-lookup";
import { renderResumeHtml } from "@/lib/resume/resume-renderer";
import { suggestCategory } from "@/lib/talent/classify";
import { labelForCategory } from "@/lib/talent/taxonomy";
import {
  buildTalentSlug,
  estimateYearsBucket,
  projectTalentProfile,
} from "@/lib/talent/talent-projection";
import { talentExpiryFrom } from "@/lib/repositories/talent-store";
import { resumePdfPath, RESUME_BUCKET } from "@/lib/storage/resume-file-store";
import { DEMO_PEOPLE, type DemoPerson } from "./demo-people";

// ─────────────────────────────────────────────────────────────────────────────
// The marker
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Stamped on every auth user this script creates, and the ONLY thing `--clean`
 * matches on. Nothing without it is ever touched, so a cleanup cannot reach a
 * real user's résumé even if the fixtures change or someone edits a listing by
 * hand. The email domain is a second, human-readable copy of the same signal.
 */
const DEMO_MARKER = "rumbo_demo_seed_v1";
const DEMO_EMAIL_DOMAIN = "demo-seed.invalid";

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A five-line .env reader rather than `dotenv`: this script runs outside Next,
 * which is what normally loads these, and adding a dependency to read two
 * variables is not worth it. Handles `KEY=value`, comments, blank lines and
 * surrounding quotes — nothing else, because nothing else is in the file.
 */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No encontré ${path}. Usa --env=<archivo> para indicar otro.`);
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}

interface Args {
  clean: boolean;
  pdf: boolean;
  dryRun: boolean;
  envFile: string;
}

function parseArgs(argv: string[]): Args {
  const envArg = argv.find((a) => a.startsWith("--env="));
  return {
    clean: argv.includes("--clean"),
    pdf: !argv.includes("--no-pdf"),
    dryRun: argv.includes("--dry-run"),
    envFile: envArg ? envArg.slice("--env=".length) : ".env.local",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Building one person's data
// ─────────────────────────────────────────────────────────────────────────────

const slugify = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

/**
 * A bullet, traced to the entry it came from.
 *
 * Real bullets carry the provenance `lib/resume/source-tracing.ts` verified. The
 * demo's are written by hand from the same entry, so the trace is honest: the
 * entry id is the one the line describes. It matters because the projection
 * drops the trace before publishing and a malformed one would go unnoticed here.
 */
const bullet = (text: string, entryId: string): GeneratedBullet => ({
  text,
  sourceEntryIds: [entryId],
  sourceFields: ["rawDescription"],
});

interface BuiltPerson {
  funnelId: string;
  person: DemoPerson;
  personal: PersonalInformation;
  resume: GeneratedResume;
  /** The capture rows the résumé was built from, so the funnel row is coherent. */
  capture: {
    experience: ExperienceEntry[];
    education: EducationEntry[];
    skills: Skill[];
    certifications: Certification[];
    languages: Language[];
  };
  location: string;
}

function buildPerson(person: DemoPerson): BuiltPerson {
  const funnelId = randomUUID();
  const zip = lookupZip(person.zip);
  if (!zip) {
    // Loudly, because a missing ZIP silently produces someone who can never
    // appear in a radius search — the main thing the demo is meant to show.
    throw new Error(
      `El código postal ${person.zip} (${person.firstName} ${person.lastName}) no está en la tabla de ZIPs.`,
    );
  }

  const personal: PersonalInformation = {
    resumeProfileId: funnelId,
    firstName: person.firstName,
    lastName: person.lastName,
    postalCode: zip.postalCode,
    city: zip.city,
    state: zip.state,
    country: "Estados Unidos",
    // RFC 2606 reserved domain + the 555-01xx fiction block: neither can reach
    // anybody, which is the point of seeding a directory of contact details.
    phone: `(${person.zip.slice(0, 3)}) 555-01${String(DEMO_PEOPLE.indexOf(person) + 10).padStart(2, "0")}`,
    email: `${slugify(`${person.firstName} ${person.lastName}`)}@example.com`,
    linkedInUrl: null,
    portfolioUrl: null,
    latitude: zip.latitude,
    longitude: zip.longitude,
  };

  const experience: ExperienceEntry[] = person.experience.map((e) => ({
    id: randomUUID(),
    resumeProfileId: funnelId,
    experienceType: e.experienceType,
    title: e.title,
    organization: e.organization,
    location: `${zip.city}, ${zip.state}`,
    startDate: e.startDate,
    endDate: e.endDate,
    isCurrent: e.isCurrent,
    rawDescription: e.bullets.join(" "),
    responsibilities: e.bullets,
    accomplishments: [],
    tools: [],
    peopleServed: null,
    metrics: [],
    source: "user_entered",
    confirmationStatus: "confirmed",
  }));

  const education: EducationEntry[] = person.education.map((e) => ({
    id: randomUUID(),
    resumeProfileId: funnelId,
    institution: e.institution,
    credential: e.credential,
    fieldOfStudy: e.fieldOfStudy,
    location: null,
    startDate: e.startDate,
    endDate: e.endDate,
    isCurrent: false,
    relevantCoursework: [],
    projects: [],
    achievements: [],
    source: "user_entered",
    confirmationStatus: "confirmed",
  }));

  const nowIso = new Date().toISOString();
  const skills: Skill[] = person.skillGroups.flatMap((group) =>
    group.skills.map((name) => ({
      id: randomUUID(),
      resumeProfileId: funnelId,
      name,
      category: group.category,
      proficiency: null,
      origin: "user_entered" as const,
      evidence: null,
      sourceEntryId: null,
      // `confirmed`, never `suggested`: the résumé generator reads only confirmed
      // skills, so a suggested one here would produce a résumé with no skills.
      // These stand for skills the (fictional) person confirmed in the funnel.
      status: "confirmed" as const,
      createdAt: nowIso,
      updatedAt: nowIso,
    })),
  );

  const certifications: Certification[] = (person.certifications ?? []).map((name) => ({
    id: randomUUID(),
    resumeProfileId: funnelId,
    name,
    issuingOrganization: null,
    issueDate: null,
    expirationDate: null,
    credentialId: null,
    credentialUrl: null,
    confirmationStatus: "confirmed",
  }));

  const languages: Language[] = person.languages.map((l) => ({
    id: randomUUID(),
    resumeProfileId: funnelId,
    name: l.name,
    speakingLevel: l.level,
    readingLevel: l.level,
    writingLevel: l.level,
    includeOnResume: true,
  }));

  const resume: GeneratedResume = {
    id: randomUUID(),
    resumeProfileId: funnelId,
    version: 1,
    stage: 0,
    professionalSummary: person.summary,
    skills: person.skillGroups.map((group) => ({
      category: group.category,
      skills: group.skills,
      sourceSkillIds: skills.filter((s) => s.category === group.category).map((s) => s.id),
    })),
    experience: experience.map((entry, i) => ({
      entryId: entry.id,
      title: entry.title,
      organization: entry.organization,
      location: entry.location,
      startDate: entry.startDate,
      endDate: entry.endDate,
      isCurrent: entry.isCurrent,
      experienceType: entry.experienceType,
      bullets: (person.experience[i]?.bullets ?? []).map((t) => bullet(t, entry.id)),
    })),
    education: education.map((entry) => ({
      entryId: entry.id,
      institution: entry.institution,
      credential: entry.credential,
      fieldOfStudy: entry.fieldOfStudy,
      startDate: entry.startDate,
      endDate: entry.endDate,
      isCurrent: false,
      details: [],
    })),
    certifications: certifications.map((c) => ({
      entryId: c.id,
      name: c.name,
      issuingOrganization: c.issuingOrganization,
      issueDate: c.issueDate,
    })),
    projects: [],
    languages: languages.map((l) => ({
      entryId: l.id,
      name: l.name,
      level: l.speakingLevel,
    })),
    html: "",
    pdfPath: null,
    createdAt: nowIso,
  };

  resume.html = renderResumeHtml({
    fullName: `${person.firstName} ${person.lastName}`,
    headline: person.targetRole,
    location: `${zip.city}, ${zip.state}`,
    contact: { email: personal.email, phone: personal.phone },
    professionalSummary: resume.professionalSummary,
    skills: resume.skills,
    experience: resume.experience,
    education: resume.education,
    certifications: resume.certifications,
    projects: resume.projects,
    languages: resume.languages,
    interests: person.interests ?? [],
  });

  return {
    funnelId,
    person,
    personal,
    resume,
    capture: { experience, education, skills, certifications, languages },
    location: `${zip.city}, ${zip.state}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

const demoEmail = (person: DemoPerson): string =>
  `${slugify(`${person.firstName} ${person.lastName}`)}@${DEMO_EMAIL_DOMAIN}`;

/** Find the seeded auth user for a fixture, if a previous run made one. */
async function findDemoUser(admin: SupabaseClient, email: string): Promise<string | null> {
  // `listUsers` pages; the demo set is small, so one wide page is enough, and
  // this is also what `--clean` walks.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`No pude listar usuarios: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureUser(admin: SupabaseClient, person: DemoPerson): Promise<string> {
  const email = demoEmail(person);
  const existing = await findDemoUser(admin, email);
  if (existing) return existing;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    // Never used to sign in — a demo profile is nobody's account. Random and
    // unstored so the row cannot become a way in.
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
    user_metadata: { [DEMO_MARKER]: true, demo_display_name: `${person.firstName} ${person.lastName}` },
  });
  if (error || !data.user) {
    throw new Error(`No pude crear el usuario ${email}: ${error?.message ?? "sin usuario"}`);
  }
  return data.user.id;
}

async function seed(admin: SupabaseClient, args: Args): Promise<void> {
  const publishedAt = new Date().toISOString();
  // One browser for all ten — a Chromium launch per résumé is most of the
  // script's runtime.
  const browser = args.pdf ? await puppeteer.launch({ headless: true }) : null;

  try {
    for (const person of DEMO_PEOPLE) {
      const built = buildPerson(person);
      const userId = await ensureUser(admin, person);

      // A re-run reuses the SAME funnel row for this user, so the demo does not
      // multiply every time it is run. `talent_profiles.funnel_id` is unique, so
      // the listing updates in place too.
      const { data: existingFunnels } = await admin
        .from("funnel")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(1);
      const funnelId = (existingFunnels as Array<{ id: string }> | null)?.[0]?.id ?? built.funnelId;

      // Ids inside the JSONB point at the funnel row, so if we adopted an
      // existing one the whole document has to be rebuilt against it.
      const p = funnelId === built.funnelId ? built : rebuildAgainst(built, funnelId);

      let pdfPath: string | null = null;
      if (browser) {
        const page = await browser.newPage();
        try {
          await page.setContent(p.resume.html, { waitUntil: "load" });
          const pdf = await page.pdf({
            format: "letter",
            printBackground: true,
            margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
          });
          // The same path the app writes for stage 0, so nothing about this row
          // is special-cased downstream.
          pdfPath = resumePdfPath({ userId, profileId: funnelId, stage: 0 });
          const { error } = await admin.storage
            .from(RESUME_BUCKET)
            .upload(pdfPath, new Uint8Array(pdf), { contentType: "application/pdf", upsert: true });
          if (error) throw new Error(`No pude subir el PDF (${pdfPath}): ${error.message}`);
        } finally {
          await page.close();
        }
      }
      p.resume.pdfPath = pdfPath;

      const { error: funnelError } = await admin.from("funnel").upsert(
        {
          id: funnelId,
          user_id: userId,
          status: "generated",
          target_role: person.targetRole,
          career_goal: person.careerGoal,
          location: p.location,
          interests: person.interests ?? [],
          progress_percentage: 100,
          current_section: "review",
          finalized_at: publishedAt,
          terms_accepted_at: publishedAt,
          terms_version: TERMS_VERSION,
          personal_information: p.personal,
          education: p.capture.education,
          experience: p.capture.experience,
          skills: p.capture.skills,
          certifications: p.capture.certifications,
          languages: p.capture.languages,
          projects: [],
          achievements: [],
          conversation: [],
          question_state: {},
          iteration: 0,
          resume_id: p.resume.id,
          resume_content: p.resume,
          resume_html: p.resume.html,
          resume_version: 1,
          resume_stage: 0,
          resume_pdf: pdfPath,
          publish_consent_at: publishedAt,
          publish_consent_version: PUBLISH_TERMS_VERSION,
        },
        { onConflict: "id" },
      );
      if (funnelError) throw new Error(`No pude guardar el funnel: ${funnelError.message}`);

      // ── The projection, exactly as publishTalentProfile does it ────────────
      const category = suggestCategory({
        targetRole: person.targetRole,
        careerGoal: person.careerGoal,
        skills: p.capture.skills.map((s) => s.name),
        certifications: p.capture.certifications.map((c) => c.name),
        education: p.capture.education,
        experience: p.capture.experience,
      });
      const yearsBucket = estimateYearsBucket(p.capture.experience, new Date().getUTCFullYear());

      // Keep the slug and the manage token of an existing listing, for the same
      // reason `publishTalentProfile` does: a URL may already have been shared.
      const { data: existingListing } = await admin
        .from("talent_profiles")
        .select("id, slug")
        .eq("funnel_id", funnelId)
        .maybeSingle();
      const previous = existingListing as { id: string; slug: string } | null;

      const projection = projectTalentProfile({
        resume: p.resume,
        personal: p.personal,
        profile: { targetRole: person.targetRole, location: p.location },
        category,
        availability: "flexible",
        yearsBucket,
        slug:
          previous?.slug ??
          buildTalentSlug(`${person.firstName} ${person.lastName}`, randomBytes(6).toString("hex").slice(0, 8)),
        publishedAt,
      });

      const pub = projection.public;
      const { data: listing, error: listingError } = await admin
        .from("talent_profiles")
        .upsert(
          {
            funnel_id: funnelId,
            user_id: userId,
            slug: pub.slug,
            display_name: pub.displayName,
            headline: pub.headline,
            summary: pub.summary,
            category: pub.category,
            skills: pub.skills,
            certifications: pub.certifications,
            education: pub.education,
            experience: pub.experience,
            languages: pub.languages,
            years_bucket: pub.yearsBucket,
            availability: pub.availability,
            city: pub.city,
            state: pub.state,
            country: pub.country,
            postal_code: p.personal.postalCode,
            latitude: p.personal.latitude,
            longitude: p.personal.longitude,
            status: "published",
            published_at: pub.publishedAt,
            expires_at: talentExpiryFrom(publishedAt),
          },
          { onConflict: "funnel_id" },
        )
        .select("id")
        .single();
      if (listingError || !listing) {
        throw new Error(`No pude publicar el perfil: ${listingError?.message ?? "sin fila"}`);
      }

      const { data: existingContact } = await admin
        .from("talent_contacts")
        .select("manage_token")
        .eq("talent_profile_id", (listing as { id: string }).id)
        .maybeSingle();

      const { error: contactError } = await admin.from("talent_contacts").upsert(
        {
          talent_profile_id: (listing as { id: string }).id,
          full_name: projection.contact.fullName,
          email: projection.contact.email,
          phone: projection.contact.phone,
          linkedin_url: projection.contact.linkedInUrl,
          resume_pdf_path: projection.contact.resumePdfPath,
          manage_token:
            (existingContact as { manage_token?: string } | null)?.manage_token ??
            randomBytes(32).toString("base64url"),
        },
        { onConflict: "talent_profile_id" },
      );
      if (contactError) {
        throw new Error(`No pude guardar el contacto: ${contactError.message}`);
      }

      const where = `${pub.city ?? "—"}, ${pub.state ?? "—"}`;
      console.log(
        `  ✓ ${pub.displayName.padEnd(20)}${labelForCategory(category).padEnd(38)}` +
          `${where.padEnd(20)}/talento/${pub.slug}${pdfPath ? "" : "  (sin PDF)"}`,
      );
      if (category === "otro") {
        console.warn(
          `    ⚠︎ El clasificador devolvió "otro" para ${pub.displayName}. ` +
            `Ajusta el texto en scripts/demo-people.ts si quieres otra categoría.`,
        );
      }
    }
  } finally {
    await browser?.close();
  }
}

/**
 * Re-stamp a built person against a funnel id that already exists.
 *
 * Every entry id inside the résumé is generated with the funnel id, and the
 * bullets' `sourceEntryIds` point at those ids. Adopting an existing row without
 * rebuilding would leave a document whose traces name entries that are not in
 * the row — which is exactly the kind of inconsistency source tracing exists to
 * prevent. Rebuilding is cheap; patching would not be.
 */
function rebuildAgainst(built: BuiltPerson, funnelId: string): BuiltPerson {
  const rebuilt = buildPerson(built.person);
  const json = JSON.stringify(rebuilt).replaceAll(rebuilt.funnelId, funnelId);
  return JSON.parse(json) as BuiltPerson;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove everything the seeder made.
 *
 * Deleting the auth user cascades: `funnel` → `talent_profiles` →
 * `talent_contacts`. Storage objects are NOT cascaded by Postgres, so the PDFs
 * are removed first and explicitly — otherwise every run would leave ten
 * résumés' worth of bytes behind in a private bucket forever.
 */
async function clean(admin: SupabaseClient): Promise<void> {
  let removed = 0;

  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`No pude listar usuarios: ${error.message}`);

    const demo = data.users.filter(
      (u) =>
        (u.user_metadata as Record<string, unknown> | null)?.[DEMO_MARKER] === true ||
        u.email?.endsWith(`@${DEMO_EMAIL_DOMAIN}`),
    );

    for (const user of demo) {
      // Storage first: once the user row is gone, so is the funnel row that
      // names the object paths.
      const { data: funnels } = await admin.from("funnel").select("id").eq("user_id", user.id);
      for (const row of (funnels ?? []) as Array<{ id: string }>) {
        const paths = [0, 1, 2, 3].map((stage) =>
          resumePdfPath({ userId: user.id, profileId: row.id, stage }),
        );
        await admin.storage.from(RESUME_BUCKET).remove(paths);
      }

      const { error: delError } = await admin.auth.admin.deleteUser(user.id);
      if (delError) {
        console.warn(`  ⚠︎ No pude borrar ${user.email}: ${delError.message}`);
        continue;
      }
      removed++;
      console.log(`  ✓ Eliminado ${user.email}`);
    }

    if (data.users.length < 200) break;
  }

  console.log(removed === 0 ? "No había datos de demostración." : `Listo: ${removed} perfiles eliminados.`);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build every fixture and print what the projection derives, touching nothing.
 *
 * Worth having because the two things most likely to be wrong are not database
 * errors: a ZIP that is not in the bundled table, and a fixture whose wording
 * the classifier reads as `otro`. Both are visible here before any row is
 * written, and neither needs credentials.
 */
function dryRun(): void {
  const year = new Date().getUTCFullYear();
  for (const person of DEMO_PEOPLE) {
    const built = buildPerson(person);
    const category = suggestCategory({
      targetRole: person.targetRole,
      careerGoal: person.careerGoal,
      skills: built.capture.skills.map((s) => s.name),
      certifications: built.capture.certifications.map((c) => c.name),
      education: built.capture.education,
      experience: built.capture.experience,
    });
    const bucket = estimateYearsBucket(built.capture.experience, year);
    const flag = category === "otro" ? "  ⚠︎ sin categoría" : "";
    console.log(
      `  ${`${person.firstName} ${person.lastName}`.padEnd(20)}` +
        `${labelForCategory(category).padEnd(38)}${bucket.padEnd(16)}` +
        `${built.location.padEnd(20)}${built.resume.html.length} bytes HTML${flag}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log(`Simulación — no se escribe nada.\n`);
    dryRun();
    return;
  }

  const env = readEnvFile(args.envFile);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      `${args.envFile} necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.`,
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const project = new URL(url).host;
  if (args.clean) {
    console.log(`Eliminando perfiles de demostración en ${project}…`);
    await clean(admin);
    return;
  }

  console.log(`Publicando ${DEMO_PEOPLE.length} perfiles de demostración en ${project}…`);
  if (!args.pdf) console.log("(--no-pdf: la columna CV dará 404)");
  await seed(admin, args);
  console.log(
    `\nListo. Abre /empleadores con una cuenta de empleador verificada.\n` +
      `Para borrarlos: npm run demo:seed:clean`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
