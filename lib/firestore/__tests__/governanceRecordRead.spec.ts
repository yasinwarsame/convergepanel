/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part C —
 * readGovernanceRecordForInitialization() tests. Mirrors
 * persistAdaptiveOutput.spec.ts / governanceRecordPersistence.spec.ts's own
 * mocking pattern (a fake Firestore doc/collection, no emulator).
 */

const mockGet = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockGet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: mockCollection },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { readGovernanceRecordForInitialization } from "@/lib/firestore/runs";

describe("readGovernanceRecordForInitialization", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns found with the raw governanceRecord value when present", async () => {
    const rawRecord = { version: 1, schemaId: "decision_support", humanReview: { status: "unreviewed" } };
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ governanceRecord: rawRecord }) });

    const result = await readGovernanceRecordForInitialization("run-123");

    expect(result).toEqual({ status: "found", value: rawRecord });
    expect(mockCollection).toHaveBeenCalledWith("runs");
    expect(mockDoc).toHaveBeenCalledWith("run-123");
  });

  it("returns absent when the document exists but has no governanceRecord field", async () => {
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ adaptiveOutput: {} }) });
    const result = await readGovernanceRecordForInitialization("run-123");
    expect(result).toEqual({ status: "absent" });
  });

  it("returns absent when governanceRecord is explicitly null", async () => {
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ governanceRecord: null }) });
    const result = await readGovernanceRecordForInitialization("run-123");
    expect(result).toEqual({ status: "absent" });
  });

  it("returns run_missing (not absent) when the run document itself doesn't exist", async () => {
    mockGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const result = await readGovernanceRecordForInitialization("run-does-not-exist");
    expect(result).toEqual({ status: "run_missing" });
  });

  it("run_missing is a distinct status from absent — a missing run must never be reported the same as an existing run with no governanceRecord field", async () => {
    mockGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const missingRun = await readGovernanceRecordForInitialization("run-missing");
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({}) });
    const existingRunNoField = await readGovernanceRecordForInitialization("run-exists");

    expect(missingRun.status).toBe("run_missing");
    expect(existingRunNoField.status).toBe("absent");
    expect(missingRun.status).not.toBe(existingRunNoField.status);
  });

  it("returns firestore_unavailable without attempting a read when adminDb is not configured", async () => {
    jest.resetModules();
    jest.doMock("@/lib/firebase/admin", () => ({ adminDb: null }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

    const { readGovernanceRecordForInitialization: readWithNoAdminDb } = await import("@/lib/firestore/runs");
    const result = await readWithNoAdminDb("run-999");

    expect(result).toEqual({ status: "firestore_unavailable" });
    jest.resetModules();
  });

  it("catches a read error and returns read_failed rather than throwing", async () => {
    mockGet.mockRejectedValueOnce(new Error("Firestore unavailable"));
    const result = await readGovernanceRecordForInitialization("run-123");
    expect(result).toEqual({ status: "read_failed" });
  });

  it("never retries after a read error", async () => {
    mockGet.mockRejectedValueOnce(new Error("boom"));
    await readGovernanceRecordForInitialization("run-123");
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("uses logger, not console, on a read failure", async () => {
    mockGet.mockRejectedValueOnce(new Error("boom"));
    await readGovernanceRecordForInitialization("run-123");
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("never logs the record's own content, reviewer data, or receipt text", async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        governanceRecord: {
          decisionReceipt: { conclusion: "SECRET CONCLUSION TEXT", sources: ["https://secret-source.example"] },
          humanReview: { status: "approved", reviewerName: "Reviewer Name", comment: "SECRET COMMENT" },
        },
      }),
    });
    await readGovernanceRecordForInitialization("run-123");

    mockGet.mockRejectedValueOnce(new Error("boom"));
    await readGovernanceRecordForInitialization("run-456");

    const loggedText = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(loggedText).not.toContain("SECRET CONCLUSION TEXT");
    expect(loggedText).not.toContain("secret-source.example");
    expect(loggedText).not.toContain("Reviewer Name");
    expect(loggedText).not.toContain("SECRET COMMENT");
  });

  it("does not return the full run document — only extracts the one field", async () => {
    const fullDoc = {
      governanceRecord: { version: 1, schemaId: "decision_support" },
      adaptiveOutput: { version: 1, huge: "x".repeat(1000) },
      runDocument: { perModel: [] },
      userId: "user-abc",
    };
    mockGet.mockResolvedValueOnce({ exists: true, data: () => fullDoc });

    const result = await readGovernanceRecordForInitialization("run-123");

    expect(result).toEqual({ status: "found", value: fullDoc.governanceRecord });
    if (result.status === "found") {
      expect(result.value).not.toHaveProperty("adaptiveOutput");
      expect(result.value).not.toHaveProperty("userId");
    }
  });
});
