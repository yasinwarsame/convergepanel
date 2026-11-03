/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part B —
 * persistGovernanceRecord() tests. Mirrors persistAdaptiveOutput.spec.ts's
 * own mocking pattern (a fake `set()` spy standing in for Firestore) —
 * same file, same precedent, kept consistent rather than reinvented.
 */

// Research deletion integrity (2026-11-03): the write now runs in a transaction guarded by the deletion barrier, so the
// spec uses the shared transactional fake. `writes()` is the applied-write log, standing in for the old set() spy. A
// storage failure is injected at commit.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const writes = () => db.writeLog;
let commitAttempts = 0;
function failNextCommit(message: string) {
  db.hooks.failCommit = () => {
    commitAttempts++;
    db.hooks.failCommit = undefined;
    throw new Error(message);
  };
}

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { persistGovernanceRecord } from "@/lib/firestore/runs";
import { AdaptiveDecisionReceipt, GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

function receipt(): AdaptiveDecisionReceipt {
  return {
    conclusion: "The panel recommends option A.",
    basis: ["Criterion 1 favors option A."],
    assumptions: [],
    uncertainties: [],
    limitations: [],
    sources: [],
    sourceBacked: false,
    humanReviewNeeded: false,
  };
}

function record(overrides: Partial<GovernanceRecordV1> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: receipt(),
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("persistGovernanceRecord", () => {
  beforeEach(() => {
    db.docs.clear();
    db.hooks = {};
    db.writeLog = [];
    commitAttempts = 0;
    for (const id of ["run-123", "run-456", "run-789"]) db.seed(`runs/${id}`, { userId: "u1", question: "q" });
  });
  afterEach(() => jest.clearAllMocks());

  it("writes only { governanceRecord } with merge semantics, scoped to the run's own document", async () => {
    const rec = record();

    const outcome = await persistGovernanceRecord("run-123", rec);

    expect(outcome).toEqual({ saved: true });
    expect(writes()).toEqual([{ kind: "merge", path: "runs/run-123", data: { governanceRecord: rec }, via: "tx" }]);
    expect(db.read("runs/run-123")).toEqual({ userId: "u1", question: "q", governanceRecord: rec }); // siblings kept
  });

  it("preserves sibling fields by construction — the write payload contains no other top-level key", async () => {
    await persistGovernanceRecord("run-123", record());

    const payload = writes()[0].data;
    expect(Object.keys(payload)).toEqual(["governanceRecord"]);
  });

  it("omits (does not write) when the record would exceed the document-size safety budget", async () => {
    const oversized = record({
      decisionReceipt: receipt() && { ...receipt(), basis: ["x".repeat(2_000_000)] },
    });

    const outcome = await persistGovernanceRecord("run-456", oversized);

    expect(outcome).toEqual({ saved: false, reason: "oversized" });
    expect(writes()).toEqual([]);
  });

  it("catches a write failure and returns a safe failure result rather than throwing", async () => {
    failNextCommit("Firestore unavailable");
    const outcome = await persistGovernanceRecord("run-789", record());

    expect(outcome).toEqual({ saved: false, reason: "write_failed" });
    expect(writes()).toEqual([]);
  });

  it("never retries after a write failure", async () => {
    failNextCommit("Firestore unavailable");
    await persistGovernanceRecord("run-789", record());

    expect(commitAttempts).toBe(1); // one commit attempt, which failed
    expect(writes()).toEqual([]); // and no second (retried) write
  });

  it("uses logger, not console, for the oversized and write-failure paths", async () => {
    const oversized = record({ decisionReceipt: { ...receipt(), basis: ["x".repeat(2_000_000)] } });
    await persistGovernanceRecord("run-456", oversized);
    expect(mockLoggerWarn).toHaveBeenCalled();

    mockLoggerWarn.mockClear();
    failNextCommit("boom");
    await persistGovernanceRecord("run-789", record());
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("never logs decision receipt content, source strings, or reviewer data", async () => {
    const rec = record({
      decisionReceipt: { ...receipt(), conclusion: "SECRET CONCLUSION TEXT", sources: ["https://secret-source.example"] },
      humanReview: { status: "approved", reviewerName: "Reviewer Name", comment: "SECRET COMMENT" },
    });
    const oversizedRec = { ...rec, decisionReceipt: { ...rec.decisionReceipt, basis: ["x".repeat(2_000_000)] } };
    await persistGovernanceRecord("run-456", oversizedRec);

    failNextCommit("boom");
    await persistGovernanceRecord("run-789", rec);

    const allLoggedText = JSON.stringify([...mockLoggerWarn.mock.calls, ...mockLoggerError.mock.calls]);
    expect(allLoggedText).not.toContain("SECRET CONCLUSION TEXT");
    expect(allLoggedText).not.toContain("secret-source.example");
    expect(allLoggedText).not.toContain("Reviewer Name");
    expect(allLoggedText).not.toContain("SECRET COMMENT");
  });

  it("does not write to teamRuns or governanceEvents or an admin audit log", async () => {
    await persistGovernanceRecord("run-123", record());

    // Exactly one applied write, to the run's own document. (The barrier READS runDeletionJobs/{runId}; it writes
    // nothing there.)
    expect(writes().map((w) => w.path)).toEqual(["runs/run-123"]);
    expect(writes().some((w) => /^(teamRuns|admin_audit_logs)\//.test(w.path) || w.path.includes("/governanceEvents/"))).toBe(false);
  });

  it("returns firestore_unavailable without attempting a write when adminDb is not configured", async () => {
    jest.resetModules();
    jest.doMock("@/lib/firebase/admin", () => ({ adminDb: null }));
    jest.doMock("@/lib/logger", () => ({
      logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
    }));

    const { persistGovernanceRecord: persistWithNoAdminDb } = await import("@/lib/firestore/runs");
    const outcome = await persistWithNoAdminDb("run-999", record());

    expect(outcome).toEqual({ saved: false, reason: "firestore_unavailable" });

    jest.resetModules();
  });

  it("deletion barrier: a run that is deleted, being deleted or missing gets no governance record", async () => {
    db.seed("runDeletionJobs/run-123", { state: "complete" });
    db.seed("runs/run-456", { userId: "u1", deletion: { state: "pending" } });
    for (const id of ["run-123", "run-456", "run-none"]) expect(await persistGovernanceRecord(id, record())).toEqual({ saved: false, reason: "write_failed" });
    expect(writes()).toEqual([]);
    expect(db.read("runs/run-none")).toBeUndefined();
  });
});
