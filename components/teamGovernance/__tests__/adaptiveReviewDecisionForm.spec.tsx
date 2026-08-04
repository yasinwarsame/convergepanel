/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — structural tests for
 * AdaptiveReviewDecisionForm's initial render via `renderToStaticMarkup()`.
 * Same documented limitation as elsewhere in this repo: proves rendering
 * content/structure on the FIRST synchronous render only — not
 * interaction, and not the async submission flow (fully covered instead by
 * `lib/client/__tests__/adaptiveReviewSubmission.spec.ts`, which tests the
 * real submission logic directly).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptiveReviewDecisionForm from "@/components/teamGovernance/AdaptiveReviewDecisionForm";

const noop = () => {};

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

function render() {
  return renderToStaticMarkup(
    createElement(AdaptiveReviewDecisionForm, {
      runId: "run-1",
      expectedUpdatedAt: "2026-07-30T00:00:00.000Z",
      onSuccess: noop,
      onRequestReload: noop,
    })
  );
}

describe("AdaptiveReviewDecisionForm — initial render", () => {
  it("renders a semantic form heading", () => {
    expect(render()).toContain("Submit a Decision");
  });

  it("groups decision options in a fieldset with a legend", () => {
    const html = render();
    expect(html).toMatch(/<fieldset[^>]*>[\s\S]*<legend/);
    expect(html).toContain("Decision");
  });

  it("renders all four decision choices with explicit labels", () => {
    const html = render();
    expect(html).toContain("Approve");
    expect(html).toContain("Approve with Conditions");
    expect(html).toContain("Request Changes");
    expect(html).toContain("Reject");
  });

  it("renders no comment field before a status is chosen", () => {
    const html = render();
    expect(html).not.toContain("adaptive-review-comment");
  });

  it("renders a Submit Decision button", () => {
    expect(render()).toContain("Submit Decision");
  });

  it("never renders a reviewer identity, team ID, or projection ID field", () => {
    const html = render();
    expect(html).not.toMatch(/reviewer|teamId|projectionId/i);
  });

  it("never renders automated-governance reasons or receipt content", () => {
    const html = render();
    expect(html).not.toMatch(/reasons|decisionReceipt|conclusion/i);
  });
});
