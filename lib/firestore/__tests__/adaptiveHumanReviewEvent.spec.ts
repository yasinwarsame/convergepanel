/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D —
 * writeAdaptiveHumanReviewEvent() tests (docs/governance-decision-receipts-design.md §21.10).
 */

// Research deletion integrity (2026-11-03): the event is now created in a transaction guarded by the deletion barrier,
// so the spec uses the shared transactional fake. `addCalls()` lists the applied event writes as
// [collection, runId, subcollection, event], the same tuple the old add() spy recorded.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
const firestoreUnavailableFlag = { value: false };
const addCalls = () =>
  db.writeLog
    .filter((w) => w.kind === "create")
    .map((w) => {
      const [collectionName, docId, subName] = w.path.split("/");
      return [collectionName, docId, subName, w.data] as [string, string, string, Record<string, unknown>];
    });
const addMock = { get mock() { return { calls: addCalls() }; } };

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : db;
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { writeAdaptiveHumanReviewEvent } from "@/lib/firestore/runs";

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.seed("runs/run-1", { userId: "owner" });
  firestoreUnavailableFlag.value = false;
  mockLoggerWarn.mockClear();
});

const BASE_ARGS = {
  runId: "run-1",
  teamId: "team-1",
  schemaId: "decision_support" as const,
  answerShape: "decision_support_view" as const,
  reviewerId: "reviewer-uid",
  prevStatus: "unreviewed" as const,
  nextStatus: "approved" as const,
  at: "2026-07-30T00:00:00.000Z",
};

describe("writeAdaptiveHumanReviewEvent", () => {
  it("writes to runs/{runId}/governanceEvents with action 'human_review_decided'", async () => {
    const result = await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    expect(result).toEqual({ written: true });
    expect(addCalls()).toHaveLength(1);
    const [collectionName, docId, subName, event] = addMock.mock.calls[0];
    expect(collectionName).toBe("runs");
    expect(docId).toBe("run-1");
    expect(subName).toBe("governanceEvents");
    expect(event.action).toBe("human_review_decided");
  });

  it("contains only approved metadata: byUid, at, teamId, schemaId, answerShape, prevStatus, nextStatus", async () => {
    await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    const [, , , event] = addMock.mock.calls[0];
    expect(Object.keys(event).sort()).toEqual(
      ["action", "byUid", "at", "teamId", "schemaId", "answerShape", "prevStatus", "nextStatus"].sort()
    );
  });

  it("sets byUid to the server-derived reviewerId", async () => {
    await writeAdaptiveHumanReviewEvent({ ...BASE_ARGS, reviewerId: "specific-reviewer-uid" });
    const [, , , event] = addMock.mock.calls[0];
    expect(event.byUid).toBe("specific-reviewer-uid");
  });

  it("records prevStatus and nextStatus correctly", async () => {
    await writeAdaptiveHumanReviewEvent({ ...BASE_ARGS, prevStatus: "pending", nextStatus: "changes_requested" });
    const [, , , event] = addMock.mock.calls[0];
    expect(event.prevStatus).toBe("pending");
    expect(event.nextStatus).toBe("changes_requested");
  });

  it("never includes comment, conditions, receipt content, question text, or raw model output", async () => {
    await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    const [, , , event] = addMock.mock.calls[0];
    const serialized = JSON.stringify(event);
    for (const forbidden of ["comment", "conditions", "conclusion", "basis", "sources", "question", "rawModelOutput"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("uses the action value 'human_review_decided', distinct from automated evaluation's 'evaluated'", async () => {
    await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    const [, , , event] = addMock.mock.calls[0];
    expect(event.action).not.toBe("evaluated");
    expect(event.action).toBe("human_review_decided");
  });

  it("returns firestore_unavailable without throwing when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    expect(result).toEqual({ written: false, reason: "firestore_unavailable" });
    expect(addCalls()).toHaveLength(0);
  });

  it("returns write_failed without throwing on an unexpected Firestore error", async () => {
    db.hooks.failCommit = () => {
      throw new Error("boom");
    };
    const result = await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    expect(result).toEqual({ written: false, reason: "write_failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("never writes to admin_audit_logs", async () => {
    await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    for (const call of addMock.mock.calls) {
      expect(call[2]).not.toBe("admin_audit_logs");
    }
    expect(db.writeLog.filter((w) => w.path.startsWith("admin_audit_logs/"))).toEqual([]);
  });

  it("deletion barrier: a run that is deleted, being deleted or missing gets no event", async () => {
    for (const setup of [() => db.seed("runDeletionJobs/run-1", { state: "complete" }), () => db.seed("runs/run-1", { deletion: { state: "pending" } }), () => db.docs.delete("runs/run-1")]) {
      db.docs.clear();
      db.writeLog = [];
      db.seed("runs/run-1", { userId: "owner" });
      setup();
      expect(await writeAdaptiveHumanReviewEvent(BASE_ARGS)).toEqual({ written: false, reason: "write_failed" });
      expect(addCalls()).toHaveLength(0);
    }
  });
});
