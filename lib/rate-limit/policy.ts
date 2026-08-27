/**
 * What counts as too much, and how the counter is keyed.
 *
 * ── Why these are code constants, not env vars ───────────────────────────────
 * A request limit encodes a claim about how the product is legitimately used
 * ("the funnel is about forty questions, so a hundred answers an hour is already
 * generous"). That claim belongs next to the reasoning, in review, and under test
 * — the same argument `ONLINE_ONLY` and `MAX_RESUME_ITERATIONS` are constants for.
 * The SPEND caps are environment config instead, because those are money and vary
 * per deployment (see `lib/env.ts`).
 *
 * ── Why the numbers are generous ─────────────────────────────────────────────
 * The product's audience shares connections — a computer lab at an institute, a
 * cyber café, a family behind one NAT address — and the funnel is long enough that
 * a determined person legitimately re-answers, goes back, and regenerates. A limit
 * tuned to stop the last 1% of abuse would block real users, and blocking a learner
 * mid-résumé costs far more than the tokens it saves. These stop scripts, not
 * people.
 *
 * Pure module: no I/O, no env, no `server-only`, so the policy is unit-testable on
 * its own and the same table can be read from either side of the wire.
 */

/** Every operation that is counted. Adding one here is what makes it enforceable. */
export type LimitedOperation =
  /** Creating a new résumé. Keyed by IP: this is the one route that runs BEFORE an identity exists. */
  | "profile_create"
  /** One funnel answer. Cheap per call, but the model sees the narrative sections. */
  | "answer"
  /** Résumé generation — the expensive one (`reasoning.effort: high`). */
  | "generate"
  /** The critique behind the improvement loop. */
  | "analyze"
  /** Spelling/grammar pass at finalize. */
  | "proofread"
  /** Re-writing one section of an existing résumé. */
  | "regenerate_section"
  /** Model-assisted capture: interests extraction, entry enrichment, skill suggestion. */
  | "assist"
  /** Translating a finished résumé into another language. */
  | "translate"
  /** Rendering the PDF. No tokens, but it launches Chromium. */
  | "export_pdf"
  /** Publishing (or re-publishing) a profile to the talent directory. */
  | "talent_publish"
  /** One directory search. No tokens, but it is the enumeration surface. */
  | "directory_search"
  /** Unlocking one candidate's contact details. The scraping vector. */
  | "contact_reveal"
  /** Creating an employer account. Keyed by IP: it runs before an identity exists. */
  | "employer_register"
  /** One sign-in attempt. The password-guessing surface. */
  | "employer_login"
  /** Asking for a verification or password-reset email. Each one SENDS MAIL. */
  | "employer_email";

/**
 * How long a re-read of the same résumé by the same employer stays the same
 * disclosure, for `contact_reveal` accounting.
 *
 * Sixty minutes, matching that limit's own window, so the ceiling reads as
 * "forty DISTINCT people an hour" rather than "forty page loads an hour". Those
 * were the same number only if nobody ever reopened anything, and in practice
 * they were not: the résumé preview's "open in another tab" escape hatch is a
 * second request, so was a reload, and so was reopening a candidate after
 * looking at their profile page. An employer on iOS — where a PDF will not
 * render in an iframe and that escape hatch is the only way to read one — burned
 * the limit at twice the rate of one on a laptop, for the same work.
 *
 * This LOOSENS nothing about who can be reached: a first read of every new
 * person still costs one, which is the number that bounds a harvest. It stops
 * charging for looking twice at the same person, which was never the thing worth
 * bounding. `contact_reveals` still records every read — `is_repeat` marks which
 * were re-reads, so the log gained detail rather than losing it.
 *
 * Mirrored as `p_dedupe_minutes` at the call site in `talent_reveal_contact` and
 * `talent_recent_reveal_exists` (`0015`); the number itself lives only here.
 */
export const REVEAL_DEDUPE_MINUTES = 60;

export interface LimitRule {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Why this number — read this before changing it. */
  readonly reason: string;
}

const HOUR = 3600;

export const LIMITS: Record<LimitedOperation, LimitRule> = {
  profile_create: {
    limit: 60,
    windowSeconds: HOUR,
    reason:
      "Keyed by IP, and a whole classroom or family can share one. Sixty new résumés " +
      "an hour from a single address is beyond any real group, and still stops a script " +
      "from minting guest identities in bulk.",
  },
  answer: {
    limit: 150,
    windowSeconds: HOUR,
    reason:
      "The funnel is roughly forty questions and going back re-answers them, so a real " +
      "session lands well under a hundred. Above 150/hour nobody is typing.",
  },
  generate: {
    limit: 12,
    windowSeconds: HOUR,
    reason:
      "MAX_RESUME_ITERATIONS is 3, so a complete résumé needs four generations. Twelve " +
      "leaves room to retry a failure and to edit-and-regenerate, and still bounds the " +
      "most expensive call in the product.",
  },
  analyze: {
    limit: 20,
    windowSeconds: HOUR,
    reason:
      "The critique is cached until the résumé or its facts change, so a real session " +
      "makes about four. Twenty absorbs cache misses from reloading the workspace.",
  },
  proofread: {
    limit: 10,
    windowSeconds: HOUR,
    reason: "Runs once at finalize; the rest is retries and re-finalizing after an edit.",
  },
  regenerate_section: {
    limit: 30,
    windowSeconds: HOUR,
    reason:
      "Deliberately the loosest paid limit: fixing one section is the cheapest way to " +
      "improve a résumé, so it should not be the thing that stops.",
  },
  assist: {
    limit: 60,
    windowSeconds: HOUR,
    reason: "Small model calls attached to editing, so tied to typing speed rather than intent.",
  },
  translate: {
    limit: 10,
    windowSeconds: HOUR,
    reason:
      "Runs once per résumé, after finalize, and again only if the person changes " +
      "the Spanish version and asks for a fresh translation. Ten covers retries and " +
      "a few rounds of edit-then-re-translate; nobody needs an eleventh in an hour.",
  },
  export_pdf: {
    limit: 40,
    windowSeconds: HOUR,
    reason:
      "No tokens, but each one may cold-start Chromium — which is CPU, a 60s function " +
      "ceiling, and the easiest way to exhaust concurrency.",
  },
  talent_publish: {
    limit: 20,
    windowSeconds: HOUR,
    reason:
      "Publishing is idempotent per résumé — it updates one row — so a person needs a " +
      "handful at most: publish, fix a category, re-publish after an edit. Twenty is " +
      "generous for that and still bounds a script rewriting a listing in a loop.",
  },
  directory_search: {
    limit: 300,
    windowSeconds: HOUR,
    reason:
      "Browsing is the point, and an employer filtering through a category legitimately " +
      "makes dozens of requests. This is not the control that stops scraping — the page " +
      "size is capped inside `talent_search` and the results carry no contact data at " +
      "all — it only stops a crawler from becoming a load problem.",
  },
  contact_reveal: {
    limit: 40,
    windowSeconds: HOUR,
    reason:
      "THE limit that matters. Every hit hands out a real person's phone number, so this " +
      "is the only rate limit here protecting people rather than infrastructure. A " +
      "recruiter shortlists a handful in a sitting; forty an hour is well past any honest " +
      "session and far short of a useful harvest. Keyed by the employer ACCOUNT, so changing " +
      "networks does not reset it, and it is the ONLY ceiling left on bulk collection — " +
      "lowering it is cheap, raising it is a real decision. Note that PREVIEWING a résumé " +
      "spends one of these too (`?inline=1` on the same route): it is the same bytes and the " +
      "same disclosure, and a cheaper preview would be a way around this number. What it no " +
      "longer spends is a RE-READ of a résumé this employer already opened — see " +
      "REVEAL_DEDUPE_MINUTES, which is what makes forty mean forty people.",
  },
  employer_register: {
    limit: 10,
    windowSeconds: HOUR,
    reason:
      "One person needs one account. Ten allows for typos in the email, a colleague on the " +
      "same office address, and re-registering after abandoning an unverified attempt. " +
      "Keyed by IP because this route runs before there is an account to key on — the same " +
      "position `profile_create` is in.",
  },
  employer_login: {
    limit: 20,
    windowSeconds: HOUR,
    reason:
      "This is the password-guessing surface, and the only limit standing in front of it. " +
      "Twenty is several honest attempts at a forgotten password and nowhere near enough " +
      "for a dictionary. Keyed by IP for the same reason as registration: a failed login " +
      "has no session, so an attacker would otherwise be counting against nobody. Note " +
      "that a shared office address shares this bucket — that is the accepted cost of not " +
      "letting the counter be reset by changing the email in the form.",
  },
  employer_email: {
    limit: 6,
    windowSeconds: HOUR,
    reason:
      "The tightest limit in the table, because every hit SENDS AN EMAIL from our domain to " +
      "an address someone else typed. Loose limits here turn the resend and reset buttons " +
      "into a way to mail-bomb a third party and to burn the sending reputation the " +
      "verification link depends on. Six covers a link lost to a spam folder, twice, and " +
      "a password reset in the same hour. Supabase enforces its own send limits under " +
      "this, which is a backstop and not a substitute — see the note in `.env.example`.",
  },
};

/**
 * The counter key. Format `<scope>:<id>:<operation>`, one row per key in
 * `rate_limits`.
 *
 * IP scope exists only for `profile_create`, the single route that runs before
 * there is a user to attribute anything to. Everywhere else the key is the user,
 * because an IP is shared by people who should not share a quota.
 */
export function rateLimitKey(
  operation: LimitedOperation,
  subject: { userId?: string | null; ip?: string | null },
): string {
  if (subject.userId) return `user:${subject.userId}:${operation}`;
  // No user and no IP: one shared bucket rather than no limit at all. A proxy that
  // strips the client address must not become a way to opt out of counting.
  return `ip:${subject.ip || "unknown"}:${operation}`;
}

/** True when this hit count is over the operation's allowance. */
export function isOverLimit(operation: LimitedOperation, hits: number): boolean {
  return hits > LIMITS[operation].limit;
}

/**
 * The client's address, best effort.
 *
 * `x-forwarded-for` is a comma-separated chain and the LEFTMOST entry is the
 * original client; every proxy appends its own. Trusting the rightmost would key
 * every request to the same edge address and make one shared bucket out of the
 * whole internet.
 *
 * A client can forge this header, so an IP limit is a speed bump, not a wall — it
 * exists to bound guest-identity creation, and the per-user limits and spend caps
 * are what actually hold once an identity exists.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || null;
}
