/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — structural test for
 * AdaptiveReviewDetail's initial synchronous render only. Same documented
 * limitation as `teamReviewQueueGateStates.spec.tsx`: `renderToStaticMarkup`
 * cannot observe post-fetch states (loaded content, not-found, access
 * denied) since those depend on an async effect this method never flushes.
 * Those states are fully covered at the API-contract level by
 * `app/api/teams/adaptive-runs/[runId]/__tests__/adaptiveReviewDetailRoute.spec.ts`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptiveReviewDetail from "@/components/teamGovernance/AdaptiveReviewDetail";

describe("AdaptiveReviewDetail — initial render", () => {
  it("shows a loading state on first render, before the detail fetch resolves", () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, loading: false, authReady: true });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewDetail, { runId: "run-1" }));
    expect(html).toContain("Loading");
  });

  it("never renders a decision control on initial render", () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, loading: false, authReady: true });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewDetail, { runId: "run-1" }));
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
    expect(html).not.toMatch(/<textarea/);
  });

  it("renders a Back to review queue link", () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, loading: false, authReady: true });
    const html = renderToStaticMarkup(createElement(AdaptiveReviewDetail, { runId: "run-1" }));
    expect(html).toContain("/team/reviews");
  });
});

/**
 * Multi-Reviewer Owner Override, Part F (§F11) — source-level guarantees
 * for the panel/single-reviewer coexistence wiring. Post-fetch behavior
 * (the panel-status-dependent show/hide itself) depends on an async effect
 * `renderToStaticMarkup` never flushes, so it is proven at the source
 * level here, plus fully exercised by
 * `AdaptiveMultiReviewerPanelSection`'s own tests and every mutating
 * route's own contract tests.
 */
describe("AdaptiveReviewDetail — single-reviewer/panel coexistence (source-level)", () => {
  const fullSource = readFileSync(join(__dirname, "../AdaptiveReviewDetail.tsx"), "utf8");
  const source = fullSource.slice(fullSource.indexOf("*/") + 2);

  it("always renders AdaptiveMultiReviewerPanelSection alongside the existing single-reviewer UI", () => {
    expect(source).toContain("<AdaptiveMultiReviewerPanelSection");
  });

  it("hides single-reviewer assignment/decision UI exactly when the panel is open or finalized, never otherwise", () => {
    expect(source).toContain('panelStatus === "open" || panelStatus === "finalized"');
    expect(source).toContain("singleReviewerUiHidden");
  });

  it("wires the panel section's status callback back into the single-reviewer visibility gate", () => {
    expect(source).toContain("onPanelStatusChange={setPanelStatus}");
  });

  it("passes the same canonical expectedGovernanceUpdatedAt to the panel section that the single-reviewer decision form uses", () => {
    expect(source).toContain("expectedGovernanceUpdatedAt={data.review.updatedAt}");
    expect(source).toContain("expectedUpdatedAt={data.review.updatedAt}");
  });
});
