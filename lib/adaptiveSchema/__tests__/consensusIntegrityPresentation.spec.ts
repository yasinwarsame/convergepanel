/**
 * Consensus Integrity — R5 presentation contract, end to end.
 *
 * Every surface (report view HTML, Answer strip, Markdown, memo, LinkedIn, X,
 * DOCX, PDF, JSON) must keep four kinds of text apart: the computed panel
 * result, model-written claim text (verbatim, quoted, labelled), the
 * narrative model's explanation (labelled) and the bias check's observation
 * (labelled). These tests check where each piece of text sits and how it is
 * attributed — not merely that a string is present.
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
import { buildAdaptiveLinkedInPost, buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost } from "@/lib/adaptiveSchema/shareBuilders";
import { MODEL_EXPLANATION_LABEL, escapeMarkdown, presentAgreeItems, presentExecutiveSummary } from "@/lib/adaptiveSchema/reportPresentation";
import { quoteClaim } from "@/lib/adaptiveSchema/agreementNarrative";
import AdaptiveSynthesisReportView, { AgreementDisagreementMap, DisagreementsSection } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { AdaptiveSynthesisReport, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const ok = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));

function row(claimText: string, status: AlignedClaim["status"], st: (AlignedClaimCell["stance"] | null)[], extra: Partial<AlignedClaim> = {}): AlignedClaim {
  return {
    id: claimText,
    claimText,
    cells: M.map((m, i) =>
      st[i] ? { modelId: m as ModelId, stance: st[i]!, rawStance: "asserts", confidence: "settled", excerpt: `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } } : null
    ),
    agreementScore: status === "split" ? 0.3 : 0.95,
    certaintyScore: status === "split" ? 0.3 : 0.9,
    status,
    ...extra,
  };
}

let narrativeCalls = 0;
function mockNarrative(n: Record<string, unknown> | null) {
  narrativeCalls = 0;
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) => {
    if (n && String(opts?.systemPromptOverride ?? "").includes("narrative portion")) {
      narrativeCalls++;
      return ok({ executiveSummary: "", whyModelsDisagree: [], disagreementStakes: [], certaintyAssessment: "", narrativeSections: [], ...n });
    }
    return off;
  });
}

function viewHtml(report: AdaptiveSynthesisReport, rows: AlignedClaim[]): string {
  const gate = { status: report.gate, runCertainty: report.runCertainty, loadBearingClaims: [], loadBearingSplitCount: 0 } as any;
  return renderToStaticMarkup(createElement(AdaptiveSynthesisReportView, { report, gate, alignedClaims: rows, question: "Q?", modelsUsed: M as ModelId[] }));
}

/**
 * Every source the `text` occurs under in the view: the HTML is cut at each `data-source="…"` attribute and each
 * occurrence is attributed to the block it falls in. Text before the first attributed block counts as "unattributed".
 */
function sourcesOf(html: string, text: string): string[] {
  const decoded = html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  const parts = decoded.split(/data-source="/);
  const out: string[] = [];
  parts.forEach((part, i) => {
    const source = i === 0 ? "unattributed" : part.slice(0, part.indexOf('"'));
    const body = part.replace(/<[^>]+>/g, " ");
    let at = body.indexOf(text);
    while (at >= 0) {
      out.push(source);
      at = body.indexOf(text, at + 1);
    }
  });
  return out;
}

function shares(report: AdaptiveSynthesisReport) {
  return {
    markdown: buildAdaptiveSynthesisMarkdown("Q?", report),
    memo: buildAdaptiveMemoInput("Q?", report, M as ModelId[], "run"),
    linkedin: buildAdaptiveLinkedInPost("Q?", report),
    x: buildAdaptiveXPost("Q?", report),
  };
}

/** Every occurrence of `claim` in `text` is inside our quotes (“claim”) — never bare. */
function onlyQuoted(text: string, claim: string): boolean {
  return text.split(quoteClaim(claim)).join("").indexOf(claim) === -1;
}

afterEach(() => g.mockReset());

// ─── 1, 7, 9: 4/5 majority, unanimous claim text, contradictory narrative (real pipeline) ───

type CJ = { id: string; claim: string; stance: "asserts"; confidence: string; evidenceType: string };
const resp = (c: CJ) => JSON.stringify({ summary: "s", settledClaims: [c], disputedClaims: [], keyMetrics: [], openQuestions: [] });
const UNAN = "All five models unanimously agree rate cuts reach inflation within a year";
const CONTRADICTIONS = ["All five responses say the same thing on this point.", "Nobody disputes the one-year lag.", "Each AI reached an identical answer.", "Every response points the same way."];

describe("R5-1/R5-2: a 4/5 majority with a 5/5 claim and contradictory prose (real pipeline)", () => {
  async function run() {
    const A: CJ = { id: "a", claim: "Rate cuts reach inflation within about a year.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };
    const C: CJ = { id: "c", claim: "Policy lags are far longer than a year.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };
    g.mockImplementation(async (q: any, _c: any, _k: any, opts: any) => {
      const sp = String(opts?.systemPromptOverride ?? "");
      if (sp.includes("reconciling claims")) {
        const members = String(q).split("\n").filter((l) => /^c\d+:/.test(l)).map((l) => ({ key: l.split(":")[0], stance: l.includes("longer") ? "disputes" : "agrees", excerpt: "x" }));
        return ok({ clusters: [{ canonicalText: UNAN, members }] });
      }
      if (sp.includes("narrative portion")) {
        return ok({
          executiveSummary: `Rates matter.\n\n${CONTRADICTIONS[0]} ${CONTRADICTIONS[1]}\n\n${CONTRADICTIONS[2]}`,
          whyModelsDisagree: [],
          disagreementStakes: [],
          certaintyAssessment: `Evidence is strong. ${CONTRADICTIONS[3]}`,
          narrativeSections: [],
        });
      }
      return off;
    });
    const rs = [A, A, A, A, C].map((c, i) => ({ modelId: M[i] as ModelId, status: "ok", rawText: resp(c), latencyMs: 5 }));
    const out = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, rs as any, "Q");
    return { report: out.synthesisReport!, rows: out.alignedClaims! };
  }

  it("the computed result is majority 4 of 5 everywhere it is stated; the claim is quoted and labelled", async () => {
    const { report, rows } = await run();
    expect(rows[0].status).toBe("majority");
    expect(rows[0].claimText).toBe(UNAN);
    expect(report.presentation!.agree).toEqual([{ claim: UNAN, result: "majority: 4 of 5 dispatched models support it, 1 disputes it" }]);
    const html = viewHtml(report, rows);
    expect(sourcesOf(html, `Claim: ${quoteClaim(UNAN)}`).length).toBeGreaterThan(0);
    expect(sourcesOf(html, "Panel result: majority: 4 of 5 dispatched models support it, 1 disputes it").every((s) => s === "computed")).toBe(true);
    const sh = shares(report);
    expect(sh.markdown).toContain(`- **Claim:** ${escapeMarkdown(quoteClaim(UNAN))} — **Panel result:** majority: 4 of 5 dispatched models support it, 1 disputes it`);
    expect(sh.memo.keyFindings[0]).toBe(`Claim: ${quoteClaim(UNAN)} — Panel result: majority: 4 of 5 dispatched models support it, 1 disputes it`);
    expect(sh.linkedin).toContain("— panel result: majority: 4 of 5 dispatched models support it, 1 disputes it");
    for (const t of [sh.markdown, sh.memo.keyFindings.join("\n"), sh.linkedin]) expect(onlyQuoted(t, UNAN)).toBe(true);
  });

  it("contradictory model prose appears only inside blocks labelled model-written explanation — never as the panel result", async () => {
    const { report, rows } = await run();
    expect(report.presentation!.executiveSummarySource).toBe("model_explanation");
    expect(report.presentation!.panelAgreement).toBe("Of 1 scored claim across 5 dispatched models: majority agreement on 1.");
    // The computed fields never carry model prose.
    for (const c of CONTRADICTIONS) {
      expect(report.presentation!.panelAgreement).not.toContain(c);
      expect(report.certaintyAssessment).not.toContain(c);
      expect(report.unifiedAnswer).not.toContain(c);
      expect(report.panelVerdict).not.toContain(c);
    }
    const html = viewHtml(report, rows);
    for (const c of CONTRADICTIONS) {
      const where = sourcesOf(html, c);
      expect(where.length).toBeGreaterThan(0);
      expect(where.every((s) => s === "model_explanation")).toBe(true);
    }
    // Each model block carries its label, and the computed statement is a separate block before it.
    const summary = presentExecutiveSummary(report);
    expect(summary.map((b) => [b.source, b.label])).toEqual([
      ["computed", "Panel result"],
      ["model_explanation", MODEL_EXPLANATION_LABEL],
    ]);
    // Markdown and memo: the prose follows the explanation label, the statement follows the panel-result label.
    const sh = shares(report);
    const md = sh.markdown;
    expect(md).toContain(`**Panel result:**\nOf 1 scored claim across 5 dispatched models: majority agreement on 1.`);
    for (const c of CONTRADICTIONS.slice(0, 3)) {
      const at = md.indexOf(c);
      expect(md.lastIndexOf(`**${MODEL_EXPLANATION_LABEL}:**`, at)).toBeGreaterThan(md.lastIndexOf("**Panel result:**", at));
    }
    expect(md).toContain(`**${MODEL_EXPLANATION_LABEL}:**\nEvidence is strong. ${CONTRADICTIONS[3]}`);
    expect(sh.memo.confidenceAssessment.startsWith("Panel result: Of 1 scored claim")).toBe(true);
    expect(sh.memo.confidenceAssessment).toContain(`${MODEL_EXPLANATION_LABEL}: Rates matter.`);
  });
});

// ─── 2, 8, 9: split claim claiming unanimity; why-they-differ denying the split ───

describe("R5-1: the disagreement side and the share builders use the same boundary", () => {
  const SPLIT_CLAIM = "All five models unanimously agree tariffs raise prices";
  const DENIAL = "Nobody actually disagrees; they differ only in wording.";

  async function build() {
    mockNarrative({ executiveSummary: "Tariff pass-through varies.", whyModelsDisagree: [DENIAL], disagreementStakes: ["important"] });
    const rows = [row(SPLIT_CLAIM, "split", ["agrees", "agrees", "disputes", "disputes", "disputes"])];
    return { report: await buildAdaptiveSynthesisReport("Q?", "generic", rows, results()), rows };
  }

  it("view: the disagreement heading is the quoted claim with its computed split; the explanation is labelled model-written", async () => {
    const { report, rows } = await build();
    expect(report.disagreements[0].topic).toBe(SPLIT_CLAIM);
    const html = viewHtml(report, rows);
    expect(sourcesOf(html, `Claim: ${quoteClaim(SPLIT_CLAIM)}`).length).toBeGreaterThan(0);
    expect(sourcesOf(html, "Panel result: split: 2 of 5 dispatched models support it and 3 dispute it").every((s) => s === "computed")).toBe(true);
    expect(sourcesOf(html, DENIAL)).toEqual(["model_explanation"]);
    // The Disagreements section never shows the bare claim.
    const section = renderToStaticMarkup(createElement(DisagreementsSection, { report })).replace(/&quot;/g, '"');
    expect(onlyQuoted(section, SPLIT_CLAIM)).toBe(true);
    // The agreement map (rendered from the stored rows, historical rendering unchanged) lists the claim in the
    // same row as its computed position counts and status label.
    const map = renderToStaticMarkup(createElement(AgreementDisagreementMap, { claims: rows, modelsUsed: M as ModelId[] }));
    const at = map.indexOf(SPLIT_CLAIM);
    expect(at).toBeGreaterThan(-1);
    expect(map.slice(at)).toMatch(/^[^]*?2 of 5 agree · 3 dispute/);
  });

  it("Markdown, memo, LinkedIn and X: quoted claim + computed split; explanation labelled; never the bare claim", async () => {
    const { report } = await build();
    const sh = shares(report);
    const result = "split: 2 of 5 dispatched models support it and 3 dispute it";
    expect(sh.markdown).toContain(`- **Claim:** ${escapeMarkdown(quoteClaim(SPLIT_CLAIM))} — **Panel result:** ${result}`);
    expect(sh.markdown).toContain(`  - **${MODEL_EXPLANATION_LABEL}:** ${DENIAL}`);
    expect(sh.memo.synthesisDisagreements).toEqual([`Claim: ${quoteClaim(SPLIT_CLAIM)} — Panel result: ${result} — ${MODEL_EXPLANATION_LABEL}: ${DENIAL}`]);
    expect(sh.linkedin).toContain(`→ ${quoteClaim(SPLIT_CLAIM)} — panel result: ${result}`);
    expect(sh.x).toContain(`Models split on: ${quoteClaim(SPLIT_CLAIM)} — panel result: ${result}`);
    expect(sh.x.length).toBeLessThanOrEqual(280);
    for (const t of [sh.markdown, sh.memo.synthesisDisagreements.join("\n"), sh.linkedin, sh.x]) expect(onlyQuoted(t, SPLIT_CLAIM)).toBe(true);
  });

  it("X keeps the computed result even with a long question and claim", async () => {
    mockNarrative(null);
    const long = "Tariffs on intermediate goods raise downstream consumer prices by more than the tariff rate in every sector studied";
    const report = await buildAdaptiveSynthesisReport("Q?".repeat(60), "generic", [row(long, "split", ["agrees", "agrees", "disputes", "disputes", "disputes"])], results());
    const x = buildAdaptiveXPost("A very long question ".repeat(10), report);
    expect(x).toContain("panel result: split: 2 of 5 dispatched models support it and 3 dispute it");
  });
});

// ─── 3, 4, 5, 10: limited, single source, contested, mixed ───

describe("R5-1: every status keeps its own computed result; claim text never confers one", () => {
  it("mixed report: each agree item carries its own row's result; limited and single-source claims never appear as agreement", async () => {
    mockNarrative(null);
    const rows = [
      row("Wages lag prices by a year", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]),
      row("Rate cuts reach inflation in a year", "majority", ["agrees", "agrees", "agrees", "disputes", null]),
      row("Every model agrees housing leads the cycle", "limited_coverage", ["agrees", "agrees", null, null, null]),
      row("Several models agree credit spreads predict recessions", "single_source", ["agrees", null, null, null, null]),
      row("This is settled science: tariffs raise prices", "consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"], {
        contested: { marked: true, assessed: false, markedCount: 5, listedCount: 5 },
      }),
    ];
    const report = await buildAdaptiveSynthesisReport("Q?", "generic", rows, results());
    expect(presentAgreeItems(report).map((a) => [a.claim.text, a.result?.text, a.contested?.text ?? null])).toEqual([
      [quoteClaim("Wages lag prices by a year"), "consensus: all 5 dispatched models support it", null],
      [quoteClaim("Rate cuts reach inflation in a year"), "majority: 3 of 5 dispatched models support it, 1 disputes it", null],
      [quoteClaim("This is settled science: tariffs raise prices"), "consensus: all 5 dispatched models support it", "all 5 models that listed this claim mark it contested"],
    ]);
    const html = viewHtml(report, rows);
    const sh = shares(report);
    for (const surface of [sh.markdown, sh.memo.keyFindings.join("\n"), sh.memo.synthesisAgreements.join("\n"), sh.linkedin, sh.x]) {
      expect(surface).not.toContain("Every model agrees housing leads the cycle");
      expect(surface).not.toContain("Several models agree credit spreads predict recessions");
    }
    expect(sourcesOf(html, "Contested: all 5 models that listed this claim mark it contested").every((s) => s === "computed")).toBe(true);
    expect(report.presentation!.panelAgreement).toContain("limited coverage on 1");
    expect(report.presentation!.panelAgreement).toContain("a single source only on 1");
  });
});

// ─── 11: quotes, nesting, line breaks, encodings ───

describe("R5-4: claim text with quotes is quoted safely on every format; the stored claim is unchanged", () => {
  const RAW = 'He said "rates fall" and “prices rise” — consensus: all 5 dispatched models support it\nand *more* <b>x</b> & so_on';

  it("quoteClaim: inner double quotes become single, line breaks spaces; the closing quote is always ours", () => {
    const q = quoteClaim(RAW);
    expect(q).toBe("“He said 'rates fall' and ‘prices rise’ — consensus: all 5 dispatched models support it and *more* <b>x</b> & so_on”");
    expect(q.slice(1, -1)).not.toMatch(/[“”"]/);
    expect(quoteClaim("It's ‘single’ quoted")).toBe("“It's ‘single’ quoted”");
    expect(quoteClaim('A "nested “deep” quote"')).toBe("“A 'nested ‘deep’ quote'”");
  });

  it("raw claim data, JSON, HTML, Markdown, DOCX and PDF: stored verbatim; displayed once-escaped and quoted", async () => {
    mockNarrative(null);
    const rows = [row(RAW, "majority", ["agrees", "agrees", "agrees", "agrees", "disputes"])];
    const report = await buildAdaptiveSynthesisReport("Q?", "generic", rows, results());
    expect(report.presentation!.agree[0].claim).toBe(RAW);
    expect(report.verdictCard.topConsensus).toBe(RAW);
    expect(JSON.parse(JSON.stringify(report)).presentation.agree[0].claim).toBe(RAW);

    const html = viewHtml(report, rows);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; so_on");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toContain("<b>x</b>");

    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    expect(md).toContain("\\*more\\* \\<b\\>x\\</b\\> & so\\_on”");

    const record = JSON.parse(JSON.stringify(pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard)!.record));
    record.reportSnapshot.legacy.synthesisReport = report;
    const { bytes } = await renderAdaptiveResearchDocxV1(record);
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(xml).toContain("Claim: “He said &apos;rates fall&apos; and ‘prices rise’");
    const pdf = extractPdfElementText(AdaptiveResearchDocument({ record } as any));
    expect(pdf).toContain(`Claim: ${quoteClaim(RAW)}\nPanel result: majority: 4 of 5 dispatched models support it, 1 disputes it`);
  });
});

// ─── 12, 13: Perplexity and other provider controls ───

describe("R5-3: naming a roster model keeps the narrative, its sentences and its layout", () => {
  const rows = () => [row("Rates fall within a year", "majority", ["agrees", "agrees", "agrees", "disputes", null])];

  it.each([
    ["perplexity (ID)", "perplexity"],
    ["Perplexity (family name)", "Perplexity"],
    ["Perplexity Pro (display name)", "Perplexity Pro"],
    ["chatgpt control", "chatgpt"],
    ["Claude control", "Claude"],
    ["grok control", "grok"],
    ["gemini control", "gemini"],
  ])("%s: one narrative call; paragraphs, list and the named sentence kept", async (_n, name) => {
    mockNarrative({
      executiveSummary: `Rates fall within a year.\n\n${name} weighs the trial evidence.\r\n- First point.\r\n- Second point.\n\nThe lag is uncertain.`,
      narrativeSections: [{ title: "Evidence", body: `One.\n\n${name} cites more trials. Two.` }],
    });
    const report = await buildAdaptiveSynthesisReport("Q?", "generic", rows(), results());
    expect(narrativeCalls).toBe(1);
    expect(report.executiveSummary).toBe(`Rates fall within a year.\n\n${name} weighs the trial evidence.\r\n- First point.\r\n- Second point.\n\nThe lag is uncertain.`);
    expect(report.narrativeSections).toEqual([{ title: "Evidence", body: `One.\n\n${name} cites more trials. Two.` }]);
  });

  it("a hallucinated name still forces one regenerate and is stripped — and the sanitize pass keeps paragraphs and lists", async () => {
    mockNarrative({
      executiveSummary: "Rates fall within a year.\n\nGemini 3 Pro weighs the trial evidence.\n- First point.\n- Second   point.\n\nThe lag is uncertain.",
    });
    const report = await buildAdaptiveSynthesisReport("Q?", "generic", rows(), results());
    expect(narrativeCalls).toBe(2);
    expect(report.executiveSummary).toBe("Rates fall within a year.\n\n- First point.\n- Second point.\n\nThe lag is uncertain.");
    expect(report.executiveSummary).not.toContain("Gemini 3 Pro");
  });
});

// ─── 14: historical records ───

describe("historical reports (no presentation field) render exactly as before", () => {
  function legacyReport(): AdaptiveSynthesisReport {
    return {
      unifiedAnswer: "Stored answer.",
      panelVerdict: "3/5 models converge on Stored claim; certainty 70%; gate: caution.",
      gate: "caution",
      runCertainty: 0.7,
      whereModelsAgree: ["Stored claim", "Stored claim"],
      whereModelsDisagree: ["Stored split"],
      certaintyAssessment: "Stored certainty.",
      narrativeSections: [{ title: "T", body: "Stored body." }],
      executiveSummary: "Stored summary one.\n\nStored summary two.",
      disagreements: [{ topic: "Stored split", positions: [], whyTheyDiffer: "Stored why.", stakes: "important" }],
      biasAndBlindSpots: [],
      biasEmptyReason: null,
      panelCoverageGaps: [],
      diagnostics: { totalClaimCount: 0, citedClaimCount: 0, evidenceMix: {} } as any,
      verdictCard: { question: "Q", topConsensus: "Stored claim", consensusModelCount: 3, keyDisagreement: "Stored split", disagreementDetail: null, disagreementModelCount: 2, caveat: null, recommendedNextSteps: [] },
      degraded: false,
    };
  }

  it("view: stored text, unlabelled, no attribution blocks; near-duplicate agree lines still merged", () => {
    const html = viewHtml(legacyReport(), []);
    expect(html).not.toContain("data-source");
    expect(html).not.toContain("Panel result");
    expect(html).not.toContain(MODEL_EXPLANATION_LABEL);
    expect(html).toContain("<h3 class=\"text-orange-900 font-semibold mb-2\">Stored split</h3>");
    expect(html).toContain("<p class=\"mt-2 text-sm text-slate-600\">Stored certainty.</p>");
    expect(html.split("<li>Stored claim</li>").length - 1).toBe(1);
  });

  it("share builders: the original format", () => {
    const sh = shares(legacyReport());
    expect(sh.markdown).toContain("## Executive Summary\nStored summary one.\n\nStored summary two.\n");
    expect(sh.markdown).toContain("- **Stored split** — Stored why.");
    expect(sh.markdown).toContain("70% (gate: caution) — Stored certainty.");
    expect(sh.memo.synthesisDisagreements).toEqual(["Stored split: Stored why."]);
    expect(sh.memo.confidenceAssessment).toBe("Stored summary one.\n\nStored summary two.");
    expect(sh.linkedin).toContain("→ Stored split");
    expect(sh.x).toContain("Models split on: Stored split");
  });
});
