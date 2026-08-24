/**
 * Turn a finished résumé into a directory profile.
 *
 * PURE: no I/O, no env, no `server-only`. Imports `types` and this folder's own
 * taxonomy, nothing else — the same contract `lib/question-engine/*` keeps.
 *
 * ── The résumé is the upper bound ───────────────────────────────────────────
 * Everything public here is read out of `GeneratedResume`, not out of the raw
 * capture tables. That is not a convenience, it is the safety invariant: a
 * generated résumé has ALREADY been filtered to `confirmed`/`edited` entries and
 * `confirmed`/`edited` skills, and every bullet on it survived
 * `lib/resume/source-tracing.ts`. Projecting from it means the directory
 * inherits all of that for free and cannot, even by mistake, publish a
 * `suggested` skill or a `needs_review` entry — there is no code path from raw
 * capture to a public page.
 *
 * ── Two return values, deliberately ─────────────────────────────────────────
 * `TalentProfilePublic` and `TalentContact` come back as separate objects
 * destined for separate tables. The public one has no contact field to write to,
 * so "the search index cannot contain an email" is enforced by the shape of this
 * function's return type rather than by whoever writes the INSERT.
 *
 * ── What this function will NOT infer ───────────────────────────────────────
 * Category, availability and years-of-experience are ARGUMENTS, not derivations.
 * Each has an `estimate*`/`suggest*` helper that pre-fills the publish form, and
 * the person confirms all three before anything is written. Publishing a guess
 * about someone's trade or seniority is the same failure as inventing a job
 * title on their CV.
 */
import type {
  GeneratedResume,
  PersonalInformation,
  TalentAvailability,
  TalentCategory,
  TalentEducationBlock,
  TalentExperienceBlock,
  TalentLanguageBlock,
  TalentProjection,
  TalentYearsBucket,
} from "@/types";
import { parseExperienceDate } from "@/lib/experience-dates";
import { labelForCategory } from "./taxonomy";
import { stripDiacritics } from "./text";

/**
 * Bounds on what reaches a public page.
 *
 * Answers are already capped per field in `lib/answer-limits.ts`, so these are
 * the second line: they keep one very long generated summary from turning a
 * result card into a wall of text, and they bound the size of a row that is read
 * on every search.
 */
export const TALENT_LIMITS = {
  headline: 120,
  summary: 600,
  bullet: 240,
  bulletsPerExperience: 4,
  experiences: 4,
  education: 3,
  skills: 24,
  certifications: 8,
  languages: 5,
} as const;

export interface TalentProjectionInput {
  /** The CURRENT generated résumé. Its content is the whole public source. */
  resume: GeneratedResume;
  personal: PersonalInformation | null;
  profile: { targetRole?: string | null; location?: string | null };
  /** Confirmed by the user on the publish screen — never inferred here. */
  category: TalentCategory;
  availability: TalentAvailability;
  yearsBucket: TalentYearsBucket;
  /** Built by the caller (needs randomness); see `buildTalentSlug`. */
  slug: string;
  publishedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Trim to `max` characters on a word boundary, with an ellipsis when cut. */
function clamp(text: string | null | undefined, max: number): string {
  const value = (text ?? "").trim().replace(/\s+/g, " ");
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The public name — first and last, in full.
 *
 * A talent directory whose listings are anonymous is not much use to an employer,
 * and the person publishing has been told plainly that their name is what
 * employers will see. Their email, phone and PDF still sit behind the reveal
 * step, so what is publicly visible is a name, a trade and a city — the same
 * thing any professional profile shows.
 *
 * Falls back to whichever half exists, then to a neutral label: a listing with no
 * name is better than one that reads "null".
 */
export function publicDisplayName(personal: PersonalInformation | null): string {
  const full = [personal?.firstName?.trim(), personal?.lastName?.trim()]
    .filter(Boolean)
    .join(" ");
  return full || "Candidato";
}

/**
 * URL segment: a readable name-ish stem plus an opaque suffix.
 *
 * The suffix is what stops the directory from being enumerable. Without it,
 * `/talento/maria-g` is guessable and someone can walk the whole database by
 * generating common names — which turns a set of individually-consented listings
 * back into a scrapeable dump. The caller supplies the randomness so this stays
 * pure.
 */
export function buildTalentSlug(displayName: string, randomSuffix: string): string {
  const stem =
    stripDiacritics(displayName.toLocaleLowerCase("es"))
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "perfil";
  return `${stem}-${randomSuffix}`;
}

/**
 * Split a free-text location into city and state.
 *
 * `funnel.location` is whatever the person typed ("Houston", "Houston, TX").
 * Used only as a FALLBACK when the structured city/state fields are empty, and
 * it never invents a country — an unparseable value stays in `city`, which is
 * honest about what we actually know.
 */
export function splitLocation(raw: string | null | undefined): {
  city: string | null;
  state: string | null;
} {
  const value = (raw ?? "").trim();
  if (!value) return { city: null, state: null };
  const [city, state] = value.split(",").map((p) => p.trim());
  return { city: city || null, state: state || null };
}

/**
 * Coarse seniority from the résumé's own dates — a SUGGESTION for the publish
 * form, never a value that reaches the database unconfirmed.
 *
 * Deliberately conservative. Dates in this product are free text ("2019",
 * "mediados de 2020"), so many entries yield no year at all, and an undated
 * work history is not evidence of a short one. When nothing parses we return the
 * lowest non-empty bucket and let the person correct it, rather than asserting a
 * number the résumé does not support.
 */
export function estimateYearsBucket(
  experience: ReadonlyArray<{ startDate?: string | null }>,
  currentYear: number,
): TalentYearsBucket {
  if (experience.length === 0) return "sin_experiencia";

  const years = experience
    .map((e) => Number(parseExperienceDate(e.startDate).year))
    .filter((y) => Number.isFinite(y) && y > 1900 && y <= currentYear);

  if (years.length === 0) return "0_2";

  const span = currentYear - Math.min(...years);
  if (span >= 6) return "6_mas";
  if (span >= 3) return "3_5";
  return "0_2";
}

/**
 * The one-line headline under the name.
 *
 * Ordered by how much the person chose it: the role they said they want, then
 * the job they most recently held, then what they studied. The category label is
 * the last resort so a card is never headline-less.
 */
function buildHeadline(input: TalentProjectionInput): string {
  const fromRole = input.profile.targetRole?.trim();
  const fromJob = input.resume.experience.find((e) => e.title?.trim())?.title?.trim();
  const fromStudy = input.resume.education.find((e) => e.credential?.trim())?.credential?.trim();
  return clamp(fromRole || fromJob || fromStudy || labelForCategory(input.category), TALENT_LIMITS.headline);
}

// ─────────────────────────────────────────────────────────────────────────────
// The projection
// ─────────────────────────────────────────────────────────────────────────────

export function projectTalentProfile(input: TalentProjectionInput): TalentProjection {
  const { resume, personal } = input;

  const skills = [
    ...new Set(
      resume.skills
        .flatMap((group) => group.skills)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, TALENT_LIMITS.skills);

  const experience: TalentExperienceBlock[] = resume.experience
    .slice(0, TALENT_LIMITS.experiences)
    .map((block) => ({
      title: block.title,
      organization: block.organization,
      experienceType: block.experienceType ?? null,
      startDate: block.startDate,
      endDate: block.endDate,
      isCurrent: block.isCurrent,
      // Bullet TEXT only. `sourceEntryIds`/`sourceFields` are internal provenance
      // that ties a line back to a raw answer, and they stay server-side.
      bullets: block.bullets
        .slice(0, TALENT_LIMITS.bulletsPerExperience)
        .map((b) => clamp(b.text, TALENT_LIMITS.bullet))
        .filter(Boolean),
    }));

  const education: TalentEducationBlock[] = resume.education
    .slice(0, TALENT_LIMITS.education)
    .map((block) => ({
      institution: block.institution,
      credential: block.credential,
      fieldOfStudy: block.fieldOfStudy,
    }));

  const languages: TalentLanguageBlock[] = resume.languages
    .slice(0, TALENT_LIMITS.languages)
    .map((block) => ({ name: block.name, level: block.level }));

  const certifications = resume.certifications
    .slice(0, TALENT_LIMITS.certifications)
    .map((c) => c.name.trim())
    .filter(Boolean);

  // Structured fields first; the free-text `location` only fills what they leave
  // empty, so a captured "state" is never overwritten by a guess from a string.
  const fallback = splitLocation(input.profile.location);
  const city = personal?.city?.trim() || fallback.city;
  const state = personal?.state?.trim() || fallback.state;

  return {
    public: {
      slug: input.slug,
      displayName: publicDisplayName(personal),
      headline: buildHeadline(input),
      summary: clamp(resume.professionalSummary, TALENT_LIMITS.summary),
      category: input.category,
      skills,
      certifications,
      education,
      experience,
      languages,
      yearsBucket: input.yearsBucket,
      availability: input.availability,
      city,
      state,
      country: personal?.country?.trim() || null,
      publishedAt: input.publishedAt,
    },
    contact: {
      fullName:
        [personal?.firstName?.trim(), personal?.lastName?.trim()].filter(Boolean).join(" ") || null,
      email: personal?.email?.trim() || null,
      phone: personal?.phone?.trim() || null,
      linkedInUrl: personal?.linkedInUrl?.trim() || null,
      // The PDF for the résumé's own improvement round — see `resumePdfPath`.
      resumePdfPath: resume.pdfPath,
    },
  };
}
