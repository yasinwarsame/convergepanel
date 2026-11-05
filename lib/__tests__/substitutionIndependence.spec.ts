/**
 * Fail-closed configuration + substitution independence — aggregation regression.
 *
 * Owner policy:
 *  1. A missing ChatGPT/Claude key (`provider_not_configured`) is a configuration
 *     failure: the provider is not called, the DeepSeek fallback is NOT invoked,
 *     and the slot is excluded from every agreement/consensus count.
 *  2. A still-permitted DeepSeek substitution (transient primary failure) records
 *     the executing model, is never named as the original provider, and N slots
 *     answered by DeepSeek count as at most ONE independent voice.
 *
 * Drives the REAL panel runner, REAL ChatGPT/Claude connectors (only the OpenAI
 * and Anthropic SDKs are doubles) and the REAL aggregation functions. DeepSeek,
 * Grok and Gemini are doubles; no real provider call is ever made.
 */
const mockOpenAICreate = jest.fn();
jest.mock("openai", () => ({
  __esModule: true,
  default: function OpenAI() {
    return { chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } };
  },
}));
const mockAnthropicCreate = jest.fn();
const mockAnthropicCtor = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: function Anthropic(...a: unknown[]) {
    mockAnthropicCtor(...a);
    return { messages: { create: (...b: unknown[]) => mockAnthropicCreate(...b) } };
  },
}));

const mockCallGrok = jest.fn();
jest.mock("@/lib/connectors/grok", () => ({ callGrok: (...a: unknown[]) => mockCallGrok(...a) }));
const mockCallGemini = jest.fn();
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: (...a: unknown[]) => mockCallGemini(...a) }));
const mockCallDeepSeek = jest.fn();
jest.mock("@/lib/connectors/deepseek", () => ({ DEEPSEEK_MODEL: "deepseek-chat", callDeepSeek: (...a: unknown[]) => mockCallDeepSeek(...a) }));

let mockDeepSeekKey: string | undefined;
jest.mock("@/lib/env", () => {
  const actual = jest.requireActual("@/lib/env");
  return {
    ...actual,
    get DEEPSEEK_API_KEY() {
      return mockDeepSeekKey;
    },
  };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { runPanel } from "@/lib/panel";
import { synthesizeReport } from "@/lib/consensus";
import { buildAgreementMap } from "@/lib/agreementMap";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import type { QueryClassification } from "@/lib/adaptiveSchema/types";
import { detectAdaptiveBiases } from "@/lib/adaptiveSchema/biasDetection";
import { computeSynthesisConsensusScoring } from "@/lib/verification/consensusScoring";
import { runClaimVerificationPanel } from "@/lib/verification/runClaimVerificationPanel";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { executingModelKey, independentVoices } from "@/lib/panel/independentVoices";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const FAKE_KEY = "sk-FAKE-test-key-never-real-0000";
const DS_KEY = "ds-FAKE-never-real";

const PANEL_TEXT =
  "Paris is the capital of France. The city has been the seat of the French government for centuries. " +
  "It is located on the Seine river in northern France. Paris is the most populous city in France.";

function openAIText(text: string) {
  mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}
function anthropicText(text: string) {
  mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" });
}
function grokText(text: string) {
  mockCallGrok.mockResolvedValue({ modelId: "grok", status: "ok", rawText: text, latencyMs: 5 } satisfies ModelResult);
}
function geminiText(text: string) {
  mockCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: text, latencyMs: 5 } satisfies ModelResult);
}
function deepSeekText(text: string) {
  mockCallDeepSeek.mockResolvedValue({ ok: true, text, latencyMs: 3, actualModel: "deepseek-chat" });
}
function serverError(): Error & { status: number } {
  return Object.assign(new Error("500 Internal Server Error"), { status: 500 });
}

const byId = (results: ModelResult[]) => Object.fromEntries(results.map((r) => [r.modelId, r]));
const clusterIds = (report: ReturnType<typeof synthesizeReport>) =>
  report!.consensusAnalysis!.agreementClusters!.map((c) => c.modelIds);

let consoleSpies: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockDeepSeekKey = undefined;
  consoleSpies = [
    jest.spyOn(console, "log").mockImplementation(() => {}),
    jest.spyOn(console, "warn").mockImplementation(() => {}),
    jest.spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  consoleSpies.forEach((s) => s.mockRestore());
});

// ─── Policy 1: provider_not_configured is never substituted ──────────────────

describe("REGRESSION: DeepSeek configured + ChatGPT and Claude keys missing (panel chatgpt, claude, grok)", () => {
  it("does not manufacture consensus: no substitution, no DeepSeek call, chatgpt/claude in no cluster, no strongConsensus", async () => {
    mockDeepSeekKey = DS_KEY;
    deepSeekText(PANEL_TEXT);
    grokText(PANEL_TEXT);

    const results = await runPanel("What is the capital of France?", ["chatgpt", "claude", "grok"], {
      chatgpt: undefined,
      claude: "   ",
      grok: FAKE_KEY,
    });
    const r = byId(results);

    expect(r.chatgpt.status).toBe("failed");
    expect(r.claude.status).toBe("failed");
    expect(r.chatgpt.substitutionReason).toBe("openai_not_configured");
    expect(r.claude.substitutionReason).toBe("anthropic_not_configured");
    expect(r.chatgpt.provider).toBe("openai");
    expect(r.claude.provider).toBe("anthropic");
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockAnthropicCtor).not.toHaveBeenCalled();

    // Only grok answered: the ≥2-voice rule is not met, so there is no consensus at all
    // (base b1a680e: both slots "substituted" → strongConsensus 3 with [chatgpt, claude, grok] clusters).
    const report = synthesizeReport(results);
    expect(report).toBeNull();
    for (const ids of buildAgreementMap(results).map((c) => c.modelIds)) {
      expect(ids).not.toContain("chatgpt");
      expect(ids).not.toContain("claude");
    }
  });

  it("consensus outcome: strongConsensus is 0 (not 3) and neither chatgpt nor claude is in any agreement cluster", async () => {
    mockDeepSeekKey = DS_KEY;
    deepSeekText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    const results = await runPanel("What is the capital of France?", ["chatgpt", "claude", "grok"], { chatgpt: undefined, claude: "   ", grok: FAKE_KEY });
    const report = synthesizeReport(results);
    const clusterModelIds = (report?.consensusAnalysis?.agreementClusters ?? []).flatMap((c) => c.modelIds);
    expect(clusterModelIds).not.toContain("chatgpt");
    expect(clusterModelIds).not.toContain("claude");
    expect(report?.consensusAnalysis?.trustSummary.strongConsensus ?? 0).toBe(0);
  });

  it("with other configured models available (gemini), consensus is only between the real responders", async () => {
    mockDeepSeekKey = DS_KEY;
    deepSeekText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    geminiText(PANEL_TEXT);

    const results = await runPanel("q", ["chatgpt", "claude", "grok", "gemini"], { chatgpt: "", claude: undefined, grok: FAKE_KEY, gemini: FAKE_KEY });
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
    const report = synthesizeReport(results)!;
    expect(report).not.toBeNull();
    const ids = clusterIds(report);
    expect(new Set(ids.flat())).toEqual(new Set(["grok", "gemini"]));
    for (const f of report.consensusAnalysis!.consensusFindings!) expect([...f.modelIds].sort()).toEqual(["gemini", "grok"]);
    expect(report.consensusAnalysis!.trustSummary.strongConsensus).toBeGreaterThan(0);
    expect(report.unifiedAnswer).not.toMatch(/ChatGPT|Claude|DeepSeek/);
  });
});

describe("missing key: each slot, DeepSeek present and absent", () => {
  it.each([
    ["DeepSeek configured", DS_KEY],
    ["DeepSeek absent", undefined],
  ])("missing ChatGPT key only (%s) → chatgpt failed openai_not_configured; claude + grok real; consensus is claude+grok", async (_l, ds) => {
    mockDeepSeekKey = ds;
    deepSeekText(PANEL_TEXT);
    anthropicText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude", "grok"], { chatgpt: "  ", claude: FAKE_KEY, grok: FAKE_KEY });
    const r = byId(results);
    expect(r.chatgpt.status).toBe("failed");
    expect(r.chatgpt.errorCode).toBe("provider_not_configured");
    expect(r.chatgpt.substitutionReason).toBe("openai_not_configured");
    expect(r.claude.status).toBe("ok");
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
    const report = synthesizeReport(results)!;
    expect(new Set(clusterIds(report).flat())).toEqual(new Set(["claude", "grok"]));
  });

  it.each([
    ["DeepSeek configured", DS_KEY],
    ["DeepSeek absent", undefined],
  ])("missing Claude key only (%s) → claude failed anthropic_not_configured; never substituted", async (_l, ds) => {
    mockDeepSeekKey = ds;
    deepSeekText(PANEL_TEXT);
    openAIText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude", "grok"], { chatgpt: FAKE_KEY, claude: "", grok: FAKE_KEY });
    const r = byId(results);
    expect(r.claude.status).toBe("failed");
    expect(r.claude.errorCode).toBe("provider_not_configured");
    expect(r.claude.substitutionReason).toBe("anthropic_not_configured");
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
    const report = synthesizeReport(results)!;
    expect(new Set(clusterIds(report).flat())).toEqual(new Set(["chatgpt", "grok"]));
  });

  it("both missing, DeepSeek absent → both failed with their own not_configured reasons", async () => {
    grokText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude", "grok"], { chatgpt: undefined, claude: undefined, grok: FAKE_KEY });
    const r = byId(results);
    expect([r.chatgpt.status, r.claude.status]).toEqual(["failed", "failed"]);
    expect([r.chatgpt.substitutionReason, r.claude.substitutionReason]).toEqual(["openai_not_configured", "anthropic_not_configured"]);
    expect(synthesizeReport(results)).toBeNull();
  });
});

describe("rejected credentials (401) are not substituted", () => {
  it("ChatGPT and Claude 401 with DeepSeek configured → failed `_auth`, no retry, DeepSeek never called", async () => {
    mockDeepSeekKey = DS_KEY;
    deepSeekText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    mockOpenAICreate.mockRejectedValue(Object.assign(new Error("Incorrect API key provided: sk-FAKE***0000"), { status: 401 }));
    mockAnthropicCreate.mockRejectedValue(Object.assign(new Error("invalid x-api-key"), { status: 401 }));

    const results = await runPanel("q", ["chatgpt", "claude", "grok"], { chatgpt: FAKE_KEY, claude: FAKE_KEY, grok: FAKE_KEY });
    const r = byId(results);
    expect(r.chatgpt.status).toBe("failed");
    expect(r.claude.status).toBe("failed");
    expect(r.chatgpt.substitutionReason).toBe("openai_auth");
    expect(r.claude.substitutionReason).toBe("anthropic_auth");
    // The fixed message never echoes the SDK text (which can carry part of the key).
    expect(JSON.stringify(results)).not.toContain("sk-FAKE");
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
    expect(synthesizeReport(results)).toBeNull();
  });
});

// ─── Policy 2: permitted substitutions are attributed and not independent ────

describe("transient failures substituted by DeepSeek count as ONE voice, attributed to DeepSeek", () => {
  async function twoSubstitutions(panel: Array<"chatgpt" | "claude" | "grok">) {
    mockDeepSeekKey = DS_KEY;
    deepSeekText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    mockOpenAICreate.mockRejectedValue(serverError());
    mockAnthropicCreate.mockRejectedValue(serverError());
    return runPanel("q", panel, { chatgpt: FAKE_KEY, claude: FAKE_KEY, grok: FAKE_KEY });
  }

  it("records the executing model on each substituted slot", async () => {
    const r = byId(await twoSubstitutions(["chatgpt", "claude", "grok"]));
    expect(mockCallDeepSeek).toHaveBeenCalledTimes(2);
    for (const [slot, from] of [
      ["chatgpt", "openai:gpt-4o-mini"],
      ["claude", "anthropic:claude-haiku-4-5-20251001"],
    ] as const) {
      expect(r[slot].status).toBe("substituted");
      expect(r[slot].provider).toBe("deepseek");
      expect(r[slot].actualModel).toBe("deepseek-chat");
      expect(r[slot].substitutedFrom).toBe(from);
      expect(r[slot].substitutionReason).toMatch(/^(openai|anthropic)_error$/);
    }
  });

  it("two DeepSeek substitutions + grok → every consensus cluster has exactly 2 voices, never both chatgpt and claude", async () => {
    const results = await twoSubstitutions(["chatgpt", "claude", "grok"]);
    const report = synthesizeReport(results)!;
    expect(report).not.toBeNull();
    const consensus = report.consensusAnalysis!.consensusFindings!;
    expect(consensus.length).toBeGreaterThan(0);
    for (const f of consensus) {
      expect(f.modelIds).toHaveLength(2);
      expect(f.modelIds).toContain("grok");
      expect(f.modelIds.includes("chatgpt") && f.modelIds.includes("claude")).toBe(false);
    }
    for (const ids of clusterIds(report)) expect(ids).not.toContain("claude"); // the repeated substitute is not a voice
    // Attribution: the counted substitute is named as DeepSeek, never as ChatGPT/Claude.
    expect(report.unifiedAnswer).toContain("DeepSeek (substituting ChatGPT)");
    expect(report.unifiedAnswer).toContain("Agreed by 2 models");
    expect(report.unifiedAnswer).not.toMatch(/Agreed by 3 models/);
    expect(report.unifiedAnswer).not.toContain("Claude");
    const html = report.unifiedAnswer;
    expect(html.split("ChatGPT").length).toBe(html.split("(substituting ChatGPT)").length); // ChatGPT only ever as the substituted slot
  });

  it("control: three REAL responders do produce 3-voice consensus (the reduction is what limits the substitutes)", async () => {
    openAIText(PANEL_TEXT);
    anthropicText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude", "grok"], { chatgpt: FAKE_KEY, claude: FAKE_KEY, grok: FAKE_KEY });
    const report = synthesizeReport(results)!;
    expect(report.consensusAnalysis!.consensusFindings!.some((f) => f.modelIds.length === 3)).toBe(true);
  });

  it("two DeepSeek substitutions and nothing else → one voice → no synthesis", async () => {
    const results = await twoSubstitutions(["chatgpt", "claude"]);
    expect(results.every((r) => r.status === "substituted")).toBe(true);
    expect(synthesizeReport(results)).toBeNull();
  });

  it("saved-run rows without a recorded provider (older runs) still collapse to one voice (fail closed)", () => {
    const rows = [
      { modelId: "chatgpt", status: "substituted", rawText: PANEL_TEXT },
      { modelId: "claude", status: "substituted", rawText: PANEL_TEXT },
    ] as unknown as ModelResult[];
    expect(synthesizeReport(rows)).toBeNull();
    expect(executingModelKey(rows[0])).toBe(executingModelKey(rows[1]));
    expect(independentVoices(rows)).toHaveLength(1);
  });
});

describe("synthesis consensus scoring (computeSynthesisConsensusScoring — research governance input)", () => {
  const synthesis = {
    keyFindings: [{ claim: "Paris is the capital of France.", evidenceRefs: ["r1"] }],
    disagreements: [],
    biasAndBlindSpots: [],
  } as unknown as StructuredSynthesis;

  it("two DeepSeek-substituted rows support once; modelCount stays the dispatched total", () => {
    const out = computeSynthesisConsensusScoring({
      synthesis,
      results: [
        { modelId: "chatgpt", status: "substituted", rawText: PANEL_TEXT, provider: "deepseek" },
        { modelId: "claude", status: "substituted", rawText: PANEL_TEXT, provider: "deepseek" },
        { modelId: "grok", status: "ok", rawText: PANEL_TEXT },
      ],
      sourceBacked: true,
      runId: "r",
    });
    const support = out.enrichedSynthesis.keyFindings[0].support!;
    expect(support.supportingModels).toEqual(["chatgpt", "grok"]);
    expect(out.consensusSummary.modelsHealthy).toBe(2);
    expect(out.consensusSummary.modelCount).toBe(3);
    expect(support.supportRatio).toBe(1);
  });

  it("control: three ok rows support three times", () => {
    const out = computeSynthesisConsensusScoring({
      synthesis,
      results: ["chatgpt", "claude", "grok"].map((modelId) => ({ modelId, status: "ok", rawText: PANEL_TEXT })),
      sourceBacked: true,
      runId: "r",
    });
    expect(out.enrichedSynthesis.keyFindings[0].support!.supportingModels).toHaveLength(3);
    expect(out.consensusSummary.modelsHealthy).toBe(3);
  });
});

describe("adaptive research: source coverage + accounting under two DeepSeek substitutions", () => {
  const DEEP_RESEARCH_JSON = JSON.stringify({
    executiveSummary: "A concise research synthesis.",
    findings: [{ id: "a", title: "Finding", summary: "A well-documented finding across studies.", sources: ["https://example.org/study"] }],
    disagreements: [],
    evidenceGaps: [],
    openQuestions: [],
    researchBoundaries: [],
    recommendedNextSteps: [],
    sources: ["https://example.org/study"],
  });
  const CLASSIFICATION = {
    queryType: "deep_research",
    domain: "test",
    answerShape: "deep_research_view",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "understand",
    confidence: 0.9,
    riskLevel: "general",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
  } as unknown as QueryClassification;

  it("the repeated substitute contributes no coverage; responded accounting stays truthful", async () => {
    mockDeepSeekKey = DS_KEY;
    deepSeekText(DEEP_RESEARCH_JSON);
    grokText(DEEP_RESEARCH_JSON);
    mockCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: [] }), latencyMs: 5 });
    mockOpenAICreate.mockRejectedValue(serverError());
    mockAnthropicCreate.mockRejectedValue(serverError());

    const results = await runPanel("Summarize research.", ["chatgpt", "claude", "grok"], { chatgpt: FAKE_KEY, claude: FAKE_KEY, grok: FAKE_KEY });
    expect(results.map((r) => r.status)).toEqual(["substituted", "substituted", "ok"]);
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.deep_research, results, "Summarize research.", undefined, CLASSIFICATION);

    const dr = output.deepResearch!;
    const findings = [...dr.findings, ...dr.lowConfidenceFindings];
    expect(findings).toHaveLength(1);
    expect([...findings[0].contributingModels].sort()).toEqual(["chatgpt", "grok"]);
    expect(findings[0].coverageCount).toBe(2);
    expect(findings[0].coverageRatio).toBeCloseTo(2 / 3);

    // Per-slot display/accounting unchanged: every substituted slot still responded.
    const meta = output.commonResponseMeta!;
    expect(meta.totalModels).toBe(3);
    expect(meta.successfulModels).toBe(3);
    expect(meta.modelsWithUsableOutput).toBe(3);
    const claude = output.adaptiveResults.find((r) => r.modelId === "claude")!;
    expect(claude.ok).toBe(true);
    expect(claude.parseError).toBeUndefined();
  });

  it("bias detection sees one voice for two DeepSeek substitutions → insufficient_models, no audit call", async () => {
    const rows = [
      { modelId: "chatgpt", status: "substituted", rawText: PANEL_TEXT, provider: "deepseek" },
      { modelId: "claude", status: "substituted", rawText: PANEL_TEXT, provider: "deepseek" },
    ] as unknown as ModelResult[];
    const out = await detectAdaptiveBiases("q", "deep_research", rows, ["chatgpt", "claude"]);
    expect(out.emptyReason).toBe("insufficient_models");
    expect(mockCallGemini).not.toHaveBeenCalled();
  });
});

describe("claim verification (no fallback path): both keys missing with DeepSeek configured", () => {
  it("both unconfigured rows are failed evidence; DeepSeek is never involved", async () => {
    mockDeepSeekKey = DS_KEY;
    grokText(JSON.stringify({ verdict: "accurate", confidence: "high", summary: "Correct.", correctParts: ["Paris"], incorrectParts: [], unverifiableParts: [], reasoning: "r" }));
    const modelResults = await runClaimVerificationPanel("Paris is the capital of France.", ["chatgpt", "claude", "grok"], {
      chatgpt: "",
      claude: undefined,
      grok: FAKE_KEY,
    });
    const evidence = buildClaimModelEvidence(modelResults);
    expect(evidence.map((e) => [e.modelId, e.status])).toEqual([
      ["chatgpt", "failed"],
      ["claude", "failed"],
      ["grok", "ok"],
    ]);
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
  });
});
