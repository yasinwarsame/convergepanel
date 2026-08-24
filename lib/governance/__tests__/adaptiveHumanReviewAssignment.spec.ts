/**
 * Part E3 — pure assignment model tests.
 */

import {
  ELIGIBLE_REVIEWER_ROLES,
  hasAdaptiveReviewSubmissionOverride,
  classifyAssignmentEventType,
  buildNextAdaptiveHumanReviewAssignment,
  buildAdaptiveHumanReviewAssignmentHistoryEntry,
  buildAdaptiveHumanReviewAssignmentMetadataUpdate,
  buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry,
  isCanonicalDueAt,
  AdaptiveHumanReviewAssignmentV1,
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

  describe("Phase 9B.2 — workspaceMetadata (workspaceId/projectId/dueAt)", () => {
    it("omitted -> the resulting assignment carries none of workspaceId/projectId/dueAt (legacy Team behavior, unchanged)", () => {
      const next = buildNextAdaptiveHumanReviewAssignment({ ...BASE, newReviewerUserId: "reviewer-uid" }) as Record<string, unknown>;
      expect(next).not.toHaveProperty("workspaceId");
      expect(next).not.toHaveProperty("projectId");
      expect(next).not.toHaveProperty("dueAt");
    });

    it("supplied on new assignment with dueAt null -> all three fields set, dueAt explicitly null", () => {
      const next = buildNextAdaptiveHumanReviewAssignment({
        ...BASE,
        newReviewerUserId: "reviewer-uid",
        workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: null },
      });
      expect(next.workspaceId).toBe("ws-1");
      expect(next.projectId).toBe("proj-1");
      expect(next).toHaveProperty("dueAt", null);
    });

    it("supplied on new assignment with a concrete dueAt -> stored exactly", () => {
      const next = buildNextAdaptiveHumanReviewAssignment({
        ...BASE,
        newReviewerUserId: "reviewer-uid",
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "2026-08-15T00:00:00.000Z" },
      });
      expect(next.dueAt).toBe("2026-08-15T00:00:00.000Z");
      expect(next.projectId).toBeNull(); // Unfiled, distinct from omitted
    });

    it("reassignment NEVER inherits the previous reviewer's dueAt — there is no code path here that reads a 'current dueAt' at all", () => {
      // Simulate: previous assignee had a dueAt, but the caller (as it must)
      // supplies a fresh, explicit decision for the NEW assignee.
      const next = buildNextAdaptiveHumanReviewAssignment({
        ...BASE,
        currentRevision: 2,
        newReviewerUserId: "new-reviewer-uid",
        workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: null },
      });
      expect(next.dueAt).toBeNull();
      expect(next.assignedReviewerUserId).toBe("new-reviewer-uid");
    });
  });
});

describe("buildAdaptiveHumanReviewAssignmentMetadataUpdate", () => {
  const CURRENT: AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string } = {
    schemaVersion: 1,
    teamId: "team-1",
    runId: "run-1",
    assignedReviewerUserId: "reviewer-uid",
    assignedAt: "2026-08-01T00:00:00.000Z",
    assignedByUserId: "admin-uid",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    revision: 3,
    workspaceId: "ws-1",
    projectId: "proj-1",
    dueAt: null,
  };

  it("changes dueAt without touching who is assigned", () => {
    const next = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: CURRENT,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: "2026-08-20T00:00:00.000Z" },
    });
    expect(next.dueAt).toBe("2026-08-20T00:00:00.000Z");
    expect(next.assignedReviewerUserId).toBe("reviewer-uid");
  });

  it("preserves assignedAt/assignedByUserId EXACTLY — a due-date change is never an assignment event", () => {
    const next = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: CURRENT,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: "2026-08-20T00:00:00.000Z" },
    });
    expect(next.assignedAt).toBe(CURRENT.assignedAt);
    expect(next.assignedByUserId).toBe(CURRENT.assignedByUserId);
  });

  it("increments revision by exactly 1 and updates updatedAt/updatedByUserId", () => {
    const next = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: CURRENT,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: null },
    });
    expect(next.revision).toBe(4);
    expect(next.updatedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(next.updatedByUserId).toBe("manager-uid");
  });

  it("clearing dueAt to null is a distinct, explicit outcome — not the same as omitting it", () => {
    const withDueAt = { ...CURRENT, dueAt: "2026-08-20T00:00:00.000Z" };
    const next = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: withDueAt,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: null },
    });
    expect(next).toHaveProperty("dueAt", null);
  });

  it("resyncing workspaceId/projectId via this path does not require a reviewer change", () => {
    const next = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: CURRENT,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-2", dueAt: CURRENT.dueAt ?? null },
    });
    expect(next.projectId).toBe("proj-2");
    expect(next.assignedReviewerUserId).toBe(CURRENT.assignedReviewerUserId);
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

  describe("Phase 9B.2 — workspaceMetadata on history entries", () => {
    it("omitted -> no workspaceId/projectId/dueAt on the history entry", () => {
      const entry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
        teamId: "team-1",
        runId: "run-1",
        previousReviewerUserId: null,
        newReviewerUserId: "reviewer-uid",
        assignmentRevision: 1,
        changedAt: "x",
        changedByUserId: "admin-uid",
      }) as Record<string, unknown>;
      expect(entry).not.toHaveProperty("workspaceId");
      expect(entry).not.toHaveProperty("projectId");
      expect(entry).not.toHaveProperty("dueAt");
    });

    it("supplied -> the historical snapshot is preserved on the entry", () => {
      const entry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
        teamId: "team-1",
        runId: "run-1",
        previousReviewerUserId: null,
        newReviewerUserId: "reviewer-uid",
        assignmentRevision: 1,
        changedAt: "x",
        changedByUserId: "admin-uid",
        workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: "2026-08-20T00:00:00.000Z" },
      });
      expect(entry.workspaceId).toBe("ws-1");
      expect(entry.projectId).toBe("proj-1");
      expect(entry.dueAt).toBe("2026-08-20T00:00:00.000Z");
    });
  });
});

describe("buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry", () => {
  it("eventType is always 'metadata_updated' — never derived via classifyAssignmentEventType", () => {
    const entry = buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      reviewerUserId: "reviewer-uid",
      assignmentRevision: 4,
      changedAt: "2026-08-10T00:00:00.000Z",
      changedByUserId: "manager-uid",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: "2026-08-20T00:00:00.000Z" },
    });
    expect(entry.eventType).toBe("metadata_updated");
  });

  it("previousReviewerUserId and newReviewerUserId are both the unchanged reviewer — honestly reflecting no reviewer transition occurred", () => {
    const entry = buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      reviewerUserId: "reviewer-uid",
      assignmentRevision: 4,
      changedAt: "2026-08-10T00:00:00.000Z",
      changedByUserId: "manager-uid",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: null },
    });
    expect(entry.previousReviewerUserId).toBe("reviewer-uid");
    expect(entry.newReviewerUserId).toBe("reviewer-uid");
  });

  it("carries the workspace/project/dueAt snapshot and a deterministic eventId equal to the revision", () => {
    const entry = buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      reviewerUserId: "reviewer-uid",
      assignmentRevision: 9,
      changedAt: "2026-08-10T00:00:00.000Z",
      changedByUserId: "manager-uid",
      workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "2026-08-20T00:00:00.000Z" },
    });
    expect(entry.eventId).toBe("9");
    expect(entry.workspaceId).toBe("ws-1");
    expect(entry.projectId).toBeNull();
    expect(entry.dueAt).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("Phase 9B.2-R2C — isCanonicalDueAt (strict UTC ISO-8601 validation)", () => {
  it("accepts a canonical UTC ISO-8601 timestamp", () => {
    expect(isCanonicalDueAt("2026-08-23T19:30:00.000Z")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isCanonicalDueAt("")).toBe(false);
  });

  it("rejects an invalid date string", () => {
    expect(isCanonicalDueAt("not-a-date")).toBe(false);
  });

  it("rejects a date-only string", () => {
    expect(isCanonicalDueAt("2026-08-23")).toBe(false);
  });

  it("rejects a valid instant expressed with a timezone offset — never persisted unchanged", () => {
    expect(isCanonicalDueAt("2026-08-23T22:30:00+03:00")).toBe(false);
  });

  it("rejects a valid instant missing canonical millisecond precision", () => {
    expect(isCanonicalDueAt("2026-08-23T19:30:00Z")).toBe(false);
  });

  it("rejects a lowercase 't'/'z' variant, even though Date.parse accepts it", () => {
    expect(isCanonicalDueAt("2026-08-23t19:30:00.000z")).toBe(false);
  });

  it("rejects non-string runtime values safely, even though TypeScript's `string` param type makes this unreachable through normal call sites", () => {
    // `isCanonicalDueAt` is typed `(value: string) => boolean`, so passing a
    // number/object/array/boolean requires an explicit type-system escape
    // hatch — this test exercises the runtime behavior anyway (rather than
    // trusting the compile-time type alone), since `dueAt` ultimately
    // originates from caller-constructed data this module cannot itself
    // guarantee was never coerced. Every non-string value is rejected by
    // the final `parsed.toISOString() === value` strict-equality check,
    // which can never be true when `value`'s runtime type isn't `string`.
    for (const nonString of [123, {}, [], true, NaN] as unknown as string[]) {
      expect(isCanonicalDueAt(nonString)).toBe(false);
    }
  });

  it("returns false (never throws) for null/undefined at the runtime boundary — typed `unknown => value is string`, not assumed to be a string", () => {
    expect(() => isCanonicalDueAt(null as unknown as string)).not.toThrow();
    expect(isCanonicalDueAt(null as unknown as string)).toBe(false);
    expect(() => isCanonicalDueAt(undefined as unknown as string)).not.toThrow();
    expect(isCanonicalDueAt(undefined as unknown as string)).toBe(false);
  });

  it("lexical ordering of canonical values matches chronological ordering (locks the future Firestore range-query assumption)", () => {
    const earlier = "2026-08-23T10:00:00.000Z";
    const middle = "2026-08-23T11:00:00.000Z";
    const later = "2026-08-24T00:00:00.000Z";
    expect(isCanonicalDueAt(earlier)).toBe(true);
    expect(isCanonicalDueAt(middle)).toBe(true);
    expect(isCanonicalDueAt(later)).toBe(true);
    expect([later, earlier, middle].sort()).toEqual([earlier, middle, later]);
    expect(new Date(earlier).getTime()).toBeLessThan(new Date(middle).getTime());
    expect(new Date(middle).getTime()).toBeLessThan(new Date(later).getTime());
  });
});

describe("Phase 9B.2-R2C — domain boundary rejects noncanonical dueAt before any document is constructed", () => {
  const NEW_ASSIGNMENT_BASE = {
    teamId: "team-1",
    runId: "run-1",
    newReviewerUserId: "reviewer-uid",
    actorUserId: "admin-uid",
    now: "2026-08-01T00:00:00.000Z",
    currentRevision: 0,
    currentAssignedAt: null,
    currentAssignedByUserId: null,
  };

  it("buildNextAdaptiveHumanReviewAssignment: canonical dueAt is accepted", () => {
    expect(() =>
      buildNextAdaptiveHumanReviewAssignment({
        ...NEW_ASSIGNMENT_BASE,
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "2026-08-23T19:30:00.000Z" },
      })
    ).not.toThrow();
  });

  it("buildNextAdaptiveHumanReviewAssignment: null dueAt is accepted", () => {
    expect(() =>
      buildNextAdaptiveHumanReviewAssignment({
        ...NEW_ASSIGNMENT_BASE,
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: null },
      })
    ).not.toThrow();
  });

  it("buildNextAdaptiveHumanReviewAssignment: omitted workspaceMetadata (legacy call site) never validates dueAt at all", () => {
    expect(() => buildNextAdaptiveHumanReviewAssignment(NEW_ASSIGNMENT_BASE)).not.toThrow();
  });

  it("buildNextAdaptiveHumanReviewAssignment: a noncanonical dueAt throws before any document is returned", () => {
    expect(() =>
      buildNextAdaptiveHumanReviewAssignment({
        ...NEW_ASSIGNMENT_BASE,
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "2026-08-23T22:30:00+03:00" },
      })
    ).toThrow(/canonical UTC ISO-8601/);
  });

  it("buildNextAdaptiveHumanReviewAssignment: an empty-string dueAt throws", () => {
    expect(() =>
      buildNextAdaptiveHumanReviewAssignment({
        ...NEW_ASSIGNMENT_BASE,
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "" },
      })
    ).toThrow();
  });

  it("buildNextAdaptiveHumanReviewAssignment: a date-only dueAt throws", () => {
    expect(() =>
      buildNextAdaptiveHumanReviewAssignment({
        ...NEW_ASSIGNMENT_BASE,
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "2026-08-23" },
      })
    ).toThrow();
  });

  const METADATA_UPDATE_CURRENT: AdaptiveHumanReviewAssignmentV1 & { assignedReviewerUserId: string } = {
    schemaVersion: 1,
    teamId: "team-1",
    runId: "run-1",
    assignedReviewerUserId: "reviewer-uid",
    assignedAt: "2026-08-01T00:00:00.000Z",
    assignedByUserId: "admin-uid",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    revision: 3,
    workspaceId: "ws-1",
    projectId: "proj-1",
    dueAt: null,
  };

  it("buildAdaptiveHumanReviewAssignmentMetadataUpdate: a noncanonical dueAt throws, never reaching a returned document", () => {
    expect(() =>
      buildAdaptiveHumanReviewAssignmentMetadataUpdate({
        current: METADATA_UPDATE_CURRENT,
        actorUserId: "manager-uid",
        now: "2026-08-10T00:00:00.000Z",
        workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: "not-a-date" },
      })
    ).toThrow(/canonical UTC ISO-8601/);
  });

  it("buildAdaptiveHumanReviewAssignmentMetadataUpdate: canonical dueAt and null both pass through unchanged", () => {
    const withValue = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: METADATA_UPDATE_CURRENT,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: "2026-08-23T19:30:00.000Z" },
    });
    expect(withValue.dueAt).toBe("2026-08-23T19:30:00.000Z");

    const cleared = buildAdaptiveHumanReviewAssignmentMetadataUpdate({
      current: METADATA_UPDATE_CURRENT,
      actorUserId: "manager-uid",
      now: "2026-08-10T00:00:00.000Z",
      workspaceMetadata: { workspaceId: "ws-1", projectId: "proj-1", dueAt: null },
    });
    expect(cleared.dueAt).toBeNull();
  });

  it("buildAdaptiveHumanReviewAssignmentHistoryEntry: a noncanonical dueAt throws before any history entry is returned", () => {
    expect(() =>
      buildAdaptiveHumanReviewAssignmentHistoryEntry({
        teamId: "team-1",
        runId: "run-1",
        previousReviewerUserId: null,
        newReviewerUserId: "reviewer-uid",
        assignmentRevision: 1,
        changedAt: "2026-08-01T00:00:00.000Z",
        changedByUserId: "admin-uid",
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "2026-08-23" },
      })
    ).toThrow(/canonical UTC ISO-8601/);
  });

  it("buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry: a noncanonical dueAt throws before any history entry is returned", () => {
    expect(() =>
      buildAdaptiveHumanReviewAssignmentMetadataHistoryEntry({
        teamId: "team-1",
        runId: "run-1",
        reviewerUserId: "reviewer-uid",
        assignmentRevision: 4,
        changedAt: "2026-08-10T00:00:00.000Z",
        changedByUserId: "manager-uid",
        workspaceMetadata: { workspaceId: "ws-1", projectId: null, dueAt: "" },
      })
    ).toThrow();
  });
});
