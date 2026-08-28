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

// Real `validateRunWorkspaceAssociation()` is used unmocked (Team Workspace
// Boundary Hardening) — it needs WORKSPACES_ENABLED for its "valid" branch's
// getWorkspace() lookup. `getWorkspace()` itself reads through the SAME
// mockAdminDb below (collection name "workspaces"), so no separate
// @/lib/firestore/workspaces mock is needed.
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));

import {
  ownerConfiguredReviewerUid,
  reviewerStillAvailable,
  propagatePersonalReviewerAssignment,
} from "@/lib/governance/personalReviewerAssignment";

function setUser(uid: string, data: Record<string, unknown>) {
  userDocs.set(`users/${uid}`, data);
}

function setRun(runId: string, data: Record<string, unknown>) {
  userDocs.set(`runs/${runId}`, data);
}

function setWorkspace(workspaceId: string, data: Record<string, unknown>) {
  userDocs.set(`workspaces/${workspaceId}`, data);
}

/** A pre-Workspace-binding ("legacy" per validateRunWorkspaceAssociation) run — no `workspaceId` property at all. Personal reviewer propagation must remain eligible for this shape unchanged. */
function setLegacyRun(runId: string) {
  setRun(runId, {});
}

/** A genuinely personal-Workspace-bound ("valid") run, plus its matching Personal Workspace document. */
function setPersonalWorkspaceBoundRun(runId: string, ownerUserId: string) {
  const workspaceId = `personal-${ownerUserId}`;
  setRun(runId, { userId: ownerUserId, workspaceId });
  setWorkspace(workspaceId, {
    schemaVersion: 1,
    id: workspaceId,
    type: "personal",
    name: "Personal",
    ownerUserId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

/** A Team Workspace-associated run — the exact incident shape: `workspaceId` is a real (non-deterministic) Team Workspace id, never equal to the owner's personal-Workspace id. */
function setTeamWorkspaceRun(runId: string, ownerUserId: string, teamWorkspaceId: string) {
  setRun(runId, { userId: ownerUserId, workspaceId: teamWorkspaceId });
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
    setLegacyRun("run-1");
    setUser("owner-1", {});
    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "not_configured" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("returns reviewer_unavailable when the configured reviewer has since disabled availability", async () => {
    setLegacyRun("run-1");
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: false });
    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "reviewer_unavailable" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("Step 6: returns reviewer_unavailable when the configured reviewer's account no longer exists at all (deleted, not merely disabled)", async () => {
    setLegacyRun("run-1");
    setUser("owner-1", { governanceReviewerUid: "reviewer-deleted", governanceReviewerEmail: "gone@example.com" });
    // No setUser("reviewer-deleted", ...) — the doc genuinely does not exist.
    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "reviewer_unavailable" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("Step 6: refuses a self-assignment data anomaly even if a config somehow named the owner as their own reviewer", async () => {
    setLegacyRun("run-1");
    setUser("owner-1", {
      governanceReviewerUid: "owner-1",
      governanceReviewerEmail: "self@example.com",
      governanceReviewerEnabled: true,
    });
    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "not_configured" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("assigns the configured, still-available reviewer and records history + audit", async () => {
    setLegacyRun("run-1");
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

  it("Step 7: a later reviewer-configuration change affects only future runs — an existing run's assignment is never re-derived or touched", async () => {
    // Run A is created while Reviewer A is configured.
    setLegacyRun("run-A");
    setLegacyRun("run-B");
    setUser("owner-1", { governanceReviewerUid: "reviewer-A", governanceReviewerEmail: "a@example.com" });
    setUser("reviewer-A", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValueOnce({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: "run-A",
        assignedReviewerUserId: "reviewer-A",
        assignedAt: "2026-08-12T18:00:00.000Z",
        assignedByUserId: "owner-1",
        updatedAt: "2026-08-12T18:00:00.000Z",
        updatedByUserId: "owner-1",
        revision: 1,
      },
      previousReviewerUserId: null,
    });
    const resultA = await propagatePersonalReviewerAssignment({ runId: "run-A", ownerUserId: "owner-1" });
    expect(resultA).toEqual({ status: "assigned", reviewerUserId: "reviewer-A" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: "run-A", newReviewerUserId: "reviewer-A" })
    );

    // The owner's configuration is later changed to Reviewer B (mirrors
    // remove_reviewer + assign_reviewer in app/api/governance/reviewer/route.ts).
    setUser("owner-1", { governanceReviewerUid: "reviewer-B", governanceReviewerEmail: "b@example.com" });
    setUser("reviewer-B", { governanceReviewerEnabled: true });

    // Run B is a genuinely NEW, later run for the same owner.
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValueOnce({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: "run-B",
        assignedReviewerUserId: "reviewer-B",
        assignedAt: "2026-08-12T19:00:00.000Z",
        assignedByUserId: "owner-1",
        updatedAt: "2026-08-12T19:00:00.000Z",
        updatedByUserId: "owner-1",
        revision: 1,
      },
      previousReviewerUserId: null,
    });
    const resultB = await propagatePersonalReviewerAssignment({ runId: "run-B", ownerUserId: "owner-1" });
    expect(resultB).toEqual({ status: "assigned", reviewerUserId: "reviewer-B" });

    // Exactly two calls total, each scoped to its own runId — the second
    // call for run-B never references run-A at all, proving there is no
    // "update all of this owner's runs" path that could have silently
    // rewritten run A's already-settled assignment when the config changed.
    expect(mockSubmitAdaptiveHumanReviewAssignment).toHaveBeenCalledTimes(2);
    expect(mockSubmitAdaptiveHumanReviewAssignment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: "run-B", newReviewerUserId: "reviewer-B" })
    );
  });

  it("returns already_assigned (never overwrites) when the transaction reports a stale revision — e.g. a concurrent/duplicate trigger", async () => {
    setLegacyRun("run-1");
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({ ok: false, reason: "stale_revision" });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "already_assigned" });
    expect(mockCreateAdaptiveHumanReviewAssignmentHistory).not.toHaveBeenCalled();
  });

  it("Step 11: two genuinely concurrent (Promise.all) triggers against the same fresh run produce exactly one effective assignment", async () => {
    setLegacyRun("run-concurrent");
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });

    // Mirrors what the REAL submitAdaptiveHumanReviewAssignment transaction
    // guarantees under contention (lib/firestore/runs.ts's own optimistic-
    // concurrency re-read): whichever call's transaction commits first
    // succeeds at revision 1; the other observes the now-stale
    // expectedRevision: 0 and is rejected. Simulated here at the mock
    // boundary since that transaction itself is existing, unchanged,
    // already-tested code — this test's job is to prove THIS module's own
    // orchestration has no shared mutable state that could turn "one
    // winner, one stale_revision" into two assignments or two audit writes.
    let calls = 0;
    mockSubmitAdaptiveHumanReviewAssignment.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          assignment: {
            schemaVersion: 1,
            teamId: null,
            runId: "run-concurrent",
            assignedReviewerUserId: "reviewer-1",
            assignedAt: "2026-08-12T18:00:00.000Z",
            assignedByUserId: "owner-1",
            updatedAt: "2026-08-12T18:00:00.000Z",
            updatedByUserId: "owner-1",
            revision: 1,
          },
          previousReviewerUserId: null,
        };
      }
      return { ok: false, reason: "stale_revision" };
    });

    const [resultOne, resultTwo] = await Promise.all([
      propagatePersonalReviewerAssignment({ runId: "run-concurrent", ownerUserId: "owner-1" }),
      propagatePersonalReviewerAssignment({ runId: "run-concurrent", ownerUserId: "owner-1" }),
    ]);

    const statuses = [resultOne.status, resultTwo.status].sort();
    expect(statuses).toEqual(["already_assigned", "assigned"]);
    // History/audit are written exactly once — for the winning call only.
    expect(mockCreateAdaptiveHumanReviewAssignmentHistory).toHaveBeenCalledTimes(1);
    expect(mockWriteAdaptiveAssignmentAdminAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("returns not_pending when the run's review is no longer pending (terminal-state protection)", async () => {
    setLegacyRun("run-1");
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({ ok: false, reason: "not_pending" });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "not_pending" });
  });

  it("returns failed (never throws) on any other submit failure reason", async () => {
    setLegacyRun("run-1");
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({ ok: false, reason: "write_failed" });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-1", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "failed" });
  });

  it("never throws when history or audit writes fail after a successful assignment (assignment itself still reported as assigned)", async () => {
    setLegacyRun("run-1");
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

  it("returns failed (never throws) when the run document itself cannot be found", async () => {
    // No setRun/setLegacyRun call — the run genuinely does not exist.
    setUser("owner-1", { governanceReviewerUid: "reviewer-1", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-1", { governanceReviewerEnabled: true });
    const result = await propagatePersonalReviewerAssignment({ runId: "run-missing", ownerUserId: "owner-1" });
    expect(result).toEqual({ status: "failed" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });
});

describe("propagatePersonalReviewerAssignment — Team Workspace boundary (Phase 10C.4A-F hardening)", () => {
  // Incident reproduction: 10C.4A found a Team Workspace run — owned by a
  // user with no LEGACY team, so the caller's own loadUserAndTeam(uid).team
  // check let this module run at all — receive a stray, membership-blind
  // reviewer assignment purely because the owner had a personal System-C
  // reviewer configured. The reviewer was never a Team Workspace member.
  it("INCIDENT REPRODUCTION: a Team Workspace run never receives a personal reviewer assignment, even when the owner has no legacy team and a personal reviewer is configured", async () => {
    setTeamWorkspaceRun("run-team-1", "owner-1", "zL1EMo5CFykLFDIoJvk5");
    setUser("owner-1", { governanceReviewerUid: "admin-reviewer", governanceReviewerEmail: "admin@example.com" });
    // The configured reviewer is enabled and NOT a Team Workspace member —
    // this module has no membership concept at all, which is exactly why
    // the guard must be association-based, not membership-based.
    setUser("admin-reviewer", { governanceReviewerEnabled: true });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-team-1", ownerUserId: "owner-1" });

    expect(result).toEqual({ status: "not_personal_association" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
    expect(mockCreateAdaptiveHumanReviewAssignmentHistory).not.toHaveBeenCalled();
    expect(mockWriteAdaptiveAssignmentAdminAuditEvent).not.toHaveBeenCalled();
  });

  it("ADMIN/NON-MEMBER SHAPE: fails closed even when the configured reviewer carries elevated (e.g. admin) status elsewhere — this module never consults custom claims or membership, only run association", async () => {
    setTeamWorkspaceRun("run-team-2", "owner-2", "anotherTeamWorkspaceId99");
    setUser("owner-2", { governanceReviewerUid: "elevated-reviewer", governanceReviewerEmail: "elevated@example.com" });
    setUser("elevated-reviewer", { governanceReviewerEnabled: true });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-team-2", ownerUserId: "owner-2" });

    expect(result).toEqual({ status: "not_personal_association" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("TEAM-MEMBER-OVERLAP NEGATIVE: still refuses even when the configured personal reviewer happens to also be a valid Team Workspace member — Team assignment must come from Team governance, never an identity coincidence", async () => {
    setTeamWorkspaceRun("run-team-3", "owner-3", "zL1EMo5CFykLFDIoJvk5");
    setUser("owner-3", { governanceReviewerUid: "team-member-reviewer", governanceReviewerEmail: "member@example.com" });
    // Deliberately configured to look exactly like a legitimate Team
    // reviewer would (enabled, real account) — membership is irrelevant to
    // this module's decision either way, which this test proves by never
    // consulting a workspaceMemberships fixture at all.
    setUser("team-member-reviewer", { governanceReviewerEnabled: true });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-team-3", ownerUserId: "owner-3" });

    expect(result).toEqual({ status: "not_personal_association" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });

  it("POSITIVE — LEGACY (pre-Workspace-binding, no workspaceId field): personal reviewer propagation is unaffected by the new guard", async () => {
    setLegacyRun("run-legacy-positive");
    setUser("owner-4", { governanceReviewerUid: "reviewer-legacy", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-legacy", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: "run-legacy-positive",
        assignedReviewerUserId: "reviewer-legacy",
        assignedAt: "2026-08-28T18:00:00.000Z",
        assignedByUserId: "owner-4",
        updatedAt: "2026-08-28T18:00:00.000Z",
        updatedByUserId: "owner-4",
        revision: 1,
      },
      previousReviewerUserId: null,
    });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-legacy-positive", ownerUserId: "owner-4" });

    expect(result).toEqual({ status: "assigned", reviewerUserId: "reviewer-legacy" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-legacy-positive", newReviewerUserId: "reviewer-legacy" })
    );
  });

  it("POSITIVE — VALID (modern personal runs DO carry a workspaceId, per Personal Workspace Phase 3): personal reviewer propagation still fires for a genuinely personal-Workspace-bound run", async () => {
    setPersonalWorkspaceBoundRun("run-personal-bound", "owner-5");
    setUser("owner-5", { governanceReviewerUid: "reviewer-bound", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-bound", { governanceReviewerEnabled: true });
    mockSubmitAdaptiveHumanReviewAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: "run-personal-bound",
        assignedReviewerUserId: "reviewer-bound",
        assignedAt: "2026-08-28T18:00:00.000Z",
        assignedByUserId: "owner-5",
        updatedAt: "2026-08-28T18:00:00.000Z",
        updatedByUserId: "owner-5",
        revision: 1,
      },
      previousReviewerUserId: null,
    });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-personal-bound", ownerUserId: "owner-5" });

    expect(result).toEqual({ status: "assigned", reviewerUserId: "reviewer-bound" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-personal-bound", newReviewerUserId: "reviewer-bound" })
    );
  });

  it("MALFORMED/UNKNOWN ASSOCIATION: fails closed (no assignment) rather than guessing, when workspaceId is present but malformed", async () => {
    setRun("run-malformed", { workspaceId: "" }); // present but empty — validateRunWorkspaceAssociation -> invalid
    setUser("owner-6", { governanceReviewerUid: "reviewer-6", governanceReviewerEmail: "r@example.com" });
    setUser("reviewer-6", { governanceReviewerEnabled: true });

    const result = await propagatePersonalReviewerAssignment({ runId: "run-malformed", ownerUserId: "owner-6" });

    expect(result).toEqual({ status: "not_personal_association" });
    expect(mockSubmitAdaptiveHumanReviewAssignment).not.toHaveBeenCalled();
  });
});
