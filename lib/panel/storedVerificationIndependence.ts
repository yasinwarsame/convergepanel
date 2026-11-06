/**
 * Whether a STORED claim verification's consensus score may be presented as agreement between models, judged only from
 * what `verifications/{verificationId}` persisted — the claim-verification counterpart of
 * `storedRunConsensusIndependence` (lib/panel/independentVoices.ts).
 *
 * A claim verification asks every requested model for a verdict; its stored `consensusScore` is a cross-model figure.
 * Three requested models with one usable answer, or several slots answered by one executing provider, is not agreement
 * between models, so the score is shown only when the stored rows prove ≥ 2 independent executing models:
 *  - "independent": every requested model has a row with recorded execution identity, and the rows that answered
 *    (`status: "ok"`) reduce to ≥ 2 independent executing models (`independentVoices`: a substituted row is keyed by the
 *    provider that executed it, so several slots served by DeepSeek are ONE model);
 *  - "insufficient": execution identity is complete and the answered rows reduce to fewer than two;
 *  - "unverified": execution identity cannot be established — no `modelResults`, a row that is not an object, a row
 *    without a non-empty `modelId` naming a known panel slot, a row without a recorded status (`ok` / `parse_error` /
 *    `failed`), or a requested model (`selectedModels`) with no row. Nothing is inferred (fail closed: never presented
 *    as agreement).
 *
 * Execution identity of a stored claim row: the claim pipeline (`runClaimVerificationPanel`) calls each requested
 * slot's own connector (`CONNECTOR_MAP[modelId]`), with no fallback provider, so a row that records no substitution was
 * executed by its slot's provider. A row that records `substituted: true` (written by `buildClaimModelEvidence` when a
 * connector reports a substitute) is keyed by its recorded `provider`; one without a recorded provider counts as the
 * unrecorded substitute (all such rows together count at most once — `resolveExecutingModelKeys`).
 *
 * Pure, server- and client-safe; never mutates its input.
 */

import { independentVoices, MIN_INDEPENDENT_SYNTHESIS_MODELS, type StoredConsensusIndependence, type VoiceRow } from "./independentVoices";
import { RUN_MODEL_FAMILY_NAMES } from "./runModelIdentity";

const STORED_CLAIM_ROW_STATUSES = new Set(["ok", "parse_error", "failed"]);

function isKnownSlot(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUN_MODEL_FAMILY_NAMES, modelId);
}

/**
 * The stored claim rows as executing-identity rows (`VoiceRow`), or null when execution identity is missing or
 * incomplete (see the module header). `answered` marks rows with a usable verdict (`status: "ok"`).
 */
export function storedVerificationExecutingRows(
  data: Record<string, unknown> | null | undefined
): Array<VoiceRow & { answered: boolean }> | null {
  if (!data || typeof data !== "object") return null;
  const mr = data.modelResults;
  if (!Array.isArray(mr) || mr.length === 0) return null;
  const rows: Array<VoiceRow & { answered: boolean }> = [];
  const slots = new Set<string>();
  for (const raw of mr) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.modelId !== "string") return null;
    const modelId = r.modelId.trim().toLowerCase();
    if (modelId.length === 0 || !isKnownSlot(modelId)) return null;
    if (typeof r.status !== "string" || !STORED_CLAIM_ROW_STATUSES.has(r.status)) return null;
    slots.add(modelId);
    rows.push({
      modelId,
      status: r.substituted === true ? "substituted" : "ok",
      provider: r.provider,
      answered: r.status === "ok",
    });
  }
  const selected = data.selectedModels;
  if (selected !== undefined) {
    if (!Array.isArray(selected)) return null;
    for (const s of selected) {
      if (typeof s !== "string" || !slots.has(s.trim().toLowerCase())) return null;
    }
  }
  return rows;
}

/** Distinct independent executing models among the stored rows that answered, or null when identity is not established. */
export function storedVerificationIndependentAnswerCount(data: Record<string, unknown> | null | undefined): number | null {
  const rows = storedVerificationExecutingRows(data);
  if (!rows) return null;
  return independentVoices(rows.filter((r) => r.answered)).length;
}

export function storedVerificationConsensusIndependence(data: Record<string, unknown> | null | undefined): StoredConsensusIndependence {
  const n = storedVerificationIndependentAnswerCount(data);
  if (n === null) return "unverified";
  return n >= MIN_INDEPENDENT_SYNTHESIS_MODELS ? "independent" : "insufficient";
}
