/**
 * Phase 6D.3A — the ONE function in the entire normalization feature
 * area capable of writing to `runs/{id}`. Everything else (the Phase
 * 6D.1 dry-run tool, the fingerprint module, the executor's own
 * preflight) is read-only by construction. This function is never
 * called directly by the dry-run tool or by any application runtime
 * path — only by the future executor's execute mode, and only after
 * that executor's own candidate-set fingerprint gate has already
 * passed.
 *
 * Per-call safety, independent of anything computed earlier (a stale
 * preflight classification is never trusted alone):
 *   1. fresh `runs/{id}.get()` — never reuses an earlier snapshot
 *   2. fresh Workspace-binding revalidation via the same canonical
 *      `validateRunWorkspaceBinding()` the dry-run tool uses
 *   3. fresh field-presence check — `projectId` must still be
 *      genuinely absent on THIS read, not merely at preflight time
 *   4. the write touches exactly one field, `projectId: null` — no
 *      `updatedAt`, no other field, ever — guarded by Firestore's
 *      native `lastUpdateTime` precondition (never the application
 *      `ProjectV1`-style `updatedAt`, which doesn't apply to runs and
 *      wouldn't provide a real concurrency guarantee here anyway)
 *   5. no retry of any kind — a precondition failure is reported as
 *      `precondition_failed` and the caller (the executor) is
 *      responsible for stopping, never silently retrying
 *
 * Never emits a `projectEvents` document — this is infrastructure
 * schema normalization, not a user Project-organization action (frozen
 * decision, Phase 6D.1).
 */

import "server-only";
import { Status } from "google-gax";
import { adminDb } from "@/lib/firebase/admin";
import { validateRunWorkspaceBinding } from "./validateRunWorkspaceBinding";
import { classifyProjectIdFieldState } from "./runProjectNormalizationEligibility";

export type NormalizeRunProjectIdStatus =
  | "normalized"
  | "skipped_not_absent"
  | "invalid_workspace_binding"
  | "not_found"
  | "precondition_failed"
  | "firestore_unavailable"
  | "read_failed"
  | "write_failed";

export interface NormalizeRunProjectIdResult {
  status: NormalizeRunProjectIdStatus;
}

export async function normalizeRunProjectId(runId: string): Promise<NormalizeRunProjectIdResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  let snap;
  try {
    snap = await adminDb.collection("runs").doc(runId).get();
  } catch {
    return { status: "read_failed" };
  }
  if (!snap.exists) {
    return { status: "not_found" };
  }

  const data = snap.data() as Record<string, unknown>;
  const userId = typeof data.userId === "string" ? data.userId : "";
  const workspaceId = data.workspaceId;

  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { status: "invalid_workspace_binding" };
  }
  const workspaceValid = await validateRunWorkspaceBinding(userId, workspaceId);
  if (!workspaceValid) {
    return { status: "invalid_workspace_binding" };
  }

  const fieldState = classifyProjectIdFieldState({
    hasProjectIdField: Object.prototype.hasOwnProperty.call(data, "projectId"),
    projectIdValue: data.projectId,
  });
  if (fieldState !== "absent") {
    // Already null / assigned / malformed as of THIS fresh read — never
    // overwritten. Idempotent skip, not an error.
    return { status: "skipped_not_absent" };
  }

  try {
    await adminDb
      .collection("runs")
      .doc(runId)
      .update({ projectId: null }, { lastUpdateTime: snap.updateTime });
    return { status: "normalized" };
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === Status.FAILED_PRECONDITION || message.includes("FAILED_PRECONDITION")) {
      return { status: "precondition_failed" };
    }
    return { status: "write_failed" };
  }
}
