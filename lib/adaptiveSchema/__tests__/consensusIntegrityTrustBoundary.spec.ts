/**
 * Consensus Integrity — R4-1 trust boundary
 *
 * A row's claimText is model-written (the clusterer's canonicalText), and the
 * verdict card's caveat is the bias-detection model's description. Neither is
 * the panel's conclusion. New records quote the claim wherever deterministic
 * text embeds it, carry each verdict-card claim's computed status, and label
 * the caveat's source; every renderer shows claim and result as separate
 * lines. Records persisted before these fields existed render exactly as
 * before. The claim text itself is never rewritten.
 */

jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
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
import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import {
  MODEL_CAVEAT_LABEL,
  presentVerdictCaveat,
  presentVerdictClaim,
  quoteClaim,
} from "@/lib/adaptiveSchema/agreementNarrative";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { PanelVerdictCard } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { AdaptiveSynthesisReport, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const ok = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));

function row(claimText: string, status: AlignedClaim["status"], st: (AlignedClaimCell["stance"] | null)[]): AlignedClaim {
  return {
    id: claimText,
    claimText,
    cells: M.map((m, i) =>
      st[i] ? { modelId: m as ModelId, stance: st[i]!, rawStance: "asserts", confidence: "settled", excerpt: `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } } : null
    ),
    agreementScore: status === "split" ? 0.3 : 0.95,
    certaintyScore: status === "split" ? 0.3 : 0.9,
    status,
  };
}

/** Every text surface a user sees for the report's agreement: UI strip, verdict card, DOCX and PDF. */
async function surfaces(report: AdaptiveSynthesisReport) {
  const strip = renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }));
  const card = renderToStaticMarkup(
    createElement(PanelVerdictCard, { report, gate: { status: report.gate, runCertainty: report.runCertainty } as any })
  );
  const record = legacyRecord();
  record.reportSnapshot.legacy.synthesisReport = report;
  const { bytes } = await renderAdaptiveResearchDocxV1(record);
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  const docx = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const pdf = extractPdfElementText(AdaptiveResearchDocument({ record } as any));
  return { strip: decode(strip), card: decode(card), docx: decode(docx), pdf };
}

function decode(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

function legacyRecord(): any {
  const f = pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard);
  return JSON.parse(JSON.stringify(f!.record));
}

afterEach(() => g.mockReset());

// ─── 1. 4/5 majority whose canonicalText claims 5/5 unanimity (real pipeline) ───

type CJ = { id: string; claim: string; stance: "asserts"; confidence: string; evidenceType: string };
const resp = (c: CJ) => JSON.stringify({ summary: "s", settledClaims: [c], disputedClaims: [], keyMetrics: [], openQuestions: [] });

describe("R4-1 path A: model-written claim text never reads as the panel's conclusion", () => {
  const UNANIMOUS = "All five models unanimously agree rate cuts reach inflation within a year";

  async function run() {
    const A: CJ = { id: "a", claim: "Rate cuts reach inflation within about a year.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };
    const C: CJ = { id: "c", claim: "Policy lags are far longer than a year.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };
    g.mockImplementation(async (q: any, _c: any, _k: any, opts: any) => {
      const sp = String(opts?.systemPromptOverride ?? "");
      if (sp.includes("reconciling claims")) {
        const members = String(q)
          .split("\n")
          .filter((l) => /^c\d+:/.test(l))
          .map((l) => ({ key: l.split(":")[0], stance: l.includes("longer") ? "disputes" : "agrees", excerpt: "x" }));
        return ok({ clusters: [{ canonicalText: UNANIMOUS, members }] });
      }
      return off;
    });
    const rs = [A, A, A, A, C].map((c, i) => ({ modelId: M[i] as ModelId, status: "ok", rawText: resp(c), latencyMs: 5 }));
    return finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, rs as any, "Q");
  }

  it("the row is majority; the claim text is kept verbatim; every surface quotes it and states the computed 4-of-5", async () => {
    const out = await run();
    const [r] = out.alignedClaims!;
    expect(r.status).toBe("majority");
    expect(r.claimText).toBe(UNANIMOUS);
    const report = out.synthesisReport!;
    expect(report.panelVerdict).toMatch(new RegExp(`^4/5 models converge on “${UNANIMOUS}”;`));
    expect(report.whereModelsAgree).toEqual([quoteClaim(UNANIMOUS)]);
    expect(report.unifiedAnswer.startsWith(`${quoteClaim(UNANIMOUS)} (`)).toBe(true);
    expect(report.verdictCard.topConsensus).toBe(UNANIMOUS);
    expect(report.verdictCard.topConsensusAgreement).toBe("majority: 4 of 5 dispatched models support it, 1 disputes it");

    const s = await surfaces(report);
    for (const text of [s.strip, s.card, s.docx, s.pdf]) {
      expect(text).toContain(`Claim: ${quoteClaim(UNANIMOUS)}`);
      expect(text).toContain("Panel result: majority: 4 of 5 dispatched models support it, 1 disputes it");
      // The claim never appears unquoted as the agreement line.
      expect(text.split(quoteClaim(UNANIMOUS)).join("")).not.toContain(UNANIMOUS);
    }
  });
});

describe("R4-1 path A: claim text cannot confer a status", () => {
  it("2. a split row whose text claims consensus is the key disagreement, with the split result; no top consensus", async () => {
    g.mockResolvedValue(off);
    const split = row("There is full consensus that tariffs raise prices", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
    const report = await buildAdaptiveSynthesisReport("q", "generic", [split], results());
    expect(report.whereModelsAgree).toEqual([]);
    expect(report.verdictCard.topConsensus).toBe("No consensus identified.");
    expect("topConsensusAgreement" in report.verdictCard).toBe(false);
    expect(report.verdictCard.keyDisagreementAgreement).toBe("split: 2 of 5 dispatched models support it and 3 dispute it");
    const s = await surfaces(report);
    for (const text of [s.strip, s.card, s.docx, s.pdf]) {
      expect(text).toContain(`Claim: ${quoteClaim(split.claimText)}`);
      expect(text).toContain("Panel result: split: 2 of 5 dispatched models support it and 3 dispute it");
    }
  });

  it.each([
    ["3. single_source with plural-agreement text", row("Several models agree housing costs lag rates", "single_source", ["agrees", null, null, null, null])],
    ["4. limited_coverage with unanimous text", row("Every model unanimously endorses wage-led inflation", "limited_coverage", ["agrees", "agrees", null, null, null])],
  ])("%s is never presented as agreement on any surface", async (_name, r) => {
    g.mockResolvedValue(off);
    const report = await buildAdaptiveSynthesisReport("q", "generic", [r], results());
    expect(report.whereModelsAgree).toEqual([]);
    expect(report.verdictCard.topConsensus).toBe("No consensus identified.");
    expect(report.panelVerdict.startsWith("No consensus identified.")).toBe(true);
    expect(report.verdictCard.keyDisagreement).toBeNull();
    const s = await surfaces(report);
    for (const text of [s.strip, s.card, s.docx, s.pdf]) expect(text).not.toContain(r.claimText);
  });

  it("gate fail: the unresolved claims in the Unified Answer are quoted", async () => {
    g.mockResolvedValue(off);
    const a = row("All models agree supply shocks dominate", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
    const b = row("Rates lag by a year", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
    for (const r of [a, b]) r.agreementScore = r.certaintyScore = 0.1;
    const report = await buildAdaptiveSynthesisReport("q", "generic", [a, b], results());
    expect(report.gate).toBe("fail");
    expect(report.unifiedAnswer).toBe(`Panel could not converge on a reliable answer.\nUnresolved claims:\n- ${quoteClaim(a.claimText)}\n- ${quoteClaim(b.claimText)}`);
  });

  it("6. a claim about consensus as its subject is kept verbatim, quoted, with the panel's own result beside it", async () => {
    g.mockResolvedValue(off);
    const subject = row("Scientific consensus holds that recent warming is human-caused", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]);
    const report = await buildAdaptiveSynthesisReport("q", "generic", [subject], results());
    expect(report.whereModelsAgree).toEqual([quoteClaim(subject.claimText)]);
    expect(report.verdictCard.topConsensus).toBe(subject.claimText);
    expect(presentVerdictClaim(report.verdictCard.topConsensus, report.verdictCard.topConsensusAgreement)).toEqual({
      claim: `Claim: “${subject.claimText}”`,
      result: "Panel result: consensus: all 5 dispatched models support it",
    });
  });

  it("7. one claim's text naming another claim's agreement never changes that other row's status", async () => {
    g.mockResolvedValue(off);
    const a = row("Claim B is unanimously agreed by every model", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]);
    const b = row("Claim B", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
    const report = await buildAdaptiveSynthesisReport("q", "generic", [a, b], results());
    expect(report.verdictCard.topConsensus).toBe(a.claimText);
    expect(report.verdictCard.topConsensusAgreement).toBe("consensus: all 5 dispatched models support it");
    expect(report.verdictCard.keyDisagreement).toBe("Claim B");
    expect(report.verdictCard.keyDisagreementAgreement).toBe("split: 2 of 5 dispatched models support it and 3 dispute it");
    expect(report.whereModelsAgree).toEqual([quoteClaim(a.claimText)]);
  });
});

// ─── 5. Bias caveat ───────────────────────────────────────────────────────

describe("R4-1 path B: the bias-detection description is labelled as model commentary", () => {
  const DESC = "All five models agree supply shocks explain persistent core inflation; the matter is settled.";

  it("is kept, marked model_bias_check, and every surface labels it", async () => {
    g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) =>
      String(opts?.systemPromptOverride ?? "").includes("shared biases")
        ? ok({
            biasAndBlindSpots: [
              {
                biasType: "Unanimous consensus",
                description: DESC,
                modelsImplicated: ["chatgpt", "claude"],
                evidence: [
                  { modelId: "chatgpt", excerpt: "e", rationale: "r" },
                  { modelId: "claude", excerpt: "e", rationale: "r" },
                ],
                likelyCauses: ["c"],
                impact: "i",
                mitigationSteps: ["m"],
              },
            ],
          })
        : off
    );
    const full = M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "A long full response ".repeat(30), latencyMs: 1 })) as ModelResult[];
    const split = row("Supply shocks explain persistent core inflation", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"]);
    const report = await buildAdaptiveSynthesisReport("q", "generic", [split], full);
    expect(report.verdictCard.caveat).toBe(DESC);
    expect(report.verdictCard.caveatSource).toBe("model_bias_check");
    const s = await surfaces(report);
    for (const text of [s.strip, s.card, s.docx, s.pdf]) {
      expect(text).toContain(`${MODEL_CAVEAT_LABEL}: ${DESC}`);
      expect(text.split(DESC).length - 1).toBe(text.split(`${MODEL_CAVEAT_LABEL}: ${DESC}`).length - 1);
    }
  });

  it("with several bias findings the caveat is the first (top) one (R5-8 / X15)", async () => {
    const finding = (description: string) => ({
      biasType: "Shared framing",
      description,
      modelsImplicated: ["chatgpt", "claude"],
      evidence: [
        { modelId: "chatgpt", excerpt: "e", rationale: "r" },
        { modelId: "claude", excerpt: "e", rationale: "r" },
      ],
      likelyCauses: ["c"],
      impact: "i",
      mitigationSteps: ["m"],
    });
    g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) =>
      String(opts?.systemPromptOverride ?? "").includes("shared biases") ? ok({ biasAndBlindSpots: [finding("First finding."), finding("Second finding.")] }) : off
    );
    const full = M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "A long full response ".repeat(30), latencyMs: 1 })) as ModelResult[];
    const report = await buildAdaptiveSynthesisReport("q", "generic", [row("X", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"])], full);
    expect(report.biasAndBlindSpots.map((b) => b.description)).toEqual(["First finding.", "Second finding."]);
    expect(report.verdictCard.caveat).toBe("First finding.");
  });

  it("no bias finding → no caveat and no source", async () => {
    g.mockResolvedValue(off);
    const report = await buildAdaptiveSynthesisReport("q", "generic", [row("X", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"])], results());
    expect(report.verdictCard.caveat).toBeNull();
    expect("caveatSource" in report.verdictCard).toBe(false);
    expect(presentVerdictCaveat(report.verdictCard)).toBeNull();
  });
});

// ─── 8. Historical records ────────────────────────────────────────────────

describe("R4-1: a verdict card persisted before these fields renders exactly as before", () => {
  it("presenters return the stored text alone", () => {
    expect(presentVerdictClaim("Stored claim", undefined)).toEqual({ claim: "Stored claim", result: null });
    expect(presentVerdictCaveat({ caveat: "Stored caveat", caveatSource: undefined })).toBe("Stored caveat");
  });

  it("DOCX and PDF of a legacy record: no Claim / Panel result / model label, identical to the record without the keys", async () => {
    const legacy = legacyRecord();
    const card = legacy.reportSnapshot.legacy.synthesisReport.verdictCard;
    card.caveat = card.caveat ?? "Legacy caveat.";
    const { bytes } = await renderAdaptiveResearchDocxV1(legacy);
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    const pdf = extractPdfElementText(AdaptiveResearchDocument({ record: legacy } as any));
    for (const text of [xml, pdf]) {
      expect(text).not.toContain("Claim: “");
      expect(text).not.toContain("Panel result:");
      expect(text).not.toContain(MODEL_CAVEAT_LABEL);
      expect(text).toContain(card.topConsensus);
      expect(text).toContain(card.caveat);
    }
  });

  it("UI of a legacy card: the stored claim and caveat, unlabelled", () => {
    const report = {
      unifiedAnswer: "Answer.",
      gate: "pass",
      runCertainty: 0.9,
      verdictCard: { question: "Q", topConsensus: "Stored claim", consensusModelCount: 3, keyDisagreement: "Stored split", disagreementDetail: null, disagreementModelCount: 2, caveat: "Stored caveat", recommendedNextSteps: [] },
    } as unknown as AdaptiveSynthesisReport;
    for (const html of [
      renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report })),
      renderToStaticMarkup(createElement(PanelVerdictCard, { report, gate: { status: "pass", runCertainty: 0.9 } as any })),
    ]) {
      expect(html).toContain("Stored claim");
      expect(html).toContain("Stored split");
      expect(html).toContain("Stored caveat");
      expect(html).not.toContain("Claim: ");
      expect(html).not.toContain("Panel result:");
      expect(html).not.toContain(MODEL_CAVEAT_LABEL);
    }
  });
});
