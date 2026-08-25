import "server-only";
import { z } from "zod";
import { BRAND_IDS, isBrandId } from "@/lib/brand/registry";
import { parseHostOverrides } from "@/lib/brand/resolve";

/**
 * Server-side environment configuration.
 *
 * This module is `server-only`: importing it from a client component is a build
 * error, which guarantees secrets (Azure OpenAI key, Supabase service role key,
 * Amplitude key) never reach the browser. Public values are also mirrored here
 * for server use; the browser reads them via `NEXT_PUBLIC_*` directly.
 */

/**
 * Online-only mode. When true, the offline-capable backends are rejected at
 * startup so the app can never boot without its external services:
 *   - AI_PROVIDER=mock       (the deterministic, offline mock)
 *   - PERSISTENCE=memory     (the in-process, no-database store)
 * This forces AI_PROVIDER=azure + PERSISTENCE=supabase, both of which
 * require a network connection. Paired with the runtime connectivity guard in
 * `middleware.ts`, it guarantees the product does not function offline.
 *
 * This is a hard build/runtime constant (not an env override) on purpose:
 * "cannot work offline" must not be defeatable by setting an environment
 * variable. Flip to `false` only to intentionally restore offline support
 * (e.g. to run the mock-based test suite as originally designed).
 */
const ONLINE_ONLY = true;
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    AI_PROVIDER: z.enum(["mock", "azure"]).default("mock"),
    /** Azure OpenAI resource key. Server-only; never exposed to the browser. */
    AZURE_OPENAI_API_KEY: z.string().optional(),
    /**
     * The **v1** endpoint of the Azure OpenAI resource, e.g.
     * `https://<resource>.cognitiveservices.azure.com/openai/v1`.
     *
     * The `/openai/v1` suffix matters: that surface speaks plain OpenAI wire
     * format, which is what lets the stock SDK talk to it with no `api-version`
     * parameter. A base URL without it will 404 on every call, so it is checked
     * here rather than at the first request.
     */
    AZURE_OPENAI_BASE_URL: z.string().url().optional(),
    /**
     * The **deployment name** on that resource — for Azure this is the deployment,
     * not the upstream model id, though they are usually named the same.
     */
    AZURE_OPENAI_MODEL: z.string().default("gpt-5.3-codex"),

    /**
     * Public base URL of this deployment, e.g. `https://rumbolatino.com`.
     *
     * Only used to build the links in employer verification and password-reset
     * emails, which have to be absolute and have to point at the host the
     * employer is actually using. Optional because it is normally derivable from
     * the request headers (`x-forwarded-host`); set it when a proxy rewrites
     * those, or when a preview deployment must send links to the real domain.
     *
     * Whatever it resolves to must ALSO be on Supabase's redirect allow-list
     * (Authentication → URL Configuration), or the link in the email lands on
     * the project's Site URL instead and the flow silently ends in the wrong
     * place.
     */
    NEXT_PUBLIC_SITE_URL: z.string().url().optional(),

    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    AMPLITUDE_API_KEY: z.string().optional(),

    PERSISTENCE: z.enum(["supabase", "memory"]).default("memory"),

    /**
     * Which PDF renderer to use — see `lib/resume/pdf-generator.ts`.
     *   auto        (default) serverless on Vercel/Lambda, full puppeteer elsewhere
     *   local       full `puppeteer` (devDependency; needs its ~300 MB Chromium)
     *   serverless  `puppeteer-core` + `@sparticuz/chromium`
     * Declared here so a typo fails at startup instead of at the first render,
     * which is the one place a PDF failure is hard to notice (the artifact writer
     * is best-effort and swallows it).
     */
    PDF_RENDERER: z.enum(["auto", "local", "serverless"]).default("auto"),

    /**
     * Marketing brand served when the request host matches no brand's `hosts` —
     * preview deploys (`*.vercel.app`), `localhost`, and single-brand hosting.
     * Leave unset to fall back to `FALLBACK_BRAND_ID`.
     *
     * Declared here so a typo fails at startup instead of silently serving the
     * wrong brand. Edge middleware still reads `process.env` directly (see
     * `brandEnv()` in `lib/brand/resolve.ts`) because this module is
     * `server-only` and cannot be imported there.
     */
    DEFAULT_BRAND: z
      .string()
      .optional()
      .refine((value) => value === undefined || isBrandId(value), {
        message: `DEFAULT_BRAND must be one of: ${BRAND_IDS.join(", ")}`,
      }),

    /**
     * Extra `host=brandId` pairs, comma-separated — points a campaign or staging
     * domain at a brand without a code change. Consulted before each brand's own
     * `hosts` list. Unparseable entries are ignored at resolution time; this
     * check only catches a value that parses to nothing at all, which always
     * means a mistake.
     */
    BRAND_HOST_OVERRIDES: z
      .string()
      .optional()
      .refine(
        (value) => value === undefined || Object.keys(parseHostOverrides(value)).length > 0,
        {
          message:
            "BRAND_HOST_OVERRIDES must be a comma-separated list of host=brandId pairs, " +
            `e.g. "cv.example.com=${BRAND_IDS[0]}"`,
        },
      ),

    /*
     * ── AI spend caps (USD) ────────────────────────────────────────────────
     *
     * Money, so these are environment config rather than code constants: the
     * right ceiling depends on the deployment's Azure agreement and traffic, and
     * raising one must not need a deploy. The REQUEST limits are code constants
     * instead — see `lib/rate-limit/policy.ts` for why.
     *
     * Defaults are deliberately tight. A worst-case résumé — five experiences,
     * every answer padded to its char limit, all three improvement rounds and a
     * proofread — estimates at roughly $0.65–0.80 on gpt-5.3-codex rates
     * (`wc-tmp/worstcase.test.ts` is the harness that measures it). A user's
     * FIRST résumé is never refused by the per-résumé or per-user cap, so a tight
     * number bounds iteration and abuse without withholding the actual product.
     */
    AI_SPEND_CAP_PROFILE_USD: z.coerce.number().positive().default(1),
    AI_SPEND_CAP_USER_USD: z.coerce.number().positive().default(2),
    /** UTC calendar day, matching what `ai_spend_state()` sums. */
    AI_SPEND_CAP_DAILY_USD: z.coerce.number().positive().default(50),
    /**
     * Escape hatch for local development: `off` skips every counter and cap.
     * Never set this in a deployed environment — it is the whole protection
     * against an unauthenticated visitor spending the Azure budget.
     */
    USAGE_LIMITS: z.enum(["on", "off"]).default("on"),

    // Test-only escape hatch: bypass Supabase auth for e2e runs.
    E2E_AUTH_BYPASS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (ONLINE_ONLY && env.AI_PROVIDER === "mock") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "AI_PROVIDER=mock is disabled: this app runs online-only and requires AI_PROVIDER=azure (+ AZURE_OPENAI_API_KEY, AZURE_OPENAI_BASE_URL)",
        path: ["AI_PROVIDER"],
      });
    }
    if (ONLINE_ONLY && env.PERSISTENCE === "memory") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PERSISTENCE=memory is disabled: this app runs online-only and requires PERSISTENCE=supabase (+ Supabase URL/keys)",
        path: ["PERSISTENCE"],
      });
    }
    if (env.AI_PROVIDER === "azure") {
      if (!env.AZURE_OPENAI_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AZURE_OPENAI_API_KEY is required when AI_PROVIDER=azure",
          path: ["AZURE_OPENAI_API_KEY"],
        });
      }
      if (!env.AZURE_OPENAI_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "AZURE_OPENAI_BASE_URL is required when AI_PROVIDER=azure " +
            "(e.g. https://<resource>.cognitiveservices.azure.com/openai/v1)",
          path: ["AZURE_OPENAI_BASE_URL"],
        });
      } else if (!/\/openai\/v1\/?$/.test(env.AZURE_OPENAI_BASE_URL)) {
        // Caught here rather than as a 404 on every AI call in production.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "AZURE_OPENAI_BASE_URL must end in /openai/v1 — that is the endpoint " +
            "that speaks the OpenAI wire format the SDK sends",
          path: ["AZURE_OPENAI_BASE_URL"],
        });
      }
    }
    if (env.PERSISTENCE === "supabase") {
      if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required when PERSISTENCE=supabase",
          path: ["NEXT_PUBLIC_SUPABASE_URL"],
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  // Treat blank env vars (common in copied .env files) as unset, so an empty
  // NEXT_PUBLIC_SUPABASE_URL="" doesn't fail `.url()` — it just means "not set".
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    raw[key] = value === "" ? undefined : value;
  }
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cache — used by tests that mutate process.env. */
export function resetEnvCache(): void {
  cached = null;
}
