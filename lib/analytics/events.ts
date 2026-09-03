/**
 * Analytics event catalog (spec §18). Only funnel/behavioral data is tracked —
 * never raw resume answers or sensitive personal information.
 */
export const ANALYTICS_EVENTS = [
  "resume_funnel_started",
  "career_goal_completed",
  "personal_information_completed",
  "education_entry_added",
  "experience_entry_added",
  /**
   * A question was served to the client. Emitted wherever the funnel hands a
   * question to the UI, so exit rate per question can be computed as
   * shown − (answered + skipped) — the question a user abandons produces no
   * other event. A refresh re-serves the same question, so count DISTINCT
   * profiles per questionId rather than raw event volume.
   */
  "adaptive_question_shown",
  "adaptive_question_answered",
  "adaptive_question_skipped",
  "skill_suggested",
  "skill_confirmed",
  "skill_rejected",
  "profile_review_started",
  "resume_generation_started",
  "resume_generated",
  "resume_section_edited",
  "resume_proofread",
  "resume_finalized",
  /**
   * A PDF was rendered and written to storage, replacing the profile's previous
   * one. Emitted on every generation, not only on download — the gap between
   * this and `resume_generated` is the PDF save-failure rate.
   */
  "resume_pdf_stored",
  /**
   * The render was skipped because the invocation was about to run out of wall
   * clock — see `lib/resume/resume-artifacts.ts`. Deliberately distinct from a
   * failed save: nothing went wrong, the work was deferred to the download path.
   * A rising rate here means generations are running close to `maxDuration`.
   */
  "resume_pdf_skipped",
  "pdf_export_started",
  "resume_downloaded",
  /**
   * A user asked for the English version. The gap between this and
   * `resume_finalized` is the uptake rate that decides whether translating on
   * demand was the right call — see docs/english-resume.md.
   */
  "resume_translated",
  "funnel_abandoned",
  /**
   * The publish card was shown after finalization — the denominator for opt-in
   * rate. Emitted on display, not on consent.
   */
  "talent_publish_offered",
  "talent_profile_published",
  "talent_profile_unpublished",
  "talent_search",
  /**
   * An employer unlocked a candidate's contact details. Deliberately carries no
   * identifier for either side: `contact_reveals` in Postgres is the record of
   * WHO saw WHOM, and it is an access log rather than a product metric. What
   * belongs in analytics is only that a reveal happened.
   */
  "talent_contact_revealed",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/**
 * Allow-list of property keys that are safe to send. Anything not on this list
 * is dropped so raw answers / PII can never leak into analytics.
 */
export const SAFE_PROPERTY_KEYS = [
  "resumeProfileId",
  "currentSection",
  "section",
  "experienceType",
  "completenessScore",
  "readiness",
  "questionId",
  "userSegment",
  "deviceCategory",
  "timeSpentMs",
  "skipped",
  "skillCount",
  "inputType",
  "version",
  /** Nth time this question has been answered by this profile (1-based). */
  "attemptNumber",
  /**
   * Which language a résumé artifact was written in ("es" | "en"). A closed set of
   * two codes, so it carries nothing about the person — it distinguishes the
   * Spanish PDF from its translation in the pdf_stored/pdf_skipped counts.
   */
  "language",
  /**
   * Directory keys. Every one of these is a CLOSED SET defined in code — a
   * category id, an availability enum, a years bucket, a result count, a
   * boolean. None of them can carry free text.
   *
   * City and state are absent for the same reason: they are typed by hand in the
   * funnel, so they are not a closed set however much they look like one.
   *
   * Note what is deliberately absent: `query`. A directory search box is typed
   * into by hand, and people type names into search boxes — sending it would put
   * "maria gutierrez houston" into analytics through the one field on this list
   * that could hold it. The value of knowing what employers search for does not
   * outweigh that, and category plus state already answers the question that
   * actually drives product decisions.
   */
  "talentCategory",
  "availability",
  "yearsBucket",
  "resultCount",
  "hasQuery",
  /**
   * The CBSA code an employer filtered by — five digits from OMB's closed list
   * of ~930 metro areas, so it is the same kind of value as `talentCategory`
   * and cannot carry free text. The employer's TYPED words never come here:
   * `metro=Houston` is resolved against the reference table first, and only the
   * resolved code is sent, which is also why an ambiguous or unrecognised
   * search reports nothing at all rather than the string.
   *
   * It is the CITY-level demand signal `city`/`state` were rejected for being —
   * those are hand-typed by the job seeker, this is a lookup result.
   */
  "metroCode",
] as const;

export type AnalyticsProps = Partial<Record<(typeof SAFE_PROPERTY_KEYS)[number], string | number | boolean>>;

/** Drop any key not on the allow-list; coerce nothing, invent nothing. */
export function sanitizeProps(props: Record<string, unknown>): AnalyticsProps {
  const out: Record<string, string | number | boolean> = {};
  for (const key of SAFE_PROPERTY_KEYS) {
    const v = props[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return out;
}
