/**
 * Workspace-Scoped Team Canary — capacity accounting, Phase 10B.1. The
 * second foundational primitive designed across Phase 10A.1 through
 * 10A.4, now implemented. Enforces `MAX_TEAM_WORKSPACE_CANARY_MEMBERS`
 * per Workspace-canary-admitted Workspace via a single, explicit,
 * revision-guarded document per Workspace — the same OCC shape already
 * Production-canary-proven for governance panels/assignments in Phase 9D,
 * applied here to seat accounting instead of review state.
 *
 * RESERVATION LIFETIME IS STATE-BASED, NOT EXPIRY-BASED (frozen in Phase
 * 10A.4, correcting an accounting defect found in 10A.3): a guard-current
 * `status==="pending"` invitation owns exactly one reserved seat for as
 * long as it stays `"pending"`, REGARDLESS of `expiresAt`. Expiry affects
 * whether an invitation can currently be *accepted* — a separate,
 * unrelated question this module never evaluates — never whether it
 * currently *reserves capacity*. A seat is released only by an explicit
 * transactional state change (revoke, or an already-active acceptance's
 * redundant-reservation release); nothing here reads wall-clock time.
 * This is why there is no persisted "expired" invitation status and no
 * lazy/background reclamation anywhere in this module: bootstrap and
 * every release path share one identical predicate
 * (`status==="pending"`), so they can never drift apart the way an
 * expiry-filtered bootstrap paired with an expiry-blind release did.
 *
 * DEPENDENCY HYGIENE: this module reads invitation/guard/membership shape
 * only through the neutral `invitationTypes.ts`/`membershipTypes.ts`
 * validators — never through `lib/firestore/workspaceInvitations.ts`,
 * which will itself import THIS module in Phase 10B.2. Importing from
 * there would create a runtime cycle; the neutral-module split (mirroring
 * the pre-existing `membershipTypes.ts`/`workspaceMemberships.ts` split)
 * avoids it entirely.
 *
 * TRANSACTION-ORDERING CONTRACT (binding on every future caller, most
 * relevantly Phase 10B.2): `reserveTeamWorkspaceCanarySlot()` and
 * `releaseTeamWorkspaceCanarySlot()` each perform MULTIPLE `tx.get()`
 * reads (the capacity document itself, and — on first use for a
 * Workspace — a membership query, a guard query, and one point-read per
 * guard) before staging their own single write. Firestore transactions
 * require every read to precede every write; a caller MUST invoke either
 * function before staging ANY other write (invitation, membership, guard)
 * in the same transaction. Calling either function after the caller has
 * already called `tx.set()`/`tx.update()`/`tx.create()`/`tx.delete()` on
 * ANYTHING else in that same transaction is a caller bug this module
 * cannot detect or protect against — order accordingly.
 *
 * FIRST-USE WRITE SAFETY: when the capacity document does not yet exist,
 * bootstrap occupancy and the current operation's delta are combined into
 * exactly ONE `tx.create()` — never a `tx.create()` followed by a
 * `tx.update()` of the same document in the same transaction. A brand-new
 * capacity document always starts at `revision: 0`, even when its very
 * first persisted `reservedCount` already reflects the triggering
 * operation's delta.
 *
 * NO WRITE ON REJECTION: a `capacity_reached` or `state_corruption`
 * result never stages any write to the capacity document, in either the
 * existing-document or first-use/bootstrap case — a rejected operation
 * leaves no trace, and the next attempt simply recomputes deterministically.
 *
 * This module is NOT yet wired into any invitation/membership mutation
 * (Phase 10B.2). It has zero effect on Production until something calls
 * it, and `TEAM_WORKSPACES_CANARY_WORKSPACE_IDS` is not configured by
 * this phase either way.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { isWellFormedWorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";
import { isWellFormedWorkspaceInvitationV1, isWellFormedWorkspaceInvitationKeyV1 } from "@/lib/workspaces/invitationTypes";

/** Owner counts — no schema exemption. Fixed server-side constant; deliberately not configurable in this phase (Phase 10A.4). */
export const MAX_TEAM_WORKSPACE_CANARY_MEMBERS = 10;

const CAPACITY_COLLECTION = "teamWorkspaceCanaryCapacity";

/**
 * `teamWorkspaceCanaryCapacity/{workspaceId}` — one document per
 * Workspace, created only the first time a capacity-controlled operation
 * touches that Workspace. `limit` is deliberately NOT persisted here —
 * every comparison is against the `MAX_TEAM_WORKSPACE_CANARY_MEMBERS`
 * code constant, so there is exactly one source of truth for the limit
 * and no risk of a persisted value drifting from a future constant change.
 */
export interface TeamWorkspaceCanaryCapacityV1 {
  schemaVersion: 1;
  workspaceId: string;
  reservedCount: number;
  revision: number;
  updatedAt: Timestamp;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Pure shape validator — never a blind cast, mirroring every other
 * canonical-document validator in this codebase. Deliberately does NOT
 * check `workspaceId` against an expected value (a pure shape validator
 * is never given the expected value) — that binding check belongs to the
 * caller, exactly as `isWellFormedWorkspaceV1` vs. `getWorkspace()`'s own
 * `data.id !== workspaceId` check are already split. Fails closed on
 * anything not positively validated: no silent repair, ever.
 */
export function isWellFormedTeamWorkspaceCanaryCapacityV1(data: unknown): data is TeamWorkspaceCanaryCapacityV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.schemaVersion !== 1) return false;
  if (typeof d.workspaceId !== "string" || d.workspaceId.length === 0) return false;
  if (!isNonNegativeInteger(d.reservedCount)) return false;
  if (!isNonNegativeInteger(d.revision)) return false;
  if (!(d.updatedAt instanceof Timestamp)) return false;
  return true;
}

type CapacityBase = { reservedCount: number; existingRevision: number | null };

/**
 * All reads this module ever performs, in one place, entirely before any
 * write. Returns the capacity document's current `reservedCount` (loaded
 * as-is if the document exists) or the freshly-computed bootstrap
 * occupancy (if it does not) — `existingRevision: null` signals "this
 * Workspace has no capacity document yet; the caller's next write must be
 * `tx.create()`, not `tx.update()`."
 *
 * Bootstrap occupancy = (active memberships) + (guard-current
 * `status==="pending"` invitations), with NO `expiresAt` filter — the
 * frozen Phase 10A.4 predicate. Any malformed membership, guard,
 * invitation, or binding mismatch encountered while computing this fails
 * the whole bootstrap closed (`ok: false`) rather than silently omitting
 * the corrupt record from the count.
 */
async function loadOrComputeCapacityBase(tx: FirebaseFirestore.Transaction, workspaceId: string): Promise<{ ok: true; base: CapacityBase } | { ok: false }> {
  const capacityRef = adminDb!.collection(CAPACITY_COLLECTION).doc(workspaceId);
  const capacitySnap = await tx.get(capacityRef);
  if (capacitySnap.exists) {
    const data = capacitySnap.data();
    if (!isWellFormedTeamWorkspaceCanaryCapacityV1(data) || data.workspaceId !== workspaceId) {
      return { ok: false };
    }
    return { ok: true, base: { reservedCount: data.reservedCount, existingRevision: data.revision } };
  }

  const membershipsSnap = await tx.get(adminDb!.collection("workspaceMemberships").where("workspaceId", "==", workspaceId).where("status", "==", "active"));
  let activeMembershipCount = 0;
  for (const doc of membershipsSnap.docs) {
    const data = doc.data();
    if (!isWellFormedWorkspaceMembershipV1(data) || data.workspaceId !== workspaceId || data.id !== computeMembershipId(data.workspaceId, data.uid)) {
      return { ok: false };
    }
    activeMembershipCount += 1;
  }

  const guardsSnap = await tx.get(adminDb!.collection("workspaceInvitationKeys").where("workspaceId", "==", workspaceId));
  let pendingInvitationCount = 0;
  for (const guardDoc of guardsSnap.docs) {
    const guardData = guardDoc.data();
    if (!isWellFormedWorkspaceInvitationKeyV1(guardData) || guardData.workspaceId !== workspaceId) {
      return { ok: false };
    }
    const invitationRef = adminDb!.collection("workspaceInvitations").doc(guardData.currentInvitationId);
    const invitationSnap = await tx.get(invitationRef);
    if (!invitationSnap.exists) {
      return { ok: false }; // guard points to a missing invitation — fail closed, never omit silently
    }
    const invitationData = invitationSnap.data();
    if (
      !isWellFormedWorkspaceInvitationV1(invitationData) ||
      invitationData.id !== guardData.currentInvitationId ||
      invitationData.workspaceId !== workspaceId ||
      invitationData.normalizedEmail !== guardData.normalizedEmail
    ) {
      return { ok: false }; // guard/invitation binding mismatch — fail closed
    }
    // Deliberately NOT checking expiresAt — see module doc comment.
    if (invitationData.status === "pending") {
      pendingInvitationCount += 1;
    }
  }

  return { ok: true, base: { reservedCount: activeMembershipCount + pendingInvitationCount, existingRevision: null } };
}

function stageCapacityWrite(tx: FirebaseFirestore.Transaction, workspaceId: string, base: CapacityBase, finalReservedCount: number): void {
  const capacityRef = adminDb!.collection(CAPACITY_COLLECTION).doc(workspaceId);
  const now = Timestamp.now();
  if (base.existingRevision === null) {
    const doc: TeamWorkspaceCanaryCapacityV1 = { schemaVersion: 1, workspaceId, reservedCount: finalReservedCount, revision: 0, updatedAt: now };
    tx.create(capacityRef, doc);
  } else {
    tx.update(capacityRef, { reservedCount: finalReservedCount, revision: base.existingRevision + 1, updatedAt: now });
  }
}

export type ReserveTeamWorkspaceCanarySlotResult =
  | { status: "reserved"; reservedCount: number }
  | { status: "capacity_reached"; reservedCount: number }
  | { status: "state_corruption" }
  | { status: "firestore_unavailable" };

/**
 * Reserve one seat for `workspaceId`, inside the caller's already-open
 * transaction `tx`. Bootstraps the capacity document first if absent (see
 * `loadOrComputeCapacityBase()`). Allowed only while
 * `reservedCount < MAX_TEAM_WORKSPACE_CANARY_MEMBERS`; otherwise returns
 * `capacity_reached` with zero writes. See the module doc comment's
 * transaction-ordering contract before calling this from a caller that
 * also writes other documents in the same transaction.
 */
export async function reserveTeamWorkspaceCanarySlot(tx: FirebaseFirestore.Transaction, workspaceId: string): Promise<ReserveTeamWorkspaceCanarySlotResult> {
  if (!adminDb) return { status: "firestore_unavailable" };
  const loaded = await loadOrComputeCapacityBase(tx, workspaceId);
  if (!loaded.ok) return { status: "state_corruption" };
  const { base } = loaded;
  if (base.reservedCount >= MAX_TEAM_WORKSPACE_CANARY_MEMBERS) {
    return { status: "capacity_reached", reservedCount: base.reservedCount };
  }
  const finalReservedCount = base.reservedCount + 1;
  stageCapacityWrite(tx, workspaceId, base, finalReservedCount);
  return { status: "reserved", reservedCount: finalReservedCount };
}

export type ReleaseTeamWorkspaceCanarySlotResult = { status: "released"; reservedCount: number } | { status: "state_corruption" } | { status: "firestore_unavailable" };

/**
 * Release one seat for `workspaceId`, inside the caller's already-open
 * transaction `tx`. Bootstraps the capacity document first if absent —
 * required so that the very first capacity-sensitive operation on a
 * newly-admitted Workspace can correctly be a release (e.g. revoking a
 * pre-existing pending invitation, or an already-active acceptance) and
 * not only ever a reserve. A release that would take `reservedCount`
 * below zero is treated as `state_corruption` (never clamped to zero,
 * never silently accepted) — the invariant this module maintains
 * guarantees `reservedCount` never legitimately reaches zero while a
 * release referring to a real, counted reservation is still outstanding;
 * an underflow means the caller's own bookkeeping (or this document) has
 * drifted from canonical state.
 */
export async function releaseTeamWorkspaceCanarySlot(tx: FirebaseFirestore.Transaction, workspaceId: string): Promise<ReleaseTeamWorkspaceCanarySlotResult> {
  if (!adminDb) return { status: "firestore_unavailable" };
  const loaded = await loadOrComputeCapacityBase(tx, workspaceId);
  if (!loaded.ok) return { status: "state_corruption" };
  const { base } = loaded;
  if (base.reservedCount <= 0) {
    return { status: "state_corruption" };
  }
  const finalReservedCount = base.reservedCount - 1;
  stageCapacityWrite(tx, workspaceId, base, finalReservedCount);
  return { status: "released", reservedCount: finalReservedCount };
}
