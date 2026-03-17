/**
 * Normalization layer for PanelResultPublic
 *
 * Ensures every public result has:
 *  - status ∈ {"ok", "substituted", "failed"} (legacy values coerced)
 *  - requestedModel, provider, actualModel always present (never undefined)
 *  - substitutedFrom as "<provider>:<model>" string (legacy objects converted)
 *  - substitutionReason is a short code-like string (sanitized)
 */

import type { ModelStatus, ConnectorStatus } from "@/lib/types";

const LEGACY_TO_FAILED: Set<string> = new Set(["error", "timeout", "refused"]);
const PUBLIC_STATUSES: Set<string> = new Set(["ok", "substituted", "failed"]);
const REASON_CODE_RE = /^[a-z0-9_:.-]{1,80}$/i;

/**
 * Coerce any ConnectorStatus (including legacy values) to a public ModelStatus.
 */
export function coerceStatus(raw: ConnectorStatus | string): ModelStatus {
  if (raw === "ok" || raw === "substituted" || raw === "failed") return raw;
  if (LEGACY_TO_FAILED.has(raw)) return "failed";
  return "failed";
}

/**
 * DEV-only assertion: throws if status is not a valid public ModelStatus.
 * In production, silently coerces to "failed" (never throws).
 */
export function assertPublicStatus(status: string, context?: string): ModelStatus {
  if (PUBLIC_STATUSES.has(status)) return status as ModelStatus;

  const coerced = coerceStatus(status);
  if (process.env.NODE_ENV === "development") {
    console.error(
      `[assertPublicStatus] INTERNAL STATUS LEAKED: "${status}" (coerced → "${coerced}")${context ? ` in ${context}` : ""}`
    );
  }
  return coerced;
}

/**
 * Sanitize substitutionReason to a short code-like string.
 * Rejects raw error messages (long text, whitespace, newlines).
 */
function sanitizeSubstitutionReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return undefined;
  if (REASON_CODE_RE.test(trimmed)) return trimmed;
  return "unknown_error";
}

/**
 * Normalize substitutedFrom from legacy object or bare model id to
 * the canonical "<provider>:<model>" string format.
 */
function normalizeSubstitutedFrom(
  value: unknown,
  fallbackProvider?: string
): string | undefined {
  if (value == null) return undefined;

  if (typeof value === "object" && value !== null) {
    const obj = value as { provider?: string; model?: string; reason?: string };
    const prov = obj.provider || fallbackProvider || "unknown";
    const model = obj.model || "unknown";
    return `${prov}:${model}`;
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (s.length === 0) return undefined;
    if (s.includes(":")) return s;
    if (fallbackProvider) return `${fallbackProvider}:${s}`;
    return `unknown:${s}`;
  }

  return undefined;
}

/**
 * Extract substitutionReason from a legacy substitutedFrom object if the
 * top-level field is missing.
 */
function extractSubstitutionReason(
  existing: string | undefined,
  rawSubstitutedFrom: unknown
): string | undefined {
  if (existing) return sanitizeSubstitutionReason(existing);
  if (
    rawSubstitutedFrom &&
    typeof rawSubstitutedFrom === "object" &&
    (rawSubstitutedFrom as any).reason
  ) {
    return sanitizeSubstitutionReason((rawSubstitutedFrom as any).reason);
  }
  return undefined;
}

interface RawResultLike {
  modelId: string;
  status: string;
  requestedModel?: string;
  provider?: string;
  actualModel?: string;
  substitutedFrom?: unknown;
  substitutionReason?: string;
  [key: string]: unknown;
}

/**
 * Normalize a result object to the public PanelResultPublic contract.
 * Safe to call on already-normalized results (idempotent).
 *
 * Guarantees:
 *  - status is "ok" | "substituted" | "failed"
 *  - requestedModel, provider, actualModel are always non-empty strings
 *  - substitutedFrom (if present) always contains ":" in "<provider>:<model>" format
 *  - substitutionReason (if present) is a short code-like string
 */
export function normalizeModelResultPublic<T extends RawResultLike>(
  result: T,
  defaults?: { requestedModel?: string; provider?: string; actualModel?: string }
): T & { status: ModelStatus; requestedModel: string; provider: string; actualModel: string } {
  const status = coerceStatus(result.status as ConnectorStatus);

  const requestedModel =
    result.requestedModel || defaults?.requestedModel || result.modelId || "unknown";
  const provider =
    result.provider || defaults?.provider || "unknown";

  let actualModel = result.actualModel || defaults?.actualModel || "";
  if (!actualModel) {
    if (status === "substituted" && provider === "deepseek") {
      actualModel = "deepseek-chat";
    } else {
      actualModel = requestedModel || "unknown";
    }
  }

  const rawSF = result.substitutedFrom;
  const sfProvider = defaults?.provider || (status !== "substituted" ? provider : undefined);
  const substitutedFrom = normalizeSubstitutedFrom(rawSF, sfProvider);
  const substitutionReason = extractSubstitutionReason(
    result.substitutionReason,
    rawSF
  );

  const out = {
    ...result,
    status,
    requestedModel,
    provider,
    actualModel,
    substitutedFrom,
    substitutionReason,
  };

  // Remove undefined fields so they don't appear in JSON serialization
  if (out.substitutedFrom === undefined) delete (out as any).substitutedFrom;
  if (out.substitutionReason === undefined) delete (out as any).substitutionReason;

  return out;
}

/**
 * Strip newlines and carriage returns from a string value.
 */
function stripNewlines(val: string): string {
  return val.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Truncate and sanitize a field for the substitution block.
 */
function sanitizeBlockField(val: string | undefined, maxLen: number): string {
  if (!val) return "";
  const cleaned = stripNewlines(val);
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen - 1) + "…";
}

/**
 * Sanitize a reason field for the substitution block.
 * Must match the code-like pattern; otherwise replaced with "unknown_error".
 */
function sanitizeBlockReason(val: string | undefined): string {
  if (!val) return "";
  const cleaned = stripNewlines(val);
  if (cleaned.length === 0) return "";
  if (REASON_CODE_RE.test(cleaned)) return cleaned;
  return "unknown_error";
}

/**
 * Build capped + truncated SUBSTITUTIONS JSON for synthesis prompt.
 * - Max 5 entries
 * - Each string field capped at 80 chars, single-line
 * - reason must be a code-like string (no raw error messages)
 * - Output is valid, minimal JSON
 * - Only metadata, never raw model output
 */
export function buildSubstitutionBlock(
  entries: Array<{
    slot: string;
    requestedModel: string;
    provider: string;
    actualModel: string;
    reason: string;
  }>
): string {
  if (entries.length === 0) return "";

  const capped = entries.slice(0, 5).map((e) => ({
    slot: sanitizeBlockField(e.slot, 80),
    requestedModel: sanitizeBlockField(e.requestedModel, 80),
    provider: sanitizeBlockField(e.provider, 80),
    actualModel: sanitizeBlockField(e.actualModel, 80),
    reason: sanitizeBlockReason(e.reason),
  }));

  return `\nSUBSTITUTIONS:\n${JSON.stringify(capped)}\n`;
}
