/**
 * Phase 5D — regression coverage for the `HistoryGovernanceChip` →
 * `GovernanceChip` extraction (mechanical relocation from `app/page.tsx`).
 * Renders via `react-dom/server`'s `renderToStaticMarkup` (no jsdom),
 * matching this repo's established convention.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GovernanceChip } from "@/components/shared/GovernanceChip";

function render(status?: "approved" | "needs_review" | "blocked"): string {
  return renderToStaticMarkup(createElement(GovernanceChip, { status }));
}

describe("GovernanceChip", () => {
  it("renders nothing for an absent/undefined status — no 'Unknown' badge merely because the component is now shared", () => {
    expect(render(undefined)).toBe("");
  });

  it("approved → 'Approved' label, emerald dot", () => {
    const html = render("approved");
    expect(html).toContain("Approved");
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain("Governance: Approved");
  });

  it("blocked → 'Blocked' label, red dot", () => {
    const html = render("blocked");
    expect(html).toContain("Blocked");
    expect(html).toContain("bg-red-500");
  });

  it("needs_review → 'Review' label, amber dot", () => {
    const html = render("needs_review");
    expect(html).toContain("Review");
    expect(html).toContain("bg-amber-500");
  });

  it("three statuses produce three genuinely distinct renderings", () => {
    const outputs = new Set([render("approved"), render("blocked"), render("needs_review")]);
    expect(outputs.size).toBe(3);
  });
});
