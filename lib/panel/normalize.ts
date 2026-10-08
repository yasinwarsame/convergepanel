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
 * Saved-run provenance honesty (S1) — the ONLY normalizer for a result read
 * back from storage (`runDocument.perModel` rows and the legacy top-level
 * `results[]`).
 *
 * Unlike `normalizeModelResultPublic` (the LIVE contract, which guarantees
 * requestedModel/provider/actualModel), this one never manufactures a
 * historical runtime fact. It coerces status and otherwise keeps only what the
 * stored row actually carries:
 *  - `provider` / `requestedModel`: kept when a non-empty string, else absent;
 *  - `actualModel`: always removed — it was never provider-reported identity;
 *  - `substitutedFrom`: only on a substituted row, and only when already a
 *    complete "<provider>:<model>" (or a legacy object with both parts) —
 *    never completed with a fallback provider or "unknown";
 *  - `substitutionReason`: only on a substituted row, and only when it is a
 *    code-like value (never rewritten to "unknown_error").
 */
export type PersistedModelResultProvenance = {
  status: ModelStatus;
  provider?: string;
  requestedModel?: string;
  substitutedFrom?: string;
  substitutionReason?: string;
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function completeSubstitutedFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const s = value.trim();
    const idx = s.indexOf(":");
    return idx > 0 && idx < s.length - 1 ? s : undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as { provider?: unknown; model?: unknown };
    return nonEmpty(obj.provider) && nonEmpty(obj.model) ? `${obj.provider.trim()}:${obj.model.trim()}` : undefined;
  }
  return undefined;
}

function recordedReason(existing: unknown, rawSubstitutedFrom: unknown): string | undefined {
  const candidate = nonEmpty(existing)
    ? existing
    : rawSubstitutedFrom && typeof rawSubstitutedFrom === "object" && nonEmpty((rawSubstitutedFrom as { reason?: unknown }).reason)
      ? ((rawSubstitutedFrom as { reason: string }).reason)
      : undefined;
  if (candidate === undefined) return undefined;
  const trimmed = candidate.trim();
  return REASON_CODE_RE.test(trimmed) ? trimmed : undefined;
}

export function normalizePersistedModelResult<T extends RawResultLike>(
  result: T
): Omit<T, "status" | "provider" | "requestedModel" | "actualModel" | "substitutedFrom" | "substitutionReason"> & PersistedModelResultProvenance {
  const status = coerceStatus(result.status as ConnectorStatus);
  const {
    provider,
    requestedModel,
    actualModel: _actualModel,
    substitutedFrom: rawSubstitutedFrom,
    substitutionReason: rawReason,
    status: _status,
    ...rest
  } = result;
  const substituted = status === "substituted";
  const substitutedFrom = substituted ? completeSubstitutedFrom(rawSubstitutedFrom) : undefined;
  const substitutionReason = substituted ? recordedReason(rawReason, rawSubstitutedFrom) : undefined;
  return {
    ...rest,
    status,
    ...(nonEmpty(provider) ? { provider } : {}),
    ...(nonEmpty(requestedModel) ? { requestedModel } : {}),
    ...(substitutedFrom !== undefined ? { substitutedFrom } : {}),
    ...(substitutionReason !== undefined ? { substitutionReason } : {}),
  };
}

/** One SUBSTITUTIONS prompt entry: the slot, plus ONLY the facts the request actually supplied. */
export type SubstitutionBlockEntry = {
  slot: string;
  requestedModel?: string;
  provider?: string;
  actualModel?: string;
  reason?: string;
};

/**
 * Saved-run provenance honesty (S1) — builds a synthesis substitution entry from
 * a request row WITHOUT filling anything. Returns null unless the row is
 * substituted. A live row (which always carries requestedModel/provider/
 * actualModel/substitutionReason) yields exactly the entry it always did; a
 * saved/reloaded row with absent provenance yields an entry with those facts
 * absent — never modelId, "unknown", "deepseek-chat" or "primary_failed".
 */
export function substitutionEntryFromSupplied(result: {
  modelId: string;
  status?: unknown;
  requestedModel?: unknown;
  provider?: unknown;
  actualModel?: unknown;
  substitutionReason?: unknown;
  substitutedFrom?: unknown;
}): SubstitutionBlockEntry | null {
  if (coerceStatus(String(result.status ?? "") as ConnectorStatus) !== "substituted") return null;
  const reason = nonEmpty(result.substitutionReason)
    ? sanitizeSubstitutionReason(result.substitutionReason)
    : extractSubstitutionReason(undefined, result.substitutedFrom);
  return {
    slot: result.modelId,
    ...(nonEmpty(result.requestedModel) ? { requestedModel: result.requestedModel } : {}),
    ...(nonEmpty(result.provider) ? { provider: result.provider } : {}),
    ...(nonEmpty(result.actualModel) ? { actualModel: result.actualModel } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
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
export function buildSubstitutionBlock(entries: SubstitutionBlockEntry[]): string {
  if (entries.length === 0) return "";

  // Each field is emitted only when the entry carries it (S1): an absent fact
  // stays absent in the prompt. Key order is unchanged, so a complete (live)
  // entry serializes exactly as before.
  const capped = entries.slice(0, 5).map((e) => ({
    slot: sanitizeBlockField(e.slot, 80),
    ...(e.requestedModel !== undefined ? { requestedModel: sanitizeBlockField(e.requestedModel, 80) } : {}),
    ...(e.provider !== undefined ? { provider: sanitizeBlockField(e.provider, 80) } : {}),
    ...(e.actualModel !== undefined ? { actualModel: sanitizeBlockField(e.actualModel, 80) } : {}),
    ...(e.reason !== undefined ? { reason: sanitizeBlockReason(e.reason) } : {}),
  }));

  return `\nSUBSTITUTIONS:\n${JSON.stringify(capped)}\n`;
}
