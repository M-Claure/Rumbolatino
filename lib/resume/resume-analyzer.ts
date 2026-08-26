/**
 * Resume analysis for the improvement loop. Critiques a generated résumé and
 * proposes targeted follow-up questions to make it stronger.
 *
 * Design: deterministic gap detection is the source of truth for which
 * follow-ups are actionable (each maps to a known, routable questionId). The AI
 * adds an overall impression, strengths, and better-worded questions — but the
 * server fills section/inputType from FOLLOWUP_DEFS (never trusting the model
 * for routing) and guarantees the detected gaps are present.
 */
import type { ResumeProfileState } from "@/types";
import type { AIProvider } from "@/lib/ai";
import type { InputType } from "@/lib/ai/schemas";
import { followUpCharLimit } from "@/lib/answer-limits";
import { DEEP_DIVE_SLOTS, MAX_FEEDBACK_QUESTIONS_PER_ITERATION } from "@/lib/config/limits";
import { Errors } from "@/lib/errors";
import type { Store } from "@/lib/repositories/store";
import { assembleProfileState } from "@/lib/profile-state";
import { analysisFingerprint, getCachedAnalysis, setCachedAnalysis } from "./analysis-cache";
import { getResumeGuidelines } from "./guidelines";

interface FollowupDef {
  /** Display grouping. A real ResumeSection for pipeline routing, or "interests". */
  section: string;
  inputType: InputType;
  title: string;
  defaultQuestion: string;
  /** Whether this follow-up is relevant given the current profile. */
  applies: (s: ResumeProfileState) => boolean;
  /** Lower = surfaced first. */
  priority: number;
}

const has = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;
const thinExperience = (s: ResumeProfileState) =>
  s.experience.some((e) => e.responsibilities.length + e.accomplishments.length < 3);

/**
 * The allow-listed follow-ups. All non-"interests" questionIds are real catalog
 * questions the answer pipeline already handles; "interests" routes to the
 * interests endpoint. (personal_location is intentionally omitted — the generic
 * normalizer would misread a city as a name.)
 */
export const FOLLOWUP_DEFS: Record<string, FollowupDef> = {
  experience_results: {
    section: "experience",
    inputType: "long_text",
    title: "Añade resultados a tu experiencia",
    defaultQuestion:
      "¿Hubo algún resultado o logro concreto en tu experiencia? Puede ser una cantidad aproximada y verdadera.",
    applies: (s) => s.experience.some((e) => e.accomplishments.length === 0 && e.metrics.length === 0),
    priority: 1,
  },
  experience_scope: {
    section: "experience",
    inputType: "long_text",
    title: "Amplía lo que hacías",
    defaultQuestion:
      "¿Qué herramientas usabas y a quién atendías (clientes, personas, documentos, dinero, inventario)?",
    applies: (s) => s.experience.some((e) => e.tools.length === 0 || !has(e.peopleServed)),
    priority: 2,
  },
  skills_add: {
    section: "skills",
    inputType: "long_text",
    title: "Suma más habilidades",
    defaultQuestion: "¿Qué otras habilidades tienes? Escríbelas separadas por comas.",
    applies: (s) => s.confirmedSkills.length < 3,
    priority: 3,
  },
  languages_any: {
    section: "languages",
    inputType: "long_text",
    title: "Agrega los idiomas que hablas",
    defaultQuestion: "¿Qué idiomas hablas y en qué nivel? (por ejemplo: español nativo, inglés básico)",
    applies: (s) => s.languages.length === 0,
    priority: 4,
  },
  interests: {
    section: "interests",
    inputType: "short_text",
    title: "Añade tus intereses",
    defaultQuestion: "¿Qué intereses o pasatiempos te gustaría incluir? Sepáralos por comas.",
    applies: (s) => s.interests.length === 0,
    priority: 5,
  },
  projects_any: {
    section: "projects",
    inputType: "long_text",
    title: "Incluye un proyecto",
    defaultQuestion: "¿Has hecho algún proyecto personal, escolar o comunitario que quieras mostrar?",
    applies: (s) => s.projects.length === 0,
    priority: 6,
  },
  certifications_any: {
    section: "certifications",
    inputType: "long_text",
    title: "Agrega certificados o cursos",
    defaultQuestion: "¿Tienes certificados o cursos que quieras incluir?",
    applies: (s) => s.certifications.length === 0,
    priority: 7,
  },
  education_details: {
    section: "education",
    inputType: "long_text",
    title: "Detalla tu educación",
    defaultQuestion: "¿Dónde estudiaste y qué aprendiste que sea relevante para este puesto?",
    applies: (s) => s.education.some((e) => !has(e.institution) || e.relevantCoursework.length === 0),
    priority: 8,
  },
  // Last of the gaps, because it is the one fewest people have an answer for.
  // It lives here rather than in the funnel for the same reason as the three
  // above it: the funnel ends at the experience loop, and a question nobody can
  // answer is better asked against a résumé you can already see.
  achievements_any: {
    section: "achievements",
    inputType: "long_text",
    title: "Destaca un logro",
    defaultQuestion: "¿Tienes algún logro o reconocimiento que quieras destacar?",
    applies: (s) => s.achievements.length === 0,
    priority: 9,
  },
};

/** Entry deep-dive question ids (personalized questions about a specific entry). */
const DEEPEN_TYPES: Record<string, "experience" | "project"> = {
  experience_deepen: "experience",
  project_deepen: "project",
};

export interface AnalysisImprovement {
  questionId: string;
  section: string;
  inputType: InputType;
  title: string;
  detail: string;
  followUpQuestion: string;
  /**
   * Max characters for the answer, resolved server-side (never from the client)
   * so the counter the UI shows is exactly what the endpoint will accept.
   */
  charLimit: number;
  /** Set for entry deep-dives — the answer enriches this specific entry. */
  entryType?: "experience" | "project";
  entryId?: string;
}

/** An improvement before its limit is attached — the shape the builders below produce. */
type ImprovementDraft = Omit<AnalysisImprovement, "charLimit">;

const withCharLimit = (i: ImprovementDraft): AnalysisImprovement => ({
  ...i,
  charLimit: followUpCharLimit(i.questionId, i.inputType),
});

export interface ResumeAnalysis {
  overallImpression: string;
  strengths: string[];
  improvements: AnalysisImprovement[];
}

/** Deterministic gaps → baseline improvements (always routable). */
/**
 * Follow-ups the person already declined in the funnel.
 *
 * Several `FOLLOWUP_DEFS` keys are also catalog question ids (`languages_any`,
 * `certifications_any`, `projects_any`, `skills_add`, `education_details`), so
 * pressing "No tengo" on one of them is recorded in `skippedQuestionIds` and this
 * is where that answer is honoured: asking again — round after round — for
 * certificates someone has just said they do not have is not an improvement
 * suggestion, it is nagging.
 */
function wasDeclined(state: ResumeProfileState, questionId: string): boolean {
  return state.skippedQuestionIds.includes(questionId);
}

function detectGaps(state: ResumeProfileState): ImprovementDraft[] {
  const out: ImprovementDraft[] = [];
  for (const [questionId, def] of Object.entries(FOLLOWUP_DEFS)) {
    // Treat thin experience as a stronger trigger for the experience follow-ups.
    const applies = def.applies(state) || (def.section === "experience" && thinExperience(state));
    if (!applies) continue;
    // "No tengo" in the funnel is an answer, not a blank to be chased.
    if (wasDeclined(state, questionId)) continue;
    out.push({
      questionId,
      section: def.section,
      inputType: def.inputType,
      title: def.title,
      detail: "",
      followUpQuestion: def.defaultQuestion,
    });
  }
  return out.sort((a, b) => FOLLOWUP_DEFS[a.questionId]!.priority - FOLLOWUP_DEFS[b.questionId]!.priority);
}

/**
 * Any id, in any user-facing string, is a bug — enforced here rather than asked
 * for in the prompt.
 *
 * The analysis prompt hands the model every entry's id, because it needs them to
 * target a deep-dive (`entryId`), and asks it to name the experience or project it
 * is asking about. When an entry is BLANK — the person skipped that section, so
 * there is no title, organization or name to use — the only handle left is the id,
 * and the model writes that instead: «Cuéntame más sobre
 * «a93ce414-1138-483c-b346-bfc020affd8c»».
 *
 * Deleting the id is not enough: "Sobre «<id>»: ¿qué herramientas usaste?" becomes
 * "Sobre: ¿qué herramientas usaste?", a question that lost its subject. So a
 * deep-dive has the id REPLACED by the entry's human label, which is what the
 * sentence was reaching for; anywhere else — section questions, the overall
 * impression, the strengths — an id means the sentence carries no information for
 * the reader, and the text is discarded for the deterministic wording instead.
 *
 * Both shapes are caught: the exact ids we handed over, and anything UUID-shaped.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function containsId(text: string, knownIds: Set<string>): boolean {
  if (new RegExp(UUID_RE.source, "i").test(text)) return true;
  for (const id of knownIds) if (id && text.includes(id)) return true;
  return false;
}

/** Swap every id for `name`, then tidy what the substitution leaves behind. */
function replaceIds(text: string, knownIds: Set<string>, name: string): string {
  let out = text.replace(UUID_RE, name);
  for (const id of knownIds) {
    if (id) out = out.split(id).join(name);
  }
  return out
    // The id often already sat inside quotes, so substituting a label can double them.
    .replace(/«\s*«/g, "«")
    .replace(/»\s*»/g, "»")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

/**
 * True when a string is no longer usable as a question or title — it was only ever
 * an id, or the repair left nothing meaningful.
 */
function degenerate(text: string): boolean {
  return text.replace(/[^\p{L}\p{N}]/gu, "").length < 3;
}

/**
 * Scrub a model-authored improvement. `entryName` is the label to substitute for a
 * deep-dive; pass `null` for a section question, where an id cannot be repaired
 * into anything meaningful and `defaults` are used instead.
 */
function scrubImprovement(
  draft: ImprovementDraft,
  knownIds: Set<string>,
  entryName: string | null,
  defaults: { title: string; followUpQuestion: string },
): ImprovementDraft {
  const fix = (text: string, fallback: string): string => {
    if (!containsId(text, knownIds)) return text;
    if (entryName === null) return fallback;
    const repaired = replaceIds(text, knownIds, entryName);
    return degenerate(repaired) ? fallback : repaired;
  };
  // `detail` is a required string on the improvement, and the workspace hides it
  // when empty — so "" is how an unrepairable "why this helps" line is dropped.
  const rawDetail = draft.detail ?? "";
  const detail = !containsId(rawDetail, knownIds)
    ? rawDetail
    : entryName === null
      ? ""
      : (() => {
          const repaired = replaceIds(rawDetail, knownIds, entryName);
          return degenerate(repaired) ? "" : repaired;
        })();

  return {
    ...draft,
    title: fix(draft.title, defaults.title),
    followUpQuestion: fix(draft.followUpQuestion, defaults.followUpQuestion),
    detail,
  };
}

/**
 * The human label a deep-dive question uses for an entry — never an id.
 *
 * A blank entry (the person skipped that section) has no title, organization or
 * name, so it falls back to a generic phrase. Shared by the deterministic pass and
 * the AI merge so the two cannot word the same question differently.
 */
function experienceName(e: ResumeProfileState["experience"][number]): string {
  return e.title || e.organization || "esta experiencia";
}

function projectName(p: ResumeProfileState["projects"][number]): string {
  return p.name || "este proyecto";
}

/** The bare name for an entry, for substituting into a sentence. */
function nameForEntry(
  state: ResumeProfileState,
  type: "experience" | "project",
  entryId: string | undefined,
): string {
  if (type === "experience") {
    const e = state.experience.find((x) => x.id === entryId);
    return e ? experienceName(e) : "esta experiencia";
  }
  const p = state.projects.find((x) => x.id === entryId);
  return p ? projectName(p) : "este proyecto";
}

/** Personalized deep-dive questions targeting specific thin experience/project entries. */
function detectDeepDives(state: ResumeProfileState): ImprovementDraft[] {
  const out: ImprovementDraft[] = [];
  for (const e of state.experience) {
    const thin = e.tools.length === 0 || e.responsibilities.length + e.accomplishments.length < 3;
    if (!thin) continue;
    const label = `«${experienceName(e)}»`;
    out.push({
      questionId: "experience_deepen",
      entryType: "experience",
      entryId: e.id,
      section: "experience",
      inputType: "long_text",
      title: `Cuéntame más sobre ${label}`,
      detail: "Más detalle (herramientas, cómo lo hiciste, resultados) hace esta experiencia mucho más fuerte.",
      followUpQuestion: `Sobre ${label}: ¿qué herramientas o programas usaste y cómo lo lograste?`,
    });
  }
  for (const p of state.projects) {
    const thin = p.tools.length === 0 || p.responsibilities.length + p.outcomes.length < 2;
    if (!thin) continue;
    const label = `«${projectName(p)}»`;
    out.push({
      questionId: "project_deepen",
      entryType: "project",
      entryId: p.id,
      section: "project",
      inputType: "long_text",
      title: `Cuéntame más sobre ${label}`,
      detail: "Explica qué herramientas usaste, cómo lo construiste y qué lograste.",
      followUpQuestion: `Sobre ${label}: ¿qué herramientas o tecnologías usaste, cómo lo hiciste y qué resultado obtuviste?`,
    });
  }
  return out;
}

function buildGapHints(state: ResumeProfileState): string[] {
  return [...detectGaps(state), ...detectDeepDives(state)].map((g) => g.title);
}

/** Display order: section gaps by priority, then the per-entry deep-dives. */
function byPriority(a: ImprovementDraft, b: ImprovementDraft): number {
  return (FOLLOWUP_DEFS[a.questionId]?.priority ?? 50) - (FOLLOWUP_DEFS[b.questionId]?.priority ?? 50);
}

/**
 * Trims a round to `MAX_FEEDBACK_QUESTIONS_PER_ITERATION` questions.
 *
 * A plain "top N by priority" would be wrong: the eight section gaps hold
 * priorities 1–8 while every personalized deep-dive falls back to 50, so the cap
 * would silently delete exactly the questions that most improve the résumé
 * ("Cuéntame más sobre «Negocio de limpieza»"). So `DEEP_DIVE_SLOTS` of the five
 * are held for deep-dives, the rest go to the highest-priority gaps, and either
 * side backfills whatever the other doesn't use — a profile with no thin entries
 * still gets five gaps, and one with nothing but thin entries still gets five
 * deep-dives.
 */
function selectImprovements(drafts: ImprovementDraft[]): ImprovementDraft[] {
  const isDeepDive = (i: ImprovementDraft) => DEEPEN_TYPES[i.questionId] !== undefined;
  const deepDives = drafts.filter(isDeepDive);
  const gaps = drafts.filter((i) => !isDeepDive(i)).sort(byPriority);

  const reserved = Math.min(DEEP_DIVE_SLOTS, deepDives.length);
  const chosen = [
    ...gaps.slice(0, MAX_FEEDBACK_QUESTIONS_PER_ITERATION - reserved),
    ...deepDives.slice(0, reserved),
  ];
  // Backfill any slot the other side left empty.
  if (chosen.length < MAX_FEEDBACK_QUESTIONS_PER_ITERATION) {
    const rest = [...gaps, ...deepDives].filter((i) => !chosen.includes(i));
    chosen.push(...rest.slice(0, MAX_FEEDBACK_QUESTIONS_PER_ITERATION - chosen.length));
  }
  return chosen.sort(byPriority);
}

export async function analyzeResume(store: Store, ai: AIProvider, profileId: string): Promise<ResumeAnalysis> {
  const state = await assembleProfileState(store, profileId);
  const resume = await store.getLatestGeneratedResume(profileId);
  if (!resume) throw Errors.notFound("Aún no se ha generado un currículum para analizar.");

  // Serve an identical critique from memory rather than paying for it again. The
  // key covers the résumé version and every profile fact the detectors below read,
  // so answering a follow-up or regenerating invalidates it automatically.
  const cacheKey = analysisFingerprint(state, resume);
  const cached = getCachedAnalysis(profileId, cacheKey);
  if (cached) return cached;

  const gaps = detectGaps(state);
  const deepDives = detectDeepDives(state);
  const experienceIds = new Set(state.experience.map((e) => e.id));
  const projectIds = new Set(state.projects.map((p) => p.id));
  // Every id the model was shown, so an echo of one can be recognised verbatim.
  const knownIds = new Set([...experienceIds, ...projectIds]);

  // The AI adds impression/strengths/better wording, but the deterministic gaps +
  // deep-dives are the routable source of truth. If the AI call fails (validation,
  // truncation, network), fall back to a deterministic analysis instead of hard-
  // failing the whole improvement loop with a 502.
  let ai_result: Awaited<ReturnType<AIProvider["analyzeResume"]>>;
  try {
    ai_result = await ai.analyzeResume({
      state,
      resume,
      gapHints: buildGapHints(state),
      allowedQuestionIds: [...Object.keys(FOLLOWUP_DEFS), ...Object.keys(DEEPEN_TYPES)],
      guidelines: getResumeGuidelines(),
    });
  } catch (err) {
    console.error("[analyzeResume] AI analysis failed; using deterministic gaps only.", err);
    return {
      overallImpression:
        "Tu currículum ya tiene una base sólida. Responde las siguientes preguntas para hacerlo más completo y fuerte.",
      strengths: [],
      improvements: selectImprovements([...gaps, ...deepDives]).map(withCharLimit),
    };
  }

  // Merge: deterministic gaps + deep-dives are the routable baseline; the AI
  // enriches matching items (better/personalized wording). Keyed by questionId
  // plus entryId so multiple deep-dives (one per entry) coexist.
  const key = (i: { questionId: string; entryId?: string }) => `${i.questionId}:${i.entryId ?? ""}`;
  const byId = new Map<string, ImprovementDraft>();
  for (const g of [...gaps, ...deepDives]) byId.set(key(g), g);

  for (const imp of ai_result.improvements) {
    const deepenType = DEEPEN_TYPES[imp.questionId];
    if (deepenType) {
      // Entry deep-dive: entryId must reference a real entry of the right type.
      const valid = deepenType === "experience" ? experienceIds.has(imp.entryId ?? "") : projectIds.has(imp.entryId ?? "");
      if (!valid) continue;
      // A deep-dive the deterministic pass also found gives us safe wording to
      // fall back on; otherwise build the same label the same way it does.
      const fallback = byId.get(key(imp));
      const name = nameForEntry(state, deepenType, imp.entryId);
      byId.set(
        key(imp),
        scrubImprovement(
          {
            questionId: imp.questionId,
            entryType: deepenType,
            entryId: imp.entryId,
            section: deepenType,
            inputType: "long_text",
            title: imp.title,
            detail: imp.detail,
            followUpQuestion: imp.followUpQuestion,
          },
          knownIds,
          name,
          {
            title: fallback?.title ?? `Cuéntame más sobre «${name}»`,
            followUpQuestion:
              fallback?.followUpQuestion ??
              `Sobre «${name}»: ¿qué herramientas o programas usaste y cómo lo lograste?`,
          },
        ),
      );
      continue;
    }
    const def = FOLLOWUP_DEFS[imp.questionId];
    if (!def) continue; // ignore questionIds outside the allow-list
    if (wasDeclined(state, imp.questionId)) continue; // the person already said no
    byId.set(
      key(imp),
      scrubImprovement(
        {
          questionId: imp.questionId,
          section: def.section,
          inputType: def.inputType,
          title: imp.title || def.title,
          detail: imp.detail,
          followUpQuestion: imp.followUpQuestion || def.defaultQuestion,
        },
        knownIds,
        null,
        { title: def.title, followUpQuestion: def.defaultQuestion },
      ),
    );
  }

  const improvements = selectImprovements([...byId.values()]).map(withCharLimit);

  const analysis: ResumeAnalysis = {
    // Shown verbatim on the workspace screen. A sentence built around an id says
    // nothing to the reader and cannot be repaired without knowing which entry it
    // meant, so it is replaced wholesale / dropped rather than patched.
    overallImpression:
      containsId(ai_result.overallImpression, knownIds) ||
      degenerate(ai_result.overallImpression)
        ? "Tu currículum ya tiene una base sólida. Responde las siguientes preguntas para hacerlo más completo y fuerte."
        : ai_result.overallImpression,
    strengths: ai_result.strengths.filter(
      (sTxt) => !containsId(sTxt, knownIds) && !degenerate(sTxt),
    ),
    improvements,
  };
  setCachedAnalysis(profileId, cacheKey, analysis);
  return analysis;
}
