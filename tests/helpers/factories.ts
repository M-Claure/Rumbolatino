/**
 * Test factories. Build valid domain/state objects with minimal overrides so
 * tests stay focused on the field(s) under test.
 */
import type {
  EducationEntryState,
  ExperienceEntryState,
  PersonalInformationState,
  ProjectState,
  ResumeProfileState,
  SkillState,
} from "@/types";
import {
  computeCompleteness,
  type CompletenessInput,
} from "@/lib/question-engine/completeness-engine";
import { estimateFunnelProgress } from "@/lib/question-engine/funnel-progress";

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

export function personalState(o: Partial<PersonalInformationState> = {}): PersonalInformationState {
  return {
    firstName: null,
    lastName: null,
    postalCode: null,
    city: null,
    state: null,
    country: null,
    hasPhone: false,
    hasEmail: false,
    hasLinkedIn: false,
    hasPortfolio: false,
    ...o,
  };
}

export function educationState(o: Partial<EducationEntryState> = {}): EducationEntryState {
  return {
    id: o.id ?? id("edu"),
    institution: null,
    credential: null,
    fieldOfStudy: null,
    location: null,
    startDate: null,
    endDate: null,
    isCurrent: false,
    relevantCoursework: [],
    projects: [],
    achievements: [],
    source: "user_entered",
    confirmationStatus: "confirmed",
    ...o,
  };
}

export function experienceState(o: Partial<ExperienceEntryState> = {}): ExperienceEntryState {
  return {
    id: o.id ?? id("exp"),
    experienceType: "formal_employment",
    title: null,
    organization: null,
    location: null,
    startDate: null,
    endDate: null,
    isCurrent: false,
    rawDescription: null,
    responsibilities: [],
    accomplishments: [],
    tools: [],
    peopleServed: null,
    metrics: [],
    source: "user_entered",
    confirmationStatus: "confirmed",
    ...o,
  };
}

export function projectState(o: Partial<ProjectState> = {}): ProjectState {
  return {
    id: o.id ?? id("proj"),
    name: o.name ?? "Proyecto",
    projectType: null,
    organization: null,
    startDate: null,
    endDate: null,
    description: null,
    responsibilities: [],
    outcomes: [],
    tools: [],
    confirmationStatus: "confirmed",
    ...o,
  };
}

export function skillState(o: Partial<SkillState> = {}): SkillState {
  return {
    id: o.id ?? id("skill"),
    name: o.name ?? "Habilidad",
    category: o.category ?? "general",
    proficiency: null,
    origin: "experience_inference",
    evidence: null,
    sourceEntryId: null,
    status: "suggested",
    ...o,
  };
}

export function completenessInput(o: Partial<CompletenessInput> = {}): CompletenessInput {
  return {
    resumeProfileId: o.resumeProfileId ?? id("profile"),
    careerGoal: o.careerGoal,
    targetRole: o.targetRole,
    interests: o.interests ?? [],
    personalInformation: o.personalInformation ?? personalState(),
    education: o.education ?? [],
    experience: o.experience ?? [],
    projects: o.projects ?? [],
    certifications: o.certifications ?? [],
    languages: o.languages ?? [],
    achievements: o.achievements ?? [],
    confirmedSkills: o.confirmedSkills ?? [],
    suggestedSkills: o.suggestedSkills ?? [],
    rejectedSkills: o.rejectedSkills ?? [],
    answeredQuestionIds: o.answeredQuestionIds ?? [],
    skippedQuestionIds: o.skippedQuestionIds ?? [],
    completedSections: o.completedSections ?? [],
    activeSection: o.activeSection ?? null,
    lastQuestionId: o.lastQuestionId ?? null,
  };
}

/**
 * A full `ResumeProfileState` from a `CompletenessInput`, built in the same two
 * phases as `assembleProfileState`: completeness first, then funnel progress
 * measured against it. Kept here so no test hand-rolls the order and drifts from
 * production.
 */
export function profileState(o: Partial<CompletenessInput> = {}): ResumeProfileState {
  return stateFrom(completenessInput(o));
}

/** Same, from an already-built input (e.g. `readyProfile()`). */
export function stateFrom(base: CompletenessInput): ResumeProfileState {
  const withCompleteness: ResumeProfileState = {
    ...base,
    completeness: computeCompleteness(base),
    funnelProgress: 0,
  };
  return { ...withCompleteness, funnelProgress: estimateFunnelProgress(withCompleteness) };
}

/** A profile that satisfies every critical requirement (ready to generate). */
export function readyProfile(o: Partial<CompletenessInput> = {}): CompletenessInput {
  return completenessInput({
    careerGoal: "Asistente administrativa",
    targetRole: "Asistente administrativa",
    personalInformation: personalState({ firstName: "María", lastName: "García", hasEmail: true, city: "Lima" }),
    education: [educationState({ institution: "Instituto Local", credential: "Secundaria", endDate: "2018" })],
    experience: [
      experienceState({
        experienceType: "family_business",
        organization: "Negocio familiar",
        responsibilities: ["Contestaba llamadas", "Organizaba citas"],
        startDate: "2019",
        endDate: "2021",
      }),
    ],
    confirmedSkills: [skillState({ name: "Atención al cliente", status: "confirmed" })],
    ...o,
  });
}
