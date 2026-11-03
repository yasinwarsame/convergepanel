/**
 * Order B, Stage B3 — REAL Firestore semantics for the Workspace Audit rows, the page context and the record export,
 * through the real firebase-admin SDK against the emulator. Skipped unless FIRESTORE_EMULATOR_HOST is set.
 *
 *   java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar --host=127.0.0.1 --port=8187 &
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 GCLOUD_PROJECT=demo-b3 npx jest --runTestsByPath <this file>
 *
 * Proves under real transactions: concurrent identical submissions / decisions commit exactly ONE audit row; the Audit
 * Log reader's query, ordering and cursor run on the real SDK; the context's history query is legal; and the export
 * reads real archives. (The emulator does not enforce composite indexes — those are declared in firestore.indexes.json
 * and verified separately after deployment.)
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-b3";

jest.mock("@/lib/firebase/admin", () => {
  const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
  const { getFirestore } = jest.requireActual("firebase-admin/firestore");
  const app = getApps().find((a: { name: string }) => a.name === "b3-emulator") ?? initializeApp({ projectId: "demo-b3" }, "b3-emulator");
  const mockDb = getFirestore(app);
  return {
    get adminDb() {
      return mockDb;
    },
  };
});
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true, REPORT_REVIEW_WORKSPACE_ALLOWLIST: ["wsQueue"] }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
const mockIdentity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => ({ status: "authenticated", uid: mockIdentity.uid, source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { listWorkspaceAuditEvents } from "@/lib/workspaces/listWorkspaceAuditEvents";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { GET as exportGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route";
import { seedDb, W, OWNER, REVIEWER, SUBMITTER, CREATOR } from "./helpers/reviewQueueScenario";

const maybe = EMULATOR ? describe : describe.skip;
const db = adminDb!;
const RUN = "rr-b3";

async function clear() {
  await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}
async function auditRows(eventType?: string) {
  const snap = await db.collection("workspaceMembershipEvents").where("workspaceId", "==", W).get();
  return snap.docs.map((d) => d.data()).filter((r) => !eventType || r.eventType === eventType);
}

maybe("REAL Firestore: Workspace Audit rows, context and export", () => {
  beforeEach(async () => {
    await clear();
    await seedDb(db as never, []);
    await db.collection("runs").doc(RUN).set({
      userId: CREATOR,
      workspaceId: W,
      projectId: null,
      question: "Emulator question",
      selectedModels: ["chatgpt"],
      status: "complete",
      createdAt: Timestamp.fromMillis(Date.UTC(2026, 10, 2)),
      runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "Saved answer", wasTruncated: false }] },
      legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: {}, generatedAt: "x", results: [], alignedClaims: [] },
    });
  }, 60_000);

  it("5 simultaneous submissions: exactly one record, one run event and ONE audit row", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => submitReportReview({ uid: SUBMITTER, workspaceId: W, runId: RUN, purpose: { code: "internal_review" } })));
    expect(rs.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(await auditRows("workspace_report_review_submitted")).toHaveLength(1);
    expect((await db.collection("runs").doc(RUN).collection("reportReviewEvents").get()).size).toBe(1);
  }, 60_000);

  it("5 simultaneous decisions: exactly one decision and ONE decided audit row, matching the committed status", async () => {
    const sub = await submitReportReview({ uid: SUBMITTER, workspaceId: W, runId: RUN, purpose: { code: "internal_review" } });
    if (!sub.ok) throw new Error("submit");
    expect((await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
    const statuses = ["approved", "rejected", "changes_requested", "approved", "rejected"];
    const rs = await Promise.all(statuses.map((status) => decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status }, expectedCycle: 1, expectedUpdatedAt: sub.record.updatedAt })));
    const committed = rs.filter((r) => r.ok && !r.replayed) as { record: { humanReview: { status: string } } }[];
    expect(committed).toHaveLength(1);
    const decided = await auditRows("workspace_report_review_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0].status).toBe(committed[0].record.humanReview.status);
    expect(await auditRows("workspace_report_review_reviewer_changed")).toHaveLength(1);
  }, 60_000);

  it("Audit Log reader (real query, ordering, cursor), context history query, and the export over real archives", async () => {
    await submitReportReview({ uid: SUBMITTER, workspaceId: W, runId: RUN, purpose: { code: "client_delivery" }, now: "2026-11-02T11:00:00.000Z" });
    await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" });
    let rec = (await db.collection("runs").doc(RUN).get()).data()!.reportReview;
    await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "changes_requested" }, expectedCycle: 1, expectedUpdatedAt: rec.updatedAt, now: "2026-11-02T12:00:00.000Z" });
    await resubmitReportReview({ uid: SUBMITTER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" });

    const page1 = await listWorkspaceAuditEvents({ workspaceId: W, limit: 2 });
    if (page1.status !== "ok") throw new Error(page1.status);
    const page2 = await listWorkspaceAuditEvents({ workspaceId: W, limit: 2, cursorRaw: page1.nextCursor });
    if (page2.status !== "ok") throw new Error(page2.status);
    expect([...page1.items, ...page2.items].map((i) => i.eventType)).toEqual([
      "workspace_report_review_resubmitted",
      "workspace_report_review_decided",
      "workspace_report_review_reviewer_changed",
      "workspace_report_review_submitted",
    ]);
    expect(page2.hasMore).toBe(false);

    const ctx = await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN });
    if (ctx.status !== "ok") throw new Error(ctx.status);
    expect(ctx.history.map((h) => h.type)).toEqual(["report_review_submitted", "report_review_assignment_changed", "report_review_decided", "report_review_resubmitted"]);
    expect(ctx.previousCycles.map((c) => [c.cycle, c.status])).toEqual([[1, "changes_requested"]]);

    rec = (await db.collection("runs").doc(RUN).get()).data()!.reportReview;
    expect(rec.cycle).toBe(2);
    mockIdentity.uid = OWNER;
    const res = await exportGet(new NextRequest(`http://localhost/api/workspaces/${W}/runs/${RUN}/report-review/export?format=json`), { params: { workspaceId: W, runId: RUN } });
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.decisionHistory.map((c: { cycle: number; status: string }) => [c.cycle, c.status])).toEqual([
      [1, "changes_requested"],
      [2, "unreviewed"],
    ]);
    expect(doc.research.responses[0].rawText).toBe("Saved answer");
  }, 60_000);
});
