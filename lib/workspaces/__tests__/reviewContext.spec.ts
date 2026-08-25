/**
 * Approval Workflow, Phase 9B.6 — getReviewContext() tests. Plain,
 * non-transactional read fake (`.get()`/`.getAll()` only, no
 * runTransaction) since this module performs no writes.
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  runs: new Map(),
  humanReviewAssignment: new Map(),
  humanReviewPanel: new Map(),
  humanReviewVotes: new Map(),
  workspaceMemberships: new Map(),
  users: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
}

function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function subKey(parentId: string, subId: string): string {
  return `${parentId}::${subId}`;
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    collection: (subCollectionName: string) => ({
      doc: (subDocId: string) => {
        const key = subKey(docId, subDocId);
        return {
          __collection: subCollectionName,
          __id: key,
          get: async () => {
            const data = stores[subCollectionName].get(key);
            return { exists: data !== undefined, data: () => data, id: subDocId };
          },
        };
      },
    }),
    get: async () => {
      const data = stores[collectionName].get(docId);
      return { exists: data !== undefined, data: () => data, id: docId };
    },
  };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
    where: (field: string, op: string, value: unknown) => {
      // Only used by getReviewerCandidates in a sibling test file; not needed here.
      throw new Error("where() not implemented in reviewContext fake");
    },
  }),
  getAll: async (...refs: { __collection: string; __id: string }[]) => {
    return refs.map((ref) => {
      const data = stores[ref.__collection].get(ref.__id);
      return { exists: data !== undefined, data: () => data, id: ref.__id };
    });
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { buildAdaptiveHumanReviewVoteId } from "@/lib/governance/adaptiveHumanReviewVote";
import { getReviewContext } from "@/lib/workspaces/reviewContext";
import type { WorkspaceReviewCandidate } from "@/lib/workspaces/workspaceReviewEligibility";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const REVIEWER2_UID = "reviewer-2";
const VIEWER_UID = "viewer-1";
const CREATOR_UID = "creator-1";
const RUN_ID = "run-1";
const NOW = Timestamp.now();
const GOVERNANCE_UPDATED_AT = "2026-08-01T00:00:00.000Z";

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const status = (overrides.status as string | undefined) ?? "active";
  stores.workspaceMemberships.set(
    id,
    asPersisted({ schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: status === "removed" ? NOW : null, removedByUserId: status === "removed" ? OWNER_UID : null, ...overrides })
  );
}

function validGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return asPersisted({
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
    createdAt: GOVERNANCE_UPDATED_AT,
    updatedAt: GOVERNANCE_UPDATED_AT,
    ...overrides,
  });
}

function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(RUN_ID, asPersisted({ userId: CREATOR_UID, workspaceId: WS_ID, projectId: null, question: "What is the outlook?", createdAt: NOW, governanceRecord: validGovernanceRecord(), ...overrides }));
}

function seedAssignment(overrides: Record<string, unknown> = {}) {
  stores.humanReviewAssignment.set(
    `${RUN_ID}::current`,
    asPersisted({ schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-07-01T00:00:00.000Z", assignedByUserId: OWNER_UID, updatedAt: "2026-07-01T00:00:00.000Z", updatedByUserId: OWNER_UID, revision: 1, workspaceId: WS_ID, projectId: null, dueAt: null, ...overrides })
  );
}

function seedPanel(overrides: Record<string, unknown> = {}) {
  stores.humanReviewPanel.set(
    `${RUN_ID}::current`,
    asPersisted({
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: null,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: [OWNER_UID, ADMIN_UID].sort(),
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      workspaceId: WS_ID,
      projectId: null,
      ...overrides,
    })
  );
}

function seedVote(reviewerUserId: string, revision: number, overrides: Record<string, unknown> = {}) {
  const voteId = buildAdaptiveHumanReviewVoteId(revision, reviewerUserId);
  stores.humanReviewVotes.set(
    `${RUN_ID}::${voteId}`,
    asPersisted({ schemaVersion: 1, kind: "adaptive_human_review_vote", teamId: null, runId: RUN_ID, panelRevision: revision, reviewerUserId, status: "approved", commentPresent: false, conditionsCount: 0, submittedAt: "2026-08-02T00:00:00.000Z", ...overrides })
  );
}

function seedUser(uid: string, overrides: Record<string, unknown> = {}) {
  stores.users.set(uid, { name: "", email: "", ...overrides });
}

function candidate(uid: string, role: string, status: "active" | "removed" = "active"): WorkspaceReviewCandidate {
  return { uid, workspaceId: WS_ID, role: role as any, status };
}

beforeEach(() => {
  resetStores();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(REVIEWER2_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
  seedMembership(CREATOR_UID, "member");
  seedRun();
});

function call(uid: string, role: string, approvalAdmitted: boolean) {
  return getReviewContext({ workspaceId: WS_ID, runId: RUN_ID, uid, callerCandidate: candidate(uid, role), approvalAdmitted });
}

describe("getReviewContext — normal mode, concealment", () => {
  it("normal mode, unreviewed unassigned run: returns full context", async () => {
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.run.runId).toBe(RUN_ID);
    expect(result.context.review.status).toBe("unreviewed");
    expect(result.context.assignment).toBeNull();
    expect(result.context.panel).toBeNull();
    expect(result.context.viewer.mode).toBe("normal");
  });

  it("run not found: concealed run_not_found", async () => {
    stores.runs.delete(RUN_ID);
    const result = await call(OWNER_UID, "owner", true);
    expect(result).toEqual({ status: "run_not_found" });
  });

  it("wrong workspace: concealed run_not_found", async () => {
    seedRun({ workspaceId: OTHER_WS_ID });
    const result = await call(OWNER_UID, "owner", true);
    expect(result).toEqual({ status: "run_not_found" });
  });

  it("Personal (no workspaceId): concealed run_not_found", async () => {
    seedRun({ workspaceId: undefined });
    const result = await call(OWNER_UID, "owner", true);
    expect(result).toEqual({ status: "run_not_found" });
  });
});

describe("getReviewContext — current review detail (§58)", () => {
  it("changes_requested with comment: comment IS included in review-context", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "changes_requested", reviewedAt: GOVERNANCE_UPDATED_AT, comment: "Please add sources.", reviewerId: OWNER_UID } }) });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.review.comment).toBe("Please add sources.");
  });

  it("approved_with_conditions: conditions ARE included", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "approved_with_conditions", reviewedAt: GOVERNANCE_UPDATED_AT, conditions: ["Add a citation"] } }) });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.review.conditions).toEqual(["Add a citation"]);
  });

  it("decidedVia passed through unmodified when present, distinguishing override from ordinary/panel decisions", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "approved", reviewedAt: GOVERNANCE_UPDATED_AT, decidedVia: "multi_reviewer_owner_override" } }) });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.review.decidedVia).toBe("multi_reviewer_owner_override");
  });
});

describe("getReviewContext — Phase 9B.6-R1C: governanceUpdatedAt OCC token", () => {
  it("exposes the exact canonical governanceRecord.updatedAt value, unsynthesized", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ updatedAt: "2026-08-09T12:00:00.000Z" }) });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.review.governanceUpdatedAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("decision-UI sufficiency: an assigned reviewer's context carries governanceUpdatedAt usable as review-decision's expectedUpdatedAt, with no additional read", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await call(REVIEWER_UID, "reviewer", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canSubmitDecision).toBe(true);
    expect(result.context.review.governanceUpdatedAt).toBe(GOVERNANCE_UPDATED_AT);
  });

  it("resubmit-UI sufficiency: a changes_requested context carries governanceUpdatedAt usable as review-resubmit's expectedUpdatedAt", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "changes_requested", reviewedAt: GOVERNANCE_UPDATED_AT, comment: "fix" } }) });
    const result = await call(CREATOR_UID, "member", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canResubmit).toBe(true);
    expect(result.context.review.governanceUpdatedAt).toBe(GOVERNANCE_UPDATED_AT);
  });

  it("finalize-UI sufficiency: an open, quorum-ready panel context carries governanceUpdatedAt (expectedGovernanceUpdatedAt) AND panel.revision together", async () => {
    seedPanel({ status: "open", revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canFinalize).toBe(true);
    expect(result.context.review.governanceUpdatedAt).toBe(GOVERNANCE_UPDATED_AT);
    expect(result.context.panel?.revision).toBe(1);
  });

  it("override-UI sufficiency: an override-eligible context carries governanceUpdatedAt (expectedGovernanceUpdatedAt) AND panel.revision together", async () => {
    seedPanel({ status: "open", revision: 1 });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canOverride).toBe(true);
    expect(result.context.review.governanceUpdatedAt).toBe(GOVERNANCE_UPDATED_AT);
    expect(result.context.panel?.revision).toBe(1);
  });

  it("never synthesized from an unrelated timestamp (assignment.updatedAt/panel.updatedAt/reviewedAt all differ from the true source)", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ updatedAt: "2026-08-09T12:00:00.000Z", humanReview: { status: "unreviewed" } }) });
    seedAssignment({ updatedAt: "2020-01-01T00:00:00.000Z" });
    seedPanel({ status: "cancelled", updatedAt: "2021-01-01T00:00:00.000Z" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.review.governanceUpdatedAt).toBe("2026-08-09T12:00:00.000Z");
  });
});

describe("getReviewContext — §59 assigned reviewer canSubmitDecision", () => {
  it("unreviewed + actionable assignment to caller + eligible + no panel: canSubmitDecision = true", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await call(REVIEWER_UID, "reviewer", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canSubmitDecision).toBe(true);
  });
});

describe("getReviewContext — §60 manager does not become reviewer", () => {
  it("manager with reviews.manage but assignment names someone else: canSubmitDecision = false", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await call(ADMIN_UID, "admin", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canSubmitDecision).toBe(false);
    expect(result.context.viewer.canManageAssignment).toBe(true);
  });
});

describe("getReviewContext — §61 self-review", () => {
  it("assignment corruptly names creator: canSubmitDecision = false regardless of capability", async () => {
    seedAssignment({ assignedReviewerUserId: CREATOR_UID });
    const result = await call(CREATOR_UID, "member", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canSubmitDecision).toBe(false);
  });

  it("Owner may still have canOverride true for their own artifact, independent of self-review guard", async () => {
    seedRun({ userId: OWNER_UID });
    seedPanel({ status: "open", reviewerUserIds: [ADMIN_UID, MEMBER_UID].sort() });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canOverride).toBe(true);
  });
});

describe("getReviewContext — §62 open panel forces single-review flags false", () => {
  it("open panel: canManageAssignment, canSubmitDecision, canCreatePanel all false", async () => {
    seedPanel({ status: "open" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canManageAssignment).toBe(false);
    expect(result.context.viewer.canSubmitDecision).toBe(false);
    expect(result.context.viewer.canCreatePanel).toBe(false);
  });
});

describe("getReviewContext — §63 CRITICAL: finalized panel fallback", () => {
  it("finalized panel + unreviewed + valid active assignment to caller: canSubmitDecision = true (never open||finalized suppression)", async () => {
    seedPanel({ status: "finalized", revision: 2, finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "changes_requested", finalDecisionId: "panel_workspace_dec_x", aggregationPolicyVersion: 1 });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID, revision: 1 });
    const result = await call(REVIEWER_UID, "reviewer", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canSubmitDecision).toBe(true);
    expect(result.context.panel?.status).toBe("finalized");
    expect(result.context.viewer.canReconfigurePanel).toBe(false);
    expect(result.context.viewer.canVote).toBe(false);
  });
});

describe("getReviewContext — §64 post-resubmission manager", () => {
  it("finalized panel, no active assignment, manager: canManageAssignment = true, canCreatePanel = false", async () => {
    seedPanel({ status: "finalized", revision: 2, finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "changes_requested", finalDecisionId: "panel_workspace_dec_x", aggregationPolicyVersion: 1 });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canManageAssignment).toBe(true);
    // A panel document EXISTS (finalized) -> canCreatePanel is false because
    // this backend's own putWorkspaceReviewPanel() never reopens ANY
    // non-open current panel, finalized or cancelled alike.
    expect(result.context.viewer.canCreatePanel).toBe(false);
  });
});

describe("getReviewContext — §65 cancelled panel", () => {
  it("cancelled panel does not block ordinary assignment management; matches backend's own never-reopen semantics for panel creation too", async () => {
    seedPanel({ status: "cancelled", revision: 2 });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canManageAssignment).toBe(true);
    expect(result.context.viewer.canCreatePanel).toBe(false);
    expect(result.context.viewer.canReconfigurePanel).toBe(false);
  });
});

describe("getReviewContext — §66 drain with open panel", () => {
  it("Approval not admitted + open panel exists: viewer.mode = drain, new-work flags false, drain-eligible flags follow state", async () => {
    seedPanel({ status: "open", reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const result = await call(OWNER_UID, "owner", false);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.mode).toBe("drain");
    expect(result.context.viewer.canManageAssignment).toBe(false);
    expect(result.context.viewer.canSubmitDecision).toBe(false);
    expect(result.context.viewer.canResubmit).toBe(false);
    expect(result.context.viewer.canCreatePanel).toBe(false);
    expect(result.context.viewer.canReconfigurePanel).toBe(false);
    // Drain-eligible: manager may still cancel; eligible non-voted reviewer may still vote.
    expect(result.context.viewer.canCancelPanel).toBe(true);
  });

  it("drain mode, eligible current panel reviewer who has not voted: canVote = true", async () => {
    seedPanel({ status: "open", reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const result = await call(ADMIN_UID, "admin", false);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canVote).toBe(true);
  });
});

describe("getReviewContext — §67 no panel + not admitted: concealed, never drain", () => {
  it("assignment exists, no panel, Approval not admitted: concealed not_admitted, never drain", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await call(OWNER_UID, "owner", false);
    expect(result).toEqual({ status: "not_admitted" });
  });

  it("unreviewed run, no panel, no assignment, Approval not admitted: concealed not_admitted", async () => {
    const result = await call(OWNER_UID, "owner", false);
    expect(result).toEqual({ status: "not_admitted" });
  });

  it("changes_requested without panel, Approval not admitted: concealed not_admitted (never drain-admitted on status alone)", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "changes_requested", reviewedAt: GOVERNANCE_UPDATED_AT, comment: "fix" } }) });
    const result = await call(OWNER_UID, "owner", false);
    expect(result).toEqual({ status: "not_admitted" });
  });
});

describe("getReviewContext — panel reviewer identity", () => {
  it("panel reviewers resolved to safe display names, never raw UIDs", async () => {
    seedPanel({ status: "open", reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    seedUser(OWNER_UID, { name: "Olivia Owner" });
    seedUser(ADMIN_UID, { name: "Andy Admin" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const names = result.context.panel!.reviewers.map((r) => r.displayName).sort();
    expect(names).toEqual(["Andy Admin", "Olivia Owner"]);
  });

  it("Phase 9B.6-R1C CRITICAL: a corrupted panel reviewer list naming an arbitrary foreign UID never discloses that user's real global identity", async () => {
    const foreignUid = "foreign-app-user-with-no-workspace-relationship";
    seedPanel({ status: "open", reviewerUserIds: [OWNER_UID, foreignUid].sort() });
    seedUser(OWNER_UID, { name: "Olivia Owner" });
    // Deliberately NO seedMembership() for foreignUid — but it DOES have a
    // real, resolvable global profile.
    seedUser(foreignUid, { name: "Private Other User" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const foreignReviewer = result.context.panel!.reviewers.find((r) => r.uid === foreignUid);
    expect(foreignReviewer).toBeDefined();
    expect(foreignReviewer!.displayName).toBe("Reviewer unavailable");
    expect(foreignReviewer!.displayName).not.toBe("Private Other User");
    // Stable machine uid is still present (needed for reconfiguration/candidate preselection).
    expect(foreignReviewer!.uid).toBe(foreignUid);
    // The legitimate member's own identity is unaffected.
    const ownerReviewer = result.context.panel!.reviewers.find((r) => r.uid === OWNER_UID);
    expect(ownerReviewer!.displayName).toBe("Olivia Owner");
  });

  it("hasVoted reflects only the CURRENT panel revision, never an old-revision vote", async () => {
    seedPanel({ status: "open", revision: 2, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    seedVote(OWNER_UID, 1, { status: "approved" }); // old revision — must not count
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.hasVoted).toBe(false);
  });

  it("hasVoted = true for a current-revision vote", async () => {
    seedPanel({ status: "open", revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    seedVote(OWNER_UID, 1, { status: "approved" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.hasVoted).toBe(true);
    expect(result.context.viewer.canVote).toBe(false); // already voted
  });
});

describe("getReviewContext — assignment identity + staleness", () => {
  it("removed assignee: state stale, safe display fallback, never actionable", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER2_UID });
    seedMembership(REVIEWER2_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.assignment?.state).toBe("stale");
    expect(result.context.assignment?.assignedReviewerDisplayName).toBe("Reviewer unavailable");
  });

  it("Phase 9B.6-R1C CRITICAL: corrupted assignment naming an arbitrary foreign UID never discloses that user's real global identity", async () => {
    const foreignUid = "foreign-app-user-with-no-workspace-relationship";
    seedAssignment({ assignedReviewerUserId: foreignUid });
    // Deliberately NO seedMembership() for foreignUid — but it DOES have a
    // real, resolvable global profile.
    seedUser(foreignUid, { name: "Private Other User" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.assignment?.state).toBe("stale");
    expect(result.context.assignment?.assignedReviewerDisplayName).toBe("Reviewer unavailable");
    expect(result.context.assignment?.assignedReviewerDisplayName).not.toBe("Private Other User");
    // Stable machine uid is still present.
    expect(result.context.assignment?.assignedReviewerUserId).toBe(foreignUid);
  });
});

describe("getReviewContext — Phase 9B.7: assignmentRevision is independent of assignment presentation", () => {
  it("never assigned (no assignment document at all): assignment null, assignmentRevision 0", async () => {
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.assignment).toBeNull();
    expect(result.context.assignmentRevision).toBe(0);
  });

  it("active assignment: assignmentRevision matches the persisted document's revision", async () => {
    seedAssignment({ revision: 1 });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.assignment?.assignedReviewerUserId).toBe(REVIEWER_UID);
    expect(result.context.assignmentRevision).toBe(1);
  });

  it("Phase 9B.7 CORE FIX: cleared assignment (assignedReviewerUserId null, persisted revision nonzero) -> assignment null, but assignmentRevision exposes the true nonzero revision", async () => {
    seedAssignment({ assignedReviewerUserId: null, revision: 2 });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.assignment).toBeNull();
    expect(result.context.assignmentRevision).toBe(2);
  });

  it("stale assignment (assignee no longer eligible): assignmentRevision still matches the persisted document's revision", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER2_UID, revision: 3 });
    seedMembership(REVIEWER2_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.assignment?.state).toBe("stale");
    expect(result.context.assignmentRevision).toBe(3);
  });

  it("persisted assignment document with a malformed revision -> read_failed, never fabricates assignmentRevision 0", async () => {
    seedAssignment({ revision: "not-a-number" as unknown as number });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("read_failed");
  });
});

describe("getReviewContext — quorum-driven canFinalize", () => {
  it("quorum met (ready): canFinalize = true for a manager", async () => {
    seedPanel({ status: "open", revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.panel?.voteSummary).toEqual({ submittedCount: 2, aggregationState: "ready" });
    expect(result.context.viewer.canFinalize).toBe(true);
  });

  it("quorum not met (waiting): canFinalize = false", async () => {
    seedPanel({ status: "open", revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    seedVote(OWNER_UID, 1, { status: "approved" });
    const result = await call(OWNER_UID, "owner", true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.viewer.canFinalize).toBe(false);
  });
});
