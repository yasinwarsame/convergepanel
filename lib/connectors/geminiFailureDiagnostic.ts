/**
 * Sanitized Gemini failure diagnostics (P0 restoration, 2026-11-01).
 *
 * In Production every Gemini call (the panel model and every adaptive
 * analysis stage) was failing in about 250 ms, and the connector logged
 * nothing: all its error logging was dev-only. This builds the one
 * Production-safe record of a failed call.
 *
 * It records ONLY:
 *   - provider, model id and the stage (a closed set);
 *   - HTTP status and status text, when the SDK reports them;
 *   - Google's structured reason codes (errorDetails[].reason), accepted only
 *     when they match an upper-case enum shape such as API_KEY_INVALID or
 *     RATE_LIMIT_EXCEEDED;
 *   - the error class name, when it is a plain identifier;
 *   - a derived category, plus the attempt, retry and latency counters.
 *
 * It never records the error message, prompt, response, credentials, request
 * URL, errorDetails metadata (which can name the consumer project), user
 * identifiers or research content.
 *
 * Categories are distinct on purpose. Google answers an invalid or expired
 * key with HTTP 400 (reason API_KEY_INVALID), which the connector's own
 * user-facing branches cannot tell apart from a malformed request.
 */

import type { GeminiDiagnosticOperation } from "./types";

export type GeminiFailureCategory =
  | "authentication"
  | "permission"
  | "billing"
  | "quota_or_rate_limit"
  | "model_unavailable"
  | "invalid_request"
  | "provider_unavailable"
  | "timeout"
  | "network"
  | "empty_response"
  | "unknown";

export type GeminiFailureDiagnostic = {
  provider: "gemini";
  model: string;
  operation: GeminiDiagnosticOperation;
  category: GeminiFailureCategory;
  httpStatus: number | null;
  httpStatusText: string | null;
  reasons: string[];
  errorName: string | null;
  attempt: number;
  maxAttempts: number;
  latencyMs: number;
};

const ENUM_SHAPE = /^[A-Z][A-Z0-9_]{1,63}$/;
const IDENTIFIER_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const STATUS_TEXT_SHAPE = /^[A-Za-z][A-Za-z ]{0,40}$/;
const AUTH_REASONS = new Set(["API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_NOT_FOUND", "CREDENTIALS_MISSING", "ACCESS_TOKEN_EXPIRED"]);
const PERMISSION_REASONS = new Set(["SERVICE_DISABLED", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_ANDROID_APP_BLOCKED", "API_KEY_IOS_APP_BLOCKED", "CONSUMER_INVALID", "USER_PROJECT_DENIED", "ACCESS_DENIED", "LOCATION_POLICY_VIOLATED", "FAILED_PRECONDITION"]);
const QUOTA_REASONS = new Set(["RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"]);

function safeReasons(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const out = new Set<string>();
  for (const d of details.slice(0, 10)) {
    const reason = d && typeof d === "object" ? (d as { reason?: unknown }).reason : undefined;
    if (typeof reason === "string" && ENUM_SHAPE.test(reason)) out.add(reason);
  }
  return [...out].sort();
}

function categorize(httpStatus: number | null, reasons: string[], errorName: string | null, isTimeout: boolean): GeminiFailureCategory {
  if (isTimeout) return "timeout";
  if (reasons.some((r) => AUTH_REASONS.has(r)) || httpStatus === 401) return "authentication";
  // 402 Payment Required: the project is not in good billing standing (observed in Production 2026-11-01 on every call).
  if (httpStatus === 402 || reasons.includes("BILLING_DISABLED")) return "billing";
  if (reasons.some((r) => PERMISSION_REASONS.has(r)) || httpStatus === 403) return "permission";
  if (reasons.some((r) => QUOTA_REASONS.has(r)) || httpStatus === 429) return "quota_or_rate_limit";
  if (httpStatus === 404) return "model_unavailable";
  if (httpStatus === 400) return "invalid_request";
  if (httpStatus !== null && httpStatus >= 500) return "provider_unavailable";
  if (httpStatus === null && errorName === "TypeError") return "network";
  return "unknown";
}

/** A response that arrived but carried no text (the "parsing" class). finishReason is kept only in its enum shape. */
export function buildGeminiEmptyResponseDiagnostic(ctx: { model: string; operation?: GeminiDiagnosticOperation; finishReason: unknown; attempt: number; maxAttempts: number; latencyMs: number }) {
  return {
    provider: "gemini" as const,
    model: ctx.model,
    operation: ctx.operation ?? "panel",
    category: "empty_response" as const,
    finishReason: typeof ctx.finishReason === "string" && ENUM_SHAPE.test(ctx.finishReason) ? ctx.finishReason : null,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    latencyMs: ctx.latencyMs,
  };
}

export function buildGeminiFailureDiagnostic(
  error: unknown,
  ctx: { model: string; operation?: GeminiDiagnosticOperation; attempt: number; maxAttempts: number; latencyMs: number; isTimeout?: boolean }
): GeminiFailureDiagnostic {
  const e = (error && typeof error === "object" ? error : {}) as { status?: unknown; statusText?: unknown; errorDetails?: unknown; name?: unknown };
  const httpStatus = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : null;
  const httpStatusText = typeof e.statusText === "string" && STATUS_TEXT_SHAPE.test(e.statusText) ? e.statusText : null;
  const errorName = typeof e.name === "string" && IDENTIFIER_SHAPE.test(e.name) ? e.name : null;
  const reasons = safeReasons(e.errorDetails);
  return {
    provider: "gemini",
    model: ctx.model,
    operation: ctx.operation ?? "panel",
    category: categorize(httpStatus, reasons, errorName, ctx.isTimeout === true),
    httpStatus,
    httpStatusText,
    reasons,
    errorName,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    latencyMs: ctx.latencyMs,
  };
}
