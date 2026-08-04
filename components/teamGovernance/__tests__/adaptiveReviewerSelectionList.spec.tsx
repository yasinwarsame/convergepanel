/**
 * Multi-Reviewer Owner Override, Part F (§F12) — structural tests for
 * AdaptiveReviewerSelectionList.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AdaptiveReviewerSelectionList from "@/components/teamGovernance/AdaptiveReviewerSelectionList";

const REVIEWERS = [
  { userId: "u1", displayName: "Alice" },
  { userId: "u2", displayName: "Bob" },
  { userId: "u3", displayName: "Carol" },
];

describe("AdaptiveReviewerSelectionList — initial render", () => {
  it("renders each eligible reviewer's display name as a checkbox option", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewerSelectionList, { eligibleReviewers: REVIEWERS, selected: [], onChange: () => {} }));
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain("Carol");
    expect(html).toMatch(/type="checkbox"/);
  });

  it("shows the current selection count against the max bound", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewerSelectionList, { eligibleReviewers: REVIEWERS, selected: ["u1", "u2"], onChange: () => {} }));
    expect(html).toContain("2/9");
  });

  it("checks exactly the selected reviewers, never a duplicate entry", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewerSelectionList, { eligibleReviewers: REVIEWERS, selected: ["u2"], onChange: () => {} }));
    const checkedCount = (html.match(/checked=""/g) ?? []).length;
    expect(checkedCount).toBe(1);
  });

  it("shows a max-reached notice once selection hits MAX_ADAPTIVE_PANEL_REVIEWERS", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ userId: `u${i}`, displayName: `Reviewer ${i}` }));
    const html = renderToStaticMarkup(
      createElement(AdaptiveReviewerSelectionList, { eligibleReviewers: many, selected: many.map((r) => r.userId), onChange: () => {} })
    );
    expect(html).toContain("Maximum of 9 reviewers reached.");
  });

  it("shows a no-eligible-members message when the list is empty", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewerSelectionList, { eligibleReviewers: [], selected: [], onChange: () => {} }));
    expect(html).toContain("No eligible team members are available.");
  });

  it("never renders an email address, only displayName", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveReviewerSelectionList, {
        eligibleReviewers: [{ userId: "u1", displayName: "Alice" }],
        selected: [],
        onChange: () => {},
      })
    );
    expect(html).not.toMatch(/@/);
  });
});

describe("AdaptiveReviewerSelectionList — accessibility", () => {
  it("uses a fieldset/legend and an accessible listbox role", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewerSelectionList, { eligibleReviewers: REVIEWERS, selected: [], onChange: () => {} }));
    expect(html).toMatch(/<fieldset/);
    expect(html).toMatch(/<legend/);
    expect(html).toMatch(/role="listbox"/);
    expect(html).toMatch(/aria-multiselectable="true"/);
  });
});
