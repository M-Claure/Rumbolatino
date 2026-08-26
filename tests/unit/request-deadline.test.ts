import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUNCTION_BUDGET_MS,
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

  // The failure the user hit: a first request 504s, the retry succeeds. The
  // difference is boot time the old fixed allowance could not see.
  it("charges the runtime boot to the FIRST request of a process, not later ones", () => {
    vi.spyOn(process, "uptime").mockReturnValue(15); // 15s spent booting
    const cold = startRequestDeadline();
    expect(cold.remainingMs()).toBeLessThanOrEqual(FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS - 15_000);

    const warm = startRequestDeadline();
    expect(warm.remainingMs()).toBeGreaterThan(FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS - 1_000);
  });

  it("floors at zero rather than going negative", () => {
    vi.spyOn(process, "uptime").mockReturnValue(600);
    expect(startRequestDeadline().remainingMs()).toBe(0);
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
