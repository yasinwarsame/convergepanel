/**
 * Order B, Stage B1 — review-cycle integrity and authorization (owner list §3), on the transactional fake.
 *
 * First submission · duplicates · idempotent retries · decision preservation · new cycle after a decision · historical
 * assignment preservation · archive write-once · attempts to overwrite an archive · concurrent resubmission ·
 * membership removal and role changes · cross-workspace isolation · no reviewer carried into a new cycle (self-review
 * cannot arise from B1) · unauthorized submissions · dark flag.
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
  REPORT_REVIEW_WORKSPACE_ALLOWLIST: ["wsTeamB1"],
}));
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { buildTeamRunSnapshotPayload } from "@/lib/firestore/teamRunSnapshots";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { buildNextAdaptiveHumanReviewPanel, buildCancelledAdaptiveHumanReviewPanel } from "@/lib/governance/adaptiveHumanReviewPanel";

const W = "wsTeamB1";
const W2 = "wsTeamOther";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const REVIEWER = "uid-reviewer";
const VIEWER = "uid-viewer";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const RUN = "run-b1";

function membership(workspaceId: string, uid: string, role: string, status = "active") {
  const id = computeMembershipId(workspaceId, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId, uid, role, status, createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
function legacyRun(id: string, workspaceId = W, extra: Record<string, unknown> = {}) {
  db.seed(`runs/${id}`, {
    userId: CREATOR,
    workspaceId,
    projectId: null,
    question: "Q?",
    selectedModels: ["chatgpt", "claude", "gemini"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }, { modelId: "gemini", status: "failed" }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: {}, generatedAt: "x", results: [], alignedClaims: [] },
    ...extra,
  });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  flags.REPORT_REVIEW_ENABLED = true;
  for (const ws of [W, W2]) db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: "T", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
  membership(W, OWNER, "owner");
  membership(W, ADMIN, "admin");
  membership(W, MEMBER, "member");
  membership(W, REVIEWER, "reviewer");
  membership(W, VIEWER, "viewer");
  membership(W, CREATOR, "member");
  membership(W2, OWNER, "owner");
  legacyRun(RUN);
});

const P = { code: "internal_review", note: "For the Q4 planning meeting." };
const submit = (uid = MEMBER, runId = RUN, workspaceId = W, purpose: unknown = P) => submitReportReview({ uid, workspaceId, runId, purpose, now: "2026-11-02T11:00:00.000Z" });
const resubmit = (expectedCycle: unknown, uid = MEMBER, purpose: unknown = { code: "client_delivery", note: null }) =>
  resubmitReportReview({ uid, workspaceId: W, runId: RUN, purpose, expectedCycle, now: "2026-11-02T12:00:00.000Z" });
const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1 | undefined;
const decide = (status: string, reviewerId = REVIEWER) =>
  db.doc(`runs/${RUN}`).update({ "reportReview.humanReview": { status, reviewerId, reviewedAt: "2026-11-02T11:30:00.000Z", comment: "Fine." } });

describe("first submission", () => {
  it("creates cycle 1 with the exact record, scope copied from the saved run, and one event", async () => {
    const res = await submit();
    expect(res).toEqual({ ok: true, created: true, record: rr() });
    expect(rr()).toEqual({
      version: 1,
      kind: "report_review",
      cycle: 1,
      scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 2, requestedModels: 3 },
      purpose: { code: "internal_review", note: "For the Q4 planning meeting." },
      humanReview: { status: "unreviewed" },
      submittedAt: "2026-11-02T11:00:00.000Z",
      submittedByUserId: MEMBER,
      createdAt: "2026-11-02T11:00:00.000Z",
      updatedAt: "2026-11-02T11:00:00.000Z",
    });
    const events = db.paths(`runs/${RUN}/reportReviewEvents/`).map((p) => db.read(p));
    expect(events).toEqual([
      { version: 1, type: "report_review_submitted", runId: RUN, workspaceId: W, projectId: null, actorUid: MEMBER, fromCycle: null, toCycle: 1, purposeCode: "internal_review", at: "2026-11-02T11:00:00.000Z" },
    ]);
  });

  it("never touches governance fields or the assignment document", async () => {
    await submit();
    const run = db.read(`runs/${RUN}`)!;
    expect(run.governanceRecord).toBeUndefined();
    expect(run.adaptiveOutput).toBeUndefined();
    expect(db.read(`runs/${RUN}/humanReviewAssignment/current`)).toBeUndefined();
  });

  it.each([
    ["unknown code", { code: "certified" }],
    ["extra key", { code: "other", note: null, verified: true }],
    ["note too long (281 code points)", { code: "other", note: "é".repeat(281) }],
    ["non-string note", { code: "other", note: 5 }],
    ["not an object", "internal_review"],
  ])("rejects an invalid purpose (%s) with no write", async (_k, purpose) => {
    expect(await submit(MEMBER, RUN, W, purpose)).toEqual({ ok: false, reason: "invalid_purpose" });
    expect(rr()).toBeUndefined();
  });

  it("accepts a note of exactly 280 code points and blank notes become null", async () => {
    expect((await submit(MEMBER, RUN, W, { code: "other", note: "😀".repeat(280) })).ok).toBe(true);
    legacyRun("run-2");
    const r2 = await submit(MEMBER, "run-2", W, { code: "publication_review", note: "   " });
    expect(r2.ok && r2.record.purpose).toEqual({ code: "publication_review", note: null });
  });
});

describe("authorization (D-B3a): who may submit", () => {
  it.each([
    [OWNER, true],
    [ADMIN, true],
    [MEMBER, true],
    [REVIEWER, false],
    [VIEWER, false],
  ])("%s → allowed %s", async (uid, allowed) => {
    const res = await submit(uid);
    expect(res.ok).toBe(allowed);
    if (!allowed) expect(res).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("a non-member, a removed member, and a member demoted to Viewer are refused; nothing is written", async () => {
    expect(await submit("uid-stranger")).toEqual({ ok: false, reason: "membership_not_found" });
    membership(W, MEMBER, "member", "removed");
    expect((await submit(MEMBER)).ok).toBe(false);
    membership(W, MEMBER, "viewer");
    expect(await submit(MEMBER)).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(rr()).toBeUndefined();
  });

  it("cross-workspace isolation: a run of another Workspace is not found through this Workspace, even for its owner", async () => {
    legacyRun("run-w2", W2);
    expect(await submit(OWNER, "run-w2", W)).toEqual({ ok: false, reason: "run_not_found" });
    expect(db.read("runs/run-w2")!.reportReview).toBeUndefined();
  });

  it("dark: with REPORT_REVIEW_ENABLED off nothing is read or written", async () => {
    flags.REPORT_REVIEW_ENABLED = false;
    expect(await submit()).toEqual({ ok: false, reason: "disabled" });
    expect(await resubmit(1)).toEqual({ ok: false, reason: "disabled" });
    expect(rr()).toBeUndefined();
  });

  it("a valid OPEN review panel blocks submission (409 active_panel); a cancelled one does not; a malformed one fails closed", async () => {
    const open = buildNextAdaptiveHumanReviewPanel({ teamId: null, runId: RUN, reviewerUserIds: [REVIEWER, ADMIN], actorUserId: OWNER, now: "2026-11-02T10:30:00.000Z", current: null, workspaceMetadata: { workspaceId: W, projectId: null } });
    db.seed(`runs/${RUN}/humanReviewPanel/current`, open);
    expect(await submit()).toEqual({ ok: false, reason: "active_panel" });
    expect(rr()).toBeUndefined();
    db.seed(`runs/${RUN}/humanReviewPanel/current`, buildCancelledAdaptiveHumanReviewPanel({ current: open, actorUserId: OWNER, now: "2026-11-02T10:40:00.000Z" }));
    expect((await submit()).ok).toBe(true);
    legacyRun("run-p");
    db.seed("runs/run-p/humanReviewPanel/current", { status: "open" });
    expect(await submit(MEMBER, "run-p")).toEqual({ ok: false, reason: "panel_unreadable" });
  });
});

describe("eligibility outcomes through the writer", () => {
  it.each([
    ["governed (has governanceRecord)", { governanceRecord: { version: 1 } }, "governed_run"],
    ["governed (has adaptiveOutput)", { adaptiveOutput: { version: 1 } }, "governed_run"],
    ["not complete", { status: "in_progress" }, "not_complete"],
    ["no envelope, after the cutoff", { legacyAdaptiveOutput: undefined }, "no_review_information"],
  ])("%s → %s", async (_k, extra, reason) => {
    legacyRun("run-x", W, extra);
    expect(await submit(MEMBER, "run-x")).toEqual({ ok: false, reason: "ineligible", ineligible: reason });
    expect(db.read("runs/run-x")!.reportReview).toBeUndefined();
  });
});

describe("duplicates and retries", () => {
  it("a second submission of an open review writes nothing and returns the existing record", async () => {
    await submit();
    const before = rr();
    const again = await submit(ADMIN, RUN, W, { code: "other", note: "x" });
    expect(again).toEqual({ ok: true, created: false, record: before });
    expect(rr()).toEqual(before);
    expect(db.paths(`runs/${RUN}/reportReviewEvents/`)).toHaveLength(1);
  });

  it("a decided review cannot be re-submitted through submit (must resubmit as a new cycle)", async () => {
    await submit();
    await decide("approved");
    expect(await submit()).toEqual({ ok: false, reason: "ineligible", ineligible: "already_decided" });
  });

  it("an unreadable existing record is never overwritten (fail closed)", async () => {
    await db.doc(`runs/${RUN}`).update({ reportReview: { version: 99 } });
    expect(await submit()).toEqual({ ok: false, reason: "record_malformed" });
    expect(db.read(`runs/${RUN}`)!.reportReview).toEqual({ version: 99 });
  });
});

describe("D-B6: resubmission is a new cycle; history is preserved and write-once", () => {
  async function decidedCycle1WithAssignment(status = "changes_requested") {
    await submit();
    db.seed(`runs/${RUN}/humanReviewAssignment/current`, { schemaVersion: 1, teamId: null, runId: RUN, assignedReviewerUserId: REVIEWER, assignedAt: "2026-11-02T11:10:00.000Z", assignedByUserId: ADMIN, updatedAt: "x", updatedByUserId: ADMIN, revision: 3, workspaceId: W, projectId: null, dueAt: null });
    await decide(status);
    return { record: rr()!, assignment: db.read(`runs/${RUN}/humanReviewAssignment/current`) };
  }

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"])("after %s: archives cycle 1 exactly, starts cycle 2 unreviewed, resets the assignment", async (status) => {
    const prior = await decidedCycle1WithAssignment(status);
    const res = await resubmit(1);
    expect(res.ok && res.archivedCycle).toBe(1);

    // The decision and the assignment of cycle 1, exactly as they stood.
    expect(db.read(`runs/${RUN}/reportReviewCycles/1`)).toEqual({
      version: 1,
      runId: RUN,
      cycle: 1,
      record: prior.record,
      assignment: prior.assignment,
      archivedAt: "2026-11-02T12:00:00.000Z",
      archivedByUserId: MEMBER,
    });
    expect((db.read(`runs/${RUN}/reportReviewCycles/1`)!.record as ReportReviewRecordV1).humanReview.status).toBe(status);

    // Cycle 2 is new: decision fields are absent, purpose is the new one.
    const now = rr()!;
    expect([now.cycle, now.humanReview, now.purpose]).toEqual([2, { status: "unreviewed" }, { code: "client_delivery", note: null }]);

    // No reviewer is carried into the new cycle.
    expect(db.read(`runs/${RUN}/humanReviewAssignment/current`)).toEqual(
      expect.objectContaining({ assignedReviewerUserId: null, assignedAt: null, assignedByUserId: null, revision: 4, cycle: 2, source: "cycle_reset", workspaceId: W })
    );
    expect(db.paths(`runs/${RUN}/reportReviewEvents/`).map((p) => (db.read(p) as { type: string }).type).sort()).toEqual(["report_review_resubmitted", "report_review_submitted"]);
  });

  it("an open (undecided) cycle cannot be resubmitted, so a decision is never reset in place", async () => {
    await submit();
    expect(await resubmit(1)).toEqual({ ok: false, reason: "not_decided" });
    await db.doc(`runs/${RUN}`).update({ "reportReview.humanReview": { status: "pending" } });
    expect(await resubmit(1)).toEqual({ ok: false, reason: "not_decided" });
  });

  it("a stale expectedCycle is refused", async () => {
    await decidedCycle1WithAssignment();
    expect(await resubmit(2)).toEqual({ ok: false, reason: "cycle_conflict" });
    expect(await resubmit("1")).toEqual({ ok: false, reason: "cycle_conflict" });
    expect(rr()!.cycle).toBe(1);
  });

  it("archive write-once: if cycle 1's archive already exists, the whole resubmission fails and nothing changes", async () => {
    await decidedCycle1WithAssignment();
    const forged = { version: 1, cycle: 1, record: "pre-existing" };
    db.seed(`runs/${RUN}/reportReviewCycles/1`, forged);
    const before = db.read(`runs/${RUN}`);
    const beforeAssignment = db.read(`runs/${RUN}/humanReviewAssignment/current`);
    expect(await resubmit(1)).toEqual({ ok: false, reason: "write_failed" });
    expect(db.read(`runs/${RUN}/reportReviewCycles/1`)).toEqual(forged);
    expect(db.read(`runs/${RUN}`)).toEqual(before);
    expect(db.read(`runs/${RUN}/humanReviewAssignment/current`)).toEqual(beforeAssignment);
  });

  it("cycles 1 and 2 both stay archived after a third cycle starts", async () => {
    await decidedCycle1WithAssignment("rejected");
    await resubmit(1);
    await decide("approved");
    await resubmit(2, ADMIN);
    expect(rr()!.cycle).toBe(3);
    expect((db.read(`runs/${RUN}/reportReviewCycles/1`)!.record as ReportReviewRecordV1).humanReview.status).toBe("rejected");
    expect((db.read(`runs/${RUN}/reportReviewCycles/2`)!.record as ReportReviewRecordV1).humanReview.status).toBe("approved");
  });

  it("concurrent resubmissions of the same cycle: exactly one new cycle and one archive; the other is refused", async () => {
    await decidedCycle1WithAssignment();
    let second: Promise<unknown> | null = null;
    db.hooks.afterTxReads = async (attempt) => {
      if (second || attempt > 0) return;
      db.hooks.afterTxReads = undefined;
      second = resubmit(1, ADMIN, { code: "publication_review", note: null });
      await second;
    };
    const first = await resubmit(1);
    const results = [first, (await second) as Awaited<ReturnType<typeof resubmit>>];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "cycle_conflict" }]);
    expect(rr()!.cycle).toBe(2);
    expect(db.paths(`runs/${RUN}/reportReviewCycles/`)).toEqual([`runs/${RUN}/reportReviewCycles/1`]);
  });

  it("the reset is recorded in the shared assignment history (review B1-m3): reviewer → unassigned at the new revision", async () => {
    await decidedCycle1WithAssignment("rejected");
    await resubmit(1);
    expect(db.read(`runs/${RUN}/humanReviewAssignmentHistory/4`)).toEqual(
      expect.objectContaining({ runId: RUN, previousReviewerUserId: REVIEWER, newReviewerUserId: null, changedByUserId: MEMBER, workspaceId: W })
    );
  });

  it("a manual assignment racing the resubmission belongs to the DECIDED cycle: archived with it, then reset; both history entries kept", async () => {
    await submit();
    await decide("changes_requested", ADMIN);
    db.hooks.afterTxReads = async (attempt) => {
      if (attempt > 0) return;
      db.hooks.afterTxReads = undefined;
      // A manager assigns a reviewer between the resubmission's reads and its commit.
      const put = await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:50:00.000Z" });
      expect(put.ok).toBe(true);
    };
    const res = await resubmit(1);
    expect(res.ok).toBe(true);
    expect(db.stats.retries).toBeGreaterThan(0); // the resubmission re-ran on the new state
    expect((db.read(`runs/${RUN}/reportReviewCycles/1`)!.assignment as { assignedReviewerUserId: string }).assignedReviewerUserId).toBe(REVIEWER);
    expect(db.read(`runs/${RUN}/humanReviewAssignment/current`)).toEqual(expect.objectContaining({ assignedReviewerUserId: null, revision: 2, cycle: 2, source: "cycle_reset" }));
    expect(db.paths(`runs/${RUN}/humanReviewAssignmentHistory/`).sort()).toEqual([`runs/${RUN}/humanReviewAssignmentHistory/1`, `runs/${RUN}/humanReviewAssignmentHistory/2`]);
  });

  it("no history entry when no reviewer is removed: no assignment document, or one with nobody assigned (review N2)", async () => {
    await submit();
    await decide("approved");
    await resubmit(1); // no assignment document existed → reset writes revision 1, no history
    expect(db.paths(`runs/${RUN}/humanReviewAssignmentHistory/`)).toEqual([]);
    await decide("rejected");
    await resubmit(2, ADMIN); // the cycle-reset document has nobody assigned → still no history
    expect(db.paths(`runs/${RUN}/humanReviewAssignmentHistory/`)).toEqual([]);
    expect(db.read(`runs/${RUN}/humanReviewAssignment/current`)).toEqual(expect.objectContaining({ assignedReviewerUserId: null, revision: 2, cycle: 3 }));
  });

  it("a stale manual assignment attempt after the reset is refused (revision moved)", async () => {
    await decidedCycle1WithAssignment();
    await resubmit(1);
    const stale = await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 3, dueAt: null });
    expect(stale).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("resubmission still enforces authority: Reviewer and Viewer cannot; a run that became governed cannot", async () => {
    await decidedCycle1WithAssignment();
    expect(await resubmit(1, REVIEWER)).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(await resubmit(1, VIEWER)).toEqual({ ok: false, reason: "insufficient_capability" });
    await db.doc(`runs/${RUN}`).update({ adaptiveOutput: { version: 1 } });
    expect(await resubmit(1)).toEqual({ ok: false, reason: "ineligible", ineligible: "governed_run" });
    expect(rr()!.cycle).toBe(1);
  });
});

describe("snapshots never carry a report review", () => {
  it("Add to Team copies content fields only; reportReview and its history are not copied", () => {
    const built = buildTeamRunSnapshotPayload({
      source: { question: "Q?", userId: "u", createdAt: NOW, completedAt: NOW, runDocument: { perModel: [] }, reportReview: { version: 1 }, legacyAdaptiveOutput: { version: 1, schemaId: "generic" } },
      sourceRunId: "src",
      newRunId: "new",
      uid: MEMBER,
      workspaceId: W,
      projectId: "p1",
      now: NOW,
      nowIso: "2026-11-02T11:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(Object.keys(built.payload)).not.toContain("reportReview");
  });
});
