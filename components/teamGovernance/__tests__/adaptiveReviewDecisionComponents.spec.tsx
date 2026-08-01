/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — structural tests for
 * the decision-form sub-components via `react-dom/server`'s
 * `renderToStaticMarkup()` (same established, honest pattern as Part E1 —
 * no DOM/RTL exists in this repo). Proves rendering content/structure, not
 * click/keyboard interaction.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveReviewDecisionOption from "@/components/teamGovernance/AdaptiveReviewDecisionOption";
import AdaptiveReviewConditionsEditor from "@/components/teamGovernance/AdaptiveReviewConditionsEditor";
import AdaptiveReviewSubmissionResult from "@/components/teamGovernance/AdaptiveReviewSubmissionResult";
import type { AdaptiveReviewSubmissionResult as SubmissionResult } from "@/lib/client/adaptiveReviewSubmission";

const noop = () => {};

describe("AdaptiveReviewDecisionOption", () => {
  it("renders the label and description, checked state reflected", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveReviewDecisionOption, {
        name: "status",
        value: "approved",
        label: "Approve",
        description: "Accept this result as-is.",
        checked: true,
        onChange: noop,
      })
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Accept this result as-is.");
    expect(html).toMatch(/checked=""/);
  });

  it("is a real radio input, not an icon-only control", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveReviewDecisionOption, {
        name: "status",
        value: "rejected",
        label: "Reject",
        description: "x",
        checked: false,
        onChange: noop,
      })
    );
    expect(html).toContain('type="radio"');
  });
});

describe("AdaptiveReviewConditionsEditor", () => {
  it("renders one input per condition with an accessible label", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewConditionsEditor, { conditions: ["a", "b"], onChange: noop }));
    expect(html).toContain("Condition 1");
    expect(html).toContain("Condition 2");
    expect((html.match(/type="text"/g) ?? []).length).toBe(2);
  });

  it("renders the current/max count indicator", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewConditionsEditor, { conditions: ["a"], onChange: noop }));
    expect(html).toContain("1/20");
  });

  it("renders an accessible Remove button per condition", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewConditionsEditor, { conditions: ["a"], onChange: noop }));
    expect(html).toContain('aria-label="Remove condition 1"');
  });

  it("renders an Add condition control", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewConditionsEditor, { conditions: [], onChange: noop }));
    expect(html).toContain("Add condition");
  });

  it("disables the add button once at the maximum condition count", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const html = renderToStaticMarkup(createElement(AdaptiveReviewConditionsEditor, { conditions: twenty, onChange: noop }));
    // The `disabled=""` attribute renders inside the button's own opening
    // tag, BEFORE its "+ Add condition" text content.
    expect(html).toMatch(/disabled=""[^>]*>\+ Add condition/);
  });
});

describe("AdaptiveReviewSubmissionResult", () => {
  function render(result: SubmissionResult) {
    return renderToStaticMarkup(createElement(AdaptiveReviewSubmissionResult, { result, onReload: noop }));
  }

  it("success (synced) shows ordinary success, no warning", () => {
    const html = render({ kind: "success", status: "approved", reviewedAt: "x", projectionSyncStatus: "synced" });
    expect(html).toContain("Decision recorded.");
    expect(html).not.toContain("team queue may take time to update");
  });

  it("success (projection sync failed) still shows success, plus a restrained warning, never implying failure", () => {
    const html = render({ kind: "success", status: "approved", reviewedAt: "x", projectionSyncStatus: "failed" });
    expect(html).toContain("Decision recorded.");
    expect(html).toContain("The review was saved, but the team queue may take time to update.");
  });

  it("stale shows the exact required message and a Reload Review action, no auto-resubmit control", () => {
    const html = render({ kind: "stale" });
    expect(html).toContain("This review changed after you opened it. Reload the latest version before deciding.");
    expect(html).toContain("Reload Review");
    expect(html).not.toContain("Submit Decision");
  });

  it("terminal shows a completed message and a reload action, never a reopen action", () => {
    const html = render({ kind: "terminal" });
    expect(html).toContain("already reached a final decision");
    expect(html).toContain("Reload Review");
    expect(html).not.toMatch(/reopen/i);
  });

  it("never reveals reviewer identity, team ID, or projection ID in any state", () => {
    for (const result of [
      { kind: "success", status: "approved", reviewedAt: "x", projectionSyncStatus: "synced" } as SubmissionResult,
      { kind: "stale" } as SubmissionResult,
      { kind: "terminal" } as SubmissionResult,
      { kind: "server_error" } as SubmissionResult,
    ]) {
      const html = render(result);
      expect(html).not.toMatch(/reviewerId|reviewerName|teamId|projectionId/i);
    }
  });

  it("network_error offers a reload action and never claims definite failure", () => {
    const html = render({ kind: "network_error" });
    expect(html).toContain("Reload Review");
    expect(html.toLowerCase()).not.toContain("failed to save");
    expect(html.toLowerCase()).not.toContain("your decision was not saved");
  });
});
