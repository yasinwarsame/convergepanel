/**
 * Personal Reviewer Inbox + Action Flow — pure DTO builder for a reviewer's
 * personal-assignment inbox row. No I/O: the caller (the route) does its
 * own batched Firestore reads and passes already-fetched data in, matching
 * this codebase's established pattern (buildReviewGovernanceViewModel,
 * teamReviewQueueEnrichment.ts).
 *
 * Source of truth is the canonical assignment + governanceRecord.humanReview
 * — never a secondary projection. Unlike the team review QUEUE (which
 * tolerates a stale teamRuns projection for discovery only), there is no
 * projection here to tolerate: the collectionGroup query over
 * humanReviewAssignment IS the canonical assignment record itself (Part 33).
 */

import type { HumanReviewStatus } from "../adaptiveSchema/governanceRecordParser";
import type { PersistedAdaptiveSchemaId } from "../adaptiveSchema/persistedOutput";
import type { AnswerShape } from "../adaptiveSchema/types";

/**
 * Mirrors ReportStatusKind's terminal vocabulary exactly (Part 32) — never
 * invents "In review", since no canonical started-reading state exists in
 * the data model.
 */
export type PersonalReviewInboxStatus =
  | "assigned"
  | "approved"
  | "approved_with_conditions"
  | "changes_requested"
  | "rejected";

export function personalReviewInboxStatus(humanReviewStatus: HumanReviewStatus): PersonalReviewInboxStatus {
  switch (humanReviewStatus) {
    case "approved":
    case "approved_with_conditions":
    case "changes_requested":
    case "rejected":
      return humanReviewStatus;
    case "unreviewed":
    case "pending":
    default:
      return "assigned";
  }
}

export function isPersonalReviewInboxStatusCompleted(status: PersonalReviewInboxStatus): boolean {
  return status !== "assigned";
}

export interface PersonalReviewInboxItemV1 {
  runId: string;
  /** Truncated report title/question — same truncation discipline as the team queue's own receiptConclusion field. */
  title: string;
  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;
  assignedAt: string;
  /** Resolved, safe display identity — never a raw uid or unmasked email (Part 17). */
  ownerDisplayName: string;
  status: PersonalReviewInboxStatus;
  /** Only present once a terminal decision exists. */
  completedAt?: string;
}

const MAX_TITLE_LENGTH = 200;

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Pure. `runData`/`ownerDisplayName` are already-fetched/resolved by the
 * caller — this function only shapes the safe, minimal DTO (Part 9): no
 * billing fields, no token usage, no private comments, no system prompts,
 * no raw governance document, no Firestore revision internals beyond the
 * one timestamp fields a reviewer actually needs.
 */
export function buildPersonalReviewInboxItem(args: {
  runId: string;
  assignedAt: string;
  ownerDisplayName: string;
  runData: {
    question?: unknown;
    governanceRecord?: {
      schemaId?: unknown;
      answerShape?: unknown;
      humanReview?: { status?: unknown; reviewedAt?: unknown };
    };
  };
}): PersonalReviewInboxItemV1 | null {
  const gov = args.runData.governanceRecord;
  const schemaId = typeof gov?.schemaId === "string" ? (gov.schemaId as PersistedAdaptiveSchemaId) : null;
  const answerShape = typeof gov?.answerShape === "string" ? (gov.answerShape as AnswerShape) : null;
  const rawStatus = gov?.humanReview?.status;
  const validStatuses = new Set(["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"]);
  if (!schemaId || !answerShape || typeof rawStatus !== "string" || !validStatuses.has(rawStatus)) {
    // A malformed/incomplete governance record for an assigned run is a
    // genuine data problem — the caller is responsible for logging it and
    // deciding whether to surface an "unavailable" row instead of silently
    // dropping it (Part 36). This builder itself never fabricates.
    return null;
  }

  const status = personalReviewInboxStatus(rawStatus as HumanReviewStatus);
  const reviewedAt = gov?.humanReview?.reviewedAt;

  return {
    runId: args.runId,
    title: truncate(String(args.runData.question ?? ""), MAX_TITLE_LENGTH),
    schemaId,
    answerShape,
    assignedAt: args.assignedAt,
    ownerDisplayName: args.ownerDisplayName,
    status,
    ...(isPersonalReviewInboxStatusCompleted(status) && typeof reviewedAt === "string" ? { completedAt: reviewedAt } : {}),
  };
}

export type PersonalReviewInboxFilter = "pending" | "completed" | "all";

export function filterPersonalReviewInboxItems(items: PersonalReviewInboxItemV1[], filter: PersonalReviewInboxFilter): PersonalReviewInboxItemV1[] {
  if (filter === "all") return items;
  if (filter === "pending") return items.filter((i) => i.status === "assigned");
  return items.filter((i) => i.status !== "assigned");
}
