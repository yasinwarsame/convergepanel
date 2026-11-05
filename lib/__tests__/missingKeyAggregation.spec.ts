/**
 * Fail-closed provider configuration — aggregation regression.
 *
 * A connector with a missing key used to return a fabricated `status: "ok"`
 * ("Mock response from claude (no API key configured)"), which counted as a
 * responding model in agreement/consensus, in model-response counts and toward
 * the ≥2-response synthesis rule. These tests drive the REAL panel runner
 * (lib/panel.ts runPanel), the REAL ChatGPT/Claude connectors (only the provider
 * SDKs are doubles), and the REAL aggregation functions, with Claude's key
 * missing, and assert the unconfigured model is excluded everywhere.
 *
 * No real provider call is ever made: the OpenAI/Anthropic SDKs, the Grok and
 * Gemini connectors, and DeepSeek are doubles.
 */
const mockOpenAICreate = jest.fn();
const mockOpenAICtor = jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } }));
jest.mock("openai", () => ({ __esModule: true, default: function OpenAI(...a: unknown[]) { return mockOpenAICtor(...a); } }));

const mockAnthropicCtor = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: function Anthropic(...a: unknown[]) { return mockAnthropicCtor(...a); } }));

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
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import type { QueryClassification } from "@/lib/adaptiveSchema/types";
import { runClaimVerificationPanel } from "@/lib/verification/runClaimVerificationPanel";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { computeConsensusScoring } from "@/lib/verification/consensusScoring";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";
import type { ModelResult } from "@/lib/types";
import { logger } from "@/lib/logger";

const FAKE_KEY = "sk-FAKE-test-key-never-real-0000";
const MISSING_CLAUDE_KEY = "   "; // whitespace-only: the case the old `!apiKey` guard let through to the SDK

const PANEL_TEXT =
  "Paris is the capital of France. The city has been the seat of the French government for centuries. " +
  "It is located on the Seine river in northern France. Paris is the most populous city in France.";

function openAIText(text: string) {
  mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}
function grokText(text: string) {
  mockCallGrok.mockResolvedValue({ modelId: "grok", status: "ok", rawText: text, latencyMs: 5 } satisfies ModelResult);
}

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

describe("runPanel — an unconfigured model is a typed failure, not a response", () => {
  it("claude with a missing key → failed slot carrying errorCode + not_configured reason; no SDK, no retry, no fallback", async () => {
    openAIText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    const results = await runPanel("What is the capital of France?", ["chatgpt", "claude", "grok"], {
      chatgpt: FAKE_KEY,
      claude: MISSING_CLAUDE_KEY,
      grok: FAKE_KEY,
    });

    const byId = Object.fromEntries(results.map((r) => [r.modelId, r]));
    expect(byId.chatgpt.status).toBe("ok");
    expect(byId.grok.status).toBe("ok");

    expect(byId.claude.status).toBe("failed");
    expect(byId.claude.errorCode).toBe("provider_not_configured");
    expect(byId.claude.substitutionReason).toBe("anthropic_not_configured");
    expect(byId.claude.errorMessage).toBe("Claude (Anthropic) is not available: ANTHROPIC_API_KEY is not configured.");
    expect(byId.claude.rawText).not.toMatch(/mock/i);
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
    expect(mockCallDeepSeek).not.toHaveBeenCalled(); // no DeepSeek key configured in this test
    // Exactly one connector invocation for claude: a configuration gap is not retried.
    const notConfiguredWarns = (logger.warn as jest.Mock).mock.calls.filter(
      (c) => (c[1] as { modelId?: string } | undefined)?.modelId === "claude"
    );
    expect(notConfiguredWarns).toHaveLength(1);
  });

  it("with DeepSeek configured, the slot is HONESTLY substituted (labelled, reason anthropic_not_configured) — never a claude 'ok'", async () => {
    mockDeepSeekKey = "ds-FAKE";
    mockCallDeepSeek.mockResolvedValue({ ok: true, text: PANEL_TEXT, latencyMs: 3, actualModel: "deepseek-chat" });
    openAIText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude"], { chatgpt: FAKE_KEY, claude: undefined });
    const claude = results.find((r) => r.modelId === "claude")!;
    expect(claude.status).toBe("substituted");
    expect(claude.provider).toBe("deepseek");
    expect(claude.substitutedFrom).toBe("anthropic:claude-haiku-4-5-20251001");
    expect(claude.substitutionReason).toBe("anthropic_not_configured");
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });

  it("DeepSeek fallback also failing → failed slot keeps the typed errorCode", async () => {
    mockDeepSeekKey = "ds-FAKE";
    mockCallDeepSeek.mockResolvedValue({ ok: false, code: "deepseek_5xx", retryable: false, message: "x", latencyMs: 1 });
    openAIText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude"], { chatgpt: FAKE_KEY, claude: "" });
    const claude = results.find((r) => r.modelId === "claude")!;
    expect(claude.status).toBe("failed");
    expect(claude.errorCode).toBe("provider_not_configured");
    expect(claude.substitutionReason).toBe("anthropic_not_configured|deepseek_5xx");
  });
});

describe("consensus / agreement / trust summary (lib/consensus.ts synthesizeReport)", () => {
  it("excludes the unconfigured model from every agreement cluster and consensus finding", async () => {
    openAIText(PANEL_TEXT);
    grokText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude", "grok"], { chatgpt: FAKE_KEY, claude: MISSING_CLAUDE_KEY, grok: FAKE_KEY });
    const report = synthesizeReport(results);
    expect(report).not.toBeNull();
    const analysis = report!.consensusAnalysis!;
    const clusterModelIds = analysis.agreementClusters!.flatMap((c) => c.modelIds);
    expect(clusterModelIds.length).toBeGreaterThan(0);
    expect(new Set(clusterModelIds)).toEqual(new Set(["chatgpt", "grok"]));
    expect(analysis.consensusFindings!.length).toBeGreaterThan(0);
    for (const f of analysis.consensusFindings!) expect(f.modelIds).not.toContain("claude");
    expect(analysis.trustSummary.strongConsensus).toBe(analysis.consensusFindings!.length);
  });

  it("one real response + one unconfigured model → no synthesis (the ≥2-responses rule is not satisfied by a missing key)", async () => {
    openAIText(PANEL_TEXT);
    const results = await runPanel("q", ["chatgpt", "claude"], { chatgpt: FAKE_KEY, claude: undefined });
    expect(synthesizeReport(results)).toBeNull();
  });
});

describe("adaptive research: model-response counts and source coverage (finalizeAdaptiveRun → buildCommonResponseMeta)", () => {
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
  const CLASSIFICATION: QueryClassification = {
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

  it("counts the unconfigured model as failed, never successful, and keeps it out of finding coverage", async () => {
    openAIText(DEEP_RESEARCH_JSON);
    grokText(DEEP_RESEARCH_JSON);
    mockCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: [] }), latencyMs: 5 });

    const results = await runPanel("Summarize research.", ["chatgpt", "claude", "grok"], {
      chatgpt: FAKE_KEY,
      claude: MISSING_CLAUDE_KEY,
      grok: FAKE_KEY,
    });
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.deep_research, results, "Summarize research.", undefined, CLASSIFICATION);

    const meta = output.commonResponseMeta!;
    expect(meta.totalModels).toBe(3);
    expect(meta.successfulModels).toBe(2);
    expect(meta.failedModels).toBe(1);
    expect(meta.modelsWithUsableOutput).toBe(2);
    expect(meta.executionStatus).toBe("partial");

    const claudeAdaptive = output.adaptiveResults.find((r) => r.modelId === "claude")!;
    expect(claudeAdaptive.ok).toBe(false);

    // Coverage counts only models that actually answered; the denominator is the selected panel (3),
    // so the unconfigured model lowers coverageRatio instead of inflating agreement.
    const dr = output.deepResearch!;
    const allFindings = [...dr.findings, ...dr.lowConfidenceFindings];
    expect(allFindings).toHaveLength(1);
    expect([...allFindings[0].contributingModels].sort()).toEqual(["chatgpt", "grok"]);
    expect(allFindings[0].coverageCount).toBe(2);
    expect(allFindings[0].coverageRatio).toBeCloseTo(2 / 3);
    expect(output.deepResearch!.sourceCoverage).toEqual({ findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 });
  });
});

describe("claim verification (runClaimVerificationPanel → evidence → verdict → consensus scoring)", () => {
  it("an unconfigured model is a failed row: not healthy, not usable, no verdict", async () => {
    openAIText(JSON.stringify({ verdict: "accurate", confidence: "high", summary: "Correct.", correctParts: ["Paris"], incorrectParts: [], unverifiableParts: [], reasoning: "r" }));
    grokText(JSON.stringify({ verdict: "accurate", confidence: "high", summary: "Correct.", correctParts: ["Paris"], incorrectParts: [], unverifiableParts: [], reasoning: "r" }));

    const modelResults = await runClaimVerificationPanel("Paris is the capital of France.", ["chatgpt", "claude", "grok"], {
      chatgpt: FAKE_KEY,
      claude: MISSING_CLAUDE_KEY,
      grok: FAKE_KEY,
    });
    const rawClaude = modelResults.find((r) => r.modelId === "claude")!;
    expect(rawClaude.status).toBe("error");
    expect(rawClaude.errorCode).toBe("provider_not_configured");
    expect(rawClaude.rawText).toBeNull();

    const evidence = buildClaimModelEvidence(modelResults);
    const claude = evidence.find((m) => m.modelId === "claude")!;
    expect(claude.status).toBe("failed");
    expect(claude.verdict).toBe("failed");

    const rows = evidence.map((m) => ({
      status: m.status as "ok" | "parse_error" | "failed",
      verdict: m.status === "ok" ? (m.verdict as ModelVerdict) : undefined,
      confidence: m.status === "ok" ? (m.confidence as "high" | "medium" | "low") : undefined,
    }));
    const verdict = computeClaimVerdict(rows);
    expect(verdict).toBe("confirmed");
    const scoring = computeConsensusScoring({ mode: "verification", modelRows: rows, aggregateVerdict: verdict });
    expect(scoring.summary.modelCount).toBe(3);
    expect(scoring.summary.modelsHealthy).toBe(2);
    expect(scoring.summary.lowEvidenceClaims).toBe(0); // a config failure is not a parse_error either
  });
});
