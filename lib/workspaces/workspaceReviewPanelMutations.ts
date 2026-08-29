/**
 * Approval Workflow, Phase 9B.5.2 — the shared Workspace-qualified
 * multi-reviewer PANEL mutation service: panel read/create/reconfigure/
 * cancel, vote submission, aggregation finalization, and explicit Owner
 * Override.
 *
 * Deliberately a NEW, self-contained set of transactional functions —
 * mirroring `workspaceReviewMutations.ts`'s own Phase 9B.5.1 precedent —
 * rather than calling the legacy `submitAdaptiveHumanReviewPanel()`/
 * `cancelAdaptiveHumanReviewPanel()`/`submitAdaptiveHumanReviewVote()`/
 * `finalizeAdaptiveHumanReviewPanel()`/`overrideAdaptiveHumanReviewPanel()`
 * (`lib/firestore/runs.ts`). Those functions open their OWN transactions
 * with legacy Team authorization (or, for vote submission, a fresh
 * `teams/{teamId}` re-read that has no Workspace analogue at all) — wrapping
 * them would require a SEPARATE transaction from the one that authorizes
 * the caller, exactly the "no second independent authorization window"
 * problem 9B.5.1 already resolved the same way. Instead this module reuses
 * the mature, already-tested PURE builders/parsers/aggregation-engine
 * directly inside its own Workspace-native transactions (which use
 * `authorizeTeamWorkspaceMutationInTransaction()` for every membership
 * check, including the vote-time eligibility re-check the legacy
 * transaction achieves via a second `teams/{teamId}` read — the Workspace
 * path gets the same freshness guarantee from the SAME transaction-scoped
 * membership snapshot, no second document type needed), and reuses the
 * existing Firestore I/O writers that are Workspace-agnostic (widened in
 * this phase to accept `teamId: string | null`, exactly mirroring the
 * PANEL/VOTE document types' own `teamId` widening — see
 * `adaptiveHumanReviewPanel.ts`/`adaptiveHumanReviewVote.ts`) as
 * best-effort, post-commit writes, exactly where the legacy finalize/
 * override routes already compose them. Legacy Team routes/behavior are
 * completely untouched by this module.
 *
 * TWO NEW WORKSPACE-ONLY MUTUAL-EXCLUSION INVARIANTS (§16/§49 of the Phase
 * 9B.5.2 spec — the other half of 9B.5.1's own "open panel blocks
 * single-review mutations" invariant):
 *
 *   1. An ACTIVELY ASSIGNED `humanReviewAssignment/current`
 *      (`assignedReviewerUserId !== null` — an unassigned-but-existing
 *      document, e.g. after a manager removes an assignment, does NOT
 *      count) blocks panel create/reconfigure. Read fresh, inside the SAME
 *      transaction as the panel write, exactly mirroring how 9B.5.1's
 *      `readPanelGate()` reads the panel fresh inside ITS OWN transaction.
 *   2. 9B.5.1's assignment/decision transactions already read the panel
 *      and reject on `"open"` — unchanged, zero-diff, not touched by this
 *      phase (per its own explicit scope freeze).
 *
 * Because BOTH sides read the OTHER side's critical document before
 * writing, Firestore's own transaction conflict/retry contract is what
 * closes every race between them (SINGLE_REVIEW_ACTIVE XOR PANEL_OPEN) —
 * no new concurrency primitive, no sentinel document, no distributed lock.
 * A concurrent ordinary DECISION racing a panel-create is closed the same
 * way, for free: panel-create already reads the run doc (for its own
 * `isHumanReviewStatusReviewable` check), so a concurrent decision commit
 * (which writes `governanceRecord.humanReview`) forces a retry, and the
 * retried attempt observes the now-terminal status and rejects.
 *
 * STALE-VOTE POLICY (§36 of the spec, explicitly frozen, not reinvented):
 * the mature `aggregateAdaptiveReviewVotes()`/legacy finalization
 * transaction never re-checks a voter's CURRENT membership/role at
 * finalization time — only that the stored vote is well-formed and
 * belongs to the current panel revision. A reviewer who voted while
 * eligible and was later removed/downgraded still has their vote counted.
 * This is an explicit, disclosed design invariant of Part C
 * (`adaptiveHumanReviewVote.ts`'s own module doc: "a vote, once created,
 * is immutable forever") — not an oversight, and not something this phase
 * silently redefines. The Workspace finalize/override transactions below
 * preserve it exactly: eligibility is enforced only at VOTE-CAST time
 * (inside `submitWorkspaceReviewPanelVote`'s own transaction), never
 * re-checked against already-cast votes at finalization time.
 *
 * DRAIN BEHAVIOR (§8/§59-62 of the spec): Approval Workflow admission
 * (`APPROVAL_WORKFLOW_ENABLED`/`_CANARY_UIDS`) gates ONLY panel
 * create/reconfigure (`putWorkspaceReviewPanel`) — checked at the ROUTE
 * layer before this service is ever called, exactly like 9B.5.1's
 * assignment PUT. Cancel/vote/finalize/override never check it at all,
 * mirroring the legacy panel/vote/finalize/override routes' own
 * documented, permanent design ("deliberately NO opt-in/global-guard
 * check — a DRAIN operation, not new activity") — Team Workspace admission
 * remains mandatory in every case, inside every transaction, regardless.
 * GET is the one read path that DOES need drain-awareness (an existing
 * open/finalized/cancelled panel must remain readable by its own
 * participants/managers even after Approval Workflow is globally
 * disabled, so nobody is stranded mid-review) — see
 * `getWorkspaceReviewPanel`'s own `approvalAdmitted` parameter and doc
 * comment below.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "./teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "./authorizeTeamWorkspaceMutationInTransaction";
import { roleHasCapability } from "./capabilities";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { isValidAssignmentTarget, violatesDecisionSelfReviewGuard, type WorkspaceReviewCandidate, type AssignmentTargetIneligibilityReason } from "./workspaceReviewEligibility";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import { isSubstantiveDecisionReceiptConclusion } from "@/lib/adaptiveSchema/decisionReceiptUsability";
import {
  parseAdaptiveHumanReviewPanel,
  buildNextAdaptiveHumanReviewPanel,
  buildCancelledAdaptiveHumanReviewPanel,
  buildFinalizedAdaptiveHumanReviewPanel,
  buildOwnerOverriddenAdaptiveHumanReviewPanel,
  normalizeAdaptivePanelReviewerUserIds,
  MIN_ADAPTIVE_PANEL_REVIEWERS,
  MAX_ADAPTIVE_PANEL_REVIEWERS,
  type AdaptiveHumanReviewPanelV1,
  type AdaptiveReviewFinalStatus,
} from "@/lib/governance/adaptiveHumanReviewPanel";
import {
  buildAdaptiveHumanReviewVote,
  parseAdaptiveHumanReviewVote,
  isSemanticallyEquivalentAdaptiveHumanReviewVote,
  buildAdaptiveHumanReviewVoteId,
  type AdaptiveHumanReviewVoteV1,
} from "@/lib/governance/adaptiveHumanReviewVote";
import { aggregateAdaptiveReviewVotes, ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION } from "@/lib/governance/adaptiveReviewAggregation";
import {
  buildWorkspacePanelFinalDecisionId,
  buildFinalConditionsUnion,
  buildFinalizedMultiReviewerHumanReview,
  buildAdaptivePanelFinalizationHistoryEntry,
} from "@/lib/governance/adaptivePanelFinalization";
import {
  parseSubmitAdaptiveReviewOverrideRequest,
  buildWorkspacePanelOverrideDecisionId,
  buildOverriddenMultiReviewerHumanReview,
  buildAdaptivePanelOverrideHistoryEntry,
} from "@/lib/governance/adaptivePanelOverride";
import { createAdaptivePanelFinalizationHistory, createAdaptivePanelOverrideHistory, writeAdaptivePanelFinalizationGovernanceEvent, writeAdaptivePanelOverrideGovernanceEvent, createAdaptiveHumanReviewHistory } from "@/lib/firestore/runs";
import { writeAdaptivePanelFinalizationAdminAuditEvent, writeAdaptivePanelOverrideAdminAuditEvent } from "@/lib/governance/auditLog";
import { buildAdaptiveHumanReviewHistoryEntry, isAdaptiveReviewNonTerminalStatus } from "@/lib/governance/adaptiveHumanReviewHistory";
import type { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import type { AdaptiveReviewDecisionStatus } from "@/lib/governance/adaptiveHumanReviewRequest";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

// ============================================
// Shared
// ============================================

type PanelParseOutcome = { kind: "absent" } | { kind: "unreadable" } | { kind: "valid"; panel: AdaptiveHumanReviewPanelV1 };

function readAndParsePanel(rawData: unknown, runId: string): PanelParseOutcome {
  const parsed = parseAdaptiveHumanReviewPanel(rawData, { expectedRunId: runId });
  if (parsed.status === "absent") return { kind: "absent" };
  if (parsed.status === "valid") return { kind: "valid", panel: parsed.panel };
  return { kind: "unreadable" }; // malformed | unsupported_version — fail closed identically, mirroring workspaceReviewMutations.ts's own panel-gate asymmetry.
}

/** Actively assigned only — an unassigned-but-existing assignment document (after a manager removes it) never blocks panel activity. */
function isAssignmentActive(rawData: Record<string, unknown> | undefined): boolean {
  return !!rawData && typeof rawData.assignedReviewerUserId === "string" && rawData.assignedReviewerUserId.length > 0;
}

// ============================================
// GET
// ============================================

export interface WorkspaceReviewPanelVoteSummaryDto {
  submittedCount: number;
  aggregationState: "waiting" | "deadlocked" | "ready";
}

export interface WorkspaceReviewPanelDto {
  status: "open" | "cancelled" | "finalized";
  revision: number;
  reviewerUserIds: string[];
  requiredReviewerCount: number;
  quorum: number;
  createdAt: string;
  updatedAt: string;
  workspaceId: string | null;
  projectId: string | null;
  finalizedAt: string | null;
  finalStatus: AdaptiveReviewFinalStatus | null;
  finalizedVia: "aggregation" | "owner_override" | null;
  /** Present only for an `"open"` panel — recomputed fresh from the pure engine every call, never stored/cached. */
  voteSummary: WorkspaceReviewPanelVoteSummaryDto | null;
}

async function readVotesForRevision(runRef: FirebaseFirestore.DocumentReference, reviewerUserIds: readonly string[], revision: number): Promise<AdaptiveHumanReviewVoteV1[]> {
  const refs = reviewerUserIds.map((reviewerUserId) => runRef.collection("humanReviewVotes").doc(buildAdaptiveHumanReviewVoteId(revision, reviewerUserId)));
  const snaps = await Promise.all(refs.map((ref) => ref.get()));
  const votes: AdaptiveHumanReviewVoteV1[] = [];
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const parsed = parseAdaptiveHumanReviewVote(snap.data(), { expectedRunId: runRef.id });
    if (parsed.status === "valid") votes.push(parsed.vote);
  }
  return votes;
}

async function toWorkspacePanelDto(runRef: FirebaseFirestore.DocumentReference, panel: AdaptiveHumanReviewPanelV1): Promise<WorkspaceReviewPanelDto> {
  let voteSummary: WorkspaceReviewPanelVoteSummaryDto | null = null;
  if (panel.status === "open") {
    const votes = await readVotesForRevision(runRef, panel.reviewerUserIds, panel.revision);
    const aggregate = aggregateAdaptiveReviewVotes({ panel, votes });
    if (aggregate.status === "waiting" || aggregate.status === "deadlocked" || aggregate.status === "ready") {
      voteSummary = { submittedCount: aggregate.submittedCount, aggregationState: aggregate.status };
    }
  }
  return {
    status: panel.status,
    revision: panel.revision,
    reviewerUserIds: panel.reviewerUserIds,
    requiredReviewerCount: panel.requiredReviewerCount,
    quorum: panel.quorum,
    createdAt: panel.createdAt,
    updatedAt: panel.updatedAt,
    workspaceId: panel.workspaceId ?? null,
    projectId: panel.projectId ?? null,
    finalizedAt: panel.finalizedAt ?? null,
    finalStatus: panel.finalStatus ?? null,
    finalizedVia: panel.finalizedVia ?? null,
    voteSummary,
  };
}

export type GetWorkspaceReviewPanelResult =
  | { status: "ok"; panel: WorkspaceReviewPanelDto | null }
  | { status: "run_not_found" }
  | { status: "not_admitted" }
  | { status: "panel_unreadable" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

/**
 * Plain, non-transactional read — no write follows. Team Workspace access
 * and `research.read`/`reviews.read` capability are the CALLER's (route's)
 * responsibility, exactly like 9B.5.1's assignment GET. `approvalAdmitted`
 * is the ONE piece of admission logic this function itself resolves
 * (rather than the route short-circuiting before any read, as every other
 * route does) — because whether "not admitted" should conceal or drain-read
 * depends on whether a panel already exists, which can only be known after
 * reading it. The route must establish Team Workspace access BEFORE calling
 * this (§60's ordering requirement) but must NOT itself decide the
 * Approval-admission HTTP response ahead of this call.
 */
export async function getWorkspaceReviewPanel(args: { workspaceId: string; runId: string; approvalAdmitted: boolean }): Promise<GetWorkspaceReviewPanelResult> {
  if (!adminDb) return { status: "firestore_unavailable" };
  try {
    const runRef = adminDb.collection("runs").doc(args.runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return { status: "run_not_found" };
    const runData = runSnap.data() as Record<string, unknown>;
    const target = resolveWorkspaceReviewTarget({
      requestedWorkspaceId: args.workspaceId,
      hasWorkspaceIdField: "workspaceId" in runData,
      workspaceIdValue: runData.workspaceId,
      userId: runData.userId,
      hasProjectIdField: "projectId" in runData,
      projectIdValue: runData.projectId,
    });
    if (target.kind !== "valid_workspace_review_target") return { status: "run_not_found" };

    const panelSnap = await runRef.collection("humanReviewPanel").doc("current").get();
    const outcome = readAndParsePanel(panelSnap.exists ? panelSnap.data() : undefined, args.runId);

    if (outcome.kind === "absent") {
      if (!args.approvalAdmitted) return { status: "not_admitted" };
      return { status: "ok", panel: null };
    }
    if (outcome.kind === "unreadable") return { status: "panel_unreadable" };

    // A panel EXISTS (any status) — always readable by an already-authorized
    // caller regardless of Approval Workflow admission (drain-read, §62).
    const dto = await toWorkspacePanelDto(runRef, outcome.panel);
    return { status: "ok", panel: dto };
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewPanelMutations] getWorkspaceReviewPanel failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}

// ============================================
// PUT (create / reconfigure)
// ============================================

export type PutWorkspaceReviewPanelFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "panel_finalized"
  | "panel_unreadable"
  | "single_review_active"
  | "not_pending"
  | { kind: "target_not_eligible"; reviewerUserId: string; reason: AssignmentTargetIneligibilityReason }
  | "stale_revision"
  | "write_failed";

export type PutWorkspaceReviewPanelResult = { ok: true; panel: WorkspaceReviewPanelDto } | { ok: false; reason: PutWorkspaceReviewPanelFailureReason };

/**
 * Create (no current panel) and reconfigure (existing `"open"` panel) share
 * one code path, exactly mirroring `submitAdaptiveHumanReviewPanel()`'s own
 * established shape — `expectedRevision` of `0` means "no panel exists yet."
 * `reviewerUserIds` is assumed already bounds/dedup-validated by the route
 * (mirrors 9B.5.1's own division of pure body-shape validation at the route
 * vs. transactional eligibility inside the service).
 */
export async function putWorkspaceReviewPanel(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  reviewerUserIds: string[];
  expectedRevision: number;
  now?: string;
}): Promise<PutWorkspaceReviewPanelResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  let transactionResult: { ok: true; panel: AdaptiveHumanReviewPanelV1 } | { ok: false; reason: PutWorkspaceReviewPanelFailureReason };
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.manage" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      // Explicit dual-capability requirement (Phase 9B.5.1-R1C's own corrected pattern, applied
      // proactively here) — never inferred from reviews.manage alone.
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" as const };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const govParse = parseGovernanceRecord(runData.governanceRecord);
      if (!govParse.ok || !isHumanReviewStatusReviewable(govParse.record.humanReview.status)) {
        return { ok: false, reason: "not_pending" as const };
      }

      // ---- Mutual exclusion (§16/§49): an actively assigned single-review
      // responsibility blocks panel create/reconfigure. Read fresh, in this
      // SAME transaction. ----
      const assignmentSnap = await tx.get(runRef.collection("humanReviewAssignment").doc("current"));
      if (isAssignmentActive(assignmentSnap.exists ? (assignmentSnap.data() as Record<string, unknown>) : undefined)) {
        return { ok: false, reason: "single_review_active" as const };
      }

      const panelSnap = await tx.get(runRef.collection("humanReviewPanel").doc("current"));
      const outcome = readAndParsePanel(panelSnap.exists ? panelSnap.data() : undefined, args.runId);
      if (outcome.kind === "unreadable") return { ok: false, reason: "panel_unreadable" as const };
      const current = outcome.kind === "valid" ? outcome.panel : null;
      if (current) {
        if (current.status === "finalized") return { ok: false, reason: "panel_finalized" as const };
        if (current.status !== "open") return { ok: false, reason: "panel_finalized" as const }; // cancelled — never reopened, §22.
      }

      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== args.expectedRevision) return { ok: false, reason: "stale_revision" as const };

      // ---- Reviewer eligibility — every candidate, every call, fresh. ----
      for (const reviewerUserId of args.reviewerUserIds) {
        const membershipId = computeMembershipId(args.workspaceId, reviewerUserId);
        const membershipSnap = await tx.get(adminDb!.collection("workspaceMemberships").doc(membershipId));
        const membership = membershipSnap.exists ? validateMembershipBinding(membershipSnap.data(), { workspaceId: args.workspaceId, uid: reviewerUserId }) : null;
        const candidate: WorkspaceReviewCandidate | null = membership ? { uid: membership.uid, workspaceId: membership.workspaceId, role: membership.role, status: membership.status } : null;
        const eligibility = isValidAssignmentTarget({ candidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid });
        if (!eligibility.eligible) return { ok: false, reason: { kind: "target_not_eligible" as const, reviewerUserId, reason: eligibility.reason } };
      }

      const nextPanel = buildNextAdaptiveHumanReviewPanel({
        teamId: null,
        runId: args.runId,
        reviewerUserIds: args.reviewerUserIds,
        actorUserId: args.uid,
        now,
        current,
        workspaceMetadata: { workspaceId: target.workspaceId, projectId: target.projectId },
      });

      tx.set(runRef.collection("humanReviewPanel").doc("current"), nextPanel);
      return { ok: true, panel: nextPanel };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewPanelMutations] putWorkspaceReviewPanel transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;
  const dto = await toWorkspacePanelDto(adminDb.collection("runs").doc(args.runId), transactionResult.panel);
  return { ok: true, panel: dto };
}

// ============================================
// DELETE (cancel)
// ============================================

export type DeleteWorkspaceReviewPanelFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "panel_absent"
  | "panel_already_cancelled"
  | "panel_finalized"
  | "panel_unreadable"
  | "not_pending"
  | "stale_revision"
  | "write_failed";

export type DeleteWorkspaceReviewPanelResult = { ok: true } | { ok: false; reason: DeleteWorkspaceReviewPanelFailureReason };

/** Never a physical delete — writes a terminal `status: "cancelled"` configuration, preserving the reviewer list, exactly mirroring `cancelAdaptiveHumanReviewPanel()`. Drain-eligible — no Approval Workflow gate anywhere in this function or its caller. */
export async function deleteWorkspaceReviewPanel(args: { uid: string; workspaceId: string; runId: string; expectedRevision: number; now?: string }): Promise<DeleteWorkspaceReviewPanelResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  let transactionResult: DeleteWorkspaceReviewPanelResult;
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.manage" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" as const };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const govParse = parseGovernanceRecord(runData.governanceRecord);
      if (!govParse.ok || !isHumanReviewStatusReviewable(govParse.record.humanReview.status)) {
        return { ok: false, reason: "not_pending" as const };
      }

      const panelRef = runRef.collection("humanReviewPanel").doc("current");
      const panelSnap = await tx.get(panelRef);
      const outcome = readAndParsePanel(panelSnap.exists ? panelSnap.data() : undefined, args.runId);
      if (outcome.kind === "absent") return { ok: false, reason: "panel_absent" as const };
      if (outcome.kind === "unreadable") return { ok: false, reason: "panel_unreadable" as const };
      const current = outcome.panel;
      if (current.status === "finalized") return { ok: false, reason: "panel_finalized" as const };
      if (current.status !== "open") return { ok: false, reason: "panel_already_cancelled" as const };
      if (current.revision !== args.expectedRevision) return { ok: false, reason: "stale_revision" as const };

      const nextPanel = buildCancelledAdaptiveHumanReviewPanel({ current, actorUserId: args.uid, now });
      tx.set(panelRef, nextPanel);
      return { ok: true };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewPanelMutations] deleteWorkspaceReviewPanel transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  return transactionResult;
}

// ============================================
// POST vote
// ============================================

export type SubmitWorkspaceReviewPanelVoteFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "panel_absent"
  | "panel_not_open"
  | "panel_unreadable"
  | "panel_stale"
  | "not_reviewer"
  | "self_review"
  | "not_pending"
  | "vote_conflict"
  | "vote_malformed"
  | "review_content_unavailable"
  | "write_failed";

export type SubmitWorkspaceReviewPanelVoteResult =
  | { ok: true; vote: { status: AdaptiveReviewDecisionStatus; submittedAt: string; commentPresent: boolean; conditionsCount: number }; submissionStatus: "submitted" | "already_submitted" }
  | { ok: false; reason: SubmitWorkspaceReviewPanelVoteFailureReason };

/**
 * No Approval Workflow gate — drain-eligible, mirroring the legacy vote
 * route's own permanent design. Reviewer eligibility is re-checked against
 * the SAME transaction-scoped `auth.membership` snapshot this transaction
 * already produced — replacing the legacy transaction's separate
 * `teams/{teamId}` re-read with an equivalent freshness guarantee from one
 * fewer document type.
 */
export async function submitWorkspaceReviewPanelVote(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  panelRevision: number;
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
  now?: string;
}): Promise<SubmitWorkspaceReviewPanelVoteResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  let transactionResult: { ok: true; vote: AdaptiveHumanReviewVoteV1; submissionStatus: "submitted" | "already_submitted" } | { ok: false; reason: SubmitWorkspaceReviewPanelVoteFailureReason };
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.submit" });
      if (!auth.ok) return { ok: false, reason: auth.reason };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const govParse = parseGovernanceRecord(runData.governanceRecord);
      if (!govParse.ok || !isHumanReviewStatusReviewable(govParse.record.humanReview.status)) {
        return { ok: false, reason: "not_pending" as const };
      }

      const panelRef = runRef.collection("humanReviewPanel").doc("current");
      const panelSnap = await tx.get(panelRef);
      const outcome = readAndParsePanel(panelSnap.exists ? panelSnap.data() : undefined, args.runId);
      if (outcome.kind === "absent") return { ok: false, reason: "panel_absent" as const };
      if (outcome.kind === "unreadable") return { ok: false, reason: "panel_unreadable" as const };
      const panel = outcome.panel;
      if (panel.status !== "open") return { ok: false, reason: "panel_not_open" as const };
      if (panel.revision !== args.panelRevision) return { ok: false, reason: "panel_stale" as const };

      // Independent, decision-time self-review re-check — never trust a
      // corrupted panel.reviewerUserIds list that happens to include the
      // creator.
      if (violatesDecisionSelfReviewGuard(args.uid, target.creatorUid)) return { ok: false, reason: "self_review" as const };

      if (!panel.reviewerUserIds.includes(args.uid)) return { ok: false, reason: "not_reviewer" as const };
      const candidate: WorkspaceReviewCandidate = { uid: args.uid, workspaceId: args.workspaceId, role: auth.membership.role, status: auth.membership.status };
      const eligibility = isValidAssignmentTarget({ candidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid });
      if (!eligibility.eligible) return { ok: false, reason: "not_reviewer" as const };

      // Team Workspace Boundary Hardening, backend correction (10C.4A-U2B)
      // — canonical governance-state integrity, checked LAST, only after
      // every identity/authorization/panel-eligibility check above has
      // already succeeded, so this can never become an authorization
      // oracle. `govParse.record` is already loaded above (and narrowed
      // non-null by the reviewable-status guard) — zero additional
      // Firestore reads.
      if (!isSubstantiveDecisionReceiptConclusion(govParse.record.decisionReceipt.conclusion)) {
        return { ok: false, reason: "review_content_unavailable" as const };
      }

      const nextVote = buildAdaptiveHumanReviewVote({ teamId: null, runId: args.runId, panelRevision: args.panelRevision, reviewerUserId: args.uid, status: args.status, comment: args.comment, conditions: args.conditions, now });

      const voteRef = runRef.collection("humanReviewVotes").doc(buildAdaptiveHumanReviewVoteId(args.panelRevision, args.uid));
      const voteSnap = await tx.get(voteRef);
      if (voteSnap.exists) {
        const existingParse = parseAdaptiveHumanReviewVote(voteSnap.data(), { expectedRunId: args.runId, expectedPanelRevision: args.panelRevision, expectedReviewerUserId: args.uid });
        if (existingParse.status !== "valid") return { ok: false, reason: "vote_malformed" as const };
        if (isSemanticallyEquivalentAdaptiveHumanReviewVote(existingParse.vote, nextVote)) {
          return { ok: true, vote: existingParse.vote, submissionStatus: "already_submitted" as const };
        }
        return { ok: false, reason: "vote_conflict" as const };
      }

      tx.set(voteRef, nextVote);
      return { ok: true, vote: nextVote, submissionStatus: "submitted" as const };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewPanelMutations] submitWorkspaceReviewPanelVote transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;
  const { vote, submissionStatus } = transactionResult;
  return { ok: true, submissionStatus, vote: { status: vote.status, submittedAt: vote.submittedAt, commentPresent: vote.commentPresent, conditionsCount: vote.conditionsCount } };
}

// ============================================
// POST finalize
// ============================================

export type FinalizeWorkspaceReviewPanelFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "panel_absent"
  | "panel_cancelled"
  | "panel_unreadable"
  | "governance_stale"
  | "not_pending"
  | "panel_stale"
  | "vote_unreadable"
  | "quorum_not_met"
  | "panel_deadlocked"
  | "aggregation_invalid"
  | "inconsistent_finalization_state"
  | "write_failed";

export type FinalizeWorkspaceReviewPanelResult = { ok: true; status: AdaptiveReviewFinalStatus; finalizedAt: string } | { ok: false; reason: FinalizeWorkspaceReviewPanelFailureReason };

/** No Approval Workflow gate — drain-eligible. Requires `reviews.manage` (any manager may finalize an already-`ready` panel, mirroring the legacy finalize route's own "mechanical, not an executive judgment call" rationale). */
export async function finalizeWorkspaceReviewPanel(args: { uid: string; workspaceId: string; runId: string; expectedPanelRevision: number; expectedGovernanceUpdatedAt: string; now?: string }): Promise<FinalizeWorkspaceReviewPanelResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  type Committed = {
    panel: AdaptiveHumanReviewPanelV1;
    humanReview: ReturnType<typeof buildFinalizedMultiReviewerHumanReview>;
    priorStatus: GovernanceRecordV1["humanReview"]["status"];
    schemaId: PersistedAdaptiveSchemaId;
    answerShape: GovernanceRecordV1["answerShape"];
    submittedCount: number;
    alreadyFinalized: boolean;
  };
  let transactionResult: { ok: true } & Committed | { ok: false; reason: FinalizeWorkspaceReviewPanelFailureReason };
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.manage" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" as const };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const govParse = parseGovernanceRecord(runData.governanceRecord);
      if (!govParse.ok) return { ok: false, reason: "not_pending" as const };
      const record = govParse.record;

      const panelRef = runRef.collection("humanReviewPanel").doc("current");
      const panelSnap = await tx.get(panelRef);
      const outcome = readAndParsePanel(panelSnap.exists ? panelSnap.data() : undefined, args.runId);
      if (outcome.kind === "absent") return { ok: false, reason: "panel_absent" as const };
      if (outcome.kind === "unreadable") return { ok: false, reason: "panel_unreadable" as const };
      const panel = outcome.panel;

      // ---- Idempotency (mirrors finalizeAdaptiveHumanReviewPanel exactly) ----
      if (panel.status === "finalized") {
        const preFinalizationRevision = panel.revision - 1;
        if (preFinalizationRevision !== args.expectedPanelRevision) return { ok: false, reason: "panel_stale" as const };
        if (panel.finalizedVia === "owner_override") return { ok: false, reason: "inconsistent_finalization_state" as const };
        const consistent =
          !isHumanReviewStatusReviewable(record.humanReview.status) &&
          record.humanReview.decidedVia === "multi_reviewer_panel" &&
          record.humanReview.status === panel.finalStatus &&
          record.humanReview.panelRevision === preFinalizationRevision;
        if (!consistent) return { ok: false, reason: "inconsistent_finalization_state" as const };

        const idemVotes = await readVotesForRevisionInTransaction(tx, runRef, panel.reviewerUserIds, preFinalizationRevision);
        return {
          ok: true,
          panel,
          humanReview: record.humanReview as ReturnType<typeof buildFinalizedMultiReviewerHumanReview>,
          priorStatus: "unreviewed",
          schemaId: record.schemaId as PersistedAdaptiveSchemaId,
          answerShape: record.answerShape,
          submittedCount: idemVotes.length,
          alreadyFinalized: true,
        };
      }
      if (panel.status === "cancelled") return { ok: false, reason: "panel_cancelled" as const };

      // panel.status === "open" from here.
      if (record.updatedAt !== args.expectedGovernanceUpdatedAt) return { ok: false, reason: "governance_stale" as const };
      if (!isHumanReviewStatusReviewable(record.humanReview.status)) return { ok: false, reason: "not_pending" as const };
      if (panel.revision !== args.expectedPanelRevision) return { ok: false, reason: "panel_stale" as const };

      const votes = await readVotesForRevisionInTransaction(tx, runRef, panel.reviewerUserIds, panel.revision);
      const invalidVoteEncountered = votes.some((v) => v === null);
      if (invalidVoteEncountered) return { ok: false, reason: "vote_unreadable" as const };
      const validVotes = votes as AdaptiveHumanReviewVoteV1[];

      const aggregate = aggregateAdaptiveReviewVotes({ panel, votes: validVotes });
      if (aggregate.status === "waiting") return { ok: false, reason: "quorum_not_met" as const };
      if (aggregate.status === "deadlocked") return { ok: false, reason: "panel_deadlocked" as const };
      if (aggregate.status === "invalid") {
        logger.warn("[workspaces/workspaceReviewPanelMutations] aggregateAdaptiveReviewVotes unexpectedly returned invalid", { runId: args.runId, reason: aggregate.reason });
        return { ok: false, reason: "aggregation_invalid" as const };
      }

      const finalDecisionId = buildWorkspacePanelFinalDecisionId(args.workspaceId, args.runId, panel.revision, aggregate.finalStatus, aggregate.policyVersion);
      const conditions = aggregate.finalStatus === "approved_with_conditions" ? buildFinalConditionsUnion(validVotes, aggregate.supportingReviewerUserIds) : undefined;
      const humanReview = buildFinalizedMultiReviewerHumanReview({
        finalStatus: aggregate.finalStatus,
        finalizingActorUid: args.uid,
        reviewedAt: now,
        conditions,
        panelRevision: panel.revision,
        aggregationPolicyVersion: aggregate.policyVersion,
        supportingReviewerCount: aggregate.supportingReviewerUserIds.length,
      });
      const finalizedPanel = buildFinalizedAdaptiveHumanReviewPanel({ current: panel, actorUserId: args.uid, now, finalStatus: aggregate.finalStatus, finalDecisionId, aggregationPolicyVersion: aggregate.policyVersion });
      const priorStatus = record.humanReview.status;

      tx.update(runRef, { "governanceRecord.humanReview": humanReview, "governanceRecord.updatedAt": now });
      tx.set(panelRef, finalizedPanel);

      return { ok: true, panel: finalizedPanel, humanReview, priorStatus, schemaId: record.schemaId as PersistedAdaptiveSchemaId, answerShape: record.answerShape, submittedCount: validVotes.length, alreadyFinalized: false };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewPanelMutations] finalizeWorkspaceReviewPanel transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;
  const { panel, humanReview, priorStatus, schemaId, answerShape, submittedCount } = transactionResult;
  const finalDecisionId = panel.finalDecisionId!;
  const finalizedAt = panel.finalizedAt!;
  const finalStatus = panel.finalStatus!;
  const aggregationPolicyVersion = panel.aggregationPolicyVersion!;
  const preFinalizationPanelRevision = panel.revision - 1;

  // ---- Secondary artifacts — best-effort, post-commit, attempted for BOTH
  // a fresh finalization and an idempotent retry, mirroring the legacy
  // finalize route's own composition exactly. ----
  try {
    const priorStatusForHistory = isAdaptiveReviewNonTerminalStatus(priorStatus) ? priorStatus : "unreviewed";
    const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
      decisionId: finalDecisionId,
      runId: args.runId,
      teamId: null,
      schemaId,
      answerShape,
      priorStatus: priorStatusForHistory,
      newStatus: finalStatus,
      reviewerId: panel.finalizedByUserId!,
      reviewedAt: finalizedAt,
      governanceRecordUpdatedAt: finalizedAt,
      comment: humanReview.comment,
      conditions: humanReview.conditions,
      now: finalizedAt,
    });
    await createAdaptiveHumanReviewHistory(args.runId, historyEntry);
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Immutable review-history write threw after a successful finalization", { workspaceId: args.workspaceId, runId: args.runId });
  }
  try {
    const panelHistoryEntry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId: null,
      runId: args.runId,
      preFinalizationPanelRevision,
      finalizedPanelRevision: panel.revision,
      finalStatus,
      finalDecisionId,
      aggregationPolicyVersion,
      reviewerCount: panel.requiredReviewerCount,
      submittedCount,
      supportingReviewerCount: humanReview.supportingReviewerCount ?? 0,
      actorUserId: panel.finalizedByUserId!,
      finalizedAt,
    });
    await createAdaptivePanelFinalizationHistory(args.runId, panelHistoryEntry);
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Panel finalization history write threw after a successful finalization", { workspaceId: args.workspaceId, runId: args.runId });
  }
  try {
    await writeAdaptivePanelFinalizationGovernanceEvent({
      runId: args.runId,
      teamId: null,
      schemaId,
      answerShape,
      finalStatus,
      finalDecisionId,
      aggregationPolicyVersion,
      supportingReviewerCount: humanReview.supportingReviewerCount ?? 0,
      actorUserId: panel.finalizedByUserId!,
      finalizedAt,
    });
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Governance event write threw after a successful finalization", { workspaceId: args.workspaceId, runId: args.runId });
  }
  try {
    await writeAdaptivePanelFinalizationAdminAuditEvent({
      actorUid: panel.finalizedByUserId!,
      teamId: null,
      runId: args.runId,
      priorHumanReviewStatus: priorStatus,
      finalStatus,
      panelRevision: preFinalizationPanelRevision,
      finalDecisionId,
      aggregationPolicyVersion,
      finalizedAt,
    });
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Admin audit write threw after a successful finalization", { workspaceId: args.workspaceId, runId: args.runId });
  }

  return { ok: true, status: finalStatus, finalizedAt };
}

async function readVotesForRevisionInTransaction(
  tx: FirebaseFirestore.Transaction,
  runRef: FirebaseFirestore.DocumentReference,
  reviewerUserIds: readonly string[],
  revision: number
): Promise<(AdaptiveHumanReviewVoteV1 | null)[]> {
  const refs = reviewerUserIds.map((reviewerUserId) => runRef.collection("humanReviewVotes").doc(buildAdaptiveHumanReviewVoteId(revision, reviewerUserId)));
  const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
  const out: (AdaptiveHumanReviewVoteV1 | null)[] = [];
  for (const snap of snaps) {
    if (!snap.exists) continue; // not yet voted — not an error.
    const parsed = parseAdaptiveHumanReviewVote(snap.data(), { expectedRunId: runRef.id, expectedPanelRevision: revision });
    out.push(parsed.status === "valid" ? parsed.vote : null);
  }
  return out;
}

// ============================================
// POST override (explicit Owner Override)
// ============================================

export type OverrideWorkspaceReviewPanelFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  | "run_not_found"
  | "panel_absent"
  | "panel_cancelled"
  | "panel_unreadable"
  | "governance_stale"
  | "not_pending"
  | "panel_stale"
  | "panel_already_finalized"
  | "inconsistent_finalization_state"
  | "review_content_unavailable"
  | "write_failed";

export type OverrideWorkspaceReviewPanelResult = { ok: true; status: AdaptiveReviewFinalStatus; finalizedAt: string } | { ok: false; reason: OverrideWorkspaceReviewPanelFailureReason };

/**
 * `reviews.override` (Owner-only in the current capability matrix — never
 * checked by role name) AND `research.read`, from the same transaction
 * membership snapshot. No Approval Workflow gate — drain-eligible, and
 * naturally self-limiting: an override with no existing panel simply fails
 * `panel_absent`, so this can never become a general hidden bypass for an
 * unrelated run (§46). Self-review is deliberately NOT checked — the whole
 * point of this path is that an Owner may act on their own artifact, but
 * ONLY through this explicit, justified, immutably-audited route (§42).
 * Never reads, mutates, or aggregates votes (§F5's own established rule,
 * preserved exactly).
 */
export async function overrideWorkspaceReviewPanel(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  expectedPanelRevision: number;
  expectedGovernanceUpdatedAt: string;
  status: AdaptiveReviewFinalStatus;
  justification: string;
  conditions?: string[];
  now?: string;
}): Promise<OverrideWorkspaceReviewPanelResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) return { ok: false, reason: "team_workspaces_disabled" };
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  const now = args.now ?? new Date().toISOString();

  type Committed = {
    panel: AdaptiveHumanReviewPanelV1;
    humanReview: ReturnType<typeof buildOverriddenMultiReviewerHumanReview>;
    priorStatus: GovernanceRecordV1["humanReview"]["status"];
    schemaId: PersistedAdaptiveSchemaId;
    answerShape: GovernanceRecordV1["answerShape"];
  };
  let transactionResult: { ok: true } & Committed | { ok: false; reason: OverrideWorkspaceReviewPanelFailureReason };
  try {
    transactionResult = await adminDb.runTransaction(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "reviews.override" });
      if (!auth.ok) return { ok: false, reason: auth.reason };
      if (!roleHasCapability(auth.membership.role, "research.read")) return { ok: false, reason: "insufficient_capability" as const };

      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) return { ok: false, reason: "run_not_found" as const };
      const runData = runSnap.data() as Record<string, unknown>;
      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") return { ok: false, reason: "run_not_found" as const };

      const govParse = parseGovernanceRecord(runData.governanceRecord);
      if (!govParse.ok) return { ok: false, reason: "not_pending" as const };
      const record = govParse.record;

      const panelRef = runRef.collection("humanReviewPanel").doc("current");
      const panelSnap = await tx.get(panelRef);
      const outcome = readAndParsePanel(panelSnap.exists ? panelSnap.data() : undefined, args.runId);
      if (outcome.kind === "absent") return { ok: false, reason: "panel_absent" as const };
      if (outcome.kind === "unreadable") return { ok: false, reason: "panel_unreadable" as const };
      const panel = outcome.panel;

      // ---- Idempotency (mirrors overrideAdaptiveHumanReviewPanel exactly) ----
      if (panel.status === "finalized") {
        const preOverrideRevision = panel.revision - 1;
        if (preOverrideRevision !== args.expectedPanelRevision) return { ok: false, reason: "panel_stale" as const };
        const expectedOverrideDecisionId = buildWorkspacePanelOverrideDecisionId({ workspaceId: args.workspaceId, runId: args.runId, panelRevision: preOverrideRevision, status: args.status, justification: args.justification, conditions: args.conditions });
        if (panel.finalizedVia !== "owner_override" || panel.finalDecisionId !== expectedOverrideDecisionId) {
          return { ok: false, reason: "panel_already_finalized" as const };
        }
        const consistent =
          !isHumanReviewStatusReviewable(record.humanReview.status) &&
          record.humanReview.decidedVia === "multi_reviewer_owner_override" &&
          record.humanReview.status === panel.finalStatus &&
          record.humanReview.panelRevision === preOverrideRevision;
        if (!consistent) return { ok: false, reason: "inconsistent_finalization_state" as const };
        return { ok: true, panel, humanReview: record.humanReview as ReturnType<typeof buildOverriddenMultiReviewerHumanReview>, priorStatus: "unreviewed", schemaId: record.schemaId as PersistedAdaptiveSchemaId, answerShape: record.answerShape };
      }
      if (panel.status === "cancelled") return { ok: false, reason: "panel_cancelled" as const };

      if (record.updatedAt !== args.expectedGovernanceUpdatedAt) return { ok: false, reason: "governance_stale" as const };
      if (!isHumanReviewStatusReviewable(record.humanReview.status)) return { ok: false, reason: "not_pending" as const };
      if (panel.revision !== args.expectedPanelRevision) return { ok: false, reason: "panel_stale" as const };

      // Team Workspace Boundary Hardening, backend correction (10C.4A-U2B)
      // — canonical governance-state integrity, checked LAST in the
      // genuinely-new-write path only (never in the idempotent-retry
      // branch above, which re-confirms an ALREADY-COMPLETED override and
      // performs no new write). Checked only after every identity/
      // authorization/OCC check has already succeeded, so this can never
      // become an authorization oracle. Zero additional Firestore reads.
      if (!isSubstantiveDecisionReceiptConclusion(record.decisionReceipt.conclusion)) {
        return { ok: false, reason: "review_content_unavailable" as const };
      }

      const finalDecisionId = buildWorkspacePanelOverrideDecisionId({ workspaceId: args.workspaceId, runId: args.runId, panelRevision: panel.revision, status: args.status, justification: args.justification, conditions: args.conditions });
      const humanReview = buildOverriddenMultiReviewerHumanReview({ finalStatus: args.status, overridingOwnerUid: args.uid, reviewedAt: now, justification: args.justification, conditions: args.conditions, panelRevision: panel.revision });
      const overriddenPanel = buildOwnerOverriddenAdaptiveHumanReviewPanel({ current: panel, actorUserId: args.uid, now, finalStatus: args.status, finalDecisionId, aggregationPolicyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION });
      const priorStatus = record.humanReview.status;

      tx.update(runRef, { "governanceRecord.humanReview": humanReview, "governanceRecord.updatedAt": now });
      tx.set(panelRef, overriddenPanel);

      return { ok: true, panel: overriddenPanel, humanReview, priorStatus, schemaId: record.schemaId as PersistedAdaptiveSchemaId, answerShape: record.answerShape };
    });
  } catch (err) {
    logger.warn("[workspaces/workspaceReviewPanelMutations] overrideWorkspaceReviewPanel transaction failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "write_failed" };
  }

  if (!transactionResult.ok) return transactionResult;
  const { panel, humanReview, priorStatus, schemaId, answerShape } = transactionResult;
  const finalDecisionId = panel.finalDecisionId!;
  const finalizedAt = panel.finalizedAt!;
  const finalStatus = panel.finalStatus!;
  const overrideByUserId = panel.overrideByUserId!;
  const preOverridePanelRevision = panel.revision - 1;
  const conditionsCount = humanReview.conditions?.length ?? 0;

  try {
    const priorStatusForHistory = isAdaptiveReviewNonTerminalStatus(priorStatus) ? priorStatus : "unreviewed";
    const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
      decisionId: finalDecisionId,
      runId: args.runId,
      teamId: null,
      schemaId,
      answerShape,
      priorStatus: priorStatusForHistory,
      newStatus: finalStatus,
      reviewerId: overrideByUserId,
      reviewedAt: finalizedAt,
      governanceRecordUpdatedAt: finalizedAt,
      comment: humanReview.comment,
      conditions: humanReview.conditions,
      now: finalizedAt,
    });
    await createAdaptiveHumanReviewHistory(args.runId, historyEntry);
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Immutable review-history write threw after a successful override", { workspaceId: args.workspaceId, runId: args.runId });
  }
  try {
    const panelHistoryEntry = buildAdaptivePanelOverrideHistoryEntry({ teamId: null, runId: args.runId, preOverridePanelRevision, overriddenPanelRevision: panel.revision, finalStatus, finalDecisionId, overrideByUserId, conditionsCount, finalizedAt });
    await createAdaptivePanelOverrideHistory(args.runId, panelHistoryEntry);
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Panel override history write threw after a successful override", { workspaceId: args.workspaceId, runId: args.runId });
  }
  try {
    await writeAdaptivePanelOverrideGovernanceEvent({ runId: args.runId, teamId: null, schemaId, answerShape, finalStatus, finalDecisionId, overrideByUserId, finalizedAt });
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Governance event write threw after a successful override", { workspaceId: args.workspaceId, runId: args.runId });
  }
  try {
    await writeAdaptivePanelOverrideAdminAuditEvent({ actorUid: overrideByUserId, teamId: null, runId: args.runId, priorHumanReviewStatus: priorStatus, finalStatus, panelRevision: preOverridePanelRevision, finalDecisionId, conditionsCount, finalizedAt });
  } catch {
    logger.warn("[workspaces/workspaceReviewPanelMutations] Admin audit write threw after a successful override", { workspaceId: args.workspaceId, runId: args.runId });
  }

  return { ok: true, status: finalStatus, finalizedAt };
}

// ============================================
// Shared body-validation helpers (route-layer, pure) — re-exported so the
// route file never duplicates the bounds/dedup rule.
// ============================================

export function validateWorkspacePanelReviewerUserIds(raw: unknown): { ok: true; value: string[] } | { ok: false; reason: "invalid_shape" | "duplicates" | "count_out_of_bounds" } {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && v.trim().length > 0)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const rawIds = raw as string[];
  const normalized = normalizeAdaptivePanelReviewerUserIds(rawIds);
  if (normalized.length !== rawIds.length) return { ok: false, reason: "duplicates" };
  if (normalized.length < MIN_ADAPTIVE_PANEL_REVIEWERS || normalized.length > MAX_ADAPTIVE_PANEL_REVIEWERS) return { ok: false, reason: "count_out_of_bounds" };
  return { ok: true, value: normalized };
}
