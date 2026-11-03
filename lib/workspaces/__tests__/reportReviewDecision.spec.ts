/**
 * Order B, Stage B2 — report-review DECISIONS, assignment audit and the read context, on the transactional fake
 * (conflicts retry, create is write-once, reads precede writes). Owner B2 §3/§4/§6.
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
}));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { putWorkspaceReviewAssignment, deleteWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { validateDecisionUpdate } from "@/lib/governance/reportReviewDecision";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";

const W = "wsB2";
const W2 = "wsOther";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member"; // submitter
const REVIEWER = "uid-reviewer";
const REVIEWER2 = "uid-reviewer2";
const VIEWER = "uid-viewer";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const RUN = "run-b2";

function membership(ws: string, uid: string, role: string, status = "active") {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status, createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
function legacyRun(id: string, ws = W) {
  db.seed(`runs/${id}`, {
    userId: CREATOR,
    workspaceId: ws,
    projectId: null,
    question: "Q?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok" }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: {}, generatedAt: "x", results: [], alignedClaims: [] },
  });
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
  membership(W, VIEWER, "viewer");
  membership(W, CREATOR, "member");
  membership(W2, OWNER, "owner");
  membership(W2, REVIEWER, "reviewer");
  legacyRun(RUN);
});

const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1;
const events = (type?: string) =>
  db
    .paths(`runs/${RUN}/reportReviewEvents/`)
    .map((p) => db.read(p) as Record<string, unknown>)
    .filter((e) => !type || e.type === type);
async function submitted() {
  const r = await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "client_delivery", note: "Board pack" }, now: "2026-11-02T11:00:00.000Z" });
  if (!r.ok) throw new Error("submit failed");
  return r.record;
}
const assign = (reviewer: string, expectedRevision = 0, actor = ADMIN) => putWorkspaceReviewAssignment({ uid: actor, workspaceId: W, runId: RUN, assignedReviewerUserId: reviewer, expectedRevision, dueAt: null, now: "2026-11-02T11:05:00.000Z" });
const decide = (uid: string, decision: unknown = { status: "approved", comment: "Fine for the board." }, over: Partial<{ expectedCycle: number; expectedUpdatedAt: string; runId: string; workspaceId: string }> = {}) =>
  decideReportReview({ uid, workspaceId: over.workspaceId ?? W, runId: over.runId ?? RUN, decision, expectedCycle: over.expectedCycle ?? rr().cycle, expectedUpdatedAt: over.expectedUpdatedAt ?? rr().updatedAt, now: "2026-11-02T12:00:00.000Z" });

describe("first decision", () => {
  it("the assigned reviewer decides: record updated, purpose/cycle kept, one durable decided event in the same commit", async () => {
    await submitted();
    expect((await assign(REVIEWER)).ok).toBe(true);
    const res = await decide(REVIEWER);
    expect(res.ok && !res.replayed).toBe(true);
    expect(rr().humanReview).toEqual({ status: "approved", reviewerId: REVIEWER, reviewedAt: "2026-11-02T12:00:00.000Z", comment: "Fine for the board." });
    expect([rr().cycle, rr().purpose, rr().updatedAt]).toEqual([1, { code: "client_delivery", note: "Board pack" }, "2026-11-02T12:00:00.000Z"]);
    expect(events("report_review_decided")).toEqual([
      expect.objectContaining({ version: 1, runId: RUN, workspaceId: W, actorUid: REVIEWER, cycle: 1, priorStatus: "unreviewed", status: "approved", purposeCode: "client_delivery", hasComment: true, conditionsCount: 0, at: "2026-11-02T12:00:00.000Z" }),
    ]);
  });

  it("approved_with_conditions keeps exactly the conditions; other statuses never keep conditions", async () => {
    await submitted();
    await assign(REVIEWER);
    await decide(REVIEWER, { status: "approved_with_conditions", conditions: [" Cite sources ", "Mark as draft"] });
    expect(rr().humanReview.conditions).toEqual(["Cite sources", "Mark as draft"]);
    expect(validateDecisionUpdate({ status: "rejected", conditions: ["x"] })).toEqual({ ok: true, update: { status: "rejected", comment: null, conditions: null } });
  });

  it.each([
    [{ status: "verified" }, "invalid_decision"],
    [{ status: "approved", extra: 1 }, "invalid_decision"],
    [{ status: "approved_with_conditions" }, "conditions_required"],
    [{ status: "approved_with_conditions", conditions: [] }, "conditions_required"],
    [{ status: "approved", comment: "x".repeat(2001) }, "invalid_decision"],
    [{ status: "approved_with_conditions", conditions: Array.from({ length: 11 }, () => "c") }, "invalid_decision"],
  ])("invalid decision %j → %s, nothing written", async (decision, reason) => {
    await submitted();
    await assign(REVIEWER);
    expect(await decide(REVIEWER, decision)).toEqual({ ok: false, reason });
    expect(rr().humanReview).toEqual({ status: "unreviewed" });
  });
});

describe("authorization: the shared contract (server-authoritative)", () => {
  it.each([
    ["the submitter (even if assigned through a pre-existing assignment)", MEMBER],
    ["the run creator", CREATOR],
  ])("%s can never decide", async (_k, uid) => {
    // Seed an assignment directly (bypassing the assignment guard) to prove the decision path itself refuses.
    await submitted();
    db.seed(`runs/${RUN}/humanReviewAssignment/current`, { schemaVersion: 1, teamId: null, runId: RUN, assignedReviewerUserId: uid, assignedAt: "x", assignedByUserId: ADMIN, updatedAt: "x", updatedByUserId: ADMIN, revision: 1, workspaceId: W, projectId: null, dueAt: null });
    const res = await decide(uid);
    expect(res).toEqual({ ok: false, reason: "not_authorized", denial: uid === MEMBER ? "submitter" : "self_review" });
    expect(rr().humanReview.status).toBe("unreviewed");
    expect(events("report_review_decided")).toEqual([]);
  });

  it("only the CURRENT assignee may decide; owner/admin/other reviewers/viewer are refused", async () => {
    await submitted();
    await assign(REVIEWER);
    for (const uid of [OWNER, ADMIN, REVIEWER2]) expect(await decide(uid)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    expect(await decide(VIEWER)).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(rr().humanReview.status).toBe("unreviewed");
  });

  it("a removed or demoted assignee loses the decision; a cross-workspace caller is refused", async () => {
    await submitted();
    await assign(REVIEWER);
    membership(W, REVIEWER, "viewer");
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "insufficient_capability" });
    membership(W, REVIEWER, "reviewer", "removed");
    expect((await decide(REVIEWER)).ok).toBe(false);
    membership(W, REVIEWER, "reviewer");
    expect(await decide(REVIEWER, undefined, { workspaceId: W2 })).toEqual({ ok: false, reason: "run_not_found" });
    expect(rr().humanReview.status).toBe("unreviewed");
  });

  it("an assignment tagged for an earlier cycle is stale", async () => {
    await submitted();
    db.seed(`runs/${RUN}/humanReviewAssignment/current`, { schemaVersion: 1, teamId: null, runId: RUN, assignedReviewerUserId: REVIEWER, assignedAt: "x", assignedByUserId: ADMIN, updatedAt: "x", updatedByUserId: ADMIN, revision: 1, workspaceId: W, projectId: null, dueAt: null, cycle: 0 });
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "not_authorized", denial: "stale_assignment" });
  });

  it("the submitter can never be ASSIGNED as reviewer of their report (assignment guard)", async () => {
    await submitted();
    expect(await assign(MEMBER)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } });
  });

  it("the context returns the same verdict the server enforces", async () => {
    await submitted();
    await assign(REVIEWER);
    for (const [uid, canDecide, denial] of [
      [REVIEWER, true, null],
      [REVIEWER2, false, "not_assigned"],
      [OWNER, false, "not_assigned"],
      [CREATOR, false, "self_review"],
    ] as const) {
      const ctx = await getReportReviewContext({ uid, workspaceId: W, runId: RUN });
      expect(ctx.status === "ok" && ctx.viewer).toEqual({ canDecide, denial });
    }
    // VIEWER lacks reviews.submit: context is readable (reviews.read) but deciding is not allowed.
    const v = await getReportReviewContext({ uid: VIEWER, workspaceId: W, runId: RUN });
    expect(v.status === "ok" && v.viewer).toEqual({ canDecide: false, denial: "insufficient_capability" });
    expect(await getReportReviewContext({ uid: "uid-stranger", workspaceId: W, runId: RUN })).toEqual({ status: "not_found" });
  });
});

describe("concurrency, retries, OCC", () => {
  it("a retried decision after a lost response is an idempotent replay: same record, no second event", async () => {
    await submitted();
    await assign(REVIEWER);
    const first = await decide(REVIEWER);
    const before = rr();
    const retry = await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "approved", comment: "Fine for the board." }, expectedCycle: 1, expectedUpdatedAt: "2026-11-02T11:00:00.000Z" });
    expect([first.ok, retry.ok && retry.replayed]).toEqual([true, true]);
    expect(rr()).toEqual(before);
    expect(events("report_review_decided")).toHaveLength(1);
  });

  it("a DIFFERENT decision on an already-decided cycle is refused (stale), never overwriting", async () => {
    await submitted();
    await assign(REVIEWER);
    await decide(REVIEWER);
    expect(await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "rejected" }, expectedCycle: 1, expectedUpdatedAt: "2026-11-02T11:00:00.000Z" })).toEqual({ ok: false, reason: "stale_expected_updated_at" });
    expect(rr().humanReview.status).toBe("approved");
  });

  it("a decided cycle can never be re-decided, even with the CURRENT cycle and updatedAt (no in-place overwrite)", async () => {
    await submitted();
    await assign(REVIEWER);
    await decide(REVIEWER, { status: "approved" });
    const res = await decide(REVIEWER, { status: "rejected" }); // decide() passes the current cycle and updatedAt
    expect(res).toEqual({ ok: false, reason: "not_authorized", denial: "not_open" });
    expect(rr().humanReview.status).toBe("approved");
    expect(events("report_review_decided")).toHaveLength(1);
  });

  it("two simultaneous decisions: exactly one commits; the other retries and is replayed or refused, never both written", async () => {
    await submitted();
    await assign(REVIEWER);
    const expectedUpdatedAt = rr().updatedAt;
    let second: Promise<unknown> | null = null;
    db.hooks.afterTxReads = async (attempt) => {
      if (second || attempt > 0) return;
      db.hooks.afterTxReads = undefined;
      second = decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "changes_requested" }, expectedCycle: 1, expectedUpdatedAt });
      await second;
    };
    const first = await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt });
    const results = [first, (await second) as Awaited<ReturnType<typeof decide>>];
    expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "stale_expected_updated_at" }]);
    expect(events("report_review_decided")).toHaveLength(1);
    expect(db.stats.retries).toBeGreaterThan(0);
  });

  it("reassignment during review: a decision racing a reassignment retries and is refused for the old reviewer", async () => {
    await submitted();
    await assign(REVIEWER);
    db.hooks.afterTxReads = async (attempt) => {
      if (attempt > 0) return;
      db.hooks.afterTxReads = undefined;
      const r = await assign(REVIEWER2, 1);
      expect(r.ok).toBe(true);
    };
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    expect((await decide(REVIEWER2)).ok).toBe(true);
    expect(rr().humanReview.reviewerId).toBe(REVIEWER2);
  });

  it("stale cycle is refused", async () => {
    await submitted();
    await assign(REVIEWER);
    expect(await decide(REVIEWER, undefined, { expectedCycle: 2 })).toEqual({ ok: false, reason: "cycle_conflict" });
  });
});

describe("cycles and history (with B1 resubmission)", () => {
  it("decide → resubmit → decide again: cycle 1 archived exactly as decided, never mutated; cycle 2 decided separately; context lists both", async () => {
    await submitted();
    await assign(REVIEWER);
    await decide(REVIEWER, { status: "changes_requested", comment: "Add sources." });
    const decided1 = rr();
    expect((await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "publication_review" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);
    const archive1 = db.read(`runs/${RUN}/reportReviewCycles/1`);
    expect((archive1!.record as ReportReviewRecordV1).humanReview).toEqual(decided1.humanReview);
    expect((archive1!.assignment as { assignedReviewerUserId: string }).assignedReviewerUserId).toBe(REVIEWER);
    // The old reviewer cannot decide cycle 2 (the assignment was reset).
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    const assignmentRevision = (db.read(`runs/${RUN}/humanReviewAssignment/current`) as { revision: number }).revision;
    await assign(REVIEWER2, assignmentRevision);
    await decide(REVIEWER2, { status: "approved" });
    expect(db.read(`runs/${RUN}/reportReviewCycles/1`)).toEqual(archive1); // cycle 1 untouched
    const ctx = await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN });
    expect(ctx.status === "ok" && ctx.previousCycles).toEqual([{ cycle: 1, status: "changes_requested", reviewerId: REVIEWER, reviewedAt: "2026-11-02T12:00:00.000Z", purposeCode: "client_delivery", assignedReviewerUserId: REVIEWER }]);
    expect(ctx.status === "ok" && [ctx.record.cycle, ctx.record.humanReview.status, ctx.record.purpose.code]).toEqual([2, "approved", "publication_review"]);
    expect(events("report_review_decided").map((e) => [e.cycle, e.status, e.actorUid])).toEqual(
      expect.arrayContaining([
        [1, "changes_requested", REVIEWER],
        [2, "approved", REVIEWER2],
      ])
    );
  });
});

describe("assignment audit (durable, same transaction) — report-review runs only", () => {
  it("assign, reassign and clear each write one event with cycle, before/after and revision", async () => {
    await submitted();
    await assign(REVIEWER);
    await assign(REVIEWER2, 1);
    expect((await deleteWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, expectedRevision: 2 })).ok).toBe(true);
    expect(events("report_review_assignment_changed").map((e) => [e.previousReviewerUserId, e.newReviewerUserId, e.revision, e.cycle, e.actorUid]).sort((a, b) => (a[2] as number) - (b[2] as number))).toEqual([
      [null, REVIEWER, 1, 1, ADMIN],
      [REVIEWER, REVIEWER2, 2, 1, ADMIN],
      [REVIEWER2, null, 3, 1, ADMIN],
    ]);
  });

  it("governed runs are unchanged: an assignment writes NO report-review event", async () => {
    db.seed("runs/run-gov", { userId: CREATOR, workspaceId: W, projectId: null, question: "G", status: "complete", createdAt: NOW });
    const r = await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: "run-gov", assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null });
    expect(r.ok).toBe(true);
    expect(db.paths("runs/run-gov/reportReviewEvents/")).toEqual([]);
  });

  it("an unreadable report-review record blocks assignment changes (no change without its audit)", async () => {
    await submitted();
    await db.doc(`runs/${RUN}`).update({ reportReview: { version: 99 } });
    expect(await assign(REVIEWER)).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("B2 review fixes", () => {
  it("MINOR-1: an open review panel makes the context say no (active_panel), matching the server's 409", async () => {
    await submitted();
    await assign(REVIEWER);
    const { buildNextAdaptiveHumanReviewPanel } = jest.requireActual("@/lib/governance/adaptiveHumanReviewPanel");
    db.seed(`runs/${RUN}/humanReviewPanel/current`, buildNextAdaptiveHumanReviewPanel({ teamId: null, runId: RUN, reviewerUserIds: [REVIEWER, REVIEWER2], actorUserId: OWNER, now: "2026-11-02T11:30:00.000Z", current: null, workspaceMetadata: { workspaceId: W, projectId: null } }));
    const ctx = await getReportReviewContext({ uid: REVIEWER, workspaceId: W, runId: RUN });
    expect(ctx.status === "ok" && ctx.viewer).toEqual({ canDecide: false, denial: "active_panel" });
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "active_panel" });
  });

  it("MINOR-2: with Report Review OFF, assignment on a run carrying a stray reportReview behaves exactly as before (no guard, no event)", async () => {
    await submitted();
    flags.REPORT_REVIEW_ENABLED = false;
    expect((await assign(MEMBER)).ok).toBe(true); // the submitter guard is dormant when OFF
    expect(events("report_review_assignment_changed")).toEqual([]);
  });

  it("MINOR-2: with Report Review ON, a run carrying both records refuses assignment changes (fail closed)", async () => {
    await submitted();
    await db.doc(`runs/${RUN}`).update({ governanceRecord: { version: 1 } });
    expect(await assign(REVIEWER)).toEqual({ ok: false, reason: "run_not_found" });
  });

  it("MINOR-3: a 'replay' with a different comment or conditions is a conflict, never a silent success", async () => {
    await submitted();
    await assign(REVIEWER);
    await decide(REVIEWER, { status: "approved_with_conditions", conditions: ["A"], comment: "ok" });
    const stale = { expectedCycle: 1, expectedUpdatedAt: "2026-11-02T11:00:00.000Z" };
    expect(await decide(REVIEWER, { status: "approved_with_conditions", conditions: ["B"], comment: "ok" }, stale)).toEqual({ ok: false, reason: "decision_conflict" });
    expect(await decide(REVIEWER, { status: "approved_with_conditions", conditions: ["A"], comment: "changed" }, stale)).toEqual({ ok: false, reason: "decision_conflict" });
    const same = await decide(REVIEWER, { status: "approved_with_conditions", conditions: ["A"], comment: "ok" }, stale);
    expect(same.ok && same.replayed).toBe(true);
    expect(rr().humanReview.conditions).toEqual(["A"]);
  });
});

describe("integrity and dark", () => {
  it("a run carrying both records fails closed on decision and context", async () => {
    await submitted();
    await assign(REVIEWER);
    await db.doc(`runs/${RUN}`).update({ governanceRecord: { version: 1 } });
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "integrity_violation" });
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN })).toEqual({ status: "integrity_violation" });
  });

  it("dark: decisions and context are unavailable while the switch is off", async () => {
    await submitted();
    await assign(REVIEWER);
    flags.REPORT_REVIEW_ENABLED = false;
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "disabled" });
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN })).toEqual({ status: "not_found" });
  });
});
