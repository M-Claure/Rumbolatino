/**
 * The single server-side profile-state object that is safe to send to the
 * question-planning LLM (spec §5).
 *
 * Redaction policy: we withhold raw contact PII (phone, email, URLs) from the
 * model — it only needs to know *whether* contact info exists, not its value.
 * First name + coarse location are kept so questions can be personalized.
 */
import type {
  CompletenessReport,
  ConfirmationStatus,
  EntrySource,
  ExperienceType,
  LanguageLevel,
  ProficiencyLevel,
  ProjectType,
  ResumeSection,
  SkillOrigin,
  SkillStatus,
} from "./domain";

export interface PersonalInformationState {
  firstName: string | null;
  lastName: string | null;
  /** Coordinates are deliberately NOT here: the model has no use for them. */
  postalCode: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  // Presence-only flags — raw values are never sent to the model.
  hasPhone: boolean;
  hasEmail: boolean;
  hasLinkedIn: boolean;
  hasPortfolio: boolean;
}

export interface EducationEntryState {
  id: string;
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

export interface ExperienceEntryState {
  id: string;
  experienceType: ExperienceType;
  title: string | null;
  organization: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  rawDescription: string | null;
  responsibilities: string[];
  accomplishments: string[];
  tools: string[];
  peopleServed: string | null;
  metrics: string[];
  source: EntrySource;
  confirmationStatus: ConfirmationStatus;
}

export interface ProjectState {
  id: string;
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

export interface CertificationState {
  id: string;
  name: string;
  issuingOrganization: string | null;
  issueDate: string | null;
  expirationDate: string | null;
  confirmationStatus: ConfirmationStatus;
}

export interface LanguageState {
  id: string;
  name: string;
  speakingLevel: LanguageLevel | null;
  readingLevel: LanguageLevel | null;
  writingLevel: LanguageLevel | null;
  includeOnResume: boolean;
}

export interface AchievementState {
  id: string;
  title: string;
  organization: string | null;
  date: string | null;
  description: string | null;
  confirmationStatus: ConfirmationStatus;
}

export interface SkillState {
  id: string;
  name: string;
  category: string;
  proficiency: ProficiencyLevel | null;
  origin: SkillOrigin;
  evidence: string | null;
  sourceEntryId: string | null;
  status: SkillStatus;
}

export interface ResumeProfileState {
  resumeProfileId: string;
  careerGoal?: string;
  targetRole?: string;
  interests: string[];
  personalInformation: PersonalInformationState;
  education: EducationEntryState[];
  experience: ExperienceEntryState[];
  projects: ProjectState[];
  certifications: CertificationState[];
  languages: LanguageState[];
  achievements: AchievementState[];
  confirmedSkills: SkillState[];
  suggestedSkills: SkillState[];
  rejectedSkills: SkillState[];
  answeredQuestionIds: string[];
  skippedQuestionIds: string[];
  completedSections: ResumeSection[];
  activeSection: ResumeSection | null;
  lastQuestionId: string | null;
  completeness: CompletenessReport;
  /**
   * Progress through the funnel, 0..100 — the number behind the user's bar and
   * the one persisted to `funnel.progress_percentage`.
   *
   * Deliberately NOT `completeness.overallScore`, which is a data-quality score
   * that stalls, can move backwards, and cannot reach 100 by finishing the
   * funnel. See `lib/question-engine/funnel-progress.ts`.
   */
  funnelProgress: number;
}
