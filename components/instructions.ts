import type { AdaptiveQuestion } from "@/lib/ai/schemas";
import type { ResumeSection } from "@/types";

/**
 * Plain-language "what should I do on this screen?" copy.
 *
 * Every funnel step and every follow-up screen shows one of these at the top
 * (see `InstructionBanner`). Written for readers with low literacy: short
 * sentences, everyday words, no jargon, and always an "out" (you can skip / it
 * doesn't have to be perfect) so nobody gets stuck.
 */
export interface StepInstruction {
  icon: string;
  title: string;
  body: string;
}

const BY_SECTION: Record<ResumeSection, StepInstruction> = {
  career_goal: {
    icon: "🎯",
    title: "¿Qué trabajo quieres?",
    body: "Dinos qué trabajo te gustaría tener. Escribe con tus palabras. No importa si no estás seguro.",
  },
  personal_information: {
    icon: "👤",
    title: "Tus datos",
    body: "Escribe tu nombre y cómo pueden encontrarte: tu teléfono o tu correo.",
  },
  education: {
    icon: "📚",
    title: "Lo que estudiaste",
    body: "Cuéntanos qué estudiaste. Sirve la escuela, un curso corto o algo que aprendiste. Si no estudiaste, puedes saltar este paso.",
  },
  experience: {
    icon: "🛠️",
    title: "Lo que has hecho",
    body: "Cuéntanos algo que hayas hecho: un trabajo, un negocio, cuidar a alguien o ayudar sin pago. Todo cuenta.",
  },
  skills: {
    icon: "⭐",
    title: "Lo que sabes hacer",
    body: "Marca lo que sí sabes hacer. Quita lo que no. Solo ponemos lo que tú digas.",
  },
  certifications: {
    icon: "📜",
    title: "Tus diplomas",
    body: "¿Tienes algún diploma o certificado? Escríbelo aquí. Si no tienes, puedes saltar este paso.",
  },
  languages: {
    icon: "🗣️",
    title: "Idiomas que hablas",
    body: "Dinos qué idiomas hablas y cuánto: un poco, más o menos, o bien.",
  },
  projects: {
    icon: "💡",
    title: "Cosas que hiciste",
    body: "Cuéntanos algo que hayas hecho o arreglado tú mismo. Puede ser en tu casa, tu barrio o un curso.",
  },
  achievements: {
    icon: "🏆",
    title: "Tus logros",
    body: "Cuéntanos algo que hiciste bien y que te puso orgulloso. Grande o pequeño, todo sirve.",
  },
  review: {
    icon: "✅",
    title: "Revisa tu información",
    body: "Lee lo que escribiste. Cambia o borra lo que quieras. Cuando esté bien, aprieta el botón para crear tu currículum.",
  },
};

/**
 * Per-QUESTION overrides, checked before the section default.
 *
 * `personal_information` is one section covering three unrelated questions — the
 * name, a contact channel, and where the person lives — so its section banner
 * ("Escribe tu nombre y cómo pueden encontrarte") was shown verbatim while the
 * screen asked something else entirely. Someone answering "¿En qué ciudad vives?"
 * read an instruction telling them to write their name, which is exactly the
 * confusion this banner exists to prevent.
 *
 * Only questions whose section banner would actively mislead need an entry here;
 * everything else falls through to BY_SECTION.
 */
const BY_QUESTION: Record<string, StepInstruction> = {
  personal_name: {
    icon: "👤",
    title: "¿Cómo te llamas?",
    body: "Escribe tu nombre y tus apellidos, como quieres que aparezcan en tu currículum.",
  },
  personal_contact: {
    icon: "📞",
    title: "¿Cómo te pueden contactar?",
    body: "Escribe tu teléfono o tu correo. Con uno basta. Es para que las empresas te puedan escribir.",
  },
  personal_location: {
    icon: "📍",
    title: "¿Cuál es tu código postal?",
    body: "Escribe los cinco números de tu código postal. Sirve para que las empresas cerca de ti te encuentren. Si no quieres decirlo, puedes saltar este paso.",
  },
  // The `skills` section banner is written for the CONFIRM screen ("Marca lo que
  // sí sabes hacer"), but the funnel's skills step is this one: a box you type a
  // list into. Same section, opposite instruction.
  skills_add: {
    icon: "⭐",
    title: "¿Qué sabes hacer?",
    body: "Escribe las cosas que sabes hacer, separadas por comas. Por ejemplo: trabajo en equipo, puntualidad, Excel.",
  },
};

const FALLBACK: StepInstruction = {
  icon: "✍️",
  title: "Cuéntanos más",
  body: "Responde con tus palabras. No tiene que ser perfecto.",
};

const SKILL_CONFIRM: StepInstruction = {
  icon: "⭐",
  title: "Confirma lo que sabes",
  body: 'Te mostramos cosas que creemos que sabes hacer. Aprieta "Confirmar" si es verdad. Aprieta "No incluir" si no lo es.',
};

/** Pick the right instruction for the current funnel question/step. */
export function stepInstruction(question: AdaptiveQuestion): StepInstruction {
  if (question.inputType === "skill_confirmation") return SKILL_CONFIRM;
  if (question.inputType === "review" || question.nextAction === "review_profile") {
    return BY_SECTION.review;
  }
  return BY_QUESTION[question.questionId] ?? BY_SECTION[question.section] ?? FALLBACK;
}
