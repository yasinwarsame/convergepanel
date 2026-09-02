/**
 * Permanent Team Workspace Collaborator-Seat Limit, Phase 12A.1S.1 —
 * capacity accounting for `TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT`
 * (`teamWorkspaceSeatLimit.ts`). Unlike `teamWorkspaceCanaryCapacity.ts` (a
 * Tier-2 rollout-containment device that goes fully inert at GA — see its
 * own doc comment — deliberately NOT reused as a permanent product limit,
 * per the PHASE 12A.1S.0 audit), this module is ALWAYS ON for every Team
 * Workspace, independent of `TEAM_WORKSPACES_ENABLED`/canary admission.
 *
 * `reservedCount` on `teamWorkspaceSeatAdmission/{workspaceId}` is a CACHE,
 * never independently authoritative. The authoritative truth is always:
 *
 *   (active non-owner memberships) + (guard-current, status==="pending",
 *    non-expired invitation reservations)
 *
 * The cache can only ever drift stale HIGH (a pending invitation that was
 * counted while valid later expires with no write to correct it) — never
 * stale LOW, PROVIDED every occupancy-INCREASING transition (a brand-new
 * reservation, or a resend that reactivates an already-expired one) goes
 * through `reserveTeamWorkspaceSeat()` and every occupancy-DECREASING
 * transition this module is wired into (revoke of a still-valid
 * reservation, member removal, release of a redundant already-member
 * reservation) goes through `releaseTeamWorkspaceSeat()`. Callers are
 * responsible for calling the right one at the right seat delta — this
 * module only accounts for whichever calls it actually receives; see each
 * call site in `lib/firestore/workspaceInvitations.ts` /
 * `lib/firestore/workspaceMemberships.ts` for its own delta proof.
 *
 * FAST PATH: if the cached `reservedCount < limit`, admit immediately using
 * the cached value — safe specifically because the cache can only be stale
 * HIGH, never LOW, so trusting it under the limit can never cause an
 * overshoot.
 *
 * FULL-CACHE SELF-HEAL PATH: if the cached `reservedCount >= limit`, this
 * may be genuine exhaustion OR a cache that is stale-high because a
 * pending invitation naturally expired with no write. Recompute TRUE live
 * occupancy (excluding expired pending invitations) inside the SAME
 * transaction; if that is actually under the limit, self-heal the cache to
 * the corrected value AND admit, in one write. This is what frees a seat
 * from a naturally expired invitation with zero cron/background job — the
 * correction only ever happens lazily, triggered by a real admission
 * attempt, never a scheduled sweep.
 *
 * CONCURRENCY: safety comes entirely from ordinary Firestore
 * single-document transactional OCC on
 * `teamWorkspaceSeatAdmission/{workspaceId}` — two concurrent reservation
 * attempts for the same Workspace both read-then-write the SAME document,
 * so Firestore forces the loser to retry and re-evaluate against the
 * winner's already-committed count (the PHASE 12A.1S.0 audit's proven
 * pattern — mirrors `lib/stripe/usageCheck.ts`'s single-document OCC on
 * `users/{uid}`, not a bare live-query race with no shared write).
 *
 * TWO-PHASE (plan/commit) API: Firestore transactions require every read
 * in the WHOLE transaction to precede every write in the whole
 * transaction — not merely within one helper's own call. A caller that
 * also needs `teamWorkspaceCanaryCapacity.ts`'s own reserve/release (an
 * opaque helper that itself reads-then-writes) in the SAME transaction
 * cannot simply call both of this module's all-in-one
 * `reserveTeamWorkspaceSeat()`/`releaseTeamWorkspaceSeat()` functions
 * back-to-back with it — whichever runs second would attempt reads after
 * the first's write already staged. `planTeamWorkspaceSeatReservation()`/
 * `planTeamWorkspaceSeatRelease()` (read-only, decide, stage nothing) let
 * such a caller sequence: [this module's plan] -> [canary's own
 * read+write] -> [this module's commit] -> [any further writes], keeping
 * every read ahead of every write across the whole transaction. Callers
 * with no such interleaving need (e.g. resend's reactivation path, which
 * never touches canary) may use the simpler all-in-one functions directly.
 */

import "server-only";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { isWellFormedWorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";
import { isWellFormedWorkspaceInvitationV1, isWellFormedWorkspaceInvitationKeyV1 } from "@/lib/workspaces/invitationTypes";
import { TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT } from "@/lib/workspaces/teamWorkspaceSeatLimit";

const ADMISSION_COLLECTION = "teamWorkspaceSeatAdmission";

/**
 * `teamWorkspaceSeatAdmission/{workspaceId}` — one document per Workspace,
 * created only the first time a seat-consuming operation touches that
 * Workspace. `limit` is deliberately NOT persisted here — every comparison
 * is against the `TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT` code constant
 * (via `getTeamWorkspaceCollaboratorSeatLimit()`'s seam), so there is
 * exactly one source of truth for the limit.
 */
export interface TeamWorkspaceSeatAdmissionV1 {
  schemaVersion: 1;
  workspaceId: string;
  reservedCount: number;
  revision: number;
  updatedAt: Timestamp;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Pure shape validator — never a blind cast, mirroring every canonical-document validator in this codebase. */
export function isWellFormedTeamWorkspaceSeatAdmissionV1(data: unknown): data is TeamWorkspaceSeatAdmissionV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.schemaVersion !== 1) return false;
  if (typeof d.workspaceId !== "string" || d.workspaceId.length === 0) return false;
  if (!isNonNegativeInteger(d.reservedCount)) return false;
  if (!isNonNegativeInteger(d.revision)) return false;
  if (!(d.updatedAt instanceof Timestamp)) return false;
  return true;
}

type SeatBase = { occupied: number; existingRevision: number | null };

/**
 * The ONE live-occupancy computation this module ever performs — reused
 * identically for bootstrap AND for the full-cache self-heal path (never
 * two separate definitions of "current occupancy"). Owner is excluded by
 * filtering `role !== "owner"` in application code after a plain
 * `workspaceId==` + `status=="active"` query (the same shape
 * `listWorkspaceMembers()`/`teamWorkspaceCanaryCapacity.ts`'s own bootstrap
 * already use — no new composite index). Invitations are counted through
 * the SAME `workspaceInvitationKeys` guard-current semantics every other
 * invitation code path defers to (never a raw `workspaceInvitations`
 * status scan), filtered to `status === "pending" && expiresAt > now` —
 * the one place this module's occupancy formula differs from
 * `teamWorkspaceCanaryCapacity.ts`'s deliberately expiry-blind formula
 * (see this module's doc comment).
 */
async function computeLiveOccupancy(tx: Transaction, workspaceId: string): Promise<{ ok: true; occupied: number } | { ok: false }> {
  const now = Timestamp.now();

  const membershipsSnap = await tx.get(adminDb!.collection("workspaceMemberships").where("workspaceId", "==", workspaceId).where("status", "==", "active"));
  let activeNonOwnerCount = 0;
  for (const doc of membershipsSnap.docs) {
    const data = doc.data();
    if (!isWellFormedWorkspaceMembershipV1(data) || data.workspaceId !== workspaceId || data.id !== computeMembershipId(data.workspaceId, data.uid)) {
      return { ok: false };
    }
    if (data.role !== "owner") {
      activeNonOwnerCount += 1;
    }
  }

  const guardsSnap = await tx.get(adminDb!.collection("workspaceInvitationKeys").where("workspaceId", "==", workspaceId));
  let validPendingCount = 0;
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
    if (invitationData.status === "pending" && invitationData.expiresAt.toMillis() > now.toMillis()) {
      validPendingCount += 1;
    }
  }

  return { ok: true, occupied: activeNonOwnerCount + validPendingCount };
}

/** All reads a seat operation ever needs, in one place, entirely before any write. */
async function loadSeatBase(tx: Transaction, workspaceId: string): Promise<{ ok: true; base: SeatBase } | { ok: false }> {
  const admissionRef = adminDb!.collection(ADMISSION_COLLECTION).doc(workspaceId);
  const admissionSnap = await tx.get(admissionRef);
  if (admissionSnap.exists) {
    const data = admissionSnap.data();
    if (!isWellFormedTeamWorkspaceSeatAdmissionV1(data) || data.workspaceId !== workspaceId) {
      return { ok: false };
    }
    return { ok: true, base: { occupied: data.reservedCount, existingRevision: data.revision } };
  }
  const live = await computeLiveOccupancy(tx, workspaceId);
  if (!live.ok) return { ok: false };
  return { ok: true, base: { occupied: live.occupied, existingRevision: null } };
}

function stageSeatWrite(tx: Transaction, workspaceId: string, base: SeatBase, finalOccupied: number): void {
  const admissionRef = adminDb!.collection(ADMISSION_COLLECTION).doc(workspaceId);
  const now = Timestamp.now();
  if (base.existingRevision === null) {
    const doc: TeamWorkspaceSeatAdmissionV1 = { schemaVersion: 1, workspaceId, reservedCount: finalOccupied, revision: 0, updatedAt: now };
    tx.create(admissionRef, doc);
  } else {
    tx.update(admissionRef, { reservedCount: finalOccupied, revision: base.existingRevision + 1, updatedAt: now });
  }
}

// ==================================================================
// RESERVE
// ==================================================================

export type TeamWorkspaceSeatReservationPlan =
  | { kind: "admit"; base: SeatBase; finalOccupied: number }
  | { kind: "limit_reached"; occupied: number; limit: number }
  | { kind: "state_corruption" };

/**
 * READ-ONLY phase: performs every `tx.get()` this reservation needs
 * (fast-path load, and — only if the cache reads at/over the limit — the
 * full-cache self-heal live recompute), and decides admit/deny, but stages
 * NO write. See module doc comment for why a caller that must also
 * interleave `teamWorkspaceCanaryCapacity.ts`'s own reserve call in the
 * same transaction needs this split rather than the all-in-one
 * `reserveTeamWorkspaceSeat()`.
 */
export async function planTeamWorkspaceSeatReservation(tx: Transaction, workspaceId: string): Promise<TeamWorkspaceSeatReservationPlan> {
  if (!adminDb) return { kind: "state_corruption" };
  const loaded = await loadSeatBase(tx, workspaceId);
  if (!loaded.ok) return { kind: "state_corruption" };
  let base = loaded.base;

  if (base.occupied >= TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT) {
    const live = await computeLiveOccupancy(tx, workspaceId);
    if (!live.ok) return { kind: "state_corruption" };
    base = { occupied: live.occupied, existingRevision: base.existingRevision };
    if (base.occupied >= TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT) {
      return { kind: "limit_reached", occupied: base.occupied, limit: TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT };
    }
  }

  return { kind: "admit", base, finalOccupied: base.occupied + 1 };
}

/** WRITE-ONLY phase: stages the single write an "admit" plan already decided. Must be called after every other read in the transaction has already happened. */
export function commitTeamWorkspaceSeatReservation(tx: Transaction, workspaceId: string, plan: Extract<TeamWorkspaceSeatReservationPlan, { kind: "admit" }>): void {
  stageSeatWrite(tx, workspaceId, plan.base, plan.finalOccupied);
}

export type ReserveTeamWorkspaceSeatResult =
  | { kind: "reserved"; occupied: number }
  | { kind: "limit_reached"; occupied: number; limit: number }
  | { kind: "state_corruption" };

/** All-in-one convenience wrapper (plan immediately followed by commit) for callers with no other read-then-write helper to interleave in the same transaction. */
export async function reserveTeamWorkspaceSeat(tx: Transaction, workspaceId: string): Promise<ReserveTeamWorkspaceSeatResult> {
  const plan = await planTeamWorkspaceSeatReservation(tx, workspaceId);
  if (plan.kind === "admit") {
    commitTeamWorkspaceSeatReservation(tx, workspaceId, plan);
    return { kind: "reserved", occupied: plan.finalOccupied };
  }
  if (plan.kind === "limit_reached") return plan;
  return { kind: "state_corruption" };
}

// ==================================================================
// RELEASE
// ==================================================================

export type TeamWorkspaceSeatReleasePlan = { kind: "release"; base: SeatBase; finalOccupied: number } | { kind: "state_corruption" };

/**
 * READ-ONLY phase for release — see the reservation plan/commit split's
 * doc comment for why this exists. Never decrements below zero: an
 * attempted underflow (`occupied <= 0`) is `state_corruption` — the
 * caller's own bookkeeping has drifted from canonical state — never
 * silently clamped. Safe when the admission document doesn't exist yet
 * (bootstraps from live state first, exactly like the reservation path) —
 * required so the very first capacity-sensitive operation on a
 * newly-shipped Workspace can correctly be a release.
 */
export async function planTeamWorkspaceSeatRelease(tx: Transaction, workspaceId: string): Promise<TeamWorkspaceSeatReleasePlan> {
  if (!adminDb) return { kind: "state_corruption" };
  const loaded = await loadSeatBase(tx, workspaceId);
  if (!loaded.ok) return { kind: "state_corruption" };
  const { base } = loaded;
  if (base.occupied <= 0) {
    return { kind: "state_corruption" };
  }
  return { kind: "release", base, finalOccupied: base.occupied - 1 };
}

export function commitTeamWorkspaceSeatRelease(tx: Transaction, workspaceId: string, plan: Extract<TeamWorkspaceSeatReleasePlan, { kind: "release" }>): void {
  stageSeatWrite(tx, workspaceId, plan.base, plan.finalOccupied);
}

export type ReleaseTeamWorkspaceSeatResult = { kind: "released"; occupied: number } | { kind: "state_corruption" };

/** All-in-one convenience wrapper for callers with no other read-then-write helper to interleave. */
export async function releaseTeamWorkspaceSeat(tx: Transaction, workspaceId: string): Promise<ReleaseTeamWorkspaceSeatResult> {
  const plan = await planTeamWorkspaceSeatRelease(tx, workspaceId);
  if (plan.kind === "state_corruption") return plan;
  commitTeamWorkspaceSeatRelease(tx, workspaceId, plan);
  return { kind: "released", occupied: plan.finalOccupied };
}
