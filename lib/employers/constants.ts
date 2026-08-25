/**
 * Constants shared between the edge and the server.
 *
 * Its own module, and deliberately import-free, for the same reason
 * `lib/brand/constants.ts` is: `middleware.ts` runs on the EDGE runtime, where
 * `next/headers` does not exist and a `server-only` module is a build error.
 * Reaching into `lib/employers/session.ts` for this string would drag the
 * service-role client and the whole env schema into the edge bundle.
 */

/**
 * The employer session's cookie name.
 *
 * Namespaced away from the default Supabase cookie so the two roles cannot
 * evict each other: an employer signing in must not replace a job seeker's guest
 * session, which is the ONLY handle on their in-progress résumé and has no
 * recovery path. See the long note in `lib/employers/session.ts`.
 *
 * `@supabase/ssr` chunks large sessions into `<name>.0`, `<name>.1`, so callers
 * matching cookies must match this as a PREFIX, never for equality.
 */
export const EMPLOYER_COOKIE_NAME = "mcv-empleador-auth";
