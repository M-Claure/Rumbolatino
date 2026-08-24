import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RESUME_BUCKET,
  resumePdfPath,
  type ResumeFileStore,
  type ResumePdfRef,
} from "@/lib/storage/resume-file-store";

/**
 * Supabase Storage implementation.
 *
 * Uses the **auth-scoped** client, exactly like `SupabaseStore`, so the bucket's
 * RLS policies apply as defense-in-depth: even if a bug computed the wrong path,
 * Postgres refuses a write outside the caller's own `auth.uid()` folder.
 */
export class SupabaseResumeFileStore implements ResumeFileStore {
  constructor(private readonly client: SupabaseClient) {}

  async putResumePdf({ pdf, ...ref }: ResumePdfRef & { pdf: Uint8Array }): Promise<string> {
    const path = resumePdfPath(ref);
    const { error } = await this.client.storage.from(RESUME_BUCKET).upload(path, pdf, {
      contentType: "application/pdf",
      // The whole point: each generation replaces the profile's single PDF.
      upsert: true,
    });
    if (error) throw new Error(`No se pudo guardar el PDF (${path}): ${error.message}`);
    return path;
  }

  async getResumePdf(ref: ResumePdfRef): Promise<Uint8Array | null> {
    return this.getResumePdfByPath(resumePdfPath(ref));
  }

  async getResumePdfByPath(path: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(RESUME_BUCKET).download(path);
    // A missing object is a normal state (nothing generated yet, or the write
    // failed earlier), not an error — the caller re-renders instead. It is also
    // what an auth-scoped client sees for somebody else's object, since the
    // bucket policy denies it: the same "null" either way, on purpose.
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async deleteResumePdf(ref: ResumePdfRef): Promise<void> {
    await this.client.storage.from(RESUME_BUCKET).remove([resumePdfPath(ref)]);
  }
}
