import "server-only";
import { getEnv } from "@/lib/env";
import { getSupabaseServerClient, getSupabaseServiceClient } from "@/lib/supabase/server";
import { MemoryStore } from "./memory-store";
import { SupabaseStore } from "./supabase-store";
import { MemoryTalentStore, SupabaseTalentStore } from "./talent-store";
import type { Store } from "./store";
import type { TalentDirectoryStore } from "./talent-store";

export type { Store } from "./store";
export type { TalentDirectoryStore } from "./talent-store";

/**
 * A single MemoryStore must persist across requests for the whole process.
 * We stash it on `globalThis` (not a module-level `let`) because Next.js dev
 * re-instantiates route modules — a module-scoped singleton would give each
 * route its own empty store, so a profile created by one route wouldn't be
 * found by the next ("Perfil no encontrado"). `globalThis` is shared across all
 * module instances in the process, so the store survives.
 */
const globalForStore = globalThis as unknown as { __mcvMemoryStore?: MemoryStore };

export function getMemoryStore(): MemoryStore {
  if (!globalForStore.__mcvMemoryStore) {
    globalForStore.__mcvMemoryStore = new MemoryStore();
  }
  return globalForStore.__mcvMemoryStore;
}

/**
 * Resolve the persistence backend from configuration.
 * - memory   → process-local singleton (dev/tests, no external services)
 * - supabase → request-scoped, RLS-enforced client
 */
export function getStore(): Store {
  const env = getEnv();
  if (env.PERSISTENCE === "supabase") {
    return new SupabaseStore(getSupabaseServerClient());
  }
  return getMemoryStore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Talent directory
// ─────────────────────────────────────────────────────────────────────────────

const globalForTalent = globalThis as unknown as { __mcvMemoryTalentStore?: MemoryTalentStore };

export function getMemoryTalentStore(): MemoryTalentStore {
  if (!globalForTalent.__mcvMemoryTalentStore) {
    globalForTalent.__mcvMemoryTalentStore = new MemoryTalentStore();
  }
  return globalForTalent.__mcvMemoryTalentStore;
}

/**
 * The directory's persistence.
 *
 * Unlike the rate limiters and the spend ledger — which fail OPEN when
 * `SUPABASE_SERVICE_ROLE_KEY` is missing, because one broken counter must not
 * refuse every résumé — this one fails CLOSED, loudly.
 *
 * The reason is what each degradation actually does. An unenforced rate limit
 * still serves the user correctly; it only stops protecting the budget. A
 * directory with no service role cannot write the contact row, so "carry on
 * anyway" would publish someone's name and work history to a public page with no
 * way for anyone to reach them, and no manage token to take it down with. That is
 * strictly worse than refusing to publish. Configuration faults here are the
 * operator's to fix before the feature is offered at all.
 */
export function getTalentStore(): TalentDirectoryStore {
  const env = getEnv();
  if (env.PERSISTENCE !== "supabase") return getMemoryTalentStore();

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "[talent] SUPABASE_SERVICE_ROLE_KEY is not set. The directory needs it to write " +
        "contact records and to run the public read functions, which are granted to " +
        "service_role only (supabase/migrations/0010_talent_directory.sql).",
    );
    throw new Error("La bolsa de talento no está configurada en este entorno.");
  }

  return new SupabaseTalentStore(getSupabaseServerClient(), getSupabaseServiceClient());
}
