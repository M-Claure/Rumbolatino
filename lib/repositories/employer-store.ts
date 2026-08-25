import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TokenPurpose } from "@/lib/employers/tokens";

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
  /** Null until they clicked the link we sent. The gate reads exactly this. */
  readonly emailVerifiedAt: string | null;
}

export interface EmployerTokenInput {
  readonly employerId: string;
  readonly purpose: TokenPurpose;
  /** The HASH, never the token — see `lib/employers/tokens.ts`. */
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly ip: string | null;
}

export interface EmployerStore {
  /**
   * Create or update the profile for an auth user. Upsert rather than insert
   * because sign-up is retried: someone who never clicked the link and registers
   * again with a corrected company name must not hit a primary-key error.
   */
  save(input: EmployerProfile & { ip: string | null }): Promise<void>;
  get(id: string): Promise<EmployerProfile | null>;
  /** By address, for the flows that start from a form field rather than a session. */
  findByEmail(email: string): Promise<EmployerProfile | null>;

  /**
   * Store a new token, invalidating any outstanding one for the same purpose.
   *
   * Invalidating is not tidiness. Without it, pressing "send it again" leaves two
   * working links alive, so a link that was forwarded, logged by a mail scanner
   * or left in an old inbox stays usable after the person has already finished —
   * and for a reset, that is an account takeover with a stale message.
   */
  issueToken(input: EmployerTokenInput): Promise<void>;

  /**
   * Consume a token and return whose it was, or null.
   *
   * ONE atomic operation. Valid, unused, unexpired and of the right purpose are
   * all checked in the same statement that marks it used, so a link cannot be
   * replayed even by two simultaneous clicks. The four failure reasons are
   * indistinguishable to the caller on purpose: they are one message to whoever
   * is holding a link that does not work.
   */
  consumeToken(tokenHash: string, purpose: TokenPurpose): Promise<string | null>;

  /** Stamp verification. Idempotent: re-verifying keeps the original timestamp. */
  markEmailVerified(id: string): Promise<void>;
}

interface MemoryToken {
  employerId: string;
  purpose: TokenPurpose;
  expiresAt: string;
  consumed: boolean;
}

export class MemoryEmployerStore implements EmployerStore {
  private readonly rows = new Map<string, EmployerProfile>();
  /** Keyed by hash, mirroring the unique index in `0013`. */
  private readonly tokens = new Map<string, MemoryToken>();

  async save(input: EmployerProfile & { ip: string | null }): Promise<void> {
    const { ip: _ip, ...profile } = input;
    this.rows.set(profile.id, { ...profile });
  }

  async get(id: string): Promise<EmployerProfile | null> {
    return this.rows.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<EmployerProfile | null> {
    const wanted = email.trim().toLowerCase();
    return [...this.rows.values()].find((r) => r.email.toLowerCase() === wanted) ?? null;
  }

  async issueToken(input: EmployerTokenInput): Promise<void> {
    for (const [hash, token] of this.tokens) {
      if (token.employerId === input.employerId && token.purpose === input.purpose) {
        this.tokens.delete(hash);
      }
    }
    this.tokens.set(input.tokenHash, {
      employerId: input.employerId,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  async consumeToken(tokenHash: string, purpose: TokenPurpose): Promise<string | null> {
    const token = this.tokens.get(tokenHash);
    if (!token) return null;
    if (token.purpose !== purpose) return null;
    if (token.consumed) return null;
    if (new Date(token.expiresAt).getTime() <= Date.now()) return null;
    token.consumed = true;
    return token.employerId;
  }

  async markEmailVerified(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.emailVerifiedAt) return;
    this.rows.set(id, { ...row, emailVerifiedAt: new Date().toISOString() });
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

  private static readonly COLUMNS = "id, company, contact_name, email, email_verified_at";

  private static toProfile(data: unknown): EmployerProfile {
    const row = data as {
      id: string;
      company: string;
      contact_name: string;
      email: string;
      email_verified_at: string | null;
    };
    return {
      id: row.id,
      company: row.company,
      contactName: row.contact_name,
      email: row.email,
      emailVerifiedAt: row.email_verified_at,
    };
  }

  async get(id: string): Promise<EmployerProfile | null> {
    const { data, error } = await this.service
      .from("employers")
      .select(SupabaseEmployerStore.COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`No se pudo leer la cuenta de empresa: ${error.message}`);
    return data ? SupabaseEmployerStore.toProfile(data) : null;
  }

  async findByEmail(email: string): Promise<EmployerProfile | null> {
    const { data, error } = await this.service
      .from("employers")
      .select(SupabaseEmployerStore.COLUMNS)
      // The column is written lowercased by `normalizeEmail`, but `ilike` costs
      // nothing here and survives a row inserted by hand in the dashboard.
      .ilike("email", email.trim())
      .maybeSingle();
    if (error) throw new Error(`No se pudo buscar la cuenta de empresa: ${error.message}`);
    return data ? SupabaseEmployerStore.toProfile(data) : null;
  }

  async issueToken(input: EmployerTokenInput): Promise<void> {
    // Retire the outstanding ones FIRST, so a crash between the two statements
    // leaves the person with no working link rather than two. Asking them to
    // press "send again" is a far better failure than a replayable reset link.
    const { error: clearError } = await this.service
      .from("employer_email_tokens")
      .update({ consumed_at: new Date().toISOString() })
      .eq("employer_id", input.employerId)
      .eq("purpose", input.purpose)
      .is("consumed_at", null);
    if (clearError) {
      throw new Error(`No se pudo invalidar el enlace anterior: ${clearError.message}`);
    }

    const { error } = await this.service.from("employer_email_tokens").insert({
      employer_id: input.employerId,
      purpose: input.purpose,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      ip: input.ip,
    });
    if (error) throw new Error(`No se pudo crear el enlace: ${error.message}`);
  }

  async consumeToken(tokenHash: string, purpose: TokenPurpose): Promise<string | null> {
    // The check and the state change are one statement inside
    // `mcv_consume_employer_token`, so a link cannot be replayed by two
    // simultaneous clicks. Never do this as a select-then-update from here.
    const { data, error } = await this.service.rpc("mcv_consume_employer_token", {
      p_token_hash: tokenHash,
      p_purpose: purpose,
    });
    if (error) throw new Error(`No se pudo validar el enlace: ${error.message}`);
    const rows = (data ?? []) as Array<{ employer_id: string }>;
    return rows[0]?.employer_id ?? null;
  }

  async markEmailVerified(id: string): Promise<void> {
    const { error } = await this.service
      .from("employers")
      .update({ email_verified_at: new Date().toISOString() })
      .eq("id", id)
      // Idempotent: a second click keeps the original timestamp, which is the
      // one that says when they actually proved it.
      .is("email_verified_at", null);
    if (error) throw new Error(`No se pudo confirmar el correo: ${error.message}`);
  }
}
