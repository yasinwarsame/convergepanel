/**
 * Regression test for the Synthesis Report layout dropping Unified Answer
 * and Trust Summary (reported after Part A's layout assembly). Renders the
 * real component (via react-dom/server — no jsdom needed for a structural
 * check) against a full inflation-question fixture and asserts every
 * required section is present, in the required order. A future edit that
 * silently drops a section (the exact failure mode being regression-tested)
 * will fail this test instead of only being caught by manual QA.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveSynthesisReportView, {
  ADAPTIVE_SYNTHESIS_SECTION_IDS,
} from "@/components/adaptive/AdaptiveSynthesisReportView";
import {
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  AlignedClaimCell,
} from "@/lib/adaptiveSchema/types";

const QUESTION = "What are the main causes of inflation in the US, and where do economists disagree?";
const MODELS = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as const;

function cell(modelId: string, stance: AlignedClaimCell["stance"]): AlignedClaimCell {
  return { modelId: modelId as any, stance, rawStance: "asserts", confidence: "majority_view", excerpt: `${modelId} take` };
}

const alignedClaims: AlignedClaim[] = [
  {
    id: "demand-pull",
    claimText: "Demand-pull pressure from post-pandemic stimulus drove the initial inflation spike",
    cells: [cell("chatgpt", "agrees"), cell("claude", "agrees"), cell("grok", "agrees"), null, cell("gemini", "agrees")],
    agreementScore: 0.9,
    certaintyScore: 0.85,
    status: "consensus",
  },
  {
    id: "supply-vs-monetary",
    claimText: "Whether supply-chain disruption or loose monetary policy was the dominant driver",
    cells: [cell("chatgpt", "disputes"), cell("claude", "agrees"), null, cell("perplexity", "disputes"), null],
    agreementScore: 0.3,
    certaintyScore: 0.4,
    status: "split",
    disagreementType: "causal_attribution",
  },
];

const gate: AdaptiveGateResult = {
  status: "caution",
  runCertainty: 0.62,
  loadBearingSplitCount: 1,
  loadBearingClaims: [alignedClaims[1]],
};

const trustSummary: AdaptiveTrustSummary = {
  perModel: MODELS.map((modelId, i) => ({
    modelId: modelId as any,
    claimsContributed: 4 + i,
    majorityAlignment: 0.8,
    citationScore: 0.7,
    contradictionCount: i === 0 ? 1 : 0,
    parseHealth: "ok",
    trustScore: 0.75,
  })),
  overallTrust: 0.75,
};

const report: AdaptiveSynthesisReport = {
  unifiedAnswer:
    "Economists broadly agree demand-pull pressure from stimulus and loose monetary policy kicked off the 2021-2023 inflation spike, but disagree sharply on how much of the persistence is attributable to supply-chain disruption versus monetary policy lag.",
  panelVerdict: "Panel converges on the initial driver but splits on the dominant persistence mechanism.",
  gate: "caution",
  runCertainty: 0.62,
  whereModelsAgree: ["Demand-pull pressure from post-pandemic stimulus drove the initial inflation spike"],
  whereModelsDisagree: ["Whether supply-chain disruption or loose monetary policy was the dominant driver"],
  certaintyAssessment: "Run certainty 62% (gate: caution). 1 claim(s) at consensus/majority, 1 split.",
  narrativeSections: [{ title: "Historical context", body: "Similar disputes arose during the 1970s stagflation debate." }],
  executiveSummary:
    "Inflation in the US from 2021-2023 had both demand-side and supply-side drivers. Economists converge on the initial trigger but diverge on relative weighting of causes during the persistence phase.",
  disagreements: [
    {
      topic: "Whether supply-chain disruption or loose monetary policy was the dominant driver",
      whyTheyDiffer: "Models weight the evidence base differently — some lean on Fed research, others on supply-chain indices.",
      positions: [
        { modelId: "chatgpt" as any, position: "chatgpt take" },
        { modelId: "claude" as any, position: "claude take" },
      ],
      stakes: "decision-critical",
    },
  ],
  biasAndBlindSpots: [
    {
      biasType: "US-centric framing",
      description: "All models focus on US Federal Reserve policy, giving limited weight to global commodity shocks.",
      modelsImplicated: ["chatgpt" as any, "grok" as any],
      evidence: [],
      likelyCauses: ["Training data skew toward US financial press"],
      impact: "May understate the role of global energy prices.",
      mitigationSteps: ["Ask a follow-up question about global commodity markets"],
    },
  ],
  verdictCard: {
    question: QUESTION,
    topConsensus: "Demand-pull pressure from post-pandemic stimulus drove the initial inflation spike",
    consensusModelCount: 4,
    keyDisagreement: "Whether supply-chain disruption or loose monetary policy was the dominant driver",
    disagreementDetail: "Split roughly along evidence-base lines.",
    disagreementModelCount: 2,
    caveat: "All models under-weight global commodity shocks.",
    recommendedNextSteps: [
      "Treat the key disagreement as unresolved — don't rely on either side without independent verification.",
    ],
  },
  degraded: false,
};

describe("AdaptiveSynthesisReportView — inflation fixture", () => {
  it("renders every required section, in the required order", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveSynthesisReportView, {
        report,
        gate,
        alignedClaims,
        trustSummary,
        question: QUESTION,
        modelsUsed: MODELS as unknown as any[],
        runId: "test-run-id",
      })
    );

    // Order: extract each data-section token in the order it appears in the
    // markup (document order == render order for renderToStaticMarkup).
    const foundOrder = Array.from(html.matchAll(/data-section="([^"]+)"/g)).map((m) => m[1]);

    expect(foundOrder).toEqual([...ADAPTIVE_SYNTHESIS_SECTION_IDS]);

    // Content spot-checks for the two previously-dropped sections.
    expect(html).toContain("Unified answer");
    expect(html).toContain(report.unifiedAnswer);
    expect(html).toContain("Trust summary");
    expect(html).toContain("Overall trust: 75%");
  });

  it("omits the trust-summary section when trustSummary is not provided", () => {
    const html = renderToStaticMarkup(
      createElement(AdaptiveSynthesisReportView, {
        report,
        gate,
        alignedClaims,
        question: QUESTION,
        modelsUsed: MODELS as unknown as any[],
        runId: "test-run-id",
      })
    );

    const foundOrder = Array.from(html.matchAll(/data-section="([^"]+)"/g)).map((m) => m[1]);
    expect(foundOrder).toEqual(ADAPTIVE_SYNTHESIS_SECTION_IDS.filter((id) => id !== "trust-summary"));
  });
});

/** Slices out one top-level `data-section` block's markup — good enough for substring/order assertions, doesn't need to be a real DOM. */
function sectionSlice(html: string, id: string): string {
  const startMarker = `data-section="${id}"`;
  const start = html.indexOf(startMarker);
  if (start === -1) return "";
  const nextMarkerIdx = html.indexOf('data-section="', start + startMarker.length);
  return html.slice(start, nextMarkerIdx === -1 ? html.length : nextMarkerIdx);
}

describe("AdaptiveSynthesisReportView — B2 low-coverage handling", () => {
  const b2Models = ["chatgpt", "claude", "grok"] as const;

  // Deliberately NOT pre-sorted (split first), to prove the component sorts
  // rather than just preserving input order.
  const b2Claims: AlignedClaim[] = [
    {
      id: "split-claim",
      claimText: "Split claim text",
      cells: [cell("chatgpt", "agrees"), cell("claude", "disputes"), null],
      agreementScore: 0.4,
      certaintyScore: 0.4,
      status: "split",
    },
    {
      id: "consensus-claim",
      claimText: "Consensus claim text",
      cells: [cell("chatgpt", "agrees"), cell("claude", "agrees"), cell("grok", "agrees")],
      agreementScore: 1,
      certaintyScore: 0.9,
      status: "consensus",
    },
    {
      id: "majority-claim",
      claimText: "Majority claim text",
      cells: [cell("chatgpt", "agrees"), cell("claude", "agrees"), cell("grok", "disputes")],
      agreementScore: 0.7,
      certaintyScore: 0.7,
      status: "majority",
    },
    {
      id: "single-claim",
      claimText: "Single model claim text",
      cells: [cell("chatgpt", "agrees"), null, null],
      agreementScore: 0,
      certaintyScore: 0.3,
      status: "single_source",
    },
  ];

  const b2Gate: AdaptiveGateResult = { status: "caution", runCertainty: 0.6, loadBearingSplitCount: 0, loadBearingClaims: [] };

  function renderB2() {
    return renderToStaticMarkup(
      createElement(AdaptiveSynthesisReportView, {
        report,
        gate: b2Gate,
        alignedClaims: b2Claims,
        trustSummary,
        question: QUESTION,
        modelsUsed: b2Models as unknown as any[],
        runId: "test-run-id",
      })
    );
  }

  it("moves single_source claims out of the map and into Single-model insights", () => {
    const html = renderB2();
    const mapHtml = sectionSlice(html, "agreement-disagreement-map");
    const insightsHtml = sectionSlice(html, "single-model-insights");

    expect(mapHtml).not.toContain("Single model claim text");
    expect(insightsHtml).toContain("Single model claim text");
    expect(insightsHtml).toContain("Single-model insights");
  });

  it("sorts consensus before majority before split, and only emphasizes split rows", () => {
    const html = renderB2();
    const mapHtml = sectionSlice(html, "agreement-disagreement-map");

    const consensusIdx = mapHtml.indexOf("Consensus claim text");
    const majorityIdx = mapHtml.indexOf("Majority claim text");
    const splitIdx = mapHtml.indexOf("Split claim text");

    expect(consensusIdx).toBeGreaterThan(-1);
    expect(majorityIdx).toBeGreaterThan(consensusIdx);
    expect(splitIdx).toBeGreaterThan(majorityIdx);
    expect(mapHtml).toContain("border-orange-400");
  });

  it("labels rows with plain counts against the full panel, not a same-denominator fraction", () => {
    const html = renderB2();
    const mapHtml = sectionSlice(html, "agreement-disagreement-map");

    // Majority claim: 2 of 3 agree, 1 dispute, 0 silent.
    expect(mapHtml).toContain("2 of 3 agree");
    expect(mapHtml).toContain("1 dispute");
    // Split claim: 1 of 3 agree, 1 dispute, 1 silent.
    expect(mapHtml).toContain("1 of 3 agree");
    expect(mapHtml).toContain("1 silent");
    // Never the old same-denominator "N/N" fraction style.
    expect(mapHtml).not.toMatch(/>\s*\d+\/\d+\s*</);
  });
});
