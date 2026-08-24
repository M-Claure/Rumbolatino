import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  buildLanguage,
  buildProfile,
  buildProject,
  buildSkill,
  clone,
  emptyPersonalInformation,
  emptyQuestionState,
  nowIso,
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
  IterationAnswer,
  IterationAnswerInput,
  PersonalInformationInput,
  QuestionStateInput,
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

/**
 * Supabase implementation of `Store`, over the simplified 5-table schema
 * (`supabase/migrations/0007_simplified_schema.sql`).
 *
 *   funnel        one row per résumé — profile columns plus the eight capture
 *                 sections, the funnel Q&A and the question state, as JSONB
 *   iteration_1/2/3   the improvement round's questions and answers, each row
 *                     naming the PDF its round produced
 *
 * ## Why this file is now a third of its former size
 * The JSONB columns hold the DOMAIN objects verbatim — camelCase, exactly the
 * shapes in `types/domain.ts`. There is no row↔domain mapping layer to maintain,
 * and no snake_case translation to get wrong. Entity construction is shared with
 * `MemoryStore` through `funnel-entities.ts`, so the two stores cannot drift on
 * defaults (notably: a new skill is always `suggested`).
 *
 * ## Concurrency
 * Editing one entry means rewriting its array, which is a read-modify-write. Every
 * such write asserts the `revision` it read and bumps it; a lost race re-reads and
 * retries rather than silently clobbering a concurrent edit. The old schema got
 * this for free from row-level writes, so it is paid back here explicitly.
 */

/** The JSONB list columns on `funnel`, keyed by the domain collection they hold. */
const LIST_COLUMNS = {
  education: "education",
  experience: "experience",
  skills: "skills",
  certifications: "certifications",
  languages: "languages",
  projects: "projects",
  achievements: "achievements",
} as const;
type ListColumn = (typeof LIST_COLUMNS)[keyof typeof LIST_COLUMNS];

/** Entries all carry a string `id`; that is all the generic helpers need. */
interface Identified {
  id: string;
}

/** How many times a lost optimistic race is retried before giving up. */
const MAX_WRITE_ATTEMPTS = 4;

type FunnelRow = Record<string, unknown> & { id: string; revision: number };

export class SupabaseStore implements Store {
  constructor(private readonly client: SupabaseClient) {}

  // ── internals ─────────────────────────────────────────────────────────────

  private async fetchRow(profileId: string): Promise<FunnelRow | null> {
    const { data, error } = await this.client
      .from("funnel")
      .select("*")
      .eq("id", profileId)
      .maybeSingle();
    if (error) throw Errors.internal(error.message);
    return (data as FunnelRow | null) ?? null;
  }

  private async requireRow(profileId: string): Promise<FunnelRow> {
    const row = await this.fetchRow(profileId);
    if (!row) throw Errors.notFound("Perfil no encontrado");
    return row;
  }

  /**
   * Find the funnel row holding an entry, given only the entry id — which is all
   * the `Store` interface passes to `updateExperience(entryId, …)` and friends.
   * JSONB containment, backed by the GIN indexes the migration creates; RLS keeps
   * the candidate set to the caller's own rows.
   */
  private async fetchRowByEntry(column: ListColumn, entryId: string): Promise<FunnelRow | null> {
    const { data, error } = await this.client
      .from("funnel")
      .select("*")
      // The filter value MUST be a pre-serialized JSON string, not an array.
      // postgrest-js branches on the argument's type: an array is encoded as a
      // POSTGRES ARRAY literal via `value.join(',')`, which for `[{id}]` yields
      // the literal text `cs.{[object Object]}` and every call fails with
      // "invalid input syntax for type json". A string is passed through as-is,
      // giving the JSONB containment this needs: `cs.[{"id":"…"}]`.
      .contains(column, JSON.stringify([{ id: entryId }]))
      .limit(1)
      .maybeSingle();
    if (error) throw Errors.internal(error.message);
    return (data as FunnelRow | null) ?? null;
  }

  /**
   * Apply `mutate` to the funnel row and persist it under an optimistic guard.
   * `mutate` must be pure — it can run more than once if another write lands first.
   */
  private async mutateRow<R>(
    profileId: string,
    mutate: (row: FunnelRow) => { patch: Record<string, unknown>; result: R },
  ): Promise<R> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const row = await this.requireRow(profileId);
      const { patch, result } = mutate(row);
      const { data, error } = await this.client
        .from("funnel")
        .update({ ...patch, revision: row.revision + 1 })
        .eq("id", profileId)
        .eq("revision", row.revision)
        .select("id");
      if (error) throw Errors.internal(error.message);
      // Zero rows means another writer bumped `revision` in between: re-read and
      // reapply rather than overwriting their change.
      if (data && data.length > 0) return result;
    }
    throw Errors.conflict("No se pudo guardar el cambio, inténtalo de nuevo.");
  }

  private list<T>(row: FunnelRow, column: ListColumn): T[] {
    return (row[column] as T[] | null) ?? [];
  }

  private async createInList<T extends Identified>(
    profileId: string,
    column: ListColumn,
    entity: T,
  ): Promise<T> {
    return this.mutateRow(profileId, (row) => ({
      patch: { [column]: [...this.list<T>(row, column), entity] },
      result: clone(entity),
    }));
  }

  private async getFromList<T extends Identified>(
    column: ListColumn,
    entryId: string,
  ): Promise<T | null> {
    const row = await this.fetchRowByEntry(column, entryId);
    if (!row) return null;
    return clone(this.list<T>(row, column).find((e) => e.id === entryId) ?? null);
  }

  private async listFrom<T>(profileId: string, column: ListColumn): Promise<T[]> {
    const row = await this.fetchRow(profileId);
    return row ? clone(this.list<T>(row, column)) : [];
  }

  private async updateInList<T extends Identified>(
    column: ListColumn,
    entryId: string,
    patch: object,
    notFound: string,
    /** Applied after the patch — used by Skill to refresh `updatedAt`. */
    finalize?: (next: T) => T,
  ): Promise<T> {
    const row = await this.fetchRowByEntry(column, entryId);
    if (!row) throw Errors.notFound(notFound);

    // An all-undefined patch (a back-edit whose normalizer found nothing mappable)
    // has nothing to write. Skipping it avoids a pointless `revision` bump, which
    // would make any concurrent writer lose its optimistic guard and retry.
    if (Object.keys(stripUndefined(patch)).length === 0) {
      const unchanged = this.list<T>(row, column).find((e) => e.id === entryId);
      if (!unchanged) throw Errors.notFound(notFound);
      return clone(unchanged);
    }

    return this.mutateRow(row.id, (current) => {
      const items = this.list<T>(current, column);
      const existing = items.find((e) => e.id === entryId);
      if (!existing) throw Errors.notFound(notFound);
      const merged = { ...existing, ...stripUndefined(patch) } as T;
      const updated = finalize ? finalize(merged) : merged;
      return {
        patch: { [column]: items.map((e) => (e.id === entryId ? updated : e)) },
        result: clone(updated),
      };
    });
  }

  private async deleteFromList(column: ListColumn, entryId: string): Promise<void> {
    const row = await this.fetchRowByEntry(column, entryId);
    if (!row) return; // deleting something absent is a no-op, as in MemoryStore
    await this.mutateRow(row.id, (current) => ({
      patch: {
        [column]: this.list<Identified>(current, column).filter((e) => e.id !== entryId),
      },
      result: undefined,
    }));
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  // The app `users` table is gone; `funnel.user_id` references auth.users. These
  // resolve against the session instead, and are only ever called in memory mode
  // (see `getRequestContext`) — Supabase Auth provisions its own user rows.

  async getUser(userId: string): Promise<User | null> {
    const { data } = await this.client.auth.getUser();
    if (!data.user || data.user.id !== userId) return null;
    return {
      id: data.user.id,
      email: data.user.email ?? "",
      preferredLanguage: "es",
      onboardingCompleted: false,
      createdAt: data.user.created_at ?? nowIso(),
      updatedAt: data.user.updated_at ?? nowIso(),
    };
  }

  async upsertUser(input: { id: string; email: string; preferredLanguage?: string }): Promise<User> {
    return {
      id: input.id,
      email: input.email,
      preferredLanguage: input.preferredLanguage ?? "es",
      onboardingCompleted: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  // ── Resume profiles ───────────────────────────────────────────────────────

  async createResumeProfile(userId: string, input: CreateProfileInput): Promise<ResumeProfile> {
    const profile = buildProfile(userId, input);
    const { error } = await this.client.from("funnel").insert({
      id: profile.id,
      user_id: profile.userId,
      status: profile.status,
      target_role: profile.targetRole,
      career_goal: profile.careerGoal,
      location: profile.location,
      interests: profile.interests,
      progress_percentage: profile.progressPercentage,
      current_section: profile.currentSection,
      finalized_at: profile.finalizedAt,
      terms_accepted_at: profile.termsAcceptedAt,
      terms_version: profile.termsVersion,
      publish_consent_at: profile.publishConsentAt,
      publish_consent_version: profile.publishConsentVersion,
      created_at: profile.createdAt,
      updated_at: profile.updatedAt,
    });
    if (error) throw Errors.internal(error.message);
    return profile;
  }

  async getResumeProfile(id: string): Promise<ResumeProfile | null> {
    const row = await this.fetchRow(id);
    return row ? toProfile(row) : null;
  }

  async listResumeProfilesByUser(userId: string): Promise<ResumeProfile[]> {
    const { data, error } = await this.client.from("funnel").select("*").eq("user_id", userId);
    if (error) throw Errors.internal(error.message);
    return ((data ?? []) as FunnelRow[]).map(toProfile);
  }

  async updateResumeProfile(id: string, patch: UpdateProfileInput): Promise<ResumeProfile> {
    const columns: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) columns[key] = value;
    };
    set("status", patch.status);
    set("target_role", patch.targetRole);
    set("career_goal", patch.careerGoal);
    set("location", patch.location);
    set("interests", patch.interests);
    set("progress_percentage", patch.progressPercentage);
    set("current_section", patch.currentSection);
    set("finalized_at", patch.finalizedAt);
    set("terms_accepted_at", patch.termsAcceptedAt);
    set("terms_version", patch.termsVersion);
    set("publish_consent_at", patch.publishConsentAt);
    set("publish_consent_version", patch.publishConsentVersion);

    const { data, error } = await this.client
      .from("funnel")
      .update({ ...columns, updated_at: nowIso() })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Perfil no encontrado");
    return toProfile(data as FunnelRow);
  }

  // ── Personal information (1:1 JSONB) ──────────────────────────────────────

  async getPersonalInformation(profileId: string): Promise<PersonalInformation | null> {
    const row = await this.fetchRow(profileId);
    if (!row) return null;
    const stored = row.personal_information as PersonalInformation | null;
    // `{}` is the column default and means "never captured", not "captured empty".
    return stored && Object.keys(stored).length > 0 ? clone(stored) : null;
  }

  async upsertPersonalInformation(
    profileId: string,
    patch: PersonalInformationInput,
  ): Promise<PersonalInformation> {
    return this.mutateRow(profileId, (row) => {
      const stored = row.personal_information as PersonalInformation | null;
      const existing =
        stored && Object.keys(stored).length > 0 ? stored : emptyPersonalInformation(profileId);
      const updated: PersonalInformation = {
        ...existing,
        ...stripUndefined(patch),
        resumeProfileId: profileId,
      };
      return { patch: { personal_information: updated }, result: clone(updated) };
    });
  }

  // ── Education ─────────────────────────────────────────────────────────────

  createEducation(profileId: string, input: CreateEducationInput): Promise<EducationEntry> {
    return this.createInList(profileId, LIST_COLUMNS.education, buildEducation(profileId, input));
  }
  getEducation(entryId: string): Promise<EducationEntry | null> {
    return this.getFromList(LIST_COLUMNS.education, entryId);
  }
  listEducation(profileId: string): Promise<EducationEntry[]> {
    return this.listFrom(profileId, LIST_COLUMNS.education);
  }
  updateEducation(entryId: string, patch: UpdateEducationInput): Promise<EducationEntry> {
    return this.updateInList(
      LIST_COLUMNS.education,
      entryId,
      patch,
      "Entrada de educación no encontrada",
    );
  }
  deleteEducation(entryId: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.education, entryId);
  }

  // ── Experience ────────────────────────────────────────────────────────────

  createExperience(profileId: string, input: CreateExperienceInput): Promise<ExperienceEntry> {
    return this.createInList(profileId, LIST_COLUMNS.experience, buildExperience(profileId, input));
  }
  getExperience(entryId: string): Promise<ExperienceEntry | null> {
    return this.getFromList(LIST_COLUMNS.experience, entryId);
  }
  listExperience(profileId: string): Promise<ExperienceEntry[]> {
    return this.listFrom(profileId, LIST_COLUMNS.experience);
  }
  updateExperience(entryId: string, patch: UpdateExperienceInput): Promise<ExperienceEntry> {
    return this.updateInList(
      LIST_COLUMNS.experience,
      entryId,
      patch,
      "Entrada de experiencia no encontrada",
    );
  }
  deleteExperience(entryId: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.experience, entryId);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  async createSkill(profileId: string, input: CreateSkillInput): Promise<Skill> {
    if (await this.findSkillByName(profileId, input.name)) {
      throw Errors.conflict("La habilidad ya existe");
    }
    return this.createInList(profileId, LIST_COLUMNS.skills, buildSkill(profileId, input));
  }
  getSkill(skillId: string): Promise<Skill | null> {
    return this.getFromList(LIST_COLUMNS.skills, skillId);
  }
  listSkills(profileId: string): Promise<Skill[]> {
    return this.listFrom(profileId, LIST_COLUMNS.skills);
  }
  async findSkillByName(profileId: string, name: string): Promise<Skill | null> {
    const skills = await this.listSkills(profileId);
    return skills.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  updateSkill(skillId: string, patch: UpdateSkillInput): Promise<Skill> {
    return this.updateInList<Skill>(
      LIST_COLUMNS.skills,
      skillId,
      patch,
      "Habilidad no encontrada",
      (next) => ({ ...next, updatedAt: nowIso() }),
    );
  }
  deleteSkill(skillId: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.skills, skillId);
  }

  // ── Certifications ────────────────────────────────────────────────────────

  createCertification(profileId: string, input: CreateCertificationInput): Promise<Certification> {
    return this.createInList(
      profileId,
      LIST_COLUMNS.certifications,
      buildCertification(profileId, input),
    );
  }
  getCertification(id: string): Promise<Certification | null> {
    return this.getFromList(LIST_COLUMNS.certifications, id);
  }
  listCertifications(profileId: string): Promise<Certification[]> {
    return this.listFrom(profileId, LIST_COLUMNS.certifications);
  }
  updateCertification(id: string, patch: UpdateCertificationInput): Promise<Certification> {
    return this.updateInList(
      LIST_COLUMNS.certifications,
      id,
      patch,
      "Certificación no encontrada",
    );
  }
  deleteCertification(id: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.certifications, id);
  }

  // ── Languages ─────────────────────────────────────────────────────────────

  createLanguage(profileId: string, input: CreateLanguageInput): Promise<Language> {
    return this.createInList(profileId, LIST_COLUMNS.languages, buildLanguage(profileId, input));
  }
  getLanguage(id: string): Promise<Language | null> {
    return this.getFromList(LIST_COLUMNS.languages, id);
  }
  listLanguages(profileId: string): Promise<Language[]> {
    return this.listFrom(profileId, LIST_COLUMNS.languages);
  }
  updateLanguage(id: string, patch: UpdateLanguageInput): Promise<Language> {
    return this.updateInList(LIST_COLUMNS.languages, id, patch, "Idioma no encontrado");
  }
  deleteLanguage(id: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.languages, id);
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  createProject(profileId: string, input: CreateProjectInput): Promise<Project> {
    return this.createInList(profileId, LIST_COLUMNS.projects, buildProject(profileId, input));
  }
  getProject(id: string): Promise<Project | null> {
    return this.getFromList(LIST_COLUMNS.projects, id);
  }
  listProjects(profileId: string): Promise<Project[]> {
    return this.listFrom(profileId, LIST_COLUMNS.projects);
  }
  updateProject(id: string, patch: UpdateProjectInput): Promise<Project> {
    return this.updateInList(LIST_COLUMNS.projects, id, patch, "Proyecto no encontrado");
  }
  deleteProject(id: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.projects, id);
  }

  // ── Achievements ──────────────────────────────────────────────────────────

  createAchievement(profileId: string, input: CreateAchievementInput): Promise<Achievement> {
    return this.createInList(
      profileId,
      LIST_COLUMNS.achievements,
      buildAchievement(profileId, input),
    );
  }
  getAchievement(id: string): Promise<Achievement | null> {
    return this.getFromList(LIST_COLUMNS.achievements, id);
  }
  listAchievements(profileId: string): Promise<Achievement[]> {
    return this.listFrom(profileId, LIST_COLUMNS.achievements);
  }
  updateAchievement(id: string, patch: UpdateAchievementInput): Promise<Achievement> {
    return this.updateInList(LIST_COLUMNS.achievements, id, patch, "Logro no encontrado");
  }
  deleteAchievement(id: string): Promise<void> {
    return this.deleteFromList(LIST_COLUMNS.achievements, id);
  }

  // ── Conversation turns (append-only JSONB log) ────────────────────────────

  async createConversationTurn(
    profileId: string,
    input: CreateConversationTurnInput,
  ): Promise<ConversationTurn> {
    const turn = buildConversationTurn(profileId, input);
    return this.mutateRow(profileId, (row) => ({
      patch: { conversation: [...((row.conversation as ConversationTurn[] | null) ?? []), turn] },
      result: clone(turn),
    }));
  }

  async listConversationTurns(profileId: string): Promise<ConversationTurn[]> {
    const row = await this.fetchRow(profileId);
    if (!row) return [];
    return clone((row.conversation as ConversationTurn[] | null) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  // ── Question state (1:1 JSONB) ────────────────────────────────────────────

  async getQuestionState(profileId: string): Promise<QuestionState | null> {
    const row = await this.fetchRow(profileId);
    if (!row) return null;
    const stored = row.question_state as QuestionState | null;
    return stored && Object.keys(stored).length > 0 ? clone(stored) : null;
  }

  async upsertQuestionState(profileId: string, patch: QuestionStateInput): Promise<QuestionState> {
    return this.mutateRow(profileId, (row) => {
      const stored = row.question_state as QuestionState | null;
      const existing =
        stored && Object.keys(stored).length > 0 ? stored : emptyQuestionState(profileId);
      const updated: QuestionState = {
        ...existing,
        ...stripUndefined(patch),
        resumeProfileId: profileId,
        lastUpdatedAt: nowIso(),
      };
      return { patch: { question_state: updated }, result: clone(updated) };
    });
  }

  // ── Generated résumé (the funnel row's resume_* columns) ──────────────────
  // 0008 dropped `resume_pdfs`: a profile has exactly one current résumé, so it
  // is columns on `funnel` rather than a table joined 1:1 in every read path.

  async createGeneratedResume(
    profileId: string,
    input: CreateGeneratedResumeInput,
  ): Promise<GeneratedResume> {
    // Through `mutateRow` so the version bump is read-modify-write under the
    // optimistic guard — two concurrent generations cannot both claim a version.
    return this.mutateRow(profileId, (row) => {
      const resume = buildGeneratedResume(
        profileId,
        input,
        ((row.resume_version as number | undefined) ?? 0) + 1,
      );
      return { patch: toResumeColumns(resume), result: clone(resume) };
    });
  }

  async getGeneratedResume(id: string): Promise<GeneratedResume | null> {
    const { data, error } = await this.client
      .from("funnel")
      .select("*")
      .eq("resume_id", id)
      .limit(1)
      .maybeSingle();
    if (error) throw Errors.internal(error.message);
    return data ? toResume(data as FunnelRow) : null;
  }

  async getLatestGeneratedResume(profileId: string): Promise<GeneratedResume | null> {
    const row = await this.fetchRow(profileId);
    // `resume_id` is null until the first generation; an empty résumé is not a
    // résumé, and callers branch on null to decide whether to generate.
    if (!row || !row.resume_id) return null;
    return toResume(row);
  }

  async updateGeneratedResume(
    id: string,
    patch: Partial<Pick<GeneratedResume, "pdfPath" | "html">>,
  ): Promise<GeneratedResume> {
    const columns: Record<string, unknown> = {};
    if (patch.pdfPath !== undefined) columns.resume_pdf = patch.pdfPath;
    if (patch.html !== undefined) columns.resume_html = patch.html;
    // Guarded on `resume_id`, so a PDF write from a generation that has since
    // been superseded matches no row and throws instead of overwriting the newer
    // résumé's path. `revision` is deliberately not bumped: this records a
    // derived artifact, and racing it against a concurrent list edit would fail
    // a write the user cares about for one they do not.
    const { data, error } = await this.client
      .from("funnel")
      .update(columns)
      .eq("resume_id", id)
      .select("*")
      .maybeSingle();
    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Currículum generado no encontrado");
    return toResume(data as FunnelRow);
  }

  // ── Improvement iterations ────────────────────────────────────────────────

  async getIteration(profileId: string): Promise<number> {
    const row = await this.fetchRow(profileId);
    return (row?.iteration as number | undefined) ?? 0;
  }

  async advanceIteration(profileId: string, max: number): Promise<number> {
    return this.mutateRow(profileId, (row) => {
      const next = Math.min(max, ((row.iteration as number | undefined) ?? 0) + 1);
      return { patch: { iteration: next }, result: next };
    });
  }

  async recordIterationAnswer(
    profileId: string,
    iteration: number,
    input: IterationAnswerInput,
  ): Promise<IterationAnswer> {
    const { data, error } = await this.client
      .from(iterationTable(iteration))
      .insert({
        funnel_id: profileId,
        question_id: input.questionId,
        question: input.question,
        answer: input.answer ?? null,
      })
      .select("*")
      .single();
    if (error) throw Errors.internal(error.message);
    return toIterationAnswer(iteration, data);
  }

  async listIterationAnswers(profileId: string, iteration: number): Promise<IterationAnswer[]> {
    const { data, error } = await this.client
      .from(iterationTable(iteration))
      .select("*")
      .eq("funnel_id", profileId)
      .order("created_at", { ascending: true });
    if (error) throw Errors.internal(error.message);
    return (data ?? []).map((r) => toIterationAnswer(iteration, r));
  }

  async setIterationResumePdf(
    profileId: string,
    iteration: number,
    pdfPath: string,
  ): Promise<void> {
    // Every row of the round gets the same path — see `Store.setIterationResumePdf`.
    // Matching no rows is a normal outcome (a round the user never answered
    // into), so this does not assert a row count.
    const { error } = await this.client
      .from(iterationTable(iteration))
      .update({ resume_pdf: pdfPath })
      .eq("funnel_id", profileId);
    if (error) throw Errors.internal(error.message);
  }
}

/**
 * There is one table per improvement round, so the round number selects the
 * table. Validated rather than interpolated blindly: `iteration` reaches here
 * from request handling, and a bad value must be a 400, not a query against an
 * arbitrary table name.
 */
function iterationTable(iteration: number): string {
  if (!Number.isInteger(iteration) || iteration < 1 || iteration > 3) {
    throw Errors.validation(`Iteración inválida: ${iteration}`);
  }
  return `iteration_${iteration}`;
}

// ── row ↔ domain (only where columns are not the domain shape) ──────────────

function toProfile(row: FunnelRow): ResumeProfile {
  const r = row as Record<string, any>;
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    targetRole: r.target_role,
    careerGoal: r.career_goal,
    location: r.location,
    interests: r.interests ?? [],
    progressPercentage: r.progress_percentage,
    currentSection: r.current_section,
    finalizedAt: r.finalized_at ?? null,
    termsAcceptedAt: r.terms_accepted_at ?? null,
    termsVersion: r.terms_version ?? null,
    publishConsentAt: r.publish_consent_at ?? null,
    publishConsentVersion: r.publish_consent_version ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * The résumé, as the `funnel` row's `resume_*` columns.
 *
 * `resume_content` holds the document itself; `createdAt` is intentionally NOT
 * persisted separately — the row already has `updated_at`, and a generation is
 * always the write that touched it.
 */
function toResumeColumns(resume: GeneratedResume): Record<string, unknown> {
  return {
    resume_id: resume.id,
    resume_version: resume.version,
    resume_stage: resume.stage,
    resume_content: {
      createdAt: resume.createdAt,
      professionalSummary: resume.professionalSummary,
      skills: resume.skills,
      experience: resume.experience,
      education: resume.education,
      certifications: resume.certifications,
      projects: resume.projects,
      languages: resume.languages,
    },
    resume_html: resume.html,
    resume_pdf: resume.pdfPath,
  };
}

function toResume(row: any): GeneratedResume {
  const c = (row.resume_content ?? {}) as Record<string, any>;
  return {
    id: row.resume_id,
    resumeProfileId: row.id,
    version: row.resume_version ?? 0,
    stage: row.resume_stage ?? 0,
    professionalSummary: c.professionalSummary ?? "",
    skills: c.skills ?? [],
    experience: c.experience ?? [],
    education: c.education ?? [],
    certifications: c.certifications ?? [],
    projects: c.projects ?? [],
    languages: c.languages ?? [],
    html: row.resume_html ?? "",
    pdfPath: row.resume_pdf ?? null,
    createdAt: c.createdAt ?? row.updated_at,
  };
}

function toIterationAnswer(iteration: number, row: any): IterationAnswer {
  return {
    id: row.id,
    resumeProfileId: row.funnel_id,
    iteration,
    questionId: row.question_id,
    question: row.question,
    answer: row.answer ?? null,
    resumePdfPath: row.resume_pdf ?? null,
    createdAt: row.created_at,
  };
}
