/**
 * Core normalized domain model for "Mi CV con IA".
 *
 * Conventions:
 * - All identifiers are strings (UUIDs from Postgres).
 * - Timestamps are ISO-8601 strings.
 * - Dates on entries (start/end) are free-form strings so we can preserve
 *   approximate values ("2020", "mediados de 2019") — we NEVER coerce an
 *   approximate date into an exact one (see AI safety rules).
 * - User-facing text is Spanish; field names/enums are English for code clarity.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared enums / unions
// ─────────────────────────────────────────────────────────────────────────────

export const RESUME_SECTIONS = [
  "career_goal",
  "personal_information",
  "education",
  "experience",
  "skills",
  "certifications",
  "languages",
  "projects",
  "achievements",
  "review",
] as const;
export type ResumeSection = (typeof RESUME_SECTIONS)[number];

export const RESUME_STATUSES = [
  "draft",
  "collecting_information",
  "ready_for_review",
  "generating",
  "generated",
  "archived",
] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];

export const EXPERIENCE_TYPES = [
  "formal_employment",
  "self_employment",
  "business_owner",
  "freelance",
  "informal_work",
  "family_business",
  "volunteering",
  "internship",
  "school_project",
  "caregiving",
  "personal_project",
  "other",
] as const;
export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];

export const SKILL_ORIGINS = [
  "user_entered",
  "education_inference",
  "experience_inference",
  "project_inference",
  "certification_inference",
] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export const SKILL_STATUSES = ["suggested", "confirmed", "rejected", "edited"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/**
 * Confirmation lifecycle for entries the AI may have normalized/interpreted.
 * - `confirmed`: user-provided fact or user-approved interpretation.
 * - `needs_review`: AI made a material interpretation awaiting user confirmation.
 * - `edited`: user modified the AI/normalized value (counts as confirmed).
 * - `rejected`: user rejected the entry (excluded from the resume).
 */
export const CONFIRMATION_STATUSES = ["confirmed", "needs_review", "edited", "rejected"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

/** Provenance of a structured entry. */
export const ENTRY_SOURCES = ["user_entered", "ai_extracted"] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const PROFICIENCY_LEVELS = ["basic", "intermediate", "advanced", "expert"] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

/** Descriptive language competence levels (Spanish-facing labels handled in UI). */
export const LANGUAGE_LEVELS = ["basico", "intermedio", "avanzado", "nativo"] as const;
export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];

/**
 * The languages a rendered résumé can be written in.
 *
 * Not to be confused with `LANGUAGE_LEVELS` above, which is about languages the
 * USER speaks — a captured résumé section. This is the language of the DOCUMENT.
 * The product is Spanish-first: "es" is what the funnel produces, and "en" is a
 * translation of a finished Spanish résumé (see `lib/resume/translate-resume.ts`).
 */
export const RESUME_LANGUAGES = ["es", "en"] as const;
export type ResumeLang = (typeof RESUME_LANGUAGES)[number];

export const PROJECT_TYPES = [
  "personal",
  "academic",
  "professional",
  "volunteer",
  "other",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const READINESS_STATES = [
  "insufficient_information",
  "partially_ready",
  "ready",
  "ready_but_improvable",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** Entry confirmation statuses that make an entry eligible for the resume. */
export const RESUME_ELIGIBLE_CONFIRMATIONS: ReadonlyArray<ConfirmationStatus> = [
  "confirmed",
  "edited",
];

/** Skill statuses that make a skill eligible for the resume. */
export const RESUME_ELIGIBLE_SKILL_STATUSES: ReadonlyArray<SkillStatus> = ["confirmed", "edited"];

// ─────────────────────────────────────────────────────────────────────────────
// Persisted entities (spec §4)
// ─────────────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  preferredLanguage: string; // e.g. "es"
  onboardingCompleted: boolean;
}

export interface ResumeProfile {
  id: string;
  userId: string;
  status: ResumeStatus;
  targetRole: string | null;
  careerGoal: string | null;
  location: string | null;
  /** Personal interests / hobbies (optional résumé section). */
  interests: string[];
  progressPercentage: number; // 0..100
  currentSection: ResumeSection | null;
  /** When the user finalized the résumé (locking it for download). null = not
   * finalized. Regenerating/editing clears this so the CV must be re-finalized. */
  finalizedAt: string | null;
  /** When the user accepted the terms & conditions (ISO timestamp). Set once at
   * profile creation; null only for legacy profiles created before consent was
   * required. Proof-of-consent for compliance. */
  termsAcceptedAt: string | null;
  /** The terms version (see `lib/legal/terms.ts`) the user accepted. */
  termsVersion: string | null;
  /**
   * When the user consented to PUBLISHING a directory profile, and to which
   * version of the publish notice (`PUBLISH_TERMS_VERSION`).
   *
   * Deliberately separate from `termsAcceptedAt`. That one covers building a
   * résumé — a private document only its author can read. This one covers
   * putting a name, a work history and a way to be contacted somewhere strangers
   * can find it, which is a different act with different consequences, and
   * consent to the first has never implied consent to the second. Never infer
   * one from the other, and never set this anywhere but the publish route.
   */
  publishConsentAt: string | null;
  publishConsentVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalInformation {
  resumeProfileId: string;
  firstName: string | null;
  lastName: string | null;
  /**
   * US ZIP code, five digits — the ONE location question the funnel asks.
   *
   * A ZIP is faster to type than a city, unambiguous where a city name is not
   * ("Springfield"), and it is the only form of the answer that yields
   * coordinates, which is what makes "employers near me" possible at all.
   * `city`, `state` and the coordinates below are all DERIVED from it by
   * `lib/geo/zip-lookup.ts` at capture time — the person is never asked twice.
   *
   * Null for anyone outside the US, who answers the same question with free
   * text that lands in `city`. They simply do not appear in radius searches.
   */
  postalCode: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  linkedInUrl: string | null;
  portfolioUrl: string | null;
  /**
   * The ZIP's centroid, not the person's address — we never ask for one.
   *
   * A ZIP is an AREA, sometimes a large rural one, so this is accurate to the
   * middle of that area and can be several miles from where someone actually
   * lives. Good enough for "who is near me"; never present it as an exact
   * distance to a person, and never plot it as their home.
   */
  latitude: number | null;
  longitude: number | null;
}

export interface EducationEntry {
  id: string;
  resumeProfileId: string;
  institution: string | null;
  credential: string | null;
  fieldOfStudy: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  relevantCoursework: string[];
  projects: string[];
  achievements: string[];
  source: EntrySource;
  confirmationStatus: ConfirmationStatus;
}

export interface ExperienceEntry {
  id: string;
  resumeProfileId: string;
  experienceType: ExperienceType;
  title: string | null;
  organization: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  /** Original, unedited user wording — always preserved (spec §9). */
  rawDescription: string | null;
  responsibilities: string[];
  accomplishments: string[];
  tools: string[];
  peopleServed: string | null;
  metrics: string[];
  source: EntrySource;
  confirmationStatus: ConfirmationStatus;
}

export interface Skill {
  id: string;
  resumeProfileId: string;
  name: string;
  category: string;
  proficiency: ProficiencyLevel | null;
  origin: SkillOrigin;
  /** Evidence from the user's own words that supports the suggestion. */
  evidence: string | null;
  /** The entry (experience/education/project) the inference came from. */
  sourceEntryId: string | null;
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Certification {
  id: string;
  resumeProfileId: string;
  name: string;
  issuingOrganization: string | null;
  issueDate: string | null;
  expirationDate: string | null;
  credentialId: string | null;
  credentialUrl: string | null;
  confirmationStatus: ConfirmationStatus;
}

export interface Language {
  id: string;
  resumeProfileId: string;
  name: string;
  speakingLevel: LanguageLevel | null;
  readingLevel: LanguageLevel | null;
  writingLevel: LanguageLevel | null;
  includeOnResume: boolean;
}

export interface Project {
  id: string;
  resumeProfileId: string;
  name: string;
  projectType: ProjectType | null;
  organization: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  responsibilities: string[];
  outcomes: string[];
  tools: string[];
  confirmationStatus: ConfirmationStatus;
}

export interface Achievement {
  id: string;
  resumeProfileId: string;
  title: string;
  organization: string | null;
  date: string | null;
  description: string | null;
  confirmationStatus: ConfirmationStatus;
}

export interface ConversationTurn {
  id: string;
  resumeProfileId: string;
  questionId: string;
  section: ResumeSection;
  assistantMessage: string;
  userAnswer: string | null;
  /** Structured interpretation of the answer (JSON). */
  normalizedAnswer: unknown | null;
  skipped: boolean;
  /** Client-reported wall time from question shown to answer submitted. */
  timeSpentMs: number | null;
  /** Nth time this questionId has been recorded for this profile (1-based). */
  attemptNumber: number;
  createdAt: string;
}

export interface QuestionState {
  resumeProfileId: string;
  askedQuestionIds: string[];
  skippedQuestionIds: string[];
  completedSections: ResumeSection[];
  activeSection: ResumeSection | null;
  /** Last question the user answered or skipped. */
  lastQuestionId: string | null;
  /**
   * Last question the user was *shown*. When a profile stalls this is the exit
   * point — `lastQuestionId` only records questions that got a response.
   */
  lastShownQuestionId: string | null;
  lastShownAt: string | null;
  lastUpdatedAt: string;
}

export interface GeneratedResume {
  id: string;
  resumeProfileId: string;
  /**
   * Monotonic per-generation counter. Counts EVERY generation — including
   * proofreads and section regenerations — so it is not the improvement round.
   */
  version: number;
  /**
   * Improvement round this résumé belongs to: 0 for the initial generation,
   * 1..MAX_RESUME_ITERATIONS after that round. It selects which PDF object the
   * render is stored as, so it must be the ROUND and not the version — a
   * mid-round regeneration re-renders the open round's PDF rather than claiming
   * the next one.
   */
  stage: number;
  professionalSummary: string;
  skills: GeneratedSkillGroup[];
  experience: GeneratedExperienceBlock[];
  education: GeneratedEducationBlock[];
  certifications: GeneratedCertificationBlock[];
  projects: GeneratedProjectBlock[];
  languages: GeneratedLanguageBlock[];
  html: string;
  /**
   * Storage object path of this résumé's saved PDF, or null if none was stored.
   *
   * One object per `stage`, so a profile holds up to four: the initial
   * `curriculum.pdf` plus `iteration-1..3.pdf`. Within a stage every generation
   * replaces the object. See `lib/storage/resume-file-store.ts`.
   */
  pdfPath: string | null;
  createdAt: string;
}

/**
 * A finished résumé rendered in another language.
 *
 * It is a TRANSLATION of `GeneratedResume`, never an independent generation: the
 * same blocks, the same `entryId`s and the same source traces, with only the prose
 * and the human-readable labels swapped. That is what guarantees the two documents
 * say the same thing, and it is why no new fact can appear in one and not the
 * other — the model is never shown the source data, only the résumé it already
 * wrote.
 *
 * Stored as parallel columns on the `funnel` row (0010), following the precedent
 * 0008 set when it collapsed `resume_pdfs` into columns: there is exactly one
 * translation per language per profile, so a table would be a 1:1 join in every
 * path that touched it.
 */
export interface TranslatedResume {
  resumeProfileId: string;
  language: ResumeLang;
  /**
   * The `GeneratedResume.version` this was translated from.
   *
   * This is the staleness check, and the reason a translation is not silently
   * regenerated: when the Spanish résumé moves ahead (a regenerate, a proofread,
   * an edit) this trails `resume.version` and the UI offers to re-translate rather
   * than spending a model call nobody asked for.
   */
  sourceVersion: number;
  professionalSummary: string;
  skills: GeneratedSkillGroup[];
  experience: GeneratedExperienceBlock[];
  education: GeneratedEducationBlock[];
  certifications: GeneratedCertificationBlock[];
  projects: GeneratedProjectBlock[];
  languages: GeneratedLanguageBlock[];
  /*
   * The three strings the document prints that do NOT live on `GeneratedResume`.
   *
   * `renderResumeHtml` assembles its model from the résumé PLUS the profile
   * (`targetRole`/`careerGoal`, `interests`) and the personal-information row
   * (city/state/country). Those are Spanish too, so a translation that stored only
   * the résumé blocks would render an English document under a Spanish job title.
   * The person's NAME and contact details are deliberately not here — they are
   * proper nouns and are re-read untranslated at render time.
   */
  /** Translated `targetRole ?? careerGoal` — the line under the name. */
  headline: string | null;
  /** Translated city/state/country line. */
  location: string | null;
  /** Translated interests. */
  interests: string[];
  html: string;
  /**
   * Storage object path of this translation's saved PDF, or null if none was
   * stored. ONE object per language — unlike the Spanish résumé there is no
   * per-round history, because a translation only ever mirrors the current
   * résumé. See `lib/storage/resume-file-store.ts`.
   */
  pdfPath: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generated resume sub-shapes (with source tracing — spec §12)
// ─────────────────────────────────────────────────────────────────────────────

/** A single generated line traced back to the source data it was built from. */
export interface GeneratedBullet {
  text: string;
  sourceEntryIds: string[];
  sourceFields: string[];
}

export interface GeneratedSkillGroup {
  category: string;
  skills: string[];
  sourceSkillIds: string[];
}

export interface GeneratedExperienceBlock {
  entryId: string;
  title: string | null;
  organization: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  bullets: GeneratedBullet[];
  /**
   * The kind of experience this was. Carried onto the block so the renderer has a
   * meaningful heading when neither a job title nor an employer exists — which is
   * the norm for this product's users: "cuidaba a mi abuela" has no title and no
   * organization, and heading such an entry "Experiencia" tells a reader nothing.
   *
   * Optional because résumés generated before this field existed are stored as
   * JSON and will not have it.
   */
  experienceType?: ExperienceType;
}

export interface GeneratedEducationBlock {
  entryId: string;
  institution: string | null;
  credential: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  details: GeneratedBullet[];
}

export interface GeneratedCertificationBlock {
  entryId: string;
  name: string;
  issuingOrganization: string | null;
  issueDate: string | null;
}

export interface GeneratedProjectBlock {
  entryId: string;
  name: string;
  bullets: GeneratedBullet[];
}

export interface GeneratedLanguageBlock {
  entryId: string;
  name: string;
  level: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Completeness report (spec §6) + readiness (spec §13)
// ─────────────────────────────────────────────────────────────────────────────

export interface MissingField {
  section: ResumeSection;
  field: string;
  /** Spanish label shown to the user. */
  label: string;
}

/** Per-section status used by the Review Dashboard (Completo/Parcial/etc.). */
export type SectionStatus = "complete" | "partial" | "missing" | "optional";

export interface SectionCompleteness {
  section: ResumeSection;
  status: SectionStatus;
  score: number; // 0..100
  /** True when this section is required for a truthful resume. */
  critical: boolean;
}

export interface CompletenessReport {
  overallScore: number; // 0..100
  readyToGenerate: boolean;
  readiness: ReadinessState;
  missingCriticalFields: MissingField[];
  missingHelpfulFields: MissingField[];
  completedSections: ResumeSection[];
  weakSections: ResumeSection[];
  recommendedSection: ResumeSection;
  /** Per-section breakdown (extension used by the review UI). */
  sections: SectionCompleteness[];
}
