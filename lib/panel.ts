/**
 * Shared library module (panel.ts): domain logic used by API routes and UI.
 */

import { ModelId, ModelResult, ConnectorStatus } from "@/lib/types";
import { CONNECTOR_MAP } from "@/lib/connectors";
import { isSuspiciouslyShort } from "@/lib/textLimits";
import { callDeepSeek, DEEPSEEK_MODEL } from "@/lib/connectors/deepseek";
import { DEEPSEEK_API_KEY } from "@/lib/env";
import { getPanelModelConfig } from "@/lib/panelModels";
import { GROK_MODEL } from "@/lib/env";

type ApiKeys = Partial<Record<ModelId, string | undefined>>;

const isDev = () => process.env.NODE_ENV !== "production";

// ─── Actual model strings per modelId ─────────────────────────────────────

const ACTUAL_MODEL_STRINGS: Record<ModelId, string> = {
  chatgpt: "gpt-4o-mini",
  claude: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.0-flash",
  grok: GROK_MODEL || "grok-4-1-fast-reasoning",
  perplexity: "sonar",
};

// ─── Fallback allowlist ───────────────────────────────────────────────────

const DEFAULT_FALLBACK_PROVIDERS = ["openai", "anthropic", "google"];

function getDeepSeekFallbackAllowlist(): Set<string> {
  const envOverride = process.env.PANEL_DEEPSEEK_FALLBACK_FOR;
  if (envOverride && envOverride.trim().length > 0) {
    return new Set(envOverride.split(",").map(s => s.trim().toLowerCase()));
  }
  return new Set(DEFAULT_FALLBACK_PROVIDERS);
}

function isFallbackAllowed(modelId: ModelId): boolean {
  const provider = getPanelModelConfig(modelId).provider;
  return getDeepSeekFallbackAllowlist().has(provider);
}

// ─── Retry helpers ────────────────────────────────────────────────────────

const RETRYABLE_STATUSES: ConnectorStatus[] = ["timeout", "refused", "rate_limited"];

function isRetryableResult(result: ModelResult): boolean {
  if (result.status === "ok") return false;
  if (RETRYABLE_STATUSES.includes(result.status)) return true;
  const msg = (result.errorMessage ?? "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    /\b5\d{2}\b/.test(msg) ||
    msg.includes("server error")
  );
}

function isNonRetryable(result: ModelResult): boolean {
  const msg = (result.errorMessage ?? "").toLowerCase();
  return (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("auth") ||
    msg.includes("forbidden") ||
    msg.includes("request not allowed")
  );
}

function classifyPrimaryErrorCode(modelId: ModelId, result: ModelResult): string {
  const provider = getPanelModelConfig(modelId).provider;
  const msg = (result.errorMessage ?? "").toLowerCase();

  if (result.status === "timeout" || msg.includes("timeout")) {
    return `${provider}_timeout`;
  }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("exceeded your current quota") || msg.includes("billing details")) {
    return `${provider}_429`;
  }
  if (msg.includes("401")) return `${provider}_auth`;
  if (msg.includes("403") || msg.includes("forbidden") || msg.includes("request not allowed")) {
    return `${provider}_forbidden`;
  }
  if (/\b5\d{2}\b/.test(msg) || msg.includes("server error")) {
    return `${provider}_5xx`;
  }
  if (msg.includes("invalid") && msg.includes("json")) return `${provider}_invalid_json`;
  return `${provider}_error`;
}

// ─── Fallback eligibility ─────────────────────────────────────────────────

const NON_TRANSIENT_QUOTA_PHRASES = [
  "billing details",
  "exceeded your current quota",
  "please check your plan",
  "insufficient_quota",
];

function shouldAttemptDeepSeek(primaryCode: string, primaryResult: ModelResult): boolean {
  if (primaryCode.includes("_auth") || primaryCode.includes("_forbidden")) {
    return false;
  }
  if (primaryCode.includes("_429")) {
    const msg = (primaryResult.errorMessage ?? "").toLowerCase();
    if (NON_TRANSIENT_QUOTA_PHRASES.some(phrase => msg.includes(phrase))) {
      return false;
    }
  }
  return true;
}

// ─── Panel orchestration ──────────────────────────────────────────────────

/**
 * Run Panel Function
 *
 * CRITICAL GUARANTEE: Always returns exactly one result per selected model.
 * - Primary succeeds → status: "ok"
 * - Primary fails, DeepSeek succeeds → status: "substituted"
 * - Both fail or fallback not allowed → status: "failed"
 */
export async function runPanel(
  question: string,
  selectedModels: ModelId[],
  apiKeys: ApiKeys,
  context?: string | null
): Promise<ModelResult[]> {
  const normalizedQuestion = question.trim();
  const normalizedContext = context ? context.trim() : null;

  console.log("[runPanel] Selected models:", selectedModels);
  if (isDev()) {
    console.log("[runPanel] API keys present:", {
      chatgpt: Boolean(apiKeys.chatgpt),
      claude: Boolean(apiKeys.claude),
      grok: Boolean(apiKeys.grok),
      perplexity: Boolean(apiKeys.perplexity),
      gemini: Boolean(apiKeys.gemini),
      deepseek: Boolean(DEEPSEEK_API_KEY),
    });
    console.log("[runPanel] Fallback allowlist:", [...getDeepSeekFallbackAllowlist()]);
  }

  const settledResults = await Promise.allSettled(
    selectedModels.map((modelId) =>
      runSlotWithFallback(modelId, normalizedQuestion, normalizedContext, apiKeys)
    )
  );

  const results: ModelResult[] = settledResults.map((settled, index) => {
    const modelId = selectedModels[index];
    const provider = getPanelModelConfig(modelId).provider;
    const requestedModel = ACTUAL_MODEL_STRINGS[modelId] || modelId;

    if (settled.status === "fulfilled") {
      return settled.value;
    }

    console.error(`[runPanel] Promise rejected for model ${modelId}:`, settled.reason);
    return {
      modelId,
      status: "failed" as const,
      rawText: "Model unavailable.",
      errorMessage: String(settled.reason?.message || settled.reason || "Unexpected error"),
      latencyMs: 0,
      tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
      requestedModel,
      provider,
      actualModel: requestedModel,
    };
  });

  console.log(`[runPanel] All model calls completed. Results count: ${results.length}`);
  if (isDev()) {
    console.log(`[runPanel] Results summary:`, results.map(r => ({
      modelId: r.modelId,
      status: r.status,
      provider: r.provider,
      requestedModel: r.requestedModel,
      actualModel: r.actualModel,
      substitutedFrom: r.substitutedFrom,
    })));
  }

  // Safety: fill any missing models
  const resultModelIds = new Set(results.map(r => r.modelId));
  const missingModels = selectedModels.filter(id => !resultModelIds.has(id));
  if (missingModels.length > 0) {
    console.error(`[runPanel] ERROR: Missing results for models: ${missingModels.join(", ")}`);
    missingModels.forEach(modelId => {
      const provider = getPanelModelConfig(modelId).provider;
      const requestedModel = ACTUAL_MODEL_STRINGS[modelId] || modelId;
      results.push({
        modelId,
        status: "failed",
        rawText: "Model unavailable.",
        latencyMs: 0,
        tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
        requestedModel,
        provider,
        actualModel: requestedModel,
      });
    });
  }

  return selectedModels.map(modelId => results.find(r => r.modelId === modelId)!);
}

/**
 * Execute a single slot: primary → retry → DeepSeek fallback → failed placeholder.
 */
async function runSlotWithFallback(
  modelId: ModelId,
  question: string,
  context: string | null,
  apiKeys: ApiKeys
): Promise<ModelResult> {
  const connector = CONNECTOR_MAP[modelId];
  const provider = getPanelModelConfig(modelId).provider;
  const requestedModel = ACTUAL_MODEL_STRINGS[modelId] || modelId;

  if (!connector) {
    console.error(`[runPanel] No connector defined for modelId="${modelId}"`);
    return {
      modelId,
      status: "failed" as const,
      rawText: null,
      latencyMs: 0,
      requestedModel,
      provider,
      actualModel: requestedModel,
    };
  }

  const apiKey = apiKeys[modelId];

  // --- Primary attempt ---
  let primaryResult = await safePrimaryCall(connector, modelId, question, context, apiKey);

  if (primaryResult.status === "ok") {
    return applyShortCheck({
      ...primaryResult,
      requestedModel,
      provider,
      actualModel: requestedModel,
    });
  }

  // --- Retry logic (up to 2 retries for retryable errors) ---
  if (!isNonRetryable(primaryResult) && isRetryableResult(primaryResult)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (isDev()) console.log(`[runPanel] Retrying ${modelId} (attempt ${attempt}/2)`);
      primaryResult = await safePrimaryCall(connector, modelId, question, context, apiKey);
      if (primaryResult.status === "ok") {
        return applyShortCheck({
          ...primaryResult,
          requestedModel,
          provider,
          actualModel: requestedModel,
        });
      }
      if (isNonRetryable(primaryResult)) break;
      if (!isRetryableResult(primaryResult)) break;
    }
  }

  // --- Check fallback allowlist ---
  if (!isFallbackAllowed(modelId)) {
    if (isDev()) console.log(`[runPanel] Fallback not allowed for ${modelId} (provider: ${provider})`);
    return failedPlaceholder(modelId, primaryResult, "fallback_not_allowed");
  }

  // --- DeepSeek fallback ---
  const dsKey = DEEPSEEK_API_KEY;
  if (!dsKey) {
    if (isDev()) console.log(`[runPanel] No DEEPSEEK_API_KEY — skipping fallback for ${modelId}`);
    return failedPlaceholder(modelId, primaryResult, classifyPrimaryErrorCode(modelId, primaryResult));
  }

  const primaryCode = classifyPrimaryErrorCode(modelId, primaryResult);

  if (!shouldAttemptDeepSeek(primaryCode, primaryResult)) {
    if (isDev()) {
      console.log(`[runPanel] Skipping DeepSeek fallback for ${modelId} — non-transient primary failure: ${primaryCode}`);
    }
    return failedPlaceholder(modelId, primaryResult, primaryCode);
  }

  if (isDev()) {
    console.log(`[runPanel] Primary ${modelId} failed (${primaryCode}). Attempting DeepSeek fallback.`);
  }

  const dsResult = await callDeepSeek(question, modelId, dsKey, context);

  if (dsResult.ok) {
    if (isDev()) console.log(`[runPanel] DeepSeek substitution succeeded for ${modelId}`);
    return {
      modelId,
      status: "substituted" as const,
      rawText: dsResult.text,
      latencyMs: dsResult.latencyMs,
      tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
      requestedModel,
      provider: "deepseek",
      actualModel: dsResult.actualModel,
      substitutedFrom: `${provider}:${requestedModel}`,
      substitutionReason: primaryCode,
    };
  }

  const combinedReason = `${primaryCode}|${dsResult.code}`;

  if (isDev()) {
    console.log(`[runPanel] DeepSeek fallback also failed for ${modelId}: ${dsResult.message} (combined: ${combinedReason})`);
  }

  return failedPlaceholder(modelId, primaryResult, combinedReason);
}

async function safePrimaryCall(
  connector: (q: string, ctx?: string | null, key?: string) => Promise<ModelResult>,
  modelId: ModelId,
  question: string,
  context: string | null,
  apiKey: string | undefined
): Promise<ModelResult> {
  try {
    return await connector(question, context, apiKey);
  } catch (err: any) {
    console.error(`[runPanel] Unexpected throw from ${modelId}:`, err);
    return {
      modelId,
      status: "error" as ConnectorStatus,
      rawText: null,
      errorMessage: String(err?.message || err || "Unknown error"),
      latencyMs: 0,
      tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
    };
  }
}

function applyShortCheck(result: ModelResult): ModelResult {
  if (result.status === "ok" && result.rawText && isSuspiciouslyShort(result.rawText)) {
    console.warn(
      `[runPanel] Model ${result.modelId} returned suspiciously short response (${result.rawText.split(/\s+/).length} words).`
    );
    result.errorMessage = "Unusually short answer – this model may have refused or returned less detail than requested.";
  }
  return result;
}

function failedPlaceholder(modelId: ModelId, primaryResult: ModelResult, reason?: string): ModelResult {
  const provider = getPanelModelConfig(modelId).provider;
  const requestedModel = ACTUAL_MODEL_STRINGS[modelId] || modelId;
  return {
    modelId,
    status: "failed" as const,
    rawText: "Model unavailable.",
    errorMessage: primaryResult.errorMessage || `${modelId} failed`,
    latencyMs: primaryResult.latencyMs || 0,
    tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
    requestedModel,
    provider,
    actualModel: requestedModel,
    ...(reason ? { substitutionReason: reason } : {}),
  };
}
