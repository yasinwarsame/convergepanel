/**
 * Adaptive Research Export, Phase 4 — AdaptiveExportButton with BOTH the
 * DOCX and JSON flags ON, verifying the full 3-way selector (PDF, Word,
 * JSON) renders and orders correctly together. Local-only combination —
 * production never has both flags on simultaneously as of this phase (DOCX
 * is live, JSON stays dark) — but the component must handle it correctly
 * regardless, since nothing in its logic assumes at most one extra format.
 */

process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED = "true";
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED = "true";

jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "u1" }, authReady: true }),
}));

jest.mock("@/hooks/useUserPlan", () => ({
  useUserPlan: () => ({ plan: "full", loading: false }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveExportButton from "@/components/adaptive/AdaptiveExportButton";

describe("AdaptiveExportButton — DOCX and JSON flags both ON", () => {
  it("renders all three options in a stable order: PDF, Word (.docx), JSON", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveExportButton, { runId: "run-1" }));
    const pdfIdx = html.indexOf('value="pdf"');
    const docxIdx = html.indexOf('value="docx"');
    const jsonIdx = html.indexOf('value="json"');
    expect(pdfIdx).toBeGreaterThan(-1);
    expect(docxIdx).toBeGreaterThan(pdfIdx);
    expect(jsonIdx).toBeGreaterThan(docxIdx);
    expect(html).toContain(">PDF<");
    expect(html).toContain(">Word (.docx)<");
    expect(html).toContain(">JSON<");
  });
});
