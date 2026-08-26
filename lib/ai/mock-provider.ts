/**
 * Deterministic, offline AI provider. Used for local dev and all tests
 * (AI_PROVIDER=mock). It obeys the SAME safety invariants as the real provider:
 *  - only extracts what appears in the user's text (no invented facts),
 *  - only suggests skills backed by cited evidence,
 *  - never marks a skill confirmed.
 *
 * Every returned value is parsed through the shared Zod schema, so the mock is
 * guaranteed to satisfy the same contract as AzureOpenAIProvider.
 */
import type {
  AIProvider,
  AnalyzeResumeParams,
  ExtractInterestsParams,
  NormalizeAnswerParams,
  PlanQuestionParams,
  ProofreadResumeParams,
  ResumeGenerationInput,
  SuggestSkillsParams,
} from "./provider";
import {
  AnswerNormalizationSchema,
  InterestsExtractionSchema,
  PlannerDecisionSchema,
  ProofreadResultSchema,
  ResumeAnalysisSchema,
  ResumeContentSchema,
  SuggestedSkillSchema,
  type AnswerNormalization,
  type InterestsExtraction,
  type PlannerDecision,
  type ProofreadResult,
  type ResumeAnalysisPayload,
  type ResumeContent,
  type SuggestedSkillPayload,
} from "./schemas";
import { EXPERIENCE_TYPES, type ExperienceType } from "@/types";
import { MAX_EXPERIENCE_ENTRIES } from "@/lib/config/limits";
import { parseLocationAnswer, parsePersonalInformation } from "@/lib/personal-contact";
import { formatExperienceDate, parseExperienceDateRange } from "@/lib/experience-dates";

/**
 * Longest snippet quoted as a skill's evidence. Comfortably under
 * SuggestedSkillSchema's 400-char cap once the "Mencionaste: …" wrapper is added.
 */
const SKILL_EVIDENCE_QUOTE_CHARS = 300;

/** Evidence-driven Spanish skill inference rules. */
interface SkillRule {
  patterns: RegExp;
  name: string;
  category: string;
}
const SKILL_RULES: SkillRule[] = [
  { patterns: /(llamad|telefón|telefon)/i, name: "Comunicación telefónica", category: "Comunicación" },
  { patterns: /client/i, name: "Atención al cliente", category: "Servicio al cliente" },
  { patterns: /(cita|agenda|horario)/i, name: "Organización de citas", category: "Organización" },
  { patterns: /(inventario|producto|suministro|stock)/i, name: "Manejo de inventario", category: "Operaciones" },
  { patterns: /(compr[ao]|adquir)/i, name: "Compra de suministros", category: "Operaciones" },
  { patterns: /excel/i, name: "Microsoft Excel", category: "Herramientas" },
  { patterns: /(word|documento|archiv)/i, name: "Gestión documental", category: "Administración" },
  { patterns: /(dinero|caja|pago|cobr|factur)/i, name: "Manejo de dinero", category: "Finanzas" },
  { patterns: /(vend|venta)/i, name: "Ventas", category: "Ventas" },
  { patterns: /(organiz)/i, name: "Organización", category: "Organización" },
  { patterns: /(limpiez|limpi)/i, name: "Servicios de limpieza", category: "Operaciones" },
  { patterns: /(enseñ|capacit|entren)/i, name: "Capacitación", category: "Educación" },
  { patterns: /(cocina|cocin|alimento)/i, name: "Preparación de alimentos", category: "Gastronomía" },
];

// Order matters: the first matching rule wins, most-specific first.
const EXPERIENCE_TYPE_HINTS: Array<{ patterns: RegExp; type: ExperienceType }> = [
  { patterns: /(voluntari)/i, type: "volunteering" },
  { patterns: /(cuid[aeé]|cuidado)/i, type: "caregiving" },
  {
    patterns: /(de mi (mam|pap|herman|t[ií]|abuel|espos|prim)|negocio familiar|de la familia|familiar)/i,
    type: "family_business",
  },
  { patterns: /(mi (propio )?negocio|negocio propio|emprend|mont[eé]|puse un negocio)/i, type: "business_owner" },
  { patterns: /(freelance|independiente|por mi cuenta)/i, type: "freelance" },
  { patterns: /(práctic|pasant|internship)/i, type: "internship" },
  { patterns: /(proyecto escolar|para la escuela|del colegio)/i, type: "school_project" },
  { patterns: /(informal|changa|ayudaba)/i, type: "informal_work" },
];

/** Whole-answer negations (ES + EN) — an interests "no" must store nothing. */
const NEGATION_RE = /^(no|nop|nel|ningun[oa]?s?|nada|n\/?a|no really|not really|none|no tengo|la verdad no|ninguno relacionad[oa])\b/i;

/** Common language names (ES/EN) → canonical Spanish label. */
const LANGUAGE_NAMES: Array<{ re: RegExp; name: string }> = [
  { re: /espa[ñn]ol|castellano|spanish/i, name: "Español" },
  { re: /ingl[eé]s|english/i, name: "Inglés" },
  { re: /portugu[eé]s|portuguese/i, name: "Portugués" },
  { re: /franc[eé]s|french/i, name: "Francés" },
  { re: /alem[aá]n|german/i, name: "Alemán" },
  { re: /italiano|italian/i, name: "Italiano" },
  { re: /mandar[ií]n|chino|chinese|mandarin/i, name: "Mandarín" },
];
type MockLangLevel = "basico" | "intermedio" | "avanzado" | "nativo";
function detectLanguageLevel(text: string): MockLangLevel | null {
  if (/nativ|native|biling|materna|perfect|perfecto/i.test(text)) return "nativo";
  if (/avanzad|advanced|fluid|fluent|profesional|business|alto/i.test(text)) return "avanzado";
  if (/intermedi|intermediate|conversacional|medio/i.test(text)) return "intermedio";
  if (/b[aá]sic|basic|principiante|poco|beginner/i.test(text)) return "basico";
  return null;
}
/** Deterministic best-effort parse of a free-text languages answer. */
function parseLanguages(raw: string): Array<{ name: string; speakingLevel: MockLangLevel | null }> {
  const found: Array<{ name: string; speakingLevel: MockLangLevel | null }> = [];
  const seen = new Set<string>();
  const globalLevel = detectLanguageLevel(raw);
  for (const clause of raw.split(/[,;\n]+|\s+y\s+|\s+e\s+/i)) {
    for (const lang of LANGUAGE_NAMES) {
      if (lang.re.test(clause) && !seen.has(lang.name)) {
        seen.add(lang.name);
        found.push({ name: lang.name, speakingLevel: detectLanguageLevel(clause) ?? globalLevel });
      }
    }
  }
  return found;
}

/**
 * Deterministic best-effort parse of a free-text certifications answer: split
 * multiple certificates and pull out an issue year. Issuing-organization
 * detection is left to the model (too ambiguous for a heuristic).
 */
function parseCertifications(raw: string): Array<{ name: string; issueDate?: string }> {
  const out: Array<{ name: string; issueDate?: string }> = [];
  const seen = new Set<string>();
  for (const chunk of raw.split(/[;\n]+|\s+y\s+/i)) {
    const part = chunk.trim();
    if (part.length < 2) continue;
    const year = part.match(/\b(19|20)\d{2}\b/)?.[0];
    // Strip the year (and trailing "en"/"de"/dashes) from the visible name.
    const name = capitalize(
      part
        .replace(/\b(19|20)\d{2}\b/, "")
        .replace(/\b(en|del?|año)\b\s*$/i, "")
        .replace(/[–—-]\s*$/, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(year ? { name: truncate(name, 120), issueDate: year } : { name: truncate(name, 120) });
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.;\n]+|,\s*(?:y\s+)?/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function inferSkills(texts: string[], exclude: Set<string>): SuggestedSkillPayload[] {
  const out: SuggestedSkillPayload[] = [];
  const seen = new Set<string>();
  for (const rule of SKILL_RULES) {
    for (const text of texts) {
      if (rule.patterns.test(text)) {
        const key = rule.name.toLowerCase();
        if (seen.has(key) || exclude.has(key)) break;
        seen.add(key);
        // Evidence is a CITATION, not a copy of the answer: quoting a full
        // 600-char experience answer both overflowed SuggestedSkillSchema's
        // 400-char cap (a hard 500 for the user) and re-sent the whole answer
        // inside every skills prompt.
        out.push({
          name: rule.name,
          category: rule.category,
          evidence: `Mencionaste: "${truncate(text, SKILL_EVIDENCE_QUOTE_CHARS)}".`,
        });
        break;
      }
    }
  }
  return out.map((s) => SuggestedSkillSchema.parse(s));
}

export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  async planNextQuestion(params: PlanQuestionParams): Promise<PlannerDecision> {
    const { candidates, recommendedSection, state } = params;
    const chosen =
      candidates.find((c) => c.section === recommendedSection) ?? candidates[0] ?? null;

    if (!chosen) {
      // Nothing left to ask — steer toward review/generation.
      return PlannerDecisionSchema.parse({
        questionId: "review_summary",
        section: "review",
        questionText: "Hemos reunido buena información. ¿Quieres revisar tu perfil y generar tu currículum?",
        nextAction: state.completeness.readyToGenerate ? "generate_resume" : "review_profile",
        contextUsed: [],
      });
    }

    const name = state.personalInformation.firstName;
    const greeting = name ? `${name}, ` : "";
    const personalized =
      chosen.section === "career_goal"
        ? chosen.defaultText
        : `${greeting}${lowerFirst(chosen.defaultText)}`;

    const nextAction = state.suggestedSkills.length > 0 ? "confirm_skills" : "ask_question";

    return PlannerDecisionSchema.parse({
      questionId: chosen.questionId,
      section: chosen.section,
      questionText: personalized,
      contextUsed: name ? [`nombre: ${name}`] : [],
      nextAction,
    });
  }

  async normalizeAnswer(params: NormalizeAnswerParams): Promise<AnswerNormalization> {
    const raw = params.rawAnswer.trim();
    const updates: AnswerNormalization["updates"] = {};
    let suggestedSkills: SuggestedSkillPayload[] = [];
    let needsConfirmation = false;
    let summary = `Registré tu respuesta: "${truncate(raw, 120)}".`;

    switch (params.section) {
      case "career_goal": {
        // Each question fills ONLY the field it actually asks about. Writing the
        // same answer into both is what made the Review screen show the identical
        // text twice — once as "Puesto deseado", once as "Objetivo (descripción)" —
        // and left nothing for the person to actually write in the second field.
        if (params.questionId === "career_goal_unknown") {
          // The "I'm not sure what job I want" path: a narrative about what the
          // person enjoys or has done. That IS the objective; it is not a job title.
          updates.careerGoal = raw;
          summary = `Anoté lo que me contaste sobre lo que buscas: "${truncate(raw, 120)}".`;
        } else {
          // "¿Qué tipo de trabajo te gustaría conseguir?" — a desired position.
          updates.targetRole = truncate(raw, 120);
          summary = `El puesto que buscas es: "${truncate(raw, 120)}".`;
        }
        break;
      }
      case "personal_information": {
        // Branch on the QUESTION, not just the section — the same rule the
        // `career_goal` and `education` cases already follow, and for the same
        // reason: each question fills ONLY the field it actually asks about.
        //
        // THREE questions share this section (name, contact, location) and all of
        // them used to run through `parsePersonalInformation`, which reads whatever
        // is left after stripping an email/phone as a NAME. So answering "Miami" to
        // "¿En qué ciudad y país vives?" overwrote the person's real first name,
        // threw the location away (city/state/country were never written), and then
        // resurfaced as the greeting the planner prefixes to every later question —
        // "Miami, cuéntame sobre tu empleo formal". The résumé would have carried
        // "Miami" as the person's name.
        if (params.questionId === "personal_location") {
          const { city, state, country } = parseLocationAnswer(raw);
          updates.personalInformation = { city, state, country };
          const where = [city, state, country].filter(Boolean).join(", ");
          summary = where ? `Anoté que vives en ${where}.` : "Anoté tu ubicación.";
        } else {
          // `personal_contact` deliberately shares this branch: it asks for a
          // contact channel, but people commonly type "Ana Ruiz ana@example.com"
          // and the name in that answer is worth keeping (pinned by
          // tests/unit/profile-contact-gate.test.ts).
          const { firstName, lastName, email, phone } = parsePersonalInformation(raw);
          updates.personalInformation = { firstName, lastName, email, phone };
          summary = "Guardé tu información personal.";
        }
        break;
      }
      case "education": {
        if (params.questionId === "education_details") {
          const sentences = splitSentences(raw);
          updates.educationEntries = [{ institution: sentences[0] ?? null, relevantCoursework: sentences.slice(1) }];
          summary = "Actualicé los detalles de tu formación.";
        } else if (params.questionId === "education_dates") {
          updates.educationEntries = [{ endDate: raw }];
          summary = "Registré la fecha de tus estudios.";
        } else {
          updates.educationEntries = [
            { institution: null, credential: raw, fieldOfStudy: null, relevantCoursework: [] },
          ];
          needsConfirmation = true;
          summary = `Anoté tu formación: "${truncate(raw, 120)}". Por favor confírmala.`;
        }
        break;
      }
      case "experience": {
        switch (params.questionId) {
          case "experience_type_counts": {
            // The counter step sends {experienceType: count}. Create that many
            // typed, still-empty entries; the describe step fills each in turn.
            const entries: {
              experienceType: ExperienceType;
              title: null;
              organization: null;
              rawDescription: null;
              responsibilities: string[];
            }[] = [];
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(raw);
            } catch {
              /* malformed payload → no entries */
            }
            if (parsed && typeof parsed === "object") {
              for (const [type, count] of Object.entries(parsed as Record<string, unknown>)) {
                if (!(EXPERIENCE_TYPES as readonly string[]).includes(type)) continue;
                // Capped at the product limit, per type and in total: a hand-crafted
                // payload must not be able to open more entries than the UI allows.
                const n = Math.max(0, Math.min(MAX_EXPERIENCE_ENTRIES, Math.floor(Number(count) || 0)));
                for (let i = 0; i < n && entries.length < MAX_EXPERIENCE_ENTRIES; i++) {
                  entries.push({
                    experienceType: type as ExperienceType,
                    title: null,
                    organization: null,
                    rawDescription: null,
                    responsibilities: [],
                  });
                }
              }
            }
            if (entries.length > 0) updates.experienceEntries = entries;
            summary =
              entries.length > 0
                ? `Anoté ${entries.length} experiencia${entries.length === 1 ? "" : "s"}. Ahora cuéntame de cada una.`
                : "Continuemos con tu experiencia.";
            break;
          }
          case "experience_daily_tasks": {
            const responsibilities = splitSentences(raw);
            updates.experienceEntries = [{ responsibilities }];
            suggestedSkills = inferSkills([raw, ...responsibilities], new Set());
            summary = "Registré tus tareas y detecté posibles habilidades.";
            break;
          }
          case "experience_scope":
            // `peopleServed` is a short descriptor (schema caps it at 200); the
            // full answer is preserved on the entry's rawDescription, so trimming
            // here loses nothing but keeps a max-length answer from 500-ing.
            updates.experienceEntries = [
              { peopleServed: truncate(raw, 200), tools: extractTools(raw) },
            ];
            suggestedSkills = inferSkills([raw], new Set());
            summary = "Anoté el alcance de tu experiencia.";
            break;
          case "experience_results":
            updates.experienceEntries = [
              { accomplishments: splitSentences(raw), metrics: extractMetrics(raw) },
            ];
            summary = "Registré los resultados que mencionaste (conservando lo aproximado).";
            break;
          case "experience_dates": {
            /*
             * The question asks for BOTH ends at once ("de marzo 2020 a la
             * actualidad"), so the answer is split into the structured fields the
             * Review card and `lib/entry-required-fields.ts` read. Writing the whole
             * answer to `startDate` — which is what this did — dropped the second
             * half, and the Review screen then asked every person for an end date
             * they had already given.
             *
             * This question is deliberately never sent to the model
             * (`MECHANICAL_QUESTION_IDS`), so this parser is the ONLY thing that
             * reads a funnel date: it has to keep both ends itself.
             *
             * Nothing parseable → the raw answer goes to `startDate` as before, which
             * is what `experience-order.ts` already copes with. The verbatim wording
             * is kept either way on `ConversationTurn.userAnswer`.
             */
            const range = parseExperienceDateRange(raw);
            updates.experienceEntries = [
              range.start.year
                ? {
                    startDate: formatExperienceDate(range.start.month, range.start.year),
                    endDate: range.isCurrent
                      ? ""
                      : formatExperienceDate(range.end.month, range.end.year),
                    isCurrent: range.isCurrent,
                  }
                : { startDate: raw },
            ];
            summary = "Registré las fechas de tu experiencia.";
            break;
          }
          default: {
            const responsibilities = splitSentences(raw);
            updates.experienceEntries = [
              {
                experienceType: detectExperienceType(raw),
                title: null,
                organization: null,
                rawDescription: raw,
                responsibilities,
              },
            ];
            suggestedSkills = inferSkills([raw, ...responsibilities], new Set());
            summary = "Registré esta experiencia y detecté algunas posibles habilidades.";
          }
        }
        break;
      }
      case "projects": {
        updates.projects = [{ name: truncate(raw, 80), description: raw, responsibilities: [], outcomes: [], tools: [] }];
        break;
      }
      case "certifications": {
        const parsed = parseCertifications(raw);
        updates.certifications =
          parsed.length > 0 ? parsed : [{ name: truncate(raw, 120) }];
        summary = "Registré los certificados que mencionaste.";
        break;
      }
      case "languages": {
        const parsed = parseLanguages(raw);
        updates.languages =
          parsed.length > 0
            ? parsed.map((l) => ({ name: l.name, speakingLevel: l.speakingLevel }))
            : [{ name: truncate(raw, 40) }];
        summary = "Registré los idiomas que mencionaste.";
        break;
      }
      case "achievements": {
        updates.achievements = [{ title: truncate(raw, 120), description: raw }];
        break;
      }
      default:
        break;
    }

    return AnswerNormalizationSchema.parse({
      interpretationSummary: summary,
      needsConfirmation,
      updates,
      suggestedSkills,
    });
  }

  async suggestSkills(params: SuggestSkillsParams): Promise<SuggestedSkillPayload[]> {
    const focus = params.focusExperienceIds
      ? params.state.experience.filter((e) => params.focusExperienceIds!.includes(e.id))
      : params.state.experience;
    const texts: string[] = [];
    for (const e of focus) {
      texts.push(...e.responsibilities, ...e.accomplishments);
      if (e.rawDescription) texts.push(e.rawDescription);
    }
    const exclude = new Set(params.excludeSkillNames.map((n) => n.toLowerCase()));
    return inferSkills(texts, exclude);
  }

  async extractInterests(params: ExtractInterestsParams): Promise<InterestsExtraction> {
    const raw = params.rawAnswer.trim();
    // A whole-answer negation yields no interests (never store the negation).
    if (raw.length === 0 || NEGATION_RE.test(raw)) {
      return InterestsExtractionSchema.parse({ interests: [] });
    }
    const existing = new Set(params.existing.map((i) => i.toLowerCase()));
    const seen = new Set<string>();
    const interests: string[] = [];
    for (const part of raw.split(/[,;\n]+|\s+y\s+/i)) {
      const cleaned = capitalize(part.trim());
      if (cleaned.length < 2) continue;
      const key = cleaned.toLowerCase();
      // Drop fragments that are themselves negations and any duplicate/existing.
      if (NEGATION_RE.test(cleaned) || existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      interests.push(truncate(cleaned, 80));
    }
    return InterestsExtractionSchema.parse({ interests: interests.slice(0, 20) });
  }

  async proofreadResume(params: ProofreadResumeParams): Promise<ProofreadResult> {
    // Deterministic, meaning-preserving tidy-up: trim, collapse internal
    // whitespace, and capitalize the first letter. No factual changes.
    const items = params.items.map((it) => {
      const text = it.text.replace(/\s+/g, " ").trim();
      return { id: it.id, text: text.length > 0 ? capitalize(text) : text };
    });
    return ProofreadResultSchema.parse({ items, notes: [] });
  }

  async generateResumeContent(input: ResumeGenerationInput): Promise<ResumeContent> {
    const roleText = input.targetRole ?? input.careerGoal ?? "profesional";
    const summaryParts = [
      `Profesional con orientación a ${roleText}, comprometida/o y con disposición para aprender.`,
    ];
    if (input.experience.length > 0) {
      const orgs = input.experience
        .map((e) => e.organization || labelForExperienceType(e.experienceType))
        .filter(Boolean);
      if (orgs.length > 0)
        summaryParts.push(`Experiencia práctica en ${uniqueJoin(orgs)}, con responsabilidad y trato directo.`);
    }
    if (input.skills.length > 0) {
      summaryParts.push(
        `Destaca en ${input.skills.slice(0, 5).map((s) => s.name.toLowerCase()).join(", ")}.`,
      );
    }

    // Expand each experience into several professional bullets, using ONLY the
    // captured facts (responsibilities, accomplishments, tools, people, metrics).
    const experience = input.experience.map((e) => ({
      entryId: e.id,
      bullets: buildExperienceBullets(e),
    }));

    const education = input.education.map((e) => ({
      entryId: e.id,
      details: [
        ...(e.credential || e.fieldOfStudy
          ? [
              {
                text: [e.credential, e.fieldOfStudy].filter(Boolean).join(" — "),
                sourceEntryIds: [e.id],
                sourceFields: ["credential", "fieldOfStudy"].filter(
                  (f) => (f === "credential" ? e.credential : e.fieldOfStudy),
                ),
              },
            ]
          : []),
        ...e.relevantCoursework.map((c) => ({
          text: c,
          sourceEntryIds: [e.id],
          sourceFields: ["relevantCoursework"],
        })),
      ],
    }));

    const projects = input.projects.map((p) => ({
      entryId: p.id,
      bullets: dedupe([...(p.description ? [p.description] : []), ...p.responsibilities, ...p.outcomes]).map(
        (text) => ({ text: capitalize(text), sourceEntryIds: [p.id], sourceFields: ["description", "responsibilities", "outcomes"] }),
      ),
    }));

    const groups = new Map<string, string[]>();
    for (const s of input.skills) {
      const arr = groups.get(s.category) ?? [];
      arr.push(s.id);
      groups.set(s.category, arr);
    }
    const skillGroups = [...groups.entries()].map(([category, skillIds]) => ({ category, skillIds }));

    return ResumeContentSchema.parse({
      professionalSummary: summaryParts.join(" "),
      experience,
      education,
      projects,
      skillGroups,
    });
  }

  async analyzeResume(params: AnalyzeResumeParams): Promise<ResumeAnalysisPayload> {
    // Deterministic: the service supplies the actionable gap improvements; the
    // mock provides a warm impression + real strengths, leaving improvements to
    // the service's gap detection.
    const s = params.state;
    const role = s.targetRole ?? s.careerGoal ?? "el puesto que buscas";
    const strengths: string[] = [];
    if (s.experience.length > 0) strengths.push("Tienes experiencia práctica que podemos destacar.");
    if (s.confirmedSkills.length > 0)
      strengths.push(`Habilidades confirmadas: ${s.confirmedSkills.slice(0, 4).map((x) => x.name).join(", ")}.`);
    if (s.education.length > 0) strengths.push("Incluiste tu formación educativa.");
    return ResumeAnalysisSchema.parse({
      overallImpression: `Tu currículum para ${role} tiene una buena base. Con unos detalles más lo hacemos más completo y atractivo.`,
      strengths,
      improvements: [],
    });
  }
}

/**
 * Turn one experience entry into several professional bullets from its captured
 * facts. Honest expansion only — no invented metrics or claims. (The Azure OpenAI
 * provider does richer semantic rewording via the prompt.)
 */
function buildExperienceBullets(e: ResumeGenerationInput["experience"][number]) {
  const bullets: { text: string; sourceEntryIds: string[]; sourceFields: string[] }[] = [];
  const push = (text: string, field: string) => {
    const t = professionalize(text);
    if (t.length > 0) bullets.push({ text: t, sourceEntryIds: [e.id], sourceFields: [field] });
  };
  for (const r of dedupe(e.responsibilities)) push(r, "responsibilities");
  for (const a of dedupe(e.accomplishments)) push(a, "accomplishments");
  if (e.tools.length > 0) push(`Uso de ${uniqueJoin(e.tools)} en las tareas diarias`, "tools");
  if (e.peopleServed) push(`Atención y trato directo con ${e.peopleServed}`, "peopleServed");
  for (const m of dedupe(e.metrics)) push(m, "metrics");
  // Fall back to the raw wording if nothing structured was captured.
  if (bullets.length === 0 && e.rawDescription) push(e.rawDescription, "rawDescription");
  return bullets;
}

const ACTION_VERB_PREFIXES = /^(gestion|realic|atend|organiz|coordin|manej|resolv|apoy|colabor|ayud|prepar|encarg|super|vend|registr|control|elabor)/i;

/** Light professional polish: capitalize and lead with an action-oriented verb. */
function professionalize(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  if (t.length === 0) return t;
  // Past-tense imperfect ("contestaba") reads fine; only prepend a verb when the
  // phrase starts with a noun/gerund that isn't already action-led.
  if (!ACTION_VERB_PREFIXES.test(t) && !/^[A-ZÁÉÍÓÚÑ]/.test(t)) {
    t = `Encargada/o de ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  }
  return capitalize(t);
}

// ── helpers ──
function detectExperienceType(text: string): ExperienceType {
  for (const h of EXPERIENCE_TYPE_HINTS) if (h.patterns.test(text)) return h.type;
  return "other";
}
function labelForExperienceType(t: string): string {
  const map: Record<string, string> = {
    family_business: "un negocio familiar",
    volunteering: "voluntariado",
    caregiving: "el cuidado de personas",
    business_owner: "un negocio propio",
    freelance: "trabajo independiente",
    informal_work: "trabajo informal",
  };
  return map[t] ?? "diversos entornos";
}
const TOOL_WORDS = /(excel|word|caja registradora|computadora|whatsapp|correo|agenda|sistema)/gi;
function extractTools(text: string): string[] {
  const found = text.match(TOOL_WORDS) ?? [];
  return [...new Set(found.map((t) => t.trim()))];
}
function extractMetrics(text: string): string[] {
  // Keep the surrounding phrase so approximate wording is preserved verbatim.
  const matches = text.match(/[^.,;]*\d+[^.,;]*/g) ?? [];
  return matches.map((m) => m.trim()).filter((m) => m.length > 0).slice(0, 5);
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
function capitalize(s: string): string {
  const t = s.trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}
function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}
function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0))];
}
function uniqueJoin(arr: string[]): string {
  return [...new Set(arr)].join(", ");
}
