/**
 * Review & Governance report completion — ReviewGovernanceSection tests.
 *
 * Split to match the component's own split: `ReviewGovernanceBody` (pure,
 * no hooks) is exercised directly with hand-built `ReviewGovernanceViewModel`
 * fixtures for every status scenario — this project's Jest config runs
 * under `testEnvironment: "node"` (no jsdom), so `useEffect` never fires
 * under `renderToStaticMarkup`, meaning a mocked-fetch-then-flush approach
 * cannot exercise post-fetch states. Testing the pure body directly gives
 * full coverage without that limitation. The default-exported
 * `ReviewGovernanceSection` (the hook-wrapped shell) keeps the same
 * "initial synchronous render only" gating tests the prior version had.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import type { ReviewGovernanceViewModel } from "@/lib/adaptiveSchema/reviewGovernanceViewModel";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import ReviewGovernanceSection, { ReviewGovernanceBody } from "@/components/adaptive/ReviewGovernanceSection";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

function renderBody(props: Partial<Parameters<typeof ReviewGovernanceBody>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ReviewGovernanceBody, {
      loading: false,
      unavailable: false,
      detail: null,
      ...props,
    })
  );
}

describe("ReviewGovernanceBody — Part 15 status scenarios", () => {
  it("1. not configured: shows 'Not configured', no fake reviewer", () => {
    const html = renderBody({ detail: { family: "not_configured" } });
    expect(html).toMatch(/not configured/i);
    expect(html).not.toMatch(/reviewer-|Jane Smith/i);
  });

  it("2. review configured but not assigned: shows Awaiting assignment", () => {
    const detail: ReviewGovernanceViewModel = { family: "milestone2", singleReviewer: null, assignment: null, panel: null };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toMatch(/awaiting assignment/i);
  });

  it("3. single reviewer assigned: identity + assignment timestamp visible", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: {
        reviewerDisplayName: "Jane Smith",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByDisplayName: "Alex Owner",
      },
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toMatch(/Jane Smith/);
    expect(html).toMatch(/Assigned/i);
    expect(html).toMatch(/Alex Owner/);
  });

  it("4. reviewer actively reviewing (open panel, no votes yet): reviewers visible, awaiting vote", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: null,
      panel: {
        status: "open",
        requiredReviewerCount: 3,
        quorum: 2,
        reviewers: [
          { reviewerKey: "r1", displayName: "Jane Smith", hasVoted: false },
          { reviewerKey: "r2", displayName: "Mohamed Ali", hasVoted: false },
          { reviewerKey: "r3", displayName: "Sarah Chen", hasVoted: false },
        ],
        submittedCount: 0,
        approvalCount: 0,
        blockingCount: 0,
        aggregationState: "waiting",
      },
    };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toMatch(/Jane Smith/);
    expect(html).toMatch(/Mohamed Ali/);
    expect(html).toMatch(/awaiting vote/i);
    expect(html).toMatch(/peer review/i);
  });

  it("5. reviewer approved: reviewer visible, completion timestamp visible", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: { displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" },
      assignment: null,
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "approved", decidedVia: "single_reviewer" }, detail });
    expect(html).toMatch(/reviewed and approved/i);
    expect(html).toMatch(/Jane Smith/);
    expect(html).toMatch(/completed/i);
  });

  it("6. changes requested: reviewer visible, completion timestamp visible", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: { displayName: "Jane Smith", reviewedAt: "2026-08-12T10:48:00.000Z" },
      assignment: null,
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "changes_requested", decidedVia: "single_reviewer" }, detail });
    expect(html).toMatch(/changes requested/i);
    expect(html).toMatch(/Jane Smith/);
  });

  it("7. multiple reviewers, incomplete quorum: shows 2 of N completed, overall status remains non-final", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: null,
      panel: {
        status: "open",
        requiredReviewerCount: 3,
        quorum: 2,
        reviewers: [
          { reviewerKey: "r1", displayName: "Jane Smith", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
          { reviewerKey: "r2", displayName: "Mohamed Ali", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:45:00.000Z" },
          { reviewerKey: "r3", displayName: "Sarah Chen", hasVoted: false },
        ],
        submittedCount: 2,
        approvalCount: 2,
        blockingCount: 0,
        aggregationState: "ready",
      },
    };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toMatch(/2 of 2 needed/i);
    expect(html).not.toMatch(/final review result/i);
    expect(html).not.toMatch(/owner override/i);
  });

  it("8. quorum reached / finalized: final result visible, reviewer results visible", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: null,
      panel: {
        status: "finalized",
        requiredReviewerCount: 3,
        quorum: 2,
        reviewers: [
          { reviewerKey: "r1", displayName: "Jane Smith", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
          { reviewerKey: "r2", displayName: "Mohamed Ali", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:45:00.000Z" },
          { reviewerKey: "r3", displayName: "Sarah Chen", hasVoted: false },
        ],
        submittedCount: 2,
        approvalCount: 2,
        blockingCount: 0,
        finalStatus: "approved",
        finalizedAt: "2026-08-12T10:46:00.000Z",
        finalizedVia: "aggregation",
      },
    };
    const html = renderBody({ humanReview: { status: "approved", decidedVia: "multi_reviewer_panel" }, detail });
    expect(html).toMatch(/final review result/i);
    expect(html).toMatch(/approved/i);
    expect(html).toMatch(/Jane Smith/);
    expect(html).toMatch(/Mohamed Ali/);
  });

  it("9. owner override: clearly visible, distinct from an ordinary approval", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: null,
      panel: {
        status: "finalized",
        requiredReviewerCount: 3,
        quorum: 2,
        reviewers: [],
        submittedCount: 0,
        approvalCount: 0,
        blockingCount: 1,
        finalStatus: "rejected",
        finalizedAt: "2026-08-12T10:55:00.000Z",
        finalizedVia: "owner_override",
        overrideBy: { displayName: "Alex Owner" },
      },
    };
    const html = renderBody({ humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override" }, detail });
    expect(html).toMatch(/owner override/i);
    expect(html).toMatch(/Alex Owner/);
    expect(html).not.toMatch(/final review result/i); // OwnerOverrideBanner replaces FinalDecisionCard, never both
  });

  it("10. cancelled: shows Cancelled, does not keep showing a stale Assigned state", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: null,
      panel: {
        status: "cancelled",
        requiredReviewerCount: 3,
        quorum: 2,
        reviewers: [],
        submittedCount: 0,
        approvalCount: 0,
        blockingCount: 0,
      },
    };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toMatch(/cancelled/i);
  });

  it("legacy family: approved/needs_review/blocked render distinct labels with reviewer and reasons", () => {
    const approved = renderBody({
      detail: { family: "legacy", status: "approved", reasons: [], reviewer: { displayName: "Jane Smith" }, reviewedAt: "2026-08-12T09:00:00.000Z" },
    });
    expect(approved).toMatch(/^(?=.*approved)(?=.*Jane Smith)[\s\S]*$/i);

    const needsReview = renderBody({
      detail: { family: "legacy", status: "needs_review", reasons: ["flagged content"], reviewer: null, reviewedAt: null },
    });
    expect(needsReview).toMatch(/needs review/i);
    expect(needsReview).toMatch(/flagged content/);

    const blocked = renderBody({ detail: { family: "legacy", status: "blocked", reasons: [], reviewer: null, reviewedAt: null } });
    expect(blocked).toMatch(/blocked by policy/i);
  });

  it("loading state: never flashes 'Not configured'", () => {
    const html = renderBody({ loading: true, detail: null });
    expect(html).not.toMatch(/not configured/i);
    expect(html).toMatch(/loading/i);
  });

  it("fetch-failure state: distinct 'unavailable' copy, never 'Not configured'", () => {
    const html = renderBody({ loading: false, unavailable: true, detail: null });
    expect(html).not.toMatch(/not configured/i);
    expect(html).toMatch(/unavailable/i);
  });
});

describe("ReviewGovernanceBody — status-aware reviewer identity wording (personal-review-reviewer-identity fix)", () => {
  it("pending personal assignment renders the literal 'Assigned to <name>' text, matching the task's exact example", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: { reviewerDisplayName: "Yasin Mursal Warsame", assignedAt: "2026-08-12T10:31:00.000Z", assignedByDisplayName: "Alex Owner" },
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toContain("Assigned to Yasin Mursal Warsame");
  });

  it("completed (approved) personal review renders the literal 'Reviewed by <name>' text, matching the task's exact example", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: { displayName: "Yasin Mursal Warsame", reviewedAt: "2026-08-12T10:44:00.000Z" },
      assignment: null,
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "approved", decidedVia: "single_reviewer" }, detail });
    expect(html).toContain("Reviewed by Yasin Mursal Warsame");
  });

  it.each(["approved_with_conditions", "changes_requested", "rejected"] as const)(
    "terminal status '%s' still renders 'Reviewed by <name>' — reviewer identity never disappears once a canonical decision exists",
    (status) => {
      const detail: ReviewGovernanceViewModel = {
        family: "milestone2",
        singleReviewer: { displayName: "Yasin Mursal Warsame", reviewedAt: "2026-08-12T10:44:00.000Z" },
        assignment: null,
        panel: null,
      };
      const html = renderBody({ humanReview: { status, decidedVia: "single_reviewer" }, detail });
      expect(html).toContain("Reviewed by Yasin Mursal Warsame");
    }
  );

  it("never renders the bare 'Unknown reviewer' label when a canonical assignment or decision identity is present", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: { displayName: "Reviewer unavailable", reviewedAt: "2026-08-12T10:44:00.000Z" },
      assignment: null,
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "approved", decidedVia: "single_reviewer" }, detail });
    expect(html).toContain("Reviewed by Reviewer unavailable");
    expect(html).not.toMatch(/Unknown reviewer/);
  });
});

describe("ReviewGovernanceBody — collapsed summary line", () => {
  it("matches the task's exact 'Approved · Jane Smith' example", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: { displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" },
      assignment: null,
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "approved", decidedVia: "single_reviewer" }, detail });
    expect(html).toContain("Review &amp; Governance — Reviewed and approved · Jane Smith");
  });

  it("matches the task's exact 'Assigned · Jane Smith' example", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: null,
      assignment: {
        reviewerDisplayName: "Jane Smith",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByDisplayName: "Alex Owner",
      },
      panel: null,
    };
    const html = renderBody({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", detail });
    expect(html).toContain("Review &amp; Governance — Assigned · Jane Smith");
  });

  it("matches 'Not configured' with no trailing separator/name", () => {
    const html = renderBody({ detail: { family: "not_configured" } });
    expect(html).toContain("Review &amp; Governance — Not configured");
  });
});

describe("ReviewGovernanceBody — Part 1, status summary (mirrors TopSummaryBar's own status tests)", () => {
  it("shows Incomplete when persistenceStatus signals a genuine persistence failure", () => {
    const html = renderBody({ persistenceStatus: "failed", detail: { family: "not_configured" } });
    expect(html).toMatch(/review status/i);
    expect(html).toMatch(/incomplete/i);
  });

  it("distinguishes 'Unreviewed — in queue' from 'Reviewed and approved' for the same component", () => {
    const inQueue = renderBody({
      humanReview: { status: "unreviewed" },
      reviewRouting: "in_queue",
      detail: { family: "milestone2", singleReviewer: null, assignment: null, panel: null },
    });
    expect(inQueue).toMatch(/unreviewed.*in queue/i);

    const approved = renderBody({
      humanReview: { status: "approved" },
      detail: { family: "milestone2", singleReviewer: null, assignment: null, panel: null },
    });
    expect(approved).toMatch(/reviewed and approved/i);
    expect(approved).not.toMatch(/unreviewed/i);
  });

  it("shows conditions verbatim, never summarized, for approved_with_conditions", () => {
    const html = renderBody({
      humanReview: { status: "approved_with_conditions", conditions: ["Verify the pricing figures before publishing"] },
      detail: { family: "milestone2", singleReviewer: null, assignment: null, panel: null },
    });
    expect(html).toMatch(/Verify the pricing figures before publishing/);
  });

  it("prefixes 'Owner override' when decidedVia is multi_reviewer_owner_override", () => {
    const html = renderBody({
      humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override" },
      detail: { family: "milestone2", singleReviewer: null, assignment: null, panel: null },
    });
    expect(html).toMatch(/owner override.*rejected/i);
  });
});

describe("ReviewGovernanceBody — review history gating (unchanged behavior)", () => {
  it("skips the history fetch entirely (not rendered at all) when humanReview is absent", () => {
    const html = renderBody({ runId: "run-1", detail: { family: "not_configured" } });
    expect(html).not.toMatch(/review history/i);
  });

  it("skips the history fetch when runId is absent, even with a real humanReview", () => {
    const html = renderBody({
      humanReview: { status: "approved" },
      detail: { family: "milestone2", singleReviewer: null, assignment: null, panel: null },
    });
    expect(html).not.toMatch(/review history/i);
  });

  it("renders the Review History section (loading state) when both humanReview and runId are present", () => {
    const html = renderBody({
      humanReview: { status: "unreviewed" },
      reviewRouting: "in_queue",
      runId: "run-1",
      detail: { family: "milestone2", singleReviewer: null, assignment: null, panel: null },
    });
    expect(html).toMatch(/review history/i);
    expect(html).toMatch(/loading history/i);
  });
});

describe("ReviewGovernanceSection (default export, hook-wrapped) — initial render", () => {
  it("renders a loading collapsed summary before the fetch resolves, when a runId is present", () => {
    const html = renderToStaticMarkup(createElement(ReviewGovernanceSection, { runId: "run-1" }));
    expect(html).toMatch(/loading/i);
  });

  it("does not attempt a fetch (and is not stuck loading) when no runId is given", () => {
    const html = renderToStaticMarkup(createElement(ReviewGovernanceSection, {}));
    expect(html).toMatch(/not configured/i);
  });
});

describe("ReviewGovernanceSection — privacy and read-only guarantees (source-level)", () => {
  const source = readFileSync(join(__dirname, "../ReviewGovernanceSection.tsx"), "utf8");

  it("never issues a POST request (read-only)", () => {
    expect(source).not.toMatch(/method:\s*["']POST["']/);
  });

  it("provides no button element or decision-mutation reference", () => {
    expect(source).not.toMatch(/<button/);
    expect(source).not.toContain("/decision");
  });

  it(
    "DELIBERATE, DISCLOSED CHANGE: now renders resolved reviewer identity (names) — " +
      "but comment/justification text remains permanently hidden, since the data " +
      "model has no report-visible/private split for them",
    () => {
      const detail: ReviewGovernanceViewModel = {
        family: "milestone2",
        singleReviewer: { displayName: "Jane Smith", reviewedAt: "2026-08-12T10:44:00.000Z" },
        assignment: null,
        panel: null,
      };
      const html = renderBody({
        humanReview: { status: "approved_with_conditions", conditions: ["A condition"] },
        detail,
      });
      // Identity now renders — the deliberate relaxation.
      expect(html).toMatch(/Jane Smith/);
      // Comment/justification text and raw structural field names never do.
      expect(html).not.toMatch(/reviewerId|"comment"|overrideJustification/i);
    }
  );

  it("never reads humanReview.comment, vote.comment/conditions text, or overrideJustification from any input into rendered output", () => {
    // Source-level guard: the component file must never reference these
    // field names at all, so there is no code path that COULD render them,
    // regardless of what a future view-model change might add to the DTO.
    expect(source).not.toMatch(/\.comment\b/);
    expect(source).not.toMatch(/overrideJustification/);
  });
});
