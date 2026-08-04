/**
 * Enum Coercion
 *
 * Models occasionally drift from the exact enum vocabulary given in the
 * prompt (e.g. Gemini returning "agrees" instead of "asserts" for
 * Claim.stance). This layer recovers the common, unambiguous cases
 * case-insensitively before Zod validation ever sees them, so one enum typo
 * doesn't discard an entire response.
 *
 * Two coercion strategies, deliberately different in how aggressive they are:
 * - FORMAT normalization (all enum fields): casing/spacing/hyphen drift only
 *   — "Majority View" -> "majority_view". Never changes meaning.
 * - SEMANTIC synonyms (stance only): a small, explicit table of alternate
 *   phrasings models use for the same concept — "agrees" -> "asserts".
 *   Confidence and evidenceType have NO semantic table: "high" is not the
 *   same claim as "settled" and must never be guessed. An unrecognized value
 *   is left as-is for Zod to reject.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveEnumCoercion, ClaimConfidence, ClaimEvidenceType, ClaimStance, QueryType } from "./types";

export type EnumCoercionLogEntry = AdaptiveEnumCoercion;

const STANCE_ALLOWED: readonly ClaimStance[] = ["asserts", "disputes", "uncertain"];
const CONFIDENCE_ALLOWED: readonly ClaimConfidence[] = ["settled", "majority_view", "contested", "speculative"];
const EVIDENCE_TYPE_ALLOWED: readonly ClaimEvidenceType[] = ["empirical", "theoretical", "anecdotal", "authoritative"];

/** Semantic synonyms — stance only. Never add a table like this for confidence: mapping "high" to "settled" reinterprets meaning instead of recovering formatting. */
const STANCE_SYNONYMS: Record<string, ClaimStance> = {
  agrees: "asserts",
  agree: "asserts",
  supports: "asserts",
  affirms: "asserts",
  disagrees: "disputes",
  disagree: "disputes",
  refutes: "disputes",
  rejects: "disputes",
  contests: "disputes",
  unclear: "uncertain",
  mixed: "uncertain",
  neutral: "uncertain",
  unsure: "uncertain",
};

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function coerceOne(
  raw: unknown,
  allowed: readonly string[]
): { value: unknown; coercedFrom?: string };
function coerceOne(
  raw: unknown,
  allowed: readonly string[],
  synonyms: Record<string, string>
): { value: unknown; coercedFrom?: string };
function coerceOne(
  raw: unknown,
  allowed: readonly string[],
  synonyms?: Record<string, string>
): { value: unknown; coercedFrom?: string } {
  if (typeof raw !== "string") return { value: raw };
  if ((allowed as readonly string[]).includes(raw)) return { value: raw };

  const normalized = normalizeToken(raw);
  if ((allowed as readonly string[]).includes(normalized)) {
    return { value: normalized, coercedFrom: raw };
  }

  if (synonyms) {
    const mapped = synonyms[normalized];
    if (mapped && (allowed as readonly string[]).includes(mapped)) {
      return { value: mapped, coercedFrom: raw };
    }
  }

  // Unknown value — leave invalid, never guess.
  return { value: raw };
}

/**
 * Coerce the stance/confidence/evidenceType fields of one raw claim-shaped
 * object. Returns a new object (never mutates the input) plus a log of
 * every coercion applied, so drift stays visible in the debug panel.
 */
export function coerceClaimEnums(
  claim: Record<string, unknown>,
  ctx: { modelId: ModelId; schemaId: QueryType; path: string }
): { claim: Record<string, unknown>; log: EnumCoercionLogEntry[] } {
  const log: EnumCoercionLogEntry[] = [];
  const next = { ...claim };

  const stance = coerceOne(claim.stance, STANCE_ALLOWED, STANCE_SYNONYMS);
  if (stance.coercedFrom) {
    next.stance = stance.value;
    log.push({
      modelId: ctx.modelId,
      schemaId: ctx.schemaId,
      field: "stance",
      path: `${ctx.path}.stance`,
      raw: stance.coercedFrom,
      coerced: String(stance.value),
    });
  }

  const confidence = coerceOne(claim.confidence, CONFIDENCE_ALLOWED);
  if (confidence.coercedFrom) {
    next.confidence = confidence.value;
    log.push({
      modelId: ctx.modelId,
      schemaId: ctx.schemaId,
      field: "confidence",
      path: `${ctx.path}.confidence`,
      raw: confidence.coercedFrom,
      coerced: String(confidence.value),
    });
  }

  const evidenceType = coerceOne(claim.evidenceType, EVIDENCE_TYPE_ALLOWED);
  if (evidenceType.coercedFrom) {
    next.evidenceType = evidenceType.value;
    log.push({
      modelId: ctx.modelId,
      schemaId: ctx.schemaId,
      field: "evidenceType",
      path: `${ctx.path}.evidenceType`,
      raw: evidenceType.coercedFrom,
      coerced: String(evidenceType.value),
    });
  }

  return { claim: next, log };
}
