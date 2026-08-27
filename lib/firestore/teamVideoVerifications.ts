/**
 * Team Video Verification, Phase 8C-E.3.3.1 — the Team-specific Firestore
 * operations for `videoVerifications`, frozen by Phase 8C-E.3.3.0 (and its
 * .1/.2/.3 corrections): admission (Gate 1), dedup candidate lookup, and
 * canonical persistence (Gate 2).
 *
 * ================= WHY TWO GATES, NOT ONE =================
 * Identical rationale to `lib/firestore/teamClaimVerifications.ts`: the
 * 3-provider `executeVideoVerification()` call can take several seconds.
 * `authorizeTeamVideoVerificationAdmission()` (Gate 1) exists ONLY to
 * answer "may this caller spend vision-provider resources through a Team
 * endpoint right now" — read-only, writes nothing.
 * `saveTeamVideoVerification()` (Gate 2) independently re-derives the same
 * authorization from scratch, inside its OWN transaction, at the moment
 * the real artifact is about to be created — Gate 2 never trusts Gate 1.
 * If Gate 2 denies, already-spent quota and already-consumed provider
 * tokens are NOT refunded (Phase 8C-E.3.3.0 §29/§20 — generic usage is
 * charged atomically BEFORE `executeVideoVerification()` runs, so it is
 * never contingent on Gate 2's outcome at all).
 *
 * ================= VERIFICATION-ID OWNERSHIP =================
 * Frozen by Phase 8C-E.3.3.0.3: `saveTeamVideoVerification()` — not the
 * route — generates `vid-${randomUUID()}` exactly once, before opening its
 * transaction. The route never generates, receives, or supplies an id.
 *
 * ================= DEDUP IS A SEPARATE CONCERN =================
 * `findTeamVideoVerificationDedupCandidate()` is deliberately NOT part of
 * Gate 1 or Gate 2 — it re-scopes Personal Video's own newest-candidate-only
 * dedup query (`lib/... app/api/verify-video/route.ts`) to
 * `userId`+`fileName`+`workspaceId`+`projectId` equality, preserving the
 * exact same (odd but characterized) "only ever evaluate the single newest
 * matching doc" behavior. Unlike Personal's own dedup, which wraps its
 * query in a best-effort try/catch and falls through to full creation on
 * failure, this function does NOT catch a Firestore query failure — it
 * propagates to the caller's own safe boundary (Phase 8C-E.3.3.0.2 §10:
 * a Team-scoped existing-resource lookup is authorization-sensitive; an
 * infrastructure failure must never silently convert into a fresh,
 * expensive creation path).
 */

import "server-only";
import { randomUUID } from "crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { roleHasCapability } from "@/lib/workspaces/capabilities";
import { isWellFormedProjectV1 } from "@/lib/projects/types";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import type { MetadataAnalysis, VideoMetadata } from "@/lib/video/videoPure";

// ============================================================
// GATE 1 — execution admission (read-only, no write)
// ============================================================

export type TeamVideoGate1Result =
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
 * `string | null`.
 */
export async function authorizeTeamVideoVerificationAdmission(args: {
  uid: string;
  workspaceId: string;
  projectId: string | null;
}): Promise<TeamVideoGate1Result> {
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
    logger.warn("[firestore/teamVideoVerifications] Gate 1 admission transaction failed", {
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
// DEDUP — Team-scoped candidate lookup (no write, no auth decision)
// ============================================================

export interface TeamVideoDedupCandidate {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Team-scoped equivalent of Personal Video's inline newest-candidate-only
 * dedup check, re-scoped to `userId`+`fileName`+`workspaceId`+`projectId`
 * equality (still no `orderBy` — equality-only multi-field queries do not
 * require a Firestore composite index). Preserves the exact same
 * characterized behavior: only the single newest matching document is
 * ever evaluated against the window/size/duration criteria; an older
 * document that would independently match is never consulted.
 *
 * Does NOT catch a Firestore query failure — see this module's own header
 * comment for why that is a deliberate, frozen divergence from Personal's
 * own best-effort dedup catch.
 */
export async function findTeamVideoVerificationDedupCandidate(args: {
  uid: string;
  workspaceId: string;
  projectId: string | null;
  fileName: string;
  fileSize: number;
  duration: number;
  windowMs: number;
}): Promise<TeamVideoDedupCandidate | null> {
  if (!adminDb) {
    throw new Error("Firestore is not available.");
  }

  const cutoff = new Date(Date.now() - args.windowMs);
  const snap = await adminDb
    .collection("videoVerifications")
    .where("userId", "==", args.uid)
    .where("fileName", "==", args.fileName)
    .where("workspaceId", "==", args.workspaceId)
    .where("projectId", "==", args.projectId)
    .get();

  const sortedDocs = snap.docs.sort((a, b) => {
    const aTs = a.data().timestamp;
    const bTs = b.data().timestamp;
    const aMs = aTs && typeof aTs.toMillis === "function" ? aTs.toMillis() : 0;
    const bMs = bTs && typeof bTs.toMillis === "function" ? bTs.toMillis() : 0;
    return bMs - aMs;
  });

  if (sortedDocs.length === 0) {
    return null;
  }

  const newest = sortedDocs[0];
  const data = newest.data() as Record<string, unknown>;
  const ts = data.timestamp;
  let recentMs = 0;
  if (ts && typeof ts === "object" && "toMillis" in ts && typeof (ts as { toMillis: () => number }).toMillis === "function") {
    recentMs = (ts as { toMillis: () => number }).toMillis();
  }
  const meta = data.metadata as Record<string, unknown> | undefined;
  const recentFileSize = typeof meta?.fileSize === "number" ? meta.fileSize : -1;
  const recentDuration = typeof meta?.duration === "number" ? meta.duration : -1;

  if (
    recentMs > 0 &&
    new Date(recentMs) > cutoff &&
    recentFileSize === args.fileSize &&
    Math.abs(recentDuration - args.duration) < 0.5
  ) {
    return { id: newest.id, data };
  }

  return null;
}

// ============================================================
// GATE 2 — canonical Team Video persistence (fresh reauthorization + write)
// ============================================================

export interface TeamVideoModelResultRow {
  modelId: string;
  modelName: string;
  status: string;
  verdict: string;
  confidence: string;
  contentType: string;
  summary: string;
  visualIndicators: string[];
  metadataIndicators: string[];
  manipulationSignals: string[];
  authenticitySignals: string[];
  productionSignals: string[];
  deceptionIndicators: string[];
  compressionNotes: string[];
  limitations: string[];
}

export type TeamVideoGate2Result =
  | { status: "created"; verificationId: string; workspaceId: string; projectId: string | null }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "project_not_found" }
  | { status: "project_archived" }
  | { status: "transaction_failed" };

/**
 * `args` carries the fully-computed Video result (produced by the SAME
 * `executeVideoVerification()` Personal uses) plus the immutable target
 * identifiers and the already-resolved requester `userEmail` (Phase
 * 8C-E.3.3.0.1 — this function performs no email lookup of its own).
 * Independently re-derives authorization from scratch — never reads or
 * trusts a Gate 1 result. Generates its own `verificationId` exactly once,
 * before opening its transaction (Phase 8C-E.3.3.0.3) — a Firestore-level
 * retry of the transaction callback reuses the same id/`DocumentReference`.
 */
export async function saveTeamVideoVerification(args: {
  uid: string;
  userEmail: string;
  workspaceId: string;
  projectId: string | null;
  fileName: string;
  verdict: string;
  contentType: string;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  supportRatio: number;
  metadata: VideoMetadata;
  metadataAnalysis: MetadataAnalysis;
  modelResults: TeamVideoModelResultRow[];
  agreementPoints: string[];
  disagreementPoints: string[];
  frameCount: number;
  warnings: string[];
  totalTokens: number;
}): Promise<TeamVideoGate2Result> {
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

  // Allocated once, before runTransaction() — never regenerated on a
  // Firestore-internal retry of the callback (Phase 8C-E.3.3.0.3).
  const verificationId = `vid-${randomUUID()}`;
  const verificationRef = adminDb.collection("videoVerifications").doc(verificationId);

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

      const canonicalDoc = {
        userId: args.uid,
        userEmail: args.userEmail,
        type: "video_verification",
        fileName: args.fileName,
        verdict: args.verdict,
        contentType: args.contentType,
        consensusScore: args.consensusScore,
        confidenceLabel: args.confidenceLabel,
        evidenceQuality: args.evidenceQuality,
        supportRatio: args.supportRatio,
        metadata: args.metadata,
        metadataAnalysis: args.metadataAnalysis,
        modelResults: args.modelResults,
        agreementPoints: args.agreementPoints,
        disagreementPoints: args.disagreementPoints,
        frameCount: args.frameCount,
        warnings: args.warnings,
        totalTokens: args.totalTokens,
        // FieldValue.serverTimestamp() sentinel — matches Personal Video's
        // own persistence semantics exactly (Phase 8C-E.3.3.0.2 §4), not
        // Team Claim's unrelated Timestamp.now() choice.
        timestamp: FieldValue.serverTimestamp(),
        // ALWAYS present — see lib/workspaces/teamVideoVerificationRowValidation.ts,
        // which treats an absent projectId identically to a malformed one.
        workspaceId: args.workspaceId,
        projectId: args.projectId,
      };
      const safe = sanitizeForFirestore(canonicalDoc) as DocumentData;
      tx.create(verificationRef, safe);

      return { kind: "created" };
    });
  } catch (err: unknown) {
    // The TRANSACTION ITSELF failed (including a verificationId collision
    // on tx.create()) — genuinely nothing committed. Caught HERE so the
    // route can still attempt token accounting on the returned result,
    // rather than this exception escaping past that accounting sequence.
    logger.warn("[firestore/teamVideoVerifications] Gate 2 persistence transaction failed — no Team Video artifact was created", {
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
