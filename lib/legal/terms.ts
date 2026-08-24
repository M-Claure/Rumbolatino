/**
 * Terms & conditions / privacy notice consent.
 *
 * We link to Aprende's official "Aviso de privacidad" (the canonical, always-
 * current page) rather than embedding a snapshot that could drift. The checkbox
 * on the home page requires the user to accept it before starting the builder,
 * and `TERMS_VERSION` is recorded on the profile as proof-of-consent.
 *
 * This module is plain data only (no imports) so it is safe on both the client
 * (home-page checkbox/link) and the server (route that stamps the version).
 * The SERVER is the source of truth for the accepted version.
 *
 * When Aprende publishes a new version of the notice, bump `TERMS_VERSION` to
 * its new "fecha de entrada en vigencia" so stored consents stay meaningful.
 */

/** Effective date of the official aviso de privacidad currently in force. */
export const TERMS_VERSION = "2025-09-29";

/** Canonical, always-current privacy notice. Opened in a new tab. */
export const TERMS_URL = "https://aprende.com/avisos-de-privacidad/";

/** User-facing label for the notice (Spanish). */
export const TERMS_LABEL = "aviso de privacidad";

/**
 * Consent to PUBLISH a profile to the talent directory — a second, separate
 * consent, versioned independently of `TERMS_VERSION`.
 *
 * Two versions rather than one because the two acts differ in kind. Accepting
 * `TERMS_VERSION` gets you a private document. Accepting this one puts your
 * name, your city, your work history and a way to reach you somewhere employers
 * can search — and unlike a résumé you can delete from your phone, a published
 * listing is out of your hands the moment someone reads it.
 *
 * Bump this whenever what gets published, or who can see it, changes. A stored
 * consent names the version it was given against, so an old consent never
 * silently authorizes a new disclosure.
 */
export const PUBLISH_TERMS_VERSION = "2026-08-24";

/** User-facing label for the publish consent (Spanish). */
export const PUBLISH_TERMS_LABEL = "aviso de publicación de perfil";
