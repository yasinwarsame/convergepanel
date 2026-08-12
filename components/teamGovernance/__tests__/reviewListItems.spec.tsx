/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 (original) / Review
 * Page Reviewer Display (reviewer/assignment/panel enrichment) —
 * structural component tests via `react-dom/server`'s
 * `renderToStaticMarkup()` (no jsdom/RTL available in this repo —
 * confirmed in the Part E1.1 audit and `jest.config.ts`'s
 * `testEnvironment: "node"`). This proves REAL rendering output
 * (content/structure), not click/keyboard interaction — see this file's
 * own read-only isolation test below for the documented limitation, and
 * `teamRunListContract.spec.ts`/`teamReviewQueueEnrichment.spec.ts`/route
 * test files for full behavioral coverage of the underlying data.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GovernanceStatusBadge from "@/components/teamGovernance/GovernanceStatusBadge";
import HumanReviewStatusBadge from "@/components/teamGovernance/HumanReviewStatusBadge";
import AdaptiveReviewListItem from "@/components/teamGovernance/AdaptiveReviewListItem";
import LegacyReviewListItem from "@/components/teamGovernance/LegacyReviewListItem";
import TeamReviewListItem from "@/components/teamGovernance/TeamReviewListItem";
import ReviewEmptyState from "@/components/teamGovernance/ReviewEmptyState";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";
import type { EnrichedAdaptiveTeamRunListItemV1, EnrichedLegacyTeamRunListItemV1 } from "@/lib/governance/teamReviewQueueEnrichment";

function adaptiveItem(overrides: Partial<EnrichedAdaptiveTeamRunListItemV1> = {}): EnrichedAdaptiveTeamRunListItemV1 {
  return {
    kind: "adaptive",
    teamRunId: "team-1:run-1",
    runId: "run-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "The panel recommends option A.",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    reviewable: true,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    singleReviewer: null,
    assignment: null,
    panel: null,
    ...overrides,
  };
}

function legacyItem(overrides: Partial<EnrichedLegacyTeamRunListItemV1> = {}): EnrichedLegacyTeamRunListItemV1 {
  return {
    kind: "legacy",
    teamRunId: "legacy-1",
    createdAt: "2026-07-27T00:00:00.000Z",
    querySummary: "What is the best CRM?",
    policyFlags: ["weak_evidence"],
    blockedByPolicy: true,
    governanceReviewRequired: true,
    consensusScore: 42,
    ...overrides,
  };
}

describe("GovernanceStatusBadge", () => {
  it("renders the label text, not just a raw enum value", () => {
    const html = renderToStaticMarkup(createElement(GovernanceStatusBadge, { status: "flagged" }));
    expect(html).toContain("Flagged");
  });

  it("renders Unknown for an unrecognized status", () => {
    const html = renderToStaticMarkup(createElement(GovernanceStatusBadge, { status: "bogus" }));
    expect(html).toContain("Unknown");
  });
});

describe("HumanReviewStatusBadge", () => {
  it("renders the label text", () => {
    const html = renderToStaticMarkup(createElement(HumanReviewStatusBadge, { status: "approved_with_conditions" }));
    expect(html).toContain("Approved with Conditions");
  });
});

describe("AdaptiveReviewListItem — base rendering (unchanged)", () => {
  it("renders the Adaptive badge, schema label, conclusion, both statuses, and an Open review link", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item: adaptiveItem() }));
    expect(html).toContain("Adaptive");
    expect(html).toContain("Decision Support");
    expect(html).toContain("The panel recommends option A.");
    expect(html).toContain("Flagged");
    expect(html).toContain("Unreviewed");
    expect(html).toContain("/team/reviews/run-1");
    expect(html).toContain("Open review");
  });

  it("never renders a decision/mutation control", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item: adaptiveItem() }));
    for (const forbidden of ["Approve", "Reject", "Request Changes", "Submit"]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).not.toMatch(/<button/);
  });

  it("never renders the raw teamRunId, a comment, or conditions", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item: adaptiveItem() }));
    expect(html).not.toContain("team-1:run-1");
  });

  it("shows no reviewer block at all when nothing is configured yet (awaiting assignment)", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item: adaptiveItem() }));
    expect(html).not.toMatch(/assigned to/i);
    expect(html).not.toMatch(/peer review/i);
  });
});

describe("AdaptiveReviewListItem — single reviewer (Step 5, Step 19)", () => {
  it("shows the assigned reviewer and assignment timestamp", () => {
    const item = adaptiveItem({
      assignment: {
        reviewerUserId: "r1",
        reviewerDisplayName: "Jane Smith",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "a1",
        assignedByDisplayName: "Alex Owner",
      },
    });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/assigned to/i);
    expect(html).toContain("Jane Smith");
    expect(html).toMatch(/assigned/i);
  });

  it.each(["approved", "changes_requested", "rejected", "approved_with_conditions"] as const)(
    "shows the reviewer, decision (%s), and completion timestamp for a completed single review",
    (status) => {
      const item = adaptiveItem({
        humanReviewStatus: status,
        singleReviewer: { userId: "r1", displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" },
      });
      const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
      expect(html).toContain("Jane Smith");
      expect(html).toMatch(/completed/i);
    }
  );

  it("never reduces an available decision to a generic 'Reviewed' label", () => {
    const item = adaptiveItem({
      humanReviewStatus: "changes_requested",
      singleReviewer: { userId: "r1", displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" },
    });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/changes requested/i);
    expect(html).not.toMatch(/>\s*Reviewed\s*</i);
  });
});

describe("AdaptiveReviewListItem — peer review (Step 6, Step 19)", () => {
  function panel(overrides: Partial<NonNullable<EnrichedAdaptiveTeamRunListItemV1["panel"]>> = {}) {
    return {
      status: "open" as const,
      requiredReviewerCount: 3,
      quorum: 2,
      reviewers: [
        { userId: "r1", displayName: "Jane Smith", hasVoted: true, voteStatus: "approved" as const, submittedAt: "2026-08-12T10:44:00.000Z" },
        { userId: "r2", displayName: "Mohamed Ali", hasVoted: true, voteStatus: "changes_requested" as const, submittedAt: "2026-08-12T10:45:00.000Z" },
        { userId: "r3", displayName: "Sarah Chen", hasVoted: false },
      ],
      submittedCount: 2,
      approvalCount: 1,
      blockingCount: 1,
      ...overrides,
    };
  }

  it("labels it Peer review and shows N of M completed", () => {
    const item = adaptiveItem({ panel: panel() });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/peer review/i);
    expect(html).toMatch(/2 of 3 completed/i);
  });

  it("shows each individual reviewer identity and their own result — never hidden behind a generic 'Assigned'", () => {
    const item = adaptiveItem({ panel: panel() });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toContain("Jane Smith");
    expect(html).toContain("Mohamed Ali");
    expect(html).toContain("Sarah Chen");
    expect(html).toMatch(/pending/i);
  });

  it("collapses beyond the inline cap with a '+N more' indicator rather than an ever-taller card", () => {
    const item = adaptiveItem({
      panel: panel({
        requiredReviewerCount: 5,
        reviewers: [
          { userId: "r1", displayName: "Jane Smith", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
          { userId: "r2", displayName: "Mohamed Ali", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:45:00.000Z" },
          { userId: "r3", displayName: "Sarah Chen", hasVoted: false },
          { userId: "r4", displayName: "Extra One", hasVoted: false },
          { userId: "r5", displayName: "Extra Two", hasVoted: false },
        ],
      }),
    });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/\+2 more reviewer/i);
  });

  it("does not show a final result while quorum is incomplete (open, not finalized)", () => {
    const item = adaptiveItem({ panel: panel({ status: "open" }) });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).not.toMatch(/final result/i);
  });

  it("shows the final result once finalized via aggregation", () => {
    const item = adaptiveItem({
      panel: panel({ status: "finalized", finalStatus: "approved", finalizedAt: "2026-08-12T10:46:00.000Z", finalizedVia: "aggregation" }),
    });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/final result/i);
    expect(html).toMatch(/approved/i);
  });

  it("shows owner override distinctly from an ordinary aggregation result (Step 9)", () => {
    const item = adaptiveItem({
      panel: panel({
        status: "finalized",
        finalStatus: "rejected",
        finalizedAt: "2026-08-12T10:55:00.000Z",
        finalizedVia: "owner_override",
        overrideBy: { userId: "admin-1", displayName: "Alex Owner" },
      }),
    });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/owner override/i);
    expect(html).toContain("Alex Owner");
    expect(html).not.toMatch(/final result/i); // override banner replaces the generic final-result line, never both
  });

  it("shows cancellation and does not present a stale active-assignment look (Step 9)", () => {
    const item = adaptiveItem({ panel: panel({ status: "cancelled" }) });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/cancelled/i);
    expect(html).not.toMatch(/assigned to/i);
  });
});

describe("AdaptiveReviewListItem — enrichment failure vs genuine absence (Step 17)", () => {
  it("shows 'Review details unavailable' when enrichmentUnavailable is true, never a bare 'not assigned' look", () => {
    const item = adaptiveItem({ enrichmentUnavailable: true });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).toMatch(/review details unavailable/i);
  });

  it("shows nothing (not 'unavailable') when reviewer data is genuinely absent", () => {
    const item = adaptiveItem();
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).not.toMatch(/unavailable/i);
  });
});

describe("AdaptiveReviewListItem — privacy (Step 10)", () => {
  it("never renders a raw reviewer uid as visible text, only inside a resolved display name pairing", () => {
    const item = adaptiveItem({
      assignment: {
        reviewerUserId: "reviewer-raw-uid-123",
        reviewerDisplayName: "Jane Smith",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "a1",
        assignedByDisplayName: "Alex Owner",
      },
    });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item }));
    expect(html).not.toContain("reviewer-raw-uid-123");
  });
});

describe("LegacyReviewListItem", () => {
  it("renders the Legacy badge, query summary, policy flag count, consensus, and decision label", () => {
    const html = renderToStaticMarkup(createElement(LegacyReviewListItem, { item: legacyItem() }));
    expect(html).toContain("Legacy");
    expect(html).toContain("What is the best CRM?");
    expect(html).toContain("1 policy flag");
    expect(html).toContain("Consensus 42/100");
    expect(html).toContain("No decision yet");
  });

  it("renders the decided action label and resolved reviewer identity when a humanDecision exists", () => {
    const html = renderToStaticMarkup(
      createElement(LegacyReviewListItem, {
        item: legacyItem({ humanDecision: { action: "approved", decidedAt: "2026-07-28T00:00:00.000Z", reviewer: { displayName: "Jane Smith" } } }),
      })
    );
    expect(html).toContain("Approved");
    expect(html).toContain("Jane Smith");
  });

  it("falls back to 'Unknown reviewer' rather than a raw uid or blank when identity cannot be resolved", () => {
    const html = renderToStaticMarkup(
      createElement(LegacyReviewListItem, {
        item: legacyItem({ humanDecision: { action: "rejected", decidedAt: "2026-07-28T00:00:00.000Z", reviewer: null } }),
      })
    );
    expect(html).toMatch(/unknown reviewer/i);
  });

  it("never renders an Open review link (no adaptive-style detail page exists for legacy rows)", () => {
    const html = renderToStaticMarkup(createElement(LegacyReviewListItem, { item: legacyItem() }));
    expect(html).not.toContain("/team/reviews/");
    expect(html).not.toContain("Open review");
  });
});

describe("TeamReviewListItem — dispatch", () => {
  it("renders the adaptive renderer for an adaptive item", () => {
    const html = renderToStaticMarkup(createElement(TeamReviewListItem, { item: adaptiveItem() }));
    expect(html).toContain("Adaptive");
  });

  it("renders the legacy renderer for a legacy item", () => {
    const html = renderToStaticMarkup(createElement(TeamReviewListItem, { item: legacyItem() }));
    expect(html).toContain("Legacy");
  });
});

describe("ReviewEmptyState / ReviewErrorState", () => {
  it("renders the given title and message", () => {
    const html = renderToStaticMarkup(createElement(ReviewEmptyState, { title: "No review items", message: "Nothing here yet." }));
    expect(html).toContain("No review items");
    expect(html).toContain("Nothing here yet.");
  });

  it("renders only the given error message, and a Retry button only when onRetry is provided", () => {
    const withoutRetry = renderToStaticMarkup(createElement(ReviewErrorState, { message: "Service unavailable." }));
    expect(withoutRetry).toContain("Service unavailable.");
    expect(withoutRetry).not.toContain("Retry");

    const withRetry = renderToStaticMarkup(createElement(ReviewErrorState, { message: "Service unavailable.", onRetry: () => {} }));
    expect(withRetry).toContain("Retry");
  });
});
