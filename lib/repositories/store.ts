/**
 * Persistence abstraction. Domain/service code depends ONLY on this interface,
 * never on Supabase or SQL directly. Two implementations exist:
 *  - MemoryStore   (in-process; PERSISTENCE=memory; used for local dev + tests)
 *  - SupabaseStore (Postgres via Supabase; PERSISTENCE=supabase)
 *
 * All methods are scoped by ownership at the call site (route handlers resolve
 * the authenticated user and pass verified ids); the SupabaseStore additionally
 * relies on RLS as defense-in-depth.
 */
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
  ResumeLang,
  ResumeProfile,
  Skill,
  TranslatedResume,
  User,
} from "@/types";

/** Data fields of an entity, without server-managed keys. */
type Data<T> = Omit<T, "id" | "resumeProfileId" | "createdAt" | "updatedAt">;

export type CreateProfileInput = Partial<
  Pick<
    ResumeProfile,
    | "status"
    | "targetRole"
    | "careerGoal"
    | "location"
    | "interests"
    | "currentSection"
    | "progressPercentage"
    | "finalizedAt"
    | "termsAcceptedAt"
    | "termsVersion"
    | "publishConsentAt"
    | "publishConsentVersion"
  >
>;
export type UpdateProfileInput = CreateProfileInput;

export type PersonalInformationInput = Partial<Data<PersonalInformation>>;

export type CreateEducationInput = Partial<Data<EducationEntry>>;
export type UpdateEducationInput = Partial<Data<EducationEntry>>;

export type CreateExperienceInput = Partial<Data<ExperienceEntry>> & {
  experienceType: ExperienceEntry["experienceType"];
};
export type UpdateExperienceInput = Partial<Data<ExperienceEntry>>;

export type CreateSkillInput = Partial<Data<Skill>> & { name: string };
export type UpdateSkillInput = Partial<Data<Skill>>;

export type CreateCertificationInput = Partial<Data<Certification>> & { name: string };
export type UpdateCertificationInput = Partial<Data<Certification>>;

export type CreateLanguageInput = Partial<Data<Language>> & { name: string };
export type UpdateLanguageInput = Partial<Data<Language>>;

export type CreateProjectInput = Partial<Data<Project>> & { name: string };
export type UpdateProjectInput = Partial<Data<Project>>;

export type CreateAchievementInput = Partial<Data<Achievement>> & { title: string };
export type UpdateAchievementInput = Partial<Data<Achievement>>;

export type CreateConversationTurnInput = Partial<Data<ConversationTurn>> & {
  questionId: string;
  section: ConversationTurn["section"];
  assistantMessage: string;
};

export type QuestionStateInput = Partial<Data<QuestionState>>;

export type CreateGeneratedResumeInput = Partial<Data<GeneratedResume>>;

/**
 * A translation to store. `language` and `sourceVersion` are required because
 * neither has a safe default: guessing the language would write the English
 * document into the Spanish slot, and a missing `sourceVersion` would make a
 * translation permanently look current.
 */
export type SaveTranslatedResumeInput = Partial<Data<TranslatedResume>> & {
  language: ResumeLang;
  sourceVersion: number;
};


export interface Store {
  // Users
  getUser(userId: string): Promise<User | null>;
  upsertUser(user: { id: string; email: string; preferredLanguage?: string }): Promise<User>;

  // Resume profiles
  createResumeProfile(userId: string, input: CreateProfileInput): Promise<ResumeProfile>;
  getResumeProfile(id: string): Promise<ResumeProfile | null>;
  listResumeProfilesByUser(userId: string): Promise<ResumeProfile[]>;
  updateResumeProfile(id: string, patch: UpdateProfileInput): Promise<ResumeProfile>;

  // Personal information (1:1)
  getPersonalInformation(profileId: string): Promise<PersonalInformation | null>;
  upsertPersonalInformation(
    profileId: string,
    patch: PersonalInformationInput,
  ): Promise<PersonalInformation>;

  // Education
  createEducation(profileId: string, input: CreateEducationInput): Promise<EducationEntry>;
  getEducation(entryId: string): Promise<EducationEntry | null>;
  listEducation(profileId: string): Promise<EducationEntry[]>;
  updateEducation(entryId: string, patch: UpdateEducationInput): Promise<EducationEntry>;
  deleteEducation(entryId: string): Promise<void>;

  // Experience
  createExperience(profileId: string, input: CreateExperienceInput): Promise<ExperienceEntry>;
  getExperience(entryId: string): Promise<ExperienceEntry | null>;
  listExperience(profileId: string): Promise<ExperienceEntry[]>;
  updateExperience(entryId: string, patch: UpdateExperienceInput): Promise<ExperienceEntry>;
  deleteExperience(entryId: string): Promise<void>;

  // Skills
  createSkill(profileId: string, input: CreateSkillInput): Promise<Skill>;
  getSkill(skillId: string): Promise<Skill | null>;
  listSkills(profileId: string): Promise<Skill[]>;
  findSkillByName(profileId: string, name: string): Promise<Skill | null>;
  updateSkill(skillId: string, patch: UpdateSkillInput): Promise<Skill>;
  deleteSkill(skillId: string): Promise<void>;

  // Certifications
  createCertification(profileId: string, input: CreateCertificationInput): Promise<Certification>;
  getCertification(id: string): Promise<Certification | null>;
  listCertifications(profileId: string): Promise<Certification[]>;
  updateCertification(id: string, patch: UpdateCertificationInput): Promise<Certification>;
  deleteCertification(id: string): Promise<void>;

  // Languages
  createLanguage(profileId: string, input: CreateLanguageInput): Promise<Language>;
  getLanguage(id: string): Promise<Language | null>;
  listLanguages(profileId: string): Promise<Language[]>;
  updateLanguage(id: string, patch: UpdateLanguageInput): Promise<Language>;
  deleteLanguage(id: string): Promise<void>;

  // Projects
  createProject(profileId: string, input: CreateProjectInput): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjects(profileId: string): Promise<Project[]>;
  updateProject(id: string, patch: UpdateProjectInput): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  // Achievements
  createAchievement(profileId: string, input: CreateAchievementInput): Promise<Achievement>;
  getAchievement(id: string): Promise<Achievement | null>;
  listAchievements(profileId: string): Promise<Achievement[]>;
  updateAchievement(id: string, patch: UpdateAchievementInput): Promise<Achievement>;
  deleteAchievement(id: string): Promise<void>;

  // Conversation turns
  createConversationTurn(
    profileId: string,
    input: CreateConversationTurnInput,
  ): Promise<ConversationTurn>;
  listConversationTurns(profileId: string): Promise<ConversationTurn[]>;

  // Question state (1:1)
  getQuestionState(profileId: string): Promise<QuestionState | null>;
  upsertQuestionState(profileId: string, patch: QuestionStateInput): Promise<QuestionState>;

  // Generated resumes
  createGeneratedResume(
    profileId: string,
    input: CreateGeneratedResumeInput,
  ): Promise<GeneratedResume>;
  /**
   * The résumé with this id, or null when it is not the current one. A profile
   * holds exactly one generated résumé (on its `funnel` row), so this answers
   * "is `id` still the current résumé?" rather than reaching into history.
   */
  getGeneratedResume(id: string): Promise<GeneratedResume | null>;
  getLatestGeneratedResume(profileId: string): Promise<GeneratedResume | null>;
  /**
   * Patch the résumé identified by `id`, which must still be the profile's
   * CURRENT one — there is only ever one, on the `funnel` row. Throws `notFound`
   * when it has been superseded, so a late PDF write from an overtaken
   * generation cannot clobber a newer résumé's path.
   */
  updateGeneratedResume(
    id: string,
    patch: Partial<Pick<GeneratedResume, "pdfPath" | "html">>,
  ): Promise<GeneratedResume>;

  // Translated resumes
  /**
   * The profile's translation into `language`, or null if it has never been
   * translated. One per language, on the same `funnel` row.
   *
   * Callers compare its `sourceVersion` against the current résumé's `version` to
   * decide whether it is still current; the store does not do that for them,
   * because a stale translation is still the right thing to serve for a download
   * the user asked for before improving their résumé.
   */
  getTranslatedResume(profileId: string, language: ResumeLang): Promise<TranslatedResume | null>;
  /** Create or replace the profile's translation into `input.language`. */
  saveTranslatedResume(
    profileId: string,
    input: SaveTranslatedResumeInput,
  ): Promise<TranslatedResume>;
  /**
   * Patch the stored translation — in practice only to record its PDF path once
   * the artifact writer has stored the object. Throws `notFound` when no
   * translation exists, matching `updateGeneratedResume`.
   */
  updateTranslatedResume(
    profileId: string,
    language: ResumeLang,
    patch: Partial<Pick<TranslatedResume, "pdfPath">>,
  ): Promise<TranslatedResume>;

  // Improvement iterations
  /** Rounds of improvement completed so far, 0..MAX_RESUME_ITERATIONS. */
  getIteration(profileId: string): Promise<number>;
  /** Bump the counter, clamped to `max`. Returns the new value. */
  advanceIteration(profileId: string, max: number): Promise<number>;
  /** Log a question/answer from the round currently being filled in. */
  recordIterationAnswer(
    profileId: string,
    iteration: number,
    input: IterationAnswerInput,
  ): Promise<IterationAnswer>;
  listIterationAnswers(profileId: string, iteration: number): Promise<IterationAnswer[]>;
  /**
   * Record the PDF a round produced on every one of that round's logged answers
   * (`iteration_N.resume_pdf`).
   *
   * `iteration_N` holds one row per question, so the value repeats across the
   * round: any row you open names the PDF that round ended up with. Called by the
   * artifact writer once the object is stored, and a no-op when the round logged
   * no answers — a regeneration can close a round the user never answered into.
   */
  setIterationResumePdf(profileId: string, iteration: number, pdfPath: string): Promise<void>;
}

/**
 * One improvement-round question and the answer it got.
 *
 * A log, not a source of truth: the answer is also applied to the profile through
 * the normal pipeline (enrich-entry / answers / interests), so these rows record
 * what was asked and said, and deleting one loses the record rather than any
 * résumé content. Persisted one table per round — `iteration_1..3`.
 */
export interface IterationAnswer {
  id: string;
  resumeProfileId: string;
  /** 1-based round number. */
  iteration: number;
  questionId: string;
  question: string;
  answer: string | null;
  /**
   * Storage path of the PDF this round produced, or null until its regeneration
   * runs. Identical on every answer of the round — see `setIterationResumePdf`.
   */
  resumePdfPath: string | null;
  createdAt: string;
}

export type IterationAnswerInput = {
  questionId: string;
  question: string;
  answer?: string | null;
};
