/**
 * "Continue where I left off" — which résumé a returning visitor is offered.
 *
 * The bug this guards: the landing page ignored the session it already had, so a
 * visitor who closed the tab mid-funnel and came back created a SECOND profile and
 * their half-finished one became unreachable (the session cookie is the only handle
 * on a résumé, and nothing in the UI ever named the old one again).
 */
import { describe, expect, it } from "vitest";
import type { ResumeProfile } from "@/types";
import { pickResumableProfile } from "@/lib/resumable-profile";

function profile(over: Partial<ResumeProfile> & { id: string }): ResumeProfile {
  return {
    userId: "u1",
    status: "collecting_information",
    targetRole: null,
    careerGoal: null,
    location: null,
    interests: [],
    progressPercentage: 0,
    currentSection: null,
    finalizedAt: null,
    termsAcceptedAt: null,
    termsVersion: null,
    publishConsentAt: null,
    publishConsentVersion: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

describe("pickResumableProfile", () => {
  it("offers nothing when the visitor has no profiles", () => {
    expect(pickResumableProfile([])).toBeNull();
  });

  it("offers the only profile there is", () => {
    const only = profile({ id: "a" });
    expect(pickResumableProfile([only])).toBe(only);
  });

  it("offers the most recently touched one, whatever order they arrive in", () => {
    const older = profile({ id: "older", updatedAt: "2026-08-01T10:00:00.000Z" });
    const newer = profile({ id: "newer", updatedAt: "2026-08-20T09:00:00.000Z" });
    expect(pickResumableProfile([older, newer])?.id).toBe("newer");
    expect(pickResumableProfile([newer, older])?.id).toBe("newer");
  });

  it("offers a FINALIZED résumé — the finished document is the point, not a leftover", () => {
    const abandoned = profile({ id: "abandoned", updatedAt: "2026-08-01T10:00:00.000Z" });
    const done = profile({
      id: "done",
      status: "generated",
      finalizedAt: "2026-08-20T09:05:00.000Z",
      updatedAt: "2026-08-20T09:05:00.000Z",
    });
    expect(pickResumableProfile([abandoned, done])?.id).toBe("done");
  });

  it("still prefers work in progress once it is the more recent one", () => {
    const done = profile({
      id: "done",
      status: "generated",
      finalizedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    });
    const started = profile({ id: "started", updatedAt: "2026-08-20T09:00:00.000Z" });
    expect(pickResumableProfile([done, started])?.id).toBe("started");
  });

  it("never resurfaces an archived profile", () => {
    const archived = profile({ id: "archived", status: "archived", updatedAt: "2026-08-20T09:00:00.000Z" });
    const open = profile({ id: "open", updatedAt: "2026-08-01T10:00:00.000Z" });
    expect(pickResumableProfile([archived, open])?.id).toBe("open");
    expect(pickResumableProfile([archived])).toBeNull();
  });

  it("compares the two stores' timestamp formats by instant, not by spelling", () => {
    // MemoryStore writes toISOString()'s trailing Z; Postgres returns +00:00. The
    // later instant must win even when the earlier one sorts later as a string.
    const memoryStyle = profile({ id: "later", updatedAt: "2026-08-20T09:00:00.000Z" });
    const postgresStyle = profile({ id: "earlier", updatedAt: "2026-08-20T08:00:00+00:00" });
    expect(pickResumableProfile([memoryStyle, postgresStyle])?.id).toBe("later");
  });

  it("breaks an exact tie the same way every time", () => {
    const a = profile({ id: "aaa", updatedAt: "2026-08-20T09:00:00.000Z" });
    const b = profile({ id: "bbb", updatedAt: "2026-08-20T09:00:00.000Z" });
    expect(pickResumableProfile([a, b])?.id).toBe("bbb");
    expect(pickResumableProfile([b, a])?.id).toBe("bbb");
  });

  it("falls back to createdAt when updatedAt cannot be parsed at all", () => {
    const broken = profile({ id: "broken", updatedAt: "not a date", createdAt: "2026-08-20T09:00:00.000Z" });
    const alsoBroken = profile({ id: "also", updatedAt: "", createdAt: "2026-08-01T10:00:00.000Z" });
    expect(pickResumableProfile([alsoBroken, broken])?.id).toBe("broken");
  });

  it("prefers any real timestamp over an unparseable one", () => {
    const broken = profile({ id: "broken", updatedAt: "not a date" });
    const real = profile({ id: "real", updatedAt: "2020-01-01T00:00:00.000Z" });
    expect(pickResumableProfile([broken, real])?.id).toBe("real");
  });
});
