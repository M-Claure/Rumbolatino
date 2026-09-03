/**
 * The directory's query-string contract.
 *
 * These exist because of a bug that produced no error and no empty result, and
 * so went unnoticed: `TalentFilters` is a plain `<form method="GET">`, which
 * submits every control it renders. With "Todas" selected — the default — that
 * includes `category=`, and `z.enum(...).optional()` rejects an empty string.
 * The whole parse failed, `/empleadores` fell back to an empty filter set, and
 * the search ran UNFILTERED: a query nobody matched returned the entire
 * directory instead of "no encontramos a nadie".
 *
 * So the first block below is not a formality. It pins the exact payloads the
 * filter bar sends, and a regression here silently un-fixes the search box.
 */
import { describe, expect, it } from "vitest";
import { MetroQuery, TalentSearchQuery } from "@/lib/validation/api-schemas";

/** What the browser actually sends for a given state of the filter bar. */
const formSubmission = (over: Record<string, string> = {}) => ({
  query: "",
  category: "",
  metro: "",
  zip: "",
  radius: "25",
  ...over,
});

describe("TalentSearchQuery — what the filter bar actually submits", () => {
  it("parses a search with the default 'Todas' area, and KEEPS the query", () => {
    const parsed = TalentSearchQuery.safeParse(formSubmission({ query: "cocinera" }));

    expect(parsed.success).toBe(true);
    // The whole point: the query must survive. Losing it is what turned a
    // no-match search into "here is everybody".
    expect(parsed.success && parsed.data.query).toBe("cocinera");
    expect(parsed.success && parsed.data.category).toBeUndefined();
  });

  it("parses an untouched form as no filters at all", () => {
    const parsed = TalentSearchQuery.safeParse(formSubmission());

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.query).toBeUndefined();
    expect(parsed.success && parsed.data.category).toBeUndefined();
    expect(parsed.success && parsed.data.zip).toBeUndefined();
  });

  it("keeps a chosen area alongside the query", () => {
    const parsed = TalentSearchQuery.safeParse(
      formSubmission({ query: "pastel", category: "gastronomia" }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.category).toBe("gastronomia");
    expect(parsed.success && parsed.data.query).toBe("pastel");
  });

  it("treats an empty metro box as absent, like every other blank control", () => {
    // The same trap as `category=`: the form submits the box whether or not
    // anybody typed in it, and a blank that reached `resolveMetroQuery` as a
    // search would render "no reconocimos ''" on an unfiltered page.
    const parsed = TalentSearchQuery.safeParse(formSubmission());
    expect(parsed.success && parsed.data.metro).toBeUndefined();
  });

  it("keeps the metro as TEXT, resolved later against the closed list", () => {
    // `MetroPicker` submits the full OMB title, and the no-JavaScript path
    // submits whatever was typed. Both arrive here as text — the schema
    // deliberately does not try to be the resolver, which needs the ZIP table.
    for (const typed of ["Houston-Pasadena-The Woodlands, TX", "houston", "26420"]) {
      const parsed = TalentSearchQuery.safeParse(formSubmission({ metro: typed }));
      expect(parsed.success && parsed.data.metro, typed).toBe(typed);
    }
  });

  it("rejects a metro longer than any real title", () => {
    expect(TalentSearchQuery.safeParse(formSubmission({ metro: "x".repeat(121) })).success).toBe(
      false,
    );
  });

  it("treats an empty ZIP as absent rather than as a ZIP to look up", () => {
    const parsed = TalentSearchQuery.safeParse(formSubmission({ zip: "" }));
    // `originForZip("")` would return null, which `/empleadores` reports as
    // "no reconocimos el código postal" — an error message for a box nobody
    // filled in.
    expect(parsed.success && parsed.data.zip).toBeUndefined();
  });

  it("treats an empty radius as absent instead of coercing it to 0", () => {
    // `z.coerce.number()` turns "" into 0, which then fails `.min(1)`. That was
    // a second, independent copy of the same bug.
    const parsed = TalentSearchQuery.safeParse(formSubmission({ radius: "" }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.radius).toBeUndefined();
  });

  it("coerces a radius that IS set", () => {
    const parsed = TalentSearchQuery.safeParse(formSubmission({ radius: "50" }));
    expect(parsed.success && parsed.data.radius).toBe(50);
  });
});

describe("TalentSearchQuery — values that are genuinely wrong still fail", () => {
  // Blank-means-absent must not become "anything goes". `/api/talent/search`
  // parses with `.parse()` and turns these into a 422, which is the right answer
  // for a client that sent nonsense.
  it("rejects a category that is not in the taxonomy", () => {
    expect(TalentSearchQuery.safeParse(formSubmission({ category: "medicina" })).success).toBe(
      false,
    );
  });

  it("rejects a limit above the cap `talent_search` enforces anyway", () => {
    expect(TalentSearchQuery.safeParse({ limit: "999" }).success).toBe(false);
  });

  it("rejects a radius outside the range the SQL clamps to", () => {
    expect(TalentSearchQuery.safeParse({ radius: "9000" }).success).toBe(false);
    expect(TalentSearchQuery.safeParse({ radius: "0" }).success).toBe(false);
  });

  it("rejects a query longer than the box allows", () => {
    expect(TalentSearchQuery.safeParse({ query: "a".repeat(121) }).success).toBe(false);
  });

  it("names the offending field, so the page can drop only that one", () => {
    const parsed = TalentSearchQuery.safeParse({ query: "cocinera", radius: "9000" });

    expect(parsed.success).toBe(false);
    // `/empleadores` reads `issue.path[0]` to decide what to discard. If issues
    // ever stopped carrying a path, it would fall back to dropping everything —
    // which is the behaviour this whole file exists to prevent.
    expect(!parsed.success && parsed.error.issues.map((i) => i.path[0])).toEqual(["radius"]);
  });

  it("trims whitespace so a query of only spaces is not a search", () => {
    const parsed = TalentSearchQuery.safeParse(formSubmission({ query: "   " }));

    expect(parsed.success).toBe(true);
    // Whitespace is blank. `talent_search` treats `btrim(p_query) = ''` as "no
    // query", so the page must agree, or it would claim to have searched.
    expect(parsed.success && parsed.data.query).toBeUndefined();
  });
});

/**
 * The autocomplete's parameter.
 *
 * A blank or one-character `q` is VALID and yields nothing, rather than a 400:
 * `MetroPicker` fires while somebody is still typing, and rejecting the first
 * keystroke would fill the console with errors during ordinary use.
 */
describe("MetroQuery — the autocomplete's parameter", () => {
  it("accepts a partial word", () => {
    expect(MetroQuery.parse({ q: "hous" }).q).toBe("hous");
  });

  it("accepts a blank as absent instead of failing", () => {
    expect(MetroQuery.parse({ q: "" }).q).toBeUndefined();
    expect(MetroQuery.parse({}).q).toBeUndefined();
  });

  it("still bounds the length", () => {
    expect(MetroQuery.safeParse({ q: "x".repeat(121) }).success).toBe(false);
  });
});
