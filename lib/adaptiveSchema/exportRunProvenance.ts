/**
 * Step 6.2b — Frozen Export Provenance.
 *
 * The ONE module that (1) freezes run-level provenance into an export snapshot
 * at creation time, (2) reads a frozen value back defensively for rendering,
 * and (3) produces the display lines every renderer (PDF, DOCX) shows — so the
 * formats cannot disagree about which facts an export carries. JSON emits the
 * same normalized object structurally.
 *
 * INVARIANT: an export contains only provenance already persisted on the run
 * the authorized export operation read, freezes it at creation, and historical
 * regeneration reproduces exactly that frozen value without consulting mutable
 * run state. Nothing here performs I/O.
 *
 *   - policy version: Milestone-2 → `governanceRecord.automatedGovernance.policyVersion`,
 *     only for a real evaluation outcome (passed / flagged / blocked — same rule
 *     as the Step 6.1 run context); legacy → the run's `governanceMeta.policyVersion`,
 *     only when the run's legacy `governanceStatus` was actually evaluated.
 *   - per model: `provider` / `requestedModel` / `substitutedFrom` exactly as the
 *     run's `perModel` row persisted them (Step 6.2a), and `substituted` from the
 *     persisted `status === "substituted"`. Never derived from current model
 *     configuration, `modelId`, or anything else. A pre-6.2a run simply has no
 *     provider / requested model, and they stay absent.
 *   - `actualModel` is never carried: it is not provider-attested identity.
 */

import type { GovernanceRecordV1 } from "./governanceRecord";
import type { AdaptiveExportModelProvenance, AdaptiveExportRunProvenance } from "./researchExport";
import type { ModelId } from "../types";

const EVALUATED_AUTOMATED_STATUSES: readonly string[] = ["passed", "flagged", "blocked"];

/**
 * Every persisted `perModel.status` (`ConnectorStatus`) that is an explicit
 * record that this slot was NOT substituted. Anything outside this set — and a
 * missing row or status — yields no substitution claim at all.
 */
export const NON_SUBSTITUTED_PERSISTED_STATUSES: readonly string[] = ["ok", "failed", "error", "timeout", "refused", "rate_limited"];

/** `true` / `false` only from an explicit persisted status; `undefined` (unknown) otherwise. */
function persistedSubstitutionState(status: unknown): boolean | undefined {
  if (status === "substituted") return true;
  if (typeof status === "string" && NON_SUBSTITUTED_PERSISTED_STATUSES.includes(status)) return false;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validPolicyVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export type ExportRunProvenancePolicySource =
  | { family: "milestone2"; governanceRecord?: GovernanceRecordV1 }
  | { family: "legacy"; governanceStatus: "approved" | "needs_review" | "blocked" | null; governanceMeta: unknown };

export type FreezeExportRunProvenanceInput = {
  selectedModels: ModelId[];
  /** The run document's persisted `runDocument` value, untrusted. */
  runDocument: unknown;
  policy: ExportRunProvenancePolicySource;
};

function frozenPolicyVersion(source: ExportRunProvenancePolicySource): number | undefined {
  if (source.family === "milestone2") {
    const automated = source.governanceRecord?.automatedGovernance;
    if (automated && EVALUATED_AUTOMATED_STATUSES.includes(automated.status) && validPolicyVersion(automated.policyVersion)) {
      return automated.policyVersion;
    }
    return undefined;
  }
  if (source.governanceStatus === null) return undefined;
  const meta = source.governanceMeta;
  return isPlainObject(meta) && validPolicyVersion(meta.policyVersion) ? meta.policyVersion : undefined;
}

function frozenModel(modelId: ModelId, row: Record<string, unknown> | undefined): AdaptiveExportModelProvenance {
  const substituted = persistedSubstitutionState(row?.status);
  // Built with conditional spreads only: no `undefined` value is ever written,
  // so a Firestore round-trip cannot turn an absent fact into a `null` one.
  return {
    modelId,
    ...(row && nonEmptyString(row.provider) ? { provider: row.provider } : {}),
    ...(row && nonEmptyString(row.requestedModel) ? { requestedModel: row.requestedModel } : {}),
    ...(substituted !== undefined ? { substituted } : {}),
    ...(substituted === true && row && nonEmptyString(row.substitutedFrom) ? { substitutedFrom: row.substitutedFrom } : {}),
  };
}

/** Freezes the run's persisted provenance. Pure; never throws. */
export function freezeExportRunProvenance(input: FreezeExportRunProvenanceInput): AdaptiveExportRunProvenance {
  const perModel = isPlainObject(input.runDocument) && Array.isArray(input.runDocument.perModel) ? input.runDocument.perModel : [];
  const rows = perModel.filter(isPlainObject);
  const policyVersion = frozenPolicyVersion(input.policy);
  return {
    ...(policyVersion !== undefined ? { policyVersion } : {}),
    models: input.selectedModels.map((modelId) => frozenModel(modelId, rows.find((r) => r.modelId === modelId))),
  };
}

/**
 * Reads a FROZEN value back for rendering. `null` means "this export carries no
 * run provenance" (every pre-6.2b record): render nothing. Malformed fields are
 * treated as absent; nothing is filled in.
 */
export function readFrozenRunProvenance(raw: unknown): AdaptiveExportRunProvenance | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.models)) return null;
  const models: AdaptiveExportModelProvenance[] = [];
  for (const entry of raw.models) {
    if (!isPlainObject(entry) || !nonEmptyString(entry.modelId)) continue;
    // A literal boolean is preserved; anything else is an unknown state and omitted.
    const substituted = typeof entry.substituted === "boolean" ? entry.substituted : undefined;
    models.push({
      modelId: entry.modelId as ModelId,
      ...(nonEmptyString(entry.provider) ? { provider: entry.provider } : {}),
      ...(nonEmptyString(entry.requestedModel) ? { requestedModel: entry.requestedModel } : {}),
      ...(substituted !== undefined ? { substituted } : {}),
      ...(substituted === true && nonEmptyString(entry.substitutedFrom) ? { substitutedFrom: entry.substitutedFrom } : {}),
    });
  }
  return {
    ...(validPolicyVersion(raw.policyVersion) ? { policyVersion: raw.policyVersion } : {}),
    models,
  };
}

export const PROVENANCE_NOT_RECORDED = "not recorded";

/** What was originally requested on a substituted row, using every persisted fact and naming only the genuinely missing part. */
function substitutionOriginal(m: AdaptiveExportModelProvenance): string {
  if (m.substitutedFrom !== undefined) return m.substitutedFrom;
  if (m.requestedModel !== undefined) return `${m.requestedModel} (original provider ${PROVENANCE_NOT_RECORDED})`;
  return `original model ${PROVENANCE_NOT_RECORDED}`;
}

/**
 * The factual display lines shared by PDF and DOCX. No "verified", "trusted" or
 * scored language. Every positive or negative statement is backed by a frozen
 * fact; a missing fact is stated as not recorded, never guessed.
 */
export function exportRunProvenanceLines(provenance: AdaptiveExportRunProvenance): string[] {
  const lines = [`Policy: ${provenance.policyVersion !== undefined ? `v${provenance.policyVersion}` : PROVENANCE_NOT_RECORDED}`];
  for (const m of provenance.models) {
    const provider = m.provider ?? `provider ${PROVENANCE_NOT_RECORDED}`;
    if (m.substituted === true) {
      lines.push(`Substitution (${m.modelId}): requested ${substitutionOriginal(m)} → answered by ${provider}`);
      continue;
    }
    const requested = m.requestedModel ?? `requested model ${PROVENANCE_NOT_RECORDED}`;
    // `false` is a recorded fact and needs no qualifier; an unknown state says so.
    const substitution = m.substituted === false ? "" : ` · substitution ${PROVENANCE_NOT_RECORDED}`;
    lines.push(`Model (${m.modelId}): ${requested} · ${provider}${substitution}`);
  }
  return lines;
}
