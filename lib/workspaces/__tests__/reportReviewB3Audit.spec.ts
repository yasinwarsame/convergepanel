/**
 * Order B, Stage B3 — Report Review events in the Workspace Audit Log (owner B3 §2), on the transactional fake.
 *
 * Contract under test:
 *   - every successful report-review mutation (submit, assign, reassign, remove, decide, resubmit) writes EXACTLY ONE
 *     `workspaceMembershipEvents` row, in the SAME commit as the mutation (durable: a failed commit leaves neither);
 *   - idempotent retries (submit replay, decision replay, resubmit/assignment OCC conflicts) write no row;
 *   - each row is bound to the run's own Workspace and the actor, carries the correct cycle, and its `at` is the SAME
 *     instant as the mutation's own timestamp;
 *   - governed runs and the OFF switch write nothing new;
 *   - the Audit Log reader projects the rows (display names only — no uid, runId or projectId) and skips malformed or
 *     foreign-Workspace rows.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const flags = { REPORT_REVIEW_ENABLED: true };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return flags.REPORT_REVIEW_ENABLED;
  },
  REPORT_REVIEW_WORKSPACE_ALLOWLIST: ["wsB3"],
}));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  // uid-x and uid-y deliberately share a display name (two different people called "Sam").
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, u === "uid-x" || u === "uid-y" ? "Sam" : `Name(${u})`])),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment, deleteWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { listWorkspaceAuditEvents } from "@/lib/workspaces/listWorkspaceAuditEvents";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";

const W = "wsB3";
const W2 = "wsOther";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member"; // submitter
const REVIEWER = "uid-reviewer";
const REVIEWER2 = "uid-reviewer2";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const RUN = "run-b3";
const GOV = "run-governed";

function membership(ws: string, uid: string, role: string) {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.stats = { commits: 0, retries: 0, aborted: 0 };
  flags.REPORT_REVIEW_ENABLED = true;
  for (const ws of [W, W2]) db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: "T", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
  membership(W, OWNER, "owner");
  membership(W, ADMIN, "admin");
  membership(W, MEMBER, "member");
  membership(W, REVIEWER, "reviewer");
  membership(W, REVIEWER2, "reviewer");
  membership(W, CREATOR, "member");
  db.seed(`runs/${RUN}`, {
    userId: CREATOR,
    workspaceId: W,
    projectId: null,
    question: "Is the <b>supply</b> plan sound?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok" }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: {}, generatedAt: "x", results: [], alignedClaims: [] },
  });
  // A governed-shaped run (has a governance record): its assignments must write NO report-review audit row.
  db.seed(`runs/${GOV}`, { userId: CREATOR, workspaceId: W, projectId: null, question: "Gov?", status: "complete", createdAt: NOW, governanceRecord: { humanReview: { status: "unreviewed" } } });
});

const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1;
const auditRows = () =>
  db
    .paths("workspaceMembershipEvents/")
    .map((p) => db.read(p) as Record<string, unknown>)
    .sort((a, b) => (a.at as Timestamp).toMillis() - (b.at as Timestamp).toMillis());
const runEvents = () => db.paths(`runs/${RUN}/reportReviewEvents/`).length;
const iso = (t: unknown) => (t as Timestamp).toDate().toISOString();

const submit = (now = "2026-11-02T11:00:00.000Z") => submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "client_delivery", note: "Board pack" }, now });
const assign = (reviewer: string, expectedRevision: number, now: string) => putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: reviewer, expectedRevision, dueAt: null, now });
const decide = (uid: string, status: string, now = "2026-11-02T12:00:00.000Z") => decideReportReview({ uid, workspaceId: W, runId: RUN, decision: { status }, expectedCycle: rr().cycle, expectedUpdatedAt: rr().updatedAt, now });

describe("one durable audit row per committed mutation", () => {
  it("full lifecycle: submit → assign → reassign → remove → assign → decide → resubmit, each with exactly one row", async () => {
    expect((await submit()).ok).toBe(true);
    expect((await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z")).ok).toBe(true);
    expect((await assign(REVIEWER2, 1, "2026-11-02T11:02:00.000Z")).ok).toBe(true);
    expect((await deleteWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, expectedRevision: 2, now: "2026-11-02T11:03:00.000Z" })).ok).toBe(true);
    expect((await assign(REVIEWER, 3, "2026-11-02T11:04:00.000Z")).ok).toBe(true);
    expect((await decide(REVIEWER, "changes_requested")).ok).toBe(true);
    expect((await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "internal_review" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);

    const rows = auditRows();
    const common = { workspaceId: W, runId: RUN, projectId: null, runQuestion: "Is the <b>supply</b> plan sound?" };
    expect(rows.map((r) => ({ ...r, at: iso(r.at) }))).toEqual([
      { ...common, eventType: "workspace_report_review_submitted", actorUid: MEMBER, cycle: 1, purposeCode: "client_delivery", at: "2026-11-02T11:00:00.000Z" },
      { ...common, eventType: "workspace_report_review_reviewer_changed", actorUid: ADMIN, cycle: 1, previousReviewerUid: null, reviewerUid: REVIEWER, revision: 1, at: "2026-11-02T11:01:00.000Z" },
      { ...common, eventType: "workspace_report_review_reviewer_changed", actorUid: ADMIN, cycle: 1, previousReviewerUid: REVIEWER, reviewerUid: REVIEWER2, revision: 2, at: "2026-11-02T11:02:00.000Z" },
      { ...common, eventType: "workspace_report_review_reviewer_changed", actorUid: ADMIN, cycle: 1, previousReviewerUid: REVIEWER2, reviewerUid: null, revision: 3, at: "2026-11-02T11:03:00.000Z" },
      { ...common, eventType: "workspace_report_review_reviewer_changed", actorUid: ADMIN, cycle: 1, previousReviewerUid: null, reviewerUid: REVIEWER, revision: 4, at: "2026-11-02T11:04:00.000Z" },
      { ...common, eventType: "workspace_report_review_decided", actorUid: REVIEWER, cycle: 1, priorStatus: "unreviewed", status: "changes_requested", purposeCode: "client_delivery", at: "2026-11-02T12:00:00.000Z" },
      { ...common, eventType: "workspace_report_review_resubmitted", actorUid: MEMBER, cycle: 2, fromCycle: 1, purposeCode: "internal_review", clearedReviewerUid: REVIEWER, at: "2026-11-02T13:00:00.000Z" },
    ]);
    // The audit row's instant IS the record's own timestamp (one clock read per mutation).
    expect(rr().submittedAt).toBe("2026-11-02T13:00:00.000Z");
    // One run-level event per audit row: the two trails agree.
    expect(runEvents()).toBe(rows.length);
  });

  it("idempotent retries write no audit row: submit replay, decision replay, stale resubmit, stale assignment", async () => {
    await submit();
    const replay = await submit("2026-11-02T11:00:30.000Z");
    expect(replay.ok && !replay.created).toBe(true);
    await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z");
    expect((await assign(REVIEWER2, 0, "2026-11-02T11:01:30.000Z")).ok).toBe(false); // stale revision
    await decide(REVIEWER, "approved");
    const decisionReplay = await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "2026-11-02T11:00:00.000Z", now: "2026-11-02T12:05:00.000Z" });
    expect(decisionReplay.ok && decisionReplay.replayed).toBe(true);
    await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" });
    const stale = await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:05.000Z" });
    expect(stale).toEqual({ ok: false, reason: "cycle_conflict" });
    expect(auditRows().map((r) => r.eventType)).toEqual(["workspace_report_review_submitted", "workspace_report_review_reviewer_changed", "workspace_report_review_decided", "workspace_report_review_resubmitted"]);
  });

  const failCommits = () => {
    db.hooks = {
      failCommit: () => {
        throw new Error("commit failed");
      },
    };
  };

  it("durability (submit): a failed commit leaves NEITHER the record NOR its audit row", async () => {
    failCommits();
    expect(await submit()).toEqual({ ok: false, reason: "write_failed" });
    expect([db.read(`runs/${RUN}`)!.reportReview, auditRows().length, runEvents()]).toEqual([undefined, 0, 0]);
  });

  it("durability (assign): a failed commit leaves NEITHER the assignment NOR its audit row", async () => {
    await submit();
    failCommits();
    expect((await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z")).ok).toBe(false);
    expect([db.read(`runs/${RUN}/humanReviewAssignment/current`), auditRows().length]).toEqual([undefined, 1]);
  });

  it("durability (decide, resubmit): a failed commit leaves no decision, no new cycle and no audit row", async () => {
    await submit();
    await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z");
    failCommits();
    expect(await decide(REVIEWER, "approved")).toEqual({ ok: false, reason: "write_failed" });
    expect(rr().humanReview.status).toBe("unreviewed");
    db.hooks = {};
    await decide(REVIEWER, "rejected");
    const n = auditRows().length;
    failCommits();
    expect(await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).toEqual({ ok: false, reason: "write_failed" });
    expect([rr().cycle, auditRows().length]).toEqual([1, n]);
  });

  it("a governed run's assignment writes no report-review row (governed behaviour unchanged)", async () => {
    expect((await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: GOV, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" })).ok).toBe(true);
    expect(auditRows()).toEqual([]);
  });

  it("OFF: no mutation runs and nothing is written; an existing record's assignment writes no row", async () => {
    await submit();
    flags.REPORT_REVIEW_ENABLED = false;
    const n = auditRows().length;
    expect(await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" } })).toEqual({ ok: false, reason: "disabled" });
    expect((await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z")).ok).toBe(true); // dormant: plain assignment, as before B2
    expect(auditRows().length).toBe(n);
  });

  it("the run question snapshot is null (never invented) when the run has none", async () => {
    db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, question: "   " });
    await submit();
    expect(auditRows()[0].runQuestion).toBeNull();
  });
});

describe("Audit Log reader", () => {
  it("projects every report-review row with display names only; no uid, runId or projectId leaves the server", async () => {
    await submit();
    await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z");
    await decide(REVIEWER, "approved");
    await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "publication_review" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" });
    const res = await listWorkspaceAuditEvents({ workspaceId: W, limit: 20 });
    if (res.status !== "ok") throw new Error(res.status);
    expect(res.items).toEqual([
      { eventType: "workspace_report_review_resubmitted", occurredAt: "2026-11-02T13:00:00.000Z", actor: { displayName: `Name(${MEMBER})` }, research: { question: "Is the <b>supply</b> plan sound?" }, cycle: 2, fromCycle: 1, purpose: "publication_review", clearedReviewer: { displayName: `Name(${REVIEWER})` } },
      { eventType: "workspace_report_review_decided", occurredAt: "2026-11-02T12:00:00.000Z", actor: { displayName: `Name(${REVIEWER})` }, research: { question: "Is the <b>supply</b> plan sound?" }, cycle: 1, status: "approved", purpose: "client_delivery" },
      { eventType: "workspace_report_review_reviewer_changed", occurredAt: "2026-11-02T11:01:00.000Z", actor: { displayName: `Name(${ADMIN})` }, research: { question: "Is the <b>supply</b> plan sound?" }, cycle: 1, change: "assigned", previousReviewer: null, reviewer: { displayName: `Name(${REVIEWER})` } },
      { eventType: "workspace_report_review_submitted", occurredAt: "2026-11-02T11:00:00.000Z", actor: { displayName: `Name(${MEMBER})` }, research: { question: "Is the <b>supply</b> plan sound?" }, cycle: 1, purpose: "client_delivery" },
    ]);
    const serialized = JSON.stringify(res.items);
    for (const secret of [RUN, MEMBER, REVIEWER, ADMIN, "uid-"]) expect(serialized.includes(`"${secret}"`) || serialized.includes(`:"${secret}`)).toBe(false);
  });

  it("review m-1: the change kind comes from uids — reassigned, removed, and a same-reviewer (due date) update", async () => {
    await submit();
    await assign(REVIEWER, 0, "2026-11-02T11:01:00.000Z");
    await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 1, dueAt: "2026-11-10T00:00:00.000Z", now: "2026-11-02T11:02:00.000Z" });
    await assign(REVIEWER2, 2, "2026-11-02T11:03:00.000Z").catch(() => null);
    await deleteWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, expectedRevision: 3, now: "2026-11-02T11:04:00.000Z" });
    const res = await listWorkspaceAuditEvents({ workspaceId: W, limit: 20 });
    if (res.status !== "ok") throw new Error(res.status);
    const changes = res.items.filter((i) => i.eventType === "workspace_report_review_reviewer_changed").map((i) => (i as { change: string }).change);
    expect(changes).toEqual(["removed", "reassigned", "updated", "assigned"]);
  });

  it("review m-1: two reviewers with the SAME display name are still 'reassigned' (uids decide, never names)", async () => {
    db.seed("workspaceMembershipEvents/same-name", { workspaceId: W, actorUid: ADMIN, runId: RUN, projectId: null, runQuestion: "Q", cycle: 1, eventType: "workspace_report_review_reviewer_changed", previousReviewerUid: "uid-x", reviewerUid: "uid-y", revision: 2, at: Timestamp.fromDate(new Date("2026-11-02T11:00:00Z")) });
    const res = await listWorkspaceAuditEvents({ workspaceId: W, limit: 20 });
    expect(res.status === "ok" && res.items[0]).toMatchObject({ change: "reassigned", previousReviewer: { displayName: "Sam" }, reviewer: { displayName: "Sam" } });
  });

  it("another Workspace's rows are never returned (query scope + row check)", async () => {
    await submit();
    const res = await listWorkspaceAuditEvents({ workspaceId: W2, limit: 20 });
    expect(res).toEqual({ status: "ok", items: [], hasMore: false });
  });

  const base = { workspaceId: W, actorUid: ADMIN, runId: RUN, projectId: null, runQuestion: "Q", at: Timestamp.fromDate(new Date("2026-11-02T11:00:00Z")) };
  it.each([
    ["submitted with cycle 2", { ...base, eventType: "workspace_report_review_submitted", cycle: 2, purposeCode: "other" }],
    ["unknown purpose", { ...base, eventType: "workspace_report_review_submitted", cycle: 1, purposeCode: "certified" }],
    ["decided with unknown status", { ...base, eventType: "workspace_report_review_decided", cycle: 1, priorStatus: "unreviewed", status: "verified", purposeCode: "other" }],
    ["decided from a decided status", { ...base, eventType: "workspace_report_review_decided", cycle: 1, priorStatus: "approved", status: "rejected", purposeCode: "other" }],
    ["resubmitted with a cycle gap", { ...base, eventType: "workspace_report_review_resubmitted", cycle: 3, fromCycle: 1, purposeCode: "other", clearedReviewerUid: null }],
    ["reviewer change with empty uid", { ...base, eventType: "workspace_report_review_reviewer_changed", cycle: 1, previousReviewerUid: "", reviewerUid: null }],
    ["missing runId", { ...base, runId: undefined, eventType: "workspace_report_review_submitted", cycle: 1, purposeCode: "other" }],
    ["empty question", { ...base, runQuestion: "", eventType: "workspace_report_review_submitted", cycle: 1, purposeCode: "other" }],
    ["zero cycle", { ...base, eventType: "workspace_report_review_reviewer_changed", cycle: 0, previousReviewerUid: null, reviewerUid: null }],
  ])("a malformed row is skipped, never repaired (%s)", async (_l, row) => {
    db.seed("workspaceMembershipEvents/bad", row as Record<string, unknown>);
    const res = await listWorkspaceAuditEvents({ workspaceId: W, limit: 20 });
    expect(res).toEqual({ status: "ok", items: [], hasMore: false });
  });
});

describe("immutability and single writer (static)", () => {
  const ROOT = join(__dirname, "../../..");
  const src = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the Workspace Audit writer only ever CREATES (never set/update/delete/add) and only inside a transaction", () => {
    const s = src("lib/workspaces/reportReviewWorkspaceAudit.ts");
    expect(s.match(/tx\.create\(/g)).toHaveLength(1);
    expect(s).not.toMatch(/\.(set|update|delete|add)\(/);
  });
  it.each(["lib/workspaces/reportReviewMutations.ts", "lib/workspaces/reportReviewDecisionMutation.ts", "lib/workspaces/reportReviewAssignmentAudit.ts"])("%s writes its audit row through the shared writer with its transaction", (f) => {
    expect(src(f)).toMatch(/writeReportReviewWorkspaceAuditEvent\(\s*tx,/);
  });
});
