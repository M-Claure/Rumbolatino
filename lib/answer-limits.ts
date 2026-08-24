/**
 * Per-answer character limits, to bound what we pay per call.
 *
 * A long answer is billed twice over:
 *   1. At capture — `buildNormalizerPrompt` embeds `rawAnswer` verbatim, and the
 *      rich sections (experience, projects, languages, achievements,
 *      certifications) route to the model via HybridAIProvider.
 *   2. On every later call — the résumé generation, analysis and proofread
 *      prompts re-send the stored `rawDescription` / `responsibilities` for the
 *      whole profile. So one oversized answer is paid for again on each
 *      generate, regenerate and analyze for the life of that profile.
 *
 * Limits are therefore sized to the longest answer a real person would give in
 * Spanish, not to the longest the model could digest. `long_text` at 600 chars
 * is roughly 100 words or four sentences — ample for the source of a résumé
 * bullet, and ~8× tighter than the previous blanket 5000.
 *
 * Pure module (no I/O, types only) so the browser, the Zod schemas and the
 * route handlers all read the SAME numbers. If the client capped at a different
 * value than the server, users would hit a 422 they could not see coming.
 */
import type { InputType } from "@/lib/ai/schemas";
import { getCatalogQuestion } from "@/lib/question-engine/question-catalog";

/**
 * Fallback limits BY INPUT TYPE. The real limit for a funnel question is the
 * `charLimit` on its catalog entry — sized per question, since a name and an
 * experience description need very different room. This table only covers
 * questions the catalog doesn't know, such as analyzer-generated follow-ups.
 */
export const ANSWER_CHAR_LIMITS: Record<InputType, number> = {
  // Narrative capture — the cost driver, and the only text the model rewrites.
  long_text: 600,
  repeatable_entry: 600,
  // Single facts: a name, a city, a job title.
  short_text: 160,
  // Answers assembled from options we supplied, so the ceiling is ours.
  single_select: 200,
  multi_select: 400,
  yes_no: 20,
  number: 20,
  date: 40,
  // Two date fields joined by " – ", so the ceiling allows both at full length.
  date_range: 100,
  // JSON payload of counts per experience type (see QuestionCard).
  type_counts: 400,
  // These carry no free text — decisions travel in `skillDecisions`.
  skill_confirmation: 200,
  review: 200,
};

/**
 * Fallback for a question the catalog does not know (e.g. an analyzer-generated
 * follow-up). Matches `long_text`: the generous case, never the tightest.
 */
export const DEFAULT_ANSWER_CHAR_LIMIT = ANSWER_CHAR_LIMITS.long_text;

/** Limit for an input type, falling back when the type is unknown. */
export function answerCharLimit(inputType: InputType | null | undefined): number {
  if (!inputType) return DEFAULT_ANSWER_CHAR_LIMIT;
  return ANSWER_CHAR_LIMITS[inputType] ?? DEFAULT_ANSWER_CHAR_LIMIT;
}

/**
 * Server-side resolution: derive the limit from the CATALOG rather than from
 * anything the client sent, so a crafted request can't raise its own ceiling.
 * Prefers the question's own `charLimit`, then the input-type fallback.
 */
export function answerCharLimitForQuestion(questionId: string): number {
  const catalog = getCatalogQuestion(questionId);
  if (!catalog) return DEFAULT_ANSWER_CHAR_LIMIT;
  return catalog.charLimit ?? answerCharLimit(catalog.inputType);
}

/**
 * Limit for a post-résumé improvement follow-up (`lib/resume/resume-analyzer.ts`).
 *
 * These answers reach three different endpoints — `/answers` for catalog
 * questions, `/interests/extract` for interests, `/enrich-entry` for the entry
 * deep-dives — each with its own ceiling. The UI can only show ONE number, and
 * showing a number the endpoint would reject is the failure this module exists
 * to prevent, so we resolve the TIGHTEST honest limit: the catalog's when the
 * questionId is a catalog question (identical to what `/answers` enforces), and
 * the input-type fallback otherwise. `experience_deepen`/`project_deepen` are
 * not catalog questions and land on `long_text` — the same 600 the review editor
 * allows for stored entry text, which is where a deep-dive answer ends up.
 */
export function followUpCharLimit(questionId: string, inputType: InputType | null | undefined): number {
  const catalog = getCatalogQuestion(questionId);
  if (catalog) return catalog.charLimit ?? answerCharLimit(catalog.inputType);
  return answerCharLimit(inputType);
}

/**
 * Limits for the up-front contact step (app/page.tsx), which is a form rather
 * than a catalog question.
 *
 * Sized to real values rather than to the shortest plausible ones: Spanish
 * naming routinely runs to two surnames plus a compound given name
 * ("María del Carmen Rodríguez Hernández" is 36), work addresses on a company
 * domain pass 30 easily ("maria.rodriguez@aprendeinstitute.com" is 36), and a
 * phone with a country code and separators needs more than its 10 digits
 * ("+52 55 1234 5678" is 16). Tighter caps would reject valid people.
 */
export const CONTACT_FIELD_CHAR_LIMITS = {
  fullName: 70,
  email: 80,
  phone: 20,
} as const;

/**
 * Limits for text that is STORED on an entry rather than submitted as an answer.
 * These matter as much as the answer limits: the résumé generation, analysis and
 * proofread prompts serialize the whole profile, so stored text is re-sent on
 * every one of those calls. They also close the back door — without them a user
 * could bypass the 600-char answer cap by editing the entry in the review step.
 */
export const ENTRY_TEXT_CHAR_LIMIT = ANSWER_CHAR_LIMITS.long_text;
/** Bullet-style items: responsibilities, tools, metrics, coursework, outcomes. */
export const LIST_ITEM_CHAR_LIMIT = 200;
export const LIST_MAX_ITEMS = 12;
/**
 * The objective, which every generation prompt carries. Held at 300 to match
 * `updates.careerGoal` in AnswerNormalizationSchema — a larger value here would
 * let the review editor store an objective the funnel itself could never produce.
 */
export const CAREER_GOAL_CHAR_LIMIT = 300;
export const TARGET_ROLE_CHAR_LIMIT = 200;

/**
 * Limits for the individual fields the Review screen edits directly.
 *
 * These numbers were previously written as bare literals inside the Zod request
 * schemas, which meant the screen could only show a counter by duplicating them —
 * and a duplicated limit drifts, leaving the person a counter that says "fits"
 * against a server that returns 422. `lib/validation/api-schemas.ts` and
 * `components/EditableReview.tsx` now both read from here, so the number under
 * the field is by construction the number the API enforces.
 */
export const REVIEW_FIELD_CHAR_LIMITS = {
  // ── Personal information ──
  firstName: 120,
  lastName: 120,
  // Five digits, plus room for a ZIP+4 someone pastes in.
  postalCode: 10,
  city: 120,
  state: 120,
  country: 120,
  email: 200,
  phone: 60,
  linkedInUrl: 300,
  portfolioUrl: 300,
  // ── Education / experience entry fields ──
  institution: 200,
  credential: 200,
  fieldOfStudy: 200,
  title: 200,
  organization: 200,
  location: 200,
  peopleServed: 200,
  /** Dates stay free text ("junio de 2019", "de marzo 2020 a la actualidad"). */
  date: 60,
  // ── Projects / certifications / languages / achievements ──
  /** A project's name, a certification's name, an achievement's title. */
  entryName: 200,
  /** Shorter than the rest because a language IS its name ("inglés"). */
  languageName: 80,
  // ── List entries: the cap is PER ITEM, not on the whole comma-separated box ──
  skillName: 80,
  interest: 80,
} as const;

/** Shown when an answer is over the limit; also used by the 422 message. */
export function tooLongMessage(limit: number): string {
  return `Tu respuesta es muy larga. Escríbela con ${limit} letras o menos.`;
}
