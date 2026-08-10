/**
 * Adaptive Research Export — AdaptiveExportButton structural render tests,
 * DOCX flag OFF (the production default today).
 *
 * Phase 1 shipped this component with no dedicated spec file of its own —
 * a comment in AdaptiveExportHistorySection.spec.tsx claimed matching
 * coverage already existed; it did not. This file (and its DOCX-flag-ON
 * sibling, AdaptiveExportButtonDocx.spec.tsx) close that gap, found
 * during the Phase 3 independent review.
 *
 * renderToStaticMarkup (no jsdom), matching every other adaptive
 * component test in this repo: proves the initial synchronous render and
 * source-level ternary resolution only — same accepted limitation
 * documented in adaptivePanelVoteForm.spec.tsx. `state === "loading"`
 * (disabled attributes, spinner, format-specific loading label) can't be
 * reached this way; it's verified by direct source reading instead.
 *
 * The flag is a module-scope constant read once at import time, matching
 * how AdaptiveExportButton.tsx itself reads it and how
 * AdaptiveExportHistorySection.spec.tsx already established this pattern
 * — set via process.env BEFORE the static import below, and deliberately
 * NOT using jest.resetModules() to test both flag states in one file
 * (confirmed the hard way while writing this: resetModules() re-requires
 * react itself fresh, which conflicts with the statically-imported
 * react-dom/server's own cached React instance and breaks hooks).
 */

process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED = "false";

jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "u1" }, authReady: true }),
}));

const mockedUseUserPlan = jest.fn();
jest.mock("@/hooks/useUserPlan", () => ({
  useUserPlan: () => mockedUseUserPlan(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveExportButton from "@/components/adaptive/AdaptiveExportButton";

beforeEach(() => {
  mockedUseUserPlan.mockReturnValue({ plan: "full", loading: false });
});

describe("AdaptiveExportButton — DOCX flag OFF (production default)", () => {
  it("renders the single Phase 1 'Export PDF' button, no format selector", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toContain("Export PDF");
    expect(html).not.toContain("<select");
    expect(html).toContain('aria-label="Export this report as a PDF"');
  });

  it("renders nothing without a runId", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: null }));
    expect(html).toBe("");
  });

  it("renders nothing on a plan without advancedExportEnabled (free)", () => {
    mockedUseUserPlan.mockReturnValue({ plan: "free", loading: false });
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toBe("");
  });

  it("renders nothing while the plan is still loading", () => {
    mockedUseUserPlan.mockReturnValue({ plan: null, loading: true });
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toBe("");
  });
});
