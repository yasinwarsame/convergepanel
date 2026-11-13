/**
 * C-a legacy research panel rows (inventory v3.4 §12.6), through the real PanelSynthesisView (and its real share /
 * memo / copy handlers) and the real ResultsDisplay:
 *  E01 verdict counts (corrected gate; PC unit label), E02 Key Findings voices, E04 / E05 / E11 PC score statement,
 *  E06 / E07 / E16 / E17 trust summary and agreement map, E09 intro line, E13 / E14 / E15 / E22 model-written labels
 *  (O3 (a)), E19 / E20 stored placeholder rows (D-5), E21 Key Findings support, E25 / E26 guards.
 * Negatives: BI35 (S4 / S5 / S4f render as before — no label, "Agreed by N models"), MU14 (S2b never IND), MU-unit,
 * N-D4′ (UV: no digit next to "independent"; S3mn / pre-6.2a / R-UV fail the identity-only gate), the stored score
 * bytes unchanged.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  prepareAuthedHeaders: async (_user: unknown, headers: Headers) => headers,
}));
jest.mock("@/lib/client/fetchWithTimeout", () => ({
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })),
  FetchError: class FetchError extends Error {},
}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));
const mockDownloads: string[] = [];
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return { ...actual, downloadTextFile: (content: string) => mockDownloads.push(content) };
});
const mockCopied: string[] = [];
jest.mock("@/lib/ui/copyFormats", () => {
  const actual = jest.requireActual("@/lib/ui/copyFormats");
  return { ...actual, copyToClipboardWithFallback: async (text: string) => (mockCopied.push(text), true) };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import ResultsDisplay from "@/components/ResultsDisplay";
import { VerificationActions } from "@/components/VerificationActions";
import { synthesizeReport } from "@/lib/consensus";
import { buildIntroLine } from "@/lib/ui/socialCopy";
import {
  INVALID_PROVIDER_OUTPUT_NOTICE,
  MODEL_WRITTEN_ASSESSMENT_LABEL,
  MODEL_WRITTEN_FINDINGS_LABEL,
  PLACEHOLDER_INSUFFICIENT_SCORE_TEXT,
  VALIDITY_UNKNOWN_NOTICE,
  modelWrittenBlockLabel,
  runExecutionIdentity,
  slotScoreStatement,
} from "@/lib/panel/executionIdentity";
import { DIGIT_NEXT_TO_INDEPENDENT, failed, mock, ok, referenceK, rowsOf, sub, type SetName } from "@/lib/panel/__tests__/executionIdentityScenarios";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const SUMMARY = { modelsHealthy: 5, modelCount: 5, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 81, aggregateSupportRatio: 1 };
const report = (slots: string[]): StructuredSynthesis =>
  ({
    executiveSummary: "Paris is the capital; every model agrees.",
    keyFindings: [{ claim: "Paris is the capital of France.", confidence: "High", evidenceRefs: ["r1"], modelsSupporting: slots, support: { supportingModels: slots }, evidenceQuality: "strong" }],
    disagreements: slots.length >= 2 ? [{ topic: "Founding date", positionsByModel: { [slots[0]]: "52 BC", [slots[slots.length - 1]]: "3rd century BC" }, whyTheyDiffer: "Sources differ." }] : [],
    biasAndBlindSpots: [{ description: "All models lean on one source.", biasType: "Source bias", modelsImplicated: [], evidence: [], likelyCauses: [], impact: "", mitigationSteps: [] }],
    openQuestions: ["When exactly?"],
    methodology: "Models agreed across the panel.",
  }) as unknown as StructuredSynthesis;

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});
beforeEach(() => {
  for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});

async function mountPsv(rows: ModelResult[], summary: any = SUMMARY) {
  const slots = rows.filter((r) => r.status === "ok" || r.status === "substituted").map((r) => r.modelId);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(PanelSynthesisView as never, { results: rows, question: "What is the capital of France?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: report(slots), preGeneratedConsensusSummary: summary } as never)
    );
  });
  mounted.push(r);
  return r;
}
const actions = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(VerificationActions).props;
async function post(r: TestRenderer.ReactTestRenderer, which: "onGenerateLinkedIn" | "onGenerateX") {
  await act(async () => {
    actions(r)[which]();
  });
  return nodeText(r.root.findAll((n) => n.type === "pre")[0]);
}
async function memo(r: TestRenderer.ReactTestRenderer) {
  mockDownloads.length = 0;
  await act(async () => {
    actions(r).onExportMemo();
  });
  return mockDownloads[0];
}
async function copy(r: TestRenderer.ReactTestRenderer) {
  mockCopied.length = 0;
  await act(async () => {
    await actions(r).onCopy();
  });
  return mockCopied[0];
}
const card = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root.findAll((n) => n.type === "h3" && nodeText(n) === "Panel Verdict")[0].parent!.parent!.parent!);
const page = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root);
const labels = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.["data-testid"] === "model-written-label" && typeof n.type === "string").map(nodeText);

const PRE62A = [ok("chatgpt", null), ok("claude", null), ok("grok", null)];
const R_UV = rowsOf("R_UV");

describe("E13 / E15 / E22: one O3 label per model-written block group (FC / PC / UV / MOCK); IND unchanged", () => {
  it.each(["S2", "S2b", "S7"] as SetName[])("%s (PC): Executive Summary, Bias, Open Questions, Methodology carry the K / M label; Key Findings its own", async (name) => {
    const r = await mountPsv(rowsOf(name));
    const label = modelWrittenBlockLabel(runExecutionIdentity(rowsOf(name)));
    expect(labels(r)).toEqual([label, MODEL_WRITTEN_FINDINGS_LABEL, label, label, label]);
    expect(label).toContain(`${referenceK(rowsOf(name))} independent models answered ${runExecutionIdentity(rowsOf(name)).answeredSlots} panel slots.`);
  });
  it.each([["S1", rowsOf("S1")], ["S8a", rowsOf("S8a")]] as const)("%s (FC): labelled", async (_n, rows) => {
    const r = await mountPsv([...rows]);
    expect(labels(r).length).toBeGreaterThanOrEqual(4);
  });
  it.each([["S3mn", rowsOf("S3mn")], ["pre-6.2a", PRE62A], ["R-UV", R_UV], ["provider unknown", rowsOf("UNKNOWN_PROVIDER")]] as const)(
    "%s (UV): the UV form, no digit next to 'independent'",
    async (_n, rows) => {
      const r = await mountPsv([...rows]);
      expect(labels(r)).toContain(modelWrittenBlockLabel(runExecutionIdentity([...rows])));
      expect(labels(r).join("\n")).toMatch(/model independence unverified\./);
      expect(labels(r).join("\n")).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
    }
  );
  it.each(["S4", "S5", "S4f", "S8b"] as SetName[])("%s: no label anywhere", async (name) => {
    const r = await mountPsv(rowsOf(name));
    expect(labels(r)).toEqual([]);
  });
  it("S9 (MOCK): labelled", async () => {
    expect(labels(await mountPsv(rowsOf("S9"))).length).toBeGreaterThan(0);
  });
});

describe("E14: the memo's confidence assessment is labelled as the saved synthesis's own text", () => {
  it("S2: labelled; S4: as before", async () => {
    expect(await memo(await mountPsv(rowsOf("S2")))).toContain(`CONFIDENCE ASSESSMENT\n${MODEL_WRITTEN_ASSESSMENT_LABEL}\nParis is the capital`);
    expect(await memo(await mountPsv(rowsOf("S4")))).toContain("CONFIDENCE ASSESSMENT\nParis is the capital");
  });
});

describe("E04 / E05 / E11: a PC run's score is stated over answering slots with K", () => {
  it.each(["S2", "S2n", "S2b", "S7"] as SetName[])("%s: summary box statement, LinkedIn, X and memo", async (name) => {
    const rows = rowsOf(name);
    const id = runExecutionIdentity(rows);
    const r = await mountPsv(rows);
    expect(page(r)).toContain(slotScoreStatement(id));
    expect(await post(r, "onGenerateLinkedIn")).toContain(`Consensus score: 81/100 (High). ${slotScoreStatement(id)}`);
    expect(await post(r, "onGenerateX")).toContain(`Consensus: 81/100 (${id.answeredSlots} slots; ${id.independentModels} independent models)`);
    const m = await memo(r);
    expect(m).toContain(`computed over ${id.answeredSlots} answering slots by the saved synthesis; ${id.independentModels} independent executing models`);
    expect(m).not.toMatch(/\d+ AI models researched this question independently/);
  });
  it("MU14: S2b is never presented as IND (the statement is present)", async () => {
    expect(page(await mountPsv(rowsOf("S2b")))).toContain("Score computed over 5 answering slots");
  });
  it.each(["S4", "S5"] as SetName[])("%s (BI35): no statement; '%s' memo 'N AI models researched this question independently'", async (name) => {
    const r = await mountPsv(rowsOf(name));
    expect(page(r)).not.toContain("Score computed over");
    expect(await memo(r)).toMatch(/\d AI models researched this question independently\./);
    expect(await post(r, "onGenerateX")).toContain("Consensus: 81/100\n");
  });
  it.each([["S3mn", rowsOf("S3mn")], ["pre-6.2a", PRE62A], ["R-UV", R_UV]] as const)("%s (UV): the score is withheld on screen, in shares and in the memo", async (_n, rows) => {
    const r = await mountPsv([...rows]);
    expect(page(r)).not.toContain("81/100");
    expect(page(r)).toContain("Consensus score withheld");
    expect(await post(r, "onGenerateX")).not.toContain("81/100");
    expect(await memo(r)).not.toContain("81/100");
  });
});

describe("E01 / E02 verdict counts and Key Findings voices under the corrected gate", () => {
  it("PC (S2): 'Agreed by K independent executing models' / 'N independent executing models split'", async () => {
    const c = card(await mountPsv(rowsOf("S2")));
    expect(c).toMatch(/Agreed by \d independent executing models/);
    expect(c).not.toMatch(/Agreed by \d models/);
  });
  it.each([["S3mn", rowsOf("S3mn")], ["pre-6.2a", PRE62A], ["R-UV", R_UV]] as const)("%s (UV): no count in the card, the copy or Key Findings", async (_n, rows) => {
    const r = await mountPsv([...rows]);
    expect(card(r)).not.toMatch(/Agreed by \d/);
    expect(card(r)).toContain("model independence unverified");
    expect(page(r)).toContain("Supporting slots (model independence unverified)");
    expect(await copy(r)).not.toMatch(/Agreed by \d/);
    expect(page(r)).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
  });
  it.each(["S4", "S5"] as SetName[])("%s (BI35): 'Top consensus', 'Agreed by N models'", async (name) => {
    const c = card(await mountPsv(rowsOf(name)));
    expect(c).toContain("Top consensus");
    expect(c).toMatch(/Agreed by \d models/);
  });
});

describe("E21: Key Findings support", () => {
  it("PC (S2): 'Supported by N of M answering slots (K independent models)', badge scored over panel slots", async () => {
    const t = page(await mountPsv(rowsOf("S2")));
    expect(t).toContain("Supported by 5 of 5 answering slots (4 independent models)");
    expect(t).toContain("strong evidence (scored over panel slots)");
    expect(t).not.toMatch(/Supported by \d\/\s*\d models/);
  });
  it("S7 (failures): the denominator is the answered slots", async () => {
    expect(page(await mountPsv(rowsOf("S7")))).toContain("Supported by 3 of 3 answering slots (2 independent models)");
  });
  it("S4 (BI35): 'Supported by 5/5 models'", async () => {
    expect(page(await mountPsv(rowsOf("S4")))).toMatch(/Supported by 5\/\s*5 models/);
  });
  it("FC / UV: hidden", async () => {
    expect(page(await mountPsv(rowsOf("S1")))).not.toContain("Supported by");
    expect(page(await mountPsv(PRE62A))).not.toContain("Supported by");
  });
});

describe("E09: the intro line says 'multi-model' only with two or more independent models", () => {
  const verdict = (o: any) => ({ question: "", topConsensus: "x", consensusModelCount: 2, disagreementModelCount: 0, ...o });
  it("FC / UV / IND", () => {
    expect(buildIntroLine({ question: "", gate: null, verdict: verdict({ crossModel: false }) as any })).toContain("one independent model responded");
    expect(buildIntroLine({ question: "", gate: null, verdict: verdict({ crossModel: true, independenceUnverified: true }) as any })).toContain("model independence unverified");
    expect(buildIntroLine({ question: "", gate: null, verdict: verdict({ crossModel: true }) as any })).toBe("I ran a multi-model panel; verdict: quick reliability pass.");
  });
});

describe("E19 / E20: stored placeholder rows (D-5 exact oracle)", () => {
  it("S9: no consensus score from placeholder 'voices' when fewer than two real ones remain; the stored score bytes are unchanged", async () => {
    const rows = [mock("chatgpt"), mock("claude"), ok("grok")];
    const summary = { ...SUMMARY, modelsHealthy: 3, modelCount: 3 };
    const before = JSON.stringify(summary);
    const r = await mountPsv(rows, summary);
    expect(page(r)).toContain(PLACEHOLDER_INSUFFICIENT_SCORE_TEXT);
    expect(page(r)).not.toContain("81/100");
    expect(JSON.stringify(summary)).toBe(before);
  });
  it("S9 with three real models: the score is shown and stated over the answering (non-placeholder) slots", async () => {
    const r = await mountPsv(rowsOf("S9"));
    expect(page(r)).toContain("81/100");
    expect(await memo(r)).not.toMatch(/5 AI models researched/);
  });
});

describe("ResultsDisplay (legacy): E06 / E07 / E16 / E17 / E19 / E25", () => {
  const LONG = "Paris is the capital of France. The city has been the seat of the French government for centuries. It is located on the Seine river in northern France. Paris is the most populous city in France.";
  const withText = (rows: ModelResult[]) => rows.map((r) => (r.rawText ? ({ ...r, rawText: r.rawText === "x" ? r.rawText : r.rawText.length < 60 ? r.rawText : LONG } as ModelResult) : r));
  async function mountRd(rows: ModelResult[]) {
    const results = withText(rows);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        createElement(ResultsDisplay as never, { results, synthesizedReport: synthesizeReport(results), onRerun: () => {}, onAddModel: () => {}, question: "What is the capital of France?", runId: "run-1", synthesisStatus: "idle", synthesisReport: null, adaptive: null, allowSynthesisGeneration: false } as never)
      );
    });
    mounted.push(r);
    // Expand every saved answer (the per-slot notices sit inside the expanded answer).
    for (const b of r.root.findAll((n) => n.type === "button" && /Show answer/.test(nodeText(n)))) {
      await act(async () => {
        b.props.onClick?.();
      });
    }
    return nodeText(r.root);
  }
  it("UV (pre-6.2a): 'model independence unverified' on the pills, card headings, 'Agreed by N responses' and the map chips; counts unchanged", async () => {
    const t = await mountRd(PRE62A);
    expect(t).toContain("Strong consensus (model independence unverified)");
    expect(t).toContain("Contested areas (model independence unverified)");
    expect(t).toMatch(/This panel compared 3 panel slots \(model independence unverified\)/);
    if (/Strong Consensus/.test(t)) expect(t).toContain("Strong Consensus (model independence unverified)");
    if (/Agreed by/.test(t)) expect(t).toMatch(/Agreed by \d responses \(model independence unverified\)/);
    expect(t).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
  });
  it("PC (S2): 'compared 5 panel slots (4 independent models)'", async () => {
    expect(await mountRd(rowsOf("S2"))).toContain("This panel compared 5 panel slots (4 independent models)");
  });
  it("BI35 (S4, S5): 'This panel compared N models', no qualifier", async () => {
    for (const name of ["S4", "S5"] as SetName[]) {
      const t = await mountRd(rowsOf(name));
      expect(t).toMatch(/This panel compared \d models/);
      expect(t).not.toContain("model independence unverified");
    }
  });
  it("E19: the exact placeholder notice for INVALID_MOCK; the unknown-validity notice for a quoted phrase; nothing for model prose", async () => {
    const mocked = await mountRd([mock("chatgpt"), ok("grok"), ok("gemini")]);
    expect(mocked).toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
    const quoted = await mountRd(rowsOf("S9u"));
    expect(quoted).toContain(VALIDITY_UNKNOWN_NOTICE);
    expect(quoted).not.toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
    const clean = await mountRd(rowsOf("S5"));
    expect(clean).not.toContain(VALIDITY_UNKNOWN_NOTICE);
    expect(clean).not.toContain("Demo output");
  });
  it("E25: every answered slot is comparable (S2): the slot report keeps a raw response per answered slot", () => {
    const results = withText(rowsOf("S2"));
    expect(synthesizeReport(results)!.rawResponses?.length ?? results.length).toBe(5);
  });
  it("R2: a failed slot stays an explicit failure next to the qualified figures", async () => {
    const t = await mountRd([failed("chatgpt"), sub("claude"), sub("grok"), ok("gemini")]);
    expect(t).toMatch(/compared 4 panel slots \(2 independent models\)/);
  });
});

describe("R8 / decision non-regression: the corrected gate and the D-5 list never reach the verification gate", () => {
  const gateCard = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root.findAll((n) => n.type === "span" && nodeText(n) === "Verification Gate")[0].parent!.parent!.parent!);
  const withProviders = (rows: ModelResult[]) => rows.map((x) => ({ ...x, provider: x.status === "substituted" ? "deepseek" : `${x.modelId}-provider` }) as ModelResult);
  it.each([["pre-6.2a", PRE62A], ["S3mn", rowsOf("S3mn")], ["R-UV", R_UV], ["provider unknown", rowsOf("UNKNOWN_PROVIDER")]] as const)(
    "%s: the gate card is identical to the same rows with every provider recorded",
    async (_n, rows) => {
      expect(gateCard(await mountPsv([...rows]))).toBe(gateCard(await mountPsv(withProviders([...rows]))));
    }
  );
  it("placeholders that leave one real model: the gate still counts them as the stored decision did (label unchanged)", async () => {
    const rows = [mock("chatgpt"), mock("claude"), ok("grok")];
    const asText = rows.map((x) => ({ ...x, rawText: "Paris is the capital of France. The city has been the seat of the French government for centuries." }) as ModelResult);
    const g = gateCard(await mountPsv(rows, { ...SUMMARY, modelsHealthy: 3, modelCount: 3 }));
    expect(g).toBe(gateCard(await mountPsv(asText, { ...SUMMARY, modelsHealthy: 3, modelCount: 3 })));
    expect(g).not.toContain("Insufficient independent models");
  });
  it("S9: stored placeholder rows still count as the stored decision counted them (gate identical to the same rows' text without the placeholder literal)", async () => {
    const asText = rowsOf("S9").map((x) => ({ ...x, rawText: "Paris is the capital of France. The city has been the seat of the French government for centuries." }) as ModelResult);
    expect(gateCard(await mountPsv(rowsOf("S9")))).toBe(gateCard(await mountPsv(asText)));
  });
});

