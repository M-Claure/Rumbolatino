import { describe, expect, it } from "vitest";
import { TALENT_CATEGORY_IDS, TALENT_AVAILABILITIES, TALENT_YEARS_BUCKETS } from "@/types/talent";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_SHORT_LABELS,
  CATEGORIES,
  CATEGORY_OPTIONS,
  YEARS_BUCKET_LABELS,
  isTalentCategory,
} from "@/lib/talent/taxonomy";
import { normalizeForMatch, rankCategories, suggestCategory } from "@/lib/talent/classify";

describe("taxonomy completeness", () => {
  it("gives every category a Spanish label and a hint", () => {
    for (const id of TALENT_CATEGORY_IDS) {
      expect(CATEGORIES[id].label.length).toBeGreaterThan(0);
      expect(CATEGORIES[id].hint.length).toBeGreaterThan(0);
    }
    expect(CATEGORY_OPTIONS).toHaveLength(TALENT_CATEGORY_IDS.length);
  });

  it("gives every category except 'otro' something to match on", () => {
    for (const id of TALENT_CATEGORY_IDS) {
      if (id === "otro") {
        // `otro` must never win on its own — it is only ever the fallback.
        expect(CATEGORIES[id].keywords).toHaveLength(0);
        continue;
      }
      expect(CATEGORIES[id].keywords.length).toBeGreaterThan(3);
    }
  });

  it("labels every availability and every years bucket", () => {
    for (const a of TALENT_AVAILABILITIES) {
      expect(AVAILABILITY_LABELS[a].length).toBeGreaterThan(0);
      expect(AVAILABILITY_SHORT_LABELS[a].length).toBeGreaterThan(0);
    }
    for (const y of TALENT_YEARS_BUCKETS) expect(YEARS_BUCKET_LABELS[y].length).toBeGreaterThan(0);
  });

  it("does not claim an unknown string is a category", () => {
    expect(isTalentCategory("belleza")).toBe(true);
    expect(isTalentCategory("Belleza")).toBe(false);
    expect(isTalentCategory("cocina")).toBe(false);
    expect(isTalentCategory(undefined)).toBe(false);
  });
});

describe("normalizeForMatch", () => {
  it("folds case and accents so either spelling matches", () => {
    expect(normalizeForMatch("DISEÑO Gráfico")).toBe("diseno grafico");
    expect(normalizeForMatch("  Cocinera   Profesional ")).toBe("cocinera profesional");
  });
});

describe("rankCategories", () => {
  it("classifies representative Aprende profiles", () => {
    const cases: Array<[string, ReturnType<typeof suggestCategory>]> = [
      ["Cosmetóloga", "belleza"],
      ["Cocinero de restaurante", "gastronomia"],
      ["Asistente médico", "salud"],
      ["Entrenadora personal", "bienestar"],
      ["Electricista residencial", "oficios"],
      ["Mecánico automotriz", "automotriz"],
      ["Auxiliar contable", "negocios"],
      ["Diseñadora gráfica", "tecnologia"],
      ["Maestra de preescolar", "educacion"],
      ["Personal de limpieza", "servicios_generales"],
    ];
    for (const [targetRole, expected] of cases) {
      expect(suggestCategory({ targetRole }), targetRole).toBe(expected);
    }
  });

  it("matches stems, so gender and plural do not matter", () => {
    for (const role of ["cocinera", "cocineros", "Cocina mexicana"]) {
      expect(suggestCategory({ targetRole: role }), role).toBe("gastronomia");
    }
  });

  it("matches text typed without accents", () => {
    expect(suggestCategory({ targetRole: "mecanico automotriz" })).toBe("automotriz");
    expect(suggestCategory({ targetRole: "diseno grafico" })).toBe("tecnologia");
  });

  it("weights the stated target role above an older job title", () => {
    // Someone trained in beauty who is currently cleaning houses: what they SAY
    // they want must outrank the job they are trying to leave.
    const suggestion = suggestCategory({
      targetRole: "Estilista",
      experience: [{ title: "Limpieza de casas" }],
    });
    expect(suggestion).toBe("belleza");
  });

  it("falls back to 'otro' rather than guessing when nothing matches", () => {
    expect(suggestCategory({ targetRole: "xyzzy" })).toBe("otro");
    expect(suggestCategory({})).toBe("otro");
  });

  it("is deterministic and returns every category, best first", () => {
    const input = { targetRole: "Cocinera", skills: ["repostería", "manejo de caja"] };
    const a = rankCategories(input);
    const b = rankCategories(input);
    expect(a).toEqual(b);
    expect(a).toHaveLength(TALENT_CATEGORY_IDS.length);
    expect(a[0]?.category).toBe("gastronomia");
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!.score).toBeLessThanOrEqual(a[i - 1]!.score);
    }
  });

  it("explains itself, so the UI can say why a category was suggested", () => {
    const top = rankCategories({ targetRole: "Barbero" })[0];
    expect(top?.category).toBe("belleza");
    expect(top?.matched.length).toBeGreaterThan(0);
  });

  it("caps how much one verbose field can contribute", () => {
    // Six kitchen words in a career goal (weight 1, capped at 3 hits = 3 points)
    // must not outweigh one credential (weight 3, and it also fires the cap).
    const wordy = "quiero cocinar en un restaurante de cocina con chef y repostería y panadería";
    const ranked = rankCategories({
      careerGoal: wordy,
      education: [{ credential: "Certificado en electricidad", fieldOfStudy: "Electricista" }],
    });
    expect(ranked[0]?.category).toBe("oficios");
  });
});
