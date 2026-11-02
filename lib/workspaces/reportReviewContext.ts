/**
 * Order B, Stage B2 — read-only Report Review context for the review page (rendered in B3).
 *
 * Authorization mirrors the Approval Queue read: Team Workspace access with research.read AND reviews.read, and the
 * run bound to THIS Workspace; every denial is the concealed not-found. The viewer's decision ability is computed by
 * the SAME contract the server decision transaction enforces (evaluateReportReviewDecisionAuthority), so the UI can
 * never offer a decision the server would refuse, or hide one it would accept.
 *
 * Previous cycles come from the write-once archives and are returned read-only.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { REPORT_REVIEW_ENABLED } from "./reportReviewRollout";
import { resolveWorkspaceAccess } from "./resolveWorkspaceAccess";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { REPORT_REVIEW_CYCLES_COLLECTION } from "./reportReviewCollections";
import { parseReportReviewRecord, REPORT_REVIEW_DISCLAIMER, type ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { evaluateReportReviewDecisionAuthority, type ReportReviewDecisionDenial } from "@/lib/governance/reportReviewDecision";

export interface ReportReviewCycleSummary {
  cycle: number;
  status: string;
  reviewerId: string | null;
  reviewedAt: string | null;
  purposeCode: string;
  assignedReviewerUserId: string | null;
}

export type ReportReviewContextResult =
  | {
      status: "ok";
      record: ReportReviewRecordV1;
      previousCycles: ReportReviewCycleSummary[];
      assignment: { assignedReviewerUserId: string | null; revision: number };
      viewer: { canDecide: boolean; denial: ReportReviewDecisionDenial | null };
      disclaimer: string;
    }
  | { status: "not_found" }
  | { status: "integrity_violation" }
  | { status: "read_failed" };

export async function getReportReviewContext(args: { uid: string; workspaceId: string; runId: string }): Promise<ReportReviewContextResult> {
  if (!REPORT_REVIEW_ENABLED || !adminDb) return { status: "not_found" };
  const access = await resolveWorkspaceAccess({ uid: args.uid, workspaceId: args.workspaceId });
  if (!access.granted || access.workspaceType !== "team") return { status: "not_found" };
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) return { status: "not_found" };
  try {
    const runRef = adminDb.collection("runs").doc(args.runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return { status: "not_found" };
    const run = runSnap.data() as Record<string, unknown>;
    const target = resolveWorkspaceReviewTarget({
      requestedWorkspaceId: args.workspaceId,
      hasWorkspaceIdField: "workspaceId" in run,
      workspaceIdValue: run.workspaceId,
      userId: run.userId,
      hasProjectIdField: "projectId" in run,
      projectIdValue: run.projectId,
    });
    if (target.kind !== "valid_workspace_review_target") return { status: "not_found" };
    const parsed = parseReportReviewRecord(run.reportReview);
    if (!parsed.ok) return { status: "not_found" };
    if (run.governanceRecord !== undefined && run.governanceRecord !== null) return { status: "integrity_violation" };

    const [assignmentSnap, cyclesSnap] = await Promise.all([runRef.collection("humanReviewAssignment").doc("current").get(), runRef.collection(REPORT_REVIEW_CYCLES_COLLECTION).get()]);
    const assignment = assignmentSnap.exists ? (assignmentSnap.data() as { assignedReviewerUserId?: unknown; revision?: unknown; cycle?: unknown }) : null;
    const reviewer = { uid: args.uid, workspaceId: access.membership.workspaceId, role: access.membership.role, status: access.membership.status };
    const authority = evaluateReportReviewDecisionAuthority({ reviewer, workspaceId: args.workspaceId, creatorUid: target.creatorUid, record: parsed.record, assignment });

    const previousCycles: ReportReviewCycleSummary[] = cyclesSnap.docs
      .map((d) => d.data() as { cycle?: unknown; record?: Record<string, unknown>; assignment?: Record<string, unknown> | null })
      .filter((a) => typeof a.cycle === "number" && a.record)
      .map((a) => {
        const hr = (a.record!.humanReview ?? {}) as Record<string, unknown>;
        const purpose = (a.record!.purpose ?? {}) as Record<string, unknown>;
        return {
          cycle: a.cycle as number,
          status: typeof hr.status === "string" ? hr.status : "unknown",
          reviewerId: typeof hr.reviewerId === "string" ? hr.reviewerId : null,
          reviewedAt: typeof hr.reviewedAt === "string" ? hr.reviewedAt : null,
          purposeCode: typeof purpose.code === "string" ? purpose.code : "unknown",
          assignedReviewerUserId: typeof a.assignment?.assignedReviewerUserId === "string" ? (a.assignment.assignedReviewerUserId as string) : null,
        };
      })
      .sort((x, y) => x.cycle - y.cycle);

    return {
      status: "ok",
      record: parsed.record,
      previousCycles,
      assignment: { assignedReviewerUserId: typeof assignment?.assignedReviewerUserId === "string" ? assignment.assignedReviewerUserId : null, revision: typeof assignment?.revision === "number" ? assignment.revision : 0 },
      viewer: authority.authorized ? { canDecide: true, denial: null } : { canDecide: false, denial: authority.reason },
      disclaimer: REPORT_REVIEW_DISCLAIMER,
    };
  } catch (err) {
    logger.warn("[workspaces/reportReviewContext] read failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}
