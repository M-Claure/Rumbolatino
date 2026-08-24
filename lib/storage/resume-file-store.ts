import type { Store } from "@/lib/repositories/store";

/**
 * Binary artifact storage for résumé PDFs.
 *
 * Kept behind an interface for the same reason `Store` and `AIProvider` are:
 * domain code depends on the shape, not on Supabase. `MemoryResumeFileStore`
 * lets the whole save-on-generate path be unit-tested with no network.
 *
 * ## One PDF per improvement round
 * The path is derived from the profile and the résumé's `stage` — the improvement
 * round it belongs to — not from its *version*. A profile therefore holds at most
 * four objects (the initial `curriculum.pdf` plus `iteration-1..3.pdf`), and
 * within a round every write replaces what was there.
 *
 * That bound is what keeps this safe: storage grows with the round cap, never with
 * how many times a user regenerates, and a download can never hand back a stale
 * version of the round it asks for. Keeping a PDF per *version* instead would be
 * unbounded and would multiply PII at rest for no user-facing gain — the rounds
 * are the history the product actually exposes (`iteration_N.resume_pdf`).
 */
export interface ResumeFileStore {
  /**
   * Write the PDF for this profile + stage, replacing any previous one at the
   * same stage. Returns the stored object path, which is what gets recorded on
   * `funnel.resume_pdf` (and on the round's `iteration_N.resume_pdf` rows).
   */
  putResumePdf(input: ResumePdfRef & { pdf: Uint8Array }): Promise<string>;
  /** Read the stored PDF back, or `null` when nothing is stored. */
  getResumePdf(input: ResumePdfRef): Promise<Uint8Array | null>;
  /**
   * Read by STORED PATH rather than by (user, profile, stage).
   *
   * Exists for the talent directory: an employer who has unlocked a contact gets
   * the résumé's `resume_pdf_path` out of `talent_contacts` and has no business
   * knowing whose user id it belongs to — the path is the capability, and it was
   * handed over by an authorized reveal that wrote an audit row.
   *
   * Reading somebody else's object means the caller must hold a service-role
   * store (`getServiceResumeFileStore()`); the auth-scoped one simply gets
   * nothing back, because the bucket's RLS keys on the OWNER's `auth.uid()` and
   * that policy is deliberately left untouched.
   */
  getResumePdfByPath(path: string): Promise<Uint8Array | null>;
  /** Remove it. Succeeds whether or not anything was there. */
  deleteResumePdf(input: ResumePdfRef): Promise<void>;
}

/** Identifies whose PDF, for which profile, and from which improvement round. */
export interface ResumePdfRef {
  userId: string;
  profileId: string;
  /**
   * Improvement round the résumé belongs to: 0 for the initial generation,
   * 1..MAX_RESUME_ITERATIONS after that round. Defaults to 0 so a caller that
   * only ever dealt with "the profile's PDF" keeps addressing the same object
   * it always did.
   */
  stage?: number;
}

/**
 * Object path for one round's PDF.
 *
 * The **user id must stay the first segment**: the Supabase Storage RLS policies
 * in `supabase/migrations/0006_resume_pdf_storage.sql` authorize on
 * `(storage.foldername(name))[1] = auth.uid()`, so changing this layout silently
 * changes who can read the file. Covered by `tests/unit/resume-pdf-storage.test.ts`.
 *
 * Stage 0 keeps the name `curriculum.pdf` rather than `iteration-0.pdf`: it is
 * the file every profile already has on disk from before 0008, and renaming it
 * would orphan those bytes for no gain.
 */
export function resumePdfPath({ userId, profileId, stage = 0 }: ResumePdfRef): string {
  const file = stage > 0 ? `iteration-${stage}.pdf` : "curriculum.pdf";
  return `${userId}/${profileId}/${file}`;
}

/** The bucket these objects live in. Private — reads go through the API. */
export const RESUME_BUCKET = "resumes";

/**
 * In-process implementation for tests and memory-mode dev. Replacement semantics
 * match the Supabase one: writing the same path overwrites.
 */
export class MemoryResumeFileStore implements ResumeFileStore {
  private readonly files = new Map<string, Uint8Array>();

  async putResumePdf({ pdf, ...ref }: ResumePdfRef & { pdf: Uint8Array }): Promise<string> {
    const path = resumePdfPath(ref);
    // Copy: the caller owns the buffer it passed and may reuse it.
    this.files.set(path, Uint8Array.from(pdf));
    return path;
  }

  async getResumePdf(ref: ResumePdfRef): Promise<Uint8Array | null> {
    return this.getResumePdfByPath(resumePdfPath(ref));
  }

  async getResumePdfByPath(path: string): Promise<Uint8Array | null> {
    const found = this.files.get(path);
    return found ? Uint8Array.from(found) : null;
  }

  async deleteResumePdf(ref: ResumePdfRef): Promise<void> {
    this.files.delete(resumePdfPath(ref));
  }

  /** Test helper: how many distinct objects are stored. */
  get size(): number {
    return this.files.size;
  }
}

/** Narrow slice of `Store` the artifact writer needs — keeps its deps honest. */
export type ResumeRowUpdater = Pick<Store, "updateGeneratedResume" | "setIterationResumePdf">;
