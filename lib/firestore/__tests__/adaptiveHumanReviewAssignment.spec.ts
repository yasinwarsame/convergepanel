/**
 * Part E3 — submitAdaptiveHumanReviewAssignment() / getAdaptiveHumanReviewAssignment()
 * / createAdaptiveHumanReviewAssignmentHistory() tests.
 */

// Research deletion integrity (2026-11-03): the assignment-history writer now creates its entry in a transaction guarded
// by the deletion barrier. The previous double was a single-attempt transaction that told refs apart by tags, and it
// could not represent the tombstone or the run read. It is replaced by the shared transactional fake, which models
// read-before-write, conflicts, retries and create() exclusivity. The three stores keep their original keys
// (`${runId}/${docId}`) as views over it.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
import { runDocView, storeView } from "@/lib/workspaces/__tests__/helpers/fakeStoreViews";
const db = new FakeTransactionalFirestore();
const subView = (sub: string) =>
  storeView(
    db,
    (k) => {
      const [runId, docId] = k.split("/");
      return `runs/${runId}/${sub}/${docId}`;
    },
    (p) => {
      const m = /^runs\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
      return m && m[2] === sub ? `${m[1]}/${m[3]}` : null;
    }
  );
const runDocs = runDocView(db);
const assignmentDocs = subView("humanReviewAssignment");
const assignmentHistoryDocs = subView("humanReviewAssignmentHistory");
const firestoreUnavailableFlag = { value: false };

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : db;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  submitAdaptiveHumanReviewAssignment,
  getAdaptiveHumanReviewAssignment,
  createAdaptiveHumanReviewAssignmentHistory,
} from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewAssignmentHistoryEntry } from "@/lib/governance/adaptiveHumanReviewAssignment";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "x",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  runDocs.clear();
  assignmentDocs.clear();
  assignmentHistoryDocs.clear();
  firestoreUnavailableFlag.value = false;
});

describe("submitAdaptiveHumanReviewAssignment", () => {
  it("assigns a reviewer for the first time (revision 0 -> 1)", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
      now: "2026-07-30T01:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.assignedReviewerUserId).toBe("reviewer-uid");
      expect(result.assignment.revision).toBe(1);
      expect(result.previousReviewerUserId).toBeNull();
    }
  });

  it("reassigns (revision N -> N+1), reporting the correct previousReviewerUserId", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    assignmentDocs.set(`${RUN_ID}/current`, {
      schemaVersion: 1,
      teamId: TEAM_ID,
      runId: RUN_ID,
      assignedReviewerUserId: "reviewer-a",
      assignedAt: "x",
      assignedByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      revision: 1,
    });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-b",
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.assignedReviewerUserId).toBe("reviewer-b");
      expect(result.assignment.revision).toBe(2);
      expect(result.previousReviewerUserId).toBe("reviewer-a");
    }
  });

  it("unassigns (newReviewerUserId: null)", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    assignmentDocs.set(`${RUN_ID}/current`, {
      schemaVersion: 1,
      teamId: TEAM_ID,
      runId: RUN_ID,
      assignedReviewerUserId: "reviewer-a",
      assignedAt: "x",
      assignedByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      revision: 1,
    });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: null,
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.assignedReviewerUserId).toBeNull();
    }
  });

  it("rejects a stale expectedRevision", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    assignmentDocs.set(`${RUN_ID}/current`, {
      schemaVersion: 1,
      teamId: TEAM_ID,
      runId: RUN_ID,
      assignedReviewerUserId: "reviewer-a",
      assignedAt: "x",
      assignedByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      revision: 2,
    });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-b",
      actorUserId: "admin-uid",
      expectedRevision: 1, // stale — real current revision is 2
    });
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("rejects assignment when the review is no longer pending", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });

  it("allows assignment while pending (status: pending, not just unreviewed)", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "pending" } }) });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed on a missing parent run", async () => {
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: "does-not-exist",
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "run_missing" });
  });

  it("fails closed on an absent governanceRecord", async () => {
    runDocs.set(RUN_ID, {});
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "governance_record_absent" });
  });

  it("fails closed on a malformed governanceRecord", async () => {
    runDocs.set(RUN_ID, { governanceRecord: { version: 1, garbage: true } });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "governance_record_malformed" });
  });

  it("returns firestore_unavailable safely", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });

  it("two concurrent mutations with the same expected revision: only the first commits", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const first = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-a",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    const second = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-b",
      actorUserId: "admin-uid",
      expectedRevision: 0, // now stale — the store already advanced to revision 1
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("two concurrent REASSIGNMENTS (both starting from the same non-zero revision): only the first commits", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    assignmentDocs.set(`${RUN_ID}/current`, {
      schemaVersion: 1,
      teamId: TEAM_ID,
      runId: RUN_ID,
      assignedReviewerUserId: "reviewer-a",
      assignedAt: "x",
      assignedByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      revision: 1,
    });
    const first = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-b",
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    const second = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-c",
      actorUserId: "admin-uid",
      expectedRevision: 1, // stale — the first reassignment already advanced the store to revision 2
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "stale_revision" });
    if (first.ok) expect(first.assignment.assignedReviewerUserId).toBe("reviewer-b");
  });

  /**
   * §7 / §9 — "protect against a race between completion and assignment
   * mutation". The transaction re-reads `governanceRecord.humanReview.status`
   * FRESH from the run document on every call (see the implementation
   * above) rather than trusting any pre-transaction check — so however the
   * race between a concurrent decision-commit and this assignment mutation
   * actually interleaves, whichever write's transaction observes the run
   * document LAST sees the true, up-to-date status. This test proves the
   * closure directly: the run is already terminal by the time this
   * transaction's own read fires (simulating a decision that committed
   * first), so the assignment mutation is rejected — it can never commit
   * against a stale "still pending" assumption.
   */
  it("closes the completion/assignment-mutation race: a run that has already gone terminal by transaction-read time is rejected, never silently allowed through", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved", reviewedAt: "2026-07-30T02:00:00.000Z" } }) });
    assignmentDocs.set(`${RUN_ID}/current`, {
      schemaVersion: 1,
      teamId: TEAM_ID,
      runId: RUN_ID,
      assignedReviewerUserId: "reviewer-a",
      assignedAt: "x",
      assignedByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      revision: 1,
    });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-b",
      actorUserId: "admin-uid",
      expectedRevision: 1, // matches the current assignment revision exactly — only the status changed
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
    // The assignment document itself must remain exactly as it was — no
    // partial or ghost write from the rejected transaction.
    expect(assignmentDocs.get(`${RUN_ID}/current`)!.assignedReviewerUserId).toBe("reviewer-a");
  });

  it("never mutates governanceRecord (structurally impossible — no such write path in this function)", async () => {
    const before = governanceRecord();
    runDocs.set(RUN_ID, { governanceRecord: { ...before } });
    await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: "reviewer-uid",
      actorUserId: "admin-uid",
      expectedRevision: 0,
    });
    expect(runDocs.get(RUN_ID)!.governanceRecord).toEqual(before);
  });
});

describe("getAdaptiveHumanReviewAssignment", () => {
  it("returns 'unassigned' when no document exists — the default, migration-free state", async () => {
    const result = await getAdaptiveHumanReviewAssignment(RUN_ID);
    expect(result).toEqual({ status: "unassigned" });
  });

  it("returns 'found' with the stored assignment when one exists", async () => {
    assignmentDocs.set(`${RUN_ID}/current`, {
      schemaVersion: 1,
      teamId: TEAM_ID,
      runId: RUN_ID,
      assignedReviewerUserId: "reviewer-uid",
      assignedAt: "x",
      assignedByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      revision: 1,
    });
    const result = await getAdaptiveHumanReviewAssignment(RUN_ID);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.assignment.assignedReviewerUserId).toBe("reviewer-uid");
    }
  });

  it("returns firestore_unavailable safely", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getAdaptiveHumanReviewAssignment(RUN_ID);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("createAdaptiveHumanReviewAssignmentHistory", () => {
  // History is written only for an existing, writable run (deletion barrier).
  beforeEach(() => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
  });

  it("deletion barrier: a run that is deleted, being deleted or missing gets no history entry", async () => {
    db.seed(`runDeletionJobs/${RUN_ID}`, { state: "in_progress" });
    expect(await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry())).toEqual({ status: "failed" });
    db.docs.delete(`runDeletionJobs/${RUN_ID}`);
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord(), deletion: { state: "pending" } });
    expect(await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry())).toEqual({ status: "failed" });
    runDocs.delete(RUN_ID);
    expect(await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry())).toEqual({ status: "failed" });
    expect(assignmentHistoryDocs.size).toBe(0);
  });

  function entry(overrides: Record<string, unknown> = {}) {
    return buildAdaptiveHumanReviewAssignmentHistoryEntry({
      teamId: TEAM_ID,
      runId: RUN_ID,
      previousReviewerUserId: null,
      newReviewerUserId: "reviewer-uid",
      assignmentRevision: 1,
      changedAt: "2026-07-30T00:00:00.000Z",
      changedByUserId: "admin-uid",
      ...overrides,
    });
  }

  it("creates the history document", async () => {
    const result = await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry());
    expect(result).toEqual({ status: "recorded" });
  });

  it("a retried write with the same eventId is idempotent, never overwriting", async () => {
    await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry());
    const storedAfterFirst = { ...assignmentHistoryDocs.get(`${RUN_ID}/1`) };
    const second = await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry({ newReviewerUserId: "different-uid" }));
    expect(second).toEqual({ status: "already_exists" });
    expect(assignmentHistoryDocs.get(`${RUN_ID}/1`)).toEqual(storedAfterFirst);
  });

  it("a distinct revision creates a distinct document", async () => {
    await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry({ assignmentRevision: 1 }));
    const result = await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry({ assignmentRevision: 2, previousReviewerUserId: "reviewer-uid", newReviewerUserId: "reviewer-2" }));
    expect(result).toEqual({ status: "recorded" });
    expect(assignmentHistoryDocs.size).toBe(2);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createAdaptiveHumanReviewAssignmentHistory(RUN_ID, entry());
    expect(result).toEqual({ status: "failed" });
  });
});
