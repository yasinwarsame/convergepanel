/**
 * Review & Governance report completion — pure builder tests. Uses a fake
 * `resolveDisplayName` injected per test, so none of this needs Firestore
 * mocking (see reviewGovernanceViewModel.ts's own doc comment on why the
 * resolver is injected rather than imported).
 */

import {
  buildReviewGovernanceViewModel,
  decidedViaLabel,
  BuildReviewGovernanceViewModelInput,
} from "@/lib/adaptiveSchema/reviewGovernanceViewModel";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1 } from "@/lib/governance/adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";

const nameByUid: Record<string, string> = {
  "reviewer-1": "Jane Smith",
  "reviewer-2": "Mohamed Ali",
  "reviewer-3": "Sarah Chen",
  "admin-1": "Alex Owner",
};
const resolveDisplayName = async (uid: string) => nameByUid[uid] ?? `user-${uid}`;

function baseInput(overrides: Partial<BuildReviewGovernanceViewModelInput> = {}): BuildReviewGovernanceViewModelInput {
  return {
    governanceRecord: null,
    legacy: null,
    assignment: null,
    panel: null,
    votes: [],
    resolveDisplayName,
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
      conclusion: "conclusion",
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

function makeAssignment(overrides: Partial<AdaptiveHumanReviewAssignmentV1> = {}): AdaptiveHumanReviewAssignmentV1 {
  return {
    schemaVersion: 1,
    teamId: "team-1",
    runId: "run-1",
    assignedReviewerUserId: "reviewer-1",
    assignedAt: "2026-08-12T10:31:00.000Z",
    assignedByUserId: "admin-1",
    updatedAt: "2026-08-12T10:31:00.000Z",
    updatedByUserId: "admin-1",
    revision: 1,
    ...overrides,
  };
}

function makePanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: "team-1",
    runId: "run-1",
    mode: "majority_quorum",
    reviewerUserIds: ["reviewer-1", "reviewer-2", "reviewer-3"],
    requiredReviewerCount: 3,
    quorum: 2,
    status: "open",
    revision: 1,
    createdAt: "2026-08-12T10:00:00.000Z",
    createdByUserId: "admin-1",
    updatedAt: "2026-08-12T10:00:00.000Z",
    updatedByUserId: "admin-1",
    ...overrides,
  };
}

function makeVote(overrides: Partial<AdaptiveHumanReviewVoteV1> = {}): AdaptiveHumanReviewVoteV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: "team-1",
    runId: "run-1",
    panelRevision: 1,
    reviewerUserId: "reviewer-1",
    status: "approved",
    commentPresent: false,
    conditionsCount: 0,
    submittedAt: "2026-08-12T10:44:00.000Z",
    ...overrides,
  };
}

describe("buildReviewGovernanceViewModel — family classification", () => {
  it("returns not_configured when neither a governanceRecord nor a legacy status exists", async () => {
    const result = await buildReviewGovernanceViewModel(baseInput());
    expect(result).toEqual({ family: "not_configured" });
  });

  it("returns milestone2 whenever governanceRecord is present, even if legacy fields are also (incorrectly) supplied", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({
        governanceRecord: makeGovernanceRecord(),
        legacy: { status: "approved", reasons: [], reviewedByUid: null, reviewedAt: null },
      })
    );
    expect(result.family).toBe("milestone2");
  });

  it("returns legacy when governanceRecord is absent but a legacy status exists", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({ legacy: { status: "needs_review", reasons: ["flagged"], reviewedByUid: null, reviewedAt: null } })
    );
    expect(result).toEqual({ family: "legacy", status: "needs_review", reasons: ["flagged"], reviewer: null, reviewedAt: null });
  });
});

describe("buildReviewGovernanceViewModel — legacy family", () => {
  it("resolves the reviewer's display name when governanceReviewedBy is present", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({
        legacy: { status: "approved", reasons: [], reviewedByUid: "reviewer-1", reviewedAt: "2026-08-12T11:00:00.000Z" },
      })
    );
    expect(result).toEqual({
      family: "legacy",
      status: "approved",
      reasons: [],
      reviewer: { displayName: "Jane Smith" },
      reviewedAt: "2026-08-12T11:00:00.000Z",
    });
  });

  it.each(["approved", "needs_review", "blocked"] as const)("supports legacy status %s", async (status) => {
    const result = await buildReviewGovernanceViewModel(baseInput({ legacy: { status, reasons: [], reviewedByUid: null, reviewedAt: null } }));
    expect(result).toMatchObject({ family: "legacy", status });
  });
});

describe("buildReviewGovernanceViewModel — milestone2, unreviewed / assignment", () => {
  it("has no singleReviewer/assignment/panel when nothing has happened yet", async () => {
    const result = await buildReviewGovernanceViewModel(baseInput({ governanceRecord: makeGovernanceRecord() }));
    expect(result).toEqual({ family: "milestone2", singleReviewer: null, assignment: null, panel: null });
  });

  it("surfaces a resolved assignment when one exists and the review is still unreviewed", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({ governanceRecord: makeGovernanceRecord(), assignment: makeAssignment() })
    );
    expect(result).toMatchObject({
      family: "milestone2",
      singleReviewer: null,
      assignment: {
        reviewerUserId: "reviewer-1",
        reviewerDisplayName: "Jane Smith",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "admin-1",
        assignedByDisplayName: "Alex Owner",
      },
    });
  });

  it("omits assignment when the assignment document exists but is currently unassigned", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({ governanceRecord: makeGovernanceRecord(), assignment: makeAssignment({ assignedReviewerUserId: null, assignedAt: null, assignedByUserId: null }) })
    );
    expect(result).toMatchObject({ family: "milestone2", assignment: null });
  });
});

describe("buildReviewGovernanceViewModel — milestone2, single-reviewer terminal decisions", () => {
  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"] as const)(
    "surfaces the resolved single reviewer for status %s",
    async (status) => {
      const result = await buildReviewGovernanceViewModel(
        baseInput({
          governanceRecord: makeGovernanceRecord({
            status,
            reviewerId: "reviewer-1",
            reviewedAt: "2026-08-12T10:44:00.000Z",
            decidedVia: "single_reviewer",
          }),
        })
      );
      expect(result).toMatchObject({
        family: "milestone2",
        singleReviewer: { userId: "reviewer-1", displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" },
      });
    }
  );

  it("treats an absent decidedVia identically to single_reviewer (pre-multi-reviewer decisions)", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({ governanceRecord: makeGovernanceRecord({ status: "approved", reviewerId: "reviewer-1" }) })
    );
    expect(result).toMatchObject({ singleReviewer: { userId: "reviewer-1" } });
  });

  it("does NOT populate singleReviewer for a multi-reviewer decision, even though reviewerId is set to the overriding owner", async () => {
    const result = await buildReviewGovernanceViewModel(
      baseInput({
        governanceRecord: makeGovernanceRecord({
          status: "rejected",
          reviewerId: "admin-1",
          decidedVia: "multi_reviewer_owner_override",
        }),
      })
    );
    expect(result).toMatchObject({ singleReviewer: null });
  });
});

describe("buildReviewGovernanceViewModel — milestone2, peer-review panel", () => {
  it("reflects an open panel awaiting quorum with partial votes", async () => {
    const panel = makePanel();
    const votes = [makeVote({ reviewerUserId: "reviewer-1", status: "approved" })];
    const result = await buildReviewGovernanceViewModel(baseInput({ governanceRecord: makeGovernanceRecord(), panel, votes }));
    expect(result).toMatchObject({
      family: "milestone2",
      panel: {
        status: "open",
        requiredReviewerCount: 3,
        quorum: 2,
        submittedCount: 1,
        approvalCount: 1,
        blockingCount: 0,
        aggregationState: "waiting",
      },
    });
    const panelResult = (result as any).panel;
    expect(panelResult.reviewers).toEqual([
      { userId: "reviewer-1", displayName: "Jane Smith", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
      { userId: "reviewer-2", displayName: "Mohamed Ali", hasVoted: false },
      { userId: "reviewer-3", displayName: "Sarah Chen", hasVoted: false },
    ]);
  });

  it("reflects an open panel that has reached quorum and is ready to finalize", async () => {
    const panel = makePanel();
    const votes = [
      makeVote({ reviewerUserId: "reviewer-1", status: "approved" }),
      makeVote({ reviewerUserId: "reviewer-2", status: "approved_with_conditions", conditions: ["Double-check figures"], commentPresent: false, conditionsCount: 1 }),
    ];
    const result = await buildReviewGovernanceViewModel(baseInput({ governanceRecord: makeGovernanceRecord(), panel, votes }));
    expect(result).toMatchObject({
      panel: { status: "open", aggregationState: "ready", submittedCount: 2, approvalCount: 2, blockingCount: 0 },
    });
    // Condition TEXT must never leak into the view model, even though the underlying vote carries it.
    expect(JSON.stringify(result)).not.toContain("Double-check figures");
  });

  it("reflects a finalized panel decided via aggregation", async () => {
    const panel = makePanel({
      status: "finalized",
      finalStatus: "approved",
      finalizedAt: "2026-08-12T10:50:00.000Z",
      finalizedByUserId: "admin-1",
      finalDecisionId: "decision-1",
      aggregationPolicyVersion: 1,
      finalizedVia: "aggregation",
    });
    const result = await buildReviewGovernanceViewModel(baseInput({ governanceRecord: makeGovernanceRecord(), panel, votes: [] }));
    expect(result).toMatchObject({
      panel: { status: "finalized", finalStatus: "approved", finalizedAt: "2026-08-12T10:50:00.000Z", finalizedVia: "aggregation" },
    });
    expect((result as any).panel.overrideBy).toBeUndefined();
  });

  it("reflects a finalized panel decided via owner override, resolving the override actor's identity", async () => {
    const panel = makePanel({
      status: "finalized",
      finalStatus: "rejected",
      finalizedAt: "2026-08-12T10:55:00.000Z",
      finalizedByUserId: "admin-1",
      finalDecisionId: "decision-2",
      aggregationPolicyVersion: 1,
      finalizedVia: "owner_override",
      overrideJustificationPresent: true,
      overrideByUserId: "admin-1",
    });
    const result = await buildReviewGovernanceViewModel(baseInput({ governanceRecord: makeGovernanceRecord(), panel, votes: [] }));
    expect(result).toMatchObject({
      panel: {
        status: "finalized",
        finalStatus: "rejected",
        finalizedVia: "owner_override",
        overrideBy: { userId: "admin-1", displayName: "Alex Owner" },
      },
    });
  });

  it("reflects a cancelled panel without crashing when no votes are supplied", async () => {
    const panel = makePanel({ status: "cancelled" });
    const result = await buildReviewGovernanceViewModel(baseInput({ governanceRecord: makeGovernanceRecord(), panel, votes: [] }));
    expect(result).toMatchObject({
      panel: { status: "cancelled", submittedCount: 0, approvalCount: 0, blockingCount: 0 },
    });
    expect((result as any).panel.aggregationState).toBeUndefined();
  });
});

describe("buildReviewGovernanceViewModel — regression: no teamRuns/routing input exists to derive from", () => {
  it("produces an identical result regardless of any extraneous teamRuns-shaped field smuggled onto the input", async () => {
    const input = baseInput({ governanceRecord: makeGovernanceRecord({ status: "approved", reviewerId: "reviewer-1" }) });
    const withoutExtra = await buildReviewGovernanceViewModel(input);

    // The builder's own TypeScript input type has no `teamRuns`/`reviewRouting`
    // field at all — this simulates a caller mistakenly attaching one (e.g. a
    // stale/mismatched teamRuns projection) via an `any`-cast and proves it is
    // never read, since the builder's signature gives it nowhere to go.
    const contaminated = { ...input, teamRuns: { humanReviewStatus: "approved", reviewedAt: "2099-01-01T00:00:00.000Z" } } as any;
    const withExtra = await buildReviewGovernanceViewModel(contaminated);

    expect(withExtra).toEqual(withoutExtra);
  });
});

describe("decidedViaLabel", () => {
  it("maps known values to real display copy", () => {
    expect(decidedViaLabel("single_reviewer")).toBe("Single reviewer");
    expect(decidedViaLabel("multi_reviewer_panel")).toBe("Reviewer panel (majority)");
    expect(decidedViaLabel("multi_reviewer_owner_override")).toBe("Owner override");
  });

  it("falls back to a mechanical replace for an unknown future value", () => {
    expect(decidedViaLabel("some_future_value")).toBe("some future value");
  });

  it("returns null for null/undefined", () => {
    expect(decidedViaLabel(null)).toBeNull();
    expect(decidedViaLabel(undefined)).toBeNull();
  });
});
