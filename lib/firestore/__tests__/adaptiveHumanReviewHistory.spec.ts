/**
 * Immutable Adaptive Review History — createAdaptiveHumanReviewHistory()
 * tests.
 */

// Research deletion integrity (2026-11-03): the history entry is now created in a transaction guarded by the deletion
// barrier, so the spec uses the shared transactional fake (create() exclusivity included). `historyDocs` is a read-only
// view of the same keys the old stub map used (`{runId}/humanReviewHistory/{decisionId}`).
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
const firestoreUnavailableFlag = { value: false };
const historyDocs = {
  get: (key: string) => db.read(`runs/${key}`) as Record<string, any> | undefined,
  keys: () => db.paths("runs/").filter((p) => p.split("/").length > 2).map((p) => p.slice("runs/".length)),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : db;
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
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.stats = { commits: 0, retries: 0, aborted: 0 };
  db.seed("runs/run-1", { userId: "owner" });
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
    await createAdaptiveHumanReviewHistory("run-1", entry());
    // One committed create of the document, one transaction, no retry.
    expect(db.writeLog.filter((w) => w.path === "runs/run-1/humanReviewHistory/dec_abc123")).toEqual([expect.objectContaining({ kind: "create", via: "tx" })]);
    expect(db.stats).toEqual({ commits: 1, retries: 0, aborted: 0 });
  });

  it("returns failed safely when Firestore is unavailable, without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(result).toEqual({ status: "failed" });
  });

  it("returns failed on an unexpected write error and logs metadata only, never the raw error content", async () => {
    db.hooks.failCommit = () => {
      throw new Error("SENSITIVE INTERNAL DETAIL");
    };
    const result = await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(result).toEqual({ status: "failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();
    const logged = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logged).not.toContain("SENSITIVE INTERNAL DETAIL");
  });

  it("never touches governanceRecord or the teamRuns projection (this writer has no such call in its own dependency set)", async () => {
    // Structural proof: the function signature/collection path never references "governanceRecord" or "teamRuns" at all.
    await createAdaptiveHumanReviewHistory("run-1", entry());
    expect(historyDocs.keys().length).toBeGreaterThan(0);
    expect(historyDocs.keys().every((k) => k.includes("humanReviewHistory"))).toBe(true);
  });

  it("deletion barrier: a run that is deleted, being deleted or missing gets no history entry", async () => {
    for (const setup of [() => db.seed("runDeletionJobs/run-1", { state: "failed" }), () => db.seed("runs/run-1", { deletion: { state: "pending" } }), () => db.docs.delete("runs/run-1")]) {
      db.docs.clear();
      db.seed("runs/run-1", { userId: "owner" });
      setup();
      expect(await createAdaptiveHumanReviewHistory("run-1", entry())).toEqual({ status: "failed" });
      expect(historyDocs.keys()).toEqual([]);
    }
  });
});
