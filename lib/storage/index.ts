import "server-only";
import { getEnv } from "@/lib/env";
import { getSupabaseServerClient, getSupabaseServiceClient } from "@/lib/supabase/server";
import { MemoryResumeFileStore, type ResumeFileStore } from "./resume-file-store";
import { SupabaseResumeFileStore } from "./supabase-resume-file-store";

export type { ResumeFileStore, ResumePdfRef } from "./resume-file-store";
export { RESUME_BUCKET, resumePdfPath } from "./resume-file-store";

/**
 * The memory file store must outlive a single request, for the same reason
 * `getMemoryStore()` does: Next re-instantiates route modules in dev, so a
 * module-scoped singleton would give each route its own empty store.
 */
const globalForFiles = globalThis as unknown as { __mcvResumeFiles?: MemoryResumeFileStore };

export function getMemoryResumeFileStore(): MemoryResumeFileStore {
  if (!globalForFiles.__mcvResumeFiles) {
    globalForFiles.__mcvResumeFiles = new MemoryResumeFileStore();
  }
  return globalForFiles.__mcvResumeFiles;
}

/** Resolve the artifact backend from configuration, mirroring `getStore()`. */
export function getResumeFileStore(): ResumeFileStore {
  const env = getEnv();
  if (env.PERSISTENCE === "supabase") {
    return new SupabaseResumeFileStore(getSupabaseServerClient());
  }
  return getMemoryResumeFileStore();
}

/**
 * The same store, bound to the SERVICE ROLE — the only way to read an object
 * that belongs to someone else.
 *
 * There is exactly one legitimate caller: the talent directory's résumé
 * download, where an employer has already identified themselves, already
 * unlocked the contact, and already had that access written to
 * `contact_reveals`. Everything else must keep using `getResumeFileStore()`,
 * whose auth-scoped client is checked by the bucket's own RLS.
 *
 * Kept as a separate function rather than a flag on the existing one so that
 * `grep -rn getServiceResumeFileStore` lists every place in the codebase that
 * can read another user's file. Today that list has one entry.
 */
export function getServiceResumeFileStore(): ResumeFileStore {
  const env = getEnv();
  if (env.PERSISTENCE !== "supabase") return getMemoryResumeFileStore();
  return new SupabaseResumeFileStore(getSupabaseServiceClient());
}
