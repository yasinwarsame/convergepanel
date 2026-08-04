/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — TeamReviewFilters
 * structural rendering tests.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TeamReviewFilters from "@/components/teamGovernance/TeamReviewFilters";

const noop = () => {};

describe("TeamReviewFilters", () => {
  it("renders kind, flagged, and reviewable selects with accessible labels", () => {
    const html = renderToStaticMarkup(
      createElement(TeamReviewFilters, {
        filters: { kind: "all", flagged: "any", reviewable: "any" },
        onChange: noop,
        onRefresh: noop,
        refreshing: false,
        page: 1,
        hasNextPage: true,
        hasPreviousPage: false,
        onPageChange: noop,
      })
    );
    expect(html).toContain("Kind");
    expect(html).toContain("Flagged");
    expect(html).toContain("Reviewable");
    expect(html).toContain("Refresh");
  });

  it("disables Prev on the first page and enables Next when there is a next page", () => {
    const html = renderToStaticMarkup(
      createElement(TeamReviewFilters, {
        filters: { kind: "all", flagged: "any", reviewable: "any" },
        onChange: noop,
        onRefresh: noop,
        refreshing: false,
        page: 1,
        hasNextPage: true,
        hasPreviousPage: false,
        onPageChange: noop,
      })
    );
    // Match the `disabled=""` ATTRIBUTE token specifically — not a bare
    // substring match, which would also (incorrectly) match inside a
    // Tailwind `disabled:opacity-40` class name.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous page"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Next page"/);
  });

  it("shows a refreshing label when refreshing is true", () => {
    const html = renderToStaticMarkup(
      createElement(TeamReviewFilters, {
        filters: { kind: "all", flagged: "any", reviewable: "any" },
        onChange: noop,
        onRefresh: noop,
        refreshing: true,
        page: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        onPageChange: noop,
      })
    );
    expect(html).toContain("Refreshing");
  });

  it("never renders a decision control", () => {
    const html = renderToStaticMarkup(
      createElement(TeamReviewFilters, {
        filters: { kind: "all", flagged: "any", reviewable: "any" },
        onChange: noop,
        onRefresh: noop,
        refreshing: false,
        page: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        onPageChange: noop,
      })
    );
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
  });
});
