/**
 * Assembles the model-safe ResumeProfileState (spec §5) from persisted data.
 *
 * Responsibilities:
 *  - Read every section of a profile from the Store.
 *  - Redact contact PII (phone/email/URLs become presence-only booleans).
 *  - Partition skills by status (confirmed / suggested / rejected).
 *  - Compute the deterministic CompletenessReport and attach it.
 */
import type {
  Certification,
  EducationEntry,
  ExperienceEntry,
  Language,
  PersonalInformation,
  Project,
  Achievement,
  Skill,
} from "@/types";
import type {
  AchievementState,
  CertificationState,
  EducationEntryState,
  ExperienceEntryState,
  LanguageState,
  PersonalInformationState,
  ProjectState,
  ResumeProfileState,
  SkillState,
} from "@/types";
import type { Store } from "@/lib/repositories/store";
import { computeCompleteness } from "@/lib/question-engine/completeness-engine";
import { estimateFunnelProgress } from "@/lib/question-engine/funnel-progress";

export async function assembleProfileState(
  store: Store,
  profileId: string,
): Promise<ResumeProfileState> {
  const [
    profile,
    personal,
    education,
    experience,
    skills,
    certifications,
    languages,
    projects,
    achievements,
    questionState,
  ] = await Promise.all([
    store.getResumeProfile(profileId),
    store.getPersonalInformation(profileId),
    store.listEducation(profileId),
    store.listExperience(profileId),
    store.listSkills(profileId),
    store.listCertifications(profileId),
    store.listLanguages(profileId),
    store.listProjects(profileId),
    store.listAchievements(profileId),
    store.getQuestionState(profileId),
  ]);

  const confirmedSkills = skills.filter((s) => s.status === "confirmed" || s.status === "edited");
  const suggestedSkills = skills.filter((s) => s.status === "suggested");
  const rejectedSkills = skills.filter((s) => s.status === "rejected");

  const base: Omit<ResumeProfileState, "completeness" | "funnelProgress"> = {
    resumeProfileId: profileId,
    careerGoal: profile?.careerGoal ?? undefined,
    targetRole: profile?.targetRole ?? undefined,
    interests: profile?.interests ?? [],
    personalInformation: toPersonalState(personal),
    education: education.map(toEducationState),
    experience: experience.map(toExperienceState),
    projects: projects.map(toProjectState),
    certifications: certifications.map(toCertificationState),
    languages: languages.map(toLanguageState),
    achievements: achievements.map(toAchievementState),
    confirmedSkills: confirmedSkills.map(toSkillState),
    suggestedSkills: suggestedSkills.map(toSkillState),
    rejectedSkills: rejectedSkills.map(toSkillState),
    answeredQuestionIds: questionState?.askedQuestionIds ?? [],
    skippedQuestionIds: questionState?.skippedQuestionIds ?? [],
    completedSections: questionState?.completedSections ?? [],
    activeSection: questionState?.activeSection ?? profile?.currentSection ?? null,
    lastQuestionId: questionState?.lastQuestionId ?? null,
  };

  // Two phases, in this order: question eligibility depends on readiness, so
  // completeness has to exist before progress can be measured against it.
  const withCompleteness: ResumeProfileState = {
    ...base,
    completeness: computeCompleteness(base),
    funnelProgress: 0,
  };
  // Floored at what is already persisted, so a grown denominator can slow the bar
  // but never walk it backwards. Reads are idempotent — only `processAnswer`
  // advances the stored value.
  const funnelProgress = Math.max(
    profile?.progressPercentage ?? 0,
    estimateFunnelProgress(withCompleteness),
  );
  return { ...withCompleteness, funnelProgress };
}

// ── PII-redacting mappers (domain → state) ───────────────────────────────────

function toPersonalState(pi: PersonalInformation | null): PersonalInformationState {
  return {
    firstName: pi?.firstName ?? null,
    lastName: pi?.lastName ?? null,
    postalCode: pi?.postalCode ?? null,
    city: pi?.city ?? null,
    state: pi?.state ?? null,
    country: pi?.country ?? null,
    hasPhone: !!pi?.phone,
    hasEmail: !!pi?.email,
    hasLinkedIn: !!pi?.linkedInUrl,
    hasPortfolio: !!pi?.portfolioUrl,
  };
}

function toEducationState(e: EducationEntry): EducationEntryState {
  return {
    id: e.id,
    institution: e.institution,
    credential: e.credential,
    fieldOfStudy: e.fieldOfStudy,
    location: e.location,
    startDate: e.startDate,
    endDate: e.endDate,
    isCurrent: e.isCurrent,
    relevantCoursework: e.relevantCoursework,
    projects: e.projects,
    achievements: e.achievements,
    source: e.source,
    confirmationStatus: e.confirmationStatus,
  };
}

function toExperienceState(e: ExperienceEntry): ExperienceEntryState {
  return {
    id: e.id,
    experienceType: e.experienceType,
    title: e.title,
    organization: e.organization,
    location: e.location,
    startDate: e.startDate,
    endDate: e.endDate,
    isCurrent: e.isCurrent,
    rawDescription: e.rawDescription,
    responsibilities: e.responsibilities,
    accomplishments: e.accomplishments,
    tools: e.tools,
    peopleServed: e.peopleServed,
    metrics: e.metrics,
    source: e.source,
    confirmationStatus: e.confirmationStatus,
  };
}

function toProjectState(p: Project): ProjectState {
  return {
    id: p.id,
    name: p.name,
    projectType: p.projectType,
    organization: p.organization,
    startDate: p.startDate,
    endDate: p.endDate,
    description: p.description,
    responsibilities: p.responsibilities,
    outcomes: p.outcomes,
    tools: p.tools,
    confirmationStatus: p.confirmationStatus,
  };
}

function toCertificationState(c: Certification): CertificationState {
  return {
    id: c.id,
    name: c.name,
    issuingOrganization: c.issuingOrganization,
    issueDate: c.issueDate,
    expirationDate: c.expirationDate,
    confirmationStatus: c.confirmationStatus,
  };
}

function toLanguageState(l: Language): LanguageState {
  return {
    id: l.id,
    name: l.name,
    speakingLevel: l.speakingLevel,
    readingLevel: l.readingLevel,
    writingLevel: l.writingLevel,
    includeOnResume: l.includeOnResume,
  };
}

function toAchievementState(a: Achievement): AchievementState {
  return {
    id: a.id,
    title: a.title,
    organization: a.organization,
    date: a.date,
    description: a.description,
    confirmationStatus: a.confirmationStatus,
  };
}

function toSkillState(s: Skill): SkillState {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    proficiency: s.proficiency,
    origin: s.origin,
    evidence: s.evidence,
    sourceEntryId: s.sourceEntryId,
    status: s.status,
  };
}
