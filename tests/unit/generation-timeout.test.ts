import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedResume } from "@/types";
import {
  PDF_COLD_MS,
  PDF_WARM_MS,
  POST_RENDER_MS,
  createResumePdfWriter,
  resetRenderStateForTests,
} from "@/lib/resume/resume-artifacts";
import { countsAsImprovementRound } from "@/lib/resume/generation-round";
import type { RequestDeadline } from "@/lib/request-deadline";

/**
 * The two halves of a real production failure: a first "Generar mi currículum"
 * answered 504, and the retry worked.
 *
 * What the data showed afterwards — two `generate-resume` calls billed 72s
 * apart, no stage-0 PDF ever written, and the profile left on `iteration=1` —
 * is that the model call had SUCCEEDED and the résumé had been saved. The
 * request then died in the only step after that which can take tens of seconds:
 * a cold Chromium render. The retry, finding a résumé, was charged an
 * improvement round for our timeout.
 *
 * So there are two things to pin, and they fail independently.
 */

const RESUME: GeneratedResume = {
  id: "res-1",
  resumeProfileId: "prof-1",
  version: 1,
  stage: 0,
  professionalSummary: "…",
  skills: [],
  experience: [],
  education: [],
  certifications: [],
  projects: [],
  languages: [],
  html: "<html>cv</html>",
  pdfPath: null,
  createdAt: new Date().toISOString(),
};

const deadlineOf = (ms: number): RequestDeadline => ({ remainingMs: () => ms });

/** Records what the writer did without needing Chromium or Storage. */
function harness(opts: { renderMs: number; deadlineMs: number }) {
  const events: string[] = [];
  const writer = createResumePdfWriter({
    userId: "user-1",
    deadline: deadlineOf(opts.deadlineMs),
    pdf: {
      available: true,
      generate: async () => {
        events.push("render:start");
        await new Promise((r) => setTimeout(r, opts.renderMs));
        events.push("render:finish");
        return new Uint8Array([1, 2, 3]);
      },
    },
    files: {
      putResumePdf: async () => {
        events.push("stored");
        return "user-1/prof-1/curriculum.pdf";
      },
    } as never,
    store: {
      updateGeneratedResume: async (_id: string, patch: { pdfPath: string }) => ({
        ...RESUME,
        pdfPath: patch.pdfPath,
      }),
      setIterationResumePdf: async () => undefined,
    } as never,
    analytics: {
      track: (event: string) => {
        events.push(`analytics:${event}`);
      },
    } as never,
  });
  return { writer, events };
}

describe("a slow PDF render can no longer eat the response", () => {
  // Declared per test rather than inherited: the cold/warm flag is module state,
  // so without this the budget a test gets depends on what ran before it.
  beforeEach(() => resetRenderStateForTests());

  it("abandons a render that overruns the invocation, and still returns the résumé", async () => {
    // The production shape: the pre-check thought the render fitted, and it did
    // not. Before this, the render ran to completion past the platform's ceiling
    // and the whole request became a 504 — losing the response to a résumé that
    // had already been saved and paid for.
    //
    // Driven on the WARM budget so the test costs ~2s instead of ~22s. The path
    // under test is the same one either way: the pre-check passes, then the race
    // caps the render.
    resetRenderStateForTests(true);
    const deadlineMs = PDF_WARM_MS + 100;
    const { writer, events } = harness({
      renderMs: deadlineMs - POST_RENDER_MS + 300,
      deadlineMs,
    });
    const out = await writer.onResumeCreated(RESUME);

    expect(events).toContain("render:start");
    expect(events).not.toContain("stored");
    expect(events).toContain("analytics:resume_pdf_skipped");
    // The résumé itself comes back untouched — the caller returns it to the user.
    expect(out).toEqual(RESUME);
    expect(out.pdfPath).toBeNull();
  });

  it("stores the PDF normally when the render fits", async () => {
    const { writer, events } = harness({ renderMs: 20, deadlineMs: PDF_COLD_MS + 10_000 });
    const out = await writer.onResumeCreated(RESUME);

    expect(events).toEqual([
      "render:start",
      "render:finish",
      "stored",
      "analytics:resume_pdf_stored",
    ]);
    expect(out.pdfPath).toBe("user-1/prof-1/curriculum.pdf");
  });

  it("does not even start a render there is plainly no room for", async () => {
    // The cheap pre-check still earns its place: no point burning a cold
    // Chromium start on bytes that will be thrown away.
    const { writer, events } = harness({ renderMs: 20, deadlineMs: PDF_COLD_MS - 1 });
    await writer.onResumeCreated(RESUME);
    expect(events).not.toContain("render:start");
    expect(events).toContain("analytics:resume_pdf_skipped");
  });

  it("an abandoned render that later FAILS does not crash the process", async () => {
    // The dropped promise outlives the response. Without a `.catch` attached to
    // it, a Chromium launch that rejects after being abandoned becomes an
    // unhandled rejection — turning a missing PDF into a dead instance.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      resetRenderStateForTests(true);
      const writer = createResumePdfWriter({
        userId: "user-1",
        deadline: deadlineOf(PDF_WARM_MS + 100),
        pdf: {
          available: true,
          generate: () =>
            new Promise<Uint8Array>((_resolve, reject) =>
              setTimeout(() => reject(new Error("chromium died")), PDF_WARM_MS + 100 - POST_RENDER_MS + 300),
            ),
        },
        files: { putResumePdf: async () => "p" } as never,
        store: {
          updateGeneratedResume: async () => RESUME,
          setIterationResumePdf: async () => undefined,
        } as never,
      });

      const out = await writer.onResumeCreated(RESUME);
      expect(out).toEqual(RESUME);
      // Let the abandoned render reject, then let the microtask queue drain.
      await new Promise((r) => setTimeout(r, 600));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("a retry after a failed generation is not an improvement round", () => {
  it("charges a round when the person is genuinely asking for one", () => {
    // They are looking at a finished résumé and pressed Regenerar.
    expect(countsAsImprovementRound({ hasResume: true, statusBefore: "generated" })).toBe(true);
  });

  it("does NOT charge one when the previous attempt never finished", () => {
    // The production case. A generation saves the résumé several steps before it
    // returns, so a request that died after saving leaves one behind — and the
    // person saw an error, not a résumé. `generating` is the tell: the route
    // only writes `generated` once everything succeeded.
    expect(countsAsImprovementRound({ hasResume: true, statusBefore: "generating" })).toBe(false);
  });

  it("never charges a round for a first résumé", () => {
    for (const statusBefore of ["draft", "collecting_information", "ready_for_review"] as const) {
      expect(countsAsImprovementRound({ hasResume: false, statusBefore }), statusBefore).toBe(false);
    }
    // Including the retry of a first generation that died before saving.
    expect(countsAsImprovementRound({ hasResume: false, statusBefore: "generating" })).toBe(false);
  });
});
