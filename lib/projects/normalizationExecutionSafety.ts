/**
 * Phase 6D.3A — pure, zero-I/O safety-check logic for the normalization
 * executor CLI (scripts/projects/execute-project-normalization.ts).
 * Mirrors the shape of `lib/workspaces/provisioningSafety.ts`'s
 * already-established, tested guard pattern rather than inventing a new
 * one. `checkProjectIdentityConsistency()` from that same module is
 * reused verbatim for the Firebase/GCP project-identity check — not
 * reimplemented here.
 *
 * This guard's arming contract is deliberately tighter than the
 * provisioning script's generic `ALLOW_*=true` flag: instead of one
 * blanket acknowledgment, the operator must supply the EXACT expected
 * candidate count and candidate-set SHA-256 fingerprint (see
 * `candidateFingerprint.ts`) — values that can only have been obtained
 * by first running a preflight and reviewing its output. There is no
 * way to "acknowledge" execution in the abstract; the acknowledgment IS
 * the exact population fingerprint.
 *
 * `checkNormalizationExecutionGuard()` is checked ONLY before EXECUTE
 * (mutating) mode. Preflight mode performs zero writes by construction
 * (`runProjectNormalizationExecution({mode: "preflight", ...})`) and
 * needs no arming at all.
 */

export type NormalizationExecutionGuardFailureReason =
  | "project_confirmation_missing"
  | "project_confirmation_mismatch"
  | "expected_count_missing"
  | "expected_count_malformed"
  | "expected_hash_missing"
  | "expected_hash_malformed";

export type NormalizationExecutionGuardResult =
  | { ok: true; expectedCandidateCount: number; expectedCandidateSha256: string }
  | { ok: false; reason: NormalizationExecutionGuardFailureReason; message: string };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function checkNormalizationExecutionGuard(args: {
  expectedCandidateCountRaw: string | undefined;
  expectedCandidateSha256: string | undefined;
  confirmedProjectId: string | undefined;
  actualProjectId: string;
}): NormalizationExecutionGuardResult {
  // Project identity is checked first — an operator confirming the
  // wrong project must never even get to see a count/hash mismatch
  // message that implies they were close to the right target.
  if (!args.confirmedProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_missing",
      message: `Refusing to execute: pass --confirm-project=${args.actualProjectId} to explicitly confirm the target Firebase project.`,
    };
  }
  if (args.confirmedProjectId !== args.actualProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_mismatch",
      message: `Refusing to execute: --confirm-project=${args.confirmedProjectId} does not match the actual initialized Firebase project (${args.actualProjectId}).`,
    };
  }

  if (args.expectedCandidateCountRaw === undefined) {
    return {
      ok: false,
      reason: "expected_count_missing",
      message: "Refusing to execute: --expected-candidates=<N> is required. Run in preflight mode first (no --execute) to obtain the current count.",
    };
  }
  const expectedCandidateCount = Number(args.expectedCandidateCountRaw);
  // Deliberately compares against the RAW (untrimmed) string — an
  // arming value this consequential should never silently tolerate
  // incidental whitespace (e.g. "9 " from a copy-paste), unlike an
  // ordinary numeric CLI flag elsewhere in this codebase.
  if (!Number.isInteger(expectedCandidateCount) || expectedCandidateCount < 0 || String(expectedCandidateCount) !== args.expectedCandidateCountRaw) {
    return {
      ok: false,
      reason: "expected_count_malformed",
      message: `Refusing to execute: --expected-candidates must be a non-negative integer (got "${args.expectedCandidateCountRaw}").`,
    };
  }

  if (!args.expectedCandidateSha256) {
    return {
      ok: false,
      reason: "expected_hash_missing",
      message: "Refusing to execute: --expected-candidate-sha256=<hash> is required. Run in preflight mode first (no --execute) to obtain the current fingerprint.",
    };
  }
  if (!SHA256_HEX_PATTERN.test(args.expectedCandidateSha256)) {
    return {
      ok: false,
      reason: "expected_hash_malformed",
      message: "Refusing to execute: --expected-candidate-sha256 must be a 64-character lowercase hex SHA-256 digest.",
    };
  }

  return { ok: true, expectedCandidateCount, expectedCandidateSha256: args.expectedCandidateSha256 };
}

export interface NormalizationExecutionCliArgs {
  execute: boolean;
  expectedCandidateCountRaw: string | undefined;
  expectedCandidateSha256: string | undefined;
  confirmProjectId: string | undefined;
  outputPath: string | undefined;
}

/**
 * Pure argv parser. `--execute` is the sole, explicit opt-in to
 * mutation mode — anything else (missing, misspelled) leaves
 * `execute: false`, which the CLI script treats as preflight-only.
 */
export function parseNormalizationExecutionCliArgs(argv: readonly string[]): NormalizationExecutionCliArgs {
  let execute = false;
  let expectedCandidateCountRaw: string | undefined;
  let expectedCandidateSha256: string | undefined;
  let confirmProjectId: string | undefined;
  let outputPath: string | undefined;

  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else if (arg.startsWith("--expected-candidates=")) expectedCandidateCountRaw = arg.slice("--expected-candidates=".length);
    else if (arg.startsWith("--expected-candidate-sha256=")) expectedCandidateSha256 = arg.slice("--expected-candidate-sha256=".length);
    else if (arg.startsWith("--confirm-project=")) confirmProjectId = arg.slice("--confirm-project=".length);
    else if (arg.startsWith("--output=")) outputPath = arg.slice("--output=".length);
  }

  return { execute, expectedCandidateCountRaw, expectedCandidateSha256, confirmProjectId, outputPath };
}
