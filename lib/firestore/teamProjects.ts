/**
 * Team Project Backend, Phase 8C-A (post-commit-read semantics corrected
 * in Phase 8C-A.1) — Firestore write primitives for Team Projects.
 * Deliberately NOT a reuse or modification of `createProject()`/
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
 *
 * ================= EVENT-WRITING INVARIANT (revised) =================
 * Phase 8C-A.1 froze: this module never imports `writeProjectEvent` /
 * `writeTeamProjectEventSafely` / the `projectEvents` module. That
 * NON-transactional, best-effort `.add()` writer must never run inside a
 * transaction callback — Firestore may re-invoke the callback on a
 * conflict, and a plain `.add()` would persist once per DISCARDED attempt.
 * It stays route-layer-only, strictly after this module has returned.
 *
 * Phase PROJECT-AUDIT-AR-I1 narrows that rule to what it actually
 * protects: `updateTeamProjectFields()` MAY — and for archive/restore
 * MUST — write the authoritative Workspace Audit event
 * (`workspaceMembershipEvents`, `workspace_project_archived` /
 * `workspace_project_restored`) via `tx.set()` through the SAME
 * `Transaction` handle as the Project write. A transactional `tx.set()`
 * is buffered and committed only with the winning attempt, so a retried
 * or aborted callback leaves no event, and `PROJECT LIFECYCLE CHANGE
 * COMMITTED IFF WORKSPACE AUDIT EVENT COMMITTED` holds structurally —
 * the same standard `removeWorkspaceMembership()` /
 * `changeTeamWorkspaceMemberRole()` already enforce for membership
 * events. The legacy post-commit `projectEvents` write in the route layer
 * is unchanged and remains unread by Workspace Audit.
 * (`lib/firestore/__tests__/teamProjectsNeverWritesEvents.spec.ts` is the
 * structural guard for both halves of this invariant.)
 *
 * ================= POST-COMMIT READ FAILURE CONTRACT =================
 * `tx.create()`/`tx.update()` have no `WriteResult` of their own (unlike
 * their non-transactional counterparts), so the authoritative native
 * `updateTime` for the response DTO can only come from a POST-COMMIT read
 * — issued strictly AFTER `runTransaction()` has already resolved
 * successfully. That read is deliberately wrapped in its OWN try/catch,
 * separate from the transaction's try/catch (a Phase 8C-A.1 correction —
 * the original Phase 8C-A implementation shared one try/catch across
 * both, which meant a transient failure of this SECOND, non-canonical
 * read was indistinguishable from the transaction itself failing,
 * silently implying to the caller that nothing had committed when the
 * Project had, in fact, already been created/updated).
 *
 * If the post-commit read fails, the function returns a status carrying
 * the word `projection_unavailable` (`created_projection_unavailable` /
 * `updated_projection_unavailable`) — NEVER the generic `create_failed`/
 * `update_failed`/`precondition_failed` statuses a genuine transaction
 * failure produces. The caller still receives the already-known `project`
 * object (the exact document just written, held in memory from the
 * transaction callback's own return value) but no `documentUpdateTime` —
 * there is no authoritative native `updateTime` to report, and this
 * module NEVER fabricates one (never `Timestamp.now()`, never
 * `project.updatedAt`, never the caller's own stale `expectedUpdateTime`
 * echoed back as if it were fresh). A caller that needs a fresh OCC token
 * after a `projection_unavailable` response must obtain one through an
 * ordinary, unrelated canonical read (e.g. the list route) — never by
 * retrying this same mutation, which would either duplicate the create
 * (a fresh opaque Project id) or redundantly re-apply the same lifecycle
 * transition.
 * =======================================================================
 */

import "server-only";
import { Status } from "google-gax";
import { Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { buildWorkspaceMembershipEventDocData } from "@/lib/workspaces/workspaceMembershipEvents";
import { isWellFormedProjectV1, type ProjectV1 } from "@/lib/projects/types";

export type CreateTeamProjectResult =
  | { status: "created"; project: ProjectV1; documentUpdateTime: Timestamp }
  // Transaction committed; the post-commit projection read failed. The
  // canonical mutation is NOT invalidated — see module doc comment.
  | { status: "created_projection_unavailable"; project: ProjectV1 }
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
 * creation invariant. It is also allocated exactly once per CALL to this
 * function — there is no application-level retry loop around
 * `runTransaction()` itself, so a genuine transaction failure never
 * silently re-attempts under a second id within the same invocation.
 */
export async function createTeamProject(args: { uid: string; workspaceId: string; name: string }): Promise<CreateTeamProjectResult> {
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

  const projectRef = adminDb.collection("projects").doc();
  const projectId = projectRef.id;

  type TxResult = { kind: "created"; project: ProjectV1 } | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
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
  } catch (err) {
    // The TRANSACTION ITSELF failed — genuinely nothing committed.
    logger.warn("[firestore/teamProjects] Team Project creation transaction failed — no Project was created", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "create_failed" };
  }

  if (txResult.kind === "unauthorized") {
    return { status: "unauthorized", reason: txResult.reason };
  }

  // The transaction has ALREADY committed successfully at this point —
  // the Project genuinely exists. Everything below is best-effort
  // projection, deliberately isolated in its own try/catch so a failure
  // here can NEVER be reported as though the mutation itself failed.
  try {
    const postCommitSnap = await projectRef.get();
    return { status: "created", project: txResult.project, documentUpdateTime: postCommitSnap.updateTime as Timestamp };
  } catch (err) {
    logger.warn("[firestore/teamProjects] Team Project created successfully but the post-commit projection read failed — canonical mutation is NOT invalidated", {
      workspaceId: args.workspaceId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "created_projection_unavailable", project: txResult.project };
  }
}

export type TeamProjectMutation = { kind: "rename"; name: string } | { kind: "archive" } | { kind: "restore" };

export type UpdateTeamProjectFieldsResult =
  | { status: "updated"; project: ProjectV1; documentUpdateTime: Timestamp }
  // Transaction committed; the post-commit projection read failed. The
  // canonical mutation is NOT invalidated — see module doc comment.
  | { status: "updated_projection_unavailable"; project: ProjectV1 }
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
 *   7. Phase PROJECT-AUDIT-AR-I1 — for `archive`/`restore` ONLY (never
 *      `rename`), stage `tx.set()` of the canonical Workspace Audit event
 *      (`workspace_project_archived` / `workspace_project_restored`) at a
 *      freshly-allocated `workspaceMembershipEvents` doc ref, in this SAME
 *      transaction. Every field is derived from state this transaction
 *      itself read and validated: `actorUid` from the authorized
 *      membership (step 1), `workspaceId`/`projectId`/`projectName` from
 *      the bound Project (steps 2-3), `at` the exact `now` used for the
 *      Project's own `updatedAt`. Nothing comes from the request. Both
 *      writes are buffered in the same attempt: the lifecycle change
 *      commits iff the event commits, and a discarded retry attempt
 *      leaves neither. A same-state request never reaches this step
 *      (step 4 already returned `invalid_transition`), so a rejected
 *      attempt is never audited.
 *
 * The post-commit projection read (for `documentUpdateTime`) is issued
 * strictly AFTER step 6 has already committed, in its own try/catch — see
 * this module's header comment for the full contract.
 */
export async function updateTeamProjectFields(args: {
  uid: string;
  workspaceId: string;
  projectId: string;
  mutation: TeamProjectMutation;
  expectedUpdateTime: Timestamp;
}): Promise<UpdateTeamProjectFieldsResult> {
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

      if (args.mutation.kind === "archive" || args.mutation.kind === "restore") {
        // Step 7 — authoritative Workspace Audit event, buffered in this
        // SAME transaction attempt as the lifecycle write above. `.doc()`
        // with no argument allocates an id locally (no read), so it is safe
        // after every read this transaction performs. See the module
        // header's EVENT-WRITING INVARIANT for why this is a `tx.set()` and
        // never the non-transactional `projectEvents` writer.
        const eventRef = adminDb!.collection("workspaceMembershipEvents").doc();
        tx.set(
          eventRef,
          buildWorkspaceMembershipEventDocData({
            eventType: args.mutation.kind === "archive" ? "workspace_project_archived" : "workspace_project_restored",
            actorUid: auth.membership.uid,
            workspaceId: project.workspaceId,
            projectId: project.id,
            projectName: project.name,
            at: now,
          })
        );
      }

      return { kind: "updated", project: { ...project, ...data } };
    });
  } catch (err: unknown) {
    // The TRANSACTION ITSELF failed — genuinely nothing committed.
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === Status.FAILED_PRECONDITION || message.includes("FAILED_PRECONDITION")) {
      return { status: "precondition_failed" };
    }
    logger.warn("[firestore/teamProjects] Team Project update transaction failed — no change was committed", { workspaceId: args.workspaceId, projectId: args.projectId, error: message });
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
      // The transaction has ALREADY committed successfully at this point
      // — the mutation genuinely applied. Everything below is
      // best-effort projection, isolated in its own try/catch so a
      // failure here can NEVER be reported as though the mutation itself
      // failed, and never masqueraded as a stale-token conflict either.
      const projectRef = adminDb.collection("projects").doc(args.projectId);
      try {
        const postCommitSnap = await projectRef.get();
        return { status: "updated", project: txResult.project, documentUpdateTime: postCommitSnap.updateTime as Timestamp };
      } catch (err) {
        logger.warn("[firestore/teamProjects] Team Project updated successfully but the post-commit projection read failed — canonical mutation is NOT invalidated", {
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: "updated_projection_unavailable", project: txResult.project };
      }
    }
  }
}
