import "server-only";
import { getEnv } from "@/lib/env";
import { AzureOpenAIProvider, type CallSpendRecorder } from "./azure-openai-provider";
import type { RequestDeadline } from "@/lib/request-deadline";
import { HybridAIProvider } from "./hybrid-provider";
import { MockAIProvider } from "./mock-provider";
import type { AIProvider } from "./provider";

export type { CallSpendRecorder } from "./azure-openai-provider";
export type {
  AIProvider,
  QuestionCandidate,
  PlanQuestionParams,
  NormalizeAnswerParams,
  SuggestSkillsParams,
  ResumeGenerationInput,
} from "./provider";

let cached: AIProvider | null = null;
let funnelCached: AIProvider | null = null;

/*
 * ── Why a spend recorder means a fresh provider ───────────────────────────────
 *
 * A ledger row has to name the user and the résumé the call belongs to, and those
 * are per REQUEST — so a provider carrying a recorder cannot be a process-wide
 * singleton. Passing `spend` therefore skips the cache and builds one for this
 * request; the cached path stays for callers with nothing to attribute (tests, the
 * worst-case harness).
 *
 * The cost is one `new OpenAI({...})` per request, which is a config wrapper around
 * global fetch — no socket, no handshake. The alternative was threading a context
 * argument through every `AIProvider` method, which would put request plumbing into
 * an interface whose whole job is to be swappable for a mock.
 */

/**
 * The configured AI provider (Azure OpenAI when enabled, else mock). Used ONLY for
 * resume generation + analysis (end of funnel + each regenerate).
 */
export function getAIProvider(spend?: CallSpendRecorder, deadline?: RequestDeadline): AIProvider {
  // Only the dependency-free provider is cached process-wide: one carrying a
  // request's spend recorder or its deadline must never outlive that request.
  if (!spend && !deadline && cached) return cached;
  const env = getEnv();
  const provider: AIProvider =
    env.AI_PROVIDER === "azure"
      ? new AzureOpenAIProvider(
          env.AZURE_OPENAI_API_KEY!,
          env.AZURE_OPENAI_BASE_URL!,
          env.AZURE_OPENAI_MODEL,
          spend,
          deadline,
        )
      : new MockAIProvider();
  if (!spend && !deadline) cached = provider;
  return provider;
}

/**
 * The FUNNEL provider used for per-step operations (answer normalization, skill
 * suggestion, next-question planning, entry enrichment).
 *
 * - AI_PROVIDER=mock  → pure deterministic mock (offline, tests, zero tokens).
 * - AI_PROVIDER=azure → a HybridAIProvider: the model parses the narrative sections
 *   that most affect résumé quality, while cheap ops (question planning, skill
 *   inference, simple-field normalization) stay on the mock to limit token spend.
 *
 * Which sections those are is decided in ONE place — `RICH_CAPTURE_SECTIONS` in
 * `lib/ai/hybrid-provider.ts`. Deliberately not restated here: the copy that used to
 * be was missing education and certifications, so the two comments described
 * different products.
 */
export function getFunnelProvider(spend?: CallSpendRecorder, deadline?: RequestDeadline): AIProvider {
  if (!spend && !deadline && funnelCached) return funnelCached;
  const env = getEnv();
  const provider: AIProvider =
    env.AI_PROVIDER === "azure"
      ? new HybridAIProvider(
          new AzureOpenAIProvider(
            env.AZURE_OPENAI_API_KEY!,
            env.AZURE_OPENAI_BASE_URL!,
            env.AZURE_OPENAI_MODEL,
            spend,
            deadline,
          ),
          new MockAIProvider(),
        )
      : new MockAIProvider();
  if (!spend && !deadline) funnelCached = provider;
  return provider;
}

/**
 * The deterministic provider, for when the budget is spent.
 *
 * Handing this back keeps the funnel working with zero model calls: the person can
 * carry on answering and their raw words are still stored verbatim, which is what
 * the résumé is generated from later. See `lib/services/usage-guard.ts`.
 */
export function getDeterministicProvider(): AIProvider {
  return new MockAIProvider();
}

/** Test hook to inject a provider. */
export function __setAIProvider(provider: AIProvider | null): void {
  cached = provider;
}
