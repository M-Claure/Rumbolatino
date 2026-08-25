/**
 * The directory's category taxonomy, and the Spanish labels for every enum the
 * publish screen and the employer filters render.
 *
 * ── Why this is a CODE constant and not a table or an env var ────────────────
 * A taxonomy is a claim about what Aprende's graduates actually do for a living.
 * That claim belongs in review, next to its reasoning, and under test — the same
 * argument `lib/rate-limit/policy.ts` makes for request limits and `lib/config/
 * limits.ts` makes for MAX_EXPERIENCE_ENTRIES. In a table it would drift per
 * environment and no diff would ever show it changing.
 *
 * The ids live in `types/talent.ts`; `CATEGORIES` below is a
 * `Record<TalentCategory, …>`, so adding an id there fails to compile until its
 * label and keywords are written here. Adding a category cannot be half-done.
 *
 * ── Keywords are STEMS, not words ───────────────────────────────────────────
 * Spanish inflects for gender and number, so "cocinera", "cocineros" and
 * "cocinar" must all reach `gastronomia`. Matching a stem at a word boundary
 * gets that for free without a stemmer: `cocin` covers all three. Write them
 * naturally, accents and all — `classify.ts` strips accents from both sides, so
 * `diseño` matches text that was typed `diseno`.
 *
 * Short keywords (≤ 4 characters) are matched as WHOLE words instead, because a
 * four-letter stem is long enough to appear inside unrelated ones.
 */
import { TALENT_CATEGORY_IDS, type TalentCategory } from "@/types/talent";
import type { TalentAvailability, TalentYearsBucket } from "@/types/talent";

export interface TalentCategoryDef {
  /** Spanish label shown in the publish dropdown and the employer filters. */
  readonly label: string;
  /** One line of plain Spanish, so a user can tell two neighbouring categories apart. */
  readonly hint: string;
  /** Stems matched against the résumé's own words. See the note above. */
  readonly keywords: readonly string[];
}

export const CATEGORIES: Record<TalentCategory, TalentCategoryDef> = {
  belleza: {
    label: "Belleza y estética",
    hint: "Cosmetología, barbería, uñas, maquillaje, cuidado de la piel.",
    keywords: [
      "cosmetolog", "belleza", "barber", "peluquer", "estilis", "cabello", "corte de cabello",
      "uñas", "manicur", "pedicur", "maquill", "cejas", "pestañ", "depilac", "facial",
      "estétic", "colorimetr", "alisad", "extensiones de cabello", "trenza", "salón de belleza",
      "tinte", "keratina", "acrílic",
    ],
  },
  gastronomia: {
    label: "Gastronomía y alimentos",
    hint: "Cocina, repostería, panadería, bar, servicio en restaurante.",
    keywords: [
      "cocin", "chef", "reposter", "panader", "pasteler", "bartend", "barista",
      "camarer", "culinar", "gastronom", "catering", "banquet", "parrill", "sushi", "meser",
      "restaurant", "food truck", "ayudante de cocina", "lavaloza", "repostería", "postres",
      "menú", "cheff", "taquer", "pizzer",
    ],
  },
  salud: {
    label: "Salud y cuidado de personas",
    hint: "Asistente médico, enfermería auxiliar, flebotomía, cuidado de adultos mayores.",
    keywords: [
      "enfermer", "flebotom", "asistente médic", "asistente medico", "cuidado de adultos",
      "cuidador", "geriatr", "ancian", "adulto mayor", "farmac", "dental", "odontolog",
      "radiolog", "laboratorio clínico", "primeros auxilios", "signos vitales", "paciente",
      "clínic", "hospital", "terapia respiratoria", "home health", "cuidado de enfermos",
    ],
  },
  bienestar: {
    label: "Bienestar y acondicionamiento físico",
    hint: "Nutrición, masajes, entrenamiento personal, yoga.",
    keywords: [
      "nutric", "nutriolog", "dietét", "dietet", "masaj",
      // Single-word stems, not "entrenador personal": a phrase cannot stem its
      // first word, so the phrase form silently misses "entrenadora personal".
      "entrenad", "entrenamiento personal",
      "fitness", "gimnasio", "yoga", "pilates", "coach de salud", "holístic", "reiki",
      "aromaterap", "quiromasaj", "spa", "relajación", "acondicionamiento físico",
    ],
  },
  oficios: {
    label: "Oficios y construcción",
    hint: "Electricidad, plomería, HVAC, soldadura, carpintería, remodelación.",
    keywords: [
      "electricist", "electricidad", "plomer", "fontaner", "hvac", "aire acondicionado",
      "refrigerac", "soldad", "carpinter", "albañil", "construc", "pintor", "pintura de casas",
      "techo", "drywall", "tablaroca", "herrer", "cerraj", "remodelac", "azulej", "piso",
      "instalación eléctrica", "mantenimiento", "obra", "andamio",
    ],
  },
  automotriz: {
    label: "Mecánica y transporte",
    hint: "Mecánica automotriz, hojalatería, conducción, reparto, almacén y montacargas.",
    keywords: [
      "mecánic", "mecanic", "automotriz", "hojalater", "transmisión", "frenos", "diésel",
      "diesel", "conductor", "chofer", "camión", "camion", "cdl", "repartidor", "reparto",
      "montacarg", "forklift", "llantas", "taller automotriz", "afinación", "suspensión",
    ],
  },
  negocios: {
    label: "Negocios y administración",
    hint: "Administración, contabilidad, ventas, atención al cliente, emprendimiento.",
    keywords: [
      "administrac", "contab", "contador", "finanz", "nómina", "nomina", "emprend",
      "negocio propio", "ventas", "vendedor", "marketing", "mercadotecn", "bienes raíces",
      "inmobiliar", "seguros", "atención al cliente", "atencion al cliente", "call center",
      "recepcion", "asistente administrativ", "secretari", "recursos humanos", "compras",
      "inventario", "cajer", "facturac", "presupuest", "supervis",
    ],
  },
  tecnologia: {
    label: "Tecnología y diseño digital",
    hint: "Programación, soporte técnico, diseño gráfico, redes sociales, edición de video.",
    keywords: [
      "program", "desarrollo web", "software", "javascript", "python", "html", "css",
      "base de datos", "ciberseguridad", "redes", "soporte técnic", "soporte tecnic",
      "computac", "informátic", "informatic",
      // "diseñad" as well as the phrase: same trap as "entrenador personal" above —
      // "diseño gráfic" cannot match "diseñadora gráfica".
      "diseñad", "diseño gráfic", "diseño grafic", "photoshop",
      "illustrator", "canva", "edición de video", "community manager", "redes sociales",
      "ecommerce", "wordpress", "excel avanzado", "análisis de datos",
    ],
  },
  educacion: {
    label: "Educación y cuidado infantil",
    hint: "Maestra, tutora, guardería, niñera, estimulación temprana.",
    keywords: [
      "maestr", "profesor", "docente", "educac", "niñer", "niner", "cuidado infantil",
      "guarder", "preescolar", "tutor", "enseñanza", "ensenanza", "pedagog", "babysit",
      "montessori", "estimulación temprana", "primaria", "kínder", "kinder", "niños",
    ],
  },
  servicios_generales: {
    label: "Servicios generales",
    hint: "Limpieza, jardinería, costura, eventos, mudanzas, seguridad, mascotas.",
    keywords: [
      "limpieza", "aseo", "housekeep", "conserj", "jardiner", "paisaj", "lavander",
      "mudanza", "eventos", "decorac", "fotograf", "costur", "sastr", "modist", "tapicer",
      "mascota", "peluquería canina", "seguridad", "guardia", "empacad", "almacén",
      "almacen", "bodega", "planchado",
    ],
  },
  otro: {
    label: "Otro",
    hint: "Nada de lo anterior describe tu trabajo.",
    // Deliberately empty. `otro` is what the classifier falls back to when
    // nothing scores, never something it can win on its own.
    keywords: [],
  },
};

/** Render order for dropdowns — the declared id order, with `otro` last. */
export const CATEGORY_OPTIONS: ReadonlyArray<{ id: TalentCategory; label: string; hint: string }> =
  TALENT_CATEGORY_IDS.map((id) => ({ id, label: CATEGORIES[id].label, hint: CATEGORIES[id].hint }));

export function labelForCategory(id: TalentCategory): string {
  return CATEGORIES[id].label;
}

/** True when `value` is a category id we know. Use before trusting a request body. */
export function isTalentCategory(value: unknown): value is TalentCategory {
  return typeof value === "string" && (TALENT_CATEGORY_IDS as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels for the other two public enums
// ─────────────────────────────────────────────────────────────────────────────

export const AVAILABILITY_LABELS: Record<TalentAvailability, string> = {
  inmediata: "Puedo empezar de inmediato",
  dos_semanas: "Puedo empezar en dos semanas",
  un_mes: "Puedo empezar en un mes",
  flexible: "Mi fecha de inicio es flexible",
};

/** The same four, shortened for a result card where space is tight. */
export const AVAILABILITY_SHORT_LABELS: Record<TalentAvailability, string> = {
  inmediata: "Disponible ya",
  dos_semanas: "En 2 semanas",
  un_mes: "En 1 mes",
  flexible: "Flexible",
};

export const YEARS_BUCKET_LABELS: Record<TalentYearsBucket, string> = {
  sin_experiencia: "Comenzando",
  "0_2": "Hasta 2 años de experiencia",
  "3_5": "3 a 5 años de experiencia",
  "6_mas": "Más de 6 años de experiencia",
};

/**
 * ── Filter discipline ───────────────────────────────────────────────────────
 * The filters an employer may narrow by are exactly: a name, category,
 * state, city, availability. That list is short on purpose.
 *
 * `query` is a NAME query, not free text over the résumé — `0014` narrowed it to
 * `name_tsv` alone. The key keeps its generic name because it is a URL
 * parameter that employers may already have bookmarked; the meaning is in
 * `mcv_talent_name_query` and mirrored by `nameSearchTokens`.
 *
 * This product refuses to collect age, photo, marital status, religion, race,
 * health or immigration status — see the safety rules in CLAUDE.md. A filter is
 * a back door into the same information: "graduated before 2005" is an age
 * filter, a photo grid is a race filter, and "native Spanish speaker" is a
 * national-origin filter. None of them may be added here, whatever a customer
 * asks for. `years_bucket` exists as a coarse bucket for the same reason — see
 * the note on `TALENT_YEARS_BUCKETS` in `types/talent.ts`.
 */
export const ALLOWED_FILTER_KEYS = [
  "query",
  "category",
  "state",
  "city",
  "availability",
] as const;
