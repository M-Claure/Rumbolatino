/**
 * Entity construction shared by every `Store` implementation.
 *
 * These are the defaults that decide what a newly captured entry *is* — including
 * the safety-critical one: a skill is born `suggested`, never `confirmed`, so only
 * an explicit user action can put it on a résumé (see `lib/skills/`).
 *
 * They live here rather than in each store because `MemoryStore` and
 * `SupabaseStore` must agree exactly. The unit suite exercises `MemoryStore`; if
 * the Supabase implementation re-declared these defaults, a divergence would only
 * ever surface in production. Sharing them makes parity structural instead of
 * a thing to remember.
 *
 * Pure: no I/O, no `server-only` imports. Ids and timestamps are the only
 * non-determinism, and both are generated here so the two stores cannot drift.
 */
import { randomUUID } from "node:crypto";
import type {
  Achievement,
  Certification,
  ConversationTurn,
  EducationEntry,
  ExperienceEntry,
  GeneratedResume,
  Language,
  PersonalInformation,
  Project,
  QuestionState,
  ResumeProfile,
  Skill,
} from "@/types";
import type {
  CreateAchievementInput,
  CreateCertificationInput,
  CreateConversationTurnInput,
  CreateEducationInput,
  CreateExperienceInput,
  CreateGeneratedResumeInput,
  CreateLanguageInput,
  CreateProfileInput,
  CreateProjectInput,
  CreateSkillInput,
} from "./store";

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => randomUUID();

/** Deep copy, so a caller can never mutate a store's internal state by reference. */
export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Remove keys whose value is `undefined` so a patch never nulls existing fields. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function buildProfile(userId: string, input: CreateProfileInput): ResumeProfile {
  return {
    id: newId(),
    userId,
    status: input.status ?? "draft",
    targetRole: input.targetRole ?? null,
    careerGoal: input.careerGoal ?? null,
    location: input.location ?? null,
    interests: input.interests ?? [],
    progressPercentage: input.progressPercentage ?? 0,
    currentSection: input.currentSection ?? "career_goal",
    finalizedAt: input.finalizedAt ?? null,
    termsAcceptedAt: input.termsAcceptedAt ?? null,
    termsVersion: input.termsVersion ?? null,
    publishConsentAt: input.publishConsentAt ?? null,
    publishConsentVersion: input.publishConsentVersion ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

export function emptyPersonalInformation(profileId: string): PersonalInformation {
  return {
    resumeProfileId: profileId,
    firstName: null,
    lastName: null,
    city: null,
    state: null,
    country: null,
    phone: null,
    email: null,
    linkedInUrl: null,
    portfolioUrl: null,
  };
}

export function buildEducation(profileId: string, input: CreateEducationInput): EducationEntry {
  return {
    id: newId(),
    resumeProfileId: profileId,
    institution: input.institution ?? null,
    credential: input.credential ?? null,
    fieldOfStudy: input.fieldOfStudy ?? null,
    location: input.location ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    isCurrent: input.isCurrent ?? false,
    relevantCoursework: input.relevantCoursework ?? [],
    projects: input.projects ?? [],
    achievements: input.achievements ?? [],
    source: input.source ?? "user_entered",
    confirmationStatus: input.confirmationStatus ?? "confirmed",
  };
}

export function buildExperience(profileId: string, input: CreateExperienceInput): ExperienceEntry {
  return {
    id: newId(),
    resumeProfileId: profileId,
    experienceType: input.experienceType,
    title: input.title ?? null,
    organization: input.organization ?? null,
    location: input.location ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    isCurrent: input.isCurrent ?? false,
    rawDescription: input.rawDescription ?? null,
    responsibilities: input.responsibilities ?? [],
    accomplishments: input.accomplishments ?? [],
    tools: input.tools ?? [],
    peopleServed: input.peopleServed ?? null,
    metrics: input.metrics ?? [],
    source: input.source ?? "user_entered",
    confirmationStatus: input.confirmationStatus ?? "confirmed",
  };
}

/**
 * SAFETY: `status` defaults to `suggested`. An inferred skill must never enter a
 * résumé without an explicit user confirmation — enforced here so no store can
 * default it otherwise.
 */
export function buildSkill(profileId: string, input: CreateSkillInput): Skill {
  return {
    id: newId(),
    resumeProfileId: profileId,
    name: input.name,
    category: input.category ?? "general",
    proficiency: input.proficiency ?? null,
    origin: input.origin ?? "user_entered",
    evidence: input.evidence ?? null,
    sourceEntryId: input.sourceEntryId ?? null,
    status: input.status ?? "suggested",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

export function buildCertification(
  profileId: string,
  input: CreateCertificationInput,
): Certification {
  return {
    id: newId(),
    resumeProfileId: profileId,
    name: input.name,
    issuingOrganization: input.issuingOrganization ?? null,
    issueDate: input.issueDate ?? null,
    expirationDate: input.expirationDate ?? null,
    credentialId: input.credentialId ?? null,
    credentialUrl: input.credentialUrl ?? null,
    confirmationStatus: input.confirmationStatus ?? "confirmed",
  };
}

export function buildLanguage(profileId: string, input: CreateLanguageInput): Language {
  return {
    id: newId(),
    resumeProfileId: profileId,
    name: input.name,
    speakingLevel: input.speakingLevel ?? null,
    readingLevel: input.readingLevel ?? null,
    writingLevel: input.writingLevel ?? null,
    includeOnResume: input.includeOnResume ?? true,
  };
}

export function buildProject(profileId: string, input: CreateProjectInput): Project {
  return {
    id: newId(),
    resumeProfileId: profileId,
    name: input.name,
    projectType: input.projectType ?? null,
    organization: input.organization ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    description: input.description ?? null,
    responsibilities: input.responsibilities ?? [],
    outcomes: input.outcomes ?? [],
    tools: input.tools ?? [],
    confirmationStatus: input.confirmationStatus ?? "confirmed",
  };
}

export function buildAchievement(profileId: string, input: CreateAchievementInput): Achievement {
  return {
    id: newId(),
    resumeProfileId: profileId,
    title: input.title,
    organization: input.organization ?? null,
    date: input.date ?? null,
    description: input.description ?? null,
    confirmationStatus: input.confirmationStatus ?? "confirmed",
  };
}

export function buildConversationTurn(
  profileId: string,
  input: CreateConversationTurnInput,
): ConversationTurn {
  return {
    id: newId(),
    resumeProfileId: profileId,
    questionId: input.questionId,
    section: input.section,
    assistantMessage: input.assistantMessage,
    userAnswer: input.userAnswer ?? null,
    normalizedAnswer: input.normalizedAnswer ?? null,
    skipped: input.skipped ?? false,
    timeSpentMs: input.timeSpentMs ?? null,
    attemptNumber: input.attemptNumber ?? 1,
    createdAt: nowIso(),
  };
}

export function emptyQuestionState(profileId: string): QuestionState {
  return {
    resumeProfileId: profileId,
    askedQuestionIds: [],
    skippedQuestionIds: [],
    completedSections: [],
    activeSection: null,
    lastQuestionId: null,
    lastShownQuestionId: null,
    lastShownAt: null,
    lastUpdatedAt: nowIso(),
  };
}

export function buildGeneratedResume(
  profileId: string,
  input: CreateGeneratedResumeInput,
  nextVersion: number,
): GeneratedResume {
  return {
    id: newId(),
    resumeProfileId: profileId,
    version: input.version ?? nextVersion,
    stage: input.stage ?? 0,
    professionalSummary: input.professionalSummary ?? "",
    skills: input.skills ?? [],
    experience: input.experience ?? [],
    education: input.education ?? [],
    certifications: input.certifications ?? [],
    projects: input.projects ?? [],
    languages: input.languages ?? [],
    html: input.html ?? "",
    pdfPath: input.pdfPath ?? null,
    createdAt: nowIso(),
  };
}
