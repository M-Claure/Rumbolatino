import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUNCTION_BUDGET_MS } from "@/lib/request-deadline";

const API_DIR = join(process.cwd(), "app", "api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return routeFiles(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

/**
 * A route "reaches the model" if it pulls the AI provider off the request
 * context. Those are the routes whose wall clock the shared deadline reasons
 * about.
 */
const USES_AI = /\b(ai|funnelAi)\b/;

describe("route time budgets", () => {
  const files = routeFiles(API_DIR);

  it("finds the API routes", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  /*
   * The deadline in `lib/request-deadline.ts` assumes every model-touching route
   * gets FUNCTION_BUDGET_MS. Six of them silently ran on the platform's ~10s
   * default instead, so the deadline handed the model ~50s inside a function that
   * would be killed at 10 — the answers route died mid-normalization and the
   * funnel reported "No pudimos guardar tu respuesta".
   */
  it("gives every model-touching route the budget the deadline assumes", () => {
    const offenders = files
      .filter((f) => USES_AI.test(readFileSync(f, "utf8")))
      .filter((f) => {
        const declared = readFileSync(f, "utf8").match(/export const maxDuration = (\d+)/);
        return !declared || Number(declared[1]) * 1_000 !== FUNCTION_BUDGET_MS;
      })
      .map((f) => f.replace(process.cwd() + "/", ""));

    expect(offenders).toEqual([]);
  });

  /*
   * Registering an operation in `LIMITS` / `PaidOperation` is compile-enforced, but
   * nothing makes a route USE them — an unguarded paid route type-checks perfectly
   * and simply costs money without a ceiling. These are the routes that spend
   * tokens on a user action, so each must hit both guards.
   */
  it("guards every paid route with a rate limit AND a budget check", () => {
    const paid = ["generate", "analyze", "proofread", "regenerate-section", "translate"];
    for (const name of paid) {
      const file = files.find((f) => f.includes(`/${name}/route.ts`));
      expect(file, `no route found for ${name}`).toBeTruthy();
      const src = readFileSync(file!, "utf8");
      expect(src, `${name} is missing enforceRateLimit`).toMatch(/enforceRateLimit\(/);
      expect(src, `${name} is missing assertWithinBudget`).toMatch(/assertWithinBudget\(/);
    }
  });

  it("keeps every PDF-rendering route on the Node.js runtime", () => {
    const rendering = files.filter((f) => /getPdfGenerator|resumeArtifacts/.test(readFileSync(f, "utf8")));
    expect(rendering.length).toBeGreaterThan(0);
    for (const f of rendering) {
      expect(readFileSync(f, "utf8"), f).toMatch(/export const runtime = "nodejs"/);
    }
  });
});
