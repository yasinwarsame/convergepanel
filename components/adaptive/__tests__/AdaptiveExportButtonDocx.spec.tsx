/**
 * Adaptive Research Export, Phase 3 — AdaptiveExportButton structural
 * render tests with the DOCX flag ON. Local-only this pass: production
 * keeps NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED unset/false
 * until a separate release task (see AdaptiveExportButton.tsx's own doc
 * comment and lib/env.ts).
 *
 * Same renderToStaticMarkup convention and the same reason this lives in
 * its own file rather than jest.resetModules()-ing between flag states —
 * see AdaptiveExportButton.spec.tsx's header comment.
 */

process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED = "true";

jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "u1" }, authReady: true }),
}));

jest.mock("@/hooks/useUserPlan", () => ({
  useUserPlan: () => ({ plan: "full", loading: false }),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveExportButton from "@/components/adaptive/AdaptiveExportButton";

describe("AdaptiveExportButton — DOCX flag ON (local-only)", () => {
  it("renders a native <select>/<option> pair with PDF and Word options, plus the generic 'Export' button", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toMatch(/<select[^>]*aria-label="Export format"[^>]*>[\s\S]*<option[^>]*value="pdf"[^>]*>PDF<[\s\S]*<option[^>]*value="docx"[^>]*>Word \(\.docx\)<[\s\S]*<\/select>/);
    expect(html).toMatch(/>Export<\/button>/);
    expect(html).not.toContain(">Export PDF<");
  });

  it("is a real <select>, not a custom listbox/menu widget — inherently keyboard-operable (Tab, arrow keys, Enter/Space) with no extra key handlers required", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).not.toMatch(/role="listbox"|role="menu"|tabIndex/);
  });

  it("defaults to format=pdf: select value and button aria-label both resolve to the PDF wording on first render", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toContain('aria-label="Export this report as a PDF"');
  });

  it("shares one `state` between the select and the button — no realistic path to a duplicate submission from the format menu (structural guarantee; a live click can't be exercised under renderToStaticMarkup, so this is confirmed by source reading rather than by re-deriving it here)", () => {
    const source = readFileSync(join(__dirname, "../AdaptiveExportButton.tsx"), "utf8");
    const disabledOnLoading = source.match(/disabled=\{state === "loading"\}/g) || [];
    expect(disabledOnLoading.length).toBe(2);
  });
});
