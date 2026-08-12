/**
 * Reviewer Assignment Propagation — personalReviewerAssignment.ts tests.
 */

const mockSubmitAdaptiveHumanReviewAssignment = jest.fn();
const mockCreateAdaptiveHumanReviewAssignmentHistory = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  submitAdaptiveHumanReviewAssignment: (...args: unknown[]) => mockSubmitAdaptiveHumanReviewAssignment(...args),
  createAdaptiveHumanReviewAssignmentHistory: (...args: unknown[]) => mockCreateAdaptiveHumanReviewAssignmentHistory(...args),
}));

const mockWriteAdaptiveAssignmentAdminAuditEvent = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveAssignmentAdminAuditEvent: (...args: unknown[]) => mockWriteAdaptiveAssignmentAdminAuditEvent(...args),
}));

const userDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({
        exists: userDocs.has(`${name}/${id}`),
        data: () => userDocs.get(`${name}/${id}`),
      }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import {
  ownerConfiguredReviewerUid,
  reviewerStillAvailable,
  propagatePersonalReviewerAssignment,
} from "@/lib/governance/personalReviewerAssignment";

function setUser(uid: string, data: Record<string, unknown>) {
  userDocs.set(`users/${uid}`, data);
}

beforeEach(() => {
  userDocs.clear();
  mockSubmitAdaptiveHumanReviewAssignment.mockReset();
  mockCreateAdaptiveHumanReviewAssignmentHistory.mockReset();
  mockWriteAdaptiveAssignmentAdminAuditEvent.mockReset();
  mockCreateAdaptiveHumanReviewAssignmentHistory.mockResolvedValue({ status: "recorded" });
  mockWriteAdaptiveAssignmentAdminAuditEvent.mockResolvedValue({ status: "recorded" });
});

describe("ownerConfiguredReviewerUid", () => {
  it("returns the configured reviewer uid when both uid and email are present", () => {
    expect(ownerConfiguredReviewerUid({ governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" })).toBe(
      "reviewer-1"
    );
  });

  it("returns null when governanceReviewerUid is absent", () => {
    expect(ownerConfiguredReviewerUid({ governanceReviewerEmail: "r@example.com" })).toBeNull();
  });

  it("returns null when governanceReviewerEmail is absent (reviewer-capable alone is never enough)", () => {
    expect(ownerConfiguredReviewerUid({ governanceReviewerUid: "reviewer-1" })).toBeNull();
  });

  it("returns null for an empty/whitespace-only uid", () => {
    expect(ownerConfiguredReviewerUid({ governanceReviewerUid: "   ", governanceReviewerEmail: "r@example.com" })).toBeNull();
  });

  it("returns null for an undefined or null profile", () => {
    expect(ownerConfiguredReviewerUid(undefined)).toBeNull();
    expect(ownerConfiguredReviewerUid(null)).toBeNull();
  });
});

describe("reviewerStillAvailable", () => {
  it("is true only when governanceReviewerEnabled is exactly true", () => {
    expect(reviewerStillAvailable({ governanceReviewerEnabled: true })).toBe(true);
  });

  it("is false when the reviewer has disabled availability", () => {
    expect(reviewerStillAvailable({ governanceReviewerEnabled: false })).toBe(false);
  });

  it("is false when the flag is absent (a merely reviewer-capable but never-enabled account)", () => {
    expect(reviewerStillAvailable({})).toBe(false);
    expect(reviewerStillAvailable(undefined)).toBe(false);
  });
});

describe("propagatePersonalReviewerAssignment", () => {
  it("returns not_configured when the owner has no reviewer configured", async () => {
    setUser("owner-1", {});
    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "not_configured" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("returns reviewer_unavailable when the configured reviewer has since disabled availability", async () => {
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: false });
    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "reviewer_unavailable" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("assigns the configured, still-available reviewer and records history + audit", async () => {
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: "run-1",
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T18:00:00.000Z",
        assignedByUserId: "owner-1",
        updatedAt: "2026-08-12T18:00:00.000Z",
        updatedByUserId: "owner-1",
        revision: 1,
      },
      previousReviewerUserId: null,
    });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });

    expect(result).toEqual({ status: "assigned", reviewerUserId: "reviewer-1" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        teamId: null,
        newReviewerUserId: "reviewer-1",
        actorUserId: "owner-1",
        expectedRevision: 0,
      })
    );
    expect(mockCreateAdaptiveHumanReviewAssignmentHistory).toHaveBeenCalledTimes(1);
    expect(mockWriteAdaptiveAssignmentAdminAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "adaptive_human_review_reviewer_assigned", teamId: null, runId: "run-1" })
    );
  });

  it("returns already_assigned (never overwrites) when the transaction reports a stale revision — e.g. a concurrent/duplicate trigger", async () => {
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({ ok: false, reason: "stale_revision" });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "already_assigned" });
    expect(mockCreateAdaptiveHumanReviewAssignmentHistory).not.toHaveBeenCalled();
  });

  it("returns not_pending when the run's review is no longer pending (terminal-state protection)", async () => {
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({ ok: false, reason: "not_pending" });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "not_pending" });
  });

  it("returns failed (never throws) on any other submit failure reason", async () => {
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({ ok: false, reason: "write_failed" });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "failed" });
  });

  it("never throws when history or audit writes fail after a successful assignment (assignment itself still reported as assigned)", async () => {
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: "run-1",
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T18:00:00.000Z",
        assignedByUserId: "owner-1",
        updatedAt: "2026-08-12T18:00:00.000Z",
        updatedByUserId: "owner-1",
        revision: 1,
      },
      previousReviewerUserId: null,
    });
    mockCreateAdaptiveHumanReviewAssignmentHistory.mockRejectedValue(new Error("boom"));
    mockWriteAdaptiveAssignmentAdminAuditEvent.mockRejectedValue(new Error("boom"));

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "assigned", reviewerUserId: "reviewer-1" });
  });
});
