/**
 * Team Claim Verification Creation, Phase 8C-E.1 — the two-gate
 * authorization/persistence primitive for Team-Workspace-bound Claim
 * Verification, frozen by Phase 8C-E.0.1's correction to the original
 * 8C-E.0 architecture.
 *
 * ================= WHY TWO GATES, NOT ONE =================
 * The five-model Claim panel (`runClaimVerificationPanel()`) can take
 * several seconds. A single "admission" transaction taken before that
 * window commits nothing durable — it cannot function as a permission
 * lease for a Team-resource mutation that happens only after the window
 * closes. Membership can be revoked, a role/capability can be downgraded,
 * ownership can transfer, or the target Project can be archived, all
 * while the five models are still running. If the FINAL artifact write
 * simply trusted the earlier admission decision, it could create a new
 * Team resource under authorization that had already ceased to be valid.
 *
 * `authorizeTeamClaimVerificationAdmission()` (Gate 1) therefore exists
 * ONLY to answer "may this caller spend Claim-model resources through a
 * Team endpoint right now" — it performs a read-only transaction and
 * writes nothing. `saveTeamClaimVerification()` (Gate 2) independently
 * re-derives the exact same authorization from scratch, inside its OWN,
 * separate transaction, at the moment the real artifact is about to be
 * created — this is the only transaction whose authorization decision
 * actually matters for the mutation it guards. Gate 2 does not accept,
 * read, or trust any state Gate 1 produced beyond the caller-supplied
 * `uid`/`workspaceId`/`projectId` identifiers themselves.
 *
 * If Gate 2 denies (a race landed between the gates), the already-spent
 * quota and already-consumed provider tokens are NOT refunded — the work
 * genuinely happened. No Team artifact is written, and no fallback to an
 * unbound Personal Claim document is ever performed. This mirrors Phase
 * 8C-D's Option A quota tradeoff, extended to also cover real model
 * spend, which D's ordinary-run design never had to reason about (D's
 * canonical run row is created BEFORE model execution, so D never faces
 * this specific "artifact would-be-created after an authorization window
 * has closed" problem — Claim's own lifecycle has no pre-execution shell
 * to lean on, by design; see 8C-E.0/E.0.1 for why inventing one here
 * would be worse, not safer).
 *
 * Deliberately a NEW, separate file from `lib/firestore/verifications.ts`
 * — that file's `saveClaimVerification()` remains completely unchanged
 * and is never called, wrapped, or extended by this module. Gate 2 owns
 * its own independent `tx.create()`, because a transactional write
 * requires the same `Transaction` handle as its own authorization reads
 * (exactly the same reason `lib/firestore/teamProjects.ts`/
 * `lib/firestore/teamWorkspaceRuns.ts` never reuse the Personal writers
 * they parallel).
 */

import "server-only";
import { randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { roleHasCapability } from "@/lib/workspaces/capabilities";
import { isWellFormedProjectV1 } from "@/lib/projects/types";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";

// ============================================================
// GATE 1 — execution admission (read-only, no write)
// ============================================================

export type Gate1Result =
  | { status: "authorized"; workspaceId: string; projectId: string | null }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "project_not_found" }
  | { status: "project_archived" }
  | { status: "transaction_failed" };

/**
 * Pure admission decision. Opens exactly one `adminDb.runTransaction()`
 * purely for read-consistency across Workspace + membership + optional
 * Project — the callback contains NO `tx.create()`/`tx.update()`/
 * `tx.set()`/`tx.delete()` of any kind and commits as a no-op read.
 *
 * `args.projectId` must already be normalized by the caller to exactly
 * `string | null` (mirrors `createTeamWorkspaceRun()`'s own contract).
 */
export async function authorizeTeamClaimVerificationAdmission(args: {
  uid: string;
  workspaceId: string;
  projectId: string | null;
}): Promise<Gate1Result> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  type TxResult =
    | { kind: "authorized" }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "project_not_found" }
    | { kind: "project_archived" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.create",
      });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      if (args.projectId !== null) {
        if (!roleHasCapability(auth.membership.role, "research.organize")) {
          return { kind: "unauthorized", reason: "insufficient_capability" };
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
        if (projectData.status !== "active") {
          return { kind: "project_archived" };
        }
      }

      // Deliberately no write of any kind — this transaction exists only
      // to prove the check above happened against a consistent snapshot.
      return { kind: "authorized" };
    });
  } catch (err: unknown) {
    logger.warn("[firestore/teamClaimVerifications] Gate 1 admission transaction failed", {
      workspaceId: args.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "transaction_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "project_not_found":
      return { status: "project_not_found" };
    case "project_archived":
      return { status: "project_archived" };
    case "authorized":
      return { status: "authorized", workspaceId: args.workspaceId, projectId: args.projectId };
  }
}

// ============================================================
// GATE 2 — canonical Team Claim persistence (fresh reauthorization + write)
// ============================================================

export type Gate2Result =
  | { status: "created"; verificationId: string; workspaceId: string; projectId: string | null }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "project_not_found" }
  | { status: "project_archived" }
  | { status: "transaction_failed" };

/**
 * `args` carries the fully-computed Claim result (produced by the SAME
 * `runClaimVerificationPanel()`/scoring functions Personal uses) plus the
 * immutable target identifiers. This function independently re-derives
 * authorization from scratch — it never reads or trusts a Gate 1 result.
 */
export async function saveTeamClaimVerification(args: {
  uid: string;
  workspaceId: string;
  projectId: string | null;
  claim: string;
  verdict: ClaimVerificationFirestoreDoc["verdict"];
  consensusScore: number;
  confidenceLabel: ClaimVerificationFirestoreDoc["confidenceLabel"];
  evidenceQuality: ClaimVerificationFirestoreDoc["evidenceQuality"];
  supportRatio: number;
  modelResults: ClaimVerificationFirestoreDoc["modelResults"];
  auditBundle: ClaimVerificationFirestoreDoc["auditBundle"];
  selectedModels: string[];
}): Promise<Gate2Result> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  // Allocated once, before runTransaction() — never regenerated on a
  // Firestore-internal retry of the callback, mirroring
  // createTeamWorkspaceRun()'s own frozen id-allocation invariant.
  const verificationId = `vcl-${randomUUID()}`;
  const verificationRef = adminDb.collection("verifications").doc(verificationId);

  type TxResult =
    | { kind: "created" }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "project_not_found" }
    | { kind: "project_archived" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      // Fresh — does NOT reuse or reference any Gate 1 result.
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.create",
      });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      if (args.projectId !== null) {
        if (!roleHasCapability(auth.membership.role, "research.organize")) {
          return { kind: "unauthorized", reason: "insufficient_capability" };
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
        if (projectData.status !== "active") {
          return { kind: "project_archived" };
        }
      }

      const canonicalDoc: ClaimVerificationFirestoreDoc & { workspaceId: string; projectId: string | null } = {
        userId: args.uid,
        claim: args.claim,
        type: "claim_verification",
        verdict: args.verdict,
        consensusScore: args.consensusScore,
        confidenceLabel: args.confidenceLabel,
        evidenceQuality: args.evidenceQuality,
        supportRatio: args.supportRatio,
        modelResults: args.modelResults,
        auditBundle: args.auditBundle,
        selectedModels: args.selectedModels,
        timestamp: Timestamp.now(),
        // ALWAYS present — see this module's header comment and
        // lib/workspaces/teamClaimVerificationRowValidation.ts, which
        // treats an absent projectId identically to a malformed one.
        workspaceId: args.workspaceId,
        projectId: args.projectId,
      };
      const safe = sanitizeForFirestore(canonicalDoc) as typeof canonicalDoc;
      tx.create(verificationRef, safe);

      return { kind: "created" };
    });
  } catch (err: unknown) {
    // The TRANSACTION ITSELF failed (including a verificationId collision
    // on tx.create() — a UUID-level edge case with no dedicated
    // client-visible signal, mapped through this same existing
    // internal-error path rather than inventing new collision semantics)
    // — genuinely nothing committed.
    logger.warn("[firestore/teamClaimVerifications] Gate 2 persistence transaction failed — no Team Claim artifact was created", {
      workspaceId: args.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "transaction_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "project_not_found":
      return { status: "project_not_found" };
    case "project_archived":
      return { status: "project_archived" };
    case "created":
      return { status: "created", verificationId, workspaceId: args.workspaceId, projectId: args.projectId };
  }
}
