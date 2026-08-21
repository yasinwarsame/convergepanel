/**
 * Personal Run/Project Invariant Health Check, Phase 8C-B1.3B.
 *
 * STRICTLY READ-ONLY. Never writes, updates, deletes, normalizes, or
 * creates a Firestore index. Its sole purpose is to verify — before any
 * future Personal Projects rollout widening (expanding
 * PROJECTS_CANARY_UIDS, flipping PROJECTS_ENABLED globally, etc.) — that
 * every Personal Workspace-bound run has an explicit `projectId` (either
 * `null` or a valid Project id), i.e. that the writer hardening shipped
 * in this same phase (`app/api/run-panel/route.ts`) is holding in
 * practice, not merely believed to hold.
 *
 * Paginates the ENTIRE `runs` collection, deterministically, in bounded
 * batches (never an unbounded single read, never a full-collection
 * in-memory load) — this is an explicit manual operational verification
 * command, not an interactive API request path, so a complete inventory
 * scan is the correct and safest verification mechanism (unlike the
 * rejected end-user dual-reader design from Phase 8C-B1.3A, which had to
 * stay bounded per-request for latency reasons this script does not
 * share).
 *
 * Classification reuses `classifyRunForInvariantCheck()`
 * (`lib/projects/projectRunInvariantCheck.ts`) — the single source of
 * truth for this invariant's verdicts. No competing classification logic
 * lives in this script.
 *
 * Usage:
 *   npm run verify:project-run-invariant -- --confirm-project=convergepanel
 */

const dotenv = require("dotenv");
const nodePath = require("path");
dotenv.config({ path: nodePath.resolve(__dirname, "../../.env.local") });

import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb, FIREBASE_PROJECT_ID, getInitializedFirebaseProjectId } from "@/lib/firebase/admin";
import { checkProjectIdentityConsistency } from "@/lib/workspaces/provisioningSafety";
import { classifyRunForInvariantCheck, isRunInvariantViolation, type RunInvariantVerdict } from "@/lib/projects/projectRunInvariantCheck";

const BATCH_SIZE = 500;
const MAX_EXAMPLE_IDS_PER_CATEGORY = 10;

function parseConfirmProjectArg(argv: string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--confirm-project=")) return arg.slice("--confirm-project=".length);
  }
  return undefined;
}

async function main() {
  if (!adminDb) {
    console.error("Firebase Admin Firestore is not available — check credentials.");
    process.exit(1);
  }

  const confirmProjectId = parseConfirmProjectArg(process.argv.slice(2));
  if (!confirmProjectId) {
    console.error("Missing required --confirm-project=<firebase-project-id> argument. This tool never guesses which project it is about to scan.");
    process.exit(1);
  }

  const identityCheck = checkProjectIdentityConsistency({
    envProjectId: FIREBASE_PROJECT_ID,
    actualProjectId: getInitializedFirebaseProjectId(),
  });
  if (!identityCheck.ok) {
    console.error(identityCheck.message);
    process.exit(1);
  }
  const actualProjectId = identityCheck.projectId;
  if (actualProjectId !== confirmProjectId) {
    console.error(`Refusing to scan: resolved Firebase project is "${actualProjectId}", but --confirm-project="${confirmProjectId}" does not match.`);
    process.exit(1);
  }

  console.log(`Firebase project: ${actualProjectId}`);
  console.log(`Database: (default)`);
  console.log(`Collection: runs`);
  console.log(`Mode: READ-ONLY health check (no writes, no normalization, no index changes)`);
  console.log("");

  const counts: Record<RunInvariantVerdict, number> = {
    legacy_no_workspace: 0,
    non_personal_workspace: 0,
    personal_unfiled: 0,
    personal_filed: 0,
    personal_violation_absent: 0,
    personal_violation_malformed: 0,
  };
  const exampleIds: Partial<Record<RunInvariantVerdict, string[]>> = {};

  let totalInspected = 0;
  let lastDocId: string | undefined;
  let scanCompleted = false;
  let scanError: string | undefined;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = adminDb.collection("runs").select("userId", "workspaceId", "projectId").orderBy(FieldPath.documentId()).limit(BATCH_SIZE);
      if (lastDocId) {
        query = query.startAfter(lastDocId);
      }
      const snap = await query.get();
      if (snap.empty) {
        scanCompleted = true;
        break;
      }

      for (const doc of snap.docs) {
        const data = doc.data();
        const verdict = classifyRunForInvariantCheck({
          userId: data.userId,
          hasWorkspaceIdField: Object.prototype.hasOwnProperty.call(data, "workspaceId"),
          workspaceIdValue: data.workspaceId,
          hasProjectIdField: Object.prototype.hasOwnProperty.call(data, "projectId"),
          projectIdValue: data.projectId,
        });
        counts[verdict]++;
        totalInspected++;

        if (isRunInvariantViolation(verdict) || verdict === "non_personal_workspace") {
          const bucket = exampleIds[verdict] ?? (exampleIds[verdict] = []);
          if (bucket.length < MAX_EXAMPLE_IDS_PER_CATEGORY) bucket.push(doc.id);
        }
      }

      lastDocId = snap.docs[snap.docs.length - 1].id;
      console.log(`  ...scanned ${totalInspected} runs so far`);

      if (snap.size < BATCH_SIZE) {
        scanCompleted = true;
        break;
      }
    }
  } catch (err: unknown) {
    scanError = err instanceof Error ? err.message : String(err);
  }

  console.log("");
  console.log("=== RESULTS ===");
  console.log(`Total runs inspected: ${totalInspected}`);
  console.log(`Scan completed (exhausted the full collection): ${scanCompleted}`);
  if (scanError) {
    console.log(`Scan error: ${scanError}`);
  }
  console.log("");
  console.log(`Legacy runs without workspaceId (out of scope for this invariant): ${counts.legacy_no_workspace}`);
  console.log(`Team-bound / non-Personal-workspace rows encountered: ${counts.non_personal_workspace}`);
  console.log(`Personal Workspace-bound, canonical Unfiled (projectId: null): ${counts.personal_unfiled}`);
  console.log(`Personal Workspace-bound, filed (valid Project id): ${counts.personal_filed}`);
  console.log(`VIOLATIONS — Personal Workspace-bound, projectId absent: ${counts.personal_violation_absent}`);
  console.log(`VIOLATIONS — Personal Workspace-bound, projectId malformed: ${counts.personal_violation_malformed}`);

  const totalViolations = counts.personal_violation_absent + counts.personal_violation_malformed;
  for (const key of Object.keys(exampleIds) as RunInvariantVerdict[]) {
    console.log(`  example ${key} run ids (up to ${MAX_EXAMPLE_IDS_PER_CATEGORY}): ${exampleIds[key]!.join(", ")}`);
  }

  console.log("");
  const invariantClean = scanCompleted && !scanError && totalViolations === 0;
  console.log(`Overall invariant status: ${invariantClean ? "PASS" : "FAIL"}`);

  if (!scanCompleted || scanError) {
    console.error("Scan did not complete safely/authoritatively — treating as a failure regardless of violation count.");
    process.exit(2);
  }
  if (totalViolations > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("PROJECT_RUN_INVARIANT_CHECK_SCRIPT_ERROR:", err);
  process.exit(1);
});
