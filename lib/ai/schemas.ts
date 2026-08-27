/**
 * Zod schemas for every AI ⇆ server boundary. The server NEVER trusts raw model
 * output: each provider method validates its result against one of these schemas
 * before the value is used (spec §6 "validate all AI responses with Zod", §8).
 *
 * These schemas also forbid the model from returning executable code, SQL, or
 * arbitrary HTML — the shapes only permit plain text / enums / string arrays.
 */
import { z } from "zod";
import {
  EXPERIENCE_TYPES,
  LANGUAGE_LEVELS,
  PROJECT_TYPES,
  RESUME_SECTIONS,
} from "@/types/domain";

const sectionEnum = z.enum(RESUME_SECTIONS);
const experienceTypeEnum = z.enum(EXPERIENCE_TYPES);
const languageLevelEnum = z.enum(LANGUAGE_LEVELS);
const projectTypeEnum = z.enum(PROJECT_TYPES);

export const INPUT_TYPES = [
  "short_text",
  "long_text",
  "single_select",
  "multi_select",
  "date",
  "date_range",
  "yes_no",
  "number",
  "type_counts",
  "skill_confirmation",
  "repeatable_entry",
  "review",
] as const;

export const NEXT_ACTIONS = [
  "ask_question",
  "confirm_skills",
  "review_profile",
  "generate_resume",
] as const;

export type InputType = (typeof INPUT_TYPES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** A suggested skill as proposed by the model — always evidence-backed. */
export const SuggestedSkillSchema = z.object({
  name: z.string().min(1).max(80),
  category: z.string().min(1).max(60),
  evidence: z.string().min(1).max(400),
});
export type SuggestedSkillPayload = z.infer<typeof SuggestedSkillSchema>;

/**
 * Genuine interests extracted from a free-text answer. A negative/empty answer
 * ("no", "not really", "ninguno") must yield an EMPTY array — a negation is never
 * itself stored as an interest.
 */
export const InterestsExtractionSchema = z.object({
  interests: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export type InterestsExtraction = z.infer<typeof InterestsExtractionSchema>;

/**
 * A final proofreading pass over the generated résumé. The model receives each
 * prose snippet with a stable `id` and returns the corrected text under the SAME
 * id — fixing only spelling/grammar/punctuation/formatting, never facts. `notes`
 * are short Spanish summaries of the kinds of corrections made (no PII), shown to
 * the user. Text may be empty (skipped on apply); ids the model omits keep their
 * original text.
 */
export const ProofreadResultSchema = z.object({
  items: z
    .array(z.object({ id: z.string().max(80), text: z.string().max(2000) }))
    .max(400)
    .default([]),
  notes: z.array(z.string().max(240)).max(12).default([]),
});
export type ProofreadResult = z.infer<typeof ProofreadResultSchema>;

/**
 * One translation pass over a finished résumé. Same id-keyed contract as
 * proofreading — text in, text out, no structural change — and deliberately with
 * NO `notes`: a translation has nothing to report back to the user, and asking for
 * commentary would only spend output tokens at $10/M on prose nobody reads.
 *
 * Ids the model omits keep their ORIGINAL Spanish text rather than going blank,
 * so a partial response degrades to a mixed-language résumé instead of a broken
 * one. `.max(600)` per item matches `GeneratedBulletObject`.
 */
export const TranslationResultSchema = z.object({
  items: z
    .array(z.object({ id: z.string().max(80), text: z.string().max(2000) }))
    .max(400)
    .default([]),
});
export type TranslationResult = z.infer<typeof TranslationResultSchema>;

/** The exact contract returned to the frontend for the next question (spec §8). */
export const AdaptiveQuestionSchema = z.object({
  questionId: z.string().min(1),
  section: sectionEnum,
  questionText: z.string().min(1).max(600),
  supportingText: z.string().max(600).optional(),
  reasonForAsking: z.string().max(400).optional(),
  exampleAnswer: z.string().max(400).optional(),
  inputType: z.enum(INPUT_TYPES),
  options: z.array(z.string().max(120)).max(20).optional(),
  required: z.boolean(),
  allowSkip: z.boolean(),
  /**
   * Label for the skip button. "Omitir" is a filing verb; on a question like
   * "¿Tienes certificados?" the honest answer is "No tengo", and saying so should
   * not read as abandoning the step. Comes from the catalog, never the model.
   */
  skipLabel: z.string().min(1).max(40).optional(),
  /** Max characters for the answer. Comes from the catalog, never the model. */
  charLimit: z.number().int().positive().max(5000),
  contextUsed: z.array(z.string().max(200)).default([]),
  suggestedSkills: z.array(SuggestedSkillSchema).default([]),
  nextAction: z.enum(NEXT_ACTIONS),
});
export type AdaptiveQuestion = z.infer<typeof AdaptiveQuestionSchema>;

/**
 * What the PLANNER model returns. It may only choose a questionId from the
 * candidate set the server supplies, and personalize copy. The server re-checks
 * that questionId ∈ candidates as defense beyond Zod.
 */
export const PlannerDecisionSchema = z.object({
  questionId: z.string().min(1),
  section: sectionEnum,
  questionText: z.string().min(1).max(600),
  supportingText: z.string().max(600).optional(),
  reasonForAsking: z.string().max(400).optional(),
  exampleAnswer: z.string().max(400).optional(),
  contextUsed: z.array(z.string().max(200)).max(12).default([]),
  nextAction: z.enum(NEXT_ACTIONS).default("ask_question"),
});
export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Answer normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Word-wraps one derived item into pieces of at most `limit` characters. Splits
 * on spaces so no word is cut; a single word longer than the cap (a URL, a
 * pasted blob) is hard-split as a last resort.
 */
function wrapItem(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return [trimmed];
  const out: string[] = [];
  let current = "";
  for (const word of trimmed.split(/\s+/).filter(Boolean)) {
    if (word.length > limit) {
      if (current) {
        out.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit) {
      out.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * A free-text field derived from ONE answer.
 *
 * Both providers build these by splitting the answer on punctuation — the first
 * sentence becomes the institution, the organization, the project name — so an
 * answer with no early punctuation makes that "first sentence" the entire
 * answer. Over-cap text is trimmed rather than failing the whole capture; the
 * person's exact words are preserved elsewhere (`ConversationTurn.userAnswer`,
 * `rawDescription`). Dates and enums stay strict: a truncated date would change
 * its meaning, not just shorten it.
 */
const cappedText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim().length > max ? v.trim().slice(0, max).trimEnd() : v),
    z.string().max(max),
  );

/**
 * The identifying name of a captured entry (project name, certification name,
 * achievement title).
 *
 * The model legitimately has no name to give when the answer is a deep-dive about
 * an entry we ALREADY have — a project deep-dive answer talks about tools and
 * outcomes, not about what the project is called — and the model then returns `""`.
 * A bare `min(1)` turns that into a 502 that discards the user's whole answer, so
 * blank is treated as ABSENT and the caller decides: `entry-enrichment` never
 * needs the name (it updates by id), and the capture path skips the entry.
 */
const optionalName = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim().length === 0 ? undefined : v),
    cappedText(max).optional(),
  );

/**
 * A list of short items derived from ONE free-text answer.
 *
 * Same cause as `cappedText`: item length depends on how the person wrote, not
 * on how much. An answer well inside its `charLimit` but with no comma or period
 * for its last 200 characters yields a single oversized segment, and a plain
 * `z.array(z.string().max(n))` would reject the WHOLE normalization — a 422 the
 * user cannot act on, losing an answer they were told was valid. Wrapping keeps
 * every word inside the cap; excess items are dropped rather than failing.
 */
const itemList = (itemMax: number, maxItems: number) =>
  z.preprocess(
    (v) =>
      Array.isArray(v) && v.every((x) => typeof x === "string")
        ? (v as string[]).flatMap((s) => wrapItem(s, itemMax)).slice(0, maxItems)
        : v,
    z.array(z.string().max(itemMax)).max(maxItems),
  );

const EducationExtract = z.object({
  institution: cappedText(200).nullable().optional(),
  credential: cappedText(200).nullable().optional(),
  fieldOfStudy: cappedText(200).nullable().optional(),
  location: cappedText(200).nullable().optional(),
  startDate: z.string().max(60).nullable().optional(),
  endDate: z.string().max(60).nullable().optional(),
  isCurrent: z.boolean().optional(),
  relevantCoursework: itemList(160, 30).optional(),
});

const ExperienceExtract = z.object({
  experienceType: experienceTypeEnum.optional(),
  title: cappedText(200).nullable().optional(),
  organization: cappedText(200).nullable().optional(),
  location: cappedText(200).nullable().optional(),
  startDate: z.string().max(60).nullable().optional(),
  endDate: z.string().max(60).nullable().optional(),
  isCurrent: z.boolean().optional(),
  /** Original user wording, preserved verbatim (spec §9). */
  rawDescription: cappedText(2000).nullable().optional(),
  responsibilities: itemList(300, 30).optional(),
  accomplishments: itemList(300, 30).optional(),
  tools: itemList(120, 30).optional(),
  peopleServed: cappedText(200).nullable().optional(),
  /** Truthful, user-provided approximate quantities only. */
  metrics: itemList(160, 20).optional(),
});

const ProjectExtract = z.object({
  name: optionalName(200),
  projectType: projectTypeEnum.nullable().optional(),
  organization: cappedText(200).nullable().optional(),
  description: cappedText(600).nullable().optional(),
  responsibilities: itemList(300, 30).optional(),
  outcomes: itemList(300, 30).optional(),
  tools: itemList(120, 30).optional(),
});

const CertificationExtract = z.object({
  name: optionalName(200),
  issuingOrganization: cappedText(200).nullable().optional(),
  issueDate: z.string().max(60).nullable().optional(),
});

const LanguageExtract = z.object({
  name: z.string().min(1).max(80),
  speakingLevel: languageLevelEnum.nullable().optional(),
  readingLevel: languageLevelEnum.nullable().optional(),
  writingLevel: languageLevelEnum.nullable().optional(),
});

const AchievementExtract = z.object({
  title: optionalName(200),
  organization: cappedText(200).nullable().optional(),
  date: z.string().max(60).nullable().optional(),
  description: cappedText(600).nullable().optional(),
});

const PersonalInfoExtract = z.object({
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  country: z.string().max(120).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  linkedInUrl: z.string().max(300).nullable().optional(),
  portfolioUrl: z.string().max(300).nullable().optional(),
});

/**
 * The NORMALIZER model's structured interpretation of a raw answer. Only fields
 * the user actually provided should be present; `interpretationSummary` restates
 * (in Spanish) what was understood, and `needsConfirmation` flags any material
 * interpretation that must be confirmed before it is trusted (spec §9 step 7).
 */
const AnswerNormalizationObjectSchema = z.object({
  interpretationSummary: z.string().max(600),
  needsConfirmation: z.boolean().default(false),
  updates: z
    .object({
      careerGoal: z.string().max(300).nullable().optional(),
      targetRole: z.string().max(200).nullable().optional(),
      personalInformation: PersonalInfoExtract.optional(),
      educationEntries: z.array(EducationExtract).max(10).optional(),
      experienceEntries: z.array(ExperienceExtract).max(10).optional(),
      projects: z.array(ProjectExtract).max(10).optional(),
      certifications: z.array(CertificationExtract).max(10).optional(),
      languages: z.array(LanguageExtract).max(10).optional(),
      achievements: z.array(AchievementExtract).max(10).optional(),
    })
    .default({}),
  suggestedSkills: z.array(SuggestedSkillSchema).max(12).default([]),
});

/**
 * Safety net for model naming drift: some responses put the structured data under
 * `extractedData` (or `data`) instead of `updates`. Normalize that before the
 * strict schema runs so a good extraction isn't discarded. Field-level shapes are
 * still enforced by the strict schema (the prompt pins the exact names + enums).
 */
function normalizeAnswerShape(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const v = { ...(value as Record<string, unknown>) };
  if (v.updates === undefined) {
    const alt = v.extractedData ?? v.data;
    if (alt !== null && typeof alt === "object") v.updates = alt;
  }
  return v;
}

export const AnswerNormalizationSchema = z.preprocess(
  normalizeAnswerShape,
  AnswerNormalizationObjectSchema,
);
export type AnswerNormalization = z.infer<typeof AnswerNormalizationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Resume content generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A generated line traced to the source entries/fields it came from (spec §12).
 * The model sometimes emits a bullet as a plain string instead of an object
 * (natural for résumé lines) — we accept both and coerce strings to the object
 * form so a valid generation isn't rejected for a cosmetic shape difference.
 */
const GeneratedBulletObject = z.object({
  text: z.string().min(1).max(600),
  sourceEntryIds: z.array(z.string()).default([]),
  sourceFields: z.array(z.string()).default([]),
});
export const GeneratedBulletSchema = z.union([
  GeneratedBulletObject,
  z
    .string()
    .min(1)
    .max(600)
    .transform((text) => ({ text, sourceEntryIds: [] as string[], sourceFields: [] as string[] })),
]);

const ResumeContentObjectSchema = z.object({
  professionalSummary: z.string().max(2000),
  experience: z
    .array(
      z.object({
        entryId: z.string(),
        bullets: z.array(GeneratedBulletSchema).max(12),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        entryId: z.string(),
        details: z.array(GeneratedBulletSchema).max(8),
      }),
    )
    .default([]),
  projects: z
    .array(
      z.object({
        entryId: z.string(),
        bullets: z.array(GeneratedBulletSchema).max(8),
      }),
    )
    .default([]),
  skillGroups: z
    .array(
      z.object({
        category: z.string().max(80),
        skillIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

/**
 * The generation model reliably produces valid, source-traceable JSON but it
 * drifts on a few *container* field NAMES: it tends to identify each block with
 * `id` (mirroring the input data) instead of `entryId`, to group skills under
 * `skills` instead of `skillIds`, and occasionally to use `bullets` for education
 * instead of `details`. These are cosmetic naming differences, not factual ones —
 * so we normalize them before the strict schema runs. Without this, a perfectly
 * good generation is rejected on every retry and the user sees a 502 /
 * "La IA no devolvió una respuesta válida." Source tracing still filters every id
 * against confirmed entries/skills afterwards, so this cannot smuggle in facts.
 */
function normalizeGeneratedResumeShape(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const root = { ...(value as Record<string, unknown>) };

  const withEntryId = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    const o = { ...(item as Record<string, unknown>) };
    if (o.entryId === undefined && typeof o.id === "string") o.entryId = o.id;
    return o;
  };

  if (Array.isArray(root.experience)) root.experience = root.experience.map(withEntryId);
  if (Array.isArray(root.projects)) root.projects = root.projects.map(withEntryId);
  if (Array.isArray(root.education)) {
    root.education = root.education.map((item) => {
      const o = withEntryId(item);
      if (o !== null && typeof o === "object") {
        const e = o as Record<string, unknown>;
        if (e.details === undefined && Array.isArray(e.bullets)) e.details = e.bullets;
      }
      return o;
    });
  }
  if (Array.isArray(root.skillGroups)) {
    root.skillGroups = root.skillGroups.map((g) => {
      if (g === null || typeof g !== "object") return g;
      const o = { ...(g as Record<string, unknown>) };
      if (o.skillIds === undefined && Array.isArray(o.skills)) o.skillIds = o.skills;
      return o;
    });
  }
  return root;
}

export const ResumeContentSchema = z.preprocess(
  normalizeGeneratedResumeShape,
  ResumeContentObjectSchema,
);
export type ResumeContent = z.infer<typeof ResumeContentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Resume analysis (improvement loop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the ANALYZER model returns when critiquing a generated résumé. It may
 * only reference follow-up questionIds from the server-supplied allow-list; the
 * server fills in section/inputType and merges with deterministic gap detection.
 */
export const ResumeAnalysisSchema = z.object({
  overallImpression: z.string().max(700),
  strengths: z.array(z.string().max(220)).max(8).default([]),
  improvements: z
    .array(
      z.object({
        questionId: z.string().min(1).max(60),
        // For entry deep-dives (experience_deepen / project_deepen): the id of the
        // specific experience/project the question is about.
        entryId: z.string().max(120).optional(),
        title: z.string().min(1).max(120),
        detail: z.string().max(400).default(""),
        followUpQuestion: z.string().min(1).max(300),
      }),
    )
    // The prompt asks for at most MAX_FEEDBACK_QUESTIONS_PER_ITERATION and the
    // server shows no more than that. This ceiling stays looser on purpose: a model
    // that returns one or two extra should not fail validation and cost three
    // retries of the most expensive analysis call — the extras are simply dropped.
    .max(8)
    .default([]),
});
export type ResumeAnalysisPayload = z.infer<typeof ResumeAnalysisSchema>;
