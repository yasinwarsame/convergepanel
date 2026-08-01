/**
 * Part E3 — repairAdaptiveHumanReviewAssignmentArtifacts() tests.
 */

const assignmentDocs = new Map<string, Record<string, any>>();
const historyDocs = new Map<string, Record<string, any>>();
const auditDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };
const getAssignmentOverride: { value: any } = { value: null };

jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: jest.fn(async (runId: string) => {
    if (getAssignmentOverride.value) return getAssignmentOverride.value;
    const doc = assignmentDocs.get(runId);
    return doc ? { status: "found", assignment: doc } : { status: "unassigned" };
  }),
  createAdaptiveHumanReviewAssignmentHistory: jest.fn(async (runId: string, entry: any) => {
    const key = `${runId}/${entry.eventId}`;
    if (historyDocs.has(key)) return { status: "already_exists" };
    historyDocs.set(key, entry);
    return { status: "recorded" };
  }),
}));

jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveAssignmentAdminAuditEvent: jest.fn(async (args: any) => {
    const key = `${args.runId}:${args.assignmentRevision}`;
    if (auditDocs.has(key)) return { status: "already_exists" };
    auditDocs.set(key, args);
    return { status: "recorded" };
  }),
}));

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : {};
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { repairAdaptiveHumanReviewAssignmentArtifacts } from "@/lib/governance/adaptiveHumanReviewAssignmentRepair";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    teamId: TEAM_ID,
    runId: RUN_ID,
    assignedReviewerUserId: "reviewer-uid",
    assignedAt: "2026-07-30T00:00:00.000Z",
    assignedByUserId: "admin-uid",
    updatedAt: "2026-07-30T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    revision: 1,
    ...overrides,
  };
}

beforeEach(() => {
  assignmentDocs.clear();
  historyDocs.clear();
  auditDocs.clear();
  firestoreUnavailableFlag.value = false;
  getAssignmentOverride.value = null;
});

describe("repairAdaptiveHumanReviewAssignmentArtifacts", () => {
  it("returns no_assignment when the run was never assigned", async () => {
    const result = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(result).toEqual({ status: "no_assignment" });
  });

  it("creates missing history and audit for a revision-1 assignment (fully reconstructable)", async () => {
    assignmentDocs.set(RUN_ID, assignment({ revision: 1 }));
    const result = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(result).toEqual({ status: "repaired", historyStatus: "recorded", auditStatus: "recorded" });
    expect(historyDocs.get(`${RUN_ID}/1`)).toBeDefined();
    expect(historyDocs.get(`${RUN_ID}/1`)!.previousReviewerUserId).toBeNull();
  });

  it("existing artifacts are never overwritten — a second repair run is idempotent", async () => {
    assignmentDocs.set(RUN_ID, assignment({ revision: 1 }));
    await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    const storedAfterFirst = { ...historyDocs.get(`${RUN_ID}/1`) };
    const second = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(second).toEqual({ status: "already_complete", historyStatus: "already_exists", auditStatus: "already_exists" });
    expect(historyDocs.get(`${RUN_ID}/1`)).toEqual(storedAfterFirst);
  });

  it("refuses to reconstruct and fabricate previousReviewerUserId for revision > 1 — reports the limitation instead", async () => {
    assignmentDocs.set(RUN_ID, assignment({ revision: 3 }));
    const result = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(result).toEqual({ status: "cannot_reconstruct", reason: "previous_reviewer_unknown_for_revision_greater_than_one", revision: 3 });
    expect(historyDocs.size).toBe(0);
    expect(auditDocs.size).toBe(0);
  });

  it("never modifies the assignment document itself — no write path to it exists in this function", async () => {
    const before = assignment({ revision: 1 });
    assignmentDocs.set(RUN_ID, { ...before });
    await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(assignmentDocs.get(RUN_ID)).toEqual(before);
  });

  it("returns firestore_unavailable safely without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("creates only the missing artifact when one already exists at revision 1", async () => {
    assignmentDocs.set(RUN_ID, assignment({ revision: 1 }));
    auditDocs.set(`${RUN_ID}:1`, { action: "adaptive_human_review_reviewer_assigned" });
    const result = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(result.status).toBe("repaired");
    if (result.status === "repaired") {
      expect(result.historyStatus).toBe("recorded");
      expect(result.auditStatus).toBe("already_exists");
    }
  });

  it("classifies an unassignment (assignedReviewerUserId: null) at revision 1 correctly", async () => {
    assignmentDocs.set(RUN_ID, assignment({ revision: 1, assignedReviewerUserId: null, assignedAt: null, assignedByUserId: null }));
    const result = await repairAdaptiveHumanReviewAssignmentArtifacts(RUN_ID);
    expect(result.status).toBe("repaired");
    expect(historyDocs.get(`${RUN_ID}/1`)!.eventType).toBe("unassigned");
  });
});
