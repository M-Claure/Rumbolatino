import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { Errors } from "@/lib/errors";
import { UNLIMITED_DEADLINE, type RequestDeadline } from "@/lib/request-deadline";
import { estimateCostUsd, type UsageTokens } from "./pricing";
import type {
  AIProvider,
  AnalyzeResumeParams,
  ExtractInterestsParams,
  NormalizeAnswerParams,
  PlanQuestionParams,
  ProofreadResumeParams,
  ResumeGenerationInput,
  SuggestSkillsParams,
  TranslateResumeParams,
} from "./provider";
import {
  AnswerNormalizationSchema,
  InterestsExtractionSchema,
  PlannerDecisionSchema,
  ProofreadResultSchema,
  ResumeAnalysisSchema,
  ResumeContentSchema,
  SuggestedSkillSchema,
  TranslationResultSchema,
  type AnswerNormalization,
  type InterestsExtraction,
  type PlannerDecision,
  type ProofreadResult,
  type ResumeAnalysisPayload,
  type ResumeContent,
  type SuggestedSkillPayload,
  type TranslationResult,
} from "./schemas";
import {
  SYSTEM_FACTUALITY,
  SYSTEM_FACTUALITY_TRANSLATION,
  buildAnalysisPrompt,
  buildInterestsExtractionPrompt,
  buildNormalizerSystemPrompt,
  buildNormalizerUserPrompt,
  buildPlannerPrompt,
  buildProofreadPrompt,
  buildResumeGenerationPrompt,
  buildSkillSuggestionPrompt,
  buildTranslationPrompt,
  buildTranslationSystemPrompt,
} from "./prompts";

/**
 * How much reasoning one operation is allowed to spend.
 *
 * Reasoning tokens are billed at OUTPUT rates and are never read back (the
 * summary is not requested), so this is the main cost dial in the file.
 *
 * `gpt-5.3-codex` accepts `none | low | medium | high | xhigh`. `none` really does
 * mean none — a probe against the configured deployment returned
 * `output_tokens_details.reasoning_tokens: 0` — which makes it the exact
 * equivalent of the disabled-thinking budget this file used before the move off
 * Anthropic.
 */
interface CallBudget {
  effort: "none" | "low" | "medium" | "high";
}

/**
 * Extraction, classification and correction: read the input, fill the fields.
 * No reasoning at all — there is no multi-step problem to work through, and the
 * JSON these calls return is small and tightly constrained by its schema.
 */
const MECHANICAL: CallBudget = { effort: "none" };

/**
 * The résumé itself — the one output the whole product is judged on. Highest
 * effort.
 *
 * `medium` was tried here as a cost saving and gave visibly thinner résumés, so it
 * was reverted: this call is ~1 of 20 per résumé, and the savings were never worth
 * the quality. The savings that stuck are on the mechanical funnel calls, which
 * cannot affect prose quality (see MECHANICAL).
 */
const AUTHORED: CallBudget = { effort: "high" };

/**
 * Judgement about an already-written résumé: the critique and its follow-up
 * questions. `medium` — the output is bounded to five questions, and this is not
 * the text the person walks away with.
 */
const CONSIDERED: CallBudget = { effort: "medium" };

/** Ceiling a retry may grow into, and the factor it grows by per truncation. */
const MODEL_MAX_TOKENS = 32000;
const TRUNCATION_HEADROOM = 1.75;

/*
 * ── Time budget ─────────────────────────────────────────────────────────────
 *
 * Every route that reaches the model declares `maxDuration = 60`. Past that the
 * platform kills the function and answers **504** — with no JSON envelope, so
 * `lib/client/api.ts` can only report a bare "Error 500/504", and no server log
 * line of our own explains it. Tokens already spent are still billed.
 *
 * The SDK's own defaults are an order of magnitude outside that box (a 600s
 * request timeout and 2 silent retries), and `callJson` loops up to 3 times on
 * top of that, each truncation retry granted *more* room and therefore slower
 * than the last. So the loop needs a wall-clock bound.
 *
 * That bound is the REQUEST's clock, not a constant of this file's own. A fixed
 * allowance measured from the moment `callJson` is entered cannot see the time
 * the invocation had already spent booting the runtime, authenticating and
 * reading the profile — which on a cold start is most of the difference between
 * a request that fits and one that gets killed. `RequestDeadline` is that shared
 * clock; see `lib/request-deadline.ts`.
 */
/** Floor for a first attempt: below this, try anyway — refusing is a certain failure. */
const MIN_ATTEMPT_MS = 6_000;
/**
 * Held back from every call so the CALLER can still act on the answer. A
 * generation that spends the last millisecond of the invocation inside the model
 * has bought nothing: source-tracing, the HTML render and `createGeneratedResume`
 * all run after this returns, and without them the résumé the user paid for is
 * never written down. The Chromium render is NOT covered here — it is far larger
 * and decides for itself whether it fits (`lib/resume/resume-artifacts.ts`).
 */
const RESULT_RESERVE_MS = 6_000;
/** Below this much time left, a RETRY cannot finish — don't start it. */
const MIN_RETRY_MS = 8_000;
/**
 * Backoff after a *transport* failure, multiplied by the attempt number. Small:
 * the deadline leaves room for roughly two attempts, so this is here to stop an
 * instant re-hit of a throttled deployment, not to wait one out. Nothing is
 * gained by sleeping on a schema failure, so only the catch path uses it.
 */
const BACKOFF_MS = 500;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Real Azure-OpenAI-backed provider. Every call:
 *  1. sends the factuality instructions + a task prompt,
 *  2. extracts JSON from the response,
 *  3. validates against the task's Zod schema (retrying once on failure),
 *  4. throws an ai_validation_error if the model still won't conform.
 *
 * The model is never given database access or tools that mutate state.
 *
 * Talks to the Azure OpenAI **v1** surface (`…/openai/v1`) with the stock OpenAI
 * SDK: that endpoint speaks plain OpenAI wire format, so no `api-version` query
 * parameter and no Azure-specific client are needed. Requests go to the
 * **Responses** API, which is the only surface the `*-codex` models are served on.
 */
export class AzureOpenAIProvider implements AIProvider {
  readonly name = "azure-openai";
  private client: OpenAI;

  /**
   * @param spend Optional sink for what each call cost. Injected rather than
   *   imported so this class keeps no knowledge of the database and stays
   *   constructible in a test — the same reason `generateResume` takes a
   *   `ResumeArtifactWriter`. Provided per request by `getRequestContext`, since the
   *   ledger row needs the user and profile this call belongs to. Absent in the
   *   worst-case harness and in unit tests, where nothing should be recorded.
   */
  constructor(
    apiKey: string,
    baseURL: string,
    private readonly model: string,
    private readonly spend?: CallSpendRecorder,
    /**
     * This invocation's shared clock. Injected per request (like `spend`) rather
     * than read from a global, so a unit test can construct the provider without
     * a serverless runtime around it. Defaults to unlimited for those callers.
     */
    private readonly deadline: RequestDeadline = UNLIMITED_DEADLINE,
  ) {
    // No client-level timeout: the real one is per-request and comes from the
    // deadline, since how long a call may take depends on when in the invocation
    // it starts. `maxRetries: 0` is deliberate, not a loss of resilience —
    // `callJson` already retries and is the only layer that can see the deadline.
    // Nested retries multiplied (3 app attempts x 3 SDK attempts) with the backoff
    // invisible to the log, so a throttled deployment looked like one slow call.
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  }

  /*
   * ── Reasoning effort, per operation ─────────────────────────────────────────
   *
   * Omitting `reasoning` lets the deployment's own default decide, and reasoning
   * is billed at output rates — the expensive half of the bill. Worse, nothing
   * here ever reads a reasoning summary, so those tokens would be paid for and
   * thrown away.
   *
   * So each operation declares what it needs:
   *   - Mechanical extraction and correction (normalize an answer, pull interests
   *     out of a sentence, fix accents) get NO reasoning. There is no multi-step
   *     thinking in "which field does this sentence fill".
   *   - Writing and judgement (the résumé itself, the critique) keep it, at high
   *     and medium respectively.
   *
   * `max_output_tokens` is sized to the JSON each call actually returns plus room
   * for the reasoning the call is allowed to do — it is a combined ceiling over
   * reasoning + visible output, so a large budget invites deeper reasoning than
   * these tasks need.
   */
  async planNextQuestion(params: PlanQuestionParams): Promise<PlannerDecision> {
    return this.callJson(buildPlannerPrompt(params), PlannerDecisionSchema, 1536, "plan-question", MECHANICAL);
  }

  async normalizeAnswer(params: NormalizeAnswerParams): Promise<AnswerNormalization> {
    /*
     * Sent as two halves: the instructions and this section's schema go in
     * `instructions`, the question and the person's answer in `input`.
     *
     * That ordering is what makes the instructions reusable. Prompt caching matches
     * on a prefix, and the old single-string prompt opened with the answer, so every
     * one of the ~26 normalizer calls per résumé had a unique prefix and nothing
     * could ever be reused. Now every call in a section shares a byte-identical
     * prefix.
     *
     * On this API that saving is automatic — there are no cache markers to place,
     * the platform caches long prefixes by itself and bills the reuse at a
     * discount. `[ai-usage]` prints `cached` so you can confirm it is landing.
     */
    return this.callJson(
      buildNormalizerUserPrompt(params),
      AnswerNormalizationSchema,
      2048,
      "normalize-answer",
      MECHANICAL,
      { stableInstructions: buildNormalizerSystemPrompt(params.section) },
    );
  }

  async suggestSkills(params: SuggestSkillsParams): Promise<SuggestedSkillPayload[]> {
    return this.callJson(buildSkillSuggestionPrompt(params), z.array(SuggestedSkillSchema).max(20), 1536, "suggest-skills", MECHANICAL);
  }

  async extractInterests(params: ExtractInterestsParams): Promise<InterestsExtraction> {
    return this.callJson(buildInterestsExtractionPrompt(params), InterestsExtractionSchema, 1024, "extract-interests", MECHANICAL);
  }

  async generateResumeContent(input: ResumeGenerationInput): Promise<ResumeContent> {
    // The one call whose quality the whole product rests on: full effort.
    return this.callJson(buildResumeGenerationPrompt(input), ResumeContentSchema, 16000, "generate-resume", AUTHORED);
  }

  async analyzeResume(params: AnalyzeResumeParams): Promise<ResumeAnalysisPayload> {
    return this.callJson(buildAnalysisPrompt(params), ResumeAnalysisSchema, 6000, "analyze-resume", CONSIDERED);
  }

  async proofreadResume(params: ProofreadResumeParams): Promise<ProofreadResult> {
    // Spelling, accents and punctuation over text that is already written.
    return this.callJson(buildProofreadPrompt(params), ProofreadResultSchema, 8000, "proofread-resume", MECHANICAL);
  }

  async translateResume(params: TranslateResumeParams): Promise<TranslationResult> {
    /*
     * MECHANICAL, like proofreading and for the same reason: there is no judgement
     * to make. The résumé is already written, already source-traced and already
     * approved by the person — this call swaps one language for another over text
     * that exists. Reasoning tokens bill at the OUTPUT rate ($10/1M) and are
     * discarded unread, so buying "thinking" here would multiply the cost of the
     * cheapest useful thing the product does.
     *
     * The task rules go in `stableInstructions` so the ~700-token prefix caches at
     * a tenth of the input rate; only the fragments vary between calls. Two
     * translations of the same résumé (a re-translate after an edit) therefore
     * share almost their entire input.
     */
    return this.callJson(
      buildTranslationPrompt(params),
      TranslationResultSchema,
      8000,
      "translate-resume",
      MECHANICAL,
      {
        stableInstructions: buildTranslationSystemPrompt(params.targetLanguage),
        // The default block orders the model to answer in Spanish, which is the one
        // rule a translation must not follow. Everything else about it still applies.
        system: SYSTEM_FACTUALITY_TRANSLATION,
      },
    );
  }

  // ── internals ──
  private async callJson<S extends z.ZodTypeAny>(
    prompt: string,
    schema: S,
    maxTokens: number,
    label: string,
    budget: CallBudget,
    options: {
      /**
       * Task instructions that do NOT vary with the input, appended to the factuality
       * rules. Kept separate from `prompt` so the stable text forms a cacheable prefix.
       */
      stableInstructions?: string;
      /**
       * Replaces the default factuality block. Only translation needs this — its
       * output is not Spanish, and `SYSTEM_FACTUALITY` mandates that it is. Any
       * replacement must still carry the truthfulness rules; compose it from
       * `FACTUALITY_RULES` in prompts.ts rather than writing a fresh one.
       */
      system?: string;
    } = {},
  ): Promise<z.infer<S>> {
    const { stableInstructions, system = SYSTEM_FACTUALITY } = options;
    let lastError: unknown;
    let truncations = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Time left in the INVOCATION, not in some allowance of this call's own.
      const remainingMs = this.deadline.remainingMs();
      // A retry that cannot finish trades a reportable error for a 504 and bills
      // the tokens anyway. The first attempt always runs: with little time left it
      // is a long shot, but refusing outright is a certain failure.
      if (attempt > 0 && remainingMs < MIN_RETRY_MS) {
        console.error(
          `[ai] ${label}: out of time after ${attempt} attempt(s); ${remainingMs}ms left in this request`,
        );
        break;
      }
      const content =
        attempt === 0
          ? prompt
          : `${prompt}\n\nTu respuesta anterior no era JSON válido según el esquema. Devuelve SOLO el JSON válido.`;
      // A truncated response is not a wrong response — it is the same response with
      // no room to finish. Retrying at the SAME ceiling truncates again and bills
      // again, so each retry after a truncation gets more room instead.
      const attemptMaxTokens = Math.min(
        Math.round(maxTokens * TRUNCATION_HEADROOM ** truncations),
        MODEL_MAX_TOKENS,
      );
      let text: string;
      try {
        const res = await this.client.responses.create({
          model: this.model,
          // Stable text first (factuality rules, then task instructions), variable
          // input last — the order prompt caching needs.
          instructions: stableInstructions ? `${system}\n\n${stableInstructions}` : system,
          input: content,
          max_output_tokens: attemptMaxTokens,
          reasoning: { effort: budget.effort },
          // Do not let the Azure resource retain the response bodies: they contain
          // the person's own words about their work history.
          store: false,
        }, Number.isFinite(remainingMs)
          ? { timeout: Math.max(remainingMs - RESULT_RESERVE_MS, MIN_ATTEMPT_MS) }
          : {});
        // Log real token usage + estimated cost for every call (even truncated
        // retries, which still bill). This is what makes per-generation cost
        // visible in the server logs.
        logUsage(label, this.model, res.usage, attempt);
        // ...and charge it against the spend caps. A truncated retry billed just as
        // much as a successful call, so it is recorded too: a cap that only counted
        // successes would undercount exactly the failure mode that burns tokens
        // fastest. Fire-and-forget — see `CallSpendRecorder`.
        this.spend?.(label, this.model, res.usage);
        text = res.output_text;
        // Truncation → the JSON is incomplete and will never parse. Surface a
        // clear cause in the error details (visible in the API error envelope)
        // and let the retry loop try again with more room to finish.
        if (res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens") {
          truncations += 1;
          lastError = new Error(
            `Respuesta truncada por max_output_tokens (max_output_tokens=${attemptMaxTokens}); el JSON quedó incompleto.`,
          );
          // No headroom left to grant: another attempt would truncate identically.
          if (attemptMaxTokens >= MODEL_MAX_TOKENS) break;
          continue;
        }
      } catch (err) {
        // A misconfiguration is not a bad model response: retrying cannot fix it,
        // and reporting it as one sends whoever debugs it looking at prompts and
        // Zod schemas instead of at the API key. Fail on the first attempt with
        // the real cause in the server log and in the error `details`.
        const misconfigured = describeConfigurationFailure(err, this.model);
        if (misconfigured) {
          console.error(`[ai] ${label}: ${misconfigured}`);
          throw Errors.serviceUnavailable(
            "No pudimos conectar con el servicio de IA. No es tu culpa: avísanos para revisarlo.",
            { label, cause: misconfigured },
          );
        }
        lastError = err;
        // With `maxRetries: 0` the SDK no longer backs off on our behalf, and
        // firing the next attempt immediately into a 429 or an overloaded
        // deployment just buys the same error twice. Bounded so the sleep can
        // never eat the room the next attempt needs — which it re-checks anyway.
        await sleep(
          Math.min(BACKOFF_MS * (attempt + 1), Math.max(0, this.deadline.remainingMs() - MIN_RETRY_MS)),
        );
        continue;
      }
      const parsed = tryParseJson(text);
      if (parsed === undefined) {
        lastError = new Error("Model did not return JSON");
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = result.error;
    }
    // Distinguish "the model was too slow" from "the model returned nonsense".
    // Reported as the same ai_validation_error, they sent whoever debugged this
    // looking at Zod schemas for a problem that was entirely about latency.
    if (isTimeout(lastError)) {
      throw Errors.serviceUnavailable(
        "El servicio de IA tardó demasiado en responder. Vuelve a intentarlo en un momento.",
        { label, cause: String(lastError) },
      );
    }
    throw Errors.aiValidation("La IA no devolvió una respuesta válida.", String(lastError));
  }
}

/** Whether a failure was the clock rather than the model. */
function isTimeout(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIConnectionTimeoutError ||
    (err instanceof Error && /timed? ?out|aborted/i.test(err.message))
  );
}

/**
 * Names the failures that come from how this server is configured rather than
 * from what the model returned — an invalid/revoked key, a key without access to
 * the deployment, a deployment name that does not exist, a request the deployment
 * rejects outright. Returns null for everything a retry can plausibly fix (rate
 * limits, overloads, timeouts, 5xx).
 *
 * Kept as an explicit allow-list of statuses so a transient failure is never
 * mistaken for a permanent one and given up on.
 */
function describeConfigurationFailure(err: unknown, model: string): string | null {
  if (err instanceof OpenAI.AuthenticationError) {
    return "AZURE_OPENAI_API_KEY no es válida o fue revocada (401).";
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return `La AZURE_OPENAI_API_KEY no tiene permiso para usar el despliegue "${model}" (403).`;
  }
  if (err instanceof OpenAI.NotFoundError) {
    return (
      `AZURE_OPENAI_MODEL="${model}" no existe como despliegue en este recurso, o ` +
      `AZURE_OPENAI_BASE_URL apunta al recurso equivocado (404 DeploymentNotFound).`
    );
  }
  /*
   * A 400 is a request this deployment will never accept — an effort value it does
   * not support, a parameter it does not know, or input its content filter blocks.
   * None of those change on a retry, so they fail fast with the API's own words
   * rather than burning three calls and reporting "the model returned bad JSON".
   */
  if (err instanceof OpenAI.BadRequestError) {
    return `La API rechazó la petición (400): ${err.message}`;
  }
  return null;
}

/**
 * Sink for what one call cost.
 *
 * Deliberately a plain function of exactly what this class already has — the
 * operation label, the model, and the raw `usage` block — so the provider needs no
 * types from the persistence layer and cannot be tempted to await a database write
 * on the response path. Whoever supplies it decides where the number goes and is
 * responsible for never throwing.
 */
export type CallSpendRecorder = (
  label: string,
  model: string,
  usage: UsageTokens | undefined,
) => void;

/**
 * Per-process running total, so the cost of a whole résumé-builder session
 * (many calls) accumulates in the logs, not just per call.
 */
const usageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Log one API response's token usage + estimated cost with a running total. */
function logUsage(
  label: string,
  model: string,
  usage: UsageTokens | undefined,
  attempt: number,
): void {
  if (!usage) return;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  // Reasoning is billed at output rates but produces nothing we read, so it is
  // worth seeing on its own: a budget that drifted off `none` shows up here first.
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  const cost = estimateCostUsd(model, usage);

  usageTotals.calls += 1;
  usageTotals.inputTokens += input;
  usageTotals.outputTokens += output;
  if (cost != null) usageTotals.costUsd += cost;

  const costStr = cost != null ? `≈$${cost.toFixed(4)} (estimado)` : "(configura tarifas en lib/ai/pricing.ts)";
  const retry = attempt > 0 ? ` retry#${attempt}` : "";
  const total =
    `total sesión: ${usageTotals.calls} llamadas, ` +
    `in=${usageTotals.inputTokens} out=${usageTotals.outputTokens} ` +
    `costo≈$${usageTotals.costUsd.toFixed(4)}`;
  console.log(
    `[ai-usage] ${label}${retry} model=${model} in=${input} out=${output} ` +
      `reasoning=${reasoning} cached=${cached} costo=${costStr} | ${total}`,
  );
}

/** Extract a JSON value from model text, tolerating markdown fences / prose. */
function tryParseJson(text: string): unknown {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const candidates = [cleaned];
  const firstBrace = cleaned.search(/[[{]/);
  const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
