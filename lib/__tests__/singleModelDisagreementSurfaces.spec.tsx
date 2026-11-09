/**
 * Executing-model independence on the surfaces the fresh review of 0d4f6c9 found (MINOR-2 + NITs):
 *  - the Verification Gate (PSV gate card, copied markdown) never reports "Contested claims detected" / "Extract the top
 *    contested claims…" below two independent models — single-model uncertainty is kept under its own label;
 *  - the research memo METHODOLOGY and the LinkedIn / X taglines claim no consensus / convergence with one model;
 *  - an unrecorded substitute merges with a recorded one (never an extra independent voice);
 *  - the stored-disagreement classifier: DeepSeek×2, one independent, two independent, DeepSeek×2 + Grok, missing provenance.
 * Real components (react-test-renderer) and real builders; only I/O is mocked.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) }));
jest.mock("@/lib/client/fetchWithTimeout", () => ({
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })),
  FetchError: class FetchError extends Error {},
}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));
const mockDownloads: Array<[string, string]> = [];
const mockMemoInputs: any[] = [];
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return {
    ...actual,
    downloadTextFile: (content: string, name: string) => mockDownloads.push([content, name]),
    generateVerificationMemo: (input: any) => (mockMemoInputs.push(input), actual.generateVerificationMemo(input)),
  };
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
import { VerificationActions } from "@/components/VerificationActions";
import { buildPanelVerdict, SINGLE_MODEL_SHARE_TAGLINE } from "@/lib/verificationGate/panelVerdict";
import {
  computeVerificationGate,
  NON_INDEPENDENT_DISAGREEMENTS_REASON,
  SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON,
  SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP,
} from "@/lib/verificationGate/verificationGate";
import { buildLinkedInPost } from "@/lib/ui/socialCopy";
import { generateVerificationMemo, RESEARCH_MEMO_SINGLE_MODEL_METHODOLOGY } from "@/lib/verification/generateMemo";
import { independentVoices, meetsIndependentSynthesisMinimum } from "@/lib/panel/independentVoices";
import { groupSlotsByExecutingVoice, independentVoiceCount } from "@/lib/panel/executingVoiceLabel";
import { classifyStoredDisagreement, storedRunIndependenceContext } from "@/lib/panel/storedDisagreementIndependence";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";
// C-a (corrected D-4 gate): a 6.2a+ ok row records its runtime provider; a provider-less ok row is a pre-6.2a row (UV).
const ok = (modelId: string) => ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5, provider: `${modelId}-provider` }) as ModelResult;
const sub = (modelId: string, provider: string | undefined = "deepseek") =>
  ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, ...(provider ? { provider } : {}) }) as ModelResult;
const TWO_SUBS = [sub("chatgpt"), sub("claude")];
const DISTINCT_REAL = [ok("chatgpt"), ok("claude"), ok("grok")];
const SUMMARY = { modelsHealthy: 2, modelCount: 2, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

/** A legacy run: two findings marked "Mixed" (the case seen in production), plus a stored trustSummary-free report. */
const mixedReport = (slots: string[]): StructuredSynthesis =>
  ({
    executiveSummary: "Founding date is uncertain.",
    keyFindings: [
      { claim: "The company was founded in 1789.", confidence: "Mixed", evidenceRefs: [], modelsSupporting: [slots[0]] },
      { claim: "The founder was a merchant.", confidence: "Mixed", evidenceRefs: [], modelsSupporting: [slots[0]] },
    ],
    disagreements: [{ topic: "Founding date", positionsByModel: Object.fromEntries(slots.map((m, i) => [m, `${1789 + 3 * i}`])), whyTheyDiffer: "Sources differ." }],
    biasAndBlindSpots: [],
    openQuestions: [],
    methodology: "Cross-model comparison.",
  }) as unknown as StructuredSynthesis;

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function mountSynthesis(results: ModelResult[], rep: StructuredSynthesis) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(PanelSynthesisView as never, { results, question: "When was the company founded and by whom?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: rep, preGeneratedConsensusSummary: SUMMARY } as never)
    );
  });
  mounted.push(r);
  return r;
}
const actions = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(VerificationActions).props;
async function copied(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockCopied.length = 0;
  await act(async () => {
    await actions(r).onCopy();
  });
  return mockCopied[0];
}
async function generatedPost(r: TestRenderer.ReactTestRenderer, which: "onGenerateLinkedIn" | "onGenerateX"): Promise<string> {
  await act(async () => {
    actions(r)[which]();
  });
  return nodeText(r.root.findAll((n) => n.type === "pre")[0]);
}
async function memo(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockDownloads.length = 0;
  await act(async () => {
    actions(r).onExportMemo();
  });
  return mockDownloads[0][0];
}

beforeEach(() => {
  for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

describe("MINOR-2: gate below two independent models (reloaded legacy run, DeepSeek×2, two 'Mixed' findings)", () => {
  it("PSV gate card and copied markdown: no 'Contested claims detected', no 'Extract the top contested claims'; uncertainty kept under its own label", async () => {
    const r = await mountSynthesis(TWO_SUBS, mixedReport(["chatgpt", "claude"]));
    const screen = nodeText(r.root);
    const md = await copied(r);
    for (const text of [screen, md]) {
      expect(text).not.toContain("Contested claims detected");
      expect(text).not.toContain("Extract the top contested claims");
      expect(text).toContain(`${SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON} (2)`);
      expect(text).toContain(SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP);
    }
  });

  it("control: two genuinely independent models keep 'Contested claims detected' and the contested step", async () => {
    const r = await mountSynthesis(DISTINCT_REAL, mixedReport(["chatgpt", "claude"]));
    const md = await copied(r);
    expect(md).toContain("Contested claims detected (2)");
    expect(md).toContain("Extract the top contested claims and verify them independently before using in a memo.");
    expect(md).not.toContain(SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON);
  });

  it("gate alone: below two models a passed disagreement and trustSummary.contestedAreas are not cross-model signals", () => {
    const base = {
      keyFindings: [{ claim: "Paris is the capital of France.", confidence: "High" as const, evidenceRefs: ["r"], modelsSupporting: ["chatgpt"] }],
      disagreements: [{ topic: "capital", positionsByModel: { chatgpt: "Paris", claude: "Osaka" }, whyTheyDiffer: "x" }],
      trustSummary: { strongConsensus: 0, contestedAreas: 2, uncertainPoints: 0 },
      questionLength: 200,
    };
    const one = computeVerificationGate({ ...base, independentModelCount: 1 });
    expect(one.metrics.disagreementsCount).toBe(0);
    expect(one.metrics.materialDisagreementsCount).toBe(0);
    expect(one.metrics.contestedCount).toBe(0);
    expect(one.reasons.join("\n")).not.toMatch(/Model disagreement|Minor nuance|Contested claims/);
    const two = computeVerificationGate({ ...base, independentModelCount: 2 });
    expect(two.metrics.disagreementsCount).toBe(1);
    expect(two.metrics.contestedCount).toBe(2);
    expect(two.reasons.join("\n")).toContain("Contested claims detected (2)");
  });
});

describe("Review of 8584211, MINOR-2 wiring: PSV hands the gate every stored disagreement, relabelled — never erased", () => {
  it("DeepSeek×2 (one independent model): the stored disagreement is stated as one model's differing positions", async () => {
    const r = await mountSynthesis(TWO_SUBS, mixedReport(["chatgpt", "claude"]));
    const screen = nodeText(r.root);
    const md = await copied(r);
    for (const text of [screen, md]) {
      expect(text).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
      expect(text).not.toMatch(/Model disagreement on a core conclusion|Minor nuance differences|Contested claims detected/);
    }
  });

  it("DeepSeek×2 + Grok (two independent models): the DeepSeek-vs-DeepSeek item is relabelled, not a model disagreement", async () => {
    const r = await mountSynthesis([sub("chatgpt"), sub("claude"), ok("grok")], mixedReport(["chatgpt", "claude"]));
    const md = await copied(r);
    expect(md).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
    expect(md).not.toMatch(/Model disagreement on a core conclusion|Minor nuance differences/);
  });

  it("control: two genuinely independent models — the disagreement is a model disagreement, nothing relabelled", async () => {
    const r = await mountSynthesis(DISTINCT_REAL, mixedReport(["chatgpt", "claude"]));
    const md = await copied(r);
    expect(md).toContain("Minor nuance differences noted (1)");
    expect(md).not.toContain(NON_INDEPENDENT_DISAGREEMENTS_REASON);
  });
});

describe("NITs: memo METHODOLOGY and share taglines with one independent model", () => {
  it("PSV memo, LinkedIn and X: no convergence / multi-model tagline", async () => {
    const r = await mountSynthesis(TWO_SUBS, mixedReport(["chatgpt", "claude"]));
    const m = await memo(r);
    expect(m).toContain(RESEARCH_MEMO_SINGLE_MODEL_METHODOLOGY);
    expect(m).not.toContain("degree of convergence");
    expect(m).not.toContain("identify areas of agreement and disagreement");
    const li = await generatedPost(r, "onGenerateLinkedIn");
    expect(li).not.toContain("The disagreements tell you more than any single answer.");
    expect(li).toContain(SINGLE_MODEL_SHARE_TAGLINE);
    const x = await generatedPost(r, "onGenerateX");
    expect(x).not.toContain("Five give you the shape of the problem.");
    expect(x).toContain(SINGLE_MODEL_SHARE_TAGLINE);
  });

  it("controls with two independent models keep the original methodology and taglines", async () => {
    const r = await mountSynthesis(DISTINCT_REAL, mixedReport(["chatgpt", "claude"]));
    expect(await memo(r)).toContain("The consensus score reflects the degree of convergence across models");
    expect(await generatedPost(r, "onGenerateLinkedIn")).toContain("The disagreements tell you more than any single answer.");
    expect(await generatedPost(r, "onGenerateX")).toContain("One model gives you a confident answer. Five give you the shape of the problem.");
  });

  it("memo generator alone: METHODOLOGY follows independentModelCount", () => {
    const input = { type: "research" as const, verdict: "", confidence: 0, consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", question: "q", modelsUsed: ["chatgpt", "claude"] };
    expect(generateVerificationMemo({ ...input, independentModelCount: 1 } as never)).toContain(RESEARCH_MEMO_SINGLE_MODEL_METHODOLOGY);
    expect(generateVerificationMemo({ ...input, independentModelCount: 2 } as never)).not.toContain(RESEARCH_MEMO_SINGLE_MODEL_METHODOLOGY);
  });

  it("socialCopy.buildLinkedInPost: crossModel false → single-model tagline; omitted → product tagline", () => {
    const gate = computeVerificationGate({ keyFindings: [], independentModelCount: 1 });
    const v = buildPanelVerdict("q", mixedReport(["chatgpt", "claude"]), gate, TWO_SUBS, { crossModel: false });
    const health = { total: 2, responded: 2, substituted: 2, failed: 0 };
    const single = buildLinkedInPost({ question: "q", gate, verdict: v, modelHealth: health });
    expect(single).toContain(SINGLE_MODEL_SHARE_TAGLINE);
    expect(single).not.toContain("highlights consensus, disagreements");
    const multi = buildLinkedInPost({ question: "q", gate, verdict: { ...v, crossModel: true }, modelHealth: health });
    expect(multi).toContain("a multi-model panel that highlights consensus, disagreements, and blind spots.");
  });
});

describe("NIT: an unrecorded substitute merges with a recorded one", () => {
  const recorded = { modelId: "chatgpt", status: "substituted", provider: "deepseek" };
  const unrecorded = { modelId: "claude", status: "substituted" };
  it("independentVoices / synthesis minimum: recorded deepseek + unrecorded substitute = one model", () => {
    expect(independentVoices([recorded, unrecorded])).toHaveLength(1);
    expect(meetsIndependentSynthesisMinimum([{ ...recorded, rawText: TEXT }, { ...unrecorded, rawText: TEXT }])).toBe(false);
    expect(meetsIndependentSynthesisMinimum([{ ...recorded, rawText: TEXT }, { ...unrecorded, rawText: TEXT }, { modelId: "grok", status: "ok", rawText: TEXT }])).toBe(true);
  });
  it("groupSlotsByExecutingVoice: one group, labelled with the recorded provider; order-independent", () => {
    for (const slots of [["chatgpt", "claude"], ["claude", "chatgpt"]]) {
      const g = groupSlotsByExecutingVoice(slots, [recorded, unrecorded]);
      expect(g).toHaveLength(1);
      expect(g[0].label.startsWith("DeepSeek (substituting ")).toBe(true);
    }
    expect(independentVoiceCount(["chatgpt", "claude", "grok"], [recorded, unrecorded, { modelId: "grok", status: "ok" }])).toBe(2);
  });
  it("controls: two unrecorded substitutes are one; a non-substituted slot never merges", () => {
    expect(independentVoices([{ modelId: "a", status: "substituted" }, { modelId: "b", status: "substituted" }])).toHaveLength(1);
    expect(independentVoices([recorded, { modelId: "grok", status: "ok" }])).toHaveLength(2);
  });
});

describe("stored-disagreement classifier (lib/panel/storedDisagreementIndependence.ts)", () => {
  const row = (modelId: string, status: string, provider?: string) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...(provider ? { provider } : {}) });
  const runDoc = (perModel: unknown[] | undefined) => (perModel ? { runDocument: { perModel } } : {});
  const item = (slots: string[]) => ({ topic: "Founding date", positionsByModel: Object.fromEntries(slots.map((s) => [s, "x"])), whyTheyDiffer: "y" });
  const classify = (perModel: unknown[] | undefined, it: unknown) => classifyStoredDisagreement(it, storedRunIndependenceContext(runDoc(perModel)));

  it("two DeepSeek substitutions → single_independent_model", () => {
    expect(classify([row("chatgpt", "substituted", "deepseek"), row("claude", "substituted", "deepseek")], item(["chatgpt", "claude"]))).toBe("single_independent_model");
  });
  it("one independent model → single_independent_model", () => {
    expect(classify([row("chatgpt", "ok"), row("claude", "failed")], "ChatGPT says 1789, Claude says 1792")).toBe("single_independent_model");
  });
  it("two genuinely independent models → cross_model (attributed and unattributed)", () => {
    const rows = [row("chatgpt", "ok"), row("claude", "ok")];
    expect(classify(rows, item(["chatgpt", "claude"]))).toBe("cross_model");
    expect(classify(rows, "Founding date: models differ")).toBe("cross_model");
  });
  it("DeepSeek×2 + Grok: DeepSeek-vs-Grok kept, DeepSeek-vs-DeepSeek not a cross-model disagreement, unattributed unverified", () => {
    const rows = [row("chatgpt", "substituted", "deepseek"), row("claude", "substituted", "deepseek"), row("grok", "ok")];
    expect(classify(rows, item(["chatgpt", "grok"]))).toBe("cross_model");
    expect(classify(rows, item(["chatgpt", "claude"]))).toBe("same_executing_model");
    expect(classify(rows, { topic: "t", positions: [{ model: "ChatGPT", position: "a" }, { model: "Claude", position: "b" }] })).toBe("same_executing_model");
    expect(classify(rows, { topic: "t", models: ["DeepSeek (substituting ChatGPT, Claude)"] })).toBe("same_executing_model");
    expect(classify(rows, { topic: "t", models: ["DeepSeek (substituting ChatGPT)", "Grok"] })).toBe("cross_model");
    expect(classify(rows, "Founding date: ChatGPT says 1789, Claude says 1792")).toBe("independence_unverified");
    expect(classify(rows, item(["chatgpt", "mystery-model"]))).toBe("independence_unverified");
    // A name that maps to no persisted row makes the whole item unattributable — it is never dropped so the remaining
    // (independent) slots could vouch for a cross-model split.
    expect(classify(rows, item(["chatgpt", "grok", "mystery-model"]))).toBe("independence_unverified");
  });
  it("missing provenance → independence_unverified (no rows, or rows without a status)", () => {
    expect(classify(undefined, item(["chatgpt", "claude"]))).toBe("independence_unverified");
    expect(classify([{ modelId: "chatgpt" }, { modelId: "claude" }], item(["chatgpt", "claude"]))).toBe("independence_unverified");
  });
});
