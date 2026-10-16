/**
 * Consensus Integrity — rendered surfaces (D4, D6, D7)
 *
 * The agreement map ranks every status through the exhaustive rank map
 * (limited_coverage between majority and split, never a NaN sort), labels
 * limited coverage, and shows the canonical contested note; the Answer strip
 * shows the verdict card's contested note; and rows/reports persisted
 * before this change (no contested axis, no topConsensusContested) render
 * no contested note at all.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgreementDisagreementMap } from "@/components/adaptive/AdaptiveSynthesisReportView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { AdaptiveSynthesisReport, AlignedClaim, AlignedClaimCell, AlignedClaimStatus } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

const MODELS: ModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as ModelId[];

function cell(modelId: ModelId, stance: AlignedClaimCell["stance"]): AlignedClaimCell {
  return { modelId, stance, rawStance: "asserts", confidence: "settled", excerpt: "e" };
}

function row(claimText: string, status: AlignedClaimStatus, agreeing: number, extra: Partial<AlignedClaim> = {}): AlignedClaim {
  const cells = MODELS.map((m, i) => (i < agreeing ? cell(m, "agrees") : null));
  if (status === "split") cells[1] = cell(MODELS[1], "disputes");
  return { id: claimText, claimText, cells, agreementScore: 0.5, certaintyScore: 0.5, status, ...extra };
}

function renderMap(claims: AlignedClaim[]): string {
  return renderToStaticMarkup(createElement(AgreementDisagreementMap, { claims, modelsUsed: MODELS }));
}

describe("AgreementDisagreementMap", () => {
  it("orders every status by the rank map: consensus, majority, limited coverage, split (single source excluded)", () => {
    const html = renderMap([
      row("S-split", "split", 3),
      row("S-limited", "limited_coverage", 2),
      row("S-single", "single_source", 1),
      row("S-majority", "majority", 4),
      row("S-consensus", "consensus", 5),
    ]);
    const order = ["S-consensus", "S-majority", "S-limited", "S-split"].map((t) => html.indexOf(t));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("S-single");
  });

  it("labels a limited_coverage row", () => {
    const html = renderMap([row("Only two said this", "limited_coverage", 2)]);
    expect(html).toContain("2 of 5 agree · 3 silent · limited coverage");
  });

  it("shows the canonical contested note on a contested row", () => {
    const html = renderMap([row("Contested row", "consensus", 5, { contested: { marked: true, assessed: false, markedCount: 5, listedCount: 5 } })]);
    expect(html).toContain("Contested: all 5 models that listed this claim mark it contested");
  });

  it("a persisted legacy row (no contested axis) shows no contested note", () => {
    const html = renderMap([row("Legacy row", "consensus", 5)]);
    expect(html).not.toContain("contested-note");
    expect(html).not.toContain("Contested:");
  });
});

describe("PrimarySynthesisStrip", () => {
  function report(verdictCard: Partial<AdaptiveSynthesisReport["verdictCard"]>): AdaptiveSynthesisReport {
    return {
      unifiedAnswer: "Answer.",
      verdictCard: {
        question: "Q",
        topConsensus: "Top claim",
        consensusModelCount: 5,
        keyDisagreement: null,
        disagreementDetail: null,
        disagreementModelCount: 0,
        caveat: null,
        recommendedNextSteps: [],
        ...verdictCard,
      },
    } as unknown as AdaptiveSynthesisReport;
  }

  it("shows the top consensus's contested note", () => {
    const html = renderToStaticMarkup(
      createElement(PrimarySynthesisStrip, { synthesisReport: report({ topConsensusContested: "all 5 models that listed this claim mark it contested" }) })
    );
    expect(html).toContain("Top claim");
    expect(html).toContain("Contested: all 5 models that listed this claim mark it contested");
  });

  it("a persisted legacy verdict card (no topConsensusContested) renders no contested note", () => {
    const html = renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report({}) }));
    expect(html).not.toContain("Contested:");
  });
});
