/**
 * Order 5 Contract P — marked records through every consumer. Each shared scenario is built by TODAY's pipeline (so its
 * report carries presentation.disagreementPositionVersion = 1 wherever eligible) with every model call mocked, then
 * rendered through every supported consumer (report view, Answer strip, list view, panel evidence, claim matrix,
 * governance body, Markdown, LinkedIn, X, memo, JSON, PDF tree, DOCX document.xml).
 *
 * The mocks seed model-written prose that attributes positions to models ("ChatGPT and Claude split on jobs"), a
 * computed default explanation, a bias caveat and coverage notes: none of it may reach any marked output (M6, M-2,
 * M-8). Vote / split / consensus wording may not describe a field row (M-7); no stored "split:" result survives
 * (M-1); the scalar normalizer is the shipped one (M-4); no median or tolerance basis is stated (M-5); the memo takes
 * the adaptive-only path (M-3); the primary answer, the computed gate and the raw JSON stay (O5-R14-2).
 */
process.env.TZ = "UTC";

jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { isPositionMarked } from "@/lib/adaptiveSchema/positionPresentation";
import { CLASSIFICATION_BASE, DEFAULT_MODE, SCENARIOS, Scenario, geminiMockImpl } from "./o5pScenarios";
import { renderRecord, RecordUnderTest } from "./o5pRender";

const gem = callGemini as unknown as jest.Mock;

async function build(s: Scenario): Promise<{ record: RecordUnderTest; input: any[] }> {
  gem.mockReset();
  gem.mockImplementation(geminiMockImpl({ ...DEFAULT_MODE, ...(s.mode ?? {}) }));
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  for (const r of s.retry ?? []) connectorMap[r.modelId] = jest.fn(async () => ({ modelId: r.modelId, status: "ok", rawText: JSON.stringify(r.data), latencyMs: 5 }));
  const input = s.results();
  const retryContext = s.retry ? { apiKeys: {}, promptOverrides: Object.fromEntries(input.map((r) => [r.modelId, "BASE PROMPT"])), context: null, budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, usageSink: new AdaptiveRetryUsageSink(), now: () => 1_000 } : undefined;
  const classification = { ...CLASSIFICATION_BASE, queryType: s.schemaId, answerShape: getResultSchema(s.schemaId as any).renderHint } as any;
  const r: any = await finalizeAdaptiveRun(getResultSchema(s.schemaId as any), input, "Does raising the minimum wage reduce employment?", retryContext as any, classification);
  const record = r.persistedLegacyOutput
    ? JSON.parse(JSON.stringify({ ...r.persistedLegacyOutput, generatedAt: undefined }))
    : { schemaId: r.schemaId, classification, results: r.adaptiveResults, alignedClaims: r.alignedClaims, gate: r.gate, synthesisReport: r.synthesisReport, trustSummary: r.trustSummary };
  return { record, input };
}

/** Model-written prose the mocks seed (narrative, explanations, bias, coverage) and the computed default explanation. */
const SEEDED_PROSE = [
  "ChatGPT stresses jobs",
  "Grok relies on older",
  "Claude weighs costs",
  "Perplexity cites newer",
  "Experts are divided",
  "Tariffs have mixed effects",
  "opposite positions on rates",
  "ignored it entirely",
  "relies on 2024 data",
  "Ask Claude to reconcile",
  "Grok disputes this reading",
  "rates will fall sharply",
  "Labor market effects",
  "How do the models compare on jobs",
  "recency bias",
  "Models take different positions",
  "Flag the caveat below",
];

/** Stored or fixed wording that characterizes the panel's positions without the rows' support. */
const PANEL_CHARACTERIZATION = [
  /\bsplit: \d+ of \d+/,
  /\ba split on \d/,
  /Models split on/,
  /models converge on/,
  /Where models (agree|disagree)/i,
  /WHERE MODELS (AGREE|DISAGREE)/,
  /diverging themes|converged on several themes|meaningful convergence/,
  /No major disagreements detected/,
  /Key disagreement/,
  /agreed by \d+ model/,
  /\b\d+ of \d+ agree\b/,
  /Split claims/,
  /The disagreements tell you more/,
  /CONSENSUS SCORE/,
  /Models agree<|Models disagree</,
  /Agreement \/ disagreement map/,
];

/** Model-written explanation surfaces on the marked path: withheld, never shown as a block. */
const PROSE_LABELS = [/Model-written explanation \(not a verified finding\)/, /Model-flagged \(bias check, not a verified finding\)/, /What the panel didn&#x27;t cover|What the panel didn't cover/];

const MARKED = SCENARIOS.filter((s) => !["generic-all-failed", "creative", "graceful-limitation"].includes(s.name));

describe("marked records: every consumer", () => {
  it("each eligible scenario's report is marked; the no-row scenarios are not", async () => {
    for (const s of SCENARIOS) {
      const { record } = await build(s);
      expect([s.name, isPositionMarked(record.synthesisReport)]).toEqual([s.name, MARKED.includes(s)]);
    }
  });

  it.each(MARKED.map((s) => s.name))("%s: no model prose, no unsupported panel characterization, primary answer and gate kept", async (name) => {
    const s = SCENARIOS.find((x) => x.name === name)!;
    const { record, input } = await build(s);
    const out = await renderRecord(record, input);
    for (const [consumer, text] of Object.entries(out)) {
      if (text === null || consumer === "export.json") continue;
      for (const prose of SEEDED_PROSE) expect([consumer, prose, text.includes(prose)]).toEqual([consumer, prose, false]);
      for (const re of PANEL_CHARACTERIZATION) expect([consumer, String(re), re.test(text)]).toEqual([consumer, String(re), false]);
      for (const re of PROSE_LABELS) expect([consumer, String(re), re.test(text)]).toEqual([consumer, String(re), false]);
      expect([consumer, /median|tolerance band|within tolerance/i.test(text)]).toEqual([consumer, false]);
    }
    // The computed gate is unchanged and still stated wherever it was.
    const gateWord = { pass: "Pass", caution: "Caution", fail: "Fail" }[record.synthesisReport.gate as "pass" | "caution" | "fail"];
    expect(out["ui.synthesisView"]).toContain(`Verification gate: ${gateWord}`);
    // The primary answer survives: every Unified Answer claim is still shown in the report view.
    for (const c of record.synthesisReport.presentation.answer.claims) expect(out["ui.synthesisView"]).toContain(c.claim.replace(/"/g, "'").replace(/&/g, "&amp;").slice(0, 20));
    // The memo takes the adaptive-only path (M-3).
    expect(out["text.memo"]).toContain("PANEL SLOTS (AS RECORDED)");
    expect(out["text.memo"]).toContain("RUN CERTAINTY:");
    // JSON stays raw: the stored report, marker included, byte-for-byte as persisted (never the view).
    if (out["export.json"]) {
      const exported = JSON.parse(out["export.json"]).result.synthesisReport;
      expect(exported).toEqual(JSON.parse(JSON.stringify(record.synthesisReport)));
      expect(exported.presentation.disagreementPositionVersion).toBe(1);
    }
  });
});

describe("negative control: the same checks find the problems on the unmarked (historical) rendering", () => {
  it.each(["generic-mixed", "procedural", "generic-mixed-narrative-mismatch", "financial-valuation"])("%s with the marker removed shows seeded prose and panel characterization", async (name) => {
    const s = SCENARIOS.find((x) => x.name === name)!;
    const { record, input } = await build(s);
    delete record.synthesisReport.presentation.disagreementPositionVersion;
    const out = await renderRecord(record, input);
    const all = Object.entries(out).filter(([k, v]) => v && k !== "export.json").map(([, v]) => v as string).join("\n");
    const prose = SEEDED_PROSE.filter((p) => all.includes(p));
    const characterization = PANEL_CHARACTERIZATION.filter((re) => re.test(all)).map(String);
    expect(prose.length).toBeGreaterThan(0);
    expect(characterization.length).toBeGreaterThan(0);
    // M-7 as the reviewer found it: the field row's stored consensus named as support by slots that gave a different step.
    if (name === "procedural") {
      expect(characterization).toEqual(expect.arrayContaining(["/Where models (agree|disagree)/i"]));
      expect(all).toMatch(/Supported by:? ChatGPT, Claude, Grok, Perplexity/);
      expect(all).toMatch(/consensus: 4 of 4 dispatched models support it|consensus: all 4 dispatched models support it/);
    }
    if (name === "generic-mixed-narrative-mismatch") expect(prose).toContain("Models take different positions");
    if (name === "financial-valuation") expect(all).toMatch(/\bsplit: \d/);
  });
});

describe("finding-specific marked outputs", () => {
  const outputs = async (name: string) => {
    const s = SCENARIOS.find((x) => x.name === name)!;
    const { record, input } = await build(s);
    return { record, out: await renderRecord(record, input) };
  };

  it("M-1: the stored 'split' results and panel statement are restated from rows on every text surface", async () => {
    const { record, out } = await outputs("generic-mixed");
    expect(record.synthesisReport.presentation.panelAgreement).toMatch(/a split on 3/);
    for (const k of ["ui.synthesisView", "ui.primaryStrip", "text.markdown", "text.memo", "text.linkedin", "text.x"]) {
      expect(out[k]).not.toMatch(/a split on|split: \d/);
    }
    expect(out["ui.synthesisView"]).toContain("recorded opposing positions on 1 claim");
    expect(out["ui.synthesisView"]).toContain("unresolved positions on 2 claims");
  });

  it("M-1 (fail record with model prose withheld): the Unified Answer's unresolved claims carry kind wording, not 'split: 0 of 5 … 5 dispute it'", async () => {
    const { record, out } = await outputs("legal-regulatory");
    expect(record.synthesisReport.gate).toBe("fail");
    expect(out["ui.synthesisView"]).toContain("Unresolved claims");
    expect(out["export.docxXml"]).not.toMatch(/split: \d/);
    expect(out["export.pdfTree"]).not.toMatch(/split: \d/);
  });

  it("M-2: the computed default explanation never shows on a marked record (narrative length mismatch)", async () => {
    const { record, out } = await outputs("generic-mixed-narrative-mismatch");
    expect(record.synthesisReport.disagreements.some((d: any) => d.whyTheyDiffer.startsWith("Models take different positions"))).toBe(true);
    // Every consumer except the JSON export, which keeps the stored report verbatim by contract.
    for (const [k, v] of Object.entries(out)) if (v && k !== "export.json") expect([k, v.includes("Models take different positions")]).toEqual([k, false]);
  });

  it("M6 / M-8: a pass/caution record with model prose shows one disclosure and withholding notices instead", async () => {
    const { record, out } = await outputs("generic-mixed");
    expect(record.synthesisReport.presentation.executiveSummarySource).toBe("model_explanation");
    expect(out["ui.synthesisView"]).toContain("Model-written explanation is not shown for this report");
    expect(out["ui.synthesisView"]).toContain("1 model-flagged bias observation not shown");
    expect(out["ui.synthesisView"]).toContain("1 model-written coverage note not shown");
    expect(out["text.markdown"]).toContain("Model-written explanation is not shown for this report");
    expect(out["ui.synthesisView"]).not.toContain("does not change the verification gate");
  });

  it("M-3: the research memo states positions by recorded panel slot from the rows", async () => {
    const { out } = await outputs("generic-substituted-and-failed");
    expect(out["text.memo"]).toContain("UNRESOLVED CLAIMS AND VALUE DIFFERENCES");
    expect(out["text.memo"]).toContain("Positions by panel slot (as recorded):");
    expect(out["text.memo"]).toContain("Claude slot (substituted; answered by DeepSeek)");
  });

  it("M-4: 'St. Louis' and 'St Louis' are the same answer", async () => {
    const { out } = await outputs("factual-normalizer");
    expect(out["ui.synthesisView"]).toContain("St Louis — same answer as 2 other panel slots");
    expect(out["ui.synthesisView"]).not.toMatch(/St Louis — answer given by no other panel slot/);
  });

  it("M-5: metric rows state the values, never a median or tolerance basis", async () => {
    const { out } = await outputs("financial-valuation");
    expect(out["ui.synthesisView"]).toMatch(/Values differ: \d+ numeric values, \d+ distinct, from/);
    expect(out["ui.synthesisView"]).toContain("Not compared: the values use different units");
    expect(out["ui.synthesisView"]).not.toMatch(/median|tolerance/i);
  });

  it("M-6 / M-7: consensus claim rows are consensus; field rows (stored consensus) are wording comparisons with no supporters", async () => {
    const { out } = await outputs("procedural");
    const view = out["ui.synthesisView"]!;
    expect(view).toContain("Top value comparison");
    expect(view).not.toContain("Top consensus");
    expect(view).toMatch(/2 different wordings at this position among 4 panel slots/);
    expect(view).not.toMatch(/Supported by[^<]*Grok/);
    expect(out["text.markdown"]).not.toMatch(/Supported by/);
    expect(out["text.memo"]).not.toMatch(/\bconverg(e|ed|es|ing|ence)\b|diverg/i);
    const mixed = await outputs("generic-mixed");
    expect(mixed.out["ui.synthesisView"]).toMatch(/Consensus<\/span>/);
    expect(mixed.out["ui.synthesisView"]).not.toMatch(/Unresolved claim<\/span> — consensus/);
  });

  it("M5: substituted slots are named with their recorded substitution; compact formats name no slot", async () => {
    const { out } = await outputs("generic-substituted-and-failed");
    expect(out["ui.synthesisView"]).toContain("Claude slot (substituted; answered by DeepSeek)");
    expect(out["ui.panelResponse.noProvenance"]).not.toContain("answered by DeepSeek");
    for (const k of ["text.linkedin", "text.x"]) expect(out[k]).not.toMatch(/ChatGPT|Claude|Grok|Perplexity|Gemini/);
    expect(out["export.pdfTree"]).toContain("Claude slot (substituted; answered by DeepSeek)");
  });

  it("exports: PDF and DOCX use the marked headings and keep the Unified Answer", async () => {
    const { record, out } = await outputs("contested-empirical");
    expect(out["export.pdfTree"]).toContain("Top claim and key unresolved claim");
    expect(out["export.docxXml"]).toContain("Top claim and key unresolved claim");
    expect(out["export.pdfTree"]).not.toContain("Where models agree / disagree");
    for (const c of record.synthesisReport.presentation.answer.claims) expect(out["export.docxXml"]).toContain(c.claim.slice(0, 15));
  });
});
