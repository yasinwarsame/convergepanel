/**
 * Immutable Adaptive Review History and Admin Audit Integration —
 * structural tests for AdaptiveReviewHistorySection's initial render.
 * Same documented limitation as elsewhere: proves the first synchronous
 * render only (always the loading state, since the fetch is async and
 * effects don't run under `renderToStaticMarkup`) plus source-level
 * guarantees. No client-side repair button exists — verified structurally.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptiveReviewHistorySection from "@/components/teamGovernance/AdaptiveReviewHistorySection";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

describe("AdaptiveReviewHistorySection — initial render", () => {
  it("renders a Review History heading", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewHistorySection, { runId: "run-1", canonicalTerminal: true }));
    expect(html).toContain("Review History");
  });

  it("shows a loading state before the fetch resolves", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewHistorySection, { runId: "run-1", canonicalTerminal: true }));
    expect(html).toContain("Loading history");
  });

  it("never renders reviewer identity, comment/condition text, a decision ID, or a team ID", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewHistorySection, { runId: "run-1", canonicalTerminal: false }));
    expect(html).not.toMatch(/reviewerId|reviewerName|teamId|decisionId/i);
  });
});

describe("AdaptiveReviewHistorySection — source-level guarantees", () => {
  const source = readFileSync(join(__dirname, "../AdaptiveReviewHistorySection.tsx"), "utf8");

  it("never issues a POST request (read-only)", () => {
    expect(source).not.toMatch(/method:\s*["']POST["']/);
  });

  it("provides no button element at all — there is no repair action or any other clickable control", () => {
    expect(source).not.toMatch(/<button/);
    expect(source).not.toMatch(/onClick/);
  });

  it("never fetches or references the decision-mutation route", () => {
    expect(source).not.toContain("/decision");
  });
});
