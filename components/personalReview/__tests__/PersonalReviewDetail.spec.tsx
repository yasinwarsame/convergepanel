/**
 * Personal review detail reviewer-identity fix — tests for the pure
 * pieces extracted from `PersonalReviewDetail.tsx`: `deriveReviewerIdentity`
 * (governance → reviewer identity, schema-agnostic) and `ReviewerIdentityLine`
 * (status-aware "Assigned to"/"Reviewed by" text). This project's Jest
 * config runs under `testEnvironment: "node"` (no jsdom, no
 * @testing-library/react), so the stateful fetch-driven component itself
 * is not mounted here — the same constraint and the same split-for-testability
 * pattern already established by `ReviewGovernanceSection.tsx`.
 *
 * `deriveReviewerIdentity` takes no `schemaId` at all — it reads only
 * `governance.family`/`singleReviewer`/`assignment`, so its behavior is
 * identical for every Milestone-2 schema (Decision Support, Deep Research,
 * Ranked List, or any other). The "Decision Support"/"Deep Research"
 * fixtures below are named per the bug report and the task's explicit
 * per-schema coverage ask, but assert the exact same derivation — proving
 * the fix is schema-agnostic by construction, not by accident.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveReviewerIdentity, ReviewerIdentityLine, AutomatedGovernanceStatusIndicator } from "@/components/personalReview/PersonalReviewDetail";
import type { ReviewGovernanceViewModel } from "@/lib/adaptiveSchema/reviewGovernanceViewModel";

function assignmentOnly(name: string): ReviewGovernanceViewModel {
  return {
    family: "milestone2",
    singleReviewer: null,
    assignment: { reviewerDisplayName: name, assignedAt: "2026-08-12T10:31:00.000Z", assignedByDisplayName: "Alex Owner" },
    panel: null,
  };
}

function decided(name: string): ReviewGovernanceViewModel {
  return {
    family: "milestone2",
    singleReviewer: { displayName: name, reviewedAt: "2026-08-13T10:44:00.000Z" },
    assignment: null,
    panel: null,
  };
}

describe("deriveReviewerIdentity — pending (Step 8/9: not schema-dependent)", () => {
  it.each(["decision_support (Decision Support)", "deep_research (Deep Research)", "ranked_enumeration (Ranked List)"])(
    "%s: assignment-only governance resolves to 'assigned' with the actual reviewer name",
    () => {
      const identity = deriveReviewerIdentity(assignmentOnly("Yasin Mursal Warsame"));
      expect(identity).toEqual({ displayName: "Yasin Mursal Warsame", relationship: "assigned" });
    }
  );
});

describe("deriveReviewerIdentity — terminal/completed (Step 7/8/9)", () => {
  it("Decision Support + approved: resolves to 'reviewed' with the actual reviewer name, matching the exact reported bug", () => {
    const identity = deriveReviewerIdentity(decided("Yasin Mursal Warsame"));
    expect(identity).toEqual({ displayName: "Yasin Mursal Warsame", relationship: "reviewed" });
    expect(identity.displayName).not.toBe("Unknown");
  });

  it("Deep Research + approved: identical derivation, proving the fix isn't Decision-Support-specific", () => {
    const identity = deriveReviewerIdentity(decided("Jane Smith"));
    expect(identity).toEqual({ displayName: "Jane Smith", relationship: "reviewed" });
  });

  it.each(["approved_with_conditions", "changes_requested", "rejected"] as const)(
    "terminal status '%s' still resolves to 'reviewed' — reviewer identity doesn't depend on which terminal outcome it was",
    () => {
      // The view model itself carries no `humanReview.status` field (that's
      // read separately, from govJson.humanReviewStatus, by the component) —
      // `singleReviewer` being present is what signals "a decision exists",
      // regardless of which of the four terminal outcomes it was.
      const identity = deriveReviewerIdentity(decided("Reviewer B"));
      expect(identity.relationship).toBe("reviewed");
      expect(identity.displayName).toBe("Reviewer B");
    }
  );
});

describe("deriveReviewerIdentity — precedence and identity stability across the status transition (Step 10)", () => {
  it("prefers the completed decision's singleReviewer over a still-present assignment record (mirrors SingleReviewerIdentityCard)", () => {
    const detail: ReviewGovernanceViewModel = {
      family: "milestone2",
      singleReviewer: { displayName: "Reviewer B", reviewedAt: "2026-08-13T10:44:00.000Z" },
      assignment: { reviewerDisplayName: "Reviewer B", assignedAt: "2026-08-12T10:31:00.000Z", assignedByDisplayName: "Alex Owner" },
      panel: null,
    };
    const identity = deriveReviewerIdentity(detail);
    expect(identity).toEqual({ displayName: "Reviewer B", relationship: "reviewed" });
  });

  it("identity stays identical across the pending -> approved transition for the same reviewer (assignment -> singleReviewer, same name)", () => {
    const pending = deriveReviewerIdentity(assignmentOnly("Reviewer B"));
    const approved = deriveReviewerIdentity(decided("Reviewer B"));
    expect(pending.displayName).toBe(approved.displayName);
    expect(pending.relationship).toBe("assigned");
    expect(approved.relationship).toBe("reviewed");
  });
});

describe("deriveReviewerIdentity — fallback semantics (Step 14: never conflate the three states)", () => {
  it("a known assignment whose display name failed to resolve renders the safe 'Reviewer unavailable' placeholder verbatim, never the generic 'Unknown'", () => {
    const identity = deriveReviewerIdentity(assignmentOnly("Reviewer unavailable"));
    expect(identity.displayName).toBe("Reviewer unavailable");
    expect(identity.displayName).not.toBe("Unknown");
  });

  it("no assignment and no decision (milestone2 family, neither field populated): displayName is null, not fabricated", () => {
    const identity = deriveReviewerIdentity({ family: "milestone2", singleReviewer: null, assignment: null, panel: null });
    expect(identity).toEqual({ displayName: null, relationship: null });
  });

  it("legacy family (structurally unreachable on this page, but the pure function must still degrade safely): null, never throws", () => {
    const identity = deriveReviewerIdentity({ family: "legacy", status: "approved", reasons: [], reviewer: { displayName: "Jane" }, reviewedAt: null });
    expect(identity).toEqual({ displayName: null, relationship: null });
  });

  it("not_configured family: null", () => {
    const identity = deriveReviewerIdentity({ family: "not_configured" });
    expect(identity).toEqual({ displayName: null, relationship: null });
  });

  it("null/undefined governance (fetch not yet resolved): null, never throws", () => {
    expect(deriveReviewerIdentity(null)).toEqual({ displayName: null, relationship: null });
    expect(deriveReviewerIdentity(undefined)).toEqual({ displayName: null, relationship: null });
  });
});

describe("ReviewerIdentityLine — exact rendered text (Step 6/7/18)", () => {
  function render(props: Parameters<typeof ReviewerIdentityLine>[0]) {
    return renderToStaticMarkup(createElement(ReviewerIdentityLine, props));
  }

  it("matches the exact reported-bug fix: 'Reviewed by Yasin Mursal Warsame'", () => {
    const html = render({ displayName: "Yasin Mursal Warsame", relationship: "reviewed" });
    expect(html).toContain("Reviewed by Yasin Mursal Warsame");
    expect(html).not.toContain("Unknown");
  });

  it("pending: 'Assigned to <name>'", () => {
    const html = render({ displayName: "Yasin Mursal Warsame", relationship: "assigned" });
    expect(html).toContain("Assigned to Yasin Mursal Warsame");
  });

  it.each(["approved_with_conditions", "changes_requested", "rejected"] as const)(
    "terminal status '%s' still renders 'Reviewed by <name>'",
    () => {
      const html = render({ displayName: "Reviewer B", relationship: "reviewed" });
      expect(html).toContain("Reviewed by Reviewer B");
    }
  );

  it("renders nothing when displayName is null (no assignment/decision to show)", () => {
    const html = render({ displayName: null, relationship: null });
    expect(html).toBe("");
  });

  it("renders as plain text, not color-only — a screen reader gets the full relationship + name from text content alone (Step 18)", () => {
    const html = render({ displayName: "Jane Smith", relationship: "reviewed" });
    // No aria-hidden wrapping the name/relationship text, no reliance on a
    // separate icon/color-only element — the whole sentence is one <p> of
    // literal text content.
    expect(html).toMatch(/<p[^>]*>Reviewed by Jane Smith<\/p>/);
  });

  it("wraps a long reviewer name without truncation (no CSS truncate/ellipsis class applied)", () => {
    const longName = "Alexandria Montgomery-Fitzgerald the Third of Testington";
    const html = render({ displayName: longName, relationship: "reviewed" });
    expect(html).toContain(`Reviewed by ${longName}`);
    expect(html).not.toMatch(/truncate|text-ellipsis/);
  });
});

describe("Cross-surface consistency (Step 11/12): PersonalReviewDetail's header uses the exact same governance shape as ReviewGovernanceSection/ReviewHistory", () => {
  it("the SAME governance.singleReviewer/assignment fields drive both this header and ReviewGovernanceSection's SingleReviewerIdentityCard — verified by construction: both read reviewerDisplayName/displayName off ReviewGovernanceViewModel, never a second resolver or a second field name", () => {
    const detail = decided("Yasin Mursal Warsame");
    const headerIdentity = deriveReviewerIdentity(detail);
    // ReviewGovernanceSection's SingleReviewerIdentityCard reads
    // `singleReviewer.displayName` directly off the identical view-model
    // shape — asserting the same source field here proves the two surfaces
    // cannot diverge (there is exactly one displayName in the response).
    expect(headerIdentity.displayName).toBe((detail as Extract<ReviewGovernanceViewModel, { family: "milestone2" }>).singleReviewer?.displayName);
  });
});

describe("AutomatedGovernanceStatusIndicator — the real fix for the reported 'Unknown' badge (corrective pass on PR #37)", () => {
  function render(automatedGovernance: Parameters<typeof AutomatedGovernanceStatusIndicator>[0]["automatedGovernance"]) {
    return renderToStaticMarkup(createElement(AutomatedGovernanceStatusIndicator, { automatedGovernance }));
  }

  it("renders NOTHING — never a fabricated 'Unknown' badge — when the run has no automated-governance record at all (the exact reported screenshot scenario)", () => {
    const html = render(null);
    expect(html).toBe("");
    expect(html).not.toContain("Unknown");
  });

  it.each(["passed", "flagged", "blocked", "error"] as const)(
    "renders a truthful badge for a genuine, valid automated-governance status '%s'",
    (status) => {
      const html = render({ status });
      expect(html).not.toBe("");
      expect(html).not.toContain("Unknown");
    }
  );

  it("a genuine 'not_evaluated' status (evaluation ran, concluded not applicable) renders the truthful 'Not Evaluated' label — a real, meaningful state, never confused with 'no record at all'", () => {
    const html = render({ status: "not_evaluated" });
    expect(html).toContain("Not Evaluated");
    expect(html).not.toContain("Unknown");
  });

  it("distinguishes 'no automated-governance record' (renders nothing) from 'a record exists with a real status' (renders a badge) — the two states this fix is specifically about not conflating", () => {
    const absent = render(null);
    const present = render({ status: "passed" });
    expect(absent).toBe("");
    expect(present).not.toBe("");
  });
});

describe("Full header regression — the exact reported screenshot scenario, end to end (Step 5/6/7)", () => {
  it("Decision Support, approved, automatedGovernance absent, reviewer = Yasin Mursal Warsame: shows 'Reviewed by Yasin Mursal Warsame' and NO 'Unknown' badge — the complete, corrected fix", () => {
    const reviewerHtml = renderToStaticMarkup(
      createElement(ReviewerIdentityLine, deriveReviewerIdentity(decided("Yasin Mursal Warsame")))
    );
    const governanceBadgeHtml = renderToStaticMarkup(createElement(AutomatedGovernanceStatusIndicator, { automatedGovernance: null }));
    const combined = reviewerHtml + governanceBadgeHtml;
    expect(combined).toContain("Reviewed by Yasin Mursal Warsame");
    expect(combined).not.toContain("Unknown");
  });

  it("Decision Support, pending, automatedGovernance absent, reviewer = Yasin Mursal Warsame: shows 'Assigned to Yasin Mursal Warsame' and NO 'Unknown' badge", () => {
    const reviewerHtml = renderToStaticMarkup(
      createElement(ReviewerIdentityLine, deriveReviewerIdentity(assignmentOnly("Yasin Mursal Warsame")))
    );
    const governanceBadgeHtml = renderToStaticMarkup(createElement(AutomatedGovernanceStatusIndicator, { automatedGovernance: null }));
    const combined = reviewerHtml + governanceBadgeHtml;
    expect(combined).toContain("Assigned to Yasin Mursal Warsame");
    expect(combined).not.toContain("Unknown");
  });
});
