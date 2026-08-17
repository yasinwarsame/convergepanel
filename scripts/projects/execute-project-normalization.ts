/**
 * Phase 6D.3A — the bounded historical normalization executor CLI.
 *
 * Deliberately separate from `dry-run-project-normalization.ts` (Phase
 * 6D.1), which remains structurally incapable of writing. This script
 * defaults to the SAME safe preflight-only behavior when `--execute` is
 * absent — there is no way to reach mutation mode via a missing or
 * misspelled flag.
 *
 * Mutation mode additionally requires BOTH an exact expected candidate
 * count AND an exact expected candidate-set SHA-256 fingerprint (see
 * `lib/projects/candidateFingerprint.ts`), plus an explicit
 * `--confirm-project` matching the actually-initialized Firebase
 * project. All four must be satisfied before the executor's own
 * zero-write preflight gate even runs — see
 * `lib/projects/runProjectNormalizationExecutor.ts` for the second,
 * independent verification that happens immediately before any write.
 *
 * Usage:
 *   npm run projects:execute-normalization
 *   npm run projects:execute-normalization -- \
 *     --execute \
 *     --expected-candidates=9 \
 *     --expected-candidate-sha256=<hash> \
 *     --confirm-project=convergepanel
 */

const dotenv = require("dotenv");
const nodePath = require("path");
dotenv.config({ path: nodePath.resolve(__dirname, "../../.env.local") });

import "server-only";
import { adminDb, FIREBASE_PROJECT_ID, getInitializedFirebaseProjectId } from "@/lib/firebase/admin";
import { runProjectNormalizationExecution } from "@/lib/projects/runProjectNormalizationExecutor";
import { normalizeRunProjectId } from "@/lib/projects/normalizeRunProjectId";
import { validateRunWorkspaceBinding } from "@/lib/projects/validateRunWorkspaceBinding";
import type { RawRunRecordForNormalization } from "@/lib/projects/runProjectNormalizationDryRun";
import { checkProjectIdentityConsistency } from "@/lib/workspaces/provisioningSafety";
import { checkNormalizationExecutionGuard, parseNormalizationExecutionCliArgs } from "@/lib/projects/normalizationExecutionSafety";
import * as fs from "fs";
import * as path from "path";

async function listRuns(): Promise<RawRunRecordForNormalization[]> {
  if (!adminDb) {
    throw new Error("Firebase Admin Firestore is not available — check credentials.");
  }
  const snap = await adminDb.collection("runs").select("userId", "workspaceId", "projectId").get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      runId: doc.id,
      userId: typeof data.userId === "string" ? data.userId : "",
      hasWorkspaceIdField: Object.prototype.hasOwnProperty.call(data, "workspaceId"),
      workspaceIdValue: data.workspaceId,
      hasProjectIdField: Object.prototype.hasOwnProperty.call(data, "projectId"),
      projectIdValue: data.projectId,
    };
  });
}

async function main() {
  if (!adminDb) {
    console.error("Firebase Admin Firestore is not available — check credentials.");
    process.exit(1);
  }

  const args = parseNormalizationExecutionCliArgs(process.argv.slice(2));
  const mode = args.execute ? "execute" : "preflight";

  // Project identity is validated for BOTH modes — a preflight report
  // is only trustworthy if it's known to have scanned the project the
  // operator actually intended.
  const identityCheck = checkProjectIdentityConsistency({
    envProjectId: FIREBASE_PROJECT_ID,
    actualProjectId: getInitializedFirebaseProjectId(),
  });
  if (!identityCheck.ok) {
    console.error(identityCheck.message);
    process.exit(1);
  }
  const actualProjectId = identityCheck.projectId;

  let expectedCandidateCount: number | undefined;
  let expectedCandidateSha256: string | undefined;

  if (mode === "execute") {
    const guard = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: args.expectedCandidateCountRaw,
      expectedCandidateSha256: args.expectedCandidateSha256,
      confirmedProjectId: args.confirmProjectId,
      actualProjectId,
    });
    if (!guard.ok) {
      console.error(guard.message);
      process.exit(1);
    }
    expectedCandidateCount = guard.expectedCandidateCount;
    expectedCandidateSha256 = guard.expectedCandidateSha256;
  } else if (args.expectedCandidateCountRaw !== undefined || args.expectedCandidateSha256 !== undefined) {
    // Preflight mode still honors expected values IF supplied, purely so
    // an operator can see whether their previously-recorded fingerprint
    // still matches — but never requires them.
    const parsedCount = Number(args.expectedCandidateCountRaw);
    if (args.expectedCandidateCountRaw !== undefined && Number.isInteger(parsedCount) && parsedCount >= 0) {
      expectedCandidateCount = parsedCount;
    }
    expectedCandidateSha256 = args.expectedCandidateSha256;
  }

  const startedAt = new Date().toISOString();
  const result = await runProjectNormalizationExecution({
    mode,
    listRuns,
    validateWorkspaceBinding: validateRunWorkspaceBinding,
    normalizeOneRun: normalizeRunProjectId,
    expectedCandidateCount,
    expectedCandidateSha256,
  });
  const completedAt = new Date().toISOString();

  const report = {
    schemaVersion: 1,
    operation: "project_run_normalization",
    gitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    environment: actualProjectId,
    startedAt,
    completedAt,
    mode: result.mode,
    observedCandidateCount: result.observedCandidateCount,
    observedCandidateSha256: result.observedCandidateSha256,
    expectedCandidateCount: result.expectedCandidateCount ?? null,
    expectedCandidateSha256: result.expectedCandidateSha256 ?? null,
    fingerprintMatches: result.fingerprintMatches,
    aborted: result.aborted,
    abortReason: result.abortReason ?? null,
    attempted: result.attempted,
    succeeded: result.succeeded,
    stoppedAtRunId: result.stoppedAtRunId ?? null,
    stoppedReason: result.stoppedReason ?? null,
    perRun: result.perRun,
  };

  const outputPath = args.outputPath ?? path.join(process.cwd(), `project-normalization-execution-${startedAt.replace(/[:.]/g, "-")}.json`);
  let artifactWriteFailed = false;
  try {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  } catch (writeError: unknown) {
    artifactWriteFailed = true;
    const message = writeError instanceof Error ? writeError.message : String(writeError);
    console.error(`WARNING: failed to write result artifact to ${outputPath} (${message}). The run's outcome is only visible in the console output below.`);
  }

  console.log("");
  console.log(`Mode: ${result.mode.toUpperCase()}${result.mode === "preflight" ? " (no writes — this mode is structurally read-only)" : ""}`);
  console.log(`Observed candidates: ${result.observedCandidateCount}`);
  console.log(`Observed candidate SHA-256: ${result.observedCandidateSha256}`);
  if (result.expectedCandidateCount !== undefined) {
    console.log(`Expected candidates: ${result.expectedCandidateCount} (matches: ${result.countMatches})`);
  }
  if (result.expectedCandidateSha256 !== undefined) {
    console.log(`Expected candidate SHA-256: ${result.expectedCandidateSha256} (matches: ${result.hashMatches})`);
  }
  console.log(`Aborted: ${result.aborted}${result.abortReason ? ` (${result.abortReason})` : ""}`);
  if (result.mode === "execute") {
    console.log(`Attempted: ${result.attempted.length}`);
    console.log(`Succeeded: ${result.succeeded.length}`);
    if (result.stoppedAtRunId) {
      console.log(`Stopped at: ${result.stoppedAtRunId} (${result.stoppedReason})`);
    }
  }
  if (!artifactWriteFailed) console.log(`Result artifact: ${outputPath}`);

  if (mode === "execute" && result.aborted) {
    process.exit(1);
  }
  if (artifactWriteFailed) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("NORMALIZATION_EXECUTION_SCRIPT_ERROR:", e);
    process.exit(1);
  });
