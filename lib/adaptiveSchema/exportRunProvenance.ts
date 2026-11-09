/**
 * Step 6.2b — Frozen Export Provenance.
 *
 * The ONE module that (1) freezes run-level provenance into an export snapshot
 * at creation time, (2) reads a frozen value back defensively for rendering,
 * and (3) produces the display lines every renderer (PDF, DOCX) shows — so the
 * formats cannot disagree about which facts an export carries. JSON emits the
 * same normalized identity object structurally.
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
 *
 * Frozen provenance VERSION 2 (C-a closeout, Order 29 M-1 / m-1). Every entry
 * also freezes the slot's call OUTCOME, derived ONLY from the explicitly
 * recorded persisted `perModel.status` through the exact-match map
 * `PERSISTED_STATUS_OUTCOMES` (the real ConnectorStatus values): ok / substituted
 * → "answered"; failed / error → "failed"; timeout, refused, rate_limited → the
 * same word. Anything else — a missing row, a missing or non-string status, a
 * case or whitespace variant ("OK ", "Ok"), a word that is not a persisted status
 * ("answered", "") — is `outcome: "unknown"`, `outcomeSource: "absent"`. The
 * outcome is never inferred from the provider's presence or absence; a failed
 * call recorded no provider and needs none. The entry also carries the D-5
 * placeholder class of the persisted row's text (`invalidProviderOutput` /
 * `validityUnknown`, the shared oracle in lib/panel/executionIdentity.ts), so
 * the exports apply the same stored-placeholder rule as the UI (F-2). No stored
 * run field changes and no historical run is rewritten: this is the export
 * snapshot only. A version-1 snapshot (no outcomes) reads back as unknown — the
 * owner accepted that older frozen exports read "model independence unverified"
 * rather than reconstructing history.
 *
 * Two readers of one frozen value: `readFrozenRunProvenance` returns the
 * identity facts (what the JSON export's `provenance.run` and the display lines
 * consume — byte-stable across both versions), `readFrozenRunExecutionProvenance`
 * the same facts with the execution read-back (what the independence judgement
 * of the PDF / DOCX reads, exportPositionView.ts). Both preserve only literal
 * valid values and treat anything else as unknown.
 */

import type { GovernanceRecordV1 } from "./governanceRecord";
import type { AdaptiveExportModelProvenance, AdaptiveExportRunProvenance, AdaptiveExportSlotOutcome, AdaptiveExportSlotOutcomeSource } from "./researchExport";
import type { ModelId } from "../types";
import { runModelIdentityLabel, runModelProvenanceFromExport } from "../panel/runModelIdentity";
import { placeholderClass } from "../panel/executionIdentity";

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

/** The frozen provenance version written by `freezeExportRunProvenance`. */
export const FROZEN_RUN_PROVENANCE_VERSION = 2 as const;

/**
 * Persisted `perModel.status` literal → frozen outcome. Exact match only (own property, the literal as persisted);
 * every real ConnectorStatus value is listed and nothing else is.
 */
export const PERSISTED_STATUS_OUTCOMES: Readonly<Record<string, Exclude<AdaptiveExportSlotOutcome, "unknown">>> = Object.freeze({
  ok: "answered",
  substituted: "answered",
  failed: "failed",
  error: "failed",
  timeout: "timeout",
  refused: "refused",
  rate_limited: "rate_limited",
});

const RECORDED_OUTCOMES: readonly AdaptiveExportSlotOutcome[] = ["answered", "failed", "timeout", "refused", "rate_limited"];

type FrozenOutcome = { outcome: AdaptiveExportSlotOutcome; outcomeSource: AdaptiveExportSlotOutcomeSource };
const UNKNOWN_OUTCOME: FrozenOutcome = Object.freeze({ outcome: "unknown", outcomeSource: "absent" });

/** The outcome an explicitly recorded persisted status freezes; unknown / absent for anything else. */
export function persistedStatusOutcome(status: unknown): FrozenOutcome {
  if (typeof status !== "string" || !Object.prototype.hasOwnProperty.call(PERSISTED_STATUS_OUTCOMES, status)) return UNKNOWN_OUTCOME;
  return { outcome: PERSISTED_STATUS_OUTCOMES[status], outcomeSource: "recorded" };
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
  // The slot's recorded outcome (exact persisted-status match) and the D-5 class of its persisted text (the shared
  // oracle, read over the persisted row exactly as the UI reads a result row). Nothing is inferred from the provider.
  const { outcome, outcomeSource } = persistedStatusOutcome(row?.status);
  const cls = row ? placeholderClass({ ...row, modelId }) : null;
  // Built with conditional spreads only: no `undefined` value is ever written,
  // so a Firestore round-trip cannot turn an absent fact into a `null` one.
  return {
    modelId,
    ...(row && nonEmptyString(row.provider) ? { provider: row.provider } : {}),
    ...(row && nonEmptyString(row.requestedModel) ? { requestedModel: row.requestedModel } : {}),
    ...(substituted !== undefined ? { substituted } : {}),
    ...(substituted === true && row && nonEmptyString(row.substitutedFrom) ? { substitutedFrom: row.substitutedFrom } : {}),
    outcome,
    outcomeSource,
    ...(cls === "INVALID_MOCK" ? { invalidProviderOutput: true as const } : {}),
    ...(cls === "VALIDITY_UNKNOWN" ? { validityUnknown: true as const } : {}),
  };
}

/** Freezes the run's persisted provenance (version 2). Pure; never throws. */
export function freezeExportRunProvenance(input: FreezeExportRunProvenanceInput): AdaptiveExportRunProvenance {
  const perModel = isPlainObject(input.runDocument) && Array.isArray(input.runDocument.perModel) ? input.runDocument.perModel : [];
  const rows = perModel.filter(isPlainObject);
  const policyVersion = frozenPolicyVersion(input.policy);
  return {
    ...(policyVersion !== undefined ? { policyVersion } : {}),
    provenanceVersion: FROZEN_RUN_PROVENANCE_VERSION,
    models: input.selectedModels.map((modelId) => frozenModel(modelId, rows.find((r) => r.modelId === modelId))),
  };
}

/** The frozen entry's identity facts (version 1 shape) and, separately, its execution read-back. */
function readFrozenEntry(entry: Record<string, unknown>): { identity: AdaptiveExportModelProvenance; execution: Partial<AdaptiveExportModelProvenance> } {
  // A literal boolean is preserved; anything else is an unknown state and omitted.
  const substituted = typeof entry.substituted === "boolean" ? entry.substituted : undefined;
  const identity: AdaptiveExportModelProvenance = {
    modelId: entry.modelId as ModelId,
    ...(nonEmptyString(entry.provider) ? { provider: entry.provider } : {}),
    ...(nonEmptyString(entry.requestedModel) ? { requestedModel: entry.requestedModel } : {}),
    ...(substituted !== undefined ? { substituted } : {}),
    ...(substituted === true && nonEmptyString(entry.substitutedFrom) ? { substitutedFrom: entry.substitutedFrom } : {}),
  };
  // Only a literal recorded outcome with the literal source "recorded" is a recorded outcome; anything else — a
  // version-1 entry, "unknown", a crafted or non-string value — is unknown / absent. Only the literal `true` is a D-5 fact.
  const recorded = typeof entry.outcome === "string" && (RECORDED_OUTCOMES as readonly string[]).includes(entry.outcome) && entry.outcomeSource === "recorded";
  const execution: Partial<AdaptiveExportModelProvenance> = {
    ...(recorded ? { outcome: entry.outcome as AdaptiveExportSlotOutcome, outcomeSource: "recorded" as const } : UNKNOWN_OUTCOME),
    ...(entry.invalidProviderOutput === true ? { invalidProviderOutput: true as const } : {}),
    ...(entry.validityUnknown === true ? { validityUnknown: true as const } : {}),
  };
  return { identity, execution };
}

function readFrozenEntries(raw: unknown): { policyVersion?: number; provenanceVersion?: 2; entries: ReturnType<typeof readFrozenEntry>[] } | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.models)) return null;
  const entries: ReturnType<typeof readFrozenEntry>[] = [];
  for (const entry of raw.models) {
    if (!isPlainObject(entry) || !nonEmptyString(entry.modelId)) continue;
    entries.push(readFrozenEntry(entry));
  }
  return {
    ...(validPolicyVersion(raw.policyVersion) ? { policyVersion: raw.policyVersion } : {}),
    ...(raw.provenanceVersion === FROZEN_RUN_PROVENANCE_VERSION ? { provenanceVersion: FROZEN_RUN_PROVENANCE_VERSION } : {}),
    entries,
  };
}

/**
 * Reads a FROZEN value back for rendering: the IDENTITY facts only (the JSON
 * export's `provenance.run`, the display lines and the model labels), the same
 * object for a version-1 and a version-2 snapshot of the same run. `null` means
 * "this export carries no run provenance" (every pre-6.2b record): render
 * nothing. Malformed fields are treated as absent; nothing is filled in.
 */
export function readFrozenRunProvenance(raw: unknown): AdaptiveExportRunProvenance | null {
  const read = readFrozenEntries(raw);
  if (!read) return null;
  return {
    ...(read.policyVersion !== undefined ? { policyVersion: read.policyVersion } : {}),
    models: read.entries.map((e) => e.identity),
  };
}

/**
 * Reads a FROZEN value back with its execution facts (version 2): every entry
 * carries `outcome` / `outcomeSource` — the literal recorded values, or
 * unknown / absent for a version-1 entry or anything not literally valid —
 * and the literal D-5 facts. This is what the exports' model-independence
 * judgement reads (exportPositionView.ts → runModelProvenanceFromExport).
 */
export function readFrozenRunExecutionProvenance(raw: unknown): AdaptiveExportRunProvenance | null {
  const read = readFrozenEntries(raw);
  if (!read) return null;
  return {
    ...(read.policyVersion !== undefined ? { policyVersion: read.policyVersion } : {}),
    ...(read.provenanceVersion !== undefined ? { provenanceVersion: read.provenanceVersion } : {}),
    models: read.entries.map((e) => ({ ...e.identity, ...e.execution })),
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

/**
 * The model-identity label PDF and DOCX print wherever they name a model
 * (the Models summary and each model's response heading): the slot's family
 * plus the requested model FROZEN in this export — "ChatGPT · requested:
 * gpt-4o-mini". A pre-6.2b export (no frozen provenance) or a slot without a
 * frozen entry reads "ChatGPT · model not recorded". Never a current product
 * label or current model configuration.
 */
export function exportModelIdentityLabel(rawRunProvenance: unknown, modelId: string): string {
  return runModelIdentityLabel(runModelProvenanceFromExport(readFrozenRunProvenance(rawRunProvenance), modelId));
}
