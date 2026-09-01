/**
 * Team Workspace Core Foundation, Phase 8B — Firestore access for the
 * `workspaceMemberships/{id}` collection and the two Team Workspace write
 * primitives (`createTeamWorkspace()`, `transferTeamWorkspaceOwnership()`).
 * Mirrors `lib/firestore/workspaces.ts`/`lib/firestore/projects.ts`'s
 * established discriminated-result, never-throw, never-blind-cast
 * conventions.
 */

import "server-only";
import { Status } from "google-gax";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { resolveTeamWorkspaceTargetAdmission, capacityControlled } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { validateMembershipBinding } from "@/lib/workspaces/membershipBinding";
import { isCanonicalTeamOwnerMembership } from "@/lib/workspaces/ownerInvariant";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { canManageMembershipTargetRole } from "@/lib/workspaces/membershipTargetAuthority";
import { releaseTeamWorkspaceCanarySlot } from "@/lib/workspaces/teamWorkspaceCanaryCapacity";
import { buildWorkspaceMembershipEventDocData } from "@/lib/workspaces/workspaceMembershipEvents";
import type { WorkspaceMembershipRole, WorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";
import { isWellFormedWorkspaceV1, type TeamWorkspaceV1 } from "@/lib/workspaces/types";

function isWorkspaceCapacityControlled(workspaceId: string): boolean {
  return capacityControlled({ workspaceId, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS });
}

export type GetWorkspaceMembershipForBindingResult =
  | { status: "found"; membership: WorkspaceMembershipV1; documentUpdateTime: Timestamp }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

/**
 * The one canonical (workspaceId, uid) -> membership load path. Reads
 * directly at `workspaceMemberships/{computeMembershipId(workspaceId, uid)}`
 * — no query. Delegates the full resource-binding check to
 * `validateMembershipBinding()` (structural validity + id/workspaceId/uid
 * self-consistency) rather than re-implementing it here.
 */
export async function getWorkspaceMembershipForBinding(args: { workspaceId: string; uid: string }): Promise<GetWorkspaceMembershipForBindingResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const membershipId = computeMembershipId(args.workspaceId, args.uid);
    const snap = await adminDb.collection("workspaceMemberships").doc(membershipId).get();
    if (!snap.exists) {
      return { status: "not_found" };
    }
    const membership = validateMembershipBinding(snap.data(), { workspaceId: args.workspaceId, uid: args.uid });
    if (!membership) {
      logger.warn("[firestore/workspaceMemberships] Malformed or mismatched membership document", { workspaceId: args.workspaceId, uid: args.uid, membershipId });
      return { status: "malformed" };
    }
    return { status: "found", membership, documentUpdateTime: snap.updateTime as Timestamp };
  } catch {
    logger.warn("[firestore/workspaceMemberships] Failed to read membership", { workspaceId: args.workspaceId, uid: args.uid });
    return { status: "read_failed" };
  }
}

export type CreateTeamWorkspaceResult =
  | { status: "created"; workspace: TeamWorkspaceV1; membership: WorkspaceMembershipV1 }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "create_failed" };

/**
 * Team Workspace creation, Phase 8B (rollout-gated in Phase 8B.2) — the
 * Workspace document and its founder membership are created in ONE
 * transaction via `tx.create()` on both refs, so a Team Workspace is
 * never observable without its Owner membership (no partial state on
 * failure — either both documents commit or neither does).
 *
 * Every identity-derived field (`ownerUserId`, `createdByUserId`, the
 * founder's `uid`/`role`) comes from `uid` alone, the caller's own
 * authenticated identity — never from a request body. `invitedByUserId`
 * is always `null` for the founder membership — the founder was never
 * invited, so this is never falsified to a non-null value merely to
 * avoid `null`; a later invitation-created membership carries the real
 * inviter's uid instead.
 *
 * Requires rollout eligibility (`resolveTeamWorkspacesMode()`) BEFORE any
 * Firestore access — a uid outside the global/canary rollout gets
 * `team_workspaces_disabled` and zero reads or writes occur.
 */
export async function createTeamWorkspace(args: { uid: string; name: string }): Promise<CreateTeamWorkspaceResult> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const workspaceRef = adminDb.collection("workspaces").doc();
  const membershipId = computeMembershipId(workspaceRef.id, args.uid);
  const membershipRef = adminDb.collection("workspaceMemberships").doc(membershipId);
  const now = Timestamp.now();

  const workspace: TeamWorkspaceV1 = {
    schemaVersion: 1,
    id: workspaceRef.id,
    type: "team",
    name: args.name,
    ownerUserId: args.uid,
    createdByUserId: args.uid,
    createdAt: now,
    updatedAt: now,
  };
  const membership: WorkspaceMembershipV1 = {
    schemaVersion: 1,
    id: membershipId,
    workspaceId: workspaceRef.id,
    uid: args.uid,
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
  };

  try {
    await adminDb.runTransaction(async (tx) => {
      tx.create(workspaceRef, workspace);
      tx.create(membershipRef, membership);
    });
    return { status: "created", workspace, membership };
  } catch (err) {
    logger.warn("[firestore/workspaceMemberships] Team Workspace creation transaction failed", { uid: args.uid, error: err instanceof Error ? err.message : String(err) });
    return { status: "create_failed" };
  }
}

export type TransferTeamWorkspaceOwnershipResult =
  | { status: "transferred"; workspace: TeamWorkspaceV1; oldOwnerMembership: WorkspaceMembershipV1; newOwnerMembership: WorkspaceMembershipV1 }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "workspace_not_found" }
  | { status: "workspace_stale" }
  | { status: "caller_not_owner" }
  | { status: "old_owner_membership_stale" }
  | { status: "self_transfer_rejected" }
  | { status: "new_owner_membership_not_found" }
  | { status: "new_owner_membership_stale" }
  | { status: "new_owner_not_eligible" }
  | { status: "stale_precondition" }
  | { status: "transaction_failed" };

/**
 * Ownership transfer, Phase 8B — the ONLY way `workspaces/{id}.ownerUserId`
 * can ever change for a Team Workspace. Never exposed as a generic
 * member-role-mutation path (see `capabilities.ts`'s
 * `ORDINARY_SETTABLE_ROLES`, which structurally excludes `"owner"`).
 *
 * ================= CRITICAL OCC CONTRACT =================
 * `expectedWorkspaceUpdateTime` / `expectedOldOwnerMembershipUpdateTime` /
 * `expectedNewOwnerMembershipUpdateTime` are CALLER-SUPPLIED tokens
 * (already parsed by the route via `validateUpdateTimeToken()` before
 * this function is ever called) — NOT values this function derives by
 * reading the documents itself. They are used two ways, both required:
 *
 *   1. An early, clear-rejection comparison against the transaction's own
 *      freshly-read `snapshot.updateTime` (`updateTimeTokensEqual()`) —
 *      mirrors `PATCH /api/user/projects/[projectId]`'s identical
 *      early-check pattern. This is a FAST PATH for the common case, NOT
 *      the authoritative guarantee.
 *   2. The AUTHORITATIVE guarantee: every `tx.update()` call below passes
 *      the caller-supplied token itself as the `{lastUpdateTime}`
 *      precondition — never a value re-read inside this transaction.
 *      Firestore evaluates a `lastUpdateTime` precondition against the
 *      document's actual state at COMMIT time, not at read time — so even
 *      if Firestore internally retries this callback after a concurrent
 *      write invalidates the transaction's read set, the retried callback
 *      re-runs against the SAME caller-supplied tokens (they are function
 *      arguments, never mutated across a retry) and the final commit is
 *      still checked against those original tokens. A stale client
 *      belief can never slip through on a retry — it fails as stale on
 *      every attempt, not just the first.
 *
 * This deliberately does NOT do "read snapshot.updateTime inside the
 * transaction, then pass that freshly-read value back as `lastUpdateTime`"
 * — that would only protect against a write landing between this
 * transaction's read and its own commit (already covered for free by
 * Firestore's read-set conflict detection) and would NOT enforce that the
 * CALLER's belief about the document was itself current. The two
 * concerns are independent; only the caller-supplied-token precondition
 * enforces the latter.
 * ===========================================================
 *
 * Read/validate order inside the transaction:
 *   1. Read all three documents together (workspace, caller's own
 *      membership at `computeMembershipId(workspaceId, callerUid)`,
 *      target membership at `computeMembershipId(workspaceId, newOwnerUid)`).
 *   2. Validate the workspace: exists, well-formed, `id` matches,
 *      `type === "team"`.
 *   3. Validate the caller is the canonical current Owner
 *      (`isCanonicalTeamOwnerMembership()` — the same invariant
 *      `resolveWorkspaceAccess()` enforces on the read path).
 *   4. Reject self-transfer (`newOwnerUid === callerUid`).
 *   5. Validate the new Owner's membership: exists, well-formed, bound to
 *      this exact workspace/uid, `status === "active"`, `role !== "owner"`
 *      (defensive — should already be implied by the Owner invariant
 *      pinning exactly one `role: "owner"` row, but checked explicitly
 *      rather than assumed).
 *   6. Compare all three tokens against freshly-read `snapshot.updateTime`
 *      (fast-path rejection).
 *   7. Write: workspace.ownerUserId := newOwnerUid (createdByUserId
 *      untouched); old membership -> role "admin" (status unchanged,
 *      still "active"); new membership -> role "owner". Every write
 *      carries its own caller-supplied `lastUpdateTime` precondition.
 *
 * No application-level retry wraps `runTransaction()` — only Firestore's
 * own internal optimistic-concurrency retry exists here, exactly
 * `associateRunWithProject()`'s established convention.
 */
export async function transferTeamWorkspaceOwnership(args: {
  workspaceId: string;
  callerUid: string;
  newOwnerUid: string;
  expectedWorkspaceUpdateTime: Timestamp;
  expectedOldOwnerMembershipUpdateTime: Timestamp;
  expectedNewOwnerMembershipUpdateTime: Timestamp;
}): Promise<TransferTeamWorkspaceOwnershipResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.callerUid,
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

  const oldOwnerMembershipId = computeMembershipId(args.workspaceId, args.callerUid);
  const newOwnerMembershipId = computeMembershipId(args.workspaceId, args.newOwnerUid);

  let result: TransferTeamWorkspaceOwnershipResult;
  try {
    result = await adminDb.runTransaction<TransferTeamWorkspaceOwnershipResult>(async (tx) => {
      const workspaceRef = adminDb!.collection("workspaces").doc(args.workspaceId);
      const oldOwnerRef = adminDb!.collection("workspaceMemberships").doc(oldOwnerMembershipId);
      const newOwnerRef = adminDb!.collection("workspaceMemberships").doc(newOwnerMembershipId);

      const [workspaceSnap, oldOwnerSnap, newOwnerSnap] = await Promise.all([tx.get(workspaceRef), tx.get(oldOwnerRef), tx.get(newOwnerRef)]);

      // Step 2 — workspace validity.
      if (!workspaceSnap.exists) {
        return { status: "workspace_not_found" };
      }
      const workspaceData = workspaceSnap.data();
      if (!isWellFormedWorkspaceV1(workspaceData) || workspaceData.id !== args.workspaceId || workspaceData.type !== "team") {
        return { status: "workspace_not_found" };
      }
      const workspace = workspaceData as TeamWorkspaceV1;

      // Step 3 — caller must be the canonical current Owner.
      if (!oldOwnerSnap.exists) {
        return { status: "caller_not_owner" };
      }
      const oldOwnerMembership = validateMembershipBinding(oldOwnerSnap.data(), { workspaceId: args.workspaceId, uid: args.callerUid });
      if (!oldOwnerMembership || !isCanonicalTeamOwnerMembership({ workspace, membership: oldOwnerMembership })) {
        return { status: "caller_not_owner" };
      }

      // Step 4 — self-transfer.
      if (args.newOwnerUid === args.callerUid) {
        return { status: "self_transfer_rejected" };
      }

      // Step 5 — new Owner eligibility.
      if (!newOwnerSnap.exists) {
        return { status: "new_owner_membership_not_found" };
      }
      const newOwnerMembership = validateMembershipBinding(newOwnerSnap.data(), { workspaceId: args.workspaceId, uid: args.newOwnerUid });
      if (!newOwnerMembership || newOwnerMembership.status !== "active" || newOwnerMembership.role === "owner") {
        return { status: "new_owner_not_eligible" };
      }

      // Step 6 — caller-supplied OCC tokens vs. freshly-read state
      // (fast-path only — see module doc comment for why the AUTHORITATIVE
      // guarantee is the precondition on the writes below, not this check).
      // `.updateTime` is guaranteed present once `.exists` is true (same
      // cast `getProject()` already uses, verified against the installed
      // @google-cloud/firestore types) — all three existence checks above
      // already passed by this point.
      const workspaceUpdateTime = workspaceSnap.updateTime as Timestamp;
      const oldOwnerUpdateTime = oldOwnerSnap.updateTime as Timestamp;
      const newOwnerUpdateTime = newOwnerSnap.updateTime as Timestamp;
      if (workspaceUpdateTime.seconds !== args.expectedWorkspaceUpdateTime.seconds || workspaceUpdateTime.nanoseconds !== args.expectedWorkspaceUpdateTime.nanoseconds) {
        return { status: "workspace_stale" };
      }
      if (
        oldOwnerUpdateTime.seconds !== args.expectedOldOwnerMembershipUpdateTime.seconds ||
        oldOwnerUpdateTime.nanoseconds !== args.expectedOldOwnerMembershipUpdateTime.nanoseconds
      ) {
        return { status: "old_owner_membership_stale" };
      }
      if (
        newOwnerUpdateTime.seconds !== args.expectedNewOwnerMembershipUpdateTime.seconds ||
        newOwnerUpdateTime.nanoseconds !== args.expectedNewOwnerMembershipUpdateTime.nanoseconds
      ) {
        return { status: "new_owner_membership_stale" };
      }

      // Step 7 — the three writes, each carrying its OWN caller-supplied
      // token as the native Firestore precondition. `createdByUserId` is
      // never touched.
      const now = Timestamp.now();
      tx.update(workspaceRef, { ownerUserId: args.newOwnerUid, updatedAt: now }, { lastUpdateTime: args.expectedWorkspaceUpdateTime });
      tx.update(oldOwnerRef, { role: "admin", updatedAt: now }, { lastUpdateTime: args.expectedOldOwnerMembershipUpdateTime });
      tx.update(newOwnerRef, { role: "owner", updatedAt: now }, { lastUpdateTime: args.expectedNewOwnerMembershipUpdateTime });

      return {
        status: "transferred",
        workspace: { ...workspace, ownerUserId: args.newOwnerUid, updatedAt: now },
        oldOwnerMembership: { ...oldOwnerMembership, role: "admin", updatedAt: now },
        newOwnerMembership: { ...newOwnerMembership, role: "owner", updatedAt: now },
      };
    });
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === Status.FAILED_PRECONDITION || message.includes("FAILED_PRECONDITION")) {
      // The native Firestore precondition fired — a stale token slipped
      // past the fast-path check (e.g. a concurrent write landed between
      // this transaction's read and its commit, including across an
      // internal Firestore retry) but was still caught here,
      // authoritatively. Deliberately a status DISTINCT from the three
      // fast-path `*_stale` statuses above and never distinguishes which
      // of the three documents failed — same concealment posture as
      // `updateProjectFields()`'s `precondition_failed`.
      return { status: "stale_precondition" };
    }
    logger.warn("[firestore/workspaceMemberships] Ownership transfer transaction failed", {
      workspaceId: args.workspaceId,
      error: message,
    });
    return { status: "transaction_failed" };
  }

  return result;
}

export type RemoveWorkspaceMembershipResult =
  | { status: "removed"; targetUid: string; workspaceId: string; previousRole: WorkspaceMembershipRole }
  | { status: "already_removed" }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "target_not_found" }
  | { status: "target_malformed" }
  | { status: "self_removal_rejected" }
  | { status: "target_is_canonical_owner" }
  | { status: "target_role_not_manageable" }
  | { status: "state_corruption" }
  | { status: "remove_failed" };

/**
 * Active Team Workspace member soft-removal, Phase 12A — the ONE canonical
 * `active -> removed` membership transition. Never a hard delete: the
 * membership document (identity, role, `createdAt`, invitation provenance)
 * is retained forever, only `status`/`removedAt`/`removedByUserId` change.
 *
 * Governance Audit Durability, Phase TEAM-GOV-I1C1 — the canonical
 * `workspace_member_removed` event (`workspaceMembershipEvents/{autoId}`)
 * is written via `tx.set()` in step 9 below, inside this SAME transaction.
 * `REMOVAL COMMITTED IFF AUDIT EVENT COMMITTED` for this operation: there
 * is no code path where the membership transitions to `removed` without
 * its event committing atomically alongside it, and no code path where
 * the event exists without a corresponding committed removal.
 *
 * Read/validate/write order inside the transaction (frozen, mirrors
 * `authorizeTeamWorkspaceMutationInTransaction()`'s own frozen-order
 * precedent and `teamWorkspaceCanaryCapacity.ts`'s read-before-write
 * contract):
 *   1. `authorizeTeamWorkspaceMutationInTransaction()` — actor authenticated,
 *      Workspace valid, actor membership active, owner-integrity Cases A/B,
 *      `members.manage` capability. Actor role/membership are authoritative
 *      at MUTATION time, never a pre-transaction snapshot.
 *   2. Target membership, read fresh in the SAME transaction at
 *      `computeMembershipId(workspaceId, targetUid)` — never trusted from
 *      any caller-supplied role/state.
 *   3. Idempotency: target already `status !== "active"` -> `already_removed`,
 *      a benign no-op, never an error and never a second write.
 *   4. Self-removal: `targetUid === callerUid` -> `self_removal_rejected`,
 *      checked before the canonical-Owner check below so an Owner
 *      attempting to remove themself gets one clear, specific reason.
 *   5. Canonical-Owner protection: `isCanonicalTeamOwnerMembership()` on the
 *      TARGET (never a bare `role === "owner"` string check) -> if true,
 *      `target_is_canonical_owner`, unconditionally — this is checked even
 *      though step 1 already re-validated the ACTOR's own owner-integrity;
 *      this is a distinct check of the TARGET row. A corrupt extra
 *      `role: "owner"` row that is NOT canonical does not hit this branch —
 *      it is instead denied by step 6 below, since `"owner"` is never a
 *      manageable target role for anyone, canonical or not.
 *   6. `canManageMembershipTargetRole({callerRole, targetRole})` — the
 *      Owner/Admin target-role policy matrix.
 *   7. Capacity release (only if `isWorkspaceCapacityControlled()`), via the
 *      canonical `releaseTeamWorkspaceCanarySlot()` helper — called BEFORE
 *      the membership write below, per that module's own read-before-write
 *      transaction-ordering contract (its own reads must precede every
 *      other write in this transaction).
 *   8. Stage the single `tx.update()`: `status: "removed"`, `removedAt`,
 *      `removedByUserId` (server-derived from `args.uid`, never
 *      client-supplied), `updatedAt`. Every other field — `role`,
 *      `createdAt`, `invitedByUserId` — is left untouched, preserving full
 *      historical identity.
 *   9. Stage `tx.set()` of the canonical `workspace_member_removed` event at
 *      a freshly-allocated `workspaceMembershipEvents` doc ref, in the SAME
 *      transaction as step 8 — both commit or neither does. `at` reuses
 *      the exact `now` Timestamp from step 8, not an independent clock
 *      read. See `buildWorkspaceMembershipEventDocData()`
 *      (`lib/workspaces/workspaceMembershipEvents.ts`) — a pure, zero-I/O
 *      document-shape builder; the write itself happens here via `tx.set()`.
 *
 * Rollout admission is checked BEFORE `runTransaction()`, mirroring
 * `transferTeamWorkspaceOwnership()`'s established precedent — zero reads
 * or writes occur for a uid outside the global/canary rollout.
 */
export async function removeWorkspaceMembership(args: { uid: string; workspaceId: string; targetUid: string }): Promise<RemoveWorkspaceMembershipResult> {
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

  const targetMembershipId = computeMembershipId(args.workspaceId, args.targetUid);

  type TxResult =
    | { kind: "removed"; targetUid: string; workspaceId: string; previousRole: WorkspaceMembershipRole }
    | { kind: "already_removed" }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "target_not_found" }
    | { kind: "target_malformed" }
    | { kind: "self_removal_rejected" }
    | { kind: "target_is_canonical_owner" }
    | { kind: "target_role_not_manageable" }
    | { kind: "state_corruption" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "members.manage" });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      const targetRef = adminDb!.collection("workspaceMemberships").doc(targetMembershipId);
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        return { kind: "target_not_found" };
      }
      const targetMembership = validateMembershipBinding(targetSnap.data(), { workspaceId: args.workspaceId, uid: args.targetUid });
      if (!targetMembership) {
        return { kind: "target_malformed" };
      }

      if (targetMembership.status !== "active") {
        return { kind: "already_removed" };
      }

      if (args.targetUid === args.uid) {
        return { kind: "self_removal_rejected" };
      }

      if (isCanonicalTeamOwnerMembership({ workspace: auth.workspace, membership: targetMembership })) {
        return { kind: "target_is_canonical_owner" };
      }

      if (!canManageMembershipTargetRole({ callerRole: auth.membership.role, targetRole: targetMembership.role })) {
        return { kind: "target_role_not_manageable" };
      }

      if (isWorkspaceCapacityControlled(args.workspaceId)) {
        const release = await releaseTeamWorkspaceCanarySlot(tx, args.workspaceId);
        if (release.status !== "released") {
          return { kind: "state_corruption" };
        }
      }

      const now = Timestamp.now();
      tx.update(targetRef, { status: "removed", removedAt: now, removedByUserId: args.uid, updatedAt: now });

      // Governance Audit Durability, Phase TEAM-GOV-I1C1 — the canonical
      // removal event is written in the SAME transaction as the membership
      // mutation above, via `tx.set()` on a freshly-allocated doc ref
      // (`.doc()` with no argument generates a random ID locally, no
      // Firestore read — safe to call here, after every read this
      // transaction performs and alongside its other writes). Firestore
      // retries the WHOLE callback on conflict; only the winning attempt's
      // writes — membership update AND event — are ever committed, so a
      // retry can never produce more than one persisted event for one
      // successful logical removal. `at` reuses the SAME `now` instant as
      // `removedAt`/`updatedAt` above, not an independent clock read.
      const eventRef = adminDb!.collection("workspaceMembershipEvents").doc();
      tx.set(eventRef, buildWorkspaceMembershipEventDocData({ eventType: "workspace_member_removed", actorUid: args.uid, targetUid: args.targetUid, workspaceId: args.workspaceId, previousRole: targetMembership.role, at: now }));

      return { kind: "removed", targetUid: args.targetUid, workspaceId: args.workspaceId, previousRole: targetMembership.role };
    });
  } catch (err) {
    logger.warn("[firestore/workspaceMemberships] Membership removal transaction failed", {
      workspaceId: args.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "remove_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "target_not_found":
      return { status: "target_not_found" };
    case "target_malformed":
      return { status: "target_malformed" };
    case "already_removed":
      return { status: "already_removed" };
    case "self_removal_rejected":
      return { status: "self_removal_rejected" };
    case "target_is_canonical_owner":
      return { status: "target_is_canonical_owner" };
    case "target_role_not_manageable":
      return { status: "target_role_not_manageable" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "removed":
      return { status: "removed", targetUid: txResult.targetUid, workspaceId: txResult.workspaceId, previousRole: txResult.previousRole };
  }
}
