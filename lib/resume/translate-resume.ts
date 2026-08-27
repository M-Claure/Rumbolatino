/**
 * Translate a finished résumé into another language.
 *
 * This is a TRANSLATION, not a second generation. The model is shown the résumé
 * the person already approved — never the source data it was written from — so it
 * cannot introduce a fact the Spanish document does not make, and every
 * `entryId` and source trace survives untouched. That is the whole safety
 * argument: re-generating in English would produce new bullets that would need
 * re-tracing, and the two documents could quietly disagree about what the person
 * did.
 *
 * COST: one `effort: "none"` call over text that already exists, ~$0.017 on
 * gpt-5.3-codex. It runs once, when the user asks, and again only if they change
 * the Spanish résumé and ask again — see `docs/english-resume.md` for why this is
 * not done automatically after every improvement round.
 *
 * SAFETY: proper nouns are never sent. Employers, institutions, certifying
 * bodies and the person's own name are simply left out of the payload, which is a
 * stronger guarantee than instructing a model to leave them alone.
 */
import type {
  GeneratedBullet,
  GeneratedResume,
  PersonalInformation,
  ResumeLang,
  ResumeProfile,
  TranslatedResume,
} from "@/types";
import type { AIProvider } from "@/lib/ai";
import { Errors } from "@/lib/errors";
import type { Store } from "@/lib/repositories/store";
import { renderResumeHtml, type ResumeRenderModel } from "./resume-renderer";
import type { ResumeArtifactWriter } from "./resume-artifacts";

export interface TranslateResult {
  translation: TranslatedResume;
  /** The résumé version it was translated from — the caller's staleness check. */
  sourceVersion: number;
}

/** One translatable string, and where to put the answer back. */
interface Item {
  id: string;
  text: string;
}

const SUMMARY_ID = "summary";
const HEADLINE_ID = "headline";
const LOCATION_ID = "location";

/*
 * Ids are positional, exactly like the proofreader's. They are never persisted and
 * never leave the request, so they only have to be stable between building the
 * payload and applying the reply — which happens in one function below.
 */
const expId = (i: number, field: string) => `exp:${i}:${field}`;
const eduId = (i: number, field: string) => `edu:${i}:${field}`;
const skgId = (i: number, field: string) => `skg:${i}:${field}`;
const prjId = (i: number, field: string) => `prj:${i}:${field}`;
const crtId = (i: number, field: string) => `crt:${i}:${field}`;
const lngId = (i: number, field: string) => `lng:${i}:${field}`;
const intId = (i: number) => `int:${i}`;

export async function translateResume(
  store: Store,
  ai: AIProvider,
  profileId: string,
  targetLanguage: ResumeLang,
  /** See `generateResume` — same optional artifact seam, same reason. */
  artifacts?: ResumeArtifactWriter,
): Promise<TranslateResult> {
  if (targetLanguage === "es") {
    throw Errors.validation("El currículum ya está en español.");
  }

  const profile = await store.getResumeProfile(profileId);
  if (!profile) throw Errors.notFound("Perfil no encontrado");
  const resume = await store.getLatestGeneratedResume(profileId);
  if (!resume) {
    throw Errors.notReady("Genera tu currículum antes de traducirlo.");
  }
  const personal = await store.getPersonalInformation(profileId);

  // 1. Collect every translatable string with a stable id.
  const items = collectTranslatableItems(resume, profile, personal);
  if (items.length === 0) {
    throw Errors.notReady("No hay contenido para traducir.");
  }

  /*
   * 2. Translate.
   *
   * Unlike the proofreader, a failure here is FATAL and must be. Proofreading is a
   * cosmetic pass over a résumé the person can already download, so swallowing the
   * error and keeping the original text costs them nothing. A translation is the
   * entire thing they asked for — returning the Spanish résumé relabelled as
   * English would be worse than an error they can retry.
   */
  const { items: translated } = await ai.translateResume({ items, targetLanguage });

  // 3. Put the text back where it came from.
  const fixes = new Map(translated.map((t) => [t.id, t.text]));
  /*
   * An id the model dropped keeps its ORIGINAL text. That leaves one Spanish line
   * in an otherwise English résumé, which is a far better failure than a blank
   * bullet — and it is the same fallback the proofreader uses.
   */
  const at = (id: string, original: string): string => {
    const value = fixes.get(id);
    return value !== undefined && value.trim().length > 0 ? value : original;
  };
  const orNull = (id: string, original: string | null): string | null =>
    original === null || original.trim().length === 0 ? original : at(id, original);
  const bullet = (id: string, b: GeneratedBullet): GeneratedBullet => ({
    ...b, // keep sourceEntryIds + sourceFields exactly — the trace is language-neutral
    text: at(id, b.text),
  });

  const professionalSummary = at(SUMMARY_ID, resume.professionalSummary);
  const experience = resume.experience.map((e, i) => ({
    ...e, // organization is deliberately untouched — it was never sent
    title: orNull(expId(i, "title"), e.title),
    location: orNull(expId(i, "location"), e.location),
    startDate: orNull(expId(i, "start"), e.startDate),
    endDate: orNull(expId(i, "end"), e.endDate),
    bullets: e.bullets.map((b, j) => bullet(expId(i, `b:${j}`), b)),
  }));
  const education = resume.education.map((e, i) => ({
    ...e, // institution untouched
    credential: orNull(eduId(i, "credential"), e.credential),
    fieldOfStudy: orNull(eduId(i, "field"), e.fieldOfStudy),
    startDate: orNull(eduId(i, "start"), e.startDate),
    endDate: orNull(eduId(i, "end"), e.endDate),
    details: e.details.map((b, j) => bullet(eduId(i, `d:${j}`), b)),
  }));
  const skills = resume.skills.map((g, i) => ({
    ...g, // sourceSkillIds untouched
    category: at(skgId(i, "cat"), g.category),
    skills: g.skills.map((name, j) => at(skgId(i, `s:${j}`), name)),
  }));
  const projects = resume.projects.map((p, i) => ({
    ...p,
    name: at(prjId(i, "name"), p.name),
    bullets: p.bullets.map((b, j) => bullet(prjId(i, `b:${j}`), b)),
  }));
  const certifications = resume.certifications.map((c, i) => ({
    ...c, // issuingOrganization untouched
    name: at(crtId(i, "name"), c.name),
    issueDate: orNull(crtId(i, "date"), c.issueDate),
  }));
  const languages = resume.languages.map((l, i) => ({
    ...l,
    name: at(lngId(i, "name"), l.name),
    level: orNull(lngId(i, "level"), l.level),
  }));
  const interests = (profile.interests ?? []).map((v, i) => at(intId(i), v));
  const headline = orNull(HEADLINE_ID, profile.targetRole ?? profile.careerGoal);
  const location = orNull(LOCATION_ID, formatLocation(personal));

  // 4. Render in the target language and persist.
  const renderModel: ResumeRenderModel = {
    // The name and contact details are re-read untranslated: proper nouns, and an
    // email address translated is an email address broken.
    fullName: fullNameOf(personal, targetLanguage),
    headline,
    location,
    contact: {
      email: personal?.email ?? null,
      phone: personal?.phone ?? null,
      linkedIn: personal?.linkedInUrl ?? null,
      portfolio: personal?.portfolioUrl ?? null,
    },
    professionalSummary,
    skills,
    experience,
    education,
    certifications,
    projects,
    languages,
    interests,
  };
  const html = renderResumeHtml(renderModel, targetLanguage);

  const saved = await store.saveTranslatedResume(profileId, {
    language: targetLanguage,
    // Pinned to the résumé this was translated FROM, so a later regeneration makes
    // the translation visibly stale instead of silently wrong.
    sourceVersion: resume.version,
    professionalSummary,
    skills,
    experience,
    education,
    certifications,
    projects,
    languages,
    headline,
    location,
    interests,
    html,
  });

  const stored = artifacts ? await artifacts.onTranslationCreated(saved) : saved;
  return { translation: stored, sourceVersion: resume.version };
}

/**
 * Is the stored translation still a translation of the CURRENT résumé?
 *
 * Shared so the route, the download path and the UI all answer this the same way.
 * A stale translation is still served on request — it is what the person asked for
 * before they changed their résumé — but it is never silently refreshed, because
 * refreshing costs a model call nobody authorized.
 */
export function isTranslationCurrent(
  translation: Pick<TranslatedResume, "sourceVersion"> | null,
  resume: Pick<GeneratedResume, "version"> | null,
): boolean {
  if (!translation || !resume) return false;
  return translation.sourceVersion === resume.version;
}

/**
 * Everything the document prints that is Spanish PROSE, and nothing that is a
 * proper noun.
 *
 * Empty and whitespace-only strings are skipped: they render as nothing, and
 * sending them would spend tokens to translate the empty string. Organization,
 * institution, issuing body, the person's name and every contact field are
 * absent by design — see the file header.
 */
function collectTranslatableItems(
  resume: GeneratedResume,
  profile: ResumeProfile,
  personal: PersonalInformation | null,
): Item[] {
  const items: Item[] = [];
  const push = (id: string, text: string | null | undefined): void => {
    if (typeof text === "string" && text.trim().length > 0) items.push({ id, text });
  };

  push(SUMMARY_ID, resume.professionalSummary);
  push(HEADLINE_ID, profile.targetRole ?? profile.careerGoal);
  push(LOCATION_ID, formatLocation(personal));

  resume.experience.forEach((e, i) => {
    push(expId(i, "title"), e.title);
    push(expId(i, "location"), e.location);
    push(expId(i, "start"), e.startDate);
    push(expId(i, "end"), e.endDate);
    e.bullets.forEach((b, j) => push(expId(i, `b:${j}`), b.text));
  });
  resume.education.forEach((e, i) => {
    push(eduId(i, "credential"), e.credential);
    push(eduId(i, "field"), e.fieldOfStudy);
    push(eduId(i, "start"), e.startDate);
    push(eduId(i, "end"), e.endDate);
    e.details.forEach((b, j) => push(eduId(i, `d:${j}`), b.text));
  });
  resume.skills.forEach((g, i) => {
    push(skgId(i, "cat"), g.category);
    g.skills.forEach((name, j) => push(skgId(i, `s:${j}`), name));
  });
  resume.projects.forEach((p, i) => {
    push(prjId(i, "name"), p.name);
    p.bullets.forEach((b, j) => push(prjId(i, `b:${j}`), b.text));
  });
  resume.certifications.forEach((c, i) => {
    push(crtId(i, "name"), c.name);
    push(crtId(i, "date"), c.issueDate);
  });
  resume.languages.forEach((l, i) => {
    push(lngId(i, "name"), l.name);
    push(lngId(i, "level"), l.level);
  });
  (profile.interests ?? []).forEach((v, i) => push(intId(i), v));

  return items;
}

function formatLocation(personal: PersonalInformation | null): string | null {
  const parts = [personal?.city, personal?.state, personal?.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The same fallback `generateResume` and the proofreader use, in the document's
 * own language — an English résumé headed "Tu Nombre" reads as a bug.
 */
function fullNameOf(personal: PersonalInformation | null, lang: ResumeLang): string {
  const name = [personal?.firstName, personal?.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  return lang === "en" ? "Your Name" : "Tu Nombre";
}
