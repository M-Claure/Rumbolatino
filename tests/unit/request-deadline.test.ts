import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUNCTION_BUDGET_MS,
  MAX_BOOT_CHARGE_MS,
  RESPONSE_MARGIN_MS,
  UNLIMITED_DEADLINE,
  resetColdStartForTests,
  startRequestDeadline,
} from "@/lib/request-deadline";
import { createResumePdfWriter } from "@/lib/resume/resume-artifacts";
import { MemoryResumeFileStore } from "@/lib/storage/resume-file-store";
import type { GeneratedResume } from "@/types";

beforeEach(() => {
  resetColdStartForTests();
  vi.spyOn(process, "uptime").mockReturnValue(0);
});

describe("startRequestDeadline", () => {
  it("reserves a margin for the response itself", () => {
    const d = startRequestDeadline();
    expect(d.remainingMs()).toBeLessThanOrEqual(FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS);
    expect(d.remainingMs()).toBeGreaterThan(FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS - 1_000);
  });

  // A first request pays for the runtime boot; the retry, now warm, does not.
  // That difference is why a cold generation 504s and the second attempt works.
  it("charges the runtime boot to the FIRST request of a process, not later ones", () => {
    vi.spyOn(process, "uptime").mockReturnValue(5); // 5s spent booting
    const cold = startRequestDeadline();
    expect(cold.remainingMs()).toBeLessThanOrEqual(FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS - 5_000);

    const warm = startRequestDeadline();
    expect(warm.remainingMs()).toBeGreaterThan(FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS - 1_000);
  });

  /*
   * The regression this clamp exists for. `process.uptime()` is only a PROXY for
   * boot time, and a worthless one on a dev server, a self-hosted container, or a
   * platform instance warmed long before the request — all of which report
   * minutes. Charged in full, that left zero budget on the first request to touch
   * this module, every model call collapsed to its 6s floor, and the funnel showed
   * "El servicio de IA tardó demasiado en responder" however fast the model was.
   */
  it("does not let a long-lived process consume the whole budget", () => {
    vi.spyOn(process, "uptime").mockReturnValue(3_600); // an hour-old dev server
    const d = startRequestDeadline();
    expect(d.remainingMs()).toBeGreaterThanOrEqual(
      FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS - MAX_BOOT_CHARGE_MS - 1_000,
    );
    // Comfortably above the 6s floor a model call would otherwise be given.
    expect(d.remainingMs()).toBeGreaterThan(30_000);
  });

  it("never reports a negative budget", () => {
    const d = startRequestDeadline(0);
    expect(d.remainingMs()).toBe(0);
  });
});

describe("the PDF writer under a deadline", () => {
  const resume = {
    id: "r1",
    resumeProfileId: "p1",
    version: 1,
    stage: 0,
    html: "<html><body>CV</body></html>",
  } as unknown as GeneratedResume;

  const deps = () => {
    const rendered: string[] = [];
    return {
      rendered,
      store: {
        updateGeneratedResume: async (_id: string, patch: { pdfPath?: string }) =>
          ({ ...resume, pdfPath: patch.pdfPath }) as GeneratedResume,
        setIterationResumePdf: async () => {},
        updateTranslatedResume: async () => {
          throw new Error("not used in these tests");
        },
      },
      pdf: {
        // `available` exists on this repo's PdfGenerator and not the other's —
        // harmless either way, since the writer only ever calls `generate`.
        available: true,
        generate: async (html: string) => {
          rendered.push(html);
          return Buffer.from("%PDF-1.4");
        },
      },
      files: new MemoryResumeFileStore(),
    };
  };

  it("renders when there is time", async () => {
    const d = deps();
    const writer = createResumePdfWriter({
      userId: "u1",
      store: d.store,
      pdf: d.pdf,
      files: d.files,
      deadline: UNLIMITED_DEADLINE,
    });
    const out = await writer.onResumeCreated(resume);
    expect(d.rendered).toHaveLength(1);
    expect(out.pdfPath).toBeTruthy();
  });

  // A skipped PDF self-heals on download; a 504 loses the whole generation.
  it("skips the render — and does NOT throw — when the invocation is nearly out of time", async () => {
    const d = deps();
    const writer = createResumePdfWriter({
      userId: "u1",
      store: d.store,
      pdf: d.pdf,
      files: d.files,
      deadline: { remainingMs: () => 2_000 },
    });
    const out = await writer.onResumeCreated(resume);
    expect(d.rendered).toHaveLength(0);
    expect(out).toBe(resume); // returned intact, no pdfPath claimed
  });
});
