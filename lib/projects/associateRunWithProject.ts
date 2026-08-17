/**
 * Run/Project Association, Phase 6D.4A — the ONE function that mutates a
 * run's `projectId` (assign/move/unassign). Structural sibling of
 * `submitAdaptiveHumanReviewAssignment()` (`lib/firestore/runs.ts`): a
 * single `adminDb.runTransaction()` reading every document the decision
 * depends on, validating everything inside that same transaction, and
 * writing at most one field before returning a discriminated-union result
 * — never throws.
 *
 * Read order inside the transaction (mirrors `resolveProjectForOwner()`'s
 * frozen read order, adapted for a transaction touching a run instead of
 * a Project):
 *   1. read `runs/{runId}` and the caller's own `workspaces/{personal-uid}`
 *      together (`Promise.all`, both via `txn.get`) — transaction-
 *      consistent, never a stale non-transactional pre-check.
 *   2. validate the caller's OWN Personal Workspace is genuinely valid
 *      (exists, well-formed, embedded id matches, owned by this uid,
 *      type "personal") — a failure here is a caller-infrastructure
 *      problem, not an existence fact about someone else's data, so it is
 *      reported distinctly (`workspace_invalid`) and NOT concealed the
 *      way a foreign run is.
 *   3. validate the run itself: exists, owned by this uid, has a
 *      `workspaceId` field (a legacy/unbound run is never
 *      Project-assignable), and that field equals the caller's own
 *      Workspace id. ANY failure here — missing, wrong owner, wrong
 *      workspace, legacy/unbound — collapses to the same `run_not_found`,
 *      so a caller can never use this endpoint to learn whether a given
 *      run id exists at all, let alone whose it is (no enumeration
 *      oracle; mirrors `resolveProjectForOwner()`'s workspace_mismatch ->
 *      404-project_not_found concealment).
 *   4. classify the run's CURRENT `projectId` field by property presence,
 *      never truthiness (`classifyProjectIdFieldState`, reused verbatim
 *      from Phase 6D.1/6D.3 — never a second, competing classifier).
 *      `absent` and `null` both mean "semantically Unfiled" here — the
 *      Phase 6D.3 invariant means a modern bound-valid run should never
 *      be `absent`, but this function must still treat one exactly like
 *      `null` for compatibility rather than assuming the invariant always
 *      holds. `malformed` fails closed: the run is never mutated, the
 *      caller gets a generic internal error, and the caller of THIS
 *      function is responsible for logging it exactly once (deliberately
 *      NOT logged inside the transaction callback itself — see the
 *      module-level side-effect note below).
 *   5. optimistic `expectedProjectId` contract: the caller's belief about
 *      the run's current Project must match exactly, or `conflict`
 *      (mapped to 409 at the route). The response never echoes the
 *      run's actual current `projectId` — that would let a stale-token
 *      conflict be used to probe organizational state.
 *   6. no-op short-circuit: target === current (post expected-state
 *      check) is `unchanged` (409) — never a silent success, never a
 *      write, never an event.
 *   7. only when the target is non-null: read `projects/{targetProjectId}`
 *      (same transaction) and validate existence, `ProjectV1` shape,
 *      embedded id match, `workspaceId` equal to the caller's own
 *      Workspace id, and `status === "active"`. Any failure other than
 *      "archived" collapses to `target_not_found` (concealed 404,
 *      indistinguishable from "doesn't exist" — never reveals a foreign
 *      Project's existence, mirroring `resolveProjectForOwner()`'s own
 *      workspace_mismatch handling for exactly the same reason: never
 *      read a foreign Workspace document to decide this, the string
 *      comparison against the caller's own deterministic Workspace id is
 *      sufficient). "Archived" gets its own distinguishable `target_archived`
 *      — safe to reveal because ownership was already established by the
 *      time this check runs.
 *   8. unassign (`targetProjectId === null`) never reads a target Project
 *      at all, and never requires the CURRENT Project (if any) to still
 *      be active — moving out of (or moving between, when the destination
 *      is active) an archived Project is explicitly allowed; only writing
 *      INTO an archived Project is rejected.
 *   9. the write touches exactly one field: `projectId`. No `updatedAt`,
 *      no `workspaceId`, no other run field, ever.
 *
 * Transaction-callback purity: the callback contains ONLY Firestore
 * reads/writes and pure comparisons — no `writeProjectEvent`, no
 * analytics, no logging call of any kind, because Firestore may retry
 * this callback internally on contention and any external side effect
 * inside it could duplicate across retries. The one case that would
 * otherwise want to log (`run_state_invalid`, a malformed stored
 * `projectId`) instead returns that status and is logged exactly once by
 * THIS function's caller-facing wrapper, after `runTransaction()` has
 * already resolved — never inside the retryable callback itself.
 *
 * No application-level retry wraps `runTransaction()` — Firestore's own
 * internal optimistic-concurrency retry is the only retry behavior here.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { WORKSPACES_ENABLED } from "@/lib/env";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { isWellFormedWorkspaceV1 } from "@/lib/workspaces/types";
import { isWellFormedProjectV1 } from "./types";
import { classifyProjectIdFieldState } from "./runProjectNormalizationEligibility";

export type AssociateRunWithProjectResult =
  | { status: "associated"; runId: string; workspaceId: string; fromProjectId: string | null; toProjectId: string | null }
  | { status: "workspaces_disabled" }
  | { status: "workspace_invalid" }
  | { status: "run_not_found" }
  | { status: "run_state_invalid" }
  | { status: "conflict" }
  | { status: "unchanged" }
  | { status: "target_not_found" }
  | { status: "target_archived" }
  | { status: "firestore_unavailable" }
  | { status: "transaction_failed" };

export async function associateRunWithProject(args: {
  uid: string;
  runId: string;
  targetProjectId: string | null;
  expectedProjectId: string | null;
}): Promise<AssociateRunWithProjectResult> {
  if (!WORKSPACES_ENABLED) {
    return { status: "workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const workspaceIdResult = getPersonalWorkspaceId(args.uid);
  if (!workspaceIdResult.ok) {
    // Defensive only: every route-level identity resolver already
    // validates the authenticated uid before it reaches here.
    return { status: "workspace_invalid" };
  }
  const expectedWorkspaceId = workspaceIdResult.workspaceId;

  let result: AssociateRunWithProjectResult;
  try {
    result = await adminDb.runTransaction<AssociateRunWithProjectResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const workspaceRef = adminDb!.collection("workspaces").doc(expectedWorkspaceId);
      const [runSnap, workspaceSnap] = await Promise.all([txn.get(runRef), txn.get(workspaceRef)]);

      // Step 2 — caller's OWN Workspace validity. Not concealment-
      // sensitive: this is the caller's own resource, not a fact about
      // anyone else's data.
      if (!workspaceSnap.exists) {
        return { status: "workspace_invalid" };
      }
      const workspaceData = workspaceSnap.data();
      if (!isWellFormedWorkspaceV1(workspaceData) || workspaceData.id !== expectedWorkspaceId) {
        return { status: "workspace_invalid" };
      }
      if (workspaceData.ownerUserId !== args.uid || workspaceData.type !== "personal") {
        return { status: "workspace_invalid" };
      }

      // Step 3 — run existence/ownership/binding. Every failure path
      // collapses to the same concealed outcome.
      if (!runSnap.exists) {
        return { status: "run_not_found" };
      }
      const runData = runSnap.data() as Record<string, unknown>;
      if (typeof runData.userId !== "string" || runData.userId !== args.uid) {
        return { status: "run_not_found" };
      }
      const hasWorkspaceIdField = Object.prototype.hasOwnProperty.call(runData, "workspaceId");
      const workspaceIdValue = runData.workspaceId;
      if (!hasWorkspaceIdField || workspaceIdValue === null || workspaceIdValue === undefined) {
        // Legacy/unbound run — never Project-assignable.
        return { status: "run_not_found" };
      }
      if (workspaceIdValue !== expectedWorkspaceId) {
        // Foreign/team workspace — never disclose this run's existence.
        return { status: "run_not_found" };
      }

      // Step 4 — classify current projectId by field presence.
      const hasProjectIdField = Object.prototype.hasOwnProperty.call(runData, "projectId");
      const projectIdValue = runData.projectId;
      const fieldState = classifyProjectIdFieldState({ hasProjectIdField, projectIdValue });
      let currentProjectId: string | null;
      if (fieldState === "absent" || fieldState === "null") {
        currentProjectId = null;
      } else if (fieldState === "assigned") {
        currentProjectId = projectIdValue as string;
      } else {
        return { status: "run_state_invalid" };
      }

      // Step 5 — optimistic expected-state contract.
      if (currentProjectId !== args.expectedProjectId) {
        return { status: "conflict" };
      }

      // Step 6 — no-op short-circuit.
      if (currentProjectId === args.targetProjectId) {
        return { status: "unchanged" };
      }

      // Step 7 — target Project validation, only when assigning/moving.
      if (args.targetProjectId !== null) {
        const targetRef = adminDb!.collection("projects").doc(args.targetProjectId);
        const targetSnap = await txn.get(targetRef);
        if (!targetSnap.exists) {
          return { status: "target_not_found" };
        }
        const targetData = targetSnap.data();
        if (!isWellFormedProjectV1(targetData) || targetData.id !== args.targetProjectId) {
          return { status: "target_not_found" };
        }
        if (targetData.workspaceId !== expectedWorkspaceId) {
          // Foreign Project — never disclose this via a different status.
          return { status: "target_not_found" };
        }
        if (targetData.status !== "active") {
          return { status: "target_archived" };
        }
      }

      // Step 9 — exactly one field, nothing else.
      txn.update(runRef, { projectId: args.targetProjectId });

      return {
        status: "associated",
        runId: args.runId,
        workspaceId: expectedWorkspaceId,
        fromProjectId: currentProjectId,
        toProjectId: args.targetProjectId,
      };
    });
  } catch (err) {
    logger.warn("[projects/associateRunWithProject] Transaction failed", {
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "transaction_failed" };
  }

  // Logged exactly once, outside the (potentially internally-retried)
  // transaction callback — never inside it.
  if (result.status === "run_state_invalid") {
    logger.error("[projects/associateRunWithProject] Malformed projectId field on run — refusing to mutate", { runId: args.runId });
  }

  return result;
}
