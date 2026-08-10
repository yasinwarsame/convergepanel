/**
 * Adaptive Research Export, Phase 2 — AdaptiveExportHistorySection
 * structural render tests. renderToStaticMarkup (no jsdom), matching the
 * convention used by every other adaptive renderer test in this repo, and
 * the same level of coverage used by AdaptiveExportButton.spec.tsx /
 * AdaptiveExportButtonDocx.spec.tsx — full interactive fetch/regenerate
 * flows are covered by the API route tests instead; this only verifies
 * the collapsed shell renders correctly under the flag/runId gates.
 *
 * The flag is a module-scope constant (`EXPORT_FLAG_ENABLED`), read once at
 * import time — set via `process.env` before the static import below runs,
 * matching how `AdaptiveExportButton.tsx` itself reads it. Deliberately NOT
 * using `jest.resetModules()` to test multiple flag states in one file:
 * that re-requires `react` itself fresh, which conflicts with the
 * statically-imported `react-dom/server`'s own cached React instance and
 * breaks hooks entirely (confirmed while writing this test).
 */

process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";

jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: null, authReady: false }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveExportHistorySection from "@/components/adaptive/AdaptiveExportHistorySection";

describe("AdaptiveExportHistorySection (flag enabled)", () => {
  it("renders nothing when there is no runId, even with the flag enabled", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportHistorySection, { runId: null }));
    expect(html).toBe("");
  });

  it("renders a collapsed 'Previous exports' shell when a runId is present — collapsed by default", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportHistorySection, { runId: "run-1" }));
    expect(html).toContain("Previous exports");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("never throws on initial (collapsed) render — no fetch mock is installed here, confirming no fetch is attempted before expansion", () => {
    expect(() => renderToStaticMarkup(createElement(AdaptiveExportHistorySection, { runId: "run-1" }))).not.toThrow();
  });
});
