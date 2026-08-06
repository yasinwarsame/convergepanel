/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — ReviewGovernanceSection
 * structural tests. Mirrors adaptiveReviewHistorySection.spec.tsx's mocking
 * pattern (useAuth) and source-level read-only guarantees, since Part 2 of
 * this component inlines that same read-only surface into an untrusted-by-
 * default context (a live research result, not an authenticated review
 * queue page).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import ReviewGovernanceSection from "@/components/adaptive/ReviewGovernanceSection";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

describe("ReviewGovernanceSection — Part 1, status summary (mirrors TopSummaryBar's own status tests)", () => {
  it("shows Incomplete when no humanReview is present at all", () => {
    const html = renderToStaticMarkup(createElement(ReviewGovernanceSection, {}));
    expect(html).toMatch(/review status/i);
    expect(html).toMatch(/incomplete/i);
  });

  it("distinguishes 'Unreviewed — in queue' from 'Reviewed and approved' for the same component", () => {
    const inQueue = renderToStaticMarkup(
      createElement(ReviewGovernanceSection, { humanReview: { status: "unreviewed" }, reviewRouting: "in_queue" })
    );
    expect(inQueue).toMatch(/unreviewed.*in queue/i);

    const approved = renderToStaticMarkup(createElement(ReviewGovernanceSection, { humanReview: { status: "approved" } }));
    expect(approved).toMatch(/reviewed and approved/i);
    expect(approved).not.toMatch(/unreviewed/i);
  });

  it("shows conditions verbatim, never summarized, for approved_with_conditions", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewGovernanceSection, {
        humanReview: { status: "approved_with_conditions", conditions: ["Verify the pricing figures before publishing"] },
      })
    );
    expect(html).toMatch(/Verify the pricing figures before publishing/);
  });

  it("prefixes 'Owner override' when decidedVia is multi_reviewer_owner_override", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewGovernanceSection, {
        humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override" },
      })
    );
    expect(html).toMatch(/owner override.*rejected/i);
  });
});

describe("ReviewGovernanceSection — Part 2, review history gating", () => {
  it("skips the history fetch entirely (not rendered at all) when humanReview is absent — original-9/generic schemas never have a governance record", () => {
    const html = renderToStaticMarkup(createElement(ReviewGovernanceSection, { runId: "run-1" }));
    expect(html).not.toMatch(/review history/i);
  });

  it("skips the history fetch when runId is absent, even with a real humanReview", () => {
    const html = renderToStaticMarkup(createElement(ReviewGovernanceSection, { humanReview: { status: "approved" } }));
    expect(html).not.toMatch(/review history/i);
  });

  it("renders the Review History section (loading state) when both humanReview and runId are present", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewGovernanceSection, { humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", runId: "run-1" })
    );
    expect(html).toMatch(/review history/i);
    expect(html).toMatch(/loading history/i);
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

  it("never renders reviewer identity or comment text (only status/conditions/decidedVia are read)", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewGovernanceSection, {
        humanReview: { status: "approved_with_conditions", conditions: ["A condition"] },
      })
    );
    expect(html).not.toMatch(/reviewerId|reviewerName|"comment"/i);
  });
});
