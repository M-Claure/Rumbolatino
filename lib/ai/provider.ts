/**
 * Provider abstraction so the language model can be swapped (spec §2).
 * Implementations: MockAIProvider (deterministic, offline) and AzureOpenAIProvider.
 *
 * Every method returns a value already validated against a Zod schema in
 * lib/ai/schemas.ts — callers can trust the shape.
 */
import type { ResumeLang, ResumeProfileState, ResumeSection } from "@/types";
import type { GeneratedResume } from "@/types";
import type {
  AnswerNormalization,
  InputType,
  InterestsExtraction,
  PlannerDecision,
  ProofreadResult,
  ResumeAnalysisPayload,
  ResumeContent,
  SuggestedSkillPayload,
  TranslationResult,
} from "./schemas";

/** A catalog-derived question the planner is allowed to choose from. */
export interface QuestionCandidate {
  questionId: string;
  section: ResumeSection;
  defaultText: string;
  inputType: InputType;
  required: boolean;
  allowSkip: boolean;
  options?: string[];
  /** Short hint (Spanish) about why this question matters — helps the planner. */
  intent?: string;
}

export interface PlanQuestionParams {
  state: ResumeProfileState;
  candidates: QuestionCandidate[];
  recommendedSection: ResumeSection;
}

export interface NormalizeAnswerParams {
  section: ResumeSection;
  questionId: string;
  questionText: string;
  rawAnswer: string;
  state: ResumeProfileState;
}

export interface SuggestSkillsParams {
  state: ResumeProfileState;
  /** Restrict inference to these experience entries (e.g. the just-added one). */
  focusExperienceIds?: string[];
  /** Skill names already suggested/confirmed/rejected — never re-suggest these. */
  excludeSkillNames: string[];
}

export interface ExtractInterestsParams {
  /** The user's raw free-text answer to an "interests" follow-up. */
  rawAnswer: string;
  /** Interests already saved — never duplicate these. */
  existing: string[];
}

export interface ProofreadResumeParams {
  /** Prose snippets to correct, each with a stable id the response must echo. */
  items: Array<{ id: string; text: string }>;
}

export interface TranslateResumeParams {
  /** Résumé fragments to translate, each with a stable id the response must echo. */
  items: Array<{ id: string; text: string }>;
  /** The language to translate INTO. The source is always the Spanish résumé. */
  targetLanguage: ResumeLang;
}

/** Confirmed-only data handed to resume generation (spec §12). */
export interface ResumeGenerationInput {
  careerGoal: string | null;
  targetRole: string | null;
  experience: Array<{
    id: string;
    experienceType: string;
    title: string | null;
    organization: string | null;
    responsibilities: string[];
    accomplishments: string[];
    tools: string[];
    peopleServed: string | null;
    metrics: string[];
    rawDescription: string | null;
  }>;
  education: Array<{
    id: string;
    institution: string | null;
    credential: string | null;
    fieldOfStudy: string | null;
    relevantCoursework: string[];
    achievements: string[];
  }>;
  projects: Array<{
    id: string;
    name: string;
    description: string | null;
    responsibilities: string[];
    outcomes: string[];
    tools: string[];
  }>;
  skills: Array<{ id: string; name: string; category: string }>;
  /** User-editable résumé style/format guidelines the model should follow. */
  guidelines?: string;
}

/** Follow-up questionIds the analyzer is allowed to reference. */
export interface AnalyzeResumeParams {
  state: ResumeProfileState;
  resume: GeneratedResume;
  /** Deterministic gap hints the model should incorporate/expand. */
  gapHints: string[];
  /** Allowed follow-up questionIds the model may reference. */
  allowedQuestionIds: string[];
  /** User-editable résumé guidelines to judge the résumé against. */
  guidelines?: string;
}

export interface AIProvider {
  readonly name: string;
  planNextQuestion(params: PlanQuestionParams): Promise<PlannerDecision>;
  normalizeAnswer(params: NormalizeAnswerParams): Promise<AnswerNormalization>;
  suggestSkills(params: SuggestSkillsParams): Promise<SuggestedSkillPayload[]>;
  /** Extract genuine interests from a free-text answer; [] for a negation. */
  extractInterests(params: ExtractInterestsParams): Promise<InterestsExtraction>;
  generateResumeContent(input: ResumeGenerationInput): Promise<ResumeContent>;
  analyzeResume(params: AnalyzeResumeParams): Promise<ResumeAnalysisPayload>;
  /** Final spelling/grammar/formatting pass over generated prose (facts preserved). */
  proofreadResume(params: ProofreadResumeParams): Promise<ProofreadResult>;
  /** Translate a finished résumé's prose and labels (facts and structure preserved). */
  translateResume(params: TranslateResumeParams): Promise<TranslationResult>;
}
