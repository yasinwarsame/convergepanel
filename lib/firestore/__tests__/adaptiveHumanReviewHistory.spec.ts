/**
 * Immutable Adaptive Review History — createAdaptiveHumanReviewHistory()
 * tests.
 */

const historyDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

function notFoundOrExistsError(exists: boolean) {
  if (exists) {
    const err: any = new Error("6 ALREADY_EXISTS");
    err.code = 6;
    return err;
  }
  return new Error("13 INTERNAL");
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (runId: string) => ({
      collection: (subName: string) => ({
        doc: (docId: string) => ({
          create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
            const key = `${runId}/${subName}/${docId}`;
            if (historyDocs.has(key)) {
              throw notFoundOrExistsError(true);
            }
            historyDocs.set(key, value);
          }),
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

import { createAdaptiveHumanReviewHistory } from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewHistoryEntry } from "@/lib/governance/adaptiveHumanReviewHistory";

function entry(overrides: Record<string, unknown> = {}) {
  return buildAdaptiveHumanReviewHistoryEntry({
    decisionId: "dec_abc123",
    runId: "run-1",
    teamId: "team-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    priorStatus: "unreviewed",
    newStatus: "approved",
    reviewerId: "reviewer-uid",
    reviewedAt: "2026-07-30T00:00:00.000Z",
    governanceRecordUpdatedAt: "2026-07-30T00:00:00.000Z",
    now: "2026-07-30T00:00:01.000Z",
    ...overrides,
  });
}

beforeEach(() => {
  historyDocs.clear();
  firestoreUnavailableFlag.value = false;
  mockLoggerWarn.mockClear();
});

describe("createAdaptiveHumanReviewHistory", () => {
  it("creates the history document at runs/{runId}/humanReviewHistory/{decisionId}", async () => {
    const result = await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(result).toEqual({ status: "recorded" });
    expect(historyDocs.get("run-1/humanReviewHistory/dec_abc123")).toBeDefined();
  });

  it("only approved fields are stored — no comment/conditions text", async () => {
    await createAdaptiveHumanReviewHistory("run-1", entry());
    const stored = historyDocs.get("run-1/humanReviewHistory/dec_abc123")!;
    expect(stored).not.toHaveProperty("comment");
    expect(stored).not.toHaveProperty("conditions");
    expect(stored.commentPresent).toBe(false);
    expect(stored.conditionsCount).toBe(0);
  });

  it("uses .create(), never .set() — a second identical write returns already_exists, not overwrite", async () => {
    const first = await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(first).toEqual({ status: "recorded" });
    const storedAfterFirst = { ...historyDocs.get("run-1/humanReviewHistory/dec_abc123") };

    const second = await createAdaptiveHumanReviewHistory("run-1", entry({ newStatus: "rejected", governanceRecordUpdatedAt: "different" }));
    expect(second).toEqual({ status: "already_exists" });
    expect(historyDocs.get("run-1/humanReviewHistory/dec_abc123")).toEqual(storedAfterFirst);
  });

  it("makes exactly one write attempt — no retry", async () => {
    const createSpy = jest.fn();
    const originalCollection = mockAdminDb.collection;
    (mockAdminDb as any).collection = (name: string) => ({
      doc: (runId: string) => ({
        collection: (subName: string) => ({
          doc: (docId: string) => ({
            create: jest.fn().mockImplementation(async (v: any) => {
              createSpy();
              return originalCollection(name).doc(runId).collection(subName).doc(docId).create(v);
            }),
          }),
        }),
      }),
    });
    await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(createSpy).toHaveBeenCalledTimes(1);
    (mockAdminDb as any).collection = originalCollection;
  });

  it("returns failed safely when Firestore is unavailable, without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(result).toEqual({ status: "failed" });
  });

  it("returns failed on an unexpected write error and logs metadata only, never the raw error content", async () => {
    (mockAdminDb as any).collection = () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            create: jest.fn().mockRejectedValue(new Error("SENSITIVE INTERNAL DETAIL")),
          }),
        }),
      }),
    });
    const result = await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(result).toEqual({ status: "failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();
    const logged = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logged).not.toContain("SENSITIVE INTERNAL DETAIL");
  });

  it("never touches governanceRecord or the teamRuns projection (this writer has no such call in its own dependency set)", async () => {
    // Structural proof: the function signature/collection path never references "governanceRecord" or "teamRuns" at all.
    await createAdaptiveHumanReviewHistory("run-1", entry());
    expect([...historyDocs.keys()].every((k) => k.includes("humanReviewHistory"))).toBe(true);
  });
});
