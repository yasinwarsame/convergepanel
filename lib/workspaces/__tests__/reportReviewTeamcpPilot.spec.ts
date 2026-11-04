/**
 * TeamCP pilot (owner decision 2026-11-04) — the SHIPPED rollout configuration, NOT a mock.
 *
 * Every other report-review spec replaces `reportReviewRollout` with jest.mock and synthetic Workspace ids. This spec
 * loads the real module, so it pins what would actually ship if the pilot PR were merged:
 *   - the switch is on and the allow-list is exactly ["Aw6kbjROOaOIhCXUiKlq"] (TeamCP);
 *   - TeamCP is the only Workspace the rule admits (near-miss ids, other types and other Workspaces are refused);
 *   - malformed variants of the shipped list still fail closed;
 *   - with the real configuration, the server-side contract holds inside TeamCP for a role layout that mirrors TeamCP's
 *     live memberships (owner = creator of the eligible runs, admin, member, two reviewers, one removed member): assignment
 *     is required, the creator and the submitter cannot decide, removed members cannot participate, and capabilities are
 *     enforced on the server, while another Workspace is refused on every surface.
 * Firestore is the in-memory transactional fake; no Production data is read or written.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
// NOTE: "@/lib/workspaces/reportReviewRollout" is deliberately NOT mocked.
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  ...jest.requireActual("@/lib/governance/reviewerIdentity"),
  resolveReviewerDisplayNames: async (uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
const identity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => ({ status: "authenticated", uid: identity.uid, source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));

import { NextRequest } from "next/server";
import * as rollout from "@/lib/workspaces/reportReviewRollout";
import { evaluateReportReviewActivation, isReportReviewEnabledForWorkspace, reportReviewActivationConfig } from "@/lib/workspaces/reportReviewActivation";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { isMergedReviewQueueView } from "@/lib/workspaces/reviewQueueMode";
import { getReviewQueue } from "@/lib/workspaces/reviewQueue";
import { getReviewerCandidates } from "@/lib/workspaces/reviewerCandidates";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { buildReportReviewRecord, type ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { POST as submitPost, GET as contextGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route";
import { POST as resubmitPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/resubmit/route";
import { POST as decisionPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/decision/route";
import { GET as exportGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route";

const TEAMCP = "Aw6kbjROOaOIhCXUiKlq";
const OTHER = "wsOtherTeam";
// Role layout mirrors TeamCP's live active memberships (read-only check 2026-11-04); uids here are synthetic.
const OWNER = "uid-owner"; // owner AND creator of the eligible runs (as in TeamCP)
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const REVIEWER = "uid-reviewer";
const REVIEWER2 = "uid-reviewer2";
const REMOVED = "uid-removed"; // TeamCP has one removed membership
const RUN = "run-pilot";
const RUN_OTHER = "run-other";
const NOW = Timestamp.fromDate(new Date("2026-11-04T10:00:00Z"));

function membership(ws: string, uid: string, role: string, status = "active") {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status, createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: status === "removed" ? NOW : null, removedByUserId: status === "removed" ? OWNER : null });
}
function genericRun(id: string, ws: string) {
  db.seed(`runs/${id}`, {
    userId: OWNER,
    workspaceId: ws,
    projectId: null,
    question: "Evaluate whether remote work improves or reduces employee productivity",
    selectedModels: ["chatgpt"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "answer", wasTruncated: false }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "x", results: [], alignedClaims: [] },
  });
}
const rr = (id = RUN) => db.read(`runs/${id}`)!.reportReview as ReportReviewRecordV1 | undefined;
const params = (ws: string, run: string) => ({ params: { workspaceId: ws, runId: run } });
const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const base = (ws: string, run: string) => `http://localhost/api/workspaces/${ws}/runs/${run}/report-review`;
const submit = (uid: string, ws = TEAMCP, runId = RUN) => submitReportReview({ uid, workspaceId: ws, runId, purpose: { code: "internal_review" }, now: "2026-11-04T11:00:00.000Z" });
const assign = (actor: string, reviewer: string, expectedRevision = 0) => putWorkspaceReviewAssignment({ uid: actor, workspaceId: TEAMCP, runId: RUN, assignedReviewerUserId: reviewer, expectedRevision, dueAt: null, now: "2026-11-04T11:05:00.000Z" });
const decide = (uid: string, ws = TEAMCP, runId = RUN) =>
  decideReportReview({ uid, workspaceId: ws, runId, decision: { status: "approved", comment: "ok" }, expectedCycle: rr(runId)?.cycle ?? 1, expectedUpdatedAt: rr(runId)?.updatedAt ?? "x", now: "2026-11-04T12:00:00.000Z" });
/** A report review left in a Workspace that is not allow-listed (e.g. after a rollback). */
const leftoverRecord = () =>
  buildReportReviewRecord({ cycle: 1, scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 1, requestedModels: 1 }, purpose: { code: "internal_review", note: null }, actorUid: MEMBER, now: "2026-11-04T09:00:00.000Z" });
const reportReviewAuditRows = () =>
  db
    .paths("workspaceMembershipEvents/")
    .map((p) => db.read(p)!)
    .filter((r) => typeof r.eventType === "string" && (r.eventType as string).startsWith("workspace_report_review_"));
/** Bypasses the assignment guard, to prove the DECISION path itself refuses. */
const seedAssignment = (uid: string) =>
  db.seed(`runs/${RUN}/humanReviewAssignment/current`, { schemaVersion: 1, teamId: null, runId: RUN, assignedReviewerUserId: uid, assignedAt: "x", assignedByUserId: ADMIN, updatedAt: "x", updatedByUserId: ADMIN, revision: 1, workspaceId: TEAMCP, projectId: null, dueAt: null, cycle: 1 });

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  identity.uid = OWNER;
  for (const ws of [TEAMCP, OTHER]) {
    db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: ws === TEAMCP ? "TeamCP" : "Other", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
    membership(ws, OWNER, "owner");
    membership(ws, ADMIN, "admin");
    membership(ws, MEMBER, "member");
    membership(ws, REVIEWER, "reviewer");
    membership(ws, REVIEWER2, "reviewer");
    membership(ws, REMOVED, "member", "removed");
  }
  genericRun(RUN, TEAMCP);
  genericRun(RUN_OTHER, OTHER);
});

describe("shipped configuration (real module)", () => {
  it("is exactly: switch on, allow-list = [TeamCP]", () => {
    expect(rollout.REPORT_REVIEW_ENABLED).toBe(true);
    expect(rollout.REPORT_REVIEW_WORKSPACE_ALLOWLIST).toEqual([TEAMCP]);
    const cfg = reportReviewActivationConfig();
    if (cfg.status !== "active") throw new Error(`expected active, got ${cfg.status}`);
    expect([...cfg.workspaceIds]).toEqual([TEAMCP]);
  });

  it("admits TeamCP and nothing else", () => {
    expect(isReportReviewEnabledForWorkspace(TEAMCP)).toBe(true);
    for (const id of [OTHER, TEAMCP.toLowerCase(), TEAMCP.toUpperCase(), ` ${TEAMCP}`, `${TEAMCP} `, TEAMCP.slice(0, -1), `${TEAMCP}x`, `x${TEAMCP}`, "", "*", "teamcp", "TeamCP"]) {
      expect(isReportReviewEnabledForWorkspace(id)).toBe(false);
    }
    for (const v of [undefined, null, 0, [TEAMCP], { toString: () => TEAMCP }, new String(TEAMCP)]) expect(isReportReviewEnabledForWorkspace(v)).toBe(false);
  });

  it("malformed variants of the shipped list still fail closed (never allow-all)", () => {
    expect(evaluateReportReviewActivation(false, [TEAMCP])).toEqual({ status: "disabled" });
    expect(evaluateReportReviewActivation("true", [TEAMCP])).toEqual({ status: "disabled" });
    expect(evaluateReportReviewActivation(true, [])).toEqual({ status: "disabled" });
    for (const bad of [[TEAMCP, TEAMCP], [TEAMCP, OTHER], [`${TEAMCP}/x`], [""], TEAMCP, null, { 0: TEAMCP, length: 1 }]) {
      expect(evaluateReportReviewActivation(true, bad)).toEqual({ status: "invalid" });
    }
  });
});

describe("with the shipped configuration: TeamCP only, server-side contract unchanged", () => {
  it("another Workspace holding a report review is refused on each gated surface (the record exists, so only the gate can refuse); TeamCP works", async () => {
    // Seed a report review on the other Workspace's run, so a 404 / "disabled" there cannot come from "no record".
    db.seed(`runs/${RUN_OTHER}`, { ...db.read(`runs/${RUN_OTHER}`)!, reportReview: leftoverRecord() });
    identity.uid = MEMBER;
    expect((await submitPost(post(base(OTHER, RUN_OTHER), { purpose: { code: "internal_review" } }), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect((await resubmitPost(post(`${base(OTHER, RUN_OTHER)}/resubmit`, { purpose: { code: "internal_review" }, expectedCycle: 1 }), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect(await submit(MEMBER, OTHER, RUN_OTHER)).toEqual({ ok: false, reason: "disabled" });
    expect(await resubmitReportReview({ uid: MEMBER, workspaceId: OTHER, runId: RUN_OTHER, purpose: { code: "internal_review" }, expectedCycle: 1 })).toEqual({ ok: false, reason: "disabled" });
    expect(await decide(REVIEWER, OTHER, RUN_OTHER)).toEqual({ ok: false, reason: "disabled" });
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(base(OTHER, RUN_OTHER)), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: OTHER, runId: RUN_OTHER })).toEqual({ status: "not_found" });
    expect((await exportGet(new NextRequest(`${base(OTHER, RUN_OTHER)}/export?format=json`), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect((await decisionPost(post(`${base(OTHER, RUN_OTHER)}/decision`, { decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "x" }), params(OTHER, RUN_OTHER))).status).toBe(404);
    // Dormant run-level hooks in the other Workspace: the submitter stays an eligible candidate and is assignable
    // (the report-review submitter guard is off there), and no report-review audit row is written.
    const cands = await getReviewerCandidates({ workspaceId: OTHER, runId: RUN_OTHER });
    expect(cands.status === "ok" && cands.reviewers.map((r) => r.uid)).toContain(MEMBER);
    expect((await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: OTHER, runId: RUN_OTHER, assignedReviewerUserId: MEMBER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
    expect(reportReviewAuditRows()).toEqual([]);
    // Queue: the other Workspace uses the governed-only scan, so its report review is not listed.
    expect(isMergedReviewQueueView("needs_review", OTHER)).toBe(false);
    const qOther = await getReviewQueue({ view: "needs_review", workspaceId: OTHER, uid: OWNER, callerCandidate: { uid: OWNER, workspaceId: OTHER, role: "owner", status: "active" }, projectFilter: undefined, limit: 10, cursor: null });
    expect(qOther.status === "ok" && qOther.items.map((i) => i.runId)).toEqual([]);
    // Containment: TeamCP's route with the other Workspace's run is refused.
    expect(await submit(MEMBER, TEAMCP, RUN_OTHER)).toEqual({ ok: false, reason: "run_not_found" });

    // Positive controls in TeamCP: the same surfaces work.
    identity.uid = MEMBER;
    expect((await submitPost(post(base(TEAMCP, RUN), { purpose: { code: "internal_review" } }), params(TEAMCP, RUN))).status).toBe(201);
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(base(TEAMCP, RUN)), params(TEAMCP, RUN))).status).toBe(200);
    expect(isMergedReviewQueueView("needs_review", TEAMCP)).toBe(true);
    const qTeamcp = await getReviewQueue({ view: "needs_review", workspaceId: TEAMCP, uid: OWNER, callerCandidate: { uid: OWNER, workspaceId: TEAMCP, role: "owner", status: "active" }, projectFilter: undefined, limit: 10, cursor: null });
    expect(qTeamcp.status === "ok" && qTeamcp.items.map((i) => i.runId)).toEqual([RUN]);
    // The other Workspace's dormant hooks above are contrasted with the live ones here.
    const candsT = await getReviewerCandidates({ workspaceId: TEAMCP, runId: RUN });
    expect(candsT.status === "ok" && candsT.reviewers.map((r) => r.uid)).not.toContain(MEMBER); // submitter excluded
    expect(candsT.status === "ok" && candsT.reviewers.map((r) => r.uid)).toContain(REVIEWER);
    expect((await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: TEAMCP, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
    const rows = reportReviewAuditRows();
    expect(rows.map((r) => [r.eventType, r.workspaceId])).toEqual(expect.arrayContaining([["workspace_report_review_submitted", TEAMCP], ["workspace_report_review_reviewer_changed", TEAMCP]]));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.workspaceId === TEAMCP)).toBe(true);
    // HTTP positive controls for the routes checked as 404 on the other Workspace: none of them answers 404 in TeamCP.
    identity.uid = OWNER;
    expect((await exportGet(new NextRequest(`${base(TEAMCP, RUN)}/export?format=json`), params(TEAMCP, RUN))).status).toBe(200);
    identity.uid = MEMBER;
    expect((await resubmitPost(post(`${base(TEAMCP, RUN)}/resubmit`, { purpose: { code: "internal_review" }, expectedCycle: 1 }), params(TEAMCP, RUN))).status).not.toBe(404);
    identity.uid = REVIEWER;
    const rec = rr()!;
    expect((await decisionPost(post(`${base(TEAMCP, RUN)}/decision`, { decision: { status: "approved", comment: "ok" }, expectedCycle: rec.cycle, expectedUpdatedAt: rec.updatedAt }), params(TEAMCP, RUN))).status).toBe(200);
    expect(rr()!.humanReview.status).toBe("approved");
  });

  it("capabilities and membership are enforced server-side, with exact reasons", async () => {
    for (const uid of [REVIEWER, REVIEWER2]) expect(await submit(uid)).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(await submit(REMOVED)).toEqual({ ok: false, reason: "membership_removed" });
    expect(await submit("uid-stranger")).toEqual({ ok: false, reason: "membership_not_found" });
    expect(rr()).toBeUndefined();
    expect((await submit(MEMBER)).ok).toBe(true);
    expect(await assign(MEMBER, REVIEWER)).toEqual({ ok: false, reason: "insufficient_capability" }); // member lacks reviews.manage
    expect(await assign(REMOVED, REVIEWER)).toEqual({ ok: false, reason: "membership_removed" });
    expect(await assign(ADMIN, REMOVED)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "removed" } });
    expect(await assign(ADMIN, "uid-stranger")).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "not_found" } });
  });

  it("the reviewer must be assigned: nobody decides an unassigned review, and only the current assignee decides once assigned", async () => {
    expect((await submit(MEMBER)).ok).toBe(true); // MEMBER submits; OWNER is the creator
    for (const uid of [REVIEWER, REVIEWER2, ADMIN]) expect(await decide(uid)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    expect(await decide(OWNER)).toEqual({ ok: false, reason: "not_authorized", denial: "self_review" }); // creator
    // The unassigned submitter is refused by the assignment check first; the "submitter" denial itself is pinned below
    // with a directly seeded assignment.
    expect(await decide(MEMBER)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    expect(rr()!.humanReview.status).toBe("unreviewed");
    expect((await assign(ADMIN, REVIEWER)).ok).toBe(true);
    for (const uid of [REVIEWER2, ADMIN]) expect(await decide(uid)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    const ok = await decide(REVIEWER);
    expect(ok.ok).toBe(true);
    expect(rr()!.humanReview.status).toBe("approved");
  });

  it("the run creator (TeamCP's owner) cannot be assigned, and cannot decide even through a directly seeded assignment", async () => {
    expect((await submit(MEMBER)).ok).toBe(true);
    expect(await assign(ADMIN, OWNER)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } });
    seedAssignment(OWNER);
    expect(await decide(OWNER)).toEqual({ ok: false, reason: "not_authorized", denial: "self_review" });
    expect(rr()!.humanReview.status).toBe("unreviewed");
  });

  it("the submitter cannot be assigned to their own submission, and cannot decide it even through a directly seeded assignment", async () => {
    expect((await submit(ADMIN)).ok).toBe(true);
    expect(await assign(OWNER, ADMIN)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } });
    seedAssignment(ADMIN);
    expect(await decide(ADMIN)).toEqual({ ok: false, reason: "not_authorized", denial: "submitter" });
    expect(rr()!.humanReview.status).toBe("unreviewed");
  });

  it("a removed member cannot participate: an assignee removed after assignment loses the context and the decision", async () => {
    expect((await submit(MEMBER)).ok).toBe(true);
    expect((await assign(ADMIN, REVIEWER)).ok).toBe(true);
    // Positive control: while active, the assignee can read the context and is allowed to decide.
    const before = await getReportReviewContext({ uid: REVIEWER, workspaceId: TEAMCP, runId: RUN });
    expect(before.status === "ok" && before.viewer).toMatchObject({ canDecide: true, denial: null });
    membership(TEAMCP, REVIEWER, "reviewer", "removed");
    expect(await getReportReviewContext({ uid: REVIEWER, workspaceId: TEAMCP, runId: RUN })).toEqual({ status: "not_found" });
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "membership_removed" });
    expect(await getReportReviewContext({ uid: REMOVED, workspaceId: TEAMCP, runId: RUN })).toEqual({ status: "not_found" });
    // HTTP, removed caller: concealed on every route.
    identity.uid = REVIEWER;
    expect((await contextGet(new NextRequest(base(TEAMCP, RUN)), params(TEAMCP, RUN))).status).toBe(404);
    expect((await exportGet(new NextRequest(`${base(TEAMCP, RUN)}/export?format=json`), params(TEAMCP, RUN))).status).toBe(404);
    const rec = rr()!;
    expect((await decisionPost(post(`${base(TEAMCP, RUN)}/decision`, { decision: { status: "approved" }, expectedCycle: rec.cycle, expectedUpdatedAt: rec.updatedAt }), params(TEAMCP, RUN))).status).toBe(404);
    identity.uid = REMOVED;
    expect((await submitPost(post(base(TEAMCP, RUN), { purpose: { code: "internal_review" } }), params(TEAMCP, RUN))).status).toBe(404);
    expect((await resubmitPost(post(`${base(TEAMCP, RUN)}/resubmit`, { purpose: { code: "internal_review" }, expectedCycle: 1 }), params(TEAMCP, RUN))).status).toBe(404);
    expect(rr()!.humanReview.status).toBe("unreviewed");
  });
});
