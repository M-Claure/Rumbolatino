/**
 * In-memory Store implementation. Deterministic, dependency-free, and used
 * whenever PERSISTENCE=memory (local dev + unit/e2e tests). Data lives for the
 * lifetime of the process only.
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
import { Errors } from "@/lib/errors";
import {
  buildAchievement,
  buildCertification,
  buildConversationTurn,
  buildEducation,
  buildExperience,
  buildGeneratedResume,
  buildTranslatedResume,
  buildLanguage,
  buildProfile,
  buildProject,
  buildSkill,
  clone,
  emptyPersonalInformation,
  emptyQuestionState,
  newId,
  nowIso as now,
  stripUndefined,
} from "./funnel-entities";
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
  PersonalInformationInput,
  IterationAnswer,
  IterationAnswerInput,
  QuestionStateInput,
  SaveTranslatedResumeInput,
  Store,
  UpdateAchievementInput,
  UpdateCertificationInput,
  UpdateEducationInput,
  UpdateExperienceInput,
  UpdateLanguageInput,
  UpdateProfileInput,
  UpdateProjectInput,
  UpdateSkillInput,
} from "./store";

/** Composite key for the per-language translation map. */
const translationKey = (profileId: string, language: ResumeLang): string =>
  `${profileId}:${language}`;

export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private profiles = new Map<string, ResumeProfile>();
  private personal = new Map<string, PersonalInformation>();
  private education = new Map<string, EducationEntry>();
  private experience = new Map<string, ExperienceEntry>();
  private skills = new Map<string, Skill>();
  private certifications = new Map<string, Certification>();
  private languages = new Map<string, Language>();
  private projects = new Map<string, Project>();
  private achievements = new Map<string, Achievement>();
  private turns = new Map<string, ConversationTurn>();
  private questionStates = new Map<string, QuestionState>();
  /**
   * Keyed by PROFILE, not by résumé id: a profile holds exactly one generated
   * résumé, mirroring the `funnel.resume_*` columns the Supabase store writes.
   */
  private resumes = new Map<string, GeneratedResume>();
  /**
   * Keyed `<profileId>:<language>` — one translation per language per profile,
   * mirroring the `funnel.resume_en_*` columns.
   */
  private translations = new Map<string, TranslatedResume>();
  private iterations = new Map<string, number>();
  private iterationAnswers = new Map<string, IterationAnswer>();

  /** Test helper: wipe all data. */
  reset(): void {
    for (const m of [
      this.users,
      this.profiles,
      this.personal,
      this.education,
      this.experience,
      this.skills,
      this.certifications,
      this.languages,
      this.projects,
      this.achievements,
      this.turns,
      this.questionStates,
      this.resumes,
      this.translations,
      this.iterations,
      this.iterationAnswers,
    ]) {
      (m as Map<string, unknown>).clear();
    }
  }

  private byProfile<T extends { resumeProfileId: string }>(map: Map<string, T>, profileId: string): T[] {
    return [...map.values()].filter((v) => v.resumeProfileId === profileId).map(clone);
  }

  // ── Users ──
  async getUser(userId: string): Promise<User | null> {
    return clone(this.users.get(userId) ?? null);
  }
  async upsertUser(input: { id: string; email: string; preferredLanguage?: string }): Promise<User> {
    const existing = this.users.get(input.id);
    const user: User = existing
      ? { ...existing, email: input.email, updatedAt: now() }
      : {
          id: input.id,
          email: input.email,
          preferredLanguage: input.preferredLanguage ?? "es",
          onboardingCompleted: false,
          createdAt: now(),
          updatedAt: now(),
        };
    this.users.set(user.id, user);
    return clone(user);
  }

  // ── Resume profiles ──
  async createResumeProfile(userId: string, input: CreateProfileInput): Promise<ResumeProfile> {
    const profile = buildProfile(userId, input);
    this.profiles.set(profile.id, profile);
    return clone(profile);
  }
  async getResumeProfile(id: string): Promise<ResumeProfile | null> {
    return clone(this.profiles.get(id) ?? null);
  }
  async listResumeProfilesByUser(userId: string): Promise<ResumeProfile[]> {
    return [...this.profiles.values()].filter((p) => p.userId === userId).map(clone);
  }
  async updateResumeProfile(id: string, patch: UpdateProfileInput): Promise<ResumeProfile> {
    const existing = this.profiles.get(id);
    if (!existing) throw Errors.notFound("Perfil no encontrado");
    const updated: ResumeProfile = { ...existing, ...stripUndefined(patch), updatedAt: now() };
    this.profiles.set(id, updated);
    return clone(updated);
  }

  // ── Personal information ──
  async getPersonalInformation(profileId: string): Promise<PersonalInformation | null> {
    return clone(this.personal.get(profileId) ?? null);
  }
  async upsertPersonalInformation(
    profileId: string,
    patch: PersonalInformationInput,
  ): Promise<PersonalInformation> {
    const existing =
      this.personal.get(profileId) ?? emptyPersonalInformation(profileId);
    const updated: PersonalInformation = { ...existing, ...stripUndefined(patch), resumeProfileId: profileId };
    this.personal.set(profileId, updated);
    return clone(updated);
  }

  // ── Education ──
  async createEducation(profileId: string, input: CreateEducationInput): Promise<EducationEntry> {
    const entry = buildEducation(profileId, input);
    this.education.set(entry.id, entry);
    return clone(entry);
  }
  async getEducation(entryId: string): Promise<EducationEntry | null> {
    return clone(this.education.get(entryId) ?? null);
  }
  async listEducation(profileId: string): Promise<EducationEntry[]> {
    return this.byProfile(this.education, profileId);
  }
  async updateEducation(entryId: string, patch: UpdateEducationInput): Promise<EducationEntry> {
    const existing = this.education.get(entryId);
    if (!existing) throw Errors.notFound("Entrada de educación no encontrada");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.education.set(entryId, updated);
    return clone(updated);
  }
  async deleteEducation(entryId: string): Promise<void> {
    this.education.delete(entryId);
  }

  // ── Experience ──
  async createExperience(profileId: string, input: CreateExperienceInput): Promise<ExperienceEntry> {
    const entry = buildExperience(profileId, input);
    this.experience.set(entry.id, entry);
    return clone(entry);
  }
  async getExperience(entryId: string): Promise<ExperienceEntry | null> {
    return clone(this.experience.get(entryId) ?? null);
  }
  async listExperience(profileId: string): Promise<ExperienceEntry[]> {
    return this.byProfile(this.experience, profileId);
  }
  async updateExperience(entryId: string, patch: UpdateExperienceInput): Promise<ExperienceEntry> {
    const existing = this.experience.get(entryId);
    if (!existing) throw Errors.notFound("Entrada de experiencia no encontrada");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.experience.set(entryId, updated);
    return clone(updated);
  }
  async deleteExperience(entryId: string): Promise<void> {
    this.experience.delete(entryId);
  }

  // ── Skills ──
  async createSkill(profileId: string, input: CreateSkillInput): Promise<Skill> {
    const dup = await this.findSkillByName(profileId, input.name);
    if (dup) throw Errors.conflict("La habilidad ya existe");
    const skill = buildSkill(profileId, input);
    this.skills.set(skill.id, skill);
    return clone(skill);
  }
  async getSkill(skillId: string): Promise<Skill | null> {
    return clone(this.skills.get(skillId) ?? null);
  }
  async listSkills(profileId: string): Promise<Skill[]> {
    return this.byProfile(this.skills, profileId);
  }
  async findSkillByName(profileId: string, name: string): Promise<Skill | null> {
    const found = [...this.skills.values()].find(
      (s) => s.resumeProfileId === profileId && s.name.toLowerCase() === name.toLowerCase(),
    );
    return clone(found ?? null);
  }
  async updateSkill(skillId: string, patch: UpdateSkillInput): Promise<Skill> {
    const existing = this.skills.get(skillId);
    if (!existing) throw Errors.notFound("Habilidad no encontrada");
    const updated: Skill = { ...existing, ...stripUndefined(patch), updatedAt: now() };
    this.skills.set(skillId, updated);
    return clone(updated);
  }
  async deleteSkill(skillId: string): Promise<void> {
    this.skills.delete(skillId);
  }

  // ── Certifications ──
  async createCertification(
    profileId: string,
    input: CreateCertificationInput,
  ): Promise<Certification> {
    const cert = buildCertification(profileId, input);
    this.certifications.set(cert.id, cert);
    return clone(cert);
  }
  async getCertification(id: string): Promise<Certification | null> {
    return clone(this.certifications.get(id) ?? null);
  }
  async listCertifications(profileId: string): Promise<Certification[]> {
    return this.byProfile(this.certifications, profileId);
  }
  async updateCertification(id: string, patch: UpdateCertificationInput): Promise<Certification> {
    const existing = this.certifications.get(id);
    if (!existing) throw Errors.notFound("Certificación no encontrada");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.certifications.set(id, updated);
    return clone(updated);
  }
  async deleteCertification(id: string): Promise<void> {
    this.certifications.delete(id);
  }

  // ── Languages ──
  async createLanguage(profileId: string, input: CreateLanguageInput): Promise<Language> {
    const lang = buildLanguage(profileId, input);
    this.languages.set(lang.id, lang);
    return clone(lang);
  }
  async getLanguage(id: string): Promise<Language | null> {
    return clone(this.languages.get(id) ?? null);
  }
  async listLanguages(profileId: string): Promise<Language[]> {
    return this.byProfile(this.languages, profileId);
  }
  async updateLanguage(id: string, patch: UpdateLanguageInput): Promise<Language> {
    const existing = this.languages.get(id);
    if (!existing) throw Errors.notFound("Idioma no encontrado");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.languages.set(id, updated);
    return clone(updated);
  }
  async deleteLanguage(id: string): Promise<void> {
    this.languages.delete(id);
  }

  // ── Projects ──
  async createProject(profileId: string, input: CreateProjectInput): Promise<Project> {
    const project = buildProject(profileId, input);
    this.projects.set(project.id, project);
    return clone(project);
  }
  async getProject(id: string): Promise<Project | null> {
    return clone(this.projects.get(id) ?? null);
  }
  async listProjects(profileId: string): Promise<Project[]> {
    return this.byProfile(this.projects, profileId);
  }
  async updateProject(id: string, patch: UpdateProjectInput): Promise<Project> {
    const existing = this.projects.get(id);
    if (!existing) throw Errors.notFound("Proyecto no encontrado");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.projects.set(id, updated);
    return clone(updated);
  }
  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }

  // ── Achievements ──
  async createAchievement(profileId: string, input: CreateAchievementInput): Promise<Achievement> {
    const achievement = buildAchievement(profileId, input);
    this.achievements.set(achievement.id, achievement);
    return clone(achievement);
  }
  async getAchievement(id: string): Promise<Achievement | null> {
    return clone(this.achievements.get(id) ?? null);
  }
  async listAchievements(profileId: string): Promise<Achievement[]> {
    return this.byProfile(this.achievements, profileId);
  }
  async updateAchievement(id: string, patch: UpdateAchievementInput): Promise<Achievement> {
    const existing = this.achievements.get(id);
    if (!existing) throw Errors.notFound("Logro no encontrado");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.achievements.set(id, updated);
    return clone(updated);
  }
  async deleteAchievement(id: string): Promise<void> {
    this.achievements.delete(id);
  }

  // ── Conversation turns ──
  async createConversationTurn(
    profileId: string,
    input: CreateConversationTurnInput,
  ): Promise<ConversationTurn> {
    const turn = buildConversationTurn(profileId, input);
    this.turns.set(turn.id, turn);
    return clone(turn);
  }
  async listConversationTurns(profileId: string): Promise<ConversationTurn[]> {
    return this.byProfile(this.turns, profileId).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  // ── Question state ──
  async getQuestionState(profileId: string): Promise<QuestionState | null> {
    return clone(this.questionStates.get(profileId) ?? null);
  }
  async upsertQuestionState(profileId: string, patch: QuestionStateInput): Promise<QuestionState> {
    const existing =
      this.questionStates.get(profileId) ??
      emptyQuestionState(profileId);
    const updated: QuestionState = {
      ...existing,
      ...stripUndefined(patch),
      resumeProfileId: profileId,
      lastUpdatedAt: now(),
    };
    this.questionStates.set(profileId, updated);
    return clone(updated);
  }

  // ── Generated resumes ──
  // One per profile, replaced on every generation — the `funnel.resume_*` columns.
  async createGeneratedResume(
    profileId: string,
    input: CreateGeneratedResumeInput,
  ): Promise<GeneratedResume> {
    const previous = this.resumes.get(profileId);
    const resume = buildGeneratedResume(profileId, input, (previous?.version ?? 0) + 1);
    this.resumes.set(profileId, resume);
    return clone(resume);
  }
  async getGeneratedResume(id: string): Promise<GeneratedResume | null> {
    const found = [...this.resumes.values()].find((r) => r.id === id);
    return clone(found ?? null);
  }
  async getLatestGeneratedResume(profileId: string): Promise<GeneratedResume | null> {
    return clone(this.resumes.get(profileId) ?? null);
  }
  async updateGeneratedResume(
    id: string,
    patch: Partial<Pick<GeneratedResume, "pdfPath" | "html">>,
  ): Promise<GeneratedResume> {
    const existing = [...this.resumes.values()].find((r) => r.id === id);
    // Superseded by a newer generation, so there is nothing to patch — see the
    // `Store` contract.
    if (!existing) throw Errors.notFound("Currículum generado no encontrado");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.resumes.set(existing.resumeProfileId, updated);
    return clone(updated);
  }

  // ── Translated resumes ──
  // One per profile per language — the `funnel.resume_en_*` columns.
  async getTranslatedResume(profileId: string, language: ResumeLang): Promise<TranslatedResume | null> {
    return clone(this.translations.get(translationKey(profileId, language)) ?? null);
  }
  async saveTranslatedResume(
    profileId: string,
    input: SaveTranslatedResumeInput,
  ): Promise<TranslatedResume> {
    const translation = buildTranslatedResume(profileId, input);
    this.translations.set(translationKey(profileId, input.language), translation);
    return clone(translation);
  }
  async updateTranslatedResume(
    profileId: string,
    language: ResumeLang,
    patch: Partial<Pick<TranslatedResume, "pdfPath">>,
  ): Promise<TranslatedResume> {
    const key = translationKey(profileId, language);
    const existing = this.translations.get(key);
    if (!existing) throw Errors.notFound("Traducción no encontrada");
    const updated = { ...existing, ...stripUndefined(patch) };
    this.translations.set(key, updated);
    return clone(updated);
  }

  // ── Improvement iterations ──
  async getIteration(profileId: string): Promise<number> {
    return this.iterations.get(profileId) ?? 0;
  }
  async advanceIteration(profileId: string, max: number): Promise<number> {
    const next = Math.min(max, (this.iterations.get(profileId) ?? 0) + 1);
    this.iterations.set(profileId, next);
    return next;
  }
  async recordIterationAnswer(
    profileId: string,
    iteration: number,
    input: IterationAnswerInput,
  ): Promise<IterationAnswer> {
    const entry: IterationAnswer = {
      id: newId(),
      resumeProfileId: profileId,
      iteration,
      questionId: input.questionId,
      question: input.question,
      answer: input.answer ?? null,
      resumePdfPath: null,
      createdAt: now(),
    };
    this.iterationAnswers.set(entry.id, entry);
    return clone(entry);
  }
  async listIterationAnswers(profileId: string, iteration: number): Promise<IterationAnswer[]> {
    return [...this.iterationAnswers.values()]
      .filter((a) => a.resumeProfileId === profileId && a.iteration === iteration)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }
  async setIterationResumePdf(
    profileId: string,
    iteration: number,
    pdfPath: string,
  ): Promise<void> {
    for (const [id, a] of this.iterationAnswers) {
      if (a.resumeProfileId === profileId && a.iteration === iteration) {
        this.iterationAnswers.set(id, { ...a, resumePdfPath: pdfPath });
      }
    }
  }
}

