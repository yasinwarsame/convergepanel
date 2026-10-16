/**
 * Consensus Integrity — R1 corrections
 *
 * F1: only consensus/majority rows may be presented as the panel's top
 * consensus ("Top consensus", "agreed by N", "N/M models converge on"). With
 * none, the verdict and card say "No consensus identified." — split,
 * single_source and limited_coverage rows are never picked, however salient.
 * F2: the DOCX and PDF agreement line carry the canonical contested note when
 * the verdict card has one, and render exactly as before when it doesn't.
 * N2: D5's corrected split raises trust-summary contradiction counts only on
 * D5-affected rows; the limited_coverage relabel never changes the trust summary.
 */

jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import { NO_CONSENSUS_IDENTIFIED, buildAdaptiveVerdict, coreFindingClaim } from "@/lib/adaptiveSchema/verdict";
import { buildAdaptiveVerdictCard } from "@/lib/adaptiveSchema/verdictCard";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { scoreAgreement } from "@/lib/adaptiveSchema/agreementComparators";
import { applyConsensusIntegrity, isTopConsensusEligible, TOP_CONSENSUS_ELIGIBLE } from "@/lib/adaptiveSchema/consensusIntegrity";
import { buildAdaptiveTrustSummary } from "@/lib/adaptiveSchema/trustSummary";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { ALIGNED_CLAIM_STATUSES, AdaptiveModelResult, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as ModelId[];

function cell(m: ModelId, stance: AlignedClaimCell["stance"], extra: Partial<AlignedClaimCell> = {}): AlignedClaimCell {
  return { modelId: m, stance, rawStance: "asserts", confidence: "settled", excerpt: `${m} e`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" }, ...extra };
}

/** A row whose first `stances.length` columns are filled; the rest silent. */
function row(claimText: string, status: AlignedClaim["status"], stances: AlignedClaimCell["stance"][], extra: Partial<AlignedClaim> = {}): AlignedClaim {
  const cells = M.map((m, i) => (i < stances.length ? cell(m, stances[i]) : null));
  return { id: claimText, claimText, cells, agreementScore: 0.5, certaintyScore: 0.5, status, ...extra };
}

const SPLIT = () => row("Split claim", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
const SINGLE = () => row("Lone claim", "single_source", ["agrees"]);
const LIMITED = () => row("Thin claim", "limited_coverage", ["agrees", "agrees"]);

function surfaces(rows: AlignedClaim[]) {
  const gate = computeAdaptiveGate(rows, 0.6, "generic");
  return { core: coreFindingClaim(rows), card: buildAdaptiveVerdictCard("Q", rows, gate, []), verdict: buildAdaptiveVerdict(rows, gate, 5) };
}

function expectNoConsensus(rows: AlignedClaim[]) {
  const { core, card, verdict } = surfaces(rows);
  expect(core).toBeNull();
  expect(card.topConsensus).toBe(NO_CONSENSUS_IDENTIFIED);
  expect(card.consensusModelCount).toBe(0);
  expect("topConsensusContested" in card).toBe(false);
  expect(verdict.coreFinding).toBe(NO_CONSENSUS_IDENTIFIED);
  expect(verdict.convergingModelCount).toBe(0);
  expect(verdict.summary).toBe("No consensus identified. Certainty 60%; gate: caution.");
  expect(verdict.summary).not.toMatch(/converge|agree/i);
  const strip = renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: { unifiedAnswer: "A.", verdictCard: card } as any }));
  expect(strip).not.toMatch(/— \d+ models?/);
}

describe("F1: top-consensus eligibility contract", () => {
  it("is exactly consensus and majority, for every status", () => {
    expect(Object.keys(TOP_CONSENSUS_ELIGIBLE).sort()).toEqual([...ALIGNED_CLAIM_STATUSES].sort());
    expect(ALIGNED_CLAIM_STATUSES.filter((s) => TOP_CONSENSUS_ELIGIBLE[s])).toEqual(["consensus", "majority"]);
    for (const s of ALIGNED_CLAIM_STATUSES) expect(isTopConsensusEligible(s)).toBe(s === "consensus" || s === "majority");
  });

  it("an unknown (future or malformed) status is never eligible", () => {
    expect(isTopConsensusEligible("some_future_status")).toBe(false);
    expect(isTopConsensusEligible("")).toBe(false);
  });

  it("split only → no consensus identified", () => expectNoConsensus([SPLIT()]));
  it("single_source only → no consensus identified", () => expectNoConsensus([SINGLE()]));
  it("limited_coverage only → no consensus identified", () => expectNoConsensus([LIMITED()]));
  it("split + single_source + limited_coverage, all more salient than nothing → still no consensus identified", () =>
    expectNoConsensus([SPLIT(), SINGLE(), LIMITED()]));

  it("the R1 reproduction shape (2/4 limited row + a 1-agree/2-dispute split) → no consensus identified, the split stays the key disagreement", () => {
    const rows = [
      row("alpha", "limited_coverage", ["agrees", "agrees"]),
      { ...row("beta", "split", ["agrees", "disputes", "disputes"]) },
    ];
    expectNoConsensus(rows);
    expect(surfaces(rows).card.keyDisagreement).toBe("beta");
  });

  it("D5: a contested_empirical 2–2 split with identical camps is never top consensus", () => {
    const camps = [
      { label: "A", position: "a" },
      { label: "B", position: "b" },
    ];
    const r = row("D5 claim", "single_source", ["agrees", "agrees", "disputes", "disputes"]);
    r.cells = r.cells.map((c) => (c ? { ...c, camps } : c));
    const rows = applyConsensusIntegrity(scoreAgreement("contested_empirical", [r]), 4);
    expect(rows[0].status).toBe("split");
    expectNoConsensus(rows);
  });

  describe("mixed statuses: an eligible row always wins, whatever the others' salience", () => {
    it("split (5 positions) + consensus (3 positions) → the consensus", () => {
      expect(surfaces([SPLIT(), row("C", "consensus", ["agrees", "agrees", "agrees"])]).core!.claimText).toBe("C");
    });
    it("single_source + majority → the majority", () => {
      expect(surfaces([SINGLE(), row("Maj", "majority", ["agrees", "agrees", "partial"])]).core!.claimText).toBe("Maj");
    });
    it("limited_coverage + consensus → the consensus", () => {
      expect(surfaces([LIMITED(), row("C", "consensus", ["agrees", "agrees", "agrees"])]).core!.claimText).toBe("C");
    });
    it("several eligible rows → the most salient (most positions), ties keep input order", () => {
      const rows = [
        row("C3", "consensus", ["agrees", "agrees", "agrees"]),
        row("M4", "majority", ["agrees", "agrees", "agrees", "partial"]),
        row("C4", "consensus", ["agrees", "agrees", "agrees", "agrees"]),
        SPLIT(),
      ];
      expect(surfaces(rows).core!.claimText).toBe("M4");
      expect(surfaces(rows).verdict.summary).toMatch(/^4\/5 models converge on M4;/);
    });
  });
});

// ─── F2: DOCX / PDF agreement line ───────────────────────────────────────

function legacyRecord(): any {
  const f = pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard);
  return JSON.parse(JSON.stringify(f!.record));
}

async function docxText(record: any): Promise<string> {
  const { bytes } = await renderAdaptiveResearchDocxV1(record);
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("F2: contested note in DOCX and PDF", () => {
  const NOTE = "all 5 models that listed this claim mark it contested";

  it("DOCX: present → the agreement line is followed by the note; absent → no note", async () => {
    const legacy = legacyRecord();
    const withNote = JSON.parse(JSON.stringify(legacy));
    withNote.reportSnapshot.legacy.synthesisReport.verdictCard.topConsensusContested = NOTE;
    const top = legacy.reportSnapshot.legacy.synthesisReport.verdictCard.topConsensus;

    const textWith = await docxText(withNote);
    expect(textWith).toContain(`Contested: ${NOTE}`);
    expect(textWith.indexOf(`Contested: ${NOTE}`)).toBeGreaterThan(textWith.indexOf(top));

    const textWithout = await docxText(legacy);
    expect(textWithout).not.toContain("Contested:");
  });

  it("DOCX: a legacy record (no field) produces the same document.xml as before the field existed", async () => {
    const legacy = legacyRecord();
    const explicitUndefined = JSON.parse(JSON.stringify(legacy));
    delete explicitUndefined.reportSnapshot.legacy.synthesisReport.verdictCard.topConsensusContested;
    expect(await docxText(explicitUndefined)).toBe(await docxText(legacy));
  });

  it("PDF: present → the agreement text carries the note; absent → the element text is the claim alone", () => {
    const legacy = legacyRecord();
    const withNote = JSON.parse(JSON.stringify(legacy));
    withNote.reportSnapshot.legacy.synthesisReport.verdictCard.topConsensusContested = NOTE;
    const top = legacy.reportSnapshot.legacy.synthesisReport.verdictCard.topConsensus;

    const textWith = extractPdfElementText(AdaptiveResearchDocument({ record: withNote } as any));
    expect(textWith).toContain(`${top}\nContested: ${NOTE}`);
    const textWithout = extractPdfElementText(AdaptiveResearchDocument({ record: legacy } as any));
    expect(textWithout).not.toContain("Contested:");
    expect(textWithout).toContain(top);
  });
});

// ─── N2: trust summary ────────────────────────────────────────────────────

function okResults(models: ModelId[]): AdaptiveModelResult[] {
  return models.map((modelId) => ({ modelId, schemaId: "contested_empirical", ok: true, data: {}, invalidFields: [] }) as unknown as AdaptiveModelResult);
}

describe("N2: trust summary under D5 and limited_coverage", () => {
  const schema = SCHEMA_REGISTRY.contested_empirical;

  it("D5: the corrected split counts each disputing model's contradiction (the old false majority counted none)", () => {
    const camps = [
      { label: "A", position: "a" },
      { label: "B", position: "b" },
    ];
    const r = row("D5 claim", "single_source", ["agrees", "agrees", "disputes", "disputes"]);
    r.cells = r.cells.map((c) => (c ? { ...c, camps } : c));
    const corrected = applyConsensusIntegrity(scoreAgreement("contested_empirical", [r]), 4);
    expect(corrected[0].status).toBe("split");
    const legacyMajority = [{ ...corrected[0], status: "majority" as const }];

    const now = buildAdaptiveTrustSummary(schema, okResults(M.slice(0, 4)), corrected);
    const before = buildAdaptiveTrustSummary(schema, okResults(M.slice(0, 4)), legacyMajority);
    const count = (t: typeof now, m: ModelId) => t.perModel.find((p) => p.modelId === m)!.contradictionCount;

    for (const m of ["grok", "perplexity"] as ModelId[]) {
      expect(count(before, m)).toBe(0);
      expect(count(now, m)).toBe(1); // stricter: a disputing model is now recorded as contradicting a split
    }
    for (const m of ["chatgpt", "claude"] as ModelId[]) expect(count(now, m)).toBe(count(before, m));
  });

  it("limited_coverage never changes the trust summary (it only relabels consensus/majority, which trust never counts as split)", () => {
    const rows = [row("Thin", "consensus", ["agrees", "agrees"])];
    const relabelled = applyConsensusIntegrity(rows, 5);
    expect(relabelled[0].status).toBe("limited_coverage");
    expect(buildAdaptiveTrustSummary(schema, okResults(M), relabelled)).toEqual(buildAdaptiveTrustSummary(schema, okResults(M), rows));
  });
});
