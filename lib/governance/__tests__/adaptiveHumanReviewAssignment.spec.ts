/**
 * Part E3 — pure assignment model tests.
 */

import {
  ELIGIBLE_REVIEWER_ROLES,
  hasAdaptiveReviewSubmissionOverride,
  classifyAssignmentEventType,
  buildNextAdaptiveHumanReviewAssignment,
  buildAdaptiveHumanReviewAssignmentHistoryEntry,
} from "@/lib/governance/adaptiveHumanReviewAssignment";

describe("ELIGIBLE_REVIEWER_ROLES", () => {
  it("contains exactly owner and admin — never member", () => {
    expect(ELIGIBLE_REVIEWER_ROLES.has("owner")).toBe(true);
    expect(ELIGIBLE_REVIEWER_ROLES.has("admin")).toBe(true);
    expect(ELIGIBLE_REVIEWER_ROLES.has("member")).toBe(false);
  });
});

describe("hasAdaptiveReviewSubmissionOverride", () => {
  it("is true only for owner", () => {
    expect(hasAdaptiveReviewSubmissionOverride("owner")).toBe(true);
    expect(hasAdaptiveReviewSubmissionOverride("admin")).toBe(false);
    expect(hasAdaptiveReviewSubmissionOverride("member")).toBe(false);
    expect(hasAdaptiveReviewSubmissionOverride(null)).toBe(false);
  });
});

describe("classifyAssignmentEventType", () => {
  it("unassigned -> assigned = 'assigned'", () => {
    expect(classifyAssignmentEventType(null, "u1")).toBe("assigned");
  });

  it("assigned -> different user = 'reassigned'", () => {
    expect(classifyAssignmentEventType("u1", "u2")).toBe("reassigned");
  });

  it("assigned -> null = 'unassigned'", () => {
    expect(classifyAssignmentEventType("u1", null)).toBe("unassigned");
  });

  it("unassigned -> unassigned is classified as 'unassigned' (no-op case, never reached in practice since it wouldn't be a real mutation)", () => {
    expect(classifyAssignmentEventType(null, null)).toBe("unassigned");
  });
});

describe("buildNextAdaptiveHumanReviewAssignment", () => {
  const BASE = {
    teamId: "team-1",
    runId: "run-1",
    actorUserId: "admin-uid",
    now: "2026-07-30T00:00:00.000Z",
    currentRevision: 0,
    currentAssignedAt: null,
    currentAssignedByUserId: null,
  };

  it("assigning sets assignedAt/assignedByUserId and increments revision", () => {
    const next = buildNextAdaptiveHumanReviewAssignment({ ...BASE, newReviewerUserId: "reviewer-uid" });
    expect(next).toEqual({
      schemaVersion: 1,
      teamId: "team-1",
      runId: "run-1",
      assignedReviewerUserId: "reviewer-uid",
      assignedAt: "2026-07-30T00:00:00.000Z",
      assignedByUserId: "admin-uid",
      updatedAt: "2026-07-30T00:00:00.000Z",
      updatedByUserId: "admin-uid",
      revision: 1,
    });
  });

  it("unassigning clears assignedAt/assignedByUserId to null but still updates revision/updatedAt/updatedByUserId", () => {
    const next = buildNextAdaptiveHumanReviewAssignment({
      ...BASE,
      currentRevision: 3,
      newReviewerUserId: null,
    });
    expect(next.assignedReviewerUserId).toBeNull();
    expect(next.assignedAt).toBeNull();
    expect(next.assignedByUserId).toBeNull();
    expect(next.revision).toBe(4);
    expect(next.updatedAt).toBe("2026-07-30T00:00:00.000Z");
    expect(next.updatedByUserId).toBe("admin-uid");
  });

  it("revision always increments by exactly 1 from the current value", () => {
    const next = buildNextAdaptiveHumanReviewAssignment({ ...BASE, currentRevision: 41, newReviewerUserId: "u1" });
    expect(next.revision).toBe(42);
  });

  it("never includes reviewer name, email, or any content field (not accepted as input)", () => {
    const next = buildNextAdaptiveHumanReviewAssignment({ ...BASE, newReviewerUserId: "reviewer-uid" }) as Record<string, unknown>;
    for (const forbidden of ["reviewerName", "reviewerEmail", "displayName", "comment"]) {
      expect(next).not.toHaveProperty(forbidden);
    }
  });
});

describe("buildAdaptiveHumanReviewAssignmentHistoryEntry", () => {
  it("builds a metadata-only entry with a deterministic eventId equal to the revision", () => {
    const entry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      previousReviewerUserId: null,
      newReviewerUserId: "reviewer-uid",
      assignmentRevision: 7,
      changedAt: "2026-07-30T00:00:00.000Z",
      changedByUserId: "admin-uid",
    });
    expect(entry).toEqual({
      schemaVersion: 1,
      eventId: "7",
      teamId: "team-1",
      runId: "run-1",
      eventType: "assigned",
      previousReviewerUserId: null,
      newReviewerUserId: "reviewer-uid",
      assignmentRevision: 7,
      changedAt: "2026-07-30T00:00:00.000Z",
      changedByUserId: "admin-uid",
    });
  });

  it("reassignment and unassignment produce distinct eventTypes at distinct revisions", () => {
    const reassigned = buildAdaptiveHumanReviewAssignmentHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      previousReviewerUserId: "u1",
      newReviewerUserId: "u2",
      assignmentRevision: 2,
      changedAt: "x",
      changedByUserId: "admin-uid",
    });
    const unassigned = buildAdaptiveHumanReviewAssignmentHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      previousReviewerUserId: "u2",
      newReviewerUserId: null,
      assignmentRevision: 3,
      changedAt: "y",
      changedByUserId: "admin-uid",
    });
    expect(reassigned.eventType).toBe("reassigned");
    expect(reassigned.eventId).toBe("2");
    expect(unassigned.eventType).toBe("unassigned");
    expect(unassigned.eventId).toBe("3");
    expect(reassigned.eventId).not.toBe(unassigned.eventId);
  });

  it("never includes reviewer names, emails, comments, or decision content", () => {
    const entry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      previousReviewerUserId: null,
      newReviewerUserId: "reviewer-uid",
      assignmentRevision: 1,
      changedAt: "x",
      changedByUserId: "admin-uid",
    }) as Record<string, unknown>;
    for (const forbidden of ["reviewerName", "reviewerEmail", "comment", "conditions", "decisionReceipt"]) {
      expect(entry).not.toHaveProperty(forbidden);
    }
  });
});
