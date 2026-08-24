/**
 * Deterministic completeness engine (spec §6).
 *
 * PURE: no I/O, no LLM, no randomness. Given a profile snapshot it computes a
 * CompletenessReport that drives (a) the Review Dashboard, (b) which sections
 * the AI planner is allowed to ask about, and (c) resume readiness.
 *
 * Design principle from the spec: a user with NO formal employment can still be
 * complete. The "meaningful background" dimension is satisfied by education,
 * projects, achievements, or ANY experience entry (informal work, caregiving,
 * volunteering, entrepreneurship, etc.).
 */
import type {
  CompletenessReport,
  MissingField,
  ReadinessState,
  ResumeSection,
  SectionCompleteness,
  SectionStatus,
} from "@/types";
import type { ResumeProfileState } from "@/types";
import { isEducationBlank, isExperienceBlank, isProjectBlank } from "@/lib/entry-blankness";

/**
 * Everything the engine needs — the profile state minus the two values derived
 * FROM it. `funnelProgress` is excluded as well as the report: it is measured
 * against question eligibility, which depends on the readiness this engine
 * computes, so it cannot be an input here without a cycle.
 */
export type CompletenessInput = Omit<ResumeProfileState, "completeness" | "funnelProgress">;

const SKILLS_FOR_FULL_SCORE = 3;

// ─────────────────────────────────────────────────────────────────────────────

export function computeCompleteness(input: CompletenessInput): CompletenessReport {
  const pi = input.personalInformation;

  // ── Critical predicates (spec §6) ──
  const hasName = nonEmpty(pi.firstName);
  const hasContact = pi.hasEmail || pi.hasPhone;
  const hasObjective = nonEmpty(input.careerGoal) || nonEmpty(input.targetRole);
  // Counted by CONTENT, not by array length. An entry can exist with nothing in
  // it (the experience counter opens one per experience counted; "+ Agregar" on the
  // Review screen opens one directly), and an empty entry is not a background — it
  // used to satisfy readiness, reach the résumé, and then reach the improvement
  // loop, which had no name to refer to it by. See `lib/entry-blankness.ts`.
  const filledExperience = input.experience.filter((e) => !isExperienceBlank(e));
  const filledEducation = input.education.filter((e) => !isEducationBlank(e));
  const filledProjects = input.projects.filter((p) => !isProjectBlank(p));
  const blankEntryCount =
    input.experience.length -
    filledExperience.length +
    (input.education.length - filledEducation.length) +
    (input.projects.length - filledProjects.length);
  const hasMeaningfulBackground =
    filledEducation.length > 0 ||
    filledExperience.length > 0 ||
    filledProjects.length > 0 ||
    input.achievements.length > 0;
  const confirmedSkillCount = input.confirmedSkills.length;
  const hasConfirmedSkill = confirmedSkillCount > 0;

  // ── Per-section scores ──
  const careerScore = hasObjective ? 100 : 0;
  const identityScore = scoreIdentity(hasName, hasContact, pi);
  const educationScore = scoreEducationList(input);
  const experienceScore = scoreExperienceList(input);
  const projectScore = input.projects.length > 0 ? 80 : 0;
  const backgroundScore = Math.max(educationScore, experienceScore, projectScore);
  const skillsScore = hasConfirmedSkill
    ? Math.min(100, 30 + (confirmedSkillCount / SKILLS_FOR_FULL_SCORE) * 70)
    : 0;
  const languagesScore = input.languages.length > 0 ? 100 : 0;

  // ── Overall weighted score (optional sections excluded) ──
  const overallScore = weightedAverage([
    [careerScore, 2],
    [identityScore, 2],
    [backgroundScore, 3],
    [skillsScore, 2],
    [languagesScore, 1],
  ]);

  // ── Missing fields ──
  const missingCriticalFields: MissingField[] = [];
  if (!hasObjective)
    missingCriticalFields.push(mf("career_goal", "objective", "Objetivo profesional o puesto deseado"));
  if (!hasName) missingCriticalFields.push(mf("personal_information", "firstName", "Tu nombre"));
  if (!hasContact)
    missingCriticalFields.push(
      mf("personal_information", "contact", "Un medio de contacto (correo o teléfono)"),
    );
  if (!hasMeaningfulBackground)
    missingCriticalFields.push(
      mf("experience", "background", "Al menos una experiencia, educación o proyecto"),
    );
  if (!hasConfirmedSkill)
    missingCriticalFields.push(mf("skills", "confirmedSkill", "Al menos una habilidad confirmada"));
  // A blank entry must be filled in or deleted — never carried into a résumé.
  if (blankEntryCount > 0)
    missingCriticalFields.push(
      mf(
        "experience",
        "blankEntries",
        blankEntryCount === 1
          ? "Llena o borra la tarjeta que quedó vacía"
          : `Llena o borra las ${blankEntryCount} tarjetas que quedaron vacías`,
      ),
    );

  const missingHelpfulFields = collectHelpful(input, {
    hasContact,
    confirmedSkillCount,
    educationScore,
    experienceScore,
  });

  // ── Per-section breakdown ──
  const sections = buildSections(input, {
    careerScore,
    identityScore,
    educationScore,
    experienceScore,
    skillsScore,
    languagesScore,
    hasMeaningfulBackground,
  });

  const completedSections = sections.filter((s) => s.status === "complete").map((s) => s.section);
  const weakSections = sections.filter((s) => s.status === "partial").map((s) => s.section);

  const readyToGenerate =
    hasName &&
    hasContact &&
    hasObjective &&
    hasMeaningfulBackground &&
    hasConfirmedSkill &&
    blankEntryCount === 0;

  const readiness = deriveReadiness({
    hasMeaningfulBackground,
    readyToGenerate,
    hasHelpfulGaps: missingHelpfulFields.length > 0,
  });

  const recommendedSection = recommendSection(input, {
    hasObjective,
    hasName,
    hasContact,
    hasMeaningfulBackground,
    hasConfirmedSkill,
    readyToGenerate,
    weakSections,
  });

  return {
    overallScore,
    readyToGenerate,
    readiness,
    missingCriticalFields,
    missingHelpfulFields,
    completedSections,
    weakSections,
    recommendedSection,
    sections,
  };
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

function scoreIdentity(
  hasName: boolean,
  hasContact: boolean,
  pi: CompletenessInput["personalInformation"],
): number {
  let score = 0;
  if (hasName) score += 45;
  if (hasContact) score += 40;
  if (nonEmpty(pi.postalCode) || nonEmpty(pi.city) || nonEmpty(pi.country)) score += 15;
  return score;
}

function scoreEducationList(input: CompletenessInput): number {
  if (input.education.length === 0) return 0;
  const scores = input.education.map((e) => {
    let s = 40; // exists
    if (nonEmpty(e.institution)) s += 20;
    if (nonEmpty(e.credential) || nonEmpty(e.fieldOfStudy)) s += 25;
    if (nonEmpty(e.endDate) || e.isCurrent) s += 15;
    return Math.min(100, s);
  });
  return Math.round(avg(scores));
}

function scoreExperienceList(input: CompletenessInput): number {
  if (input.experience.length === 0) return 0;
  const scores = input.experience.map((e) => {
    let s = 30; // exists
    if (nonEmpty(e.title) || nonEmpty(e.organization)) s += 20;
    if (e.responsibilities.length > 0 || nonEmpty(e.rawDescription)) s += 25;
    if (e.accomplishments.length > 0 || e.metrics.length > 0) s += 10;
    if (nonEmpty(e.startDate) || nonEmpty(e.endDate) || e.isCurrent) s += 15;
    return Math.min(100, s);
  });
  return Math.round(avg(scores));
}

// ── Helpful (non-critical) gaps ─────────────────────────────────────────────

function collectHelpful(
  input: CompletenessInput,
  ctx: { hasContact: boolean; confirmedSkillCount: number; educationScore: number; experienceScore: number },
): MissingField[] {
  const out: MissingField[] = [];
  const pi = input.personalInformation;

  if (!nonEmpty(pi.lastName)) out.push(mf("personal_information", "lastName", "Tus apellidos"));
  if (!nonEmpty(pi.postalCode) && !nonEmpty(pi.city) && !nonEmpty(pi.country))
    out.push(mf("personal_information", "location", "Tu ciudad o país"));
  if (ctx.hasContact && !pi.hasLinkedIn)
    out.push(mf("personal_information", "linkedIn", "Tu perfil de LinkedIn (opcional)"));

  // Experience entries that lack detail.
  for (const e of input.experience) {
    if (e.responsibilities.length === 0 && !nonEmpty(e.rawDescription)) {
      out.push(mf("experience", `responsibilities:${e.id}`, "Detalles de lo que hacías en esa experiencia"));
    }
    if (!nonEmpty(e.startDate) && !nonEmpty(e.endDate) && !e.isCurrent) {
      out.push(mf("experience", `dates:${e.id}`, "Fechas aproximadas de esa experiencia"));
    }
  }

  // Education entries missing dates.
  for (const e of input.education) {
    if (!nonEmpty(e.endDate) && !e.isCurrent) {
      out.push(mf("education", `dates:${e.id}`, "Fecha en que terminaste esos estudios"));
    }
  }

  if (ctx.confirmedSkillCount > 0 && ctx.confirmedSkillCount < SKILLS_FOR_FULL_SCORE)
    out.push(mf("skills", "moreSkills", "Más habilidades confirmadas fortalecen tu CV"));

  if (input.languages.length === 0)
    out.push(mf("languages", "language", "Los idiomas que hablas"));

  return out;
}

// ── Per-section breakdown ───────────────────────────────────────────────────

interface SectionCtx {
  careerScore: number;
  identityScore: number;
  educationScore: number;
  experienceScore: number;
  skillsScore: number;
  languagesScore: number;
  hasMeaningfulBackground: boolean;
}

function buildSections(input: CompletenessInput, ctx: SectionCtx): SectionCompleteness[] {
  const status = (score: number, present: boolean): SectionStatus => {
    if (score >= 80) return "complete";
    if (present || score > 0) return "partial";
    return "missing";
  };

  return [
    { section: "career_goal", critical: true, score: ctx.careerScore, status: status(ctx.careerScore, false) },
    {
      section: "personal_information",
      critical: true,
      score: ctx.identityScore,
      status: status(ctx.identityScore, false),
    },
    {
      section: "education",
      critical: false,
      score: ctx.educationScore,
      status: sectionStatusForBackground(ctx.educationScore, input.education.length > 0),
    },
    {
      section: "experience",
      critical: true, // critical as a group; see below
      score: ctx.experienceScore,
      status: experienceStatus(input, ctx),
    },
    {
      section: "skills",
      critical: true,
      score: ctx.skillsScore,
      status: status(ctx.skillsScore, input.suggestedSkills.length > 0),
    },
    optionalSection("certifications", input.certifications.length),
    {
      section: "languages",
      critical: false,
      score: ctx.languagesScore,
      status: ctx.languagesScore >= 80 ? "complete" : "missing",
    },
    optionalSection("projects", input.projects.length),
    optionalSection("achievements", input.achievements.length),
    { section: "review", critical: false, score: 0, status: "optional" },
  ];
}

function sectionStatusForBackground(score: number, present: boolean): SectionStatus {
  if (score >= 80) return "complete";
  if (present) return "partial";
  return "optional";
}

function experienceStatus(input: CompletenessInput, ctx: SectionCtx): SectionStatus {
  // Experience is the anchor of "meaningful background". If the user has any
  // background at all it counts; the section is only truly "missing" when there
  // is no background anywhere.
  if (input.experience.length === 0) {
    return ctx.hasMeaningfulBackground ? "optional" : "missing";
  }
  if (ctx.experienceScore >= 80) return "complete";
  return "partial";
}

function optionalSection(section: ResumeSection, count: number): SectionCompleteness {
  return {
    section,
    critical: false,
    score: count > 0 ? 100 : 0,
    status: count > 0 ? "complete" : "optional",
  };
}

// ── Readiness (spec §13) ────────────────────────────────────────────────────

function deriveReadiness(ctx: {
  hasMeaningfulBackground: boolean;
  readyToGenerate: boolean;
  hasHelpfulGaps: boolean;
}): ReadinessState {
  if (!ctx.hasMeaningfulBackground) return "insufficient_information";
  if (!ctx.readyToGenerate) return "partially_ready";
  return ctx.hasHelpfulGaps ? "ready_but_improvable" : "ready";
}

// ── Recommended next section (deterministic ladder, spec §7) ────────────────

function recommendSection(
  input: CompletenessInput,
  ctx: {
    hasObjective: boolean;
    hasName: boolean;
    hasContact: boolean;
    hasMeaningfulBackground: boolean;
    hasConfirmedSkill: boolean;
    readyToGenerate: boolean;
    weakSections: ResumeSection[];
  },
): ResumeSection {
  if (!ctx.hasObjective) return "career_goal";
  if (!ctx.hasName || !ctx.hasContact) return "personal_information";
  // Pending skill suggestions should be confirmed before we keep exploring.
  if (input.suggestedSkills.length > 0) return "skills";
  // Education-first when there's no background yet (easier for low-experience users).
  if (!ctx.hasMeaningfulBackground) {
    return input.education.length === 0 ? "education" : "experience";
  }
  // We have background but no experience captured — probe transferable experience.
  if (input.experience.length === 0 && input.projects.length === 0) return "experience";
  // Evidence exists but no confirmed skills — go confirm skills.
  if (!ctx.hasConfirmedSkill) return "skills";
  // Otherwise nudge toward the weakest non-optional section, else review.
  const priority: ResumeSection[] = ["experience", "education", "skills", "personal_information"];
  const weak = priority.find((s) => ctx.weakSections.includes(s));
  if (weak && !ctx.readyToGenerate) return weak;
  return "review";
}

// ── Small utilities ──────────────────────────────────────────────────────────

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}
function weightedAverage(pairs: Array<[number, number]>): number {
  const totalWeight = pairs.reduce((a, [, w]) => a + w, 0);
  if (totalWeight === 0) return 0;
  const sum = pairs.reduce((a, [score, w]) => a + score * w, 0);
  return Math.round(sum / totalWeight);
}
function mf(section: ResumeSection, field: string, label: string): MissingField {
  return { section, field, label };
}
