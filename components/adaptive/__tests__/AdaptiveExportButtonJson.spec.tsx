/**
 * Adaptive Research Export, Phase 4 — AdaptiveExportButton structural
 * render tests with the JSON flag ON (DOCX flag off, isolating JSON's own
 * behavior). Local-only this pass: production keeps
 * NEXT_PUBLIC_ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED unset/false until a
 * separate release task.
 *
 * Same renderToStaticMarkup convention, and the same reason this lives in
 * its own file rather than jest.resetModules()-ing between flag states —
 * see AdaptiveExportButton.spec.tsx's header comment.
 */

process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED = "false";
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED = "true";

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

describe("AdaptiveExportButton — JSON flag ON, DOCX flag OFF (local-only)", () => {
  it("renders a native <select>/<option> pair with PDF and JSON options (no Word option, since DOCX flag is off), plus the generic 'Export' button", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toMatch(/<select[^>]*aria-label="Export format"[^>]*>[\s\S]*<option[^>]*value="pdf"[^>]*>PDF<[\s\S]*<option[^>]*value="json"[^>]*>JSON<[\s\S]*<\/select>/);
    expect(html).not.toContain("Word (.docx)");
    expect(html).toMatch(/>Export<\/button>/);
    expect(html).not.toContain(">Export PDF<");
  });

  it("defaults to format=pdf: select value and button aria-label both resolve to the PDF wording on first render", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    expect(html).toContain('aria-label="Export this report as a PDF"');
  });

  it("shares one `state` between the select and the button — no realistic path to a duplicate submission from the format menu", () => {
    const source = readFileSync(join(__dirname, "../AdaptiveExportButton.tsx"), "utf8");
    const disabledOnLoading = source.match(/disabled=\{state === "loading"\}/g) || [];
    expect(disabledOnLoading.length).toBe(2);
  });
});
