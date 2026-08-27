/**
 * Rendering rules for the generated résumé: interests on one line, sentence-cased
 * skill categories, dates shown per experience, and a sheet that matches the
 * printed page so a one-page overflow is visible.
 */
import { describe, expect, it } from "vitest";
import { capitalizeFirst, renderResumeHtml, type ResumeRenderModel } from "@/lib/resume/resume-renderer";
import { buildSkillGroups } from "@/lib/resume/source-tracing";
import { skillState } from "../helpers/factories";
import type { ExperienceType } from "@/types";

function model(overrides: Partial<ResumeRenderModel> = {}): ResumeRenderModel {
  return {
    fullName: "María García",
    headline: "Asistente administrativa",
    location: "Lima",
    contact: { email: "maria@example.com", phone: null, linkedIn: null, portfolio: null },
    professionalSummary: "Profesional organizada y confiable.",
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    projects: [],
    languages: [],
    interests: [],
    ...overrides,
  };
}

describe("intereses render on one line", () => {
  it("joins them with commas in a single paragraph", () => {
    const html = renderResumeHtml(model({ interests: ["Fútbol", "Cocina", "Lectura"] }));
    expect(html).toContain('<p class="one-line">Fútbol, Cocina, Lectura</p>');
  });

  it("does not use the wrapping chip list any more", () => {
    const html = renderResumeHtml(model({ interests: ["Fútbol", "Cocina"] }));
    const interestsSection = html.slice(html.indexOf("Intereses"));
    expect(interestsSection).not.toContain('<ul class="inline">');
  });

  it("still escapes interest text", () => {
    const html = renderResumeHtml(model({ interests: ['Cocina <script>alert("x")</script>'] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the section entirely when there are none", () => {
    // Match the heading markup, not the bare word — the stylesheet mentions it too.
    expect(renderResumeHtml(model({ interests: [] }))).not.toContain("<h2>Intereses</h2>");
    expect(renderResumeHtml(model({ interests: ["Fútbol"] }))).toContain("<h2>Intereses</h2>");
  });
});

describe("skill categories are sentence-cased", () => {
  it("renders a lowercase 'general' category as 'General'", () => {
    const html = renderResumeHtml(
      model({ skills: [{ category: "general", skills: ["Trabajo en equipo"], sourceSkillIds: ["sk1"] }] }),
    );
    expect(html).toContain("General:");
    expect(html).not.toContain("general:");
  });

  it("capitalizes only the first letter, keeping Spanish sentence case", () => {
    expect(capitalizeFirst("atención al cliente")).toBe("Atención al cliente");
    expect(capitalizeFirst("general")).toBe("General");
    // Already-capitalized and accented input is left alone.
    expect(capitalizeFirst("Ó rgano")).toBe("Ó rgano");
    expect(capitalizeFirst("")).toBe("");
  });

  it("does not split one category into two groups over casing", () => {
    // "general" from an older row and "General" from a new one must merge, or the
    // résumé shows two groups that both render as "General:".
    const groups = buildSkillGroups(
      [],
      [
        skillState({ id: "sk1", name: "Puntualidad", category: "general", status: "confirmed" }),
        skillState({ id: "sk2", name: "Trabajo en equipo", category: "General", status: "confirmed" }),
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.skills).toEqual(["Puntualidad", "Trabajo en equipo"]);
  });
});

describe("an experience with no title or employer still reads as something", () => {
  const bare = (entryId: string, experienceType: ExperienceType) => ({
    entryId,
    title: null,
    organization: null,
    location: null,
    startDate: "2020",
    endDate: "2022",
    isCurrent: false,
    experienceType,
    bullets: [{ text: "Hice cosas", sourceEntryIds: [entryId], sourceFields: ["responsibilities"] }],
  });

  it("heads the entry with the experience type instead of the word 'Experiencia'", () => {
    // Caregiving and helping at a family business have no job title and no employer,
    // and four entries headed "Experiencia" told the reader nothing.
    const html = renderResumeHtml(
      model({ experience: [bare("e1", "caregiving"), bare("e2", "informal_work"), bare("e3", "volunteering")] }),
    );
    expect(html).toContain("Cuidado de personas");
    expect(html).toContain("Trabajo informal");
    expect(html).toContain("Voluntariado");
    // The bare fallback as an ENTRY title — the section heading is legitimately
    // "Experiencia", so match the entry markup rather than the word.
    expect(html).not.toContain('<span class="entry-title">Experiencia</span>');
  });

  it("still prefers a real title or employer when there is one", () => {
    const html = renderResumeHtml(
      model({ experience: [{ ...bare("e1", "caregiving"), title: "Cuidadora", organization: "Familia" }] }),
    );
    expect(html).toContain("Cuidadora — Familia");
    expect(html).not.toContain("Cuidado de personas");
  });

  it("falls back to 'Experiencia' only for a résumé stored before types were carried", () => {
    const { experienceType, ...legacy } = bare("e1", "caregiving");
    void experienceType;
    expect(renderResumeHtml(model({ experience: [legacy] }))).toContain(
      '<span class="entry-title">Experiencia</span>',
    );
  });
});

describe("education does not repeat itself", () => {
  const entry = (details: string[]) => ({
    entryId: "ed1",
    institution: "Colegio Nacional",
    credential: "Secundaria",
    fieldOfStudy: null,
    startDate: null,
    endDate: "2014",
    isCurrent: false,
    details: details.map((text) => ({ text, sourceEntryIds: ["ed1"], sourceFields: ["credential"] })),
  });

  it("drops a detail line that only restates the heading", () => {
    const html = renderResumeHtml(model({ education: [entry(["Secundaria"])] }));
    // "Secundaria" appears once, as the heading — not again as a bullet.
    expect(html.match(/Secundaria/g)).toHaveLength(1);
    expect(html).not.toContain("<li>Secundaria</li>");
  });

  it("keeps details that actually add something", () => {
    const html = renderResumeHtml(model({ education: [entry(["Cursos de contabilidad y computación"])] }));
    expect(html).toContain("<li>Cursos de contabilidad y computación</li>");
  });

  it("shows the school under the heading", () => {
    const html = renderResumeHtml(model({ education: [entry([])] }));
    expect(html).toContain('<span class="entry-title">Secundaria</span>');
    expect(html).toContain('<div class="entry-sub">Colegio Nacional</div>');
  });
});

describe("experience dates are shown", () => {
  it("prints the captured range, and 'Actualidad' for a current role", () => {
    const html = renderResumeHtml(
      model({
        experience: [
          {
            entryId: "e1",
            title: "Cuidadora",
            organization: "Familia",
            location: null,
            startDate: "2023",
            endDate: null,
            isCurrent: true,
            bullets: [{ text: "Cuidé a una persona mayor", sourceEntryIds: ["e1"], sourceFields: ["responsibilities"] }],
          },
          {
            entryId: "e2",
            title: "Vendedora",
            organization: "Tienda",
            location: null,
            startDate: "marzo de 2018",
            endDate: "junio de 2021",
            isCurrent: false,
            bullets: [{ text: "Atendí a clientes", sourceEntryIds: ["e2"], sourceFields: ["responsibilities"] }],
          },
        ],
      }),
    );
    expect(html).toContain("2023 – Actualidad");
    expect(html).toContain("Marzo de 2018 – Junio de 2021");
  });

  it("capitalizes every date segment", () => {
    const entry = (id: string, startDate: string, endDate: string | null, isCurrent = false) => ({
      entryId: id,
      title: "Vendedora",
      organization: null,
      location: null,
      startDate,
      endDate,
      isCurrent,
      bullets: [{ text: "Atendí", sourceEntryIds: [id], sourceFields: ["responsibilities"] }],
    });
    const html = renderResumeHtml(
      model({
        experience: [
          // What the Review dropdowns write.
          entry("e1", "marzo 2020", "febrero 2023"),
          // What a person typed in the funnel: a whole range in one field.
          entry("e2", "de 2015 a 2017", null),
          entry("e3", "junio 2024", null, true),
        ],
      }),
    );
    expect(html).toContain("Marzo 2020 – Febrero 2023");
    expect(html).toContain("De 2015 a 2017");
    expect(html).toContain("Junio 2024 – Actualidad");
    // The range typed by hand keeps its own wording — reformatting it from a parsed
    // value would drop the second year.
    expect(html).toContain("2017");
  });

  it("capitalizes a certification date too", () => {
    const html = renderResumeHtml(
      model({
        certifications: [
          { entryId: "c1", name: "Curso de Excel", issuingOrganization: "Aprende", issueDate: "marzo 2022" },
        ],
      }),
    );
    expect(html).toContain("Marzo 2022");
  });
});

/*
 * The renderer is the half of the English résumé the model never sees: headings,
 * the document language and the fallback labels are code, not translated prose.
 * If they leak Spanish, the person downloads English bullets under Spanish
 * headings — which is exactly what a translation feature is expected not to do.
 */
describe("rendering in English", () => {
  const full = model({
    interests: ["Football"],
    skills: [{ category: "sales", skills: ["Cashier"], sourceSkillIds: [] }],
    experience: [
      {
        entryId: "e1",
        title: "Sales Assistant",
        organization: "La Esperanza Bakery",
        location: null,
        startDate: "March 2020",
        endDate: null,
        isCurrent: true,
        bullets: [{ text: "Served customers.", sourceEntryIds: ["e1"], sourceFields: [] }],
      },
    ],
    education: [
      {
        entryId: "d1",
        institution: "Benito Juárez School",
        credential: "High School Diploma",
        fieldOfStudy: null,
        startDate: null,
        endDate: null,
        isCurrent: false,
        details: [],
      },
    ],
    certifications: [{ entryId: "c1", name: "Excel Course", issuingOrganization: "Aprende", issueDate: null }],
    projects: [{ entryId: "p1", name: "Market stall", bullets: [] }],
    languages: [{ entryId: "l1", name: "Spanish", level: "Native" }],
  });

  it("declares the document language so screen readers and PDF metadata agree", () => {
    expect(renderResumeHtml(full, "en")).toContain('<html lang="en">');
    expect(renderResumeHtml(full)).toContain('<html lang="es">');
  });

  it("prints every section heading in English and none in Spanish", () => {
    const html = renderResumeHtml(full, "en");
    for (const heading of [
      "Professional Summary",
      "Experience",
      "Education",
      "Skills",
      "Projects",
      "Certifications",
      "Languages",
      "Interests",
    ]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    for (const heading of [
      "Resumen profesional",
      "Experiencia",
      "Educación",
      "Habilidades",
      "Proyectos",
      "Certificaciones",
      "Idiomas",
      "Intereses",
    ]) {
      expect(html).not.toContain(`<h2>${heading}</h2>`);
    }
  });

  it("titles the document a Resume rather than a Currículum", () => {
    expect(renderResumeHtml(full, "en")).toContain("María García — Resume</title>");
    expect(renderResumeHtml(full)).toContain("María García — Currículum</title>");
  });

  it("says Present, not Actualidad, for an ongoing experience", () => {
    const html = renderResumeHtml(full, "en");
    expect(html).toContain("March 2020 – Present");
    expect(html).not.toContain("Actualidad");
  });

  /*
   * The heading fallback for an entry with no title and no employer — the norm for
   * this product's users, so it is the label most likely to be seen.
   */
  it("falls back to the English experience-type label", () => {
    const untitled: ResumeRenderModel["experience"][number] = {
      entryId: "e2",
      title: null,
      organization: null,
      location: null,
      startDate: null,
      endDate: null,
      isCurrent: false,
      bullets: [{ text: "Cared for my grandmother.", sourceEntryIds: ["e2"], sourceFields: [] }],
      experienceType: "caregiving" as ExperienceType,
    };
    expect(renderResumeHtml(model({ experience: [untitled] }), "en")).toContain("Caregiving");
    expect(renderResumeHtml(model({ experience: [untitled] }))).toContain("Cuidado de personas");
  });

  it("leaves Spanish rendering byte-identical when no language is passed", () => {
    expect(renderResumeHtml(full)).toBe(renderResumeHtml(full, "es"));
  });
});

describe("the sheet matches the printed page", () => {
  const html = renderResumeHtml(model());

  it("sizes the preview to the A4 page pdf-generator prints", () => {
    expect(html).toContain("width:800px");
    expect(html).toContain("min-height:1131px");
  });

  it("drops the sheet simulation when printing, so margins are not doubled", () => {
    const print = html.slice(html.indexOf("@media print"));
    expect(print).toContain("min-height:0");
    expect(print).toContain("padding:0");
  });

  it("never splits one entry across pages", () => {
    expect(html).toContain("break-inside:avoid");
  });
});
