/**
 * Immutable Adaptive Review History and Admin Audit Integration —
 * repairAdaptiveReviewArtifacts() tests.
 */

const runDocs = new Map<string, Record<string, any>>();
const historyDocs = new Map<string, Record<string, any>>();
const auditDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

function alreadyExistsError() {
  const err: any = new Error("6 ALREADY_EXISTS");
  err.code = 6;
  return err;
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (name === "runs") return { exists: runDocs.has(id), data: () => runDocs.get(id) };
        throw new Error("unexpected get");
      }),
      collection: (subName: string) => ({
        doc: (docId: string) => ({
          create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
            const store = subName === "humanReviewHistory" ? historyDocs : auditDocs;
            const key = `${id}/${subName}/${docId}`;
            if (store.has(key)) throw alreadyExistsError();
            store.set(key, value);
          }),
        }),
      }),
      create: jest.fn(),
    }),
  }),
};

// admin_audit_logs writes go through `.collection("admin_audit_logs").doc(id).create()`
// directly (top-level), not a subcollection of runs — patch that path distinctly.
const originalCollectionFn = mockAdminDb.collection;
mockAdminDb.collection = (name: string) => {
  if (name === "admin_audit_logs") {
    return {
      doc: (docId: string) => ({
        create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
          const key = `admin_audit_logs/${docId}`;
          if (auditDocs.has(key)) throw alreadyExistsError();
          auditDocs.set(key, value);
        }),
      }),
    };
  }
  return originalCollectionFn(name);
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

import { repairAdaptiveReviewArtifacts } from "@/lib/governance/adaptiveReviewArtifactRepair";
import { buildAdaptiveReviewDecisionId } from "@/lib/governance/adaptiveHumanReviewHistory";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "approved", reviewerId: "reviewer-uid", reviewedAt: "2026-07-30T00:00:00.000Z" },
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
  historyDocs.clear();
  auditDocs.clear();
  firestoreUnavailableFlag.value = false;
  consoleErrorSpy.mockClear();
});

describe("repairAdaptiveReviewArtifacts", () => {
  it("creates missing history and audit for a terminal record", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("repaired");
    expect(result.historyStatus).toBe("recorded");
    expect(result.auditStatus).toBe("recorded");

    const decisionId = buildAdaptiveReviewDecisionId(TEAM_ID, RUN_ID, "2026-07-30T00:00:00.000Z", "approved");
    expect(historyDocs.get(`${RUN_ID}/humanReviewHistory/${decisionId}`)).toBeDefined();
    expect(auditDocs.get(`admin_audit_logs/adaptive-review:${decisionId}`)).toBeDefined();
  });

  it("existing history is never overwritten by a second repair run", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    const decisionId = buildAdaptiveReviewDecisionId(TEAM_ID, RUN_ID, "2026-07-30T00:00:00.000Z", "approved");
    const storedAfterFirst = { ...historyDocs.get(`${RUN_ID}/humanReviewHistory/${decisionId}`) };

    const second = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(second.status).toBe("already_complete");
    expect(second.historyStatus).toBe("already_exists");
    expect(second.auditStatus).toBe("already_exists");
    expect(historyDocs.get(`${RUN_ID}/humanReviewHistory/${decisionId}`)).toEqual(storedAfterFirst);
  });

  it("creates only the missing artifact when one already exists", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const decisionId = buildAdaptiveReviewDecisionId(TEAM_ID, RUN_ID, "2026-07-30T00:00:00.000Z", "approved");
    // Pre-seed only the audit entry.
    auditDocs.set(`admin_audit_logs/adaptive-review:${decisionId}`, { action: "adaptive_human_review_decided" });

    const result = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(result.historyStatus).toBe("recorded");
    expect(result.auditStatus).toBe("already_exists");
    expect(result.status).toBe("repaired");
  });

  it("does not repair a non-terminal (unreviewed/pending) record", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "unreviewed" } }) });
    const result = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "not_terminal" });
    expect(historyDocs.size).toBe(0);
    expect(auditDocs.size).toBe(0);
  });

  it("fails closed on a missing parent run", async () => {
    const result = await repairAdaptiveReviewArtifacts("does-not-exist", TEAM_ID);
    expect(result).toEqual({ status: "run_missing" });
  });

  it("fails closed on a malformed governanceRecord", async () => {
    runDocs.set(RUN_ID, { governanceRecord: { version: 1, garbage: true } });
    const result = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "governance_record_unavailable" });
  });

  it("fails closed on an unsupported governanceRecord version", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ version: 2 }) });
    const result = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "governance_record_unavailable" });
  });

  it("never modifies the canonical governanceRecord", async () => {
    const original = governanceRecord();
    runDocs.set(RUN_ID, { governanceRecord: { ...original } });
    await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(runDocs.get(RUN_ID)!.governanceRecord).toEqual(original);
  });

  it("never reopens a terminal review (no write path exists to humanReview at all in this function)", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.status).toBe("approved");
  });

  it("returns firestore_unavailable safely without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await repairAdaptiveReviewArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});
