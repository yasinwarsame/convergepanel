/**
 * TEAM-RESEARCH-PARITY-R3-P0 §D/§F/§G/§Q/§R — the adaptive ancillary
 * presentation contract at the component boundary.
 *
 * `AdaptivePanelResponse` is REAL; every schema view, `TopSummaryBar` and
 * `ReviewGovernanceSection` are recording stubs, so each of the eleven
 * review & governance branches can be driven with trivial data and the ONLY
 * thing under test is the ancillary decision. `TopSummaryBar` is exercised
 * for real (with recording export stubs) in the second half.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const governanceProps: Record<string, unknown>[] = [];
const summaryBarProps: Record<string, unknown>[] = [];
const exportButtonProps: Record<string, unknown>[] = [];
const exportHistoryProps: Record<string, unknown>[] = [];

/** Schema views stubbed via hoisted jest.mock so every branch can be driven with trivial data. */
jest.mock("@/components/adaptive/AdaptiveResultsView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "AdaptiveResultsView" }) }));
jest.mock("@/components/adaptive/RankedListView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "RankedListView" }) }));
jest.mock("@/components/adaptive/ComparisonMatrixView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "ComparisonMatrixView" }) }));
jest.mock("@/components/adaptive/DefinitionExplanationView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "DefinitionExplanationView" }) }));
jest.mock("@/components/adaptive/CausalExplanationView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "CausalExplanationView" }) }));
jest.mock("@/components/adaptive/ChecklistTaxonomyView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "ChecklistTaxonomyView" }) }));
jest.mock("@/components/adaptive/RiskAnalysisView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "RiskAnalysisView" }) }));
jest.mock("@/components/adaptive/DeepResearchView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "DeepResearchView" }) }));
jest.mock("@/components/adaptive/EvidenceReviewView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "EvidenceReviewView" }) }));
jest.mock("@/components/adaptive/BiasBlindspotAuditView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "BiasBlindspotAuditView" }) }));
jest.mock("@/components/adaptive/DecisionSupportView", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "DecisionSupportView" }) }));
jest.mock("@/components/adaptive/ModelResponsesSection", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "ModelResponsesSection" }) }));
jest.mock("@/components/adaptive/PanelEvidenceSection", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "PanelEvidenceSection" }) }));
jest.mock("@/components/adaptive/PrimarySynthesisStrip", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "PrimarySynthesisStrip" }) }));
jest.mock("@/components/adaptive/SchemaKeyFactsStrip", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "SchemaKeyFactsStrip" }) }));
jest.mock("@/components/adaptive/DirectAnswerCard", () => ({ __esModule: true, default: () => require("react").createElement("section", { "data-stub": "DirectAnswerCard" }) }));
jest.mock("@/components/adaptive/ReviewGovernanceSection", () => ({
  __esModule: true,
  default: (p: Record<string, unknown>) => {
    governanceProps.push(p);
    return require("react").createElement("section", { "data-stub": "ReviewGovernanceSection" });
  },
}));
jest.mock("@/components/adaptive/AdaptiveExportButton", () => ({
  __esModule: true,
  default: (p: Record<string, unknown>) => {
    exportButtonProps.push(p);
    return require("react").createElement("span", { "data-stub": "AdaptiveExportButton" });
  },
}));
jest.mock("@/components/adaptive/AdaptiveExportHistorySection", () => ({
  __esModule: true,
  default: (p: Record<string, unknown>) => {
    exportHistoryProps.push(p);
    return require("react").createElement("section", { "data-stub": "AdaptiveExportHistorySection" });
  },
}));

import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import TopSummaryBar from "@/components/adaptive/TopSummaryBar";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import {
  PERSONAL_DEFAULT_ANCILLARY_PRESENTATION,
  resolveAdaptiveAncillaryPresentation,
  type AdaptiveAncillaryPresentation,
} from "@/components/adaptive/adaptiveAncillaryPresentation";

/** The representative caller-owned link lives HERE, in the fixture — never in the shared renderer. */
const WORKSPACE_REVIEW_HREF = "/workspace/reviews/run-123";
const governanceSurface = (): ReactNode => createElement("a", { href: WORKSPACE_REVIEW_HREF, "data-testid": "caller-governance" }, "Open review");
const exportSurface = (): ReactNode => createElement("span", { "data-testid": "caller-export" }, "Caller export");

/**
 * The smallest per-schema result the REAL TopSummaryBar can summarize (its
 * consensus derivation reads these fields). The schema VIEWS are stubbed, so
 * nothing else is needed.
 */
const SUMMARY_SAFE_RESULT: Record<string, unknown> = {
  comparisonMatrix: { cells: [] },
  checklistTaxonomy: { categories: [], lowConfidenceItems: [] },
  decisionSupport: { recommendation: { totalModelsWithRecommendation: 0 } },
  causalExplanation: { factors: [], disputedInterpretations: [] },
  deepResearch: { findings: [], disagreements: [] },
  biasBlindspotAudit: { biasEmptyReason: "insufficient_models", attributedBiases: [] },
};

const GATE = { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] };
const REPORT = { unifiedAnswer: "U" };
const TRUST = { perModel: [], overallTrust: 0.9 };

/** Every schema branch that mounts review & governance, with the data that selects it. `pilot` = the Phase 2 progressive-disclosure branch. */
const GOVERNANCE_BRANCHES: Array<{ id: string; field?: string; pilot?: boolean }> = [
  { id: "ranked_enumeration", field: "rankedEnumeration" },
  { id: "comparison_matrix", field: "comparisonMatrix" },
  { id: "definition_explanation", field: "definitionExplanation" },
  { id: "causal_explanation", field: "causalExplanation" },
  { id: "checklist_taxonomy", field: "checklistTaxonomy" },
  { id: "deep_research", field: "deepResearch" },
  { id: "evidence_review", field: "evidenceReview" },
  { id: "bias_blindspot_audit", field: "biasBlindspotAudit" },
  { id: "decision_support", field: "decisionSupport" },
  { id: "procedural", pilot: true },
  { id: "creative_generative", pilot: true },
];

function panelProps(branch: { id: string; field?: string; pilot?: boolean }, ancillaryPresentation?: AdaptiveAncillaryPresentation) {
  const schema = (SCHEMA_REGISTRY as Record<string, { renderHint: string }>)[branch.id];
  const props: Record<string, unknown> = {
    schema,
    classification: { queryType: branch.id, domain: "t", answerShape: schema.renderHint, confidence: 0.9, riskLevel: "professional" },
    results: [{ modelId: "chatgpt", schemaId: branch.id, ok: true, data: {} }],
    alignedClaims: [],
    question: "Q?",
    runId: "run-123",
    humanReview: { status: "unreviewed" },
    reviewRouting: "in_queue",
    persistenceStatus: "saved",
    onRunFollowUp: jest.fn(),
  };
  if (branch.field) props[branch.field] = SUMMARY_SAFE_RESULT[branch.field] ?? {};
  if (branch.id === "procedural") Object.assign(props, { gate: GATE, synthesisReport: REPORT, trustSummary: TRUST });
  if (ancillaryPresentation !== undefined) props.ancillaryPresentation = ancillaryPresentation;
  return props;
}

const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AdaptivePanelResponse as never, props as never));

beforeEach(() => {
  governanceProps.length = 0;
  summaryBarProps.length = 0;
  exportButtonProps.length = 0;
  exportHistoryProps.length = 0;
});

describe("resolveAdaptiveAncillaryPresentation", () => {
  it("absent or null WHOLE policy → Personal default; a present policy is returned unchanged", () => {
    expect(resolveAdaptiveAncillaryPresentation(undefined)).toEqual({ kind: "personal_default" });
    expect(resolveAdaptiveAncillaryPresentation(null)).toBe(PERSONAL_DEFAULT_ANCILLARY_PRESENTATION);
    const delegated: AdaptiveAncillaryPresentation = { kind: "delegated_read_only" };
    expect(resolveAdaptiveAncillaryPresentation(delegated)).toBe(delegated);
  });
});

describe("AdaptivePanelResponse — review & governance, every schema branch (§G/§R)", () => {
  describe.each(GOVERNANCE_BRANCHES)("$id", (branch) => {
    const expectedPersonalProps = () =>
      branch.pilot
        ? { humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", persistenceStatus: "saved", runId: "run-123", gate: branch.id === "procedural" ? GATE : undefined, synthesisReport: branch.id === "procedural" ? REPORT : undefined, trustSummary: branch.id === "procedural" ? TRUST : undefined, alignedClaims: [], modelsUsed: ["chatgpt"], question: "Q?", onRunFollowUp: expect.any(Function) }
        : { humanReview: { status: "unreviewed" }, reviewRouting: "in_queue", persistenceStatus: "saved", runId: "run-123" };

    it("policy ABSENT → the Personal ReviewGovernanceSection mounts exactly once with exactly its established props", () => {
      render(panelProps(branch));
      expect(governanceProps).toHaveLength(1);
      expect(governanceProps[0]).toEqual(expectedPersonalProps());
    });

    it("explicit personal_default → identical to absent", () => {
      render(panelProps(branch, { kind: "personal_default" }));
      expect(governanceProps).toHaveLength(1);
      expect(governanceProps[0]).toEqual(expectedPersonalProps());
    });

    it("delegated_read_only with NO governance surface → no ReviewGovernanceSection and nothing in its place (not even a renderer-chosen link)", () => {
      const html = render(panelProps(branch, { kind: "delegated_read_only" }));
      expect(governanceProps).toHaveLength(0);
      expect(html).not.toContain("ReviewGovernanceSection");
      // The shared renderer never invents a destination: with views, summary exports and governance all accounted for, no anchor exists.
      expect(html).not.toMatch(/<a\b/);
      expect(html).not.toContain("/workspace/");
    });

    it("delegated_read_only with an explicitly undefined or null governance surface → still nothing (never falls back to Personal)", () => {
      render(panelProps(branch, { kind: "delegated_read_only", reviewGovernanceSurface: undefined }));
      render(panelProps(branch, { kind: "delegated_read_only", reviewGovernanceSurface: null }));
      expect(governanceProps).toHaveLength(0);
    });

    it("delegated_read_only with a caller surface → exactly that surface, exactly once, with the caller's own link; no Personal section", () => {
      const html = render(panelProps(branch, { kind: "delegated_read_only", reviewGovernanceSurface: governanceSurface() }));
      expect(governanceProps).toHaveLength(0);
      expect(html.split('data-testid="caller-governance"').length - 1).toBe(1);
      expect(html).toContain(`href="${WORKSPACE_REVIEW_HREF}"`);
    });
  });

  it("factual_lookup has no review & governance position in any mode (unchanged), and a delegated surface is not invented one", () => {
    const branch = { id: "factual_lookup" };
    render(panelProps(branch));
    const html = render(panelProps(branch, { kind: "delegated_read_only", reviewGovernanceSurface: governanceSurface() }));
    expect(governanceProps).toHaveLength(0);
    expect(html).not.toContain("caller-governance");
  });
});

describe("AdaptivePanelResponse → TopSummaryBar — the export position follows the same caller policy (§E/§F)", () => {
  it("absent → Personal export button and export history both mount; delegated → neither; delegated + surface → only the surface", () => {
    const branch = GOVERNANCE_BRANCHES[0];
    render(panelProps(branch));
    expect(exportButtonProps).toHaveLength(1);
    expect(exportHistoryProps).toHaveLength(1);

    exportButtonProps.length = 0;
    exportHistoryProps.length = 0;
    render(panelProps(branch, { kind: "delegated_read_only" }));
    expect(exportButtonProps).toHaveLength(0);
    expect(exportHistoryProps).toHaveLength(0);

    const html = render(panelProps(branch, { kind: "delegated_read_only", exportSurface: exportSurface() }));
    expect(exportButtonProps).toHaveLength(0);
    expect(exportHistoryProps).toHaveLength(0);
    expect(html.split('data-testid="caller-export"').length - 1).toBe(1);
  });
});

describe("TopSummaryBar — export action AND export history are one caller decision (§F/§Q)", () => {
  const bar = (ancillaryPresentation?: AdaptiveAncillaryPresentation) =>
    renderToStaticMarkup(
      createElement(TopSummaryBar as never, { schemaId: "comparison_matrix", results: [], runId: "run-9", ...(ancillaryPresentation !== undefined ? { ancillaryPresentation } : {}) } as never)
    );

  it("policy absent → the Personal AdaptiveExportButton (in the header row) and AdaptiveExportHistorySection (after the card) both mount with the runId", () => {
    const html = bar();
    expect(exportButtonProps).toEqual([{ runId: "run-9" }]);
    expect(exportHistoryProps).toEqual([{ runId: "run-9" }]);
    expect(html.indexOf("AdaptiveExportButton")).toBeLessThan(html.indexOf("AdaptiveExportHistorySection"));
  });

  it("explicit personal_default → identical markup to absent", () => {
    const absent = bar();
    const explicit = bar({ kind: "personal_default" });
    expect(explicit).toBe(absent);
  });

  it.each([
    ["no exportSurface key", { kind: "delegated_read_only" } as AdaptiveAncillaryPresentation],
    ["exportSurface undefined", { kind: "delegated_read_only", exportSurface: undefined } as AdaptiveAncillaryPresentation],
    ["exportSurface null", { kind: "delegated_read_only", exportSurface: null } as AdaptiveAncillaryPresentation],
  ])("delegated_read_only with %s → NEITHER the export button NOR the export history mounts", (_label, policy) => {
    const html = bar(policy);
    expect(exportButtonProps).toHaveLength(0);
    expect(exportHistoryProps).toHaveLength(0);
    expect(html).not.toContain("AdaptiveExportButton");
    expect(html).not.toContain("AdaptiveExportHistorySection");
    // The summary itself still renders.
    expect(html).toContain("Report type");
  });

  it("delegated_read_only with an exportSurface → exactly that surface once, in the export position; no Personal component", () => {
    const html = bar({ kind: "delegated_read_only", exportSurface: exportSurface() });
    expect(exportButtonProps).toHaveLength(0);
    expect(exportHistoryProps).toHaveLength(0);
    expect(html.split('data-testid="caller-export"').length - 1).toBe(1);
    expect(html.indexOf("caller-export")).toBeLessThan(html.indexOf("Models"));
  });

  it("the governance surface is never rendered by TopSummaryBar (each surface has one position)", () => {
    const html = bar({ kind: "delegated_read_only", reviewGovernanceSurface: governanceSurface() });
    expect(html).not.toContain("caller-governance");
  });
});
