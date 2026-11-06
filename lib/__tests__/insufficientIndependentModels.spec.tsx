/**
 * Owner rule: a stored consensus score is not displayable as multi-model agreement when fewer than two INDEPENDENT
 * executing models contributed. Below two the panel shows an insufficient-independent-models classification — never
 * "Broadly consistent", "broad agreement", "EVIDENCE QUALITY: strong", or a disagreement between slots answered by the
 * same executing model — while a REAL disagreement between distinct executing models still shows.
 *
 * Surfaces (real components / builders; only I/O mocked): Verification Gate card, Panel Verdict card, copied synthesis
 * markdown (lib/ui/copyFormats.ts), LinkedIn / X share text (PanelSynthesisView handlers and lib/ui/socialCopy.ts), the
 * research memo (lib/verification/generateMemo.ts), and the on-screen Disagreements section.
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
const mockMemoInputs: any[] = [];
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return {
    ...actual,
    downloadTextFile: (content: string) => mockDownloads.push(content),
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
import {
  buildPanelVerdict,
  buildCopyForXShort,
  crossModelDisagreements,
  formatVerdictText,
  NO_CROSS_MODEL_COMPARISON_TEXT,
} from "@/lib/verificationGate/panelVerdict";
import {
  computeVerificationGate,
  INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL,
  INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON,
  INSUFFICIENT_INDEPENDENT_MODELS_GATE_STEP,
} from "@/lib/verificationGate/verificationGate";
import { buildLinkedInPost } from "@/lib/ui/socialCopy";
import { RECORDED_DIFFERENCES_HEADING } from "@/lib/verificationGate/panelVerdict";
import { QUALIFIED_DISAGREEMENT_TEXT } from "@/lib/panel/storedDisagreementIndependence";
import { outsideRecordedDifferences, recordedDifferenceSections } from "./recordedDifferencesText";
import { buildSynthesisMarkdown } from "@/lib/ui/copyFormats";
import { RESEARCH_MEMO_NO_CROSS_MODEL_EVIDENCE } from "@/lib/verification/generateMemo";
import { clientRowText, meetsIndependentSynthesisMinimum } from "@/lib/panel/independentVoices";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";
const ok = (modelId: string, provider: string) => ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5, provider }) as ModelResult;
const sub = (modelId: string, provider: string | undefined = "deepseek") =>
  ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, ...(provider ? { provider } : {}) }) as ModelResult;
const failed = (modelId: string, extra: Record<string, unknown> = {}) => ({ modelId, status: "failed", rawText: null, latencyMs: 5, ...extra }) as unknown as ModelResult;

// Row sets under test.
const TWO_DEEPSEEK_SUBS = [sub("chatgpt"), sub("claude")];
const ONE_INDEPENDENT = [ok("chatgpt", "openai"), failed("claude"), failed("grok")];
const MISSING_CREDENTIALS = [
  failed("chatgpt", { errorCode: "provider_not_configured", substitutionReason: "openai_not_configured" }),
  failed("claude", { errorCode: "provider_not_configured", substitutionReason: "anthropic_not_configured" }),
  ok("grok", "xai"),
];
const UNRECORDED_SUBS = [sub("chatgpt", undefined), sub("claude", undefined)];
const TWO_INDEPENDENT = [ok("chatgpt", "openai"), ok("grok", "xai")];
const SUBS_PLUS_GROK = [sub("chatgpt"), sub("claude"), ok("grok", "xai")];

// A stored summary that, read naively, is a strong, high-scoring cross-model agreement.
const STRONG_SUMMARY = { modelsHealthy: 2, modelCount: 2, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

const finding = (modelsSupporting: string[]) => ({ claim: "Paris is the capital of France.", confidence: "High", evidenceRefs: ["r1"], modelsSupporting });
/** No disagreements, one High-confidence sourced finding: the gate is SAFE_TO_EXPLORE unless independence says otherwise. */
const calmReport = (modelsSupporting: string[]): StructuredSynthesis =>
  ({ executiveSummary: "Paris is the capital.", keyFindings: [finding(modelsSupporting)], disagreements: [], biasAndBlindSpots: [], openQuestions: [], methodology: "m" }) as unknown as StructuredSynthesis;
/** One disagreement whose positions come from exactly `positionSlots`. */
const disputedReport = (modelsSupporting: string[], positionSlots: string[], topic = "Founding date"): StructuredSynthesis =>
  ({
    executiveSummary: "Paris is the capital.",
    keyFindings: [finding(modelsSupporting)],
    disagreements: [{ topic, positionsByModel: Object.fromEntries(positionSlots.map((m, i) => [m, `Position ${i}`])), whyTheyDiffer: "Sources differ on the year." }],
    biasAndBlindSpots: [],
    openQuestions: [],
    methodology: "m",
  }) as unknown as StructuredSynthesis;

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function mount(results: ModelResult[], rep: StructuredSynthesis, summary: any = STRONG_SUMMARY) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(PanelSynthesisView as never, { results, question: "What is the capital of France?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: rep, preGeneratedConsensusSummary: summary } as never)
    );
  });
  mounted.push(r);
  return r;
}
const actions = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(VerificationActions).props;
async function post(r: TestRenderer.ReactTestRenderer, which: "onGenerateLinkedIn" | "onGenerateX"): Promise<string> {
  await act(async () => {
    actions(r)[which]();
  });
  return nodeText(r.root.findAll((n) => n.type === "pre")[0]);
}
async function memo(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockDownloads.length = 0;
  mockMemoInputs.length = 0;
  await act(async () => {
    actions(r).onExportMemo();
  });
  expect(mockDownloads).toHaveLength(1);
  return mockDownloads[0];
}
async function copied(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockCopied.length = 0;
  await act(async () => {
    await actions(r).onCopy();
  });
  expect(mockCopied).toHaveLength(1);
  return mockCopied[0];
}
const verdictCard = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root.findAll((n) => n.type === "h3" && nodeText(n) === "Panel Verdict")[0].parent!.parent!.parent!);
const gateCard = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root.findAll((n) => n.type === "span" && nodeText(n) === "Verification Gate")[0].parent!.parent!.parent!);
const byTestIdText = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string").map(nodeText).join("\n");
/** The verdict card's recorded-differences lists (and their heading) vs the rest of the card. */
const recordedInCard = (r: TestRenderer.ReactTestRenderer) => byTestIdText(r, "verdict-recorded-differences");
const cardOutsideRecorded = (r: TestRenderer.ReactTestRenderer) => {
  let t = verdictCard(r);
  for (const el of r.root.findAll((n) => n.props?.["data-testid"] === "verdict-recorded-differences" && typeof n.type === "string")) t = t.split(nodeText(el)).join("");
  return t.split(RECORDED_DIFFERENCES_HEADING).join("");
};
const hasDisagreementsSection = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "h2" && nodeText(n) === "Disagreements").length > 0;

/** Every text a viewer can see or share for one mounted run. */
async function everySurface(r: TestRenderer.ReactTestRenderer) {
  return {
    gate: gateCard(r),
    card: verdictCard(r),
    linkedIn: await post(r, "onGenerateLinkedIn"),
    x: await post(r, "onGenerateX"),
    memo: await memo(r),
    markdown: await copied(r),
    page: nodeText(r.root),
  };
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

const BELOW_TWO: Array<[string, ModelResult[], string[]]> = [
  ["two DeepSeek substitutions", TWO_DEEPSEEK_SUBS, ["chatgpt", "claude"]],
  ["one independent model (others failed)", ONE_INDEPENDENT, ["chatgpt"]],
  ["missing provider credentials (ChatGPT/Claude not configured, Grok answered)", MISSING_CREDENTIALS, ["grok"]],
  ["two substitutions with no recorded provider", UNRECORDED_SUBS, ["chatgpt", "claude"]],
];

describe("M1. fewer than two independent executing models: no agreement / evidence / disagreement claim on any surface", () => {
  it.each(BELOW_TWO)("%s: no 'Broadly consistent', no 'broad agreement', no 'EVIDENCE QUALITY: strong'", async (_n, rows, supporting) => {
    expect(meetsIndependentSynthesisMinimum(rows)).toBe(false);
    const r = await mount([...rows], calmReport(supporting));
    const s = await everySurface(r);
    for (const [where, text] of Object.entries(s)) {
      expect([where, /Broadly consistent/.test(text)]).toEqual([where, false]);
      expect([where, /broad agreement/i.test(text)]).toEqual([where, false]);
      expect([where, /EVIDENCE QUALITY: strong/.test(text)]).toEqual([where, false]);
    }
    // The insufficient-independent-models classification is shown instead (gate card, verdict card, markdown, memo).
    expect(s.gate).toContain(INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL);
    expect(s.gate).toContain(INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON);
    expect(s.gate).toContain(INSUFFICIENT_INDEPENDENT_MODELS_GATE_STEP);
    expect(s.card).toContain(INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL);
    expect(s.markdown).toContain(`**${INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL}**`);
    expect(s.memo).toContain(`EVIDENCE QUALITY: ${RESEARCH_MEMO_NO_CROSS_MODEL_EVIDENCE}`);
    // No substitute score: the stored 90 is not shown anywhere either.
    for (const text of Object.values(s)) expect(text).not.toMatch(/\b90\/100\b/);
  });

  it.each(BELOW_TWO)("%s: a stored disagreement is not presented as models disagreeing", async (_n, rows, supporting) => {
    const r = await mount([...rows], disputedReport(supporting, ["chatgpt", "claude"]));
    const s = await everySurface(r);
    expect(s.linkedIn).not.toContain("Where models disagree");
    expect(s.x).not.toContain("Models disagreed on");
    expect(s.memo).not.toContain("WHERE MODELS DISAGREE");
    expect(s.markdown).not.toContain("Key disagreement");
    // Review of 1ee4982, MINOR-B: the stored difference is RETAINED — only inside its own "Recorded differences not
    // counted as model disagreements" section (one independent model), never anywhere else on any surface.
    for (const where of ["linkedIn", "x", "memo", "markdown"] as const) {
      expect([where, recordedDifferenceSections(s[where]).includes("Founding date")]).toEqual([where, true]);
      expect([where, outsideRecordedDifferences(s[where]).includes("Founding date")]).toEqual([where, false]);
      expect([where, recordedDifferenceSections(s[where]).includes(QUALIFIED_DISAGREEMENT_TEXT.single_independent_model)]).toEqual([where, true]);
    }
    const cardRecorded = recordedInCard(r);
    expect(cardRecorded).toContain("Founding date");
    expect(cardOutsideRecorded(r)).not.toContain("Founding date");
    expect(s.card).not.toContain("Key disagreement");
    expect(s.card).toContain(NO_CROSS_MODEL_COMPARISON_TEXT);
    expect(hasDisagreementsSection(r)).toBe(false);
    expect(byTestIdText(r, "recorded-differences")).toContain("Founding date");
    // The gate's disagreement reasons / steps are not fed by one model's positions either.
    for (const t of [s.gate, s.markdown]) {
      expect(t).not.toMatch(/Model disagreement on a core conclusion|Minor nuance differences|Isolate the disputed premise/);
    }
    expect(mockMemoInputs.length === 0 || mockMemoInputs[0].synthesisDisagreements.length === 0).toBe(true);
  });
});

describe("M1 controls: two genuinely independent models keep agreement, evidence quality and REAL disagreement", () => {
  it("calm report: 'Broadly consistent', the broad-agreement step, 'EVIDENCE QUALITY: strong' and the score are shown", async () => {
    const r = await mount([...TWO_INDEPENDENT], calmReport(["chatgpt", "grok"]));
    const s = await everySurface(r);
    expect(s.gate).toContain("Broadly consistent");
    expect(s.gate).toMatch(/broad agreement/);
    expect(s.gate).not.toContain(INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL);
    expect(s.card).toContain("Broadly consistent");
    expect(s.memo).toContain("EVIDENCE QUALITY: strong");
    expect(s.memo).toContain("CONSENSUS SCORE: 90/100");
    expect(s.markdown).toContain("**Broadly consistent**");
  });

  it("real disagreement between two independent models shows on every surface", async () => {
    const r = await mount([...TWO_INDEPENDENT], disputedReport(["chatgpt", "grok"], ["chatgpt", "grok"]));
    const s = await everySurface(r);
    expect(s.linkedIn).toContain("Where models disagree:");
    expect(s.linkedIn).toContain("Founding date: Sources differ on the year.");
    expect(s.x).toContain("Models disagreed on: Founding date");
    expect(s.memo).toContain("WHERE MODELS DISAGREE");
    expect(s.markdown).toContain("Key disagreement:");
    expect(s.markdown).toContain("- Topic: Founding date");
    expect(s.card).toContain("Founding date");
    expect(s.card).toContain("2 models split");
    expect(s.card).not.toContain(NO_CROSS_MODEL_COMPARISON_TEXT);
    expect(hasDisagreementsSection(r)).toBe(true);
    // Control: a real disagreement still drives the gate's disagreement reason.
    expect(s.gate).toMatch(/Model disagreement on a core conclusion \(1\)|Minor nuance differences noted \(1\)/);
  });

  it("two DeepSeek slots + Grok: the DeepSeek-vs-DeepSeek 'disagreement' is dropped, the DeepSeek-vs-Grok one is kept", async () => {
    const rep = disputedReport(["chatgpt", "claude", "grok"], ["chatgpt", "claude"], "Fabricated split");
    (rep.disagreements as any[]).push({ topic: "Real split", positionsByModel: { chatgpt: "1789", grok: "1792" }, whyTheyDiffer: "Different sources." });
    const r = await mount([...SUBS_PLUS_GROK], rep, { ...STRONG_SUMMARY, modelCount: 3 });
    const s = await everySurface(r);
    // MINOR-B: the DeepSeek-vs-DeepSeek item is retained only in its own section, named by executing model.
    for (const text of [s.linkedIn, s.memo, s.markdown]) {
      expect(outsideRecordedDifferences(text)).not.toContain("Fabricated split");
      expect(recordedDifferenceSections(text)).toContain("Fabricated split");
      expect(recordedDifferenceSections(text)).toContain(QUALIFIED_DISAGREEMENT_TEXT.same_executing_model);
    }
    // X carries a recorded difference only when no genuine disagreement exists (here one does).
    expect(s.x).not.toContain("Fabricated split");
    expect(cardOutsideRecorded(r)).not.toContain("Fabricated split");
    expect(recordedInCard(r)).toContain("Fabricated split");
    expect(byTestIdText(r, "recorded-differences")).toContain("DeepSeek (substituting ChatGPT):");
    expect(s.linkedIn).toContain("Real split: Different sources.");
    expect(s.x).toContain("Models disagreed on: Real split");
    expect(s.memo).toContain("- Real split: Different sources.");
    expect(s.markdown).toContain("- Topic: Real split");
    expect(s.card).toContain("Real split");
    // On-screen Disagreements section: only the real one.
    const section = r.root.findAll((n) => n.type === "h2" && nodeText(n) === "Disagreements")[0].parent!;
    const h3s = section.findAll((n) => n.type === "h3").map(nodeText);
    expect(h3s).toContain("Real split");
    expect(h3s).not.toContain("Fabricated split");
  });
});

describe("M1 builders on their own", () => {
  const rep = disputedReport(["chatgpt", "claude"], ["chatgpt", "claude"]);
  it("computeVerificationGate: independentModelCount 0 / 1 / NaN / Infinity → insufficient; 2 / absent → unchanged", () => {
    const base = { keyFindings: calmReport(["chatgpt", "grok"]).keyFindings as any, disagreements: [], biasAndBlindSpots: [], openQuestions: [], sourceBacked: false, questionLength: 30 };
    for (const n of [0, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = computeVerificationGate({ ...base, independentModelCount: n });
      expect([n, g.label, g.status]).toEqual([n, INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL, "NEEDS_HUMAN_REVIEW"]);
      expect(g.reasons[0]).toBe(INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON);
      expect(g.recommendedNextSteps.join(" ")).not.toMatch(/broad agreement/);
      expect(g.recommendedNextSteps[0]).toBe(INSUFFICIENT_INDEPENDENT_MODELS_GATE_STEP);
    }
    for (const g of [computeVerificationGate({ ...base, independentModelCount: 2 }), computeVerificationGate(base)]) {
      expect([g.label, g.status]).toEqual(["Broadly consistent", "SAFE_TO_EXPLORE"]);
      expect(g.recommendedNextSteps).toEqual(["Models show broad agreement — suitable for exploratory use. Cross-check key claims with primary sources before acting on them."]);
      expect(g.reasons).toEqual([]);
    }
  });

  it("computeVerificationGate: a stricter computed status is kept (DO_NOT_RELY_YET stays), label still insufficient", () => {
    const g = computeVerificationGate({
      keyFindings: [{ claim: "x", confidence: "Low", evidenceRefs: [], modelsSupporting: ["chatgpt"] }, { claim: "y", confidence: "Low", evidenceRefs: ["r"], modelsSupporting: ["chatgpt"] }],
      disagreements: [],
      sourceBacked: true,
      independentModelCount: 1,
    });
    expect([g.status, g.label]).toEqual(["DO_NOT_RELY_YET", INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL]);
  });

  it("crossModelDisagreements: crossModel false → none; same-executor slots dropped; distinct kept; single-slot item kept only when no slots collapsed", () => {
    const items: Array<{ topic: string; positionsByModel: Record<string, string> }> = [
      { topic: "same", positionsByModel: { chatgpt: "a", claude: "b" } },
      { topic: "real", positionsByModel: { chatgpt: "a", grok: "b" } },
      { topic: "single", positionsByModel: { grok: "a" } },
      { topic: "dup-key", positionsByModel: { chatgpt: "a", " chatgpt ": "b" } },
    ];
    expect(crossModelDisagreements(items, SUBS_PLUS_GROK, false)).toEqual([]);
    // SUBS_PLUS_GROK collapsed (chatgpt + claude both DeepSeek): an item naming one slot cannot be attributed to
    // independent models — the same classification the governance queue gives the stored record (review of 262ef64, B3).
    expect(crossModelDisagreements(items, SUBS_PLUS_GROK, true).map((d) => d.topic)).toEqual(["real"]);
    expect(crossModelDisagreements(items, TWO_INDEPENDENT, true).map((d) => d.topic)).toEqual(["same", "real", "single", "dup-key"]);
    expect(crossModelDisagreements(null, TWO_INDEPENDENT, true)).toEqual([]);
  });

  it("buildPanelVerdict + verdict text / LinkedIn builders: no fabricated disagreement, real one kept", () => {
    const gate = computeVerificationGate({ keyFindings: [], disagreements: [], independentModelCount: 1 });
    const below = buildPanelVerdict("q", rep, gate, TWO_DEEPSEEK_SUBS, { crossModel: false });
    expect(below.topDisagreement).toBeNull();
    for (const t of [formatVerdictText(below, "linkedin"), buildCopyForXShort(below), buildLinkedInPost({ question: "q", gate, verdict: below, modelHealth: { total: 2, responded: 2, substituted: 2, failed: 0 } } as never)]) {
      expect(t).not.toMatch(/Key disagreement|Disagreement:/);
      // MINOR-B: retained only in the recorded-differences section.
      expect(outsideRecordedDifferences(t)).not.toContain("Founding date");
      expect(recordedDifferenceSections(t)).toContain("Founding date");
      expect(t).not.toContain("Broadly consistent");
      expect(t).toContain(INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL);
    }
    // crossModel true but both positions from DeepSeek: still no disagreement.
    expect(buildPanelVerdict("q", rep, gate, SUBS_PLUS_GROK, { crossModel: true }).topDisagreement).toBeNull();
    const real = buildPanelVerdict("q", disputedReport(["chatgpt", "grok"], ["chatgpt", "grok"]), gate, TWO_INDEPENDENT, { crossModel: true });
    expect([real.topDisagreement, real.disagreementModelCount]).toEqual(["Founding date", 2]);
    const md = buildSynthesisMarkdown("q", gate, below, { total: 2, responded: 2, substitutedCount: 2, failedCount: 0 });
    expect(md).not.toContain("Key disagreement");
  });

  it("memo generator alone: independentModelCount 1 suppresses evidence quality and disagreement; 2 keeps them; absent unchanged", () => {
    const { generateVerificationMemo } = jest.requireActual("@/lib/verification/generateMemo");
    const base = { type: "research", question: "q", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "r", keyFindings: ["F"], synthesisDisagreements: ["D: why"], modelsUsed: ["x", "y"] };
    const one = generateVerificationMemo({ ...base, independentModelCount: 1 });
    expect(one).not.toContain("EVIDENCE QUALITY: strong");
    expect(one).toContain(`EVIDENCE QUALITY: ${RESEARCH_MEMO_NO_CROSS_MODEL_EVIDENCE}`);
    expect(one).not.toContain("WHERE MODELS DISAGREE");
    const two = generateVerificationMemo({ ...base, independentModelCount: 2 });
    expect(two).toContain("EVIDENCE QUALITY: strong");
    expect(two).toContain("WHERE MODELS DISAGREE\n- D: why");
    const absent = generateVerificationMemo(base);
    expect(absent).toContain("EVIDENCE QUALITY: strong");
    expect(absent).toContain("WHERE MODELS DISAGREE");
  });
});

describe("NIT M26: the synthesis payload text getter equals the gate's (first non-empty)", () => {
  it("rawTextFull '' + rawText non-empty → rawText (the row the gate counts is sent with its text)", () => {
    expect(clientRowText({ modelId: "chatgpt", status: "ok", rawTextFull: "", rawText: "R", text: "T" })).toBe("R");
    expect(clientRowText({ modelId: "chatgpt", status: "ok", rawTextFull: "F", rawText: "R" })).toBe("F");
    expect(clientRowText({ modelId: "chatgpt", status: "ok", rawTextFull: "", rawText: "", text: "T" })).toBe("T");
    expect(clientRowText({ modelId: "chatgpt", status: "ok" })).toBe("");
  });

  it("PanelSynthesisView sends the rawText of a row whose rawTextFull is empty", async () => {
    const { fetchWithTimeout } = jest.requireMock("@/lib/client/fetchWithTimeout");
    const rows = [
      { ...ok("chatgpt", "openai"), rawTextFull: "", rawText: "CHATGPT TEXT" },
      { ...ok("grok", "xai"), rawTextFull: "", rawText: "GROK TEXT" },
    ] as unknown as ModelResult[];
    fetchWithTimeout.mockClear();
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(createElement(PanelSynthesisView as never, { results: rows, question: "q", runId: "run-1", preGeneratedStatus: "error", preGeneratedError: null } as never));
    });
    mounted.push(r);
    const button = r.root.findAll((n) => n.type === "button" && nodeText(n).includes("Generate Synthesis"))[0];
    await act(async () => {
      button.props.onClick();
    });
    const calls = fetchWithTimeout.mock.calls.filter((c: any[]) => String(c[0]) === "/api/synthesize-panel" && c[1]?.method === "POST");
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[0][1].body);
    expect(body.results.map((x: any) => x.text)).toEqual(["CHATGPT TEXT", "GROK TEXT"]);
  });
});
