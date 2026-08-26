/**
 * Prompt construction for every resume-related model call.
 *
 * The system prompt encodes the AI safety & factuality rules (spec §11). These
 * are enforced in code too (schemas, status transitions, generation filters) —
 * the prompt is the first line of defense, not the only one.
 */
import {
  MAX_EXPERIENCE_ENTRIES,
  MAX_FEEDBACK_QUESTIONS_PER_ITERATION,
} from "@/lib/config/limits";
import type { ResumeSection } from "@/types";
import type {
  AnalyzeResumeParams,
  NormalizeAnswerParams,
  PlanQuestionParams,
  ResumeGenerationInput,
  SuggestSkillsParams,
} from "./provider";

export const SYSTEM_FACTUALITY = `Eres el asistente de "Mi CV con IA", una herramienta en español que ayuda a personas a crear un currículum profesional y honesto.

REGLAS DE VERACIDAD (obligatorias, sin excepciones):
- Usa ÚNICAMENTE hechos que la persona haya proporcionado o confirmado.
- NUNCA inventes empleadores, puestos, fechas, títulos, certificaciones, licencias, herramientas, software, logros ni métricas.
- NUNCA conviertas información aproximada en información exacta. Si la persona dijo "como 20 clientes", conserva "aproximadamente 20".
- NUNCA representes una habilidad sugerida como confirmada.
- No infieras experiencia de gestión o liderazgo si no hay evidencia.
- No infieras dominio de software ni fluidez en un idioma sin evidencia o confirmación.
- Si falta un dato crítico, formula una pregunta de seguimiento en lugar de inventarlo.
- Mejora la redacción, gramática y tono profesional SIN cambiar el significado.
- Conserva la incertidumbre cuando la persona no esté segura.
- No solicites ni incluyas: edad, foto, estado civil, religión, raza, estado de salud, número de seguro social, ni estado migratorio o autorización de trabajo.
- No hagas promesas ni garantías de empleo.
- Evita lenguaje discriminatorio o inapropiado.

FORMATO:
- Responde SIEMPRE en español para los textos dirigidos a la persona.
- Cuando se te pida JSON, devuelve EXCLUSIVAMENTE JSON válido que cumpla el esquema indicado. Sin texto adicional, sin markdown, sin comentarios, sin código ejecutable ni HTML.`;

const JSON_ONLY = "Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional ni markdown.";

/** Compact, PII-redacted view of state for prompts. */
function stateDigest(state: PlanQuestionParams["state"]): string {
  const c = state.completeness;
  return JSON.stringify(
    {
      careerGoal: state.careerGoal ?? null,
      targetRole: state.targetRole ?? null,
      personalInformation: state.personalInformation,
      educationCount: state.education.length,
      experience: state.experience.map((e) => ({
        id: e.id,
        experienceType: e.experienceType,
        title: e.title,
        organization: e.organization,
        hasDetail: e.responsibilities.length > 0 || !!e.rawDescription,
      })),
      projectsCount: state.projects.length,
      confirmedSkills: state.confirmedSkills.map((s) => s.name),
      suggestedSkills: state.suggestedSkills.map((s) => s.name),
      rejectedSkills: state.rejectedSkills.map((s) => s.name),
      answeredQuestionIds: state.answeredQuestionIds,
      skippedQuestionIds: state.skippedQuestionIds,
      completeness: {
        overallScore: c.overallScore,
        readiness: c.readiness,
        recommendedSection: c.recommendedSection,
        missingCritical: c.missingCriticalFields.map((m) => m.label),
      },
    },
    null,
    0,
  );
}

/**
 * The model REWORDS the next question; it does not choose it.
 *
 * The question is already decided — `FUNNEL_SCRIPT` decides it and
 * `planNextQuestion` pins it before this prompt is built — so asking the model to
 * pick would only reintroduce the wandering order this funnel was fixed to stop.
 * A decision that comes back naming any other questionId is discarded, which is
 * why the instruction is stated as a constraint rather than a preference.
 */
export function buildPlannerPrompt(params: PlanQuestionParams): string {
  const next = params.candidates[0];
  const upcoming = params.candidates.slice(1).map((c) => c.defaultText);
  return `Tu tarea: REESCRIBIR la siguiente pregunta del cuestionario para esta persona. La pregunta ya está decidida; tú solo la haces sonar natural y cercana.

Estado actual del perfil (información sensible ya redactada):
${stateDigest(params.state)}

Sección recomendada por el sistema (solo contexto): ${params.recommendedSection}

La pregunta que debes reescribir:
${JSON.stringify(
  next
    ? {
        questionId: next.questionId,
        section: next.section,
        defaultText: next.defaultText,
        inputType: next.inputType,
        intent: next.intent,
      }
    : null,
  null,
  0,
)}

Preguntas que vienen después (NO las hagas todavía, solo para que no repitas su contenido):
${JSON.stringify(upcoming, null, 0)}

Instrucciones:
- "questionId" y "section" DEBEN ser exactamente los de la pregunta de arriba. No elijas otra.
- Personaliza "questionText" en español, cálido y claro, adaptándolo a lo que la persona ya contó. Conserva la intención y lo que se pide.
- No adelantes ni juntes las preguntas que vienen después.
- "nextAction" normalmente es "ask_question"; usa "confirm_skills" si la pregunta es de confirmación de habilidades, "review_profile" o "generate_resume" solo si el perfil está listo.

${JSON_ONLY} Debe cumplir el esquema PlannerDecision: { questionId, section, questionText, supportingText?, reasonForAsking?, exampleAnswer?, contextUsed[], nextAction }.`;
}

/**
 * The `updates` fields for ONE section, plus the extra rules that section needs.
 *
 * The prompt used to carry all eight sections' schemas on every call: an answer
 * about an experience shipped the field lists for education, projects,
 * certifications, languages and achievements too, and the language-level rules, and
 * the certificate rules. That static block ran ~1,100 tokens and this is the most
 * repeated prompt in the product — roughly 26 calls per résumé once the improvement
 * loop's deep-dives are counted — so most of those tokens were paid for on every
 * call to describe fields the answer could not possibly fill.
 *
 * Each entry below is what that section can actually write. `career_goal` and
 * `review` need none: nothing in `updates` belongs to them.
 */
const SECTION_SCHEMAS: Partial<Record<ResumeSection, { fields: string; rules?: string }>> = {
  personal_information: {
    fields: `"personalInformation": { "firstName": "…", "lastName": "…", "city": "…", "state": "…", "country": "…", "phone": "…", "email": "…", "linkedInUrl": "…", "portfolioUrl": "…" }`,
  },
  education: {
    fields: `"educationEntries": [{ "institution": "…", "credential": "…", "fieldOfStudy": "…", "startDate": "…", "endDate": "…", "isCurrent": false, "relevantCoursework": ["…"] }]`,
    rules: `- Separa cada estudio en su propio objeto. Pon en "credential" SOLO el nivel o título, sin la escuela ni la frase completa (p.ej. "Secundaria", "Curso de administración"); en "institution" el nombre de la escuela si lo menciona; en "fieldOfStudy" el área de estudio. Ejemplo: "Terminé la secundaria en el Colegio Nacional y estudié seis meses de administración en el Instituto Local" → dos objetos: {credential:"Secundaria", institution:"Colegio Nacional"} y {credential:"Curso de administración", institution:"Instituto Local", fieldOfStudy:"Administración"}. No inventes escuela ni fecha.`,
  },
  experience: {
    fields: `"experienceEntries": [{ "experienceType": "formal_employment|self_employment|business_owner|freelance|informal_work|family_business|volunteering|internship|school_project|caregiving|personal_project|other", "title": "…", "organization": "…", "startDate": "…", "endDate": "…", "isCurrent": false, "rawDescription": "…", "responsibilities": ["…"], "accomplishments": ["…"], "tools": ["…"], "peopleServed": "…", "metrics": ["…"] }]`,
    rules: `- Si la respuesta es un objeto JSON de conteos por tipo de experiencia (p.ej. {"caregiving":2,"volunteering":1}), devuelve en "experienceEntries" ESE número de entradas de cada tipo, VACÍAS (solo "experienceType"; sin title, organization ni descripción): más adelante se le pregunta por cada una. Nunca devuelvas más de ${MAX_EXPERIENCE_ENTRIES} entradas en total. Si el objeto viene vacío ({}), la persona no tiene ninguna experiencia de esos tipos: devuelve "updates" vacío, sin ninguna entrada.
- Conserva la redacción original de la persona en "rawDescription".`,
  },
  projects: {
    fields: `"projects": [{ "name": "…", "projectType": "personal|academic|professional|volunteer|other", "description": "…", "responsibilities": ["…"], "outcomes": ["…"], "tools": ["…"] }]`,
  },
  certifications: {
    fields: `"certifications": [{ "name": "…", "issuingOrganization": "…", "issueDate": "…" }]`,
    rules: `- Separa cada certificado en su propio objeto. Pon en "name" el título del certificado o curso (sin la institución ni el año), en "issuingOrganization" la entidad que lo emitió (p.ej. Google, Coursera, SENA) si se menciona, y en "issueDate" el año o fecha si se menciona. No inventes emisor ni fecha si la persona no los dio.`,
  },
  languages: {
    fields: `"languages": [{ "name": "Español", "speakingLevel": "basico|intermedio|avanzado|nativo", "readingLevel": "…", "writingLevel": "…" }]`,
    rules: `- Normaliza el nombre del idioma en español (p.ej. "English" → "Inglés") y clasifica el nivel en uno de: "basico", "intermedio", "avanzado", "nativo". Interpreta descripciones libres: "perfecto"/"lo hablo perfectamente"/"native"/"bilingüe" → "nativo"; "profesional"/"business"/"fluido"/"avanzado" → "avanzado"; "intermedio"/"conversacional" → "intermedio"; "básico"/"poco" → "basico".`,
  },
  achievements: {
    fields: `"achievements": [{ "title": "…", "organization": "…", "date": "…", "description": "…" }]`,
  },
  skills: {
    fields: `"careerGoal": "…", "targetRole": "…"`,
  },
  career_goal: {
    fields: `"careerGoal": "…", "targetRole": "…"`,
  },
};

/**
 * The half of the normalizer prompt that does not depend on the answer.
 *
 * Split out so the stable text comes FIRST and the person's answer LAST. That
 * ordering is what makes the block cacheable: prompt caching matches on a prefix,
 * and with the question and answer at the top (as they were) every call had a
 * different prefix and nothing could ever be reused. Caching still has to be turned
 * on — see `AzureOpenAIProvider.normalizeAnswer` — but the shape now allows it.
 */
export function buildNormalizerSystemPrompt(section: ResumeSection): string {
  const schema = SECTION_SCHEMAS[section];
  const sectionRules = schema?.rules ? `\n${schema.rules}` : "";
  const updates = schema ? `\n  "updates": {\n    ${schema.fields}\n  }` : `\n  "updates": {}`;
  return `Tu tarea: extraer ÚNICAMENTE la información que la persona realmente dijo en su respuesta y estructurarla como JSON.
- No agregues datos que no estén en la respuesta.
- Conserva valores aproximados tal cual (no los conviertas en exactos).
- En "interpretationSummary" resume en español lo que entendiste.
- Marca "needsConfirmation": true si hiciste alguna interpretación material que la persona deba confirmar.
- En "suggestedSkills" incluye habilidades SOLO si hay evidencia clara en la respuesta; cada una con "evidence" citando lo que dijo la persona.
- Coloca lo extraído en "updates". Incluye SOLO los campos relevantes a esta respuesta; omite el resto.
- Si la respuesta es una negación o no aporta información (p.ej. "no", "ninguno", "nada", "no sé", "no recuerdo", "no aplica"), NO inventes nada y NO la guardes como contenido: devuelve "updates" vacío ({}) y di en "interpretationSummary" que no había información nueva. Las preguntas de experiencia no se pueden omitir, así que una negación es la forma normal de decir "aquí no hay nada".${sectionRules}

${JSON_ONLY} Usa EXACTAMENTE estos nombres de campo. Esquema AnswerNormalization:
{
  "interpretationSummary": "…",
  "needsConfirmation": false,
  "suggestedSkills": [{ "name": "…", "category": "…", "evidence": "…" }],${updates}
}`;
}

/** The variable half: the question asked and what the person actually wrote. */
export function buildNormalizerUserPrompt(params: NormalizeAnswerParams): string {
  return `Sección: "${params.section}"
Pregunta: ${params.questionText}
Respuesta textual de la persona: """${params.rawAnswer}"""`;
}

/**
 * Whole-prompt form, kept for callers that want one string (and for the tests that
 * assert the two halves compose). The provider sends the halves separately.
 */
export function buildNormalizerPrompt(params: NormalizeAnswerParams): string {
  return `${buildNormalizerSystemPrompt(params.section)}\n\n${buildNormalizerUserPrompt(params)}`;
}

export function buildSkillSuggestionPrompt(params: SuggestSkillsParams): string {
  const focus = params.focusExperienceIds
    ? params.state.experience.filter((e) => params.focusExperienceIds!.includes(e.id))
    : params.state.experience;
  const evidence = focus.map((e) => ({
    id: e.id,
    experienceType: e.experienceType,
    title: e.title,
    organization: e.organization,
    responsibilities: e.responsibilities,
    accomplishments: e.accomplishments,
    tools: e.tools,
    rawDescription: e.rawDescription,
  }));
  return `Analiza estas experiencias y sugiere habilidades RESPALDADAS POR EVIDENCIA.

Experiencias:
${JSON.stringify(evidence, null, 0)}

Habilidades que NO debes volver a sugerir (ya sugeridas, confirmadas o rechazadas):
${JSON.stringify(params.excludeSkillNames, null, 0)}

Reglas:
- Solo sugiere una habilidad si puedes citar evidencia concreta en "evidence".
- No infieras dominio de software ni de idiomas sin evidencia.
- No inventes certificaciones ni niveles de dominio.
- Las habilidades son SUGERENCIAS; la persona las confirmará después.

${JSON_ONLY} Devuelve un arreglo JSON de objetos { name, category, evidence }.`;
}

export function buildInterestsExtractionPrompt(params: { rawAnswer: string; existing: string[] }): string {
  return `La persona respondió a una pregunta sobre sus intereses o pasatiempos para incluirlos en su currículum.

Respuesta textual: """${params.rawAnswer}"""
Intereses que ya tiene (no los repitas): ${JSON.stringify(params.existing)}

Tu tarea: extraer los intereses o pasatiempos GENUINOS que la persona menciona.
- Si la respuesta es una negación o no aporta un interés real (p.ej. "no", "no really", "ninguno", "nada", "no tengo", "la verdad no"), devuelve una lista VACÍA.
- NUNCA guardes una negación como si fuera un interés (nunca escribas cosas como "ninguno relacionado con la cocina").
- Normaliza cada interés a una frase corta y presentable en español (p.ej. "me gusta jugar fútbol los domingos" → "Fútbol").
- No inventes intereses que la persona no haya mencionado. No repitas los que ya tiene.

${JSON_ONLY} Debe cumplir el esquema: { "interests": ["…", "…"] } (arreglo vacío si no hay ninguno).`;
}

export function buildProofreadPrompt(params: { items: Array<{ id: string; text: string }> }): string {
  return `Eres un corrector de estilo profesional para currículums en español. Recibes fragmentos de texto YA redactados, cada uno con un "id".

Tu tarea: corregir ÚNICAMENTE ortografía, acentuación, gramática, puntuación, mayúsculas y consistencia de formato. Deja el texto pulido y profesional.

REGLAS ESTRICTAS:
- NO cambies el significado ni el contenido. NO agregues ni elimines información, logros, herramientas, cifras ni fechas.
- NO inventes datos. NO traduzcas a otro idioma (mantén el español).
- Conserva las cantidades aproximadas EXACTAMENTE como están (p.ej. "aproximadamente 20", "más de 100").
- Si un fragmento ya está correcto, devuélvelo igual.
- Devuelve CADA fragmento con su MISMO "id" y el texto corregido en "text".
- En "notes" incluye de 1 a 4 notas MUY breves en español sobre los tipos de correcciones hechas (p.ej. "Corregí acentos", "Unifiqué el uso de mayúsculas"). No incluyas datos personales en las notas. Si no hubo cambios, deja "notes" vacío.

Fragmentos:
${JSON.stringify(params.items, null, 0)}

${JSON_ONLY} Debe cumplir el esquema: { "items": [{ "id": "…", "text": "…" }], "notes": ["…"] }.`;
}

function guidelinesBlock(guidelines?: string): string {
  if (!guidelines || guidelines.trim().length === 0) return "";
  return `\nPAUTAS DE ESTILO Y FORMATO (síguelas, pero las REGLAS DE VERACIDAD del sistema tienen prioridad — nunca inventes ni exageres, aunque estas pautas lo sugieran):
"""
${guidelines.trim()}
"""\n`;
}

export function buildResumeGenerationPrompt(input: ResumeGenerationInput): string {
  const { guidelines, ...data } = input;
  return `Genera el CONTENIDO de un currículum profesional en español usando ÚNICAMENTE los datos confirmados a continuación. No agregues hechos nuevos.
${guidelinesBlock(guidelines)}
Datos confirmados:
${JSON.stringify(data, null, 0)}

SELECCIÓN DE EXPERIENCIAS (tú decides cuáles entran):
- Las experiencias vienen ordenadas de la MÁS RECIENTE a la más antigua. Devuélvelas en ese MISMO orden.
- Incluye todas las experiencias que ayuden a conseguir el puesto objetivo ("targetRole" / "careerGoal"). Para OMITIR una, simplemente NO devuelvas su bloque (no la menciones en ningún otro lado). Omitir no borra nada: la persona conserva su información.
- Omite SOLO cuando la experiencia claramente no aporta nada para ese puesto. Ante la duda, INCLÚYELA.
- Un trabajo informal, el cuidado de personas, un voluntariado, un negocio familiar o un proyecto SÍ aportan cuando muestran habilidades transferibles (responsabilidad, atención al cliente, organización, manejo de dinero, puntualidad, trabajo en equipo). NUNCA omitas una experiencia por ser informal, no remunerada o de poca duración.
- Si la persona tiene 1 o 2 experiencias, inclúyelas TODAS.

LÍMITE DE UNA PÁGINA (obligatorio — tú decides qué conservar y qué quitar):
- El currículum COMPLETO debe caber en UNA sola página. Tú decides, con tu criterio, qué conservar y qué recortar para lograrlo.
- Presupuesto aproximado de una página: "professionalSummary" de 2 a 3 frases; entre 10 y 14 viñetas EN TOTAL sumando experiencia y proyectos; 1 o 2 líneas por entrada de educación; de 2 a 4 grupos de habilidades.
- MÍNIMO POR EXPERIENCIA: cada experiencia que incluyas debe llevar AL MENOS 2 viñetas. Una experiencia con una sola viñeta se ve vacía y no ayuda a la persona. Si el presupuesto no alcanza para dar 2 viñetas a todas, es mejor OMITIR la experiencia menos pertinente y describir bien las demás que dejar todas a medias.
- Si no cabe todo, recorta EN ESTE ORDEN: (1) viñetas repetidas o que aportan poco; (2) detalles de educación; (3) viñetas de proyectos; (4) viñetas de las experiencias menos pertinentes o más antiguas, siempre respetando el mínimo de 2; (5) solo al final, omite por completo una experiencia claramente no pertinente, siguiendo las reglas de selección de arriba.
- NUNCA recortes, ni para ahorrar espacio: el resumen profesional por debajo de 2 frases, ni las viñetas de la experiencia más pertinente para el puesto.
- Prefiere pocas viñetas bien escritas antes que muchas viñetas cortas y repetidas.

Instrucciones de redacción (objetivo: un CV pulido y profesional, SIN inventar):
- "professionalSummary": 2-3 frases atractivas y profesionales que resalten el perfil, basadas SOLO en estos datos.
- Dedica MÁS viñetas y mejor redacción a las experiencias más pertinentes para el puesto objetivo.
- Redacta cada experiencia con varias viñetas, ajustándote al presupuesto de una página: con 1 o 2 experiencias puedes dar 3-5 viñetas a cada una; con 3 o 4 experiencias, da 2-3 a cada una. Aprovecha responsabilidades, logros, herramientas, personas atendidas y métricas. Es correcto convertir un hecho en una viñeta bien redactada (p.ej. "usaba Excel" → "Manejo de Microsoft Excel para organizar información").
- Empieza cada viñeta con un verbo de acción fuerte (Gestioné, Atendí, Organicé, Coordiné, Resolví, Optimicé…) y un tono orientado a logros.
- Presenta la experiencia de la forma MÁS FUERTE y profesional posible, PERO sin inventar ni exagerar hechos: no agregues métricas, empleadores, herramientas ni logros que la persona no mencionó. Conserva las cantidades aproximadas tal cual.
- ELIMINA REDUNDANCIAS: no repitas la misma idea en varias viñetas ni entre secciones; fusiona lo repetido y pule la redacción y el formato en cada generación.
- Cada bloque de experiencia, educación y proyecto DEBE identificarse con el campo "entryId" igual al "id" EXACTO de la entrada proporcionada arriba (usa "entryId", NO "id").
- Cada viñeta DEBE incluir "sourceEntryIds" (los id de las entradas de origen) y "sourceFields" (los campos usados, p.ej. "responsibilities", "tools").
- Agrupa las habilidades por categoría en "skillGroups"; cada grupo lleva "category" y "skillIds" con los id EXACTOS de las habilidades (p.ej. "sk1"), NO los nombres.

${JSON_ONLY} Usa EXACTAMENTE estos nombres de campo (no los cambies) y cumple este esquema ResumeContent:
{
  "professionalSummary": "…",
  "experience": [{ "entryId": "<id de la experiencia>", "bullets": [{ "text": "…", "sourceEntryIds": ["<id>"], "sourceFields": ["responsibilities"] }] }],
  "education": [{ "entryId": "<id de la educación>", "details": [{ "text": "…", "sourceEntryIds": ["<id>"], "sourceFields": ["credential"] }] }],
  "projects": [{ "entryId": "<id del proyecto>", "bullets": [{ "text": "…", "sourceEntryIds": ["<id>"], "sourceFields": ["outcomes"] }] }],
  "skillGroups": [{ "category": "…", "skillIds": ["<id de la habilidad>"] }]
}`;
}

export function buildAnalysisPrompt(params: AnalyzeResumeParams): string {
  const r = params.resume;
  const resumeDigest = {
    professionalSummary: r.professionalSummary,
    experienceBlocks: r.experience.map((e) => ({ title: e.title, organization: e.organization, bulletCount: e.bullets.length })),
    educationCount: r.education.length,
    skillCount: r.skills.reduce((n, g) => n + g.skills.length, 0),
    languageCount: r.languages.length,
    interestCount: params.state.interests.length,
    projectCount: r.projects.length,
    certificationCount: r.certifications.length,
  };
  // Entries WITH IDS so the model can ask personalized deep-dive questions.
  const entries = {
    experiences: params.state.experience.map((e) => ({
      id: e.id,
      title: e.title,
      organization: e.organization,
      responsibilities: e.responsibilities,
      accomplishments: e.accomplishments,
      tools: e.tools,
    })),
    projects: params.state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      responsibilities: p.responsibilities,
      outcomes: p.outcomes,
      tools: p.tools,
    })),
  };
  return `Eres un revisor de currículums EXIGENTE. Critica el currículum con honestidad y dureza (constructiva), detecta debilidades y redundancias, y propón cómo hacerlo más fuerte — sacando a la luz información REAL que la persona aún no ha compartido (no inventes nada). Evalúalo contra las pautas.
${guidelinesBlock(params.guidelines)}
Currículum actual (resumen):
${JSON.stringify(resumeDigest, null, 0)}

Entradas con su id (para preguntas personalizadas):
${JSON.stringify(entries, null, 0)}

Perfil (información sensible redactada):
${stateDigest(params.state)}

Áreas débiles detectadas por el sistema (tenlas en cuenta):
${JSON.stringify(params.gapHints, null, 0)}

Tu tarea:
- "overallImpression": 1-2 frases honestas y directas sobre el estado del currículum (qué le falta para ser competitivo).
- "strengths": 2-4 fortalezas reales del currículum actual.
- "improvements": preguntas de seguimiento para mejorar el currículum. Devuelve como MÁXIMO ${MAX_FEEDBACK_QUESTIONS_PER_ITERATION}, las más importantes — el sistema solo muestra ${MAX_FEEDBACK_QUESTIONS_PER_ITERATION} por ronda, así que las demás se descartan. Cada "questionId" DEBE salir de esta lista: ${JSON.stringify(params.allowedQuestionIds)}.
  * Para PREGUNTAS PERSONALIZADAS sobre una experiencia o proyecto concreto, usa "experience_deepen" o "project_deepen" e incluye el "entryId" EXACTO de la entrada correspondiente (de la lista de arriba). Haz preguntas MUY específicas que mencionen el proyecto/experiencia por su nombre. Ejemplo: si hay un proyecto "Simulador Monte Carlo para VOO", pregunta qué lenguajes/herramientas usó, cómo modeló los escenarios y qué resultados obtuvo.
  * Para secciones faltantes (idiomas, intereses, habilidades, etc.), usa el questionId de sección correspondiente (sin entryId).
  * Prioriza profundizar en experiencias/proyectos con poco detalle y señalar cualquier redundancia.
- Cada improvement lleva "followUpQuestion" (claro y amable), "title" corto y "detail" (por qué ayuda). No inventes datos ni sugieras exagerar; el objetivo es reunir más información verdadera.
- NUNCA escribas un id en un texto que la persona vaya a leer ("title", "detail", "followUpQuestion", "overallImpression", "strengths"). Los ids son SOLO para el campo "entryId". Si una entrada está vacía y no tiene nombre, di "esta experiencia" o "este proyecto".

${JSON_ONLY} Debe cumplir el esquema ResumeAnalysis: { overallImpression, strengths[], improvements[] } donde cada improvement es { questionId, entryId?, title, detail, followUpQuestion }.`;
}
