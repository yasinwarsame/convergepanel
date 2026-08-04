/**
 * Multi-Reviewer Owner Override, Part F —
 * createAdaptivePanelOverrideHistory() and
 * writeAdaptivePanelOverrideGovernanceEvent() tests.
 */

const docs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

function alreadyExistsError() {
  const err: any = new Error("6 ALREADY_EXISTS");
  err.code = 6;
  return err;
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (runId: string) => ({
      collection: (subName: string) => ({
        doc: (docId: string) => ({
          create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
            const key = `${name}/${runId}/${subName}/${docId}`;
            if (docs.has(key)) throw alreadyExistsError();
            docs.set(key, value);
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

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createAdaptivePanelOverrideHistory, writeAdaptivePanelOverrideGovernanceEvent } from "@/lib/firestore/runs";
import { buildAdaptivePanelOverrideHistoryEntry } from "@/lib/governance/adaptivePanelOverride";

beforeEach(() => {
  docs.clear();
  firestoreUnavailableFlag.value = false;
});

describe("createAdaptivePanelOverrideHistory", () => {
  const entry = buildAdaptivePanelOverrideHistoryEntry({
    teamId: "team-1",
    runId: "run-1",
    preOverridePanelRevision: 1,
    overriddenPanelRevision: 2,
    finalStatus: "approved",
    finalDecisionId: "panel_override_dec_x",
    overrideByUserId: "owner-uid",
    conditionsCount: 0,
    finalizedAt: "2020-06-01T00:00:00.000Z",
  });

  it("writes a metadata-only entry with a deterministic eventId, in the shared humanReviewPanelHistory subcollection", async () => {
    const result = await createAdaptivePanelOverrideHistory("run-1", entry);
    expect(result).toEqual({ status: "recorded" });
    expect(docs.get("runs/run-1/humanReviewPanelHistory/2:panel_owner_overridden")).toEqual(entry);
  });

  it("never includes the raw justification text or any vote/comment content", () => {
    expect(JSON.stringify(entry).toLowerCase()).not.toContain("justification:");
    for (const forbidden of ["comment", "condition:", "email", "reviewerName", "voteText"]) {
      expect(JSON.stringify(entry).toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("a retried write with the same eventId is idempotent — reports already_exists, never a duplicate", async () => {
    const first = await createAdaptivePanelOverrideHistory("run-1", entry);
    expect(first).toEqual({ status: "recorded" });
    const second = await createAdaptivePanelOverrideHistory("run-1", entry);
    expect(second).toEqual({ status: "already_exists" });
    expect(docs.size).toBe(1);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createAdaptivePanelOverrideHistory("run-1", entry);
    expect(result).toEqual({ status: "failed" });
  });
});

describe("writeAdaptivePanelOverrideGovernanceEvent", () => {
  const args = {
    runId: "run-1",
    teamId: "team-1",
    schemaId: "decision_support" as any,
    answerShape: "decision_support_view" as any,
    finalStatus: "approved",
    finalDecisionId: "panel_override_dec_x",
    overrideByUserId: "owner-uid",
    finalizedAt: "2020-06-01T00:00:00.000Z",
  };

  it("writes with a deterministic ID derived from finalDecisionId, distinct from the aggregation event prefix", async () => {
    const result = await writeAdaptivePanelOverrideGovernanceEvent(args);
    expect(result).toEqual({ status: "recorded" });
    const stored = docs.get("runs/run-1/governanceEvents/panel-owner-overridden:panel_override_dec_x");
    expect(stored).toBeDefined();
    expect(stored!.action).toBe("multi_reviewer_panel_owner_overridden");
    expect(stored!.byUid).toBe("owner-uid");
  });

  it("a retried write with the same finalDecisionId is idempotent", async () => {
    const first = await writeAdaptivePanelOverrideGovernanceEvent(args);
    expect(first).toEqual({ status: "recorded" });
    const second = await writeAdaptivePanelOverrideGovernanceEvent({ ...args, finalStatus: "rejected" });
    expect(second).toEqual({ status: "already_exists" });
    expect(docs.size).toBe(1);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptivePanelOverrideGovernanceEvent(args);
    expect(result).toEqual({ status: "failed" });
  });
});
