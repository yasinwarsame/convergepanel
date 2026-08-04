/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part B —
 * persistGovernanceRecord() tests. Mirrors persistAdaptiveOutput.spec.ts's
 * own mocking pattern (a fake `set()` spy standing in for Firestore) —
 * same file, same precedent, kept consistent rather than reinvented.
 */

const mockSet = jest.fn();
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: mockCollection },
}));

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
  afterEach(() => jest.clearAllMocks());

  it("writes only { governanceRecord } with merge semantics, scoped to the run's own document", async () => {
    mockSet.mockResolvedValueOnce(undefined);
    const rec = record();

    const outcome = await persistGovernanceRecord("run-123", rec);

    expect(outcome).toEqual({ saved: true });
    expect(mockCollection).toHaveBeenCalledWith("runs");
    expect(mockDoc).toHaveBeenCalledWith("run-123");
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ governanceRecord: rec }, { merge: true });
  });

  it("preserves sibling fields by construction — the write payload contains no other top-level key", async () => {
    mockSet.mockResolvedValueOnce(undefined);
    await persistGovernanceRecord("run-123", record());

    const [payload] = mockSet.mock.calls[0];
    expect(Object.keys(payload)).toEqual(["governanceRecord"]);
  });

  it("omits (does not write) when the record would exceed the document-size safety budget", async () => {
    const oversized = record({
      decisionReceipt: receipt() && { ...receipt(), basis: ["x".repeat(2_000_000)] },
    });

    const outcome = await persistGovernanceRecord("run-456", oversized);

    expect(outcome).toEqual({ saved: false, reason: "oversized" });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("catches a write failure and returns a safe failure result rather than throwing", async () => {
    mockSet.mockRejectedValueOnce(new Error("Firestore unavailable"));
    const outcome = await persistGovernanceRecord("run-789", record());

    expect(outcome).toEqual({ saved: false, reason: "write_failed" });
  });

  it("never retries after a write failure", async () => {
    mockSet.mockRejectedValueOnce(new Error("Firestore unavailable"));
    await persistGovernanceRecord("run-789", record());

    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it("uses logger, not console, for the oversized and write-failure paths", async () => {
    const oversized = record({ decisionReceipt: { ...receipt(), basis: ["x".repeat(2_000_000)] } });
    await persistGovernanceRecord("run-456", oversized);
    expect(mockLoggerWarn).toHaveBeenCalled();

    mockLoggerWarn.mockClear();
    mockSet.mockRejectedValueOnce(new Error("boom"));
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

    mockSet.mockRejectedValueOnce(new Error("boom"));
    await persistGovernanceRecord("run-789", rec);

    const allLoggedText = JSON.stringify([...mockLoggerWarn.mock.calls, ...mockLoggerError.mock.calls]);
    expect(allLoggedText).not.toContain("SECRET CONCLUSION TEXT");
    expect(allLoggedText).not.toContain("secret-source.example");
    expect(allLoggedText).not.toContain("Reviewer Name");
    expect(allLoggedText).not.toContain("SECRET COMMENT");
  });

  it("does not write to teamRuns or governanceEvents or an admin audit log", async () => {
    mockSet.mockResolvedValueOnce(undefined);
    await persistGovernanceRecord("run-123", record());

    expect(mockCollection).not.toHaveBeenCalledWith("teamRuns");
    expect(mockCollection).not.toHaveBeenCalledWith("governanceEvents");
    expect(mockCollection).not.toHaveBeenCalledWith("admin_audit_logs");
    expect(mockCollection).toHaveBeenCalledTimes(1);
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
});
