/**
 * Phase 6D.3A — the normalization executor orchestrator. This is the
 * ONLY place `normalizeRunProjectId()` (the sole write-capable
 * function) is ever called, and only in `mode: "execute"`, and only
 * after a fresh, zero-write preflight classification (reusing the
 * Phase 6D.1 `runProjectNormalizationDryRun()` verbatim — never a
 * second, competing classification implementation) confirms the
 * candidate-set fingerprint matches the caller-supplied expected
 * values EXACTLY. `mode: "preflight"` never calls
 * `normalizeOneRun` at all, regardless of what expected values are
 * (or aren't) supplied — it exists purely to let an operator see the
 * current fingerprint before deciding what to authorize.
 *
 * Sequential, conservative fail-fast: candidates are processed one at
 * a time, in the same sorted order the fingerprint was computed over
 * (so a partial run's progress is unambiguous). The first
 * non-"normalized" outcome during execution stops all further writes
 * immediately — never retried, never silently skipped-and-continued.
 * A `"skipped_not_absent"` result IS treated as a stop condition here
 * (not a benign skip) specifically because reaching it during
 * execution means the record diverged from the just-verified
 * preflight snapshot — exactly the kind of concurrent-change signal
 * this executor's whole design exists to surface loudly rather than
 * paper over.
 *
 * Never calls `writeProjectEvent()` — normalization is infrastructure
 * schema backfill, not a user Project-organization action (frozen
 * decision, Phase 6D.1). Never accepts a real Project id anywhere in
 * this module's surface — the only value ever written is the literal
 * `null` inside `normalizeRunProjectId()`.
 */

import { runProjectNormalizationDryRun, type ListRunsFn, type ValidateWorkspaceBindingFn } from "./runProjectNormalizationDryRun";
import { computeCandidateFingerprint } from "./candidateFingerprint";
import type { NormalizeRunProjectIdResult } from "./normalizeRunProjectId";

export type NormalizeOneRunFn = (runId: string) => Promise<NormalizeRunProjectIdResult>;

export type NormalizationExecutionMode = "preflight" | "execute";

export type NormalizationExecutionAbortReason = "count_mismatch" | "hash_mismatch";

export interface NormalizationExecutionOptions {
  mode: NormalizationExecutionMode;
  listRuns: ListRunsFn;
  validateWorkspaceBinding: ValidateWorkspaceBindingFn;
  normalizeOneRun: NormalizeOneRunFn;
  expectedCandidateCount?: number;
  expectedCandidateSha256?: string;
}

export interface NormalizationExecutionPerRunRecord {
  runId: string;
  result: string;
}

export interface NormalizationExecutionResult {
  mode: NormalizationExecutionMode;
  observedCandidateCount: number;
  observedCandidateSha256: string;
  expectedCandidateCount?: number;
  expectedCandidateSha256?: string;
  countMatches: boolean;
  hashMatches: boolean;
  fingerprintMatches: boolean;
  /** True only when mode==="execute" and the run stopped before completing every candidate — either at the fingerprint gate or partway through execution. */
  aborted: boolean;
  abortReason?: NormalizationExecutionAbortReason;
  /** Run ids attempted, in sorted order — empty in preflight mode or if the fingerprint gate rejected before any attempt. */
  attempted: string[];
  succeeded: string[];
  stoppedAtRunId?: string;
  stoppedReason?: string;
  perRun: NormalizationExecutionPerRunRecord[];
}

export async function runProjectNormalizationExecution(options: NormalizationExecutionOptions): Promise<NormalizationExecutionResult> {
  const classification = await runProjectNormalizationDryRun({
    listRuns: options.listRuns,
    validateWorkspaceBinding: options.validateWorkspaceBinding,
  });

  const sortedCandidateIds = [...classification.wouldNormalizeRunIds].sort();
  const fingerprint = computeCandidateFingerprint(sortedCandidateIds);

  const countMatches = options.expectedCandidateCount === undefined || fingerprint.candidateCount === options.expectedCandidateCount;
  const hashMatches = options.expectedCandidateSha256 === undefined || fingerprint.candidateIdSha256 === options.expectedCandidateSha256;
  const fingerprintMatches = countMatches && hashMatches;

  const base = {
    mode: options.mode,
    observedCandidateCount: fingerprint.candidateCount,
    observedCandidateSha256: fingerprint.candidateIdSha256,
    expectedCandidateCount: options.expectedCandidateCount,
    expectedCandidateSha256: options.expectedCandidateSha256,
    countMatches,
    hashMatches,
    fingerprintMatches,
    attempted: [] as string[],
    succeeded: [] as string[],
    perRun: [] as NormalizationExecutionPerRunRecord[],
  };

  if (options.mode === "preflight") {
    return { ...base, aborted: false };
  }

  // mode === "execute" — the zero-write gate. Nothing below this point
  // may run unless BOTH the count and the hash match exactly.
  if (!countMatches) {
    return { ...base, aborted: true, abortReason: "count_mismatch" };
  }
  if (!hashMatches) {
    return { ...base, aborted: true, abortReason: "hash_mismatch" };
  }

  for (const runId of sortedCandidateIds) {
    base.attempted.push(runId);
    const result = await options.normalizeOneRun(runId);
    base.perRun.push({ runId, result: result.status });

    if (result.status === "normalized") {
      base.succeeded.push(runId);
      continue;
    }

    // Any other outcome — including the idempotent-looking
    // "skipped_not_absent" — is an unexpected divergence from the
    // fingerprint-verified snapshot taken moments ago. Stop
    // immediately; do not attempt the remaining candidates.
    return { ...base, aborted: true, stoppedAtRunId: runId, stoppedReason: result.status };
  }

  return { ...base, aborted: false };
}
