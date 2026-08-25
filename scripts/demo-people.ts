/**
 * The ten fictional people the demo directory is seeded with.
 *
 * ── Everything here is FAKE, and visibly so ─────────────────────────────────
 * Names are invented. Every contact email is on `example.com` (RFC 2606, which
 * exists so examples cannot reach a real mailbox) and every phone number is in
 * the 555-01xx block reserved for fiction. Nobody can be contacted by accident,
 * and anyone who looks closely can tell the data is not real — which is what you
 * want in a directory whose whole subject is real people's contact details.
 *
 * ── Written so the CLASSIFIER agrees ────────────────────────────────────────
 * The seeder does not hand-assign categories: it runs `suggestCategory` over
 * each résumé exactly as `publishTalentProfile` does, so the demo shows what the
 * product would actually do. The wording below therefore carries the taxonomy's
 * own keywords (`lib/talent/taxonomy.ts`) — that is not decoration, it is what
 * makes the category filter demonstrate something true. The seeder prints the
 * category it derived for each person; if a fixture is reworded into `otro`, it
 * will say so.
 *
 * Kept deliberately thin — one or two jobs, one course, a handful of skills.
 * A demo needs the directory to look populated, not to look like ten finished
 * résumés.
 */
import type { ExperienceType, LanguageLevel } from "@/types";

export interface DemoExperience {
  experienceType: ExperienceType;
  title: string;
  organization: string | null;
  startDate: string;
  endDate: string | null;
  isCurrent: boolean;
  /** Plain sentences; the seeder turns each into a source-traced bullet. */
  bullets: string[];
}

export interface DemoEducation {
  institution: string;
  credential: string;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface DemoPerson {
  firstName: string;
  lastName: string;
  /** Must exist in the bundled GeoNames table — the seeder fails loudly if not. */
  zip: string;
  targetRole: string;
  careerGoal: string;
  summary: string;
  skillGroups: Array<{ category: string; skills: string[] }>;
  experience: DemoExperience[];
  education: DemoEducation[];
  certifications?: string[];
  languages: Array<{ name: string; level: LanguageLevel }>;
  interests?: string[];
}

export const DEMO_PEOPLE: DemoPerson[] = [
  {
    firstName: "María",
    lastName: "González",
    zip: "77002", // Houston, TX
    targetRole: "Estilista profesional",
    careerGoal: "Trabajar en un salón de belleza establecido y con el tiempo abrir el mío.",
    summary:
      "Cosmetóloga con más de seis años de experiencia en corte de cabello, colorimetría y tratamientos de keratina. Atiendo en español e inglés y me especializo en tinte y alisado.",
    skillGroups: [
      { category: "Belleza", skills: ["Corte de cabello", "Colorimetría", "Tinte", "Keratina", "Peinado"] },
      { category: "Atención al cliente", skills: ["Atención al cliente", "Agenda de citas"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Estilista",
        organization: "Salón de belleza Bella Vista",
        startDate: "2019",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Atiende un promedio de 12 clientas por día en corte de cabello, tinte y peinado.",
          "Realiza tratamientos de keratina y alisado siguiendo los protocolos del salón.",
        ],
      },
      {
        experienceType: "self_employment",
        title: "Estilista independiente",
        organization: null,
        startDate: "2017",
        endDate: "2019",
        isCurrent: false,
        bullets: ["Ofreció servicios de corte de cabello y tinte a domicilio en su comunidad."],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Cosmetología",
        fieldOfStudy: "Cosmetología",
        startDate: "2018",
        endDate: "2019",
      },
    ],
    certifications: ["Certificación en colorimetría"],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "intermedio" },
    ],
    interests: ["Maquillaje social", "Uñas acrílicas"],
  },
  {
    firstName: "Carlos",
    lastName: "Ramírez",
    zip: "90011", // Los Angeles, CA
    targetRole: "Cocinero de línea",
    careerGoal: "Crecer dentro de una cocina profesional hasta llegar a chef de partida.",
    summary:
      "Cocinero con cuatro años de experiencia en cocina de restaurante y parrilla. Manejo preparación de menú, línea caliente y control de inventario de alimentos.",
    skillGroups: [
      { category: "Cocina", skills: ["Cocina de línea", "Parrilla", "Preparación de menú", "Manejo de alimentos"] },
      { category: "Operación", skills: ["Inventario", "Trabajo en equipo"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Cocinero de línea",
        organization: "Restaurante El Portal",
        startDate: "2023",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Prepara platillos de la línea caliente durante turnos de hasta 150 comensales.",
          "Apoya en el control de inventario y en la recepción de insumos del restaurante.",
        ],
      },
      {
        experienceType: "informal_work",
        title: "Ayudante de cocina",
        organization: "Taquería La Esquina",
        startDate: "2022",
        endDate: "2023",
        isCurrent: false,
        bullets: ["Preparó ingredientes y mantuvo la limpieza del área de cocina."],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Cocina Profesional",
        fieldOfStudy: "Gastronomía",
        startDate: "2021",
        endDate: "2022",
      },
    ],
    certifications: ["ServSafe Food Handler"],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "basico" },
    ],
  },
  {
    firstName: "Lucía",
    lastName: "Fernández",
    zip: "33125", // Miami, FL
    targetRole: "Asistente médico",
    careerGoal: "Trabajar en una clínica familiar apoyando directamente a los pacientes.",
    summary:
      "Asistente médico con formación en toma de signos vitales y flebotomía. Experiencia apoyando en clínica y en el cuidado de adultos mayores.",
    skillGroups: [
      { category: "Clínica", skills: ["Signos vitales", "Flebotomía", "Historia clínica", "Primeros auxilios"] },
      { category: "Trato al paciente", skills: ["Atención al paciente", "Comunicación"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Asistente médico",
        organization: "Clínica Familiar Sunrise",
        startDate: "2023",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Toma signos vitales y prepara al paciente antes de la consulta.",
          "Registra la información del paciente en el expediente de la clínica.",
        ],
      },
      {
        experienceType: "caregiving",
        title: "Cuidadora de adultos mayores",
        organization: null,
        startDate: "2022",
        endDate: "2023",
        isCurrent: false,
        bullets: ["Acompañó a dos adultos mayores en sus rutinas diarias y en sus citas médicas."],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Asistente Médico",
        fieldOfStudy: "Salud",
        startDate: "2021",
        endDate: "2022",
      },
    ],
    certifications: ["Certificación en primeros auxilios y RCP"],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "avanzado" },
    ],
  },
  {
    firstName: "José",
    lastName: "Martínez",
    zip: "60629", // Chicago, IL
    targetRole: "Electricista residencial",
    careerGoal: "Obtener mi licencia y trabajar en instalación eléctrica residencial.",
    summary:
      "Electricista con siete años de experiencia en instalación eléctrica y mantenimiento en obra residencial. También he trabajado en remodelación y drywall.",
    skillGroups: [
      { category: "Oficio", skills: ["Instalación eléctrica", "Mantenimiento", "Lectura de planos", "Drywall"] },
      { category: "Seguridad", skills: ["Seguridad en obra", "Uso de andamio"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Electricista",
        organization: "Construcciones Delgado",
        startDate: "2018",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Realiza instalación eléctrica completa en casas de nueva construcción.",
          "Diagnostica y repara fallas eléctricas en trabajos de remodelación.",
        ],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Electricidad Residencial",
        fieldOfStudy: "Electricidad",
        startDate: "2017",
        endDate: "2018",
      },
    ],
    certifications: ["OSHA 10"],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "intermedio" },
    ],
  },
  {
    firstName: "Ana",
    lastName: "Torres",
    zip: "85009", // Phoenix, AZ
    targetRole: "Maestra de preescolar",
    careerGoal: "Trabajar en una guardería bilingüe con niños de tres a cinco años.",
    summary:
      "Educadora con experiencia en cuidado infantil y estimulación temprana. He trabajado en guardería y como niñera con grupos de niños pequeños.",
    skillGroups: [
      { category: "Educación", skills: ["Estimulación temprana", "Planeación de clase", "Cuidado infantil"] },
      { category: "Manejo de grupo", skills: ["Manejo de grupo", "Comunicación con padres"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Asistente de maestra",
        organization: "Guardería Pequeños Pasos",
        startDate: "2025",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Apoya a la maestra titular con un grupo de 15 niños de preescolar.",
          "Prepara actividades de estimulación temprana y material didáctico.",
        ],
      },
      {
        experienceType: "informal_work",
        title: "Niñera",
        organization: null,
        startDate: "2024",
        endDate: "2025",
        isCurrent: false,
        bullets: ["Cuidó a tres niños en edad escolar y apoyó con sus tareas."],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Educación Infantil",
        fieldOfStudy: "Educación",
        startDate: "2023",
        endDate: "2024",
      },
    ],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "intermedio" },
    ],
  },
  {
    firstName: "Roberto",
    lastName: "Sánchez",
    zip: "78207", // San Antonio, TX
    targetRole: "Mecánico automotriz",
    careerGoal: "Especializarme en transmisión y frenos en un taller automotriz grande.",
    summary:
      "Mecánico automotriz con ocho años de experiencia en afinación, frenos y suspensión. He trabajado en taller automotriz propio y para concesionario.",
    skillGroups: [
      { category: "Mecánica", skills: ["Afinación", "Frenos", "Suspensión", "Diagnóstico automotriz"] },
      { category: "Taller", skills: ["Cotización de reparaciones", "Atención al cliente"] },
    ],
    experience: [
      {
        experienceType: "business_owner",
        title: "Dueño de taller automotriz",
        organization: "Taller Sánchez",
        startDate: "2019",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Atiende reparaciones de frenos, suspensión y afinación en vehículos particulares.",
          "Cotiza el trabajo y compra las refacciones para cada reparación.",
        ],
      },
      {
        experienceType: "formal_employment",
        title: "Mecánico",
        organization: "Auto Servicio Delta",
        startDate: "2018",
        endDate: "2019",
        isCurrent: false,
        bullets: ["Realizó servicios de mantenimiento preventivo y cambio de llantas."],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Mecánica Automotriz",
        fieldOfStudy: "Mecánica automotriz",
        startDate: "2015",
        endDate: "2016",
      },
    ],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "basico" },
    ],
  },
  {
    firstName: "Patricia",
    lastName: "Rivas",
    zip: "75201", // Dallas, TX
    targetRole: "Asistente administrativa",
    careerGoal: "Trabajar en el área de administración y contabilidad de una empresa pequeña.",
    summary:
      "Asistente administrativa con experiencia en facturación, control de inventario y atención al cliente. Manejo Excel y sistemas de nómina.",
    skillGroups: [
      { category: "Administración", skills: ["Facturación", "Inventario", "Nómina", "Excel avanzado"] },
      { category: "Servicio", skills: ["Atención al cliente", "Organización de agenda"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Asistente administrativa",
        organization: "Distribuidora Lozano",
        startDate: "2022",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Lleva la facturación mensual y el control de inventario de la bodega.",
          "Atiende a clientes por teléfono y da seguimiento a sus pedidos.",
        ],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Administración de Negocios",
        fieldOfStudy: "Administración",
        startDate: "2021",
        endDate: "2022",
      },
    ],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "avanzado" },
    ],
  },
  {
    firstName: "Diego",
    lastName: "Herrera",
    zip: "11215", // Brooklyn, NY
    targetRole: "Diseñador gráfico",
    careerGoal: "Trabajar como diseñador gráfico y community manager para negocios locales.",
    summary:
      "Diseñador gráfico con tres años de experiencia en identidad visual, redes sociales y edición de video. Manejo Photoshop, Illustrator y Canva.",
    skillGroups: [
      { category: "Diseño", skills: ["Photoshop", "Illustrator", "Canva", "Identidad visual"] },
      { category: "Digital", skills: ["Redes sociales", "Edición de video", "Community manager"] },
    ],
    experience: [
      {
        experienceType: "freelance",
        title: "Diseñador gráfico independiente",
        organization: null,
        startDate: "2023",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Diseña logotipos y material para redes sociales de negocios locales.",
          "Edita video corto para campañas de redes sociales de sus clientes.",
        ],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Diseño Gráfico",
        fieldOfStudy: "Diseño gráfico",
        startDate: "2022",
        endDate: "2023",
      },
    ],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "avanzado" },
    ],
  },
  {
    firstName: "Gabriela",
    lastName: "Ortiz",
    zip: "30310", // Atlanta, GA
    targetRole: "Nutrióloga",
    careerGoal: "Acompañar a personas con planes de nutrición y hábitos saludables.",
    summary:
      "Formación en nutrición y bienestar, con experiencia dando asesoría de alimentación y acondicionamiento físico en gimnasio.",
    skillGroups: [
      { category: "Nutrición", skills: ["Planes de alimentación", "Asesoría nutricional", "Seguimiento de hábitos"] },
      { category: "Bienestar", skills: ["Acondicionamiento físico", "Entrenamiento personal"] },
    ],
    experience: [
      {
        experienceType: "self_employment",
        title: "Asesora en nutrición",
        organization: null,
        startDate: "2025",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Elabora planes de alimentación personalizados y da seguimiento mensual.",
          "Acompaña a clientes del gimnasio en sus metas de acondicionamiento físico.",
        ],
      },
    ],
    education: [
      {
        institution: "Aprende Institute",
        credential: "Diplomado en Nutrición",
        fieldOfStudy: "Nutrición",
        startDate: "2024",
        endDate: "2025",
      },
    ],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "intermedio" },
    ],
  },
  {
    firstName: "Miguel",
    lastName: "Castillo",
    zip: "89101", // Las Vegas, NV
    targetRole: "Supervisor de limpieza",
    careerGoal: "Coordinar un equipo de limpieza en hotelería o en edificios de oficinas.",
    summary:
      "Nueve años de experiencia en limpieza y housekeeping en hotelería, incluyendo coordinación de turnos y control de insumos.",
    skillGroups: [
      { category: "Limpieza", skills: ["Housekeeping", "Limpieza profunda", "Manejo de químicos"] },
      { category: "Coordinación", skills: ["Coordinación de turnos", "Control de insumos"] },
    ],
    experience: [
      {
        experienceType: "formal_employment",
        title: "Encargado de housekeeping",
        organization: "Hotel Desert Palm",
        startDate: "2017",
        endDate: null,
        isCurrent: true,
        bullets: [
          "Coordina el turno de limpieza de 60 habitaciones con un equipo de seis personas.",
          "Controla el inventario de insumos de limpieza y hace los pedidos semanales.",
        ],
      },
    ],
    education: [
      {
        institution: "Preparatoria Técnica",
        credential: "Bachillerato",
        fieldOfStudy: null,
        startDate: null,
        endDate: "2014",
      },
    ],
    languages: [
      { name: "Español", level: "nativo" },
      { name: "Inglés", level: "intermedio" },
    ],
  },
];
