import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The `employers` table, which `0010` created and nothing has used until now.
 *
 * ── Why service-role, with no RLS policy ────────────────────────────────────
 * Same pattern as `talent_contacts` and the usage counters: RLS is ON and there
 * are NO policies, so the anon key cannot reach this table at all. An employer's
 * own row is not interesting to leak on its own, but the table answers "who has
 * accounts here", and `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships to browsers — a
 * readable policy would make that list an unauthenticated API.
 *
 * The row is written from the server after Supabase Auth has created the user,
 * so `id` is always an existing `auth.users` id and the foreign key holds.
 */
export interface EmployerProfile {
  readonly id: string;
  readonly company: string;
  readonly contactName: string;
  readonly email: string;
}

export interface EmployerStore {
  /**
   * Create or update the profile for an auth user. Upsert rather than insert
   * because sign-up is retried: someone who never clicked the link and registers
   * again with a corrected company name must not hit a primary-key error.
   */
  save(input: EmployerProfile & { ip: string | null }): Promise<void>;
  get(id: string): Promise<EmployerProfile | null>;
}

export class MemoryEmployerStore implements EmployerStore {
  private readonly rows = new Map<string, EmployerProfile>();

  async save(input: EmployerProfile & { ip: string | null }): Promise<void> {
    const { ip: _ip, ...profile } = input;
    this.rows.set(profile.id, { ...profile });
  }

  async get(id: string): Promise<EmployerProfile | null> {
    return this.rows.get(id) ?? null;
  }
}

export class SupabaseEmployerStore implements EmployerStore {
  constructor(private readonly service: SupabaseClient) {}

  async save(input: EmployerProfile & { ip: string | null }): Promise<void> {
    const { error } = await this.service.from("employers").upsert(
      {
        id: input.id,
        company: input.company,
        contact_name: input.contactName,
        email: input.email,
        ip: input.ip,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`No se pudo guardar la cuenta de empresa: ${error.message}`);
  }

  async get(id: string): Promise<EmployerProfile | null> {
    const { data, error } = await this.service
      .from("employers")
      .select("id, company, contact_name, email")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`No se pudo leer la cuenta de empresa: ${error.message}`);
    if (!data) return null;
    const row = data as { id: string; company: string; contact_name: string; email: string };
    return {
      id: row.id,
      company: row.company,
      contactName: row.contact_name,
      email: row.email,
    };
  }
}
