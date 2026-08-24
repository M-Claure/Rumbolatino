/**
 * Which category of work is this résumé about?
 *
 * PURE: no I/O, no env, no `server-only`, and — the point — **no model call**.
 * Publishing a profile must cost nothing, both because it happens after the
 * expensive part of the product is already paid for and because a classifier
 * that spends money is a classifier that stops working the moment
 * `AI_SPEND_CAP_DAILY_USD` is reached. This is the same two-layer split the
 * funnel already uses: `completeness-engine.ts` decides deterministically what
 * is eligible, and the model is only ever brought in for narrative.
 *
 * ── This function SUGGESTS; it never decides ────────────────────────────────
 * The output pre-selects a dropdown the user then confirms. It is deliberately
 * not wired to publish on its own. Filing somebody under "Servicios generales"
 * when they trained as a cosmetologist is the same class of mistake as inventing
 * a job title on their résumé — the entire product exists not to do that, and a
 * keyword score is nowhere near good enough to be trusted unattended.
 */
import { TALENT_CATEGORY_IDS, type TalentCategory } from "@/types/talent";
import { CATEGORIES } from "./taxonomy";
import { stripDiacritics } from "./text";

/**
 * Everything the classifier looks at. A narrow, plain shape rather than
 * `ResumeProfileState` so the whole thing can be unit-tested from a literal.
 */
export interface ClassificationInput {
  targetRole?: string | null;
  careerGoal?: string | null;
  /** CONFIRMED skill names only — a `suggested` skill is not yet a fact. */
  skills?: readonly string[];
  certifications?: readonly string[];
  education?: readonly {
    credential?: string | null;
    fieldOfStudy?: string | null;
  }[];
  experience?: readonly { title?: string | null }[];
}

export interface CategoryScore {
  category: TalentCategory;
  score: number;
  /** Which keywords fired, so the UI can say *why* a category was suggested. */
  matched: string[];
}

/**
 * How much each part of a résumé says about what someone does for a living.
 *
 * `targetRole` leads by a wide margin: it is the one field where the person
 * states, in the present tense, what work they are looking for. Everything else
 * is inference from history, and history can be the job they are trying to leave.
 */
const WEIGHTS = {
  targetRole: 5,
  certification: 3,
  education: 3,
  experienceTitle: 2,
  skill: 2,
  careerGoal: 1,
} as const;

/**
 * A single field can only contribute this many distinct keyword hits.
 *
 * Without it, one long career-goal paragraph that happens to name six kitchen
 * words outweighs the credential the person actually earned. The cap keeps a
 * verbose field from becoming a loud one.
 */
const MAX_HITS_PER_FIELD = 3;

/** Lowercase, strip accents, collapse whitespace. Applied to BOTH sides. */
export function normalizeForMatch(text: string): string {
  return stripDiacritics(text.toLocaleLowerCase("es"))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One regex per category, built once.
 *
 * Long keywords match as STEMS (`\bcocin` catches cocina/cocinero/cocinar);
 * keywords of four characters or fewer must match as WHOLE words, because a
 * short stem shows up inside unrelated ones — `\baseo` as a stem would fire on
 * nothing useful, but `\bspa` would happily match "spa" inside a longer token.
 */
const SHORT_KEYWORD_MAX = 4;

interface KeywordMatcher {
  readonly keyword: string;
  readonly re: RegExp;
}

const MATCHERS: Record<TalentCategory, readonly KeywordMatcher[]> = (() => {
  // Built with an explicit loop rather than `Object.fromEntries`, which widens the
  // key type back to `string` and would quietly accept a missing category.
  const out = {} as Record<TalentCategory, readonly KeywordMatcher[]>;
  for (const id of TALENT_CATEGORY_IDS) {
    out[id] = CATEGORIES[id].keywords.map((raw) => {
      const kw = normalizeForMatch(raw);
      const body = escapeRegExp(kw);
      return {
        keyword: raw,
        re: new RegExp(kw.length <= SHORT_KEYWORD_MAX ? `\\b${body}\\b` : `\\b${body}`),
      };
    });
  }
  return out;
})();

/** Add every category hit found in one field's text, respecting the per-field cap. */
function scoreField(
  text: string | null | undefined,
  weight: number,
  totals: Map<TalentCategory, number>,
  matched: Map<TalentCategory, Set<string>>,
): void {
  if (!text) return;
  const haystack = normalizeForMatch(text);
  if (!haystack) return;

  for (const category of TALENT_CATEGORY_IDS) {
    let hits = 0;
    for (const { keyword, re } of MATCHERS[category]) {
      if (hits >= MAX_HITS_PER_FIELD) break;
      if (!re.test(haystack)) continue;
      hits += 1;
      const set = matched.get(category);
      if (set) set.add(keyword);
      else matched.set(category, new Set([keyword]));
    }
    if (hits > 0) totals.set(category, (totals.get(category) ?? 0) + hits * weight);
  }
}

/**
 * Rank every category for this résumé, best first.
 *
 * Always returns the full list — the publish screen shows the top suggestion
 * pre-selected and the rest in a dropdown, so a wrong guess costs one tap rather
 * than a wrong listing. Ties break on the declared id order, which makes the
 * ranking deterministic for a given input (a property the tests pin).
 */
export function rankCategories(input: ClassificationInput): CategoryScore[] {
  const totals = new Map<TalentCategory, number>();
  const matched = new Map<TalentCategory, Set<string>>();

  scoreField(input.targetRole, WEIGHTS.targetRole, totals, matched);
  scoreField(input.careerGoal, WEIGHTS.careerGoal, totals, matched);

  for (const cert of input.certifications ?? []) {
    scoreField(cert, WEIGHTS.certification, totals, matched);
  }
  for (const entry of input.education ?? []) {
    scoreField(entry.fieldOfStudy, WEIGHTS.education, totals, matched);
    scoreField(entry.credential, WEIGHTS.education, totals, matched);
  }
  for (const entry of input.experience ?? []) {
    scoreField(entry.title, WEIGHTS.experienceTitle, totals, matched);
  }
  for (const skill of input.skills ?? []) {
    scoreField(skill, WEIGHTS.skill, totals, matched);
  }

  return TALENT_CATEGORY_IDS.map((category, declaredIndex) => ({
    category,
    declaredIndex,
    score: totals.get(category) ?? 0,
    matched: [...(matched.get(category) ?? [])],
  }))
    .sort((a, b) => b.score - a.score || a.declaredIndex - b.declaredIndex)
    .map(({ category, score, matched: m }) => ({ category, score, matched: m }));
}

/**
 * The category to pre-select. `otro` whenever nothing matched, so an unclassified
 * résumé asks the person instead of guessing at them.
 */
export function suggestCategory(input: ClassificationInput): TalentCategory {
  const top = rankCategories(input)[0];
  return top && top.score > 0 ? top.category : "otro";
}
