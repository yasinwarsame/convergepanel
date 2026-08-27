/**
 * Team Run→Project Association, Phase 8C-C — the ONE function that
 * mutates a Team-bound run's `projectId` (assign/move/unassign). Team
 * analog of `associateRunWithProject()`, built the same way B1/B2's Team
 * helpers were built as analogs of their Personal precedents: same OCC
 * contract, same no-op policy, same archived-source/target rules, same
 * single-field write shape — but ownership-based authorization is
 * replaced with Workspace-capability authorization, and Personal's
 * `absent projectId ≈ null` compatibility carve-out is deliberately NOT
 * carried over (Team has no such legacy debt — see
 * `validateTeamRunRowShape()`'s own doc comment).
 *
 * Frozen by the Phase 8C-C.0 architecture audit, with three corrections
 * to that audit's own initial draft, each grounded in direct reading of
 * the actual Phase 8C-A Team Project mutation precedent
 * (`lib/firestore/teamProjects.ts`) rather than the B2/B3 Team *read*
 * pattern:
 *
 *   1. NO separate request-time Workspace-access precheck
 *      (`resolveTeamRunWorkspaceAccess()`/`resolveWorkspaceAccess()`) is
 *      performed anywhere — not by this function, not by its caller.
 *      `authorizeTeamWorkspaceMutationInTransaction()` inside the
 *      transaction below is the ONLY authorization gate, exactly
 *      mirroring `createTeamProject()`/`updateTeamProjectFields()`. A
 *      non-transactional precheck would add I/O without adding security
 *      (the transaction re-derives everything from scratch regardless)
 *      and would create a second place for the two checks to drift.
 *
 *   2. This function itself owns the Team rollout gate
 *      (`resolveTeamWorkspacesMode()`), checked before any Firestore
 *      access — never left to the HTTP route layer — so the function
 *      remains safe if a future trusted server caller invokes it
 *      directly, outside this phase's own route.
 *
 *   3. Run-integrity validation reuses `validateTeamRunRowShape()`
 *      (`lib/workspaces/teamRunRowValidation.ts`, already shared by both
 *      Phase 8C-B2 list routes) verbatim, rather than a hand-rolled
 *      workspaceId/projectId comparison — it already encodes exactly the
 *      Team-correct semantics this mutation needs (workspaceId must
 *      equal the requested Workspace exactly; `projectId` must be
 *      exactly `null` or a valid assigned string; `absent`/`malformed`
 *      both fail closed, never reinterpreted as Unfiled).
 *
 * Read order inside the transaction:
 *   1. `authorizeTeamWorkspaceMutationInTransaction()` — Workspace W
 *      (exists, well-formed, `type === "team"`), caller's own active
 *      membership, canonical owner-membership invariant, and
 *      `research.organize` capability, all freshly re-derived from
 *      documents read through THIS transaction. Run creator identity
 *      plays no role here — `run.userId` is never read for
 *      authorization, only ever as attribution inside the returned DTO.
 *   2. `runs/{runId}`, read via `tx.get()` — never a route-level
 *      snapshot passed in from outside the transaction.
 *   3. `validateTeamRunRowShape(runData, workspaceId)` — a run that is
 *      absent, legacy (no `workspaceId`), Personal-bound, bound to a
 *      *different* Team Workspace, or has an absent/malformed
 *      `projectId` all collapse to the same `run_not_found` result —
 *      never opportunistically repaired, never distinguished externally.
 *   4. optimistic `expectedProjectId` contract: the caller's belief about
 *      the run's current Project must match exactly (value comparison,
 *      not a Firestore-native `{lastUpdateTime}` token — deliberately
 *      symmetric with Personal's own `associateRunWithProject()` OCC
 *      contract, since both mutate the identical `projectId` field with
 *      an identical client-facing shape), or `conflict`.
 *   5. no-op short-circuit: target === current (post expected-state
 *      check) is `unchanged` — never a silent success, never a write,
 *      never an event.
 *   6. only when the target is non-null: read `projects/{targetProjectId}`
 *      (same transaction) and validate existence, `ProjectV1` shape,
 *      embedded id match, `workspaceId` equal to W, and
 *      `status === "active"`. Any failure other than "archived" collapses
 *      to `target_not_found` (concealed); "archived" gets its own
 *      distinguishable `target_archived` (safe — authorization/ownership
 *      already established by the time this runs).
 *   7. unassign (`targetProjectId === null`) never reads a target
 *      Project at all, and the CURRENT/source Project (if any) is never
 *      read either, regardless of operation — moving out of, or between,
 *      an archived Project is explicitly allowed; only writing INTO an
 *      archived Project is rejected.
 *   8. (Phase 9B.2) active Workspace-review projection reads:
 *      `runs/{runId}/humanReviewAssignment/current` and
 *      `.../humanReviewPanel/current`, both read here — BEFORE any write
 *      in this transaction — because the Admin SDK requires every read to
 *      happen before any write, and throws otherwise. Each is a candidate
 *      for `projectId`-mirror sync only if it exists AND already carries a
 *      Workspace metadata mirror (its own `workspaceId` field, matching
 *      this Workspace) — a legacy assignment/panel with no `workspaceId`
 *      mirror is left completely untouched, never treated as a Workspace
 *      projection it isn't.
 *   9. every write in this transaction, together, only after every read
 *      above (steps 1-8): the run write touches exactly one field,
 *      `projectId` — no `updatedAt`, no `workspaceId`, no other run field,
 *      ever. If step 8 found a Workspace-bound assignment and/or panel,
 *      each gets the identical one-field `projectId` write — `revision` is
 *      never incremented on either, `updatedAt` is never touched, and no
 *      append-only history entry is written for either: this is projection
 *      maintenance, NOT a reviewer-assignment/panel mutation. No other
 *      Project-side projection of any kind is written — association truth
 *      remains solely `run.projectId`.
 *
 * Transaction-callback purity: the callback contains ONLY Firestore
 * reads/writes and pure comparisons — no event emission, no logging of
 * any kind, because Firestore may retry this callback internally on
 * contention and any external side effect inside it could duplicate or
 * misfire across retries. A genuine transaction failure is logged
 * exactly once by this function's own wrapper, after `runTransaction()`
 * has already resolved (rejected) — never inside the retryable callback
 * itself. Event emission (`project_run_association_changed`) is the
 * CALLER's responsibility, strictly post-commit, best-effort — this
 * module never imports `writeProjectEvent`/`writeTeamProjectEventSafely`.
 *
 * No application-level retry wraps `runTransaction()` — Firestore's own
 * internal optimistic-concurrency retry is the only retry behavior here,
 * and every check above re-executes fresh on every retried invocation.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { isWellFormedProjectV1 } from "./types";

/** Phase 9B.2 — narrow presence check for a Workspace-metadata mirror field; not a full parse, deliberately, since Step 9 only ever needs to know whether a mirror exists at all. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type AssociateTeamRunWithProjectResult =
  | { status: "associated"; runId: string; workspaceId: string; fromProjectId: string | null; toProjectId: string | null }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "run_not_found" }
  | { status: "conflict" }
  | { status: "unchanged" }
  | { status: "target_not_found" }
  | { status: "target_archived" }
  | { status: "transaction_failed" };

export async function associateTeamRunWithProject(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  targetProjectId: string | null;
  expectedProjectId: string | null;
}): Promise<AssociateTeamRunWithProjectResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  let result: AssociateTeamRunWithProjectResult;
  try {
    result = await adminDb.runTransaction<AssociateTeamRunWithProjectResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.organize",
      });
      if (!auth.ok) {
        return { status: "unauthorized", reason: auth.reason };
      }

      // Step 2 — the run itself, read fresh through this transaction —
      // never a route-level snapshot passed in from outside.
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) {
        return { status: "run_not_found" };
      }

      // Step 3 — Team run-shape validation, reused verbatim from Phase
      // 8C-B2. Legacy, Personal-bound, foreign-Team-Workspace, and
      // absent/malformed-projectId rows all collapse to the same
      // `run_not_found` — never opportunistically repaired.
      const runData = runSnap.data() as Record<string, unknown>;
      const validated = validateTeamRunRowShape(runData, args.workspaceId);
      if (!validated.ok) {
        return { status: "run_not_found" };
      }
      const currentProjectId = validated.projectId;

      // Step 4 — optimistic expected-state contract.
      if (currentProjectId !== args.expectedProjectId) {
        return { status: "conflict" };
      }

      // Step 5 — no-op short-circuit.
      if (currentProjectId === args.targetProjectId) {
        return { status: "unchanged" };
      }

      // Step 6 — target Project validation, only when assigning/moving.
      // The CURRENT/source Project (if any) is never read, regardless of
      // operation.
      if (args.targetProjectId !== null) {
        const targetRef = adminDb!.collection("projects").doc(args.targetProjectId);
        const targetSnap = await tx.get(targetRef);
        if (!targetSnap.exists) {
          return { status: "target_not_found" };
        }
        const targetData = targetSnap.data();
        if (!isWellFormedProjectV1(targetData) || targetData.id !== args.targetProjectId) {
          return { status: "target_not_found" };
        }
        if (targetData.workspaceId !== args.workspaceId) {
          // Foreign Workspace — never disclose this via a different status.
          return { status: "target_not_found" };
        }
        if (targetData.status !== "active") {
          return { status: "target_archived" };
        }
      }

      // Step 8 (Phase 9B.2) — active Workspace-review projection reads; see
      // the header doc comment (step 8) for the full rationale and the
      // read-before-write ordering requirement.
      const assignmentRef = runRef.collection("humanReviewAssignment").doc("current");
      const panelRef = runRef.collection("humanReviewPanel").doc("current");
      const [assignmentSnap, panelSnap] = await Promise.all([tx.get(assignmentRef), tx.get(panelRef)]);

      const assignmentData = assignmentSnap.exists ? (assignmentSnap.data() as Record<string, unknown> | undefined) : undefined;
      const syncAssignmentMirror = isNonEmptyString(assignmentData?.workspaceId) && assignmentData!.workspaceId === args.workspaceId;

      const panelData = panelSnap.exists ? (panelSnap.data() as Record<string, unknown> | undefined) : undefined;
      const syncPanelMirror = isNonEmptyString(panelData?.workspaceId) && panelData!.workspaceId === args.workspaceId;

      // Step 9 — every write, together, only after every read above.
      tx.update(runRef, { projectId: args.targetProjectId });
      if (syncAssignmentMirror) {
        tx.update(assignmentRef, { projectId: args.targetProjectId });
      }
      if (syncPanelMirror) {
        tx.update(panelRef, { projectId: args.targetProjectId });
      }

      return {
        status: "associated",
        runId: args.runId,
        workspaceId: args.workspaceId,
        fromProjectId: currentProjectId,
        toProjectId: args.targetProjectId,
      };
    });
  } catch (err) {
    // Logged exactly once, outside the (potentially internally-retried)
    // transaction callback — never inside it.
    logger.warn("[projects/associateTeamRunWithProject] Transaction failed", {
      workspaceId: args.workspaceId,
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "transaction_failed" };
  }

  return result;
}
