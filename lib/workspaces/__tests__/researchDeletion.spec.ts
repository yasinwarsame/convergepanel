/**
 * Owner Order A / S1 — reviewed-content snapshots and the durable research-deletion workflow.
 *
 * Snapshot: written once per cycle in the submission transaction; exported only after re-verification (binding + digest);
 * never a second, undeletable copy. Deletion: every supported path (admin DELETE, bulk purge) removes the run's whole
 * subtree (snapshots, cycles, events, exports, review documents), redacts research text copied into audit records (rows
 * kept as metadata), deletes derived projections, verifies, and only then reports success; interrupted or partially
 * failed deletions are reported incomplete and are safely retryable; concurrent review operations are refused once
 * deletion has started.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true, REPORT_REVIEW_WORKSPACE_ALLOWLIST: ["wsDel"] }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
const identity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => ({ status: "authenticated", uid: identity.uid, source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));
jest.mock("@/lib/firebase/auth-helpers", () => ({ ...jest.requireActual("@/lib/firebase/auth-helpers"), requireSystemAdminAccess: async () => ({ uid: "uid-sysadmin" }) }));

import { NextRequest } from "next/server";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { listWorkspaceAuditEvents, DELETED_RESEARCH_LABEL } from "@/lib/workspaces/listWorkspaceAuditEvents";
import { deleteResearchRun, findResearchDeletionOrphans, REDACTED_ADMIN_AUDIT_QUESTION } from "@/lib/firestore/researchDeletion";
import { verifyReportReviewContentSnapshot, computeReportReviewContentFingerprint } from "@/lib/governance/reportReviewContent";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { GET as exportGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route";
import { POST as purgePost } from "@/app/api/admin/purge-runs/route";
import { DELETE as adminDelete } from "@/app/api/admin/runs/[runId]/route";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";

const W = "wsDel";
const W2 = "wsDelOther";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const REVIEWER = "uid-reviewer";
const CREATOR = "uid-creator";
const OLD = Timestamp.fromDate(new Date("2026-01-02T10:00:00Z"));
const RUN = "runDel";
const SECRET_Q = "SECRET-QUESTION about Acme's merger";
const SECRET_A = "SECRET-ANSWER text";

function membership(ws: string, uid: string, role: string) {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: OLD, updatedAt: OLD, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
function seedRun(id: string, extra: Record<string, unknown> = {}) {
  db.seed(`runs/${id}`, {
    userId: CREATOR,
    workspaceId: W,
    projectId: null,
    question: SECRET_Q,
    selectedModels: ["chatgpt"],
    status: "complete",
    createdAt: OLD,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: SECRET_A, wasTruncated: false }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "x", results: [], alignedClaims: [] },
    ...extra,
  });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  identity.uid = OWNER;
  for (const ws of [W, W2]) {
    db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: ws, ownerUserId: OWNER, createdByUserId: OWNER, createdAt: OLD, updatedAt: OLD });
    for (const [u, r] of [[OWNER, "owner"], [ADMIN, "admin"], [MEMBER, "member"], [REVIEWER, "reviewer"], [CREATOR, "member"]]) membership(ws, u, r);
  }
  seedRun(RUN);
});

const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1;
const under = (prefix: string) => db.paths(prefix);
async function reviewedRun() {
  const s = await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "client_delivery", note: "note" }, now: "2026-11-02T11:00:00.000Z" });
  if (!s.ok) throw new Error(`submit ${s.reason}`);
  await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" });
  const d = await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "changes_requested", comment: "PRIVATE reviewer comment" }, expectedCycle: 1, expectedUpdatedAt: rr().updatedAt, now: "2026-11-02T12:00:00.000Z" });
  if (!d.ok) throw new Error("decide");
}
const exportJson = async (cycle?: number, ws = W) => {
  const res = await exportGet(new NextRequest(`http://localhost/api/workspaces/${ws}/runs/${RUN}/report-review/export?format=json${cycle ? `&cycle=${cycle}` : ""}`), { params: { workspaceId: ws, runId: RUN } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

describe("S1 snapshot: the exact reviewed content, write-once, verified on every read", () => {
  it("submission and resubmission each write the cycle's snapshot in the same commit as its fingerprint", async () => {
    await reviewedRun();
    const s1 = db.read(`runs/${RUN}/reportReviewSnapshots/1`)!;
    expect(verifyReportReviewContentSnapshot(s1, { runId: RUN, workspaceId: W, cycle: 1, fingerprint: rr().contentFingerprint! })).toMatchObject({ ok: true, content: { question: SECRET_Q } });
    db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, synthesizedStructuredReport: { summary: "regenerated" }, schemaVersion: 1 });
    expect((await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);
    const s2 = db.read(`runs/${RUN}/reportReviewSnapshots/2`)!;
    expect(verifyReportReviewContentSnapshot(s2, { runId: RUN, workspaceId: W, cycle: 2, fingerprint: rr().contentFingerprint! })).toMatchObject({ ok: true, content: { synthesizedStructuredReport: { summary: "regenerated" } } });
    // Cycle 1's snapshot is untouched (never rewritten by a later cycle).
    expect(db.read(`runs/${RUN}/reportReviewSnapshots/1`)).toEqual(s1);
  });

  it("an existing snapshot is never overwritten: a submission that would collide fails closed and records nothing", async () => {
    db.seed(`runs/${RUN}/reportReviewSnapshots/1`, { forged: true });
    expect(await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" } })).toEqual({ ok: false, reason: "write_failed" });
    expect(db.read(`runs/${RUN}`)!.reportReview).toBeUndefined();
    expect(db.read(`runs/${RUN}/reportReviewSnapshots/1`)).toEqual({ forged: true });
  });

  it("the export carries the verified reviewed version — still the original after the research changes; ?cycle=n exports an archived cycle's own version", async () => {
    await reviewedRun();
    db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "EDITED later", wasTruncated: false }] } });
    let e = await exportJson();
    expect(e.status).toBe(200);
    expect(e.body.review.contentIntegrity).toBe("changed");
    expect(e.body.reviewedContent.content.runDocument.perModel[0].rawTextTruncated).toBe(SECRET_A);
    expect(e.body.research.responses[0].rawText).toBe("EDITED later");
    await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" });
    e = await exportJson(1);
    expect([e.body.review.currentCycle, e.body.review.status, e.body.reviewedContent.cycle, e.body.reviewedContent.content.runDocument.perModel[0].rawTextTruncated]).toEqual([1, "changes_requested", 1, SECRET_A]);
    e = await exportJson(2);
    expect(e.body.reviewedContent.content.runDocument.perModel[0].rawTextTruncated).toBe("EDITED later");
    expect((await exportJson(9)).status).toBe(404);
  });

  it.each([
    ["tampered content", (s: Record<string, unknown>) => ({ ...s, canonical: String(s.canonical).replace("SECRET-ANSWER", "FORGED-ANSWER") })],
    ["another Workspace's binding", (s: Record<string, unknown>) => ({ ...s, workspaceId: W2 })],
    ["another cycle's number", (s: Record<string, unknown>) => ({ ...s, cycle: 2 })],
    ["missing", () => null],
  ])("a snapshot that does not verify (%s) is never exported (500, fail closed)", async (_l, mutate) => {
    await reviewedRun();
    const s = db.read(`runs/${RUN}/reportReviewSnapshots/1`)!;
    const next = mutate(s);
    if (next === null) db.docs.delete(`runs/${RUN}/reportReviewSnapshots/1`);
    else db.seed(`runs/${RUN}/reportReviewSnapshots/1`, next);
    expect((await exportJson()).status).toBe(500);
  });

  it("no snapshot is reachable through another Workspace (the export is bound to the run's own Workspace)", async () => {
    await reviewedRun();
    expect((await exportJson(undefined, W2)).status).toBe(404);
  });
});

function seedCopies(runId: string) {
  // Copies of the research outside the report-review documents that deletion must cover.
  db.seed(`runs/${runId}/exports/exp1`, { snapshot: { question: SECRET_Q }, artifactStatus: "ready" });
  db.seed(`runs/${runId}/exports/exp1/nested/x`, { text: SECRET_A });
  // A "missing" ancestor (no data of its own) holding a subcollection: a query never returns it; deletion must still reach it.
  db.seed(`runs/${runId}/exports/ghostParent/parts/p1`, { text: SECRET_A });
  db.seed(`runs/${runId}/governanceEvents/g1`, { action: "evaluated" });
  db.seed(`admin_audit_logs/a1`, { action: "admin_deleted", runId, question: SECRET_Q.slice(0, 200) });
  db.seed(`admin_audit_logs/a2`, { action: "evaluated", runId, question: SECRET_Q.slice(0, 50) });
  db.seed(`admin_audit_logs/other`, { action: "evaluated", runId: "unrelated", question: "keep me" });
  db.seed(`teamRuns/t_${runId}`, { runId, receiptConclusion: SECRET_A });
  db.seed(`workspaceMembershipEvents/ra`, { eventType: "workspace_research_assignee_changed", workspaceId: W, actorUid: ADMIN, projectId: null, projectName: null, runId, runQuestion: SECRET_Q, previousAssigneeUid: null, assigneeUid: MEMBER, at: Timestamp.fromDate(new Date("2026-11-02T10:30:00Z")) });
}
function assertNothingLeft(runId: string) {
  expect(under(`runs/${runId}`)).toEqual([]);
  // Nothing that belongs to, or refers to, the deleted run still carries its research text.
  const related = Array.from(db.docs.entries()).filter(([p, s]) => !p.startsWith("runDeletionJobs/") && (p.startsWith(`runs/${runId}/`) || (s.data as Record<string, unknown>).runId === runId));
  expect(JSON.stringify(related)).not.toContain("SECRET-");
  if (db.read("admin_audit_logs/other")) expect(db.read("admin_audit_logs/other")!.question).toBe("keep me"); // unrelated rows untouched
  expect(db.read(`runDeletionJobs/${runId}`)).toMatchObject({ state: "complete" });
}

describe("S1 deletion: every supported path removes the research and every derived copy, verified", () => {
  it("admin deletion: the whole subtree, research text redacted from kept audit rows, projections deleted, job complete", async () => {
    await reviewedRun();
    seedCopies(RUN);
    expect(under(`runs/${RUN}/reportReview`).length).toBeGreaterThan(0);
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toEqual({ status: "deleted", runId: RUN, attempts: 1 });
    assertNothingLeft(RUN);
    expect(db.read("admin_audit_logs/a1")).toMatchObject({ action: "admin_deleted", runId: RUN, question: REDACTED_ADMIN_AUDIT_QUESTION, contentRedacted: true });
    expect(db.read("teamRuns/t_runDel")).toBeUndefined();
  });

  it("Workspace Audit Log after deletion: every row is still visible as evidence, with the research text replaced by a fixed label", async () => {
    await reviewedRun();
    seedCopies(RUN);
    const before = await listWorkspaceAuditEvents({ workspaceId: W, limit: 50 });
    await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" });
    const after = await listWorkspaceAuditEvents({ workspaceId: W, limit: 50 });
    if (before.status !== "ok" || after.status !== "ok") throw new Error("audit");
    expect(after.items.map((i) => i.eventType)).toEqual(before.items.map((i) => i.eventType)); // nothing dropped
    expect(after.items.length).toBeGreaterThanOrEqual(4);
    for (const i of after.items) expect((i as { research: { question: unknown } }).research.question).toBe(DELETED_RESEARCH_LABEL);
    expect(JSON.stringify(after.items)).not.toContain("SECRET-");
  });

  it("bulk purge: each matched run goes through the durable workflow; the response reports exactly what was deleted", async () => {
    await reviewedRun();
    seedCopies(RUN);
    seedRun("runDel2");
    const res = await purgePost(new NextRequest("http://localhost/api/admin/purge-runs", { method: "POST", body: JSON.stringify({ mode: "olderThan", days: 30, dryRun: false, confirmation: "DELETE" }), headers: { "content-type": "application/json" } }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect([body.deletedCount, body.errorsCount, body.incompleteRunIds]).toEqual([2, 0, undefined]);
    assertNothingLeft(RUN);
    expect(under("runs/runDel2")).toEqual([]);
  });

  it("interrupted deletion (failure before the run document is removed): reported incomplete, nothing claimed; retry completes", async () => {
    await reviewedRun();
    seedCopies(RUN);
    db.hooks = {
      failWrite: (w) => {
        if (w.kind === "delete" && w.path === `runs/${RUN}`) throw new Error("UNAVAILABLE");
      },
    };
    const first = await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" });
    expect(first).toMatchObject({ status: "incomplete", step: "run" });
    expect(db.read(`runDeletionJobs/${RUN}`)).toMatchObject({ state: "failed", step: "run" });
    // While incomplete, the run is marked: no report-review operation can act on it.
    expect(db.read(`runs/${RUN}`)!.deletion).toMatchObject({ state: "pending" });
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN })).toEqual({ status: "not_found" });
    db.hooks = {};
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toEqual({ status: "deleted", runId: RUN, attempts: 2 });
    assertNothingLeft(RUN);
  });

  it.each([
    ["a subtree document", (p: string) => p.startsWith(`runs/${RUN}/reportReviewSnapshots/`), "subtree"],
    ["an audit redaction", (p: string) => p.startsWith("workspaceMembershipEvents/"), "workspace_audit"],
    ["an admin-audit redaction", (p: string) => p.startsWith("admin_audit_logs/"), "admin_audit"],
    ["a projection deletion", (p: string) => p.startsWith("teamRuns/"), "team_projection"],
  ])("partial storage failure on %s: incomplete at that step, the run document is NOT deleted, retry completes", async (_l, match, step) => {
    await reviewedRun();
    seedCopies(RUN);
    db.hooks = {
      failWrite: (w) => {
        if (match(w.path) && w.kind !== "create") throw new Error("DEADLINE_EXCEEDED");
      },
    };
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toMatchObject({ status: "incomplete", step });
    expect(db.read(`runs/${RUN}`)).toBeDefined(); // never deleted before every copy is handled
    db.hooks = {};
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    assertNothingLeft(RUN);
  });

  it("verification gate: a copy that still carries research text at the end makes the deletion incomplete (never a false success)", async () => {
    await reviewedRun();
    db.hooks = {
      failWrite: (w) => {
        // A derived copy appearing between the pre-check and the end (projections are not re-swept after the run is gone).
        if (w.kind === "delete" && w.path === `runs/${RUN}`) db.seed(`teamRuns/late_${RUN}`, { runId: RUN, receiptConclusion: SECRET_A });
      },
    };
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toMatchObject({ status: "incomplete", step: "verify" });
    db.hooks = {};
    // The run document is already gone: the deletion is still resumable by runId (review S1-M-1).
    expect(db.read(`runs/${RUN}`)).toBeUndefined();
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    assertNothingLeft(RUN);
  });

  it("a late audit row written while the run was being deleted is still redacted (post-deletion sweep)", async () => {
    await reviewedRun();
    db.hooks = {
      failWrite: (w) => {
        if (w.kind === "delete" && w.path === `runs/${RUN}`) db.seed("workspaceMembershipEvents/late", { eventType: "workspace_research_assignee_changed", workspaceId: W, runId: RUN, runQuestion: SECRET_Q, at: Timestamp.now() });
      },
    };
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    expect(db.read("workspaceMembershipEvents/late")).toMatchObject({ runQuestion: null, contentRedacted: true });
  });

  it("admin audit free text (question, comment, reasons, justification) is redacted; metadata is kept (review S1-M-2)", async () => {
    await reviewedRun();
    const R = REDACTED_ADMIN_AUDIT_QUESTION;
    db.seed("admin_audit_logs/rev", { action: "approved", runId: RUN, question: SECRET_Q, comment: "SECRET-COMMENT", reasons: ["SECRET-REASON"], justification: "SECRET-JUST", overrideJustification: "SECRET-OJ", note: "SECRET-N", notes: ["SECRET-NS"], byUid: REVIEWER, at: "t" });
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    expect(db.read("admin_audit_logs/rev")).toEqual({ action: "approved", runId: RUN, question: R, comment: R, reasons: R, justification: R, overrideJustification: R, note: R, notes: R, byUid: REVIEWER, at: "t", contentRedacted: true });
  });

  it("snapshot locks naming the deleted run are removed (re-adding the source research is not blocked) (review S1-m-2)", async () => {
    db.seed("runSnapshotLocks/l1", { snapshotRunId: RUN, sourceRunId: "personal-1" });
    db.seed("runSnapshotLocks/l2", { snapshotRunId: "other", sourceRunId: "personal-2" });
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    expect([db.read("runSnapshotLocks/l1"), db.read("runSnapshotLocks/l2")]).toEqual([undefined, { snapshotRunId: "other", sourceRunId: "personal-2" }]);
  });

  it.each([
    ["the run document alone", () => db.seed(`runs/${RUN}`, { adaptiveExportCounter: 1 })],
    ["a subtree document alone (run document absent)", () => db.seed(`runs/${RUN}/exports/late`, { reportSnapshot: { question: SECRET_Q } })],
    ["a Workspace Audit row with research text", () => db.seed("workspaceMembershipEvents/lateRa", { eventType: "workspace_research_assignee_changed", workspaceId: W, runId: RUN, runQuestion: SECRET_Q, at: Timestamp.now() })],
    ["an admin audit row with a reviewer comment", () => db.seed("admin_audit_logs/lateGov", { action: "approved", runId: RUN, comment: "SECRET-COMMENT" })],
  ])("content recreated after a completed deletion (%s) is detected, and the admin DELETE re-runs the deletion", async (_l, recreate) => {
    await reviewedRun();
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    expect((await findResearchDeletionOrphans()).orphanRunIds).toEqual([]);
    recreate();
    expect((await findResearchDeletionOrphans()).orphanRunIds).toEqual([RUN]);
    if (!db.read(`runs/${RUN}`)) {
      const res = await adminDelete(new NextRequest(`http://localhost/api/admin/runs/${RUN}?collection=runs`, { method: "DELETE", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } }), { params: { runId: RUN } } as never);
      expect(res.status).toBe(200);
    } else {
      expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    }
    expect((await findResearchDeletionOrphans()).orphanRunIds).toEqual([]);
    assertNothingLeft(RUN);
  });

  it("purge resumes unfinished deletion jobs (including runs whose document is already gone)", async () => {
    await reviewedRun();
    db.hooks = { failWrite: (w) => { if (w.kind === "delete" && w.path === `runs/${RUN}`) db.seed(`teamRuns/late_${RUN}`, { runId: RUN }); } };
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("incomplete");
    db.hooks = {};
    const res = await purgePost(new NextRequest("http://localhost/api/admin/purge-runs", { method: "POST", body: JSON.stringify({ mode: "olderThan", days: 30, dryRun: false, confirmation: "DELETE" }), headers: { "content-type": "application/json" } }));
    const body = await res.json();
    expect(body.errorsCount).toBe(0);
    expect(db.read(`runDeletionJobs/${RUN}`)).toMatchObject({ state: "complete" });
    expect(db.read(`teamRuns/late_${RUN}`)).toBeUndefined();
  });

  it("concurrent review and deletion: once deletion has started, submit, decide, assign, context and export all refuse; a decision racing the mark retries and refuses", async () => {
    await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, now: "2026-11-02T11:00:00.000Z" });
    await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null });
    // Race: the deletion mark commits while the decision transaction is in flight.
    let fired = false;
    db.hooks = {
      afterTxReads: () => {
        if (fired) return;
        fired = true;
        db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, deletion: { state: "pending", requestedAt: "t" } });
      },
    };
    expect(await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: rr().updatedAt })).toEqual({ ok: false, reason: "run_not_found" });
    db.hooks = {};
    expect(rr().humanReview.status).toBe("unreviewed");
    expect(await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1 })).toEqual({ ok: false, reason: "run_not_found" });
    expect((await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: OWNER, expectedRevision: 1, dueAt: null })).ok).toBe(false);
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN })).toEqual({ status: "not_found" });
    expect((await exportJson()).status).toBe(404);
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    assertNothingLeft(RUN);
  });

  it("orphan detection finds documents whose run is gone and unfinished jobs; a deletion re-run clears them", async () => {
    db.seed("runs/ghost/reportReviewSnapshots/1", { canonical: SECRET_A });
    db.seed("runs/ghost/exports/e", { snapshot: SECRET_Q });
    db.seed("runDeletionJobs/stuck", { state: "failed", runId: "stuck" });
    await reviewedRun(); // a live run is never an orphan
    expect(await findResearchDeletionOrphans()).toEqual({ orphanRunIds: ["ghost"], unfinishedJobs: ["stuck"] });
    expect((await deleteResearchRun({ runId: "ghost", actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    expect((await findResearchDeletionOrphans()).orphanRunIds).toEqual([]);
  });

  it("governed run: deleted completely through the same workflow (its subtree and projections), without any report-review step failing", async () => {
    db.seed("runs/gov", { userId: CREATOR, workspaceId: W, question: SECRET_Q, status: "complete", createdAt: OLD, governanceRecord: { humanReview: { status: "approved" } } });
    db.seed("runs/gov/humanReviewAssignment/current", { assignedReviewerUserId: REVIEWER });
    seedCopies("gov");
    expect((await deleteResearchRun({ runId: "gov", actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    assertNothingLeft("gov");
  });

  it("idempotent: deleting an already-deleted run succeeds again without error and leaves the same state", async () => {
    await reviewedRun();
    await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" });
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toEqual({ status: "deleted", runId: RUN, attempts: 2 });
    assertNothingLeft(RUN);
  });

  it("archives and snapshots stay immutable in normal operation: only the deletion workflow ever removes them", async () => {
    await reviewedRun();
    await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" });
    const archive = db.read(`runs/${RUN}/reportReviewCycles/1`);
    const snap = db.read(`runs/${RUN}/reportReviewSnapshots/1`);
    await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 2, dueAt: null });
    expect([db.read(`runs/${RUN}/reportReviewCycles/1`), db.read(`runs/${RUN}/reportReviewSnapshots/1`)]).toEqual([archive, snap]);
    expect(computeReportReviewContentFingerprint({ x: 1 }).ok).toBe(true);
  });
});

describe("admin DELETE route resumes an unfinished deletion by runId (review S1-M-1)", () => {
  const del = (runId: string) => adminDelete(new NextRequest(`http://localhost/api/admin/runs/${runId}?collection=runs`, { method: "DELETE", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } }), { params: { runId } } as never);
  it("run document already gone + unfinished job → resumed and verified; no job → 404 as before", async () => {
    await reviewedRun();
    db.hooks = { failWrite: (w) => { if (w.kind === "delete" && w.path === `runs/${RUN}`) db.seed(`teamRuns/late_${RUN}`, { runId: RUN }); } };
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("incomplete");
    db.hooks = {};
    const res = await del(RUN);
    expect([res.status, await res.json()]).toEqual([200, { ok: true, deleted: RUN, resumed: true }]);
    expect(db.read(`runDeletionJobs/${RUN}`)).toMatchObject({ state: "complete" });
    expect((await del("never-existed")).status).toBe(404);
  });
});

describe("verification ordering (review S1-M-1 mutation gaps)", () => {
  it("a copy that appears before the pre-check makes the deletion incomplete while the run document is STILL present (ordinary retry)", async () => {
    await reviewedRun();
    db.seed(`teamRuns/t_${RUN}`, { runId: RUN });
    db.hooks = {
      failWrite: (w) => {
        if (w.kind === "delete" && w.path === `teamRuns/t_${RUN}`) db.seed("workspaceMembershipEvents/latePre", { eventType: "workspace_research_assignee_changed", workspaceId: W, runId: RUN, runQuestion: SECRET_Q, at: Timestamp.now() });
      },
    };
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toMatchObject({ status: "incomplete", step: "verify" });
    expect(db.read(`runs/${RUN}`)).toBeDefined(); // never removed while a copy still carries research text
    db.hooks = {};
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    assertNothingLeft(RUN);
  });

  it("a snapshot lock that reappears at the end is caught by the final verification", async () => {
    await reviewedRun();
    db.hooks = { failWrite: (w) => { if (w.kind === "delete" && w.path === `runs/${RUN}`) db.seed("runSnapshotLocks/lateLock", { snapshotRunId: RUN }); } };
    expect(await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).toMatchObject({ status: "incomplete", step: "verify" });
    db.hooks = {};
    expect((await deleteResearchRun({ runId: RUN, actorUid: "uid-sysadmin", reason: "admin_delete" })).status).toBe("deleted");
    expect(db.read("runSnapshotLocks/lateLock")).toBeUndefined();
  });
});

describe("purge scope, budget and resume reporting (review S1 confirmation MINOR-3)", () => {
  const purge = () => purgePost(new NextRequest("http://localhost/api/admin/purge-runs", { method: "POST", body: JSON.stringify({ mode: "olderThan", days: 30, dryRun: false, confirmation: "DELETE" }), headers: { "content-type": "application/json" } }));
  it("resumed earlier deletions are reported separately and never counted in this purge's deletedCount", async () => {
    db.seed("runDeletionJobs/earlier", { runId: "earlier", state: "failed", step: "verify" });
    db.seed("runs/earlier/exports/x", { snapshot: SECRET_Q });
    const body = await (await purge()).json();
    expect([body.deletedCount, body.errorsCount, body.resumedDeletedCount]).toEqual([1, 0, 1]);
    expect(under("runs/earlier")).toEqual([]);
  });
  it("time budget: once exceeded, no new deletion starts; the rest is reported as notStarted (counted as errors), never as deleted", async () => {
    for (const id of ["b1", "b2", "b3"]) seedRun(id);
    // Every clock read is 5 minutes later than the last, so the budget is already exceeded at the first check.
    let t = Date.now();
    const spy = jest.spyOn(Date, "now").mockImplementation(() => (t += 5 * 60_000));
    try {
      const body = await (await purge()).json();
      expect(body.deletedCount).toBe(0);
      expect(body.notStartedCount).toBe(4);
      expect(body.errorsCount).toBe(4);
    } finally {
      spy.mockRestore();
    }
    expect(db.read(`runs/${RUN}`)).toBeDefined();
  });
});

describe("resume is research-only", () => {
  it("a missing document in another collection never triggers the research-deletion resume", async () => {
    db.docs.delete(`runs/${RUN}`);
    db.seed(`runDeletionJobs/${RUN}`, { runId: RUN, state: "failed" }); // an unfinished RESEARCH deletion with this id exists
    const res = await adminDelete(new NextRequest(`http://localhost/api/admin/runs/${RUN}?collection=verifications`, { method: "DELETE", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } }), { params: { runId: RUN } } as never);
    expect(res.status).toBe(404);
    expect(db.read(`runDeletionJobs/${RUN}`)).toMatchObject({ state: "failed" }); // untouched: not resumed through another collection
  });
});

describe("review M-1: Workspace review writers refuse a run whose deletion has started (tombstone), in their own transaction", () => {
  it("assignment: run_not_found and nothing written with a tombstone; control: the same call succeeds without it", async () => {
    db.seed(`runDeletionJobs/${RUN}`, { runId: RUN, state: "in_progress" });
    const before = under(`runs/${RUN}/`).length;
    const r = await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null });
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "run_not_found" }));
    expect(under(`runs/${RUN}/`).length).toBe(before);
    db.docs.delete(`runDeletionJobs/${RUN}`);
    expect((await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
  });

  it("a non-member is still refused on membership first (concealment order unchanged) even when the run has a tombstone", async () => {
    db.seed(`runDeletionJobs/${RUN}`, { runId: RUN, state: "in_progress" });
    const r = await putWorkspaceReviewAssignment({ uid: "uid-stranger", workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).not.toBe("run_not_found");
  });
});
