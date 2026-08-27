/**
 * Server-side HTML/CSS resume renderer. Produces a self-contained HTML document
 * (inline CSS, no external assets) suitable for preview and for PDF printing.
 * Styling mirrors the Pencil "Resume Preview" design.
 *
 * SECURITY: all dynamic strings are HTML-escaped — resume content comes from
 * user/AI text and must never be injected as markup.
 */
import { currentDateLabel } from "@/lib/experience-dates";
import { labelForType } from "@/lib/experience-types";
import type {
  GeneratedCertificationBlock,
  GeneratedEducationBlock,
  GeneratedExperienceBlock,
  GeneratedLanguageBlock,
  GeneratedProjectBlock,
  GeneratedSkillGroup,
  ResumeLang,
} from "@/types";

/**
 * Every fixed string the document prints, per language.
 *
 * These are the parts of the résumé the model never sees: the translation pass
 * sends the user's PROSE, not the furniture around it. Keeping the furniture in
 * code means an English résumé costs exactly one call over the prose — and means
 * a heading can never come back mistranslated or missing.
 *
 * `locale` drives `toLocale*Case`, which matters for more than politeness: the
 * Turkish-i class of bug aside, Spanish and English disagree on nothing here, but
 * hardcoding "es" while printing English text is the kind of thing that silently
 * stops being true when a third language is added.
 */
interface ResumeLabels {
  locale: string;
  documentKind: string;
  summary: string;
  experience: string;
  education: string;
  skills: string;
  projects: string;
  certifications: string;
  languages: string;
  interests: string;
  /** Heading fallback when an entry has no title/organization and no type. */
  experienceFallback: string;
  educationFallback: string;
}

const LABELS: Record<ResumeLang, ResumeLabels> = {
  es: {
    locale: "es",
    documentKind: "Currículum",
    summary: "Resumen profesional",
    experience: "Experiencia",
    education: "Educación",
    skills: "Habilidades",
    projects: "Proyectos",
    certifications: "Certificaciones",
    languages: "Idiomas",
    interests: "Intereses",
    experienceFallback: "Experiencia",
    educationFallback: "Educación",
  },
  en: {
    locale: "en",
    documentKind: "Resume",
    summary: "Professional Summary",
    experience: "Experience",
    education: "Education",
    skills: "Skills",
    projects: "Projects",
    certifications: "Certifications",
    languages: "Languages",
    interests: "Interests",
    experienceFallback: "Experience",
    educationFallback: "Education",
  },
};

export interface ResumeRenderModel {
  fullName: string;
  headline: string | null;
  location: string | null;
  contact: {
    email?: string | null;
    phone?: string | null;
    linkedIn?: string | null;
    portfolio?: string | null;
  };
  professionalSummary: string;
  skills: GeneratedSkillGroup[];
  experience: GeneratedExperienceBlock[];
  education: GeneratedEducationBlock[];
  certifications: GeneratedCertificationBlock[];
  projects: GeneratedProjectBlock[];
  languages: GeneratedLanguageBlock[];
  interests: string[];
}

export function renderResumeHtml(model: ResumeRenderModel, lang: ResumeLang = "es"): string {
  const t = LABELS[lang];
  const contactLine = [
    model.location,
    model.contact.email,
    model.contact.phone,
    model.contact.linkedIn,
    model.contact.portfolio,
  ]
    .filter(Boolean)
    .map((v) => esc(String(v)))
    .join(" &nbsp;·&nbsp; ");

  const sections: string[] = [];

  if (model.professionalSummary.trim()) {
    sections.push(section(t.summary, `<p class="summary">${esc(model.professionalSummary)}</p>`));
  }

  if (model.experience.length > 0) {
    sections.push(section(t.experience, model.experience.map((e) => renderExperience(e, lang)).join("")));
  }

  if (model.education.length > 0) {
    sections.push(section(t.education, model.education.map((e) => renderEducation(e, lang)).join("")));
  }

  if (model.skills.length > 0) {
    sections.push(section(t.skills, model.skills.map((g) => renderSkillGroup(g, lang)).join("")));
  }

  if (model.projects.length > 0) {
    sections.push(section(t.projects, model.projects.map(renderProject).join("")));
  }

  if (model.certifications.length > 0) {
    sections.push(section(t.certifications, model.certifications.map((c) => renderCertification(c, lang)).join("")));
  }

  if (model.languages.length > 0) {
    sections.push(section(t.languages, `<ul class="inline">${model.languages.map(renderLanguage).join("")}</ul>`));
  }

  if (model.interests.length > 0) {
    // One single line, comma-separated — interests are the least load-bearing
    // section on the page, so they get one line and no more. (A flex list of
    // chips wrapped onto three rows and pushed real content off the page.)
    sections.push(
      section(t.interests, `<p class="one-line">${model.interests.map((i) => esc(i)).join(", ")}</p>`),
    );
  }

  return `<!doctype html>
<html lang="${t.locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(model.fullName)} — ${esc(t.documentKind)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="resume">
  <header class="head">
    <h1>${esc(model.fullName)}</h1>
    ${model.headline ? `<p class="headline">${esc(model.headline)}</p>` : ""}
    ${contactLine ? `<p class="contact">${contactLine}</p>` : ""}
  </header>
  ${sections.join("\n")}
</main>
</body>
</html>`;
}

// ── Block renderers ──
function renderExperience(e: GeneratedExperienceBlock, lang: ResumeLang): string {
  const heading = [e.title, e.organization].filter(Boolean).map((v) => esc(String(v))).join(" — ");
  /*
   * Most people this product serves have neither a job title nor an employer for
   * their most valuable experience — caregiving, helping at a family business,
   * volunteering. Heading those "Experiencia" produced a résumé that said
   * "Experiencia" four times over and told a reader nothing, so the experience
   * TYPE they chose is the fallback: "Cuidado de personas", "Trabajo informal".
   */
  const fallback = e.experienceType
    ? capitalizeFirst(labelForType(e.experienceType, lang), lang)
    : LABELS[lang].experienceFallback;
  return `<article class="entry">
    <div class="entry-head">
      <span class="entry-title">${heading || esc(fallback)}</span>
      <span class="entry-dates">${esc(dateRange(e.startDate, e.endDate, e.isCurrent, lang))}</span>
    </div>
    ${e.location ? `<div class="entry-sub">${esc(e.location)}</div>` : ""}
    ${bullets(e.bullets.map((b) => b.text))}
  </article>`;
}

function renderEducation(e: GeneratedEducationBlock, lang: ResumeLang): string {
  const headingText = [e.credential, e.fieldOfStudy].filter(Boolean).join(" — ");
  const heading = headingText ? esc(headingText) : esc(e.institution ?? LABELS[lang].educationFallback);
  /*
   * Drop a detail line that only repeats what the heading already says. Both
   * providers do this — the deterministic one builds its detail from exactly
   * `credential — fieldOfStudy` — and it renders as the same words twice, wasting a
   * line on a page that is budgeted to fit.
   */
  const locale = LABELS[lang].locale;
  const same = (a: string, b: string) =>
    a.trim().toLocaleLowerCase(locale) === b.trim().toLocaleLowerCase(locale);
  const details = e.details
    .map((b) => b.text)
    .filter((t) => !same(t, headingText) && !same(t, e.credential ?? "") && !same(t, e.institution ?? ""));
  return `<article class="entry">
    <div class="entry-head">
      <span class="entry-title">${heading}</span>
      <span class="entry-dates">${esc(dateRange(e.startDate, e.endDate, e.isCurrent, lang))}</span>
    </div>
    ${e.institution ? `<div class="entry-sub">${esc(e.institution)}</div>` : ""}
    ${bullets(details)}
  </article>`;
}

function renderProject(p: GeneratedProjectBlock): string {
  return `<article class="entry">
    <div class="entry-head"><span class="entry-title">${esc(p.name)}</span></div>
    ${bullets(p.bullets.map((b) => b.text))}
  </article>`;
}

function renderSkillGroup(g: GeneratedSkillGroup, lang: ResumeLang): string {
  return `<div class="skill-group">
    <span class="skill-cat">${esc(capitalizeFirst(g.category, lang))}:</span>
    <span class="skill-list">${g.skills.map((s) => esc(s)).join(", ")}</span>
  </div>`;
}

function renderCertification(c: GeneratedCertificationBlock, lang: ResumeLang): string {
  const meta = [c.issuingOrganization, capitalizeFirst(c.issueDate ?? "", lang)]
    .filter(Boolean)
    .map((v) => esc(String(v)))
    .join(" · ");
  return `<div class="cert"><span class="cert-name">${esc(c.name)}</span>${meta ? ` <span class="cert-meta">${meta}</span>` : ""}</div>`;
}

function renderLanguage(l: GeneratedLanguageBlock): string {
  return `<li>${esc(l.name)}${l.level ? ` <span class="lang-level">(${esc(l.level)})</span>` : ""}</li>`;
}

// ── helpers ──
function section(title: string, body: string): string {
  return `<section class="section"><h2>${esc(title)}</h2>${body}</section>`;
}

function bullets(items: string[]): string {
  const clean = items.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  return `<ul>${clean.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
}

/**
 * Renders a date range, capitalizing each side.
 *
 * Dates are stored as the person wrote them ("marzo 2020", "de 2015 a 2017"), so
 * without this the date column reads lowercase — "de 2015 a 2017" — next to a page
 * where every other line starts capitalized. Only the first letter of each segment
 * is touched: that capitalizes the month picked in Review ("marzo 2020" →
 * "Marzo 2020") while leaving a month mid-phrase lowercase, which is how Spanish
 * writes it anyway ("De marzo 2020 a la actualidad").
 *
 * Deliberately NOT reformatted into a canonical shape: one field can hold a whole
 * range, and re-rendering "de 2015 a 2017" from a parsed value would silently drop
 * the 2017.
 */
function dateRange(
  start: string | null,
  end: string | null,
  isCurrent: boolean,
  lang: ResumeLang = "es",
): string {
  const startText = capitalizeFirst(start?.trim() ?? "", lang);
  const endText = isCurrent ? currentDateLabel(lang) : capitalizeFirst(end?.trim() ?? "", lang);
  if (startText && endText) return `${startText} – ${endText}`;
  return endText || startText;
}

/**
 * Sentence-cases a label for display: "general" → "General".
 *
 * Skill categories arrive from three places — the model's grouping, a skill's own
 * stored category, and the "general" default for skills someone typed in — and any
 * of them can be lowercase. Capitalizing at RENDER covers all three, including
 * rows already saved, rather than chasing each writer. Only the first letter is
 * touched: Spanish uses sentence case, so "atención al cliente" must not become
 * "Atención Al Cliente".
 */
export function capitalizeFirst(value: string, lang: ResumeLang = "es"): string {
  const text = value.trim();
  if (text.length === 0) return text;
  return text.charAt(0).toLocaleUpperCase(LABELS[lang].locale) + text.slice(1);
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
/* Black-and-white résumé. Hierarchy comes from weight, size, letter-spacing and
   rule width instead of colour, so it prints identically on any printer, survives
   photocopying and faxing, and never burns colour ink. --muted is a true grey,
   kept dark enough (7.5:1 on white) to stay legible in a scanned copy. */
:root { --accent:#000000; --ink:#000000; --muted:#4A4A4A; --line:#B8B8B8; }
* { box-sizing: border-box; }
body { margin:0; background:#F2F2F2; color:var(--ink); font-family:'Source Sans 3','Source Sans Pro',Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
/* The preview sheet mirrors the printed page, so what you see is what prints.
   pdf-generator renders A4 with 14mm side and 16mm top/bottom margins; at 96dpi
   that is a 800×1131px sheet with 56px/60px padding. A résumé that runs past the
   bottom edge of this sheet is one that spills onto a second page — which is the
   only way to SEE the one-page budget the generation prompt asks the model for. */
.resume { width:800px; max-width:100%; min-height:1131px; margin:0 auto; background:#fff; padding:60px 56px; box-shadow:0 1px 4px rgba(0,0,0,0.18); }
.head { border-bottom:2px solid var(--accent); padding-bottom:16px; margin-bottom:20px; }
.head h1 { margin:0; font-size:28px; font-weight:700; letter-spacing:-0.01em; }
.headline { margin:4px 0 0; font-size:15px; color:var(--accent); font-weight:600; }
.contact { margin:8px 0 0; font-size:12px; color:var(--muted); }
/* Vertical rhythm is deliberately tight: every millimetre saved between sections
   is a bullet the model does not have to cut to stay on one page. */
.section { margin-bottom:18px; }
.section h2 { font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--line); padding-bottom:4px; margin:0 0 8px; }
.summary { margin:0; font-size:13.5px; line-height:1.55; }
.entry { margin-bottom:11px; }
.entry-head { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
.entry-title { font-weight:600; font-size:14px; }
.entry-dates { font-size:12px; color:var(--muted); white-space:nowrap; }
.entry-sub { font-size:12.5px; color:var(--muted); margin-top:2px; }
.entry ul, .section > ul { margin:6px 0 0; padding-left:18px; }
.entry li, .section li { font-size:13px; line-height:1.5; margin-bottom:3px; }
.skill-group { font-size:13px; margin-bottom:5px; }
.skill-cat { font-weight:600; }
.cert { font-size:13px; margin-bottom:4px; }
.cert-name { font-weight:600; }
.cert-meta, .lang-level { color:var(--muted); }
ul.inline { list-style:none; padding:0; margin:0; display:flex; flex-wrap:wrap; gap:6px 18px; }
ul.inline li { font-size:13px; }
/* Intereses: one comma-separated line, not a wrapping grid of chips. */
.one-line { margin:0; font-size:13px; line-height:1.5; }
@media print {
  body { background:#fff; }
  /* Page size and margins come from pdf-generator's puppeteer options — the sheet
     simulation above must not add a second set on top of them. */
  .resume { width:auto; max-width:none; min-height:0; padding:0; box-shadow:none; }
  /* If it does spill despite the budget, break between entries, never inside one. */
  .entry, .skill-group, .cert { break-inside:avoid; page-break-inside:avoid; }
}`;
