/**
 * Personal reviewer main-app navigation — regression tests for the exact
 * link destinations. "Back to my reviews" and "Back to ConvergePanel" are
 * two genuinely different actions (-> /reviews vs -> /, the main
 * authenticated ConvergePanel application) and must never collapse onto
 * the same href. No hooks/state in this component, so it renders cleanly
 * under `renderToStaticMarkup` in this project's no-jsdom Jest environment.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReviewerNavigation from "@/components/personalReview/ReviewerNavigation";

function render(showBackToReviews: boolean) {
  return renderToStaticMarkup(createElement(ReviewerNavigation, { showBackToReviews }));
}

describe("ReviewerNavigation — /reviews (inbox): showBackToReviews=false", () => {
  const html = render(false);

  it("shows 'Back to ConvergePanel' visibly", () => {
    expect(html).toContain("Back to ConvergePanel");
  });

  it("the 'Back to ConvergePanel' link points at the main app root ('/'), not /reviews", () => {
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>[\s\S]*Back to ConvergePanel/);
  });

  it("does not render 'Back to my reviews' — there is no reviews-list level above the inbox itself", () => {
    expect(html).not.toContain("Back to my reviews");
  });

  it("renders exactly one link, as real, accessible <a> markup via Next Link (never icon-only, never a bare onClick div)", () => {
    const anchorCount = (html.match(/<a\b/g) || []).length;
    expect(anchorCount).toBe(1);
    expect(html).toMatch(/<a[^>]*>/);
  });
});

describe("ReviewerNavigation — /reviews/[runId] (detail): showBackToReviews=true", () => {
  const html = render(true);

  it("preserves 'Back to my reviews' as the primary link, pointing at /reviews (never removed, never repointed)", () => {
    expect(html).toContain("Back to my reviews");
    expect(html).toMatch(/<a[^>]*href="\/reviews"[^>]*>[\s\S]*Back to my reviews/);
  });

  it("also shows 'Back to ConvergePanel' as a secondary link, pointing at '/' — the two destinations are never the same href", () => {
    expect(html).toContain("Back to ConvergePanel");
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>[\s\S]*Back to ConvergePanel/);
  });

  it("the two links resolve to two DIFFERENT destinations — the exact regression this test guards against (both pointing at /reviews)", () => {
    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/reviews", "/"]);
    expect(new Set(hrefs).size).toBe(2);
  });

  it("renders exactly two links", () => {
    const anchorCount = (html.match(/<a\b/g) || []).length;
    expect(anchorCount).toBe(2);
  });
});

describe("ReviewerNavigation — accessibility (Step 10)", () => {
  it("the navigation region has an accessible name via aria-label, distinguishing it from other <nav> regions on the page", () => {
    const html = render(true);
    expect(html).toMatch(/<nav[^>]*aria-label="Reviewer navigation"/);
  });

  it("both link labels are real text content, not conveyed only by the decorative arrow icon (aria-hidden on the icon itself)", () => {
    const html = render(true);
    expect(html).toContain("Back to my reviews");
    expect(html).toContain("Back to ConvergePanel");
    // The arrow icon(s) present must be marked decorative.
    expect(html).toMatch(/aria-hidden="true"/);
  });

  it("uses real <a> elements (Next Link), not a non-focusable clickable <div>/<span>", () => {
    const html = render(false);
    expect(html).not.toMatch(/<div[^>]*onclick/i);
    expect(html).toMatch(/<a\b/);
  });
});
