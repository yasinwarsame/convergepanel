/**
 * Review Page Reviewer Display — teamReviewQueueEnrichment.ts tests. Pure
 * builder tests (injected fake resolver), no Firestore mocking.
 */

import {
  enrichLegacyTeamRunListItem,
  enrichAdaptiveTeamRunListItem,
} from "@/lib/governance/teamReviewQueueEnrichment";
import type { LegacyTeamRunListItemV1, AdaptiveTeamRunListItemV1 } from "@/lib/governance/teamRunListContract";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1 } from "@/lib/governance/adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";

const nameByUid: Record<string, string> = {
  "reviewer-1": "Jane Smith",
  "reviewer-2": "Mohamed Ali",
  "admin-1": "Alex Owner",
};
const resolveDisplayName = async (uid: string) => nameByUid[uid] ?? `user-${uid}`;

function baseLegacyItem(overrides: Partial<LegacyTeamRunListItemV1> = {}): LegacyTeamRunListItemV1 {
  return {
    kind: "legacy",
    teamRunId: "trun-1",
    createdAt: "2026-08-12T09:00:00.000Z",
    policyFlags: [],
    blockedByPolicy: false,
    governanceReviewRequired: false,
    consensusScore: null,
    ...overrides,
  };
}

function baseAdaptiveItem(overrides: Partial<AdaptiveTeamRunListItemV1> = {}): AdaptiveTeamRunListItemV1 {
  return {
    kind: "adaptive",
    teamRunId: "trun-2",
    runId: "run-2",
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    receiptConclusion: "conclusion",
    sourceBacked: false,
    humanReviewNeeded: true,
    humanReviewStatus: "unreviewed",
    reviewable: true,
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    ...overrides,
  };
}

function makeGovernanceRecord(humanReview: Partial<GovernanceRecordV1["humanReview"]> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed", ...humanReview },
    decisionReceipt: {
      conclusion: "c",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("enrichLegacyTeamRunListItem", () => {
  it("resolves decidedBy to a safe display name and strips the raw uid", async () => {
    const item = baseLegacyItem({ humanDecision: { action: "approved", decidedAt: "2026-08-12T10:00:00.000Z", decidedBy: "reviewer-1" } });
    const result = await enrichLegacyTeamRunListItem(item, "reviewer-1", resolveDisplayName);
    expect(result.humanDecision).toEqual({
      action: "approved",
      decidedAt: "2026-08-12T10:00:00.000Z",
      reviewer: { displayName: "Jane Smith" },
    });
    expect(JSON.stringify(result)).not.toContain("reviewer-1");
    expect(JSON.stringify(result)).not.toMatch(/decidedBy/);
  });

  it("returns reviewer: null when no decidedBy is present (predates identity capture)", async () => {
    const item = baseLegacyItem({ humanDecision: { action: "rejected", decidedAt: "2026-08-12T10:00:00.000Z" } });
    const result = await enrichLegacyTeamRunListItem(item, undefined, resolveDisplayName);
    expect(result.humanDecision).toEqual({ action: "rejected", decidedAt: "2026-08-12T10:00:00.000Z", reviewer: null });
  });

  it("omits humanDecision entirely when the item has no decision yet (awaiting assignment)", async () => {
    const item = baseLegacyItem();
    const result = await enrichLegacyTeamRunListItem(item, undefined, resolveDisplayName);
    expect(result.humanDecision).toBeUndefined();
  });

  it("never reads or forwards notes (the private decision justification)", async () => {
    const item = baseLegacyItem({
      humanDecision: { action: "escalated", decidedAt: "2026-08-12T10:00:00.000Z", decidedBy: "reviewer-1" },
    });
    const contaminated = { ...item, humanDecision: { ...item.humanDecision!, notes: "PRIVATE justification text" } } as any;
    const result = await enrichLegacyTeamRunListItem(contaminated, "reviewer-1", resolveDisplayName);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});

describe("enrichAdaptiveTeamRunListItem", () => {
  it("merges singleReviewer/assignment/panel: null when no governance record exists", async () => {
    const item = baseAdaptiveItem();
    const result = await enrichAdaptiveTeamRunListItem(item, { governanceRecord: null, assignment: null, panel: null, votes: [] }, resolveDisplayName);
    expect(result.singleReviewer).toBeNull();
    expect(result.assignment).toBeNull();
    expect(result.panel).toBeNull();
    // Base item fields preserved.
    expect(result.runId).toBe("run-2");
  });

  it("surfaces a resolved assignment when one exists", async () => {
    const item = baseAdaptiveItem();
    const assignment: AdaptiveHumanReviewAssignmentV1 = {
      schemaVersion: 1,
      teamId: "team-1",
      runId: "run-2",
      assignedReviewerUserId: "reviewer-1",
      assignedAt: "2026-08-12T10:31:00.000Z",
      assignedByUserId: "admin-1",
      updatedAt: "2026-08-12T10:31:00.000Z",
      updatedByUserId: "admin-1",
      revision: 1,
    };
    const result = await enrichAdaptiveTeamRunListItem(
      item,
      { governanceRecord: makeGovernanceRecord(), assignment, panel: null, votes: [] },
      resolveDisplayName
    );
    expect(result.assignment).toMatchObject({ reviewerUserId: "reviewer-1", reviewerDisplayName: "Jane Smith" });
  });

  it("surfaces a resolved single-reviewer terminal decision", async () => {
    const item = baseAdaptiveItem({ humanReviewStatus: "approved", reviewable: false });
    const governanceRecord = makeGovernanceRecord({ status: "approved", reviewerId: "reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z", decidedVia: "single_reviewer" });
    const result = await enrichAdaptiveTeamRunListItem(item, { governanceRecord, assignment: null, panel: null, votes: [] }, resolveDisplayName);
    expect(result.singleReviewer).toEqual({ userId: "reviewer-1", displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" });
  });

  it("surfaces peer-review panel progress with resolved reviewer names", async () => {
    const item = baseAdaptiveItem();
    const panel: AdaptiveHumanReviewPanelV1 = {
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: "team-1",
      runId: "run-2",
      mode: "majority_quorum",
      reviewerUserIds: ["reviewer-1", "reviewer-2"],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-08-12T10:00:00.000Z",
      createdByUserId: "admin-1",
      updatedAt: "2026-08-12T10:00:00.000Z",
      updatedByUserId: "admin-1",
    };
    const votes: AdaptiveHumanReviewVoteV1[] = [
      {
        schemaVersion: 1,
        kind: "adaptive_human_review_vote",
        teamId: "team-1",
        runId: "run-2",
        panelRevision: 1,
        reviewerUserId: "reviewer-1",
        status: "approved",
        commentPresent: false,
        conditionsCount: 0,
        submittedAt: "2026-08-12T10:44:00.000Z",
      },
    ];
    const result = await enrichAdaptiveTeamRunListItem(item, { governanceRecord: makeGovernanceRecord(), assignment: null, panel, votes }, resolveDisplayName);
    expect(result.panel).toMatchObject({ status: "open", submittedCount: 1, requiredReviewerCount: 2, quorum: 2 });
    expect(result.panel?.reviewers).toEqual([
      { userId: "reviewer-1", displayName: "Jane Smith", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
      { userId: "reviewer-2", displayName: "Mohamed Ali", hasVoted: false },
    ]);
  });

  it("never leaks comment/justification text through the adaptive enrichment path", async () => {
    const item = baseAdaptiveItem();
    const governanceRecord = makeGovernanceRecord({
      status: "approved_with_conditions",
      reviewerId: "reviewer-1",
      comment: "PRIVATE internal note",
      conditions: ["visible condition"],
      decidedVia: "single_reviewer",
    });
    const result = await enrichAdaptiveTeamRunListItem(item, { governanceRecord, assignment: null, panel: null, votes: [] }, resolveDisplayName);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});

describe("Review-list / report Review & Governance consistency (Step 16 regression)", () => {
  it("produces IDENTICAL singleReviewer/assignment/panel shapes as buildReviewGovernanceViewModel for the same canonical data — both surfaces derive from the same source, never independently", async () => {
    const governanceRecord = makeGovernanceRecord({ status: "approved", reviewerId: "reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z", decidedVia: "single_reviewer" });
    const panel: AdaptiveHumanReviewPanelV1 = {
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: "team-1",
      runId: "run-2",
      mode: "majority_quorum",
      reviewerUserIds: ["reviewer-1", "reviewer-2"],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-08-12T10:00:00.000Z",
      createdByUserId: "admin-1",
      updatedAt: "2026-08-12T10:00:00.000Z",
      updatedByUserId: "admin-1",
    };
    const votes: AdaptiveHumanReviewVoteV1[] = [
      {
        schemaVersion: 1,
        kind: "adaptive_human_review_vote",
        teamId: "team-1",
        runId: "run-2",
        panelRevision: 1,
        reviewerUserId: "reviewer-1",
        status: "approved",
        commentPresent: false,
        conditionsCount: 0,
        submittedAt: "2026-08-12T10:44:00.000Z",
      },
    ];

    const { buildReviewGovernanceViewModel } = await import("@/lib/adaptiveSchema/reviewGovernanceViewModel");
    const reportViewModel = await buildReviewGovernanceViewModel({
      governanceRecord,
      legacy: null,
      assignment: null,
      panel,
      votes,
      resolveDisplayName,
    });

    const listItem = await enrichAdaptiveTeamRunListItem(baseAdaptiveItem(), { governanceRecord, assignment: null, panel, votes }, resolveDisplayName);

    expect(reportViewModel.family).toBe("milestone2");
    if (reportViewModel.family !== "milestone2") throw new Error("unreachable");
    expect(listItem.singleReviewer).toEqual(reportViewModel.singleReviewer);
    expect(listItem.assignment).toEqual(reportViewModel.assignment);
    expect(listItem.panel).toEqual(reportViewModel.panel);
  });
});
