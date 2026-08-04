/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — structural component
 * tests via `react-dom/server`'s `renderToStaticMarkup()` (no jsdom/RTL
 * available in this repo — confirmed in the Part E1.1 audit and
 * `jest.config.ts`'s `testEnvironment: "node"`). This proves REAL
 * rendering output (content/structure), not click/keyboard interaction —
 * see this file's own read-only isolation test below for the documented
 * limitation, and `teamRunListContract.spec.ts`/route test files for full
 * behavioral coverage of the underlying data.
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
import type { AdaptiveTeamRunListItemV1, LegacyTeamRunListItemV1 } from "@/lib/governance/teamRunListContract";

function adaptiveItem(overrides: Partial<AdaptiveTeamRunListItemV1> = {}): AdaptiveTeamRunListItemV1 {
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
    ...overrides,
  };
}

function legacyItem(overrides: Partial<LegacyTeamRunListItemV1> = {}): LegacyTeamRunListItemV1 {
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

describe("AdaptiveReviewListItem", () => {
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
  });

  it("never renders the raw teamRunId, a comment, or conditions", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewListItem, { item: adaptiveItem() }));
    expect(html).not.toContain("team-1:run-1");
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

  it("renders the decided action label when a humanDecision exists", () => {
    const html = renderToStaticMarkup(
      createElement(LegacyReviewListItem, { item: legacyItem({ humanDecision: { action: "approved", decidedAt: "2026-07-28T00:00:00.000Z" } }) })
    );
    expect(html).toContain("Approved");
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
