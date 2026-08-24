/**
 * Persistence for the talent directory.
 *
 * ── Why this is NOT part of `Store` ─────────────────────────────────────────
 * `Store` answers questions about ONE user's own résumé: every method takes a
 * profile id the caller has already proven ownership of, and `SupabaseStore`
 * leans on RLS underneath. The directory is the opposite shape — a cross-user
 * query surface, read by people who own none of the rows, through functions that
 * run as the service role. Bolting it onto `Store` would put a search index and
 * a private document behind one interface with two different security stories,
 * and would force `MemoryStore` to grow a Spanish full-text engine.
 *
 * ── Which client does what, and why it is split ─────────────────────────────
 * `SupabaseTalentStore` holds two clients on purpose:
 *
 *   - The AUTHENTICATED client writes `talent_profiles`. That table's policy is
 *     `user_id = auth.uid()`, so Postgres itself refuses a publish on somebody
 *     else's behalf. The route also checks ownership, but this makes it true at
 *     the database rather than only in the code path that happens to run.
 *   - The SERVICE client does everything else: the contact table has RLS on with
 *     no policies at all, and the public read functions are granted to
 *     `service_role` alone (`0010_talent_directory.sql`).
 *
 * Publishing writes the public row first. If RLS rejects it, the contact row is
 * never reached — the failure mode is "nothing published", never "contact stored
 * for a listing that isn't yours".
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Employer,
  TalentContact,
  TalentListing,
  TalentLocation,
  TalentProfilePublic,
  TalentProfileStatus,
  TalentSearchFilters,
  TalentSearchResult,
} from "@/types";
import { isTalentCategory } from "@/lib/talent/taxonomy";
import { normalizeForMatch } from "@/lib/talent/classify";
import { distanceMiles } from "@/lib/geo/zip-lookup";

export interface PublishTalentInput {
  funnelId: string;
  userId: string;
  /** The public projection, slug included. */
  profile: TalentProfilePublic;
  /**
   * Coordinates for radius search. Stored on the row but never returned by the
   * public read functions — an employer learns that someone is 12 miles away,
   * not the point they were measured from.
   */
  location: TalentLocation;
  contact: TalentContact;
  manageToken: string;
  expiresAt: string;
}

export interface RevealContactInput {
  employerId: string;
  slug: string;
  ip?: string | null;
}

export interface UpsertEmployerInput {
  id: string;
  company: string;
  contactName: string;
  email: string;
  ip?: string | null;
}

export interface TalentDirectoryStore {
  /**
   * Create or replace the listing for a résumé. Idempotent per `funnelId`, so
   * re-publishing after an edit updates in place instead of leaving a stale copy
   * of the same person in the directory.
   */
  publish(input: PublishTalentInput): Promise<TalentListing>;
  /** Change a listing's status — unpublish, expire, or (a human) block it. */
  setStatus(funnelId: string, status: TalentProfileStatus): Promise<void>;
  /** The owner's own listing, whatever its status. Null when never published. */
  getByFunnelId(funnelId: string): Promise<TalentListing | null>;

  /** Public search. Published, unexpired rows only. */
  search(filters: TalentSearchFilters): Promise<TalentSearchResult>;
  /** One public profile. Null when the slug is unknown, unpublished or expired. */
  getPublicBySlug(slug: string): Promise<TalentProfilePublic | null>;

  /**
   * Reveal a contact AND record who saw it, in one operation. Returns null when
   * the slug is not live — nothing to reveal, so nothing to log.
   */
  revealContact(input: RevealContactInput): Promise<TalentContact | null>;

  upsertEmployer(input: UpsertEmployerInput): Promise<Employer>;
  getEmployer(id: string): Promise<Employer | null>;

  /** Resolve an unpublish/renew token. Null when it matches nothing. */
  findByManageToken(token: string): Promise<{ slug: string; funnelId: string } | null>;
}

/** Default listing lifetime. See the freshness note in the migration. */
export const TALENT_LISTING_DAYS = 90;

export function talentExpiryFrom(publishedAt: string, days = TALENT_LISTING_DAYS): string {
  return new Date(new Date(publishedAt).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory implementation
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  funnelId: string;
  userId: string;
  status: TalentProfileStatus;
  expiresAt: string;
  manageToken: string;
  profile: TalentProfilePublic;
  location: TalentLocation;
  contact: TalentContact;
}

/**
 * Process-local store for tests and memory-mode dev.
 *
 * The search is an APPROXIMATION of the Postgres one: it folds accents and does
 * token containment where the database does `plainto_tsquery('spanish', …)` over
 * a stemmed index. Close enough to exercise filters, paging and the ordering
 * contract; it will not agree with Postgres on stemming edge cases, and it is
 * not the thing to reach for when verifying relevance ranking.
 */
export class MemoryTalentStore implements TalentDirectoryStore {
  private readonly rows = new Map<string, MemoryRow>();
  private readonly employers = new Map<string, Employer>();
  /** Kept so tests can assert that a reveal was actually audited. */
  readonly reveals: Array<{ employerId: string; slug: string; at: string }> = [];

  private nextId = 1;

  async publish(input: PublishTalentInput): Promise<TalentListing> {
    const existing = this.rows.get(input.funnelId);
    const row: MemoryRow = {
      id: existing?.id ?? `talent-${this.nextId++}`,
      funnelId: input.funnelId,
      userId: input.userId,
      status: "published",
      expiresAt: input.expiresAt,
      // A re-publish keeps the token that may already have been emailed out.
      manageToken: existing?.manageToken ?? input.manageToken,
      profile: JSON.parse(JSON.stringify(input.profile)) as TalentProfilePublic,
      location: { ...input.location },
      contact: { ...input.contact },
    };
    this.rows.set(input.funnelId, row);
    return toListing(row);
  }

  async setStatus(funnelId: string, status: TalentProfileStatus): Promise<void> {
    const row = this.rows.get(funnelId);
    if (row) row.status = status;
  }

  async getByFunnelId(funnelId: string): Promise<TalentListing | null> {
    const row = this.rows.get(funnelId);
    return row ? toListing(row) : null;
  }

  private live(): MemoryRow[] {
    const now = Date.now();
    return [...this.rows.values()].filter(
      (r) => r.status === "published" && new Date(r.expiresAt).getTime() > now,
    );
  }

  async search(filters: TalentSearchFilters): Promise<TalentSearchResult> {
    const terms = filters.query ? normalizeForMatch(filters.query).split(" ").filter(Boolean) : [];
    const hasOrigin =
      typeof filters.latitude === "number" && typeof filters.longitude === "number";
    // Mirrors the clamp inside `talent_search`, so a caller cannot widen the
    // radius past what the database would allow either.
    const radius = Math.min(Math.max(filters.radiusMiles ?? 25, 1), 500);
    const origin = hasOrigin
      ? { latitude: filters.latitude as number, longitude: filters.longitude as number }
      : null;

    const matched = this.live()
      .map((row) => ({
        row,
        // Someone with no ZIP has no coordinates and so can never match a radius
        // search — the same as in SQL, where the null check excludes them.
        distance:
          origin && row.location.latitude !== null && row.location.longitude !== null
            ? distanceMiles(origin, {
                latitude: row.location.latitude,
                longitude: row.location.longitude,
              })
            : null,
      }))
      .filter(({ row, distance }) => {
        const p = row.profile;
        if (filters.category && p.category !== filters.category) return false;
        if (filters.availability && p.availability !== filters.availability) return false;
        if (origin && (distance === null || distance > radius)) return false;
        if (terms.length === 0) return true;
        const haystack = normalizeForMatch(
          [p.headline, p.summary, p.skills.join(" "), p.certifications.join(" "), p.city, p.state]
            .filter(Boolean)
            .join(" "),
        );
        return terms.every((t) => haystack.includes(t));
      });

    matched.sort((a, b) => {
      // Nearest first when there is an origin — that is the question being
      // asked. Recency otherwise.
      if (origin) return (a.distance ?? Infinity) - (b.distance ?? Infinity);
      return (
        new Date(b.row.profile.publishedAt).getTime() -
        new Date(a.row.profile.publishedAt).getTime()
      );
    });

    const offset = Math.max(filters.offset ?? 0, 0);
    const limit = Math.min(filters.limit ?? 24, 60);
    return {
      total: matched.length,
      profiles: matched.slice(offset, offset + limit).map(({ row, distance }) =>
        distance === null ? row.profile : { ...row.profile, distanceMiles: distance },
      ),
    };
  }

  async getPublicBySlug(slug: string): Promise<TalentProfilePublic | null> {
    return this.live().find((r) => r.profile.slug === slug)?.profile ?? null;
  }

  async revealContact(input: RevealContactInput): Promise<TalentContact | null> {
    const row = this.live().find((r) => r.profile.slug === input.slug);
    if (!row) return null;
    this.reveals.push({
      employerId: input.employerId,
      slug: input.slug,
      at: new Date().toISOString(),
    });
    return { ...row.contact };
  }

  async upsertEmployer(input: UpsertEmployerInput): Promise<Employer> {
    const employer: Employer = {
      id: input.id,
      company: input.company,
      contactName: input.contactName,
      email: input.email,
      createdAt: this.employers.get(input.id)?.createdAt ?? new Date().toISOString(),
    };
    this.employers.set(input.id, employer);
    return employer;
  }

  async getEmployer(id: string): Promise<Employer | null> {
    return this.employers.get(id) ?? null;
  }

  async findByManageToken(token: string): Promise<{ slug: string; funnelId: string } | null> {
    const row = [...this.rows.values()].find((r) => r.manageToken === token);
    return row ? { slug: row.profile.slug, funnelId: row.funnelId } : null;
  }
}

function toListing(row: MemoryRow): TalentListing {
  return {
    id: row.id,
    funnelId: row.funnelId,
    status: row.status,
    expiresAt: row.expiresAt,
    manageToken: row.manageToken,
    profile: row.profile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Columns of `talent_profiles` that make up the public projection. */
interface TalentProfileRow {
  id: string;
  funnel_id: string;
  slug: string;
  display_name: string;
  headline: string;
  summary: string;
  category: string;
  skills: string[] | null;
  certifications: string[] | null;
  education: unknown;
  experience: unknown;
  languages: unknown;
  years_bucket: string;
  availability: string;
  city: string | null;
  state: string | null;
  country: string | null;
  status: string;
  published_at: string;
  expires_at: string;
}

/**
 * Row → domain. The scalar columns are snake_case because this is a real
 * relational table (unlike `funnel`, whose JSONB columns hold domain objects
 * verbatim); the JSONB columns inside it DO hold domain shapes, so they pass
 * through untouched.
 *
 * `category`, `availability` and `years_bucket` are CHECK-constrained in
 * Postgres, so a cast is honest here — but `category` is validated anyway, since
 * removing an id from the taxonomy would leave older rows behind and a bad cast
 * would then propagate a category the UI cannot label.
 */
function rowToPublic(row: TalentProfileRow): TalentProfilePublic {
  return {
    slug: row.slug,
    displayName: row.display_name,
    headline: row.headline,
    summary: row.summary,
    category: isTalentCategory(row.category) ? row.category : "otro",
    skills: row.skills ?? [],
    certifications: row.certifications ?? [],
    education: (row.education ?? []) as TalentProfilePublic["education"],
    experience: (row.experience ?? []) as TalentProfilePublic["experience"],
    languages: (row.languages ?? []) as TalentProfilePublic["languages"],
    yearsBucket: row.years_bucket as TalentProfilePublic["yearsBucket"],
    availability: row.availability as TalentProfilePublic["availability"],
    city: row.city,
    state: row.state,
    country: row.country,
    publishedAt: row.published_at,
  };
}

export class SupabaseTalentStore implements TalentDirectoryStore {
  /**
   * @param auth    Cookie-bound client. Writes `talent_profiles` so the row's
   *                own RLS policy verifies ownership.
   * @param service Service-role client. Everything else — the contact table has
   *                no policies, and the read functions are granted to it alone.
   */
  constructor(
    private readonly auth: SupabaseClient,
    private readonly service: SupabaseClient,
  ) {}

  async publish(input: PublishTalentInput): Promise<TalentListing> {
    const p = input.profile;
    // Written through the AUTHENTICATED client: `talent_profiles_owner` checks
    // `user_id = auth.uid()`, so Postgres refuses a listing published on someone
    // else's résumé even if a route forgot to.
    const { data, error } = await this.auth
      .from("talent_profiles")
      .upsert(
        {
          funnel_id: input.funnelId,
          user_id: input.userId,
          slug: p.slug,
          display_name: p.displayName,
          headline: p.headline,
          summary: p.summary,
          category: p.category,
          skills: p.skills,
          certifications: p.certifications,
          education: p.education,
          experience: p.experience,
          languages: p.languages,
          years_bucket: p.yearsBucket,
          availability: p.availability,
          city: p.city,
          state: p.state,
          country: p.country,
          postal_code: input.location.postalCode,
          latitude: input.location.latitude,
          longitude: input.location.longitude,
          status: "published",
          published_at: p.publishedAt,
          expires_at: input.expiresAt,
        },
        { onConflict: "funnel_id" },
      )
      .select("*")
      .single();

    if (error) throw new Error(`No se pudo publicar el perfil: ${error.message}`);
    const row = data as TalentProfileRow;

    // Contact data second, and only through the service role. A failure here
    // leaves a listing with no way to be contacted, which is useless — so it
    // throws rather than being best-effort, and the caller unpublishes.
    const { error: contactError } = await this.service.from("talent_contacts").upsert(
      {
        talent_profile_id: row.id,
        full_name: input.contact.fullName,
        email: input.contact.email,
        phone: input.contact.phone,
        linkedin_url: input.contact.linkedInUrl,
        resume_pdf_path: input.contact.resumePdfPath,
        manage_token: input.manageToken,
      },
      // A plain upsert, which DOES overwrite `manage_token`. That is safe only
      // because the caller re-sends the existing token on a re-publish
      // (`publishTalentProfile` reads it back from `getByFunnelId` first), so the
      // write is a no-op on that column. If a future caller passes a fresh token
      // here, it will silently invalidate a link the user may already have been
      // emailed — which is the only way to unpublish once cookies are cleared.
      { onConflict: "talent_profile_id" },
    );
    if (contactError) {
      throw new Error(`No se pudieron guardar los datos de contacto: ${contactError.message}`);
    }

    return {
      id: row.id,
      funnelId: row.funnel_id,
      status: row.status as TalentProfileStatus,
      expiresAt: row.expires_at,
      manageToken: input.manageToken,
      profile: rowToPublic(row),
    };
  }

  async setStatus(funnelId: string, status: TalentProfileStatus): Promise<void> {
    const { error } = await this.auth
      .from("talent_profiles")
      .update({ status })
      .eq("funnel_id", funnelId);
    if (error) throw new Error(`No se pudo actualizar el perfil: ${error.message}`);
  }

  async getByFunnelId(funnelId: string): Promise<TalentListing | null> {
    const { data, error } = await this.auth
      .from("talent_profiles")
      .select("*")
      .eq("funnel_id", funnelId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as TalentProfileRow;

    // The token lives in the service-role table, so it needs a second read.
    const { data: contact } = await this.service
      .from("talent_contacts")
      .select("manage_token")
      .eq("talent_profile_id", row.id)
      .maybeSingle();

    return {
      id: row.id,
      funnelId: row.funnel_id,
      status: row.status as TalentProfileStatus,
      expiresAt: row.expires_at,
      manageToken: (contact as { manage_token?: string } | null)?.manage_token ?? "",
      profile: rowToPublic(row),
    };
  }

  async search(filters: TalentSearchFilters): Promise<TalentSearchResult> {
    const { data, error } = await this.service.rpc("talent_search", {
      p_query: filters.query ?? null,
      p_category: filters.category ?? null,
      p_availability: filters.availability ?? null,
      p_lat: filters.latitude ?? null,
      p_lng: filters.longitude ?? null,
      p_radius_miles: filters.radiusMiles ?? 25,
      p_limit: filters.limit ?? 24,
      p_offset: filters.offset ?? 0,
    });
    if (error) throw new Error(`No se pudo buscar en el directorio: ${error.message}`);

    const rows = (data ?? []) as Array<
      TalentProfileRow & { total_count: number; distance_miles: number | null }
    >;
    return {
      // The total rides on every row (one round trip, see the function); an empty
      // result set therefore has no row to carry it, which is correctly 0.
      total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
      profiles: rows.map((row) => {
        const profile = rowToPublic(row);
        return row.distance_miles === null
          ? profile
          : { ...profile, distanceMiles: Number(row.distance_miles) };
      }),
    };
  }

  async getPublicBySlug(slug: string): Promise<TalentProfilePublic | null> {
    const { data, error } = await this.service.rpc("talent_profile_public", { p_slug: slug });
    if (error) throw new Error(`No se pudo abrir el perfil: ${error.message}`);
    const rows = (data ?? []) as TalentProfileRow[];
    return rows[0] ? rowToPublic(rows[0]) : null;
  }

  async revealContact(input: RevealContactInput): Promise<TalentContact | null> {
    const { data, error } = await this.service.rpc("talent_reveal_contact", {
      p_employer: input.employerId,
      p_slug: input.slug,
      p_ip: input.ip ?? null,
    });
    if (error) throw new Error(`No se pudo obtener el contacto: ${error.message}`);

    const rows = (data ?? []) as Array<{
      full_name: string | null;
      email: string | null;
      phone: string | null;
      linkedin_url: string | null;
      resume_pdf_path: string | null;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      linkedInUrl: row.linkedin_url,
      resumePdfPath: row.resume_pdf_path,
    };
  }

  async upsertEmployer(input: UpsertEmployerInput): Promise<Employer> {
    const { data, error } = await this.service
      .from("employers")
      .upsert(
        {
          id: input.id,
          company: input.company,
          contact_name: input.contactName,
          email: input.email,
          ip: input.ip ?? null,
        },
        { onConflict: "id" },
      )
      .select("*")
      .single();
    if (error) throw new Error(`No se pudo registrar la empresa: ${error.message}`);
    const row = data as {
      id: string;
      company: string;
      contact_name: string;
      email: string;
      created_at: string;
    };
    return {
      id: row.id,
      company: row.company,
      contactName: row.contact_name,
      email: row.email,
      createdAt: row.created_at,
    };
  }

  async getEmployer(id: string): Promise<Employer | null> {
    const { data, error } = await this.service
      .from("employers")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      id: string;
      company: string;
      contact_name: string;
      email: string;
      created_at: string;
    };
    return {
      id: row.id,
      company: row.company,
      contactName: row.contact_name,
      email: row.email,
      createdAt: row.created_at,
    };
  }

  async findByManageToken(token: string): Promise<{ slug: string; funnelId: string } | null> {
    const { data, error } = await this.service.rpc("talent_profile_by_manage_token", {
      p_token: token,
    });
    if (error) throw new Error(`No se pudo validar el enlace: ${error.message}`);
    const rows = (data ?? []) as Array<{ slug: string }>;
    if (!rows[0]) return null;

    const { data: profile } = await this.service
      .from("talent_profiles")
      .select("funnel_id")
      .eq("slug", rows[0].slug)
      .maybeSingle();
    const funnelId = (profile as { funnel_id?: string } | null)?.funnel_id;
    return funnelId ? { slug: rows[0].slug, funnelId } : null;
  }
}
