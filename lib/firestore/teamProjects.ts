/**
 * Team Project Backend, Phase 8C-A — Firestore write primitives for Team
 * Projects. Deliberately NOT a reuse or modification of `createProject()`/
 * `updateProjectFields()` in `lib/firestore/projects.ts`: those perform
 * their writes via plain `DocumentReference.create()/.update()` outside
 * any transaction, so their function bodies cannot be invoked from inside
 * a `runTransaction()` callback (every read AND write inside a Firestore
 * transaction must go through the same `Transaction` handle). What IS
 * reused from that file is the exact `ProjectV1` document shape those
 * functions already write — this module mirrors it, never invents a
 * divergent one.
 *
 * Both functions here open exactly one `adminDb.runTransaction()`, inside
 * which `authorizeTeamWorkspaceMutationInTransaction()` re-derives
 * authorization from state read through the SAME transaction handle as
 * the write — see that module's doc comment for the revocation-race
 * rationale. Firestore internal transaction retries are the ONLY retry
 * mechanism in play; neither function wraps `runTransaction()` in any
 * application-level retry loop.
 */

import "server-only";
import { Status } from "google-gax";
import { Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { isWellFormedProjectV1, type ProjectV1 } from "@/lib/projects/types";

export type CreateTeamProjectResult =
  | { status: "created"; project: ProjectV1; documentUpdateTime: Timestamp }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "create_failed" };

/**
 * The opaque Project id/ref is allocated exactly ONCE, via
 * `adminDb.collection("projects").doc()`, BEFORE `runTransaction()` is
 * ever entered — never inside the retryable callback. Firestore may
 * internally re-invoke the callback on a conflict; generating a fresh
 * auto-id on each invocation would mean a retried attempt silently
 * targets a DIFFERENT document identity than the one already reasoned
 * about (and potentially already partially observed) by the caller. The
 * id, once allocated, is passed into every retry of the callback
 * unchanged, exactly like `createProject()`'s own frozen Phase 6A.1
 * creation invariant.
 */
export async function createTeamProject(args: { uid: string; workspaceId: string; name: string }): Promise<CreateTeamProjectResult> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const projectRef = adminDb.collection("projects").doc();
  const projectId = projectRef.id;

  type TxResult = { kind: "created"; project: ProjectV1 } | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason };

  try {
    const txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "projects.create" });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      const now = Timestamp.now();
      const project: ProjectV1 = {
        schemaVersion: 1,
        id: projectId,
        workspaceId: args.workspaceId,
        name: args.name,
        status: "active",
        // Server-authenticated identity only — never a client-supplied
        // value. This is the ONLY place a Team Project's
        // `createdByUserId` is ever set; it is immutable thereafter (no
        // Team Project mutation in this module ever writes this field
        // again).
        createdByUserId: args.uid,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(projectRef, project);
      return { kind: "created", project };
    });

    if (txResult.kind === "unauthorized") {
      return { status: "unauthorized", reason: txResult.reason };
    }

    // Post-commit read — NOT a mutation retry. `tx.create()` has no
    // `WriteResult` of its own (unlike a non-transactional `.create()`),
    // so the authoritative native `updateTime` for the response DTO can
    // only come from re-reading the document after the transaction has
    // already committed successfully.
    const postCommitSnap = await projectRef.get();
    return { status: "created", project: txResult.project, documentUpdateTime: postCommitSnap.updateTime as Timestamp };
  } catch (err) {
    logger.warn("[firestore/teamProjects] Team Project creation transaction failed", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "create_failed" };
  }
}

export type TeamProjectMutation = { kind: "rename"; name: string } | { kind: "archive" } | { kind: "restore" };

export type UpdateTeamProjectFieldsResult =
  | { status: "updated"; project: ProjectV1; documentUpdateTime: Timestamp }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "project_not_found" }
  | { status: "invalid_transition" }
  | { status: "precondition_failed" }
  | { status: "update_failed" };

/**
 * Read/validate order inside the transaction (mirrors
 * `authorizeTeamWorkspaceMutationInTransaction()`'s own frozen order,
 * extended with the Project-specific steps Section 16 requires):
 *   1. Team authorization (`projects.manage`).
 *   2. Read Project `projectId` through the SAME transaction handle.
 *   3. Validate the Project: well-formed, embedded `id === projectId`,
 *      `workspaceId === args.workspaceId` — a Project belonging to a
 *      different Workspace than the route's own `{workspaceId}` is
 *      concealed identically to a genuinely missing Project (Section 20
 *      cross-Workspace concealment), never partially read or revealed.
 *   4. Validate the lifecycle precondition for the requested mutation
 *      (archive requires `status === "active"`; restore requires
 *      `status === "archived"`; rename has no status precondition,
 *      mirroring the existing Personal rename route's identical policy).
 *   5. Compare the freshly-read snapshot `updateTime` against the
 *      caller-supplied `expectedUpdateTime` — an early, clear rejection
 *      for the common case.
 *   6. `tx.update()`, passing `expectedUpdateTime` itself as the
 *      authoritative `{lastUpdateTime}` precondition — never a value
 *      re-read inside this transaction — so a stale caller belief still
 *      fails on every Firestore-internal retry of this callback, exactly
 *      mirroring `transferTeamWorkspaceOwnership()`'s documented dual
 *      fast-path/authoritative precondition contract.
 */
export async function updateTeamProjectFields(args: {
  uid: string;
  workspaceId: string;
  projectId: string;
  mutation: TeamProjectMutation;
  expectedUpdateTime: Timestamp;
}): Promise<UpdateTeamProjectFieldsResult> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  type TxResult =
    | { kind: "updated"; project: ProjectV1 }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "project_not_found" }
    | { kind: "invalid_transition" }
    | { kind: "stale" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "projects.manage" });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      const projectRef = adminDb!.collection("projects").doc(args.projectId);
      const projectSnap = await tx.get(projectRef);
      if (!projectSnap.exists) {
        return { kind: "project_not_found" };
      }
      const projectData = projectSnap.data();
      if (!isWellFormedProjectV1(projectData) || projectData.id !== args.projectId || projectData.workspaceId !== args.workspaceId) {
        return { kind: "project_not_found" };
      }
      const project = projectData;

      if (args.mutation.kind === "archive" && project.status !== "active") {
        return { kind: "invalid_transition" };
      }
      if (args.mutation.kind === "restore" && project.status !== "archived") {
        return { kind: "invalid_transition" };
      }

      const documentUpdateTime = projectSnap.updateTime as Timestamp;
      if (documentUpdateTime.seconds !== args.expectedUpdateTime.seconds || documentUpdateTime.nanoseconds !== args.expectedUpdateTime.nanoseconds) {
        return { kind: "stale" };
      }

      const now = Timestamp.now();
      const data: Partial<Pick<ProjectV1, "name" | "status" | "updatedAt">> =
        args.mutation.kind === "rename"
          ? { name: args.mutation.name, updatedAt: now }
          : args.mutation.kind === "archive"
            ? { status: "archived", updatedAt: now }
            : { status: "active", updatedAt: now };

      tx.update(projectRef as DocumentReference, data, { lastUpdateTime: args.expectedUpdateTime });

      return { kind: "updated", project: { ...project, ...data } };
    });
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === Status.FAILED_PRECONDITION || message.includes("FAILED_PRECONDITION")) {
      // The native Firestore precondition fired — a stale token slipped
      // past the fast-path check above (e.g. a concurrent write landed
      // between this transaction's read and its commit, including across
      // an internal Firestore retry) but was still caught here,
      // authoritatively. Never distinguished from the fast-path "stale"
      // outcome at the public response layer.
      return { status: "precondition_failed" };
    }
    logger.warn("[firestore/teamProjects] Team Project update transaction failed", { workspaceId: args.workspaceId, projectId: args.projectId, error: message });
    return { status: "update_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "project_not_found":
      return { status: "project_not_found" };
    case "invalid_transition":
      return { status: "invalid_transition" };
    case "stale":
      return { status: "precondition_failed" };
    case "updated": {
      // Post-commit read — NOT a mutation retry. `tx.update()` has no
      // `WriteResult` of its own; the authoritative native `updateTime`
      // for the response DTO can only come from re-reading the document
      // after the transaction has already committed successfully.
      const projectRef = adminDb.collection("projects").doc(args.projectId);
      const postCommitSnap = await projectRef.get();
      return { status: "updated", project: txResult.project, documentUpdateTime: postCommitSnap.updateTime as Timestamp };
    }
  }
}
