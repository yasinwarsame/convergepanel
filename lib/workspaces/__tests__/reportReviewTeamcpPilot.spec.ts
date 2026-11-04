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
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { isMergedReviewQueueView } from "@/lib/workspaces/reviewQueueMode";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { POST as submitPost, GET as contextGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route";
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
    expect(cfg.status).toBe("active");
    expect(cfg.status === "active" && [...cfg.workspaceIds]).toEqual([TEAMCP]);
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
  it("another Workspace is refused on every surface; TeamCP works", async () => {
    identity.uid = MEMBER;
    expect((await submitPost(post(base(OTHER, RUN_OTHER), { purpose: { code: "internal_review" } }), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect(await submit(MEMBER, OTHER, RUN_OTHER)).toEqual({ ok: false, reason: "disabled" });
    expect(await decide(REVIEWER, OTHER, RUN_OTHER)).toEqual({ ok: false, reason: "disabled" });
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(base(OTHER, RUN_OTHER)), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect((await exportGet(new NextRequest(`${base(OTHER, RUN_OTHER)}/export?format=json`), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect((await decisionPost(post(`${base(OTHER, RUN_OTHER)}/decision`, { decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "x" }), params(OTHER, RUN_OTHER))).status).toBe(404);
    expect(isMergedReviewQueueView("needs_review", OTHER)).toBe(false);
    expect(rr(RUN_OTHER)).toBeUndefined();
    // Containment: TeamCP's route with the other Workspace's run is refused.
    expect(await submit(MEMBER, TEAMCP, RUN_OTHER)).toEqual({ ok: false, reason: "run_not_found" });

    identity.uid = MEMBER;
    expect((await submitPost(post(base(TEAMCP, RUN), { purpose: { code: "internal_review" } }), params(TEAMCP, RUN))).status).toBe(201);
    expect(isMergedReviewQueueView("needs_review", TEAMCP)).toBe(true);
    expect(rr(RUN_OTHER)).toBeUndefined();
  });

  it("capabilities are enforced server-side: reviewers and removed members cannot submit; a member cannot assign", async () => {
    for (const uid of [REVIEWER, REVIEWER2]) expect(await submit(uid)).toEqual({ ok: false, reason: "insufficient_capability" });
    expect((await submit(REMOVED)).ok).toBe(false);
    expect((await submit("uid-stranger")).ok).toBe(false);
    expect(rr()).toBeUndefined();
    expect((await submit(MEMBER)).ok).toBe(true);
    expect((await assign(MEMBER, REVIEWER)).ok).toBe(false); // member lacks reviews.manage
    expect((await assign(REMOVED, REVIEWER)).ok).toBe(false);
    expect((await assign(ADMIN, REMOVED)).ok).toBe(false); // a removed member is not an eligible target
  });

  it("the reviewer must be assigned: unassigned reviewers, the owner and the admin cannot decide", async () => {
    expect((await submit(ADMIN)).ok).toBe(true);
    for (const uid of [REVIEWER, REVIEWER2, OWNER, MEMBER]) expect((await decide(uid)).ok).toBe(false);
    expect(rr()!.humanReview.status).toBe("unreviewed");
    expect((await assign(ADMIN, REVIEWER)).ok).toBe(true);
    expect(await decide(REVIEWER2)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    const ok = await decide(REVIEWER);
    expect(ok.ok).toBe(true);
    expect(rr()!.humanReview.status).toBe("approved");
  });

  it("the run creator (TeamCP's owner) cannot decide, even through a directly seeded assignment, and cannot be assigned", async () => {
    expect((await submit(MEMBER)).ok).toBe(true);
    expect((await assign(ADMIN, OWNER)).ok).toBe(false);
    seedAssignment(OWNER);
    expect(await decide(OWNER)).toEqual({ ok: false, reason: "not_authorized", denial: "self_review" });
    expect(rr()!.humanReview.status).toBe("unreviewed");
  });

  it("the submitter cannot decide their own submission, and cannot be assigned to it", async () => {
    expect((await submit(ADMIN)).ok).toBe(true);
    expect(await assign(OWNER, ADMIN)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } });
    seedAssignment(ADMIN);
    expect(await decide(ADMIN)).toEqual({ ok: false, reason: "not_authorized", denial: "submitter" });
    expect(rr()!.humanReview.status).toBe("unreviewed");
  });

  it("a removed member cannot participate: an assignee removed after assignment loses the decision and the context", async () => {
    expect((await submit(MEMBER)).ok).toBe(true);
    expect((await assign(ADMIN, REVIEWER)).ok).toBe(true);
    membership(TEAMCP, REVIEWER, "reviewer", "removed");
    expect((await decide(REVIEWER)).ok).toBe(false);
    expect(await getReportReviewContext({ uid: REVIEWER, workspaceId: TEAMCP, runId: RUN })).toEqual({ status: "not_found" });
    expect(await getReportReviewContext({ uid: REMOVED, workspaceId: TEAMCP, runId: RUN })).toEqual({ status: "not_found" });
    expect(rr()!.humanReview.status).toBe("unreviewed");
  });
});
