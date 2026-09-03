/**
 * Bolsa de Talento — the opt-in directory profile.
 *
 * A talent profile is a PROJECTION of a finished résumé, never a second capture
 * surface. Everything here is derived in `lib/talent/talent-projection.ts` from
 * data the user already confirmed, and the résumé is the upper bound on it: the
 * directory can never show something the CV does not.
 *
 * ── The one structural rule ─────────────────────────────────────────────────
 * `TalentProfilePublic` and `TalentContact` are two separate types on purpose.
 * The public one is what a search result and a public profile page are built
 * from, and it has NO contact field — not an optional one, not a nullable one,
 * none. Revealing a contact requires reaching for a different type, from a
 * different table, through a route that writes an audit row. Keeping them apart
 * here is what makes "the search path cannot leak an email" a fact about the
 * type system rather than a habit.
 *
 * Field names are English camelCase like the rest of the domain; labels shown to
 * users are Spanish and live in `lib/talent/taxonomy.ts`.
 */
import type { ExperienceType } from "./domain";

/**
 * Category ids, the single source of truth for the taxonomy's SHAPE.
 *
 * The ids live here, in the types leaf, while the labels and the matching
 * keywords live in `lib/talent/taxonomy.ts`. That split keeps the dependency
 * pointing one way (lib → types, never back) and still buys the property that
 * matters: the taxonomy is a `Record<TalentCategory, …>`, so adding an id to
 * this tuple is a COMPILE ERROR until its label and keywords are written. The
 * same trick `BrandId` uses to make adding a brand impossible to half-finish.
 *
 * Ordered roughly by how much of Aprende's catalogue sits in each, because this
 * is also the order the publish dropdown renders in.
 */
export const TALENT_CATEGORY_IDS = [
  "belleza",
  "gastronomia",
  "salud",
  "bienestar",
  "oficios",
  "automotriz",
  "negocios",
  "tecnologia",
  "educacion",
  "servicios_generales",
  "otro",
] as const;
export type TalentCategory = (typeof TALENT_CATEGORY_IDS)[number];

/**
 * How soon the person can start. Coarse on purpose — an exact date goes stale
 * the moment it is stored, and nobody updates a directory listing.
 */
export const TALENT_AVAILABILITIES = ["inmediata", "dos_semanas", "un_mes", "flexible"] as const;
export type TalentAvailability = (typeof TALENT_AVAILABILITIES)[number];

/**
 * Experience as a BUCKET, never a number.
 *
 * "14 years of experience" plus a graduation year is an age, and this product
 * refuses to collect age at all (no birth date, no photo, no marital status).
 * Publishing a precise figure would reintroduce through the back door exactly
 * what the funnel is careful never to ask for, and hand employers a filter that
 * proxies for a protected class. Four buckets carry the signal a hiring decision
 * legitimately needs and none of the signal it must not have.
 */
export const TALENT_YEARS_BUCKETS = ["sin_experiencia", "0_2", "3_5", "6_mas"] as const;
export type TalentYearsBucket = (typeof TALENT_YEARS_BUCKETS)[number];

/**
 * A US metro area, as OMB defines one: a county with an urban core plus every
 * county that commutes into it. Reference data, resolved from a ZIP by
 * `lib/geo/cbsa-lookup.ts` — never captured, never asked for.
 *
 * `code` is the CBSA code (five digits, e.g. `26420`); `title` is OMB's own
 * name for it (`Houston-Pasadena-The Woodlands, TX`), which is what employers
 * see and what the autocomplete matches against.
 */
export interface MetroArea {
  code: string;
  title: string;
  /** Metropolitan = 50k+ urban core; micropolitan = 10k–50k. */
  kind: "metropolitan" | "micropolitan";
  /** The metro's centre, for centring a map. See the note in the build script. */
  latitude: number;
  longitude: number;
}

/**
 * What the `metro=` filter turned out to mean.
 *
 * Four outcomes rather than a nullable metro, because `/empleadores` owes the
 * employer a different sentence for each: a resolved metro is named, an
 * ambiguous one is offered as choices, an unrecognised one is admitted to, and
 * an absent one says nothing at all. Collapsing any two of them produces the
 * failure this codebase keeps running into — an empty table that reads as
 * "nobody works there" when it means "we did not understand you".
 */
export type MetroMatch =
  | { status: "absent" }
  | { status: "exact"; metro: MetroArea }
  | { status: "ambiguous"; typed: string; options: MetroArea[] }
  | { status: "unknown"; typed: string };

export const TALENT_PROFILE_STATUSES = [
  "published",
  "unpublished",
  "expired",
  /** Set by a human reviewer; never by the app. */
  "blocked",
] as const;
export type TalentProfileStatus = (typeof TALENT_PROFILE_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Public sub-shapes — everything below is safe to render on a page anyone can open
// ─────────────────────────────────────────────────────────────────────────────

export interface TalentEducationBlock {
  institution: string | null;
  credential: string | null;
  fieldOfStudy: string | null;
}

export interface TalentExperienceBlock {
  title: string | null;
  organization: string | null;
  /**
   * Carried through from the résumé for the same reason the renderer carries it:
   * this product's users often have no job title and no employer ("cuidaba a mi
   * abuela"), and the type is the only thing that makes such an entry legible.
   */
  experienceType: ExperienceType | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  /** Generated bullet TEXT only — the source-trace ids stay server-side. */
  bullets: string[];
}

export interface TalentLanguageBlock {
  name: string;
  level: string | null;
}

/**
 * What an employer sees, in search results and on a public profile page.
 *
 * No email. No phone. No full surname. No street address. If you are adding a
 * field here, it is about to be visible to everyone — and it also has to be
 * added to the `returns table` clause of `talent_search` /
 * `talent_profile_public` in `0010_talent_directory.sql`, which is the database's
 * half of the same guarantee.
 */
export interface TalentProfilePublic {
  slug: string;
  /** "María G." — first name plus last initial. The full name is contact data. */
  displayName: string;
  headline: string;
  summary: string;
  category: TalentCategory;
  skills: string[];
  certifications: string[];
  education: TalentEducationBlock[];
  experience: TalentExperienceBlock[];
  languages: TalentLanguageBlock[];
  yearsBucket: TalentYearsBucket;
  availability: TalentAvailability;
  /** City / state / country only — never finer than a commute. */
  city: string | null;
  state: string | null;
  country: string | null;
  /**
   * The metro area the person's ZIP falls in, resolved at publish time.
   *
   * Public because it is strictly COARSER than the city already above it — a
   * CBSA is several counties — and because it is the label the map and the metro
   * filter are built on. Null for a rural ZIP that belongs to no CBSA, and for
   * anyone outside the US; both are simply absent from a metro search rather
   * than being placed in the nearest one.
   */
  cbsaCode: string | null;
  cbsaTitle: string | null;
  /**
   * Where to put this person's pin on the map: the CENTROID OF THEIR ZIP AREA,
   * which is the same number the radius search already measures from.
   *
   * ── This is a real widening of the public shape, and it was decided ────────
   * Everything else on this type is at city granularity or coarser. This is
   * finer — it says which postal area of the city, roughly a five-mile answer.
   * Three things make it acceptable, and all three have to keep holding:
   *
   *   1. It is a ZIP-AREA CENTROID, never an address. We never ask for a street
   *      address, so there is nothing finer to leak. Everyone in one ZIP shares
   *      one identical coordinate, which is why the map draws ONE pin per ZIP
   *      area with a count on it rather than one pin per person — a pin is a
   *      postal area, and cannot single out a house.
   *   2. It is already derivable from what we publish. `distanceMiles` comes
   *      back on every radius search, so three searches from three ZIPs
   *      trilaterate this exact point. Publishing it discloses nothing new; it
   *      stops pretending the number is hidden.
   *   3. It is the purpose the ZIP was collected for. The funnel asks for a ZIP
   *      so employers can find people near them, and `PublishDialog` says the
   *      listing shows the person's area before anyone opts in.
   *
   * Null whenever the ZIP is unknown or non-US — the same population that is
   * absent from radius search, and they are absent from the map too rather than
   * being drawn somewhere plausible.
   */
  latitude: number | null;
  longitude: number | null;
  publishedAt: string;
  /**
   * How far this person is from the SEARCHER, in miles. Present only on radius
   * search results; the projection never sets it, because it is a property of a
   * query and not of a person.
   *
   * Measured between ZIP-area centroids, so treat it as "roughly this far", not
   * as a distance to anybody's door — see `latitude` on `PersonalInformation`.
   */
  distanceMiles?: number | null;
}

/**
 * The other half. Lives in `talent_contacts`, a table with RLS on and no
 * policies, and only ever leaves the database through `talent_reveal_contact`,
 * which writes an audit row in the same statement.
 */
export interface TalentContact {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  linkedInUrl: string | null;
  /** Storage object path — turned into a short-lived signed URL at reveal time. */
  resumePdfPath: string | null;
  /**
   * The rendered résumé HTML, snapshotted at publish time — what the employer
   * preview frames, because iOS Safari will not render a PDF inside an iframe.
   *
   * A SNAPSHOT and not a live read of `funnel.resume_html`: the listing is a
   * projection taken at publish time and `resumePdfPath` is already a snapshot
   * pointer, so reading the current résumé here would let the preview and the
   * download disagree the moment someone regenerates without re-publishing.
   *
   * Null for listings published before `0015`, and for a résumé with no stored
   * HTML — the route falls back to framing the PDF.
   */
  resumeHtml: string | null;
}

/** What `talent_projection.ts` returns: the two halves, separated at the type level. */
export interface TalentProjection {
  public: TalentProfilePublic;
  contact: TalentContact;
}

/** One search result page. `total` is what drives the pager. */
export interface TalentSearchResult {
  profiles: TalentProfilePublic[];
  total: number;
}

/** Filters a search may narrow by — see the discipline note in `taxonomy.ts`. */
export interface TalentSearchFilters {
  query?: string | null;
  category?: TalentCategory | null;
  availability?: TalentAvailability | null;
  /**
   * Origin of a radius search. Both set => results are limited to
   * `radiusMiles` around this point and ordered nearest-first. Both absent =>
   * no distance filter at all, which is also what anyone without a US ZIP needs,
   * since they have no coordinates to be found by.
   *
   * City and state text filters were REMOVED when this arrived: keeping both
   * would leave the brittle behaviour (typing "Houston" misses everyone in
   * Katy, Pasadena and Sugar Land) that proximity exists to replace.
   */
  latitude?: number | null;
  longitude?: number | null;
  radiusMiles?: number | null;
  /**
   * A CBSA code, from the metro autocomplete. Strict equality against the code
   * denormalized onto the listing at publish time — no radius, no merge.
   *
   * It composes with the radius filter rather than replacing it: the metro
   * answers "who is in this labour market", the radius answers "who is within
   * this drive of me", and an employer who sets both means the intersection.
   * Deliberately kept as two controls — see the Step 5 note in
   * `docs/talent-metro-search.md` for why the metro is not quietly widened by a
   * radius of its own.
   */
  cbsaCode?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * Where a published profile sits, as stored on the listing row.
 *
 * The coordinates are now ALSO on `TalentProfilePublic` — the map needs them —
 * so this type is no longer "the private half of the location". What stays
 * private is `postalCode`: the map has no use for the ZIP string itself, and
 * although a centroid and a ZIP carry the same information, a bare ZIP column is
 * the shape that ends up in a spreadsheet. See the note on
 * `TalentProfilePublic.latitude`.
 */
export interface TalentLocation {
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Resolved from the ZIP at publish time by `lib/geo/cbsa-lookup.ts`. */
  cbsaCode: string | null;
  cbsaTitle: string | null;
}

/**
 * The OWNER's view of their own listing: the public projection plus the
 * lifecycle fields only they (and the server) may see.
 *
 * `manageToken` is here and deliberately not on `TalentProfilePublic` — it is
 * the credential that can take a listing down, so it travels with the contact
 * record, in a table no anonymous role can read.
 */
export interface TalentListing {
  id: string;
  funnelId: string;
  status: TalentProfileStatus;
  expiresAt: string;
  manageToken: string;
  profile: TalentProfilePublic;
}

/**
 * The demand side. Still no account: `id` is the guest `auth.users` id that
 * `resolveUserId()` mints, so an employer is just a session that has told us who
 * it is. Recorded so a contact reveal is attributable to someone.
 */
export interface Employer {
  id: string;
  company: string;
  contactName: string;
  email: string;
  createdAt: string;
}
