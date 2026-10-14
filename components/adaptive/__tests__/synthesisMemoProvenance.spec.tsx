/**
 * Model-identity PR A — the adaptive Synthesis Report's "Export memo" action
 * reads the run's provenance from RunModelProvenanceContext (provided by
 * ResultsDisplay). Proves the WIRING inside the real view: with the context,
 * the memo lists frozen requested models; without it, families only.
 */
const captured: { onExportMemo?: () => void } = {};
jest.mock("@/components/VerificationActions", () => ({
  VerificationActions: (props: { onExportMemo: () => void }) => {
    captured.onExportMemo = props.onExportMemo;
    return null;
  },
}));
const memoInputs: unknown[] = [];
jest.mock("@/lib/verification/generateMemo", () => ({
  generateVerificationMemo: (input: unknown) => {
    memoInputs.push(input);
    return "memo";
  },
  downloadTextFile: jest.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveSynthesisReportView from "@/components/adaptive/AdaptiveSynthesisReportView";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";

const report = {
  unifiedAnswer: "U",
  panelVerdict: "x",
  gate: "caution",
  runCertainty: 0.5,
  whereModelsAgree: [],
  whereModelsDisagree: [],
  certaintyAssessment: "x",
  narrativeSections: [],
  executiveSummary: "x",
  disagreements: [],
  biasAndBlindSpots: [],
  biasEmptyReason: "insufficient_models",
  panelCoverageGaps: [],
  diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.5 },
  verdictCard: { question: "q", topConsensus: null, consensusModelCount: 0, keyDisagreement: null, disagreementDetail: null, disagreementModelCount: 0, caveat: null, recommendedNextSteps: [] },
  degraded: false,
};
const gate = { status: "caution", runCertainty: 0.5, loadBearingSplitCount: 0, loadBearingClaims: [] };

function exportMemo(provenance: unknown): { modelsUsed: string[] } {
  captured.onExportMemo = undefined;
  memoInputs.length = 0;
  const view = createElement(AdaptiveSynthesisReportView, { report: report as never, gate: gate as never, question: "Q?", modelsUsed: ["chatgpt", "gemini"], runId: "run-1" });
  renderToStaticMarkup(provenance === undefined ? view : createElement(RunModelProvenanceContext.Provider, { value: provenance as never }, view));
  expect(captured.onExportMemo).toBeDefined();
  captured.onExportMemo!();
  expect(memoInputs).toHaveLength(1);
  return memoInputs[0] as { modelsUsed: string[] };
}

describe("adaptive Synthesis Report memo export", () => {
  it("with the run's provenance: frozen requested models, 'model not recorded' for a held row without one", () => {
    const input = exportMemo([{ modelId: "chatgpt", requestedModel: "gpt-4o-mini", substituted: false }, { modelId: "gemini", substituted: false }]);
    expect(input.modelsUsed).toEqual(["ChatGPT · requested: gpt-4o-mini", "Gemini · model not recorded"]);
  });

  it("without provenance: families only — no product label, no false 'not recorded'", () => {
    const input = exportMemo(undefined);
    expect(input.modelsUsed).toEqual(["ChatGPT", "Gemini"]);
  });
});
