/**
 * Immutable Adaptive Review History and Admin Audit Integration — an
 * internal, idempotent repair service for the secondary artifacts of an
 * already-committed adaptive review decision
 * (docs/governance-decision-receipts-design.md §27.9). Not exposed via a
 * public route in this step (no protected admin-repair pattern exists yet
 * to reuse) and not scheduled/automated — a plain, callable function only.
 *
 * Never alters `governanceRecord.humanReview` (read-only against it), never
 * reopens a review, and never rewrites the `teamRuns` projection — this
 * function's only job is to fill in a MISSING immutable history record or
 * admin audit entry for a decision that already, genuinely committed.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import { createAdaptiveHumanReviewHistory } from "@/lib/firestore/runs";
import { writeAdaptiveAdminAuditEvent } from "@/lib/governance/auditLog";
import {
  buildAdaptiveReviewDecisionId,
  buildAdaptiveHumanReviewHistoryEntry,
  isAdaptiveReviewTerminalStatus,
} from "@/lib/governance/adaptiveHumanReviewHistory";

export type RepairAdaptiveReviewArtifactsResult =
  | {
      status: "repaired" | "already_complete" | "not_terminal";
      historyStatus?: "recorded" | "already_exists" | "failed";
      auditStatus?: "recorded" | "already_exists" | "failed";
    }
  | { status: "run_missing" | "governance_record_unavailable" | "firestore_unavailable" };

/**
 * `priorStatus` for a repaired decision is derived as the terminal status's
 * only possible non-terminal predecessor — since Phase 2A's state machine
 * never distinguishes which of `unreviewed`/`pending` preceded a given
 * terminal decision once it has already committed (both transition to the
 * same 4 terminal statuses), and the canonical record no longer carries
 * that information after the fact. `"unreviewed"` is used as a fixed,
 * documented convention for repaired records specifically — never
 * fabricated as if it were positively known when it wasn't.
 */
const REPAIR_PRIOR_STATUS_CONVENTION = "unreviewed" as const;

export async function repairAdaptiveReviewArtifacts(runId: string, teamId: string): Promise<RepairAdaptiveReviewArtifactsResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  let runData: Record<string, unknown> | undefined;
  try {
    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) {
      return { status: "run_missing" };
    }
    runData = snap.data();
  } catch {
    logger.warn("[adaptiveReviewArtifactRepair] Failed to read parent run", { runId });
    return { status: "firestore_unavailable" };
  }

  const parseResult = parseGovernanceRecord(runData?.governanceRecord);
  if (!parseResult.ok) {
    logger.warn("[adaptiveReviewArtifactRepair] governanceRecord unavailable or malformed, skipping", { runId, reason: parseResult.reason });
    return { status: "governance_record_unavailable" };
  }
  const record = parseResult.record;

  if (!isAdaptiveReviewTerminalStatus(record.humanReview.status)) {
    return { status: "not_terminal" };
  }
  if (!record.humanReview.reviewedAt) {
    // A terminal status with no reviewedAt is itself malformed — never fabricate one.
    logger.warn("[adaptiveReviewArtifactRepair] Terminal humanReview missing reviewedAt, skipping", { runId });
    return { status: "governance_record_unavailable" };
  }

  const decisionId = buildAdaptiveReviewDecisionId(teamId, runId, record.humanReview.reviewedAt, record.humanReview.status);

  const historyEntry = buildAdaptiveHumanReviewHistoryEntry({
    decisionId,
    runId,
    teamId,
    schemaId: record.schemaId as PersistedAdaptiveSchemaId,
    answerShape: record.answerShape,
    priorStatus: REPAIR_PRIOR_STATUS_CONVENTION,
    newStatus: record.humanReview.status,
    reviewerId: record.humanReview.reviewerId ?? "unknown",
    reviewedAt: record.humanReview.reviewedAt,
    governanceRecordUpdatedAt: record.updatedAt,
    comment: record.humanReview.comment,
    conditions: record.humanReview.conditions,
    now: new Date().toISOString(),
  });

  const historyResult = await createAdaptiveHumanReviewHistory(runId, historyEntry);
  const auditResult = await writeAdaptiveAdminAuditEvent({
    decisionId,
    actorUid: record.humanReview.reviewerId ?? "unknown",
    teamId,
    runId,
    schemaId: record.schemaId,
    answerShape: record.answerShape,
    priorStatus: REPAIR_PRIOR_STATUS_CONVENTION,
    newStatus: record.humanReview.status,
    reviewedAt: record.humanReview.reviewedAt,
  });

  const bothAlreadyComplete = historyResult.status === "already_exists" && auditResult.status === "already_exists";

  return {
    status: bothAlreadyComplete ? "already_complete" : "repaired",
    historyStatus: historyResult.status,
    auditStatus: auditResult.status,
  };
}

