import "server-only";
import type { ResumeSection } from "@/types";
import type {
  AIProvider,
  AnalyzeResumeParams,
  ExtractInterestsParams,
  NormalizeAnswerParams,
  PlanQuestionParams,
  ProofreadResumeParams,
  ResumeGenerationInput,
  SuggestSkillsParams,
  TranslateResumeParams,
} from "./provider";
import type {
  AnswerNormalization,
  InterestsExtraction,
  PlannerDecision,
  ProofreadResult,
  ResumeAnalysisPayload,
  ResumeContent,
  SuggestedSkillPayload,
  TranslationResult,
} from "./schemas";

/**
 * Funnel sections whose free-text answers are narrative enough to be worth real LLM
 * parsing — one sentence routinely holds several fields ("English and Spanish,
 * perfectly" → two languages with levels; see the education note below).
 *
 * Everything NOT in this set stays on the deterministic parser: today that is
 * `career_goal`, `personal_information` and `skills`, whose answers are single
 * values a regex reads as well as a model would.
 *
 * Stated as "whatever is not listed here" on purpose, rather than as a second list.
 * The inverted copy that used to live in this comment drifted: it claimed education
 * and certifications were deterministic while both sat in the set two lines below,
 * so the only written description of the cost split was wrong about a third of it.
 */
const RICH_CAPTURE_SECTIONS = new Set<ResumeSection>([
  "experience",
  "projects",
  "languages",
  "achievements",
  "certifications",
  /*
   * Education belongs here, despite looking like a "simple field".
   *
   * One answer routinely contains a level, a school and a subject — "Terminé la
   * secundaria en el Colegio Nacional y estudié seis meses de administración" — and
   * the deterministic parser cannot split that: it dropped the WHOLE sentence into
   * `credential` and left `institution` and `fieldOfStudy` null. The résumé then
   * showed a run-on heading and no school at all, which is not a rendering problem
   * but a capture one. Splitting a narrative into fields is exactly what the model
   * is for; with reasoning off it is one of the cheapest calls we make.
   */
  "education",
]);

/**
 * Questions inside a rich section whose answers still carry NO narrative, and so
 * have nothing for the model to interpret. Routing by section alone sent these to
 * the model purely for belonging to `experience`:
 *
 *  - `experience_type_counts` — a machine-written JSON payload of counts per type
 *    (`{"caregiving":2}`), built by the counter UI, not typed by a person.
 *  - `experience_dates` — a date, now asked once per experience. The deterministic
 *    parser and `lib/experience-dates.ts` already own every format this product
 *    accepts, and they are what orders the résumé.
 *  - `education_dates` — the same, for the year a study finished.
 *
 * In the experience section that is five of roughly eleven calls removed for a
 * four-experience résumé (the counter, plus one date per entry), at no cost to
 * quality: there is no wording here to improve. `education_dates` removes one more.
 *
 * ── The consequence to keep in mind ──────────────────────────────────────────
 * Listing a question here makes the DETERMINISTIC parser the only thing that ever
 * reads that answer, even with Azure configured — there is no model to fall back on
 * and cover for it. That is what made `experience_dates` a bug: the mock wrote the
 * whole answer to `startDate` and dropped the rest, so "de marzo 2020 a la
 * actualidad" lost its end and the Review screen asked every person for a date they
 * had already given. A question belongs here only if the deterministic path captures
 * ALL of it — see `parseExperienceDateRange`.
 */
const MECHANICAL_QUESTION_IDS = new Set([
  "experience_type_counts",
  "experience_dates",
  "education_dates",
]);

/**
 * Cost-aware funnel provider used when AI_PROVIDER=azure. It routes the
 * per-answer capture that most affects résumé quality to the model (`capable`) and
 * keeps cheap/deterministic operations (question planning, skill inference,
 * simple-field normalization) on the mock (`deterministic`). Résumé generation
 * and analysis always use the model.
 */
export class HybridAIProvider implements AIProvider {
  readonly name = "hybrid";

  constructor(
    private readonly capable: AIProvider,
    private readonly deterministic: AIProvider,
  ) {}

  planNextQuestion(params: PlanQuestionParams): Promise<PlannerDecision> {
    return this.deterministic.planNextQuestion(params);
  }

  normalizeAnswer(params: NormalizeAnswerParams): Promise<AnswerNormalization> {
    // Question id wins over section: a mechanical answer inside a rich section
    // still has nothing worth paying the model to read.
    const rich =
      RICH_CAPTURE_SECTIONS.has(params.section) && !MECHANICAL_QUESTION_IDS.has(params.questionId);
    return (rich ? this.capable : this.deterministic).normalizeAnswer(params);
  }

  suggestSkills(params: SuggestSkillsParams): Promise<SuggestedSkillPayload[]> {
    return this.deterministic.suggestSkills(params);
  }

  extractInterests(params: ExtractInterestsParams): Promise<InterestsExtraction> {
    return this.capable.extractInterests(params);
  }

  generateResumeContent(input: ResumeGenerationInput): Promise<ResumeContent> {
    return this.capable.generateResumeContent(input);
  }

  analyzeResume(params: AnalyzeResumeParams): Promise<ResumeAnalysisPayload> {
    return this.capable.analyzeResume(params);
  }

  proofreadResume(params: ProofreadResumeParams): Promise<ProofreadResult> {
    return this.capable.proofreadResume(params);
  }

  /*
   * Model, always. The deterministic provider cannot translate — it would hand back
   * the Spanish text unchanged, and the user would download a "English résumé" that
   * is entirely in Spanish. A translation is also explicitly requested and paid for
   * by a user action, unlike the funnel capture this class exists to make cheap.
   */
  translateResume(params: TranslateResumeParams): Promise<TranslationResult> {
    return this.capable.translateResume(params);
  }
}
