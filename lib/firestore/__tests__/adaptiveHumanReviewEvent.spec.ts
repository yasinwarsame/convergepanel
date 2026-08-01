/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D —
 * writeAdaptiveHumanReviewEvent() tests (docs/governance-decision-receipts-design.md §21.10).
 */

const eventsByRunId = new Map<string, Record<string, unknown>[]>();
const firestoreUnavailableFlag = { value: false };
const addMock = jest.fn();

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      collection: (subName: string) => ({
        add: jest.fn().mockImplementation(async (event: Record<string, unknown>) => {
          addMock(name, id, subName, event);
          const key = `${id}/${subName}`;
          const existing = eventsByRunId.get(key) || [];
          existing.push(event);
          eventsByRunId.set(key, existing);
          return { id: `event-${existing.length}` };
        }),
      }),
    }),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { writeAdaptiveHumanReviewEvent } from "@/lib/firestore/runs";

beforeEach(() => {
  eventsByRunId.clear();
  firestoreUnavailableFlag.value = false;
  addMock.mockClear();
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
    expect(addMock).toHaveBeenCalledTimes(1);
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
    expect(addMock).not.toHaveBeenCalled();
  });

  it("returns write_failed without throwing on an unexpected Firestore error", async () => {
    (mockAdminDb as any).collection = () => ({
      doc: () => ({
        collection: () => ({
          add: jest.fn().mockRejectedValue(new Error("boom")),
        }),
      }),
    });
    const result = await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    expect(result).toEqual({ written: false, reason: "write_failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("never writes to admin_audit_logs", async () => {
    await writeAdaptiveHumanReviewEvent(BASE_ARGS);
    for (const call of addMock.mock.calls) {
      expect(call[2]).not.toBe("admin_audit_logs");
    }
  });
});
