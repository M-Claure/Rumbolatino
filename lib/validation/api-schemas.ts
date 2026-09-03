/**
 * Zod schemas for API request bodies. Every route validates its input with one
 * of these before touching a service — malformed requests become a consistent
 * 422 validation_error (see lib/http.ts).
 */
import { z } from "zod";
import {
  CONTACT_FIELD_CHAR_LIMITS,
  ENTRY_TEXT_CHAR_LIMIT,
  LIST_ITEM_CHAR_LIMIT,
  LIST_MAX_ITEMS,
  REVIEW_FIELD_CHAR_LIMITS as R,
  answerCharLimitForQuestion,
  tooLongMessage,
} from "@/lib/answer-limits";
import { isEmail, isPhone } from "@/lib/personal-contact";
import {
  EXPERIENCE_TYPES,
  LANGUAGE_LEVELS,
  PROFICIENCY_LEVELS,
  PROJECT_TYPES,
  RESUME_SECTIONS,
} from "@/types/domain";
import { TALENT_AVAILABILITIES, TALENT_CATEGORY_IDS } from "@/types/talent";

const section = z.enum(RESUME_SECTIONS);
const nonEmpty = z.string().trim().min(1);
// Narrative entry text and bullet lists are bounded for the same reason answers
// are: every generation/analysis/proofread prompt re-sends them. See
// lib/answer-limits.ts.
const optStr = z.string().trim().max(ENTRY_TEXT_CHAR_LIMIT).optional();
const strArray = z
  .array(z.string().trim().min(1).max(LIST_ITEM_CHAR_LIMIT))
  .max(LIST_MAX_ITEMS);

export const CreateProfileBody = z
  .object({
    targetRole: z.string().trim().max(200).optional(),
    careerGoal: z.string().trim().max(500).optional(),
    location: z.string().trim().max(200).optional(),
    // Name + at least one contact channel are REQUIRED to start the builder, so a
    // profile is never persisted for someone we have no way to reach. Enforced
    // here rather than only in the UI: the route cannot reach a write without it.
    // Lengths match CONTACT_FIELD_CHAR_LIMITS, which the form counts against.
    fullName: z
      .string()
      .trim()
      .min(1, { message: "Escribe tu nombre" })
      .max(CONTACT_FIELD_CHAR_LIMITS.fullName),
    // Asked as two separate fields, so each is validated whole instead of being
    // guessed out of one combined string. Either one alone is enough.
    email: z.string().trim().max(CONTACT_FIELD_CHAR_LIMITS.email).optional(),
    phone: z.string().trim().max(CONTACT_FIELD_CHAR_LIMITS.phone).optional(),
    // Terms & conditions consent is REQUIRED to start the builder — enforced here
    // (not just in the UI) so a profile can never be created without acceptance.
    acceptTerms: z.literal(true, {
      errorMap: () => ({ message: "Debes aceptar los términos y condiciones para continuar" }),
    }),
  })
  .superRefine((body, ctx) => {
    // `.trim()` already normalised these; "" means the field was left blank.
    const email = body.email ?? "";
    const phone = body.phone ?? "";

    if (!email && !phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "Escribe tu correo electrónico o tu teléfono. Con uno de los dos basta",
      });
      return;
    }
    if (email && !isEmail(email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "Escribe un correo electrónico válido, por ejemplo maria@correo.com",
      });
    }
    if (phone && !isPhone(phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "Escribe un teléfono válido, por ejemplo 555 123 4567",
      });
    }
  });

export const PatchProfileBody = z.object({
  targetRole: z.string().trim().max(200).nullable().optional(),
  careerGoal: z.string().trim().max(500).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
});

const SkillEditBody = z.object({
  id: nonEmpty,
  name: z.string().trim().max(80).optional(),
  category: z.string().trim().max(60).optional(),
  proficiency: z.enum(PROFICIENCY_LEVELS).nullable().optional(),
});

export const AnswerBody = z
  .object({
    questionId: nonEmpty.max(120),
    section,
    // Hard ceiling only; the real per-question limit is applied in superRefine
    // below, resolved from the catalog. Kept generous here so an over-limit
    // answer produces the specific "muy larga" message rather than this one.
    rawAnswer: z.string().max(5000).optional(),
    skipped: z.boolean().optional().default(false),
    skillDecisions: z
      .object({
        confirm: z.array(nonEmpty).max(100).optional(),
        reject: z.array(nonEmpty).max(100).optional(),
        edit: z.array(SkillEditBody).max(100).optional(),
      })
      .optional(),
    timeSpentMs: z.number().int().nonnegative().max(86_400_000).optional(),
    deviceCategory: z.enum(["mobile", "tablet", "desktop"]).optional(),
    // Overwrite this existing entry instead of creating a new one (back-edit).
    targetEntryId: z.string().max(120).optional(),
    // Create a new entry rather than filling one still awaiting a description
    // ("Agregar otra experiencia"). The cap is still enforced server-side.
    forceNewEntry: z.boolean().optional(),
  })
  .refine((b) => b.skipped || b.rawAnswer !== undefined || b.skillDecisions !== undefined, {
    message: "Se requiere una respuesta, decisiones de habilidades, o skipped=true",
  })
  .superRefine((b, ctx) => {
    // Bound what reaches the model. The limit comes from the catalog entry for
    // this questionId — never from the request — so a crafted body cannot raise
    // its own ceiling. See lib/answer-limits.ts for the cost rationale.
    if (b.rawAnswer === undefined) return;
    const limit = answerCharLimitForQuestion(b.questionId);
    if (b.rawAnswer.trim().length > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rawAnswer"],
        message: tooLongMessage(limit),
      });
    }
  });

export const CreateEducationBody = z.object({
  institution: z.string().trim().max(R.institution).optional(),
  credential: z.string().trim().max(R.credential).optional(),
  fieldOfStudy: z.string().trim().max(R.fieldOfStudy).optional(),
  location: z.string().trim().max(R.location).optional(),
  startDate: z.string().trim().max(R.date).optional(),
  endDate: z.string().trim().max(R.date).optional(),
  isCurrent: z.boolean().optional(),
  relevantCoursework: strArray.optional(),
  achievements: strArray.optional(),
});
export const UpdateEducationBody = CreateEducationBody.extend({
  confirmationStatus: z.enum(["confirmed", "needs_review", "edited", "rejected"]).optional(),
});

export const CreateExperienceBody = z.object({
  experienceType: z.enum(EXPERIENCE_TYPES),
  title: z.string().trim().max(R.title).optional(),
  organization: z.string().trim().max(R.organization).optional(),
  location: z.string().trim().max(R.location).optional(),
  startDate: z.string().trim().max(R.date).optional(),
  endDate: z.string().trim().max(R.date).optional(),
  isCurrent: z.boolean().optional(),
  rawDescription: optStr,
  responsibilities: strArray.optional(),
  accomplishments: strArray.optional(),
  tools: strArray.optional(),
  peopleServed: z.string().trim().max(R.peopleServed).optional(),
  metrics: strArray.optional(),
});
export const UpdateExperienceBody = CreateExperienceBody.partial().extend({
  confirmationStatus: z.enum(["confirmed", "needs_review", "edited", "rejected"]).optional(),
});

export const CreateSkillBody = z.object({
  name: nonEmpty.max(80),
  category: z.string().trim().max(60).optional(),
  proficiency: z.enum(PROFICIENCY_LEVELS).nullable().optional(),
});
export const EditSkillBody = z.object({
  name: z.string().trim().max(80).optional(),
  category: z.string().trim().max(60).optional(),
  proficiency: z.enum(PROFICIENCY_LEVELS).nullable().optional(),
});

/*
 * ── The four sections the funnel captures but nothing used to edit ────────────
 *
 * Projects, certifications, languages and achievements were WRITE-ONLY: the funnel
 * asked about each of them, the résumé printed them, `Store` had full CRUD — and no
 * route exposed any of it. A person who mis-answered "¿qué idiomas hablas?" could
 * neither correct nor remove the answer, and it still reached the PDF.
 *
 * The `Update*` bodies below back `PATCH /api/{projects,certifications,languages,
 * achievements}/:id`. There is deliberately no `POST`: creating an entry from the
 * Review screen means creating a BLANK one, which needs a blankness predicate plus
 * completeness/readiness handling per shape (see `lib/entry-blankness.ts`) — a
 * larger change than closing the "typed it, cannot fix it" hole. These sections are
 * still created by the funnel and the improvement loop.
 *
 * Bounds route through `REVIEW_FIELD_CHAR_LIMITS`, so the counter the Review screen
 * draws under each field is the number the API enforces (pinned by
 * tests/unit/review-field-limits.test.ts).
 */
export const CreateLanguageBody = z.object({
  name: nonEmpty.max(R.languageName),
  speakingLevel: z.enum(LANGUAGE_LEVELS).nullable().optional(),
  readingLevel: z.enum(LANGUAGE_LEVELS).nullable().optional(),
  writingLevel: z.enum(LANGUAGE_LEVELS).nullable().optional(),
});
/**
 * `includeOnResume` is the only thing that decides whether a language prints
 * (`resume-generator.ts` filters on it — languages have no confirmationStatus), so
 * it is editable: that checkbox is how someone keeps a language on file but off the
 * page.
 */
export const UpdateLanguageBody = CreateLanguageBody.partial().extend({
  includeOnResume: z.boolean().optional(),
});

export const CreateProjectBody = z.object({
  name: nonEmpty.max(R.entryName),
  projectType: z.enum(PROJECT_TYPES).nullable().optional(),
  organization: z.string().trim().max(R.organization).optional(),
  description: optStr,
  responsibilities: strArray.optional(),
  outcomes: strArray.optional(),
  tools: strArray.optional(),
});
export const UpdateProjectBody = CreateProjectBody.partial().extend({
  confirmationStatus: z.enum(["confirmed", "needs_review", "edited", "rejected"]).optional(),
});

/**
 * Certifications and achievements have no `Create` body: nothing creates one over
 * HTTP, and a schema with no caller is a promise nobody keeps.
 *
 * `expirationDate` and the credential id/url are absent for the same reason — the
 * pipeline never writes them and the renderer never prints them, so a field for
 * them would be a box that changes nothing.
 */
export const UpdateCertificationBody = z.object({
  name: nonEmpty.max(R.entryName).optional(),
  issuingOrganization: z.string().trim().max(R.organization).optional(),
  issueDate: z.string().trim().max(R.date).optional(),
  confirmationStatus: z.enum(["confirmed", "needs_review", "edited", "rejected"]).optional(),
});

export const UpdateAchievementBody = z.object({
  title: nonEmpty.max(R.entryName).optional(),
  organization: z.string().trim().max(R.organization).optional(),
  date: z.string().trim().max(R.date).optional(),
  description: optStr,
  confirmationStatus: z.enum(["confirmed", "needs_review", "edited", "rejected"]).optional(),
});

export const PatchPersonalInfoBody = z.object({
  firstName: z.string().trim().max(R.firstName).nullable().optional(),
  lastName: z.string().trim().max(R.lastName).nullable().optional(),
  // Sending this RE-DERIVES city, state and the coordinates from the postal
  // table, so those three can never drift out of agreement with the ZIP.
  postalCode: z.string().trim().max(R.postalCode).nullable().optional(),
  city: z.string().trim().max(R.city).nullable().optional(),
  state: z.string().trim().max(R.state).nullable().optional(),
  country: z.string().trim().max(R.country).nullable().optional(),
  phone: z.string().trim().max(R.phone).nullable().optional(),
  email: z.string().trim().max(R.email).nullable().optional(),
  linkedInUrl: z.string().trim().max(R.linkedInUrl).nullable().optional(),
  portfolioUrl: z.string().trim().max(R.portfolioUrl).nullable().optional(),
});

export const AddSkillsBody = z.object({
  names: z.array(nonEmpty.max(R.skillName)).min(1).max(30),
});

export const SetInterestsBody = z.object({
  interests: z.array(z.string().trim().min(1).max(R.interest)).max(30),
});

/** Free-text interests answer → the server extracts genuine interests (ignoring
 * negations) and appends them to the profile. */
export const ExtractInterestsBody = z.object({
  rawAnswer: z.string().trim().max(2000),
});

export const EnrichEntryBody = z.object({
  entryType: z.enum(["experience", "project"]),
  entryId: nonEmpty.max(120),
  rawAnswer: nonEmpty.max(5000),
});

export const RegenerateSectionBody = z.object({
  section: z.enum(["professional_summary", "experience", "education", "projects", "skills"]),
});

export type AnswerBodyInput = z.infer<typeof AnswerBody>;

/**
 * One improvement-round question/answer. `question` is the text the user was
 * shown, which only the client has — the analyzer's output is not persisted.
 */
export const RecordIterationAnswerBody = z.object({
  questionId: z.string().min(1).max(120),
  question: z.string().min(1).max(2000),
  answer: z.string().max(8000).nullish(),
});


/**
 * Publishing a profile to the talent directory.
 *
 * TWO fields: the consent, and when the person can start.
 *
 * Which trade the listing is filed under and how much experience it shows are
 * still DERIVED server-side from the résumé they just finished — nobody is asked
 * those, because the résumé already answers them. Availability is the one thing
 * no résumé contains, so it is the one thing worth a question. It used to be
 * stamped `flexible` server-side to satisfy a not-null column, which meant the
 * profile page told employers when someone could start on the strength of a
 * placeholder.
 *
 * `acceptPublishTerms` is `literal(true)` for the same reason
 * `CreateProfileBody.acceptTerms` is: the route cannot reach a write without it,
 * so consent is structural rather than a check somebody might skip. It is a
 * SEPARATE consent from the one given at sign-up — that covered building a
 * private résumé, this covers publishing one. See `PUBLISH_TERMS_VERSION`.
 */
export const PublishTalentBody = z.object({
  acceptPublishTerms: z.literal(true, {
    errorMap: () => ({
      message: "Marca la casilla para publicar tu perfil",
    }),
  }),
  /**
   * Required, with no default. A default here would be the old bug wearing a
   * different hat: the server would once again be choosing an answer on the
   * person's behalf and publishing it as theirs. A request that cannot say when
   * somebody can start is refused, and the popup will not let one be sent.
   */
  availability: z.enum(TALENT_AVAILABILITIES, {
    errorMap: () => ({ message: "Elige cuándo podrías empezar a trabajar" }),
  }),
});


/**
 * An empty query-string value means "not provided", never "match the empty
 * string".
 *
 * ── This is not a nicety; it is the fix for a silent, total search failure ───
 * An HTML GET form has no way to omit a control. `<option value="">Todas</option>`
 * and a blank `<input>` both submit `key=`, so EVERY default search from
 * `TalentFilters` arrived carrying `category=`. Zod's `.optional()` accepts only
 * `undefined`, so the whole object failed to parse — and `/empleadores` then fell
 * back to an empty filter set, discarding the search text along with it and
 * rendering the entire directory.
 *
 * The result was the worst shape a search bug can take: it never errored and it
 * never came back empty. Typing a name nobody has returned everybody, so the
 * "no encontramos a nadie" state below was unreachable in practice. `z.coerce`
 * hid a second copy of the same bug — `Number("")` is `0`, which then failed
 * `radius`'s `.min(1)`.
 *
 * Applied per field rather than to the object so a value that is genuinely
 * invalid (`limit=999`, `category=medicina`) still fails loudly and still gives
 * `/api/talent/search` its 422.
 */
function blankAsAbsent<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema,
  );
}

/**
 * Directory search parameters, parsed from the query string.
 *
 * The allow-list here is the whole filter surface, and it is short by design —
 * see `ALLOWED_FILTER_KEYS` in `lib/talent/taxonomy.ts` for why no filter may
 * proxy for a protected class. Anything not named here is ignored rather than
 * passed through.
 *
 * `limit` is capped at 60 to match `least(coalesce(p_limit, 24), 60)` inside
 * `talent_search`. The database enforces it regardless; repeating it here just
 * turns an over-large request into a clear 422 instead of a silent truncation.
 */
export const TalentSearchQuery = z.object({
  /**
   * A person's NAME, and only that. Since `0014` the free-text box no longer
   * matches the résumé document (`search_tsv`); a trade is searched through
   * `category`, a closed list derived from the résumé. The parameter keeps its
   * generic name because employers may have the URL bookmarked — see
   * `mcv_talent_name_query` for the matching rules and `nameSearchTokens` for
   * their TypeScript mirror. A value whose every token is under two characters
   * matches nobody, which is not the same as an absent one.
   */
  query: blankAsAbsent(z.string().trim().max(120).optional()),
  category: blankAsAbsent(z.enum(TALENT_CATEGORY_IDS).optional()),
  availability: blankAsAbsent(z.enum(TALENT_AVAILABILITIES).optional()),
  /**
   * The employer types a ZIP, not coordinates. It is resolved to a point
   * server-side (`lib/geo/zip-lookup.ts`), which keeps the URL shareable and
   * readable — `?zip=77002&radius=25` says what it does, a lat/lng pair does not.
   */
  zip: blankAsAbsent(z.string().trim().max(10).optional()),
  radius: blankAsAbsent(z.coerce.number().min(1).max(500).optional()),
  /**
   * A metro area: either a CBSA code (`26420`, which is what the autocomplete
   * submits and what a shared URL carries) or the words a person typed
   * (`Houston`). Resolved server-side against the closed list of ~930 OMB metro
   * titles by `resolveMetroQuery` — this is picking a row from a fixed table,
   * not free-text search over anything.
   *
   * It accepts text as well as a code so the filter bar keeps working with no
   * JavaScript: the combobox needs hydration to fill the code, and the rest of
   * that form is a plain GET on purpose. `max(120)` because the longest real
   * title is around eighty characters.
   */
  metro: blankAsAbsent(z.string().trim().max(120).optional()),
  limit: blankAsAbsent(z.coerce.number().int().min(1).max(60).optional()),
  offset: blankAsAbsent(z.coerce.number().int().min(0).max(5000).optional()),
});

/** The parsed filter set, as `/empleadores` and `/api/talent/search` both see it. */
export type TalentSearchParams = z.infer<typeof TalentSearchQuery>;

/**
 * The metro autocomplete's only parameter.
 *
 * A blank or one-character `q` is VALID and yields no suggestions, rather than a
 * 400: the combobox fires while somebody is still typing, and rejecting the
 * first keystroke would fill their console with errors during normal use.
 */
export const MetroQuery = z.object({
  q: blankAsAbsent(z.string().trim().max(120).optional()),
});

/**
 * Who is asking to see a contact.
 *
 * Symmetric with `CreateProfileBody`: the job seeker gives us a name and a way
 * to reach them before we build their résumé, and an employer gives us the same
 * before we hand over anyone's phone number. Still no password and no account —
 * this is identification, not authentication, and it exists so that every reveal
 * in `contact_reveals` has a name attached to it.
 */
export const CreateEmployerBody = z.object({
  company: z.string().trim().min(1, { message: "Escribe el nombre de tu empresa" }).max(120),
  contactName: z.string().trim().min(1, { message: "Escribe tu nombre" }).max(120),
  email: z
    .string()
    .trim()
    .max(160)
    .refine(isEmail, { message: "Escribe un correo electrónico válido" }),
});

/**
 * ── Employer accounts ───────────────────────────────────────────────────────
 * Shape only. The RULES about which addresses and passwords are acceptable live
 * in `lib/employers/policy.ts`, where each one is written next to its reasoning
 * and unit-tested; duplicating them as Zod refinements would give two places to
 * change and two different Spanish messages for the same rejection.
 *
 * The password is NOT trimmed. A leading or trailing space is a legitimate
 * character in a passphrase, and silently removing it at sign-up while a
 * password manager sends it verbatim at sign-in locks the account.
 */
export const EmployerSignUpBody = z.object({
  company: z.string().trim().min(1, { message: "Escribe el nombre de tu empresa" }).max(120),
  contactName: z.string().trim().min(1, { message: "Escribe tu nombre" }).max(120),
  email: z.string().trim().min(1, { message: "Escribe tu correo" }).max(160),
  password: z.string().min(1, { message: "Escribe una contraseña" }).max(200),
});

export const EmployerSignInBody = z.object({
  email: z.string().trim().min(1, { message: "Escribe tu correo" }).max(160),
  password: z.string().min(1, { message: "Escribe tu contraseña" }).max(200),
});

/** Resend verification, and request a password reset: both just take an address. */
export const EmployerEmailBody = z.object({
  email: z.string().trim().min(1, { message: "Escribe tu correo" }).max(160),
});

export const EmployerNewPasswordBody = z.object({
  password: z.string().min(1, { message: "Escribe una contraseña" }).max(200),
});
