/**
 * Multi-Reviewer Owner Override, Part F —
 * createAdaptivePanelOverrideHistory() and
 * writeAdaptivePanelOverrideGovernanceEvent() tests.
 */

// Research deletion integrity (2026-11-03): these writers now create their document in a transaction guarded by the
// deletion barrier, so the spec uses the shared transactional fake (which models transactions and create() exclusivity)
// instead of a create() stub. `storedDoc(path)` / `storedCount()` read the same documents the old stub map held.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
const firestoreUnavailableFlag = { value: false };
const storedDoc = (path: string) => db.read(path);
const storedCount = () => db.paths("runs/run-1/").length;

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : db;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createAdaptivePanelOverrideHistory, writeAdaptivePanelOverrideGovernanceEvent } from "@/lib/firestore/runs";
import { buildAdaptivePanelOverrideHistoryEntry } from "@/lib/governance/adaptivePanelOverride";

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.seed("runs/run-1", { userId: "owner-uid" });
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
    expect(storedDoc("runs/run-1/humanReviewPanelHistory/2:panel_owner_overridden")).toEqual(entry);
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
    expect(storedCount()).toBe(1);
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
    const stored = storedDoc("runs/run-1/governanceEvents/panel-owner-overridden:panel_override_dec_x");
    expect(stored).toBeDefined();
    expect(stored!.action).toBe("multi_reviewer_panel_owner_overridden");
    expect(stored!.byUid).toBe("owner-uid");
  });

  it("a retried write with the same finalDecisionId is idempotent", async () => {
    const first = await writeAdaptivePanelOverrideGovernanceEvent(args);
    expect(first).toEqual({ status: "recorded" });
    const second = await writeAdaptivePanelOverrideGovernanceEvent({ ...args, finalStatus: "rejected" });
    expect(second).toEqual({ status: "already_exists" });
    expect(storedCount()).toBe(1);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptivePanelOverrideGovernanceEvent(args);
    expect(result).toEqual({ status: "failed" });
  });
});

describe("deletion barrier (research deletion integrity)", () => {
  it("both writers refuse a run that is deleted, being deleted or missing, and create nothing", async () => {
    const entry = buildAdaptivePanelOverrideHistoryEntry({ teamId: "team-1", runId: "run-1", preOverridePanelRevision: 1, overriddenPanelRevision: 2, finalStatus: "approved", finalDecisionId: "d", overrideByUserId: "owner-uid", conditionsCount: 0, finalizedAt: "2020-06-01T00:00:00.000Z" });
    const args = { runId: "run-1", teamId: "team-1", schemaId: "decision_support" as any, answerShape: "decision_support_view" as any, finalStatus: "approved", finalDecisionId: "d", overrideByUserId: "owner-uid", finalizedAt: "t" };
    for (const setup of [() => db.seed("runDeletionJobs/run-1", { state: "in_progress" }), () => db.seed("runs/run-1", { deletion: { state: "pending" } }), () => db.docs.delete("runs/run-1")]) {
      db.docs.clear();
      db.seed("runs/run-1", { userId: "owner-uid" });
      setup();
      expect(await createAdaptivePanelOverrideHistory("run-1", entry)).toEqual({ status: "failed" });
      expect(await writeAdaptivePanelOverrideGovernanceEvent(args)).toEqual({ status: "failed" });
      expect(storedCount()).toBe(0);
    }
  });
});
