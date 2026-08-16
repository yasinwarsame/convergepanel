/**
 * Phase 6D.1 — read-only dry run for the future bounded `projectId: null`
 * normalization (Phase 6D.3, not implemented here). This script contains
 * NO write primitive: no `.set(`, `.update(`, `.create(`, `.delete(`, no
 * `BulkWriter`, no transaction, and deliberately no `--execute` flag —
 * there is nothing in this file capable of executing one even if a flag
 * were added (a grep-based structural test enforces this — see
 * `lib/projects/__tests__/runProjectNormalizationDryRun.spec.ts`). It
 * only reads `runs/{id}` (projected to `userId`/`workspaceId`/`projectId`)
 * and `workspaces/{id}` (via the canonical `getWorkspace()`), classifies
 * every run via `runProjectNormalizationDryRun()`, and prints/writes a
 * report of what a future, separately-authorized execution WOULD change.
 *
 * All orchestration/classification logic lives in
 * `lib/projects/runProjectNormalizationDryRun.ts` and
 * `lib/projects/runProjectNormalizationEligibility.ts` (both
 * dependency-injection-tested against fakes) — this file's only job is
 * wiring the real `adminDb` binding, running the report, and printing it.
 *
 * Usage:
 *   npm run projects:dry-run-normalization
 */

const dotenv = require("dotenv");
const nodePath = require("path");
dotenv.config({ path: nodePath.resolve(__dirname, "../../.env.local") });

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { runProjectNormalizationDryRun, type RawRunRecordForNormalization } from "@/lib/projects/runProjectNormalizationDryRun";
import { validateRunWorkspaceBinding } from "@/lib/projects/validateRunWorkspaceBinding";
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

  const startedAt = new Date().toISOString();
  const result = await runProjectNormalizationDryRun({
    listRuns,
    validateWorkspaceBinding: validateRunWorkspaceBinding,
  });
  const completedAt = new Date().toISOString();

  const report = { mode: "DRY_RUN_NO_WRITES", startedAt, completedAt, ...result };

  const outputPath = path.join(process.cwd(), `project-normalization-dry-run-${startedAt.replace(/[:.]/g, "-")}.json`);
  let artifactWriteFailed = false;
  try {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  } catch (writeError: unknown) {
    artifactWriteFailed = true;
    const message = writeError instanceof Error ? writeError.message : String(writeError);
    console.error(`WARNING: failed to write result artifact to ${outputPath} (${message}). The run's outcome is only visible in the console output below.`);
  }

  console.log("");
  console.log("Mode: DRY RUN (no writes — this script contains no write primitive)");
  console.log(`Total scanned: ${result.totalScanned}`);
  console.log(`Legacy (excluded, no workspaceId): ${result.counts.legacy}`);
  console.log(`Workspace-bound: ${result.totalScanned - result.counts.legacy}`);
  console.log(`  bound-invalid (excluded, blocker): ${result.counts.bound_invalid}`);
  console.log(`  bound-valid:`);
  console.log(`    would_normalize (projectId absent -> candidate): ${result.counts.would_normalize}`);
  console.log(`    already_null (skip): ${result.counts.already_null}`);
  console.log(`    already_assigned (skip): ${result.counts.already_assigned}`);
  console.log(`    malformed_blocker (skip, needs manual review): ${result.counts.malformed_blocker}`);
  console.log(`Would-normalize by user: ${JSON.stringify(result.wouldNormalizeByUser)}`);
  if (result.counts.bound_invalid > 0 || result.counts.malformed_blocker > 0) {
    console.log("");
    console.log("NOTE: bound_invalid and malformed_blocker runs require manual review before any future execution — never auto-normalized.");
  }
  if (!artifactWriteFailed) console.log(`Result artifact: ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("DRY_RUN_SCRIPT_ERROR:", e);
    process.exit(1);
  });
