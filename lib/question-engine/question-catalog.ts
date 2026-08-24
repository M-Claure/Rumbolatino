/**
 * Deterministic catalog of questions in Spanish (spec §16).
 *
 * The AI planner CHOOSES and personalizes a question from this catalog; it does
 * not invent questions from scratch. Each entry declares:
 *  - preconditions: when the question is eligible (pure predicate over state),
 *  - completionEffect: what fields it fills (documentation + analytics),
 *  - priority: lower = earlier in the flow.
 */
import type { ResumeProfileState, ResumeSection } from "@/types";
import type { InputType } from "@/lib/ai/schemas";
import { MAX_EXPERIENCE_ENTRIES } from "@/lib/config/limits";
import { isExperienceUndated, isExperienceUndescribed, labelForType } from "@/lib/experience-types";

export interface CatalogQuestion {
  id: string;
  section: ResumeSection;
  /** Default Spanish wording; the planner may personalize while keeping intent.
   *  A function lets the wording depend on state (e.g. "tu voluntariado 2 de 3"). */
  text: string | ((s: ResumeProfileState) => string);
  supportingText?: string;
  exampleAnswer?: string;
  /** Short Spanish hint about the question's purpose (given to the planner). */
  intent?: string;
  inputType: InputType;
  required: boolean;
  allowSkip: boolean;
  /**
   * Wording for the skip button when "Omitir" is not what the person means.
   * "No tengo" answers the question instead of dodging it, which is what someone
   * without certificates, languages or projects is actually doing — and it makes
   * the choice explicit enough that the improvement loop can stop asking (see
   * `detectGaps` in `lib/resume/resume-analyzer.ts`). Defaults to "Omitir".
   */
  skipLabel?: string;
  /**
   * Maximum characters this answer may contain. REQUIRED, so adding a question
   * forces a deliberate decision about its length rather than inheriting a
   * blanket default — a name and an experience description need very different
   * room. The server resolves the limit from here (never from the request) and
   * the client shows a live counter against it. See lib/answer-limits.ts.
   */
  charLimit: number;
  options?: string[];
  /** Eligible only when this returns true. */
  precondition: (s: ResumeProfileState) => boolean;
  completionEffect: string[];
  /** Lower runs earlier. */
  priority: number;
  /** May be asked more than once (e.g. "add another experience"). */
  repeatable?: boolean;
  /** When true this question is critical for generating the resume — it may be
   *  re-asked even after being skipped (spec §7 skip rule). */
  criticalForGeneration?: boolean;
}

// ── Predicate helpers ─────────────────────────────────────────────────────────
const has = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;
const hasObjective = (s: ResumeProfileState) => has(s.careerGoal) || has(s.targetRole);
const hasName = (s: ResumeProfileState) => has(s.personalInformation.firstName);
const hasContact = (s: ResumeProfileState) =>
  s.personalInformation.hasEmail || s.personalInformation.hasPhone;
// A ZIP is what we ask for, but a non-US answer lands in `city` instead, and
// both count as "we know where they are" — otherwise the funnel would loop
// asking a Mexican user for a US ZIP they do not have.
const hasLocation = (s: ResumeProfileState) =>
  has(s.personalInformation.postalCode) ||
  has(s.personalInformation.city) ||
  has(s.personalInformation.country);
const hasBackground = (s: ResumeProfileState) =>
  s.education.length + s.experience.length + s.projects.length + s.achievements.length > 0;

// The describe loop walks entries in order, so "still needs describing" is an
// ANY check. Deeper enrichment (scope/results/dates) targets the most recent
// entry, so those are LATEST checks — this keeps the ask-loop from re-firing for
// earlier entries and never terminating when there are several.
const experienceMissingResponsibilities = (s: ResumeProfileState) =>
  s.experience.some(isExperienceUndescribed);

/**
 * Whether the person has already told us HOW MANY experiences they have — by
 * answering the counter step (or, on profiles from before it became mandatory,
 * by skipping it).
 *
 * This gates the describe question's "nothing captured yet" branch. Answering the
 * counter with every type at 0 is a real answer — "no tengo ninguna" — and since
 * no experience question offers "Omitir", asking them to describe an experience
 * anyway would leave them on a question they cannot answer and cannot leave.
 */
const declaredExperienceCounts = (s: ResumeProfileState) =>
  s.answeredQuestionIds.includes("experience_type_counts") ||
  s.skippedQuestionIds.includes("experience_type_counts");
const latestExperience = (s: ResumeProfileState) =>
  s.experience.length > 0 ? s.experience[s.experience.length - 1] : undefined;
const latestMissingPeople = (s: ResumeProfileState) => {
  const e = latestExperience(s);
  return !!e && !has(e.peopleServed);
};
const latestMissingTools = (s: ResumeProfileState) => {
  const e = latestExperience(s);
  return !!e && e.tools.length === 0;
};
const latestMissingResults = (s: ResumeProfileState) => {
  const e = latestExperience(s);
  return !!e && e.accomplishments.length === 0 && e.metrics.length === 0;
};
/**
 * Dates are asked for EVERY experience, not just the most recent one.
 *
 * The résumé orders experience newest-first (`lib/resume/experience-order.ts`), and
 * an entry with no dates cannot be placed — it sinks to the bottom in capture
 * order. Asking only about the latest entry left every earlier one undateable, so
 * a three-experience résumé was effectively unordered. This walks them in the same
 * order as the describe loop.
 */
const experienceMissingDates = (s: ResumeProfileState) => s.experience.some(isExperienceUndated);

/** Names which experience the date question is about, mirroring the describe step. */
const datesExperienceText = (s: ResumeProfileState): string => {
  const idx = s.experience.findIndex(isExperienceUndated);
  const entry = idx >= 0 ? s.experience[idx] : undefined;
  const ask = "¿En qué fechas fue? Una fecha aproximada está bien.";
  if (!entry) return `¿En qué fechas fue esa experiencia? Una fecha aproximada está bien.`;
  const label = labelForType(entry.experienceType);
  const total = s.experience.length;
  if (total === 1) return `Tu ${label}: ${ask}`;
  return `Experiencia ${idx + 1} de ${total}, tu ${label}: ${ask}`;
};

/**
 * Wording for the "describe this experience" step.
 *
 * Leads with the position and the TYPE the person picked in the counter step, so
 * each question maps 1:1 onto the list they built: pick 2 informal + 1
 * volunteering and you are asked about "Experiencia 1 de 3: tu trabajo informal",
 * then 2 de 3, then "tu voluntariado". Without the number in front, three
 * near-identical questions in a row give no sense of position or progress.
 *
 * Entries added through the broad "Agregar otra experiencia" path carry the
 * `other` type, which labels as plain "experiencia" — deliberately generic, since
 * nobody told us what kind it is.
 */
const describeExperienceText = (s: ResumeProfileState): string => {
  const idx = s.experience.findIndex(isExperienceUndescribed);
  const entry = idx >= 0 ? s.experience[idx] : undefined;
  if (!entry) return "Cuéntame de otra experiencia: ¿de qué se trataba y qué hacías?";
  const label = labelForType(entry.experienceType);
  const total = s.experience.length;
  if (total === 1) return `Cuéntame de tu ${label}: ¿de qué se trataba y qué hacías?`;
  return `Experiencia ${idx + 1} de ${total}: tu ${label}. Cuéntame de qué se trataba y qué hacías.`;
};
const educationMissingDates = (s: ResumeProfileState) =>
  s.education.some((e) => !has(e.endDate) && !e.isCurrent);

export const QUESTION_CATALOG: CatalogQuestion[] = [
  // ── Career goal ──
  {
    id: "career_goal_target",
    section: "career_goal",
    text: "¿Qué tipo de trabajo te gustaría conseguir con este currículum?",
    intent: "Definir el objetivo profesional / puesto deseado.",
    exampleAnswer: "Asistente administrativa",
    inputType: "short_text",
    required: true,
    allowSkip: false,
    charLimit: 80, // un puesto: "Auxiliar de cocina y repostería" (31)
    precondition: (s) => !hasObjective(s),
    completionEffect: ["careerGoal", "targetRole"],
    priority: 10,
    criticalForGeneration: true,
  },
  {
    id: "career_goal_unknown",
    section: "career_goal",
    text: "Si no estás segura/o, cuéntame: ¿qué actividades disfrutas o qué tipo de trabajo has hecho antes?",
    intent: "Alternativa cuando la persona no sabe qué puesto busca.",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No sé todavía",
    charLimit: 300, // narrativo; tope de updates.careerGoal en el esquema de IA
    precondition: (s) => !hasObjective(s),
    completionEffect: ["careerGoal"],
    priority: 11,
  },

  // ── Personal information ──
  {
    id: "personal_name",
    section: "personal_information",
    text: "¿Cuál es tu nombre completo?",
    intent: "Capturar nombre y apellidos.",
    exampleAnswer: "María García López",
    inputType: "short_text",
    required: true,
    allowSkip: false,
    charLimit: 70, // "María del Carmen Rodríguez Hernández" (36)
    precondition: (s) => !hasName(s),
    completionEffect: ["firstName", "lastName"],
    priority: 20,
    criticalForGeneration: true,
  },
  {
    id: "personal_contact",
    section: "personal_information",
    text: "¿Cuál es tu correo electrónico o número de teléfono para que te puedan contactar?",
    supportingText: "No pediremos datos sensibles como tu edad, foto ni estado civil.",
    intent: "Capturar al menos un medio de contacto.",
    inputType: "short_text",
    required: true,
    allowSkip: false,
    charLimit: 80, // un correo largo o un teléfono con lada
    precondition: (s) => !hasContact(s),
    completionEffect: ["email", "phone"],
    priority: 21,
    criticalForGeneration: true,
  },
  {
    id: "personal_location",
    section: "personal_information",
    text: "¿Cuál es tu código postal?",
    // Five digits instead of "¿en qué ciudad vives?": shorter to type on a
    // phone, unambiguous where a city name is not, and the only answer that
    // yields coordinates — which is what lets employers search by how close
    // someone is. The city and state shown on the résumé are looked up from it,
    // so nothing is lost from the CV and the person answers one thing, not two.
    intent: "Ubicación, para que las empresas cercanas te encuentren.",
    inputType: "short_text",
    required: false,
    allowSkip: true,
    skipLabel: "Prefiero no decir",
    // Room for "77002" and for a non-US answer typed as a place name, which is
    // accepted rather than rejected — see `resolveLocationAnswer`.
    charLimit: 60,
    precondition: (s) => hasName(s) && !hasLocation(s),
    completionEffect: ["postalCode", "city", "state"],
    priority: 22,
  },

  // ── Education ──
  {
    id: "education_highest",
    section: "education",
    text: "¿Cuál es el nivel de educación más alto que completaste?",
    // Asks for ONE study, because there is one education slot
    // (`MAX_EDUCATION_ENTRIES`). The old wording invited "también cursos cortos"
    // and the example named two studies, so the model split the answer in two and
    // the second entry was dropped at the write path. Short courses have their own
    // uncapped home: `certifications_any` asks for "certificados o cursos".
    supportingText:
      "Solo el más alto: primaria, secundaria, preparatoria, carrera o técnico. " +
      "Tus cursos y certificados te los preguntamos más adelante.",
    intent: "Capturar el nivel educativo más alto (a menudo más fácil de responder primero).",
    exampleAnswer: "Terminé la secundaria.",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No estudié",
    charLimit: 200, // el nivel, con espacio para explicarlo con sus palabras
    precondition: (s) => s.education.length === 0,
    completionEffect: ["education"],
    priority: 30,
  },
  {
    id: "education_details",
    section: "education",
    text: "¿Dónde realizaste esos estudios y qué aprendiste?",
    intent: "Completar institución y contenido de un estudio ya mencionado.",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    charLimit: 400, // dónde estudió y qué aprendió
    precondition: (s) => s.education.some((e) => !has(e.institution) || e.relevantCoursework.length === 0),
    completionEffect: ["institution", "relevantCoursework"],
    priority: 31,
  },
  {
    id: "education_dates",
    section: "education",
    text: "¿En qué año terminaste (o terminarás) esos estudios? Una fecha aproximada está bien.",
    intent: "Completar fechas de educación.",
    inputType: "short_text",
    required: false,
    allowSkip: true,
    charLimit: 40, // "2021" o "junio de 2019"
    precondition: (s) => s.education.length > 0 && educationMissingDates(s),
    completionEffect: ["endDate"],
    priority: 32,
  },

  // ── Experience ──
  {
    id: "experience_type_counts",
    section: "experience",
    text: "¿Qué tipos de experiencia has tenido y cuántas de cada una? Pon el número de cada tipo.",
    supportingText: `No necesitas un empleo formal: cuidar, ayudar en un negocio o un proyecto también cuentan. Puedes contar hasta ${MAX_EXPERIENCE_ENTRIES} experiencias en total: elige las ${MAX_EXPERIENCE_ENTRIES} más importantes.`,
    intent: "Capturar el tipo y la cantidad de experiencias para preguntar por cada una.",
    inputType: "type_counts",
    required: false,
    // No skip anywhere in the experience section: experience is what the résumé is
    // built from, and a skipped experience question is a gap nothing else fills.
    // Here the escape hatch is answering with every counter at 0 — that IS "no
    // tengo ninguna", and the UI says so, so nobody is trapped without a skip.
    allowSkip: false,
    charLimit: 400, // payload JSON de conteos, no lo teclea la persona
    precondition: (s) => s.experience.length === 0,
    completionEffect: ["experienceType"],
    priority: 40,
    criticalForGeneration: true,
  },
  {
    id: "experience_add",
    section: "experience",
    // Personalized per entry: names the type + position of the next one to describe.
    text: describeExperienceText,
    intent: "Registrar la descripción de una experiencia concreta.",
    exampleAnswer: "Ayudaba en el negocio de limpieza de mi mamá atendiendo a los clientes.",
    inputType: "long_text",
    required: false,
    allowSkip: false,
    charLimit: 600, // descripción principal de una experiencia
    // Fires while any listed experience still needs describing — or, before the
    // counter step has been answered, when nothing is captured yet.
    precondition: (s) =>
      experienceMissingResponsibilities(s) ||
      (s.experience.length === 0 && !declaredExperienceCounts(s)),
    completionEffect: ["experience"],
    priority: 41,
    repeatable: true,
  },
  {
    id: "experience_daily_tasks",
    section: "experience",
    text: "¿Qué hacías durante un día normal en esa experiencia?",
    intent: "Detallar responsabilidades cuando faltan.",
    inputType: "long_text",
    required: false,
    allowSkip: false,
    charLimit: 500, // lista de tareas de un día normal
    precondition: (s) => s.experience.length > 0 && experienceMissingResponsibilities(s),
    completionEffect: ["responsibilities"],
    priority: 42,
  },
  {
    id: "experience_scope",
    section: "experience",
    text: "¿Manejabas dinero, clientes, citas, documentos o inventario? ¿Supervisabas a alguien?",
    intent: "Descubrir alcance/transferibilidad sin asumir liderazgo.",
    inputType: "long_text",
    required: false,
    allowSkip: false,
    charLimit: 400, // dinero, clientes, inventario, supervisión
    precondition: (s) => latestMissingTools(s) || latestMissingPeople(s),
    completionEffect: ["tools", "peopleServed"],
    priority: 43,
  },
  {
    id: "experience_results",
    section: "experience",
    text: "¿Hubo algún resultado o logro que puedas contar? Puede ser una cantidad aproximada y verdadera.",
    intent: "Capturar logros/métricas verdaderas (aproximadas permitidas).",
    inputType: "long_text",
    required: false,
    allowSkip: false,
    charLimit: 400, // resultados o logros con cantidades
    precondition: (s) => latestMissingResults(s),
    completionEffect: ["accomplishments", "metrics"],
    priority: 44,
  },
  {
    id: "experience_dates",
    section: "experience",
    // Names the entry it is about; asked once per experience so the résumé can be
    // ordered newest-first.
    text: datesExperienceText,
    supportingText: "Sirve para ordenar tus experiencias de la más nueva a la más vieja.",
    exampleAnswer: "de marzo 2020 a la actualidad",
    intent: "Capturar fechas de experiencia.",
    inputType: "short_text",
    required: false,
    allowSkip: false,
    charLimit: 60, // "de marzo 2020 a la actualidad" (29)
    precondition: (s) => experienceMissingDates(s),
    completionEffect: ["startDate", "endDate"],
    priority: 45,
    repeatable: true,
  },

  // ── Skills ──
  {
    id: "skills_confirm",
    section: "skills",
    text: "Por lo que nos contaste, creemos que podrías tener estas habilidades. ¿Cuáles quieres confirmar?",
    intent: "Confirmar habilidades sugeridas (nunca se asumen confirmadas).",
    inputType: "skill_confirmation",
    required: false,
    allowSkip: true,
    charLimit: 200, // sin texto libre: decide con botones
    precondition: (s) => s.suggestedSkills.length > 0,
    completionEffect: ["confirmedSkills"],
    priority: 50,
    criticalForGeneration: true,
  },
  {
    id: "skills_add",
    section: "skills",
    text: "¿Tienes otras habilidades que quieras incluir? Escríbelas separadas por comas.",
    supportingText: "Por ejemplo: trabajo en equipo, puntualidad, Excel.",
    exampleAnswer: "Trabajo en equipo, puntualidad, atención al detalle",
    intent: "Agregar habilidades declaradas por la persona (separadas por comas).",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No tengo más",
    charLimit: 300, // varias habilidades separadas por comas
    // Asked at most once — the answer accepts a comma-separated list, so there's
    // no need to repeat it (repeating caused a loop with the LLM planner).
    precondition: (s) => hasBackground(s),
    completionEffect: ["confirmedSkills"],
    priority: 51,
  },

  // ── Certifications / Languages / Projects / Achievements (optional) ──
  {
    id: "certifications_any",
    section: "certifications",
    text: "¿Tienes certificados o cursos que quieras incluir?",
    intent: "Capturar certificaciones (opcional).",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No tengo",
    charLimit: 400, // varios certificados con emisor y año
    precondition: (s) => s.certifications.length === 0 && hasBackground(s),
    completionEffect: ["certifications"],
    priority: 60,
  },
  {
    id: "languages_any",
    section: "languages",
    text: "¿Qué idiomas hablas y en qué nivel?",
    intent: "Capturar idiomas (se confirma el nivel, no se asume fluidez).",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No tengo",
    charLimit: 200, // "Español nativo, inglés intermedio" (33)
    precondition: (s) => s.languages.length === 0 && hasBackground(s),
    completionEffect: ["languages"],
    priority: 61,
  },
  {
    id: "projects_any",
    section: "projects",
    text: "¿Has hecho algún proyecto personal, escolar o comunitario que quieras mostrar?",
    intent: "Capturar proyectos (opcional).",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No tengo",
    charLimit: 500, // descripción de un proyecto
    precondition: (s) => s.projects.length === 0 && hasBackground(s),
    completionEffect: ["projects"],
    priority: 62,
  },
  {
    id: "achievements_any",
    section: "achievements",
    text: "¿Tienes algún logro o reconocimiento que quieras destacar?",
    intent: "Capturar logros (opcional).",
    inputType: "long_text",
    required: false,
    allowSkip: true,
    skipLabel: "No tengo",
    charLimit: 400, // un logro o reconocimiento
    precondition: (s) => s.achievements.length === 0 && hasBackground(s),
    completionEffect: ["achievements"],
    priority: 63,
  },

  // ── Review ──
  {
    id: "review_summary",
    section: "review",
    text: "Hemos reunido buena información. Revisemos tu perfil y, si estás lista/o, generamos tu currículum.",
    intent: "Cerrar la recolección y pasar a revisión/generación.",
    inputType: "review",
    required: false,
    allowSkip: true,
    charLimit: 200, // sin texto libre: pantalla de repaso
    precondition: (s) => s.completeness.readyToGenerate,
    completionEffect: [],
    priority: 90,
  },
];

export function getCatalogQuestion(id: string): CatalogQuestion | undefined {
  return QUESTION_CATALOG.find((q) => q.id === id);
}
