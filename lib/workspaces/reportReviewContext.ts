/**
 * Order B, Stage B2/B3 — read-only Report Review context for the Team research page.
 *
 * Authorization mirrors the Approval Queue read: Team Workspace access with research.read AND reviews.read, and the
 * run bound to THIS Workspace; every denial is the concealed not-found. The viewer's abilities are computed by the SAME
 * rules the server mutations enforce, so the UI can never offer an action the server would refuse, or hide one it would
 * accept:
 *   - canDecide:            evaluateReportReviewDecisionAuthority (the B2 decision contract) + the panel gate;
 *   - canSubmit/Resubmit:   research.organize AND research.read (D-B3a) + evaluateReportReviewEligibility + panel gate;
 *   - canManageAssignment:  reviews.manage AND research.read, while the cycle is open.
 * These verdicts are presentation only: every mutation re-authorizes inside its own transaction.
 *
 * B3 additions: the not-yet-submitted state (eligibility and its reason, so the page can explain why submission is
 * unavailable), display names for every uid (resolved server-side), the assignment in the shape the shared reviewer
 * assignment card uses, and the run's write-once event history. Previous cycles come from the write-once archives.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isReportReviewEnabledForWorkspace } from "./reportReviewActivation";
import { resolveWorkspaceAccess } from "./resolveWorkspaceAccess";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { REPORT_REVIEW_CYCLES_COLLECTION, REPORT_REVIEW_EVENTS_COLLECTION } from "./reportReviewCollections";
import { roleHasCapability } from "./capabilities";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { isValidAssignmentTarget, type WorkspaceReviewCandidate } from "./workspaceReviewEligibility";
import { resolveWorkspaceReviewerDisplayNames } from "./workspaceReviewerIdentity";
import { REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";
import {
  compareReportReviewScope,
  type ReportReviewAnalysis,
  evaluateReportReviewEligibility,
  isReportReviewDecided,
  parseReportReviewRecord,
  REPORT_REVIEW_DISCLAIMER,
  type ReportReviewIneligibleReason,
  type ReportReviewRecordV1,
} from "@/lib/governance/reportReview";
import { evaluateReportReviewDecisionAuthority, type ReportReviewDecisionDenial } from "@/lib/governance/reportReviewDecision";
import { parseAdaptiveHumanReviewPanel } from "@/lib/governance/adaptiveHumanReviewPanel";

/** Bounded: a run's history is a handful of events per cycle; the newest 200 are returned. */
export const REPORT_REVIEW_HISTORY_LIMIT = 200;

export interface ReportReviewCycleSummary {
  cycle: number;
  status: string;
  reviewerId: string | null;
  reviewedAt: string | null;
  purposeCode: string;
  assignedReviewerUserId: string | null;
}

export interface ReportReviewHistoryItem {
  type: "report_review_submitted" | "report_review_resubmitted" | "report_review_assignment_changed" | "report_review_decided";
  at: string;
  actorDisplayName: string;
  cycle: number;
  status?: string;
  purposeCode?: string;
  previousReviewerDisplayName?: string | null;
  reviewerDisplayName?: string | null;
}

export interface ReportReviewAssignmentInfo {
  assignedReviewerUserId: string;
  assignedReviewerDisplayName: string;
  revision: number;
  assignedAt: string | null;
  updatedAt: string;
  dueAt: string | null;
  state: "actionable" | "stale";
}

type PanelDenial = "active_panel" | "panel_unreadable";

export type ReportReviewContextResult =
  | {
      status: "ok";
      record: ReportReviewRecordV1;
      previousCycles: ReportReviewCycleSummary[];
      assignment: { assignedReviewerUserId: string | null; revision: number; info: ReportReviewAssignmentInfo | null };
      viewer: { canDecide: boolean; denial: ReportReviewDecisionDenial | PanelDenial | null; canResubmit: boolean; canManageAssignment: boolean };
      names: Record<string, string>;
      history: ReportReviewHistoryItem[];
      /** Review M-2: analyses absent from the run now, and analyses saved after this cycle was submitted (not reviewed). */
      content: { absentNow: ReportReviewAnalysis[]; changedSinceSubmission: ReportReviewAnalysis[] };
      /** Review n-1: an archived cycle could not be read, so the cycle history shown is incomplete (never silently). */
      historyIncomplete: boolean;
      disclaimer: string;
    }
  | {
      status: "not_submitted";
      eligibility: { eligible: true } | { eligible: false; reason: ReportReviewIneligibleReason | PanelDenial };
      viewer: { canSubmit: boolean };
      disclaimer: string;
    }
  | { status: "not_found" }
  | { status: "integrity_violation" }
  | { status: "read_failed" };

const HISTORY_TYPES: ReadonlySet<string> = new Set(["report_review_submitted", "report_review_resubmitted", "report_review_assignment_changed", "report_review_decided"]);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export async function getReportReviewContext(args: { uid: string; workspaceId: string; runId: string }): Promise<ReportReviewContextResult> {
  if (!isReportReviewEnabledForWorkspace(args.workspaceId) || !adminDb) return { status: "not_found" };
  const access = await resolveWorkspaceAccess({ uid: args.uid, workspaceId: args.workspaceId });
  if (!access.granted || access.workspaceType !== "team") return { status: "not_found" };
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) return { status: "not_found" };
  const role = access.membership.role;
  const mayOrganize = roleHasCapability(role, "research.organize") && roleHasCapability(role, "research.read");
  try {
    const db = adminDb;
    const runRef = db.collection("runs").doc(args.runId);
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
    // B1 invariant: a run never holds both records. Fail closed rather than present either.
    if (run.governanceRecord !== undefined && run.governanceRecord !== null && run.reportReview !== undefined && run.reportReview !== null) return { status: "integrity_violation" };

    // The same panel gate the mutations apply (readPanelGate), so every verdict below matches the server.
    const panelSnap = await runRef.collection("humanReviewPanel").doc("current").get();
    const panel = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, { expectedRunId: args.runId });
    const panelDenial: PanelDenial | null = panel.status === "absent" ? null : panel.status === "valid" ? (panel.panel.status === "open" ? "active_panel" : null) : "panel_unreadable";

    const parsed = parseReportReviewRecord(run.reportReview);
    if (!parsed.ok) {
      if (parsed.reason === "malformed") return { status: "not_found" };
      // Not submitted yet: say whether it can be, and why not. The reader is already authorized to read this run.
      const eligibility = evaluateReportReviewEligibility(run);
      const verdict = !eligibility.eligible ? { eligible: false as const, reason: eligibility.reason } : panelDenial ? { eligible: false as const, reason: panelDenial } : { eligible: true as const };
      return { status: "not_submitted", eligibility: verdict, viewer: { canSubmit: verdict.eligible && mayOrganize }, disclaimer: REPORT_REVIEW_DISCLAIMER };
    }
    const record = parsed.record;

    const [assignmentSnap, cyclesSnap, eventsSnap] = await Promise.all([
      runRef.collection("humanReviewAssignment").doc("current").get(),
      runRef.collection(REPORT_REVIEW_CYCLES_COLLECTION).get(),
      runRef.collection(REPORT_REVIEW_EVENTS_COLLECTION).orderBy("at", "desc").limit(REPORT_REVIEW_HISTORY_LIMIT).get(),
    ]);
    const assignment = assignmentSnap.exists ? (assignmentSnap.data() as Record<string, unknown>) : null;
    const reviewer: WorkspaceReviewCandidate = { uid: args.uid, workspaceId: access.membership.workspaceId, role, status: access.membership.status };
    const authority = evaluateReportReviewDecisionAuthority({ reviewer, workspaceId: args.workspaceId, creatorUid: target.creatorUid, record, assignment });

    const archives = cyclesSnap.docs.map((d) => d.data() as { cycle?: unknown; record?: Record<string, unknown>; assignment?: Record<string, unknown> | null });
    const readable = archives.filter((a) => typeof a.cycle === "number" && a.record);
    // Complete only when every archive is a valid record and the cycles are exactly 1..n-1 (the export's own rule).
    const validCycles = archives
      .filter((a) => typeof a.cycle === "number" && (() => {
        const r = parseReportReviewRecord(a.record);
        return r.ok && r.record.cycle === a.cycle;
      })())
      .map((a) => a.cycle as number)
      .sort((x, y) => x - y);
    const historyIncomplete = archives.length !== record.cycle - 1 || validCycles.length !== archives.length || validCycles.some((c, i) => c !== i + 1);
    const previousCycles: ReportReviewCycleSummary[] = readable
      .map((a) => {
        const hr = (a.record!.humanReview ?? {}) as Record<string, unknown>;
        const purpose = (a.record!.purpose ?? {}) as Record<string, unknown>;
        return {
          cycle: a.cycle as number,
          status: typeof hr.status === "string" ? hr.status : "unknown",
          reviewerId: str(hr.reviewerId),
          reviewedAt: str(hr.reviewedAt),
          purposeCode: typeof purpose.code === "string" ? purpose.code : "unknown",
          assignedReviewerUserId: str(a.assignment?.assignedReviewerUserId),
        };
      })
      .sort((x, y) => x.cycle - y.cycle);

    const rawEvents = eventsSnap.docs.map((d) => d.data() as Record<string, unknown>).filter((e) => typeof e.type === "string" && HISTORY_TYPES.has(e.type) && typeof e.at === "string");

    // Every uid this response mentions, resolved once, server-side (membership-gated, like every Workspace label).
    const assignedUid = str(assignment?.assignedReviewerUserId);
    const uids = new Set<string>([record.submittedByUserId]);
    if (record.humanReview.reviewerId) uids.add(record.humanReview.reviewerId);
    if (assignedUid) uids.add(assignedUid);
    for (const c of previousCycles) {
      if (c.reviewerId) uids.add(c.reviewerId);
      if (c.assignedReviewerUserId) uids.add(c.assignedReviewerUserId);
    }
    for (const e of rawEvents) for (const k of ["actorUid", "previousReviewerUserId", "newReviewerUserId"]) if (str(e[k])) uids.add(e[k] as string);
    const nameMap = await resolveWorkspaceReviewerDisplayNames(args.workspaceId, Array.from(uids));
    const nameOf = (u: string | null) => (u === null ? null : (nameMap.get(u) ?? REVIEWER_UNAVAILABLE_LABEL));
    const names: Record<string, string> = {};
    for (const u of uids) names[u] = nameOf(u)!;

    const history: ReportReviewHistoryItem[] = rawEvents
      .map((e) => {
        const item: ReportReviewHistoryItem = {
          type: e.type as ReportReviewHistoryItem["type"],
          at: e.at as string,
          actorDisplayName: nameOf(str(e.actorUid)) ?? REVIEWER_UNAVAILABLE_LABEL,
          cycle: typeof e.cycle === "number" ? e.cycle : typeof e.toCycle === "number" ? e.toCycle : record.cycle,
        };
        if (e.type === "report_review_decided" && typeof e.status === "string") item.status = e.status;
        if (typeof e.purposeCode === "string") item.purposeCode = e.purposeCode;
        if (e.type === "report_review_assignment_changed") {
          item.previousReviewerDisplayName = nameOf(str(e.previousReviewerUserId));
          item.reviewerDisplayName = nameOf(str(e.newReviewerUserId));
        }
        return item;
      })
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    // The assignment in the shape the shared reviewer-assignment card renders; stale when the reviewer could no longer
    // be assigned (removed, role changed, or the submitter, whom the B2 guard never lets decide).
    let info: ReportReviewAssignmentInfo | null = null;
    if (assignedUid) {
      const membershipSnap = await db.collection("workspaceMemberships").doc(computeMembershipId(args.workspaceId, assignedUid)).get();
      const m = membershipSnap.exists ? validateMembershipBinding(membershipSnap.data(), { workspaceId: args.workspaceId, uid: assignedUid }) : null;
      const candidate: WorkspaceReviewCandidate | null = m ? { uid: m.uid, workspaceId: m.workspaceId, role: m.role, status: m.status } : null;
      const eligible = isValidAssignmentTarget({ candidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid }).eligible && assignedUid !== record.submittedByUserId;
      info = {
        assignedReviewerUserId: assignedUid,
        assignedReviewerDisplayName: names[assignedUid],
        revision: typeof assignment?.revision === "number" ? assignment.revision : 0,
        assignedAt: str(assignment?.assignedAt),
        updatedAt: str(assignment?.updatedAt) ?? record.updatedAt,
        dueAt: str(assignment?.dueAt),
        state: eligible ? "actionable" : "stale",
      };
    }

    const decided = isReportReviewDecided(record);
    const { reportReview: _omit, ...withoutRecord } = run;
    void _omit;
    const canResubmit = decided && mayOrganize && panelDenial === null && evaluateReportReviewEligibility(withoutRecord).eligible;
    const canManageAssignment = !decided && roleHasCapability(role, "reviews.manage") && roleHasCapability(role, "research.read") && panelDenial === null;

    return {
      status: "ok",
      record,
      previousCycles,
      assignment: { assignedReviewerUserId: assignedUid, revision: typeof assignment?.revision === "number" ? assignment.revision : 0, info },
      viewer: {
        ...(panelDenial ? { canDecide: false, denial: panelDenial } : authority.authorized ? { canDecide: true, denial: null } : { canDecide: false, denial: authority.reason }),
        canResubmit,
        canManageAssignment,
      },
      names,
      history,
      content: (({ absentNow, changedSinceSubmission }) => ({ absentNow, changedSinceSubmission }))(compareReportReviewScope(record.scope, run, record.submittedAt)),
      historyIncomplete,
      disclaimer: REPORT_REVIEW_DISCLAIMER,
    };
  } catch (err) {
    logger.warn("[workspaces/reportReviewContext] read failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}
