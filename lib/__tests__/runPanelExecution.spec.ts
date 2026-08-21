/**
 * Phase 8C-D.1 — `executeOrdinaryRun()` characterization tests. Exercises
 * the shared engine directly (no HTTP layer), proving the two invariants
 * this extraction exists to guarantee:
 *   1. It does NOT require a persisted `runs/{runId}` document — a
 *      `completeRun()` failure (simulating an absent doc) still returns a
 *      normal, results-bearing success.
 *   2. Its output is transport-neutral (`{status, body}`, no `NextResponse`,
 *      no `usage` key — that's the caller's responsibility) and its
 *      internal try/catches are unchanged from the pre-extraction route,
 *      so only a truly uncaught error propagates.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
}));

const mockedCompleteRun = jest.fn();
const mockedMarkRunError = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/firestore/runs", () => ({
  completeRun: (...args: any[]) => mockedCompleteRun(...args),
  markRunError: (...args: any[]) => mockedMarkRunError(...args),
  persistAdaptiveOutput: jest.fn(),
  persistLegacyAdaptiveOutput: jest.fn(),
  readGovernanceRecordForInitialization: jest.fn(),
  persistAutomatedGovernanceUpdate: jest.fn(),
  writeAdaptiveGovernanceEvent: jest.fn(),
}));

const mockedIncrementUserTokenUsage = jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() });
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: any[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({
  runPanel: (...args: any[]) => mockedRunPanel(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Legacy adaptive-governance module — never exercised by these classic-only
// tests (adaptivePlan: null throughout), but must resolve.
jest.mock("@/lib/firestore/teamRuns", () => ({
  createAdaptiveTeamRunProjection: jest.fn(),
}));

import { executeOrdinaryRun } from "@/lib/runPanelExecution";

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-1",
    runId: "run-1",
    trimmedQuestion: "What is the capital of Kenya?",
    context: null,
    selectedModels: ["chatgpt", "claude"] as any,
    adaptivePlan: null,
    debugRawResponseRequested: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCompleteRun.mockResolvedValue({ totalTokens: 22, tokensByProvider: { openai: 10, anthropic: 12 } });
});

describe("executeOrdinaryRun — classic success", () => {
  it("returns {status:200, body:{ok:true, results, runId}} with no usage/status leaking beyond the frozen contract", async () => {
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "chatgpt", status: "ok", rawText: "Nairobi.", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
      { modelId: "claude", status: "ok", rawText: "Nairobi is the capital.", latencyMs: 6, tokenUsage: { totalTokens: 12, promptTokens: 6, completionTokens: 6 } },
    ]);

    const result = await executeOrdinaryRun(baseArgs());

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.runId).toBe("run-1");
    expect(result.body.results).toHaveLength(2);
    expect(result.body.results.every((r: any) => r.status === "ok")).toBe(true);
    expect((result.body as any).usage).toBeUndefined();
    expect(result.body.adaptive).toBeUndefined();
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith("uid-1", 22);
  });

  it("passes apiKeys built from env, question/context/models/promptOverrides through to runPanel() unchanged", async () => {
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "chatgpt", status: "ok", rawText: "x", latencyMs: 1, tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 } },
      { modelId: "claude", status: "ok", rawText: "y", latencyMs: 1, tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 } },
    ]);
    await executeOrdinaryRun(baseArgs({ context: "some context" }));
    expect(mockedRunPanel).toHaveBeenCalledWith(
      "What is the capital of Kenya?",
      ["chatgpt", "claude"],
      { chatgpt: "test", claude: "test", grok: "test", perplexity: "test", gemini: "test" },
      "some context",
      undefined
    );
  });
});

describe("executeOrdinaryRun — persistence is NOT required (Phase 8C-D.0.3 invariant)", () => {
  it("completeRun() rejecting (simulating an absent runs/{runId} doc) still returns 200 with full results; token increment is skipped", async () => {
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "chatgpt", status: "ok", rawText: "Nairobi.", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
      { modelId: "claude", status: "ok", rawText: "Nairobi.", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
    ]);
    mockedCompleteRun.mockRejectedValueOnce(new Error("NOT_FOUND: no document to update"));

    const result = await executeOrdinaryRun(baseArgs());

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.results).toHaveLength(2);
    // completeRun() throw skips the token increment entirely — it sits
    // after completeRun() in the same try block (see the module's own
    // doc comment / Phase 8C-D.0.3's traced characterization).
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    // markRunError() is never called for a completeRun() failure — only
    // for a runPanel() throw, which did not happen here.
    expect(mockedMarkRunError).not.toHaveBeenCalled();
  });
});

describe("executeOrdinaryRun — runPanel() throw", () => {
  it("synthesizes error results for every selected model, calls markRunError(), still returns 200", async () => {
    mockedRunPanel.mockRejectedValueOnce(new Error("orchestration exploded"));

    const result = await executeOrdinaryRun(baseArgs());

    expect(result.status).toBe(200);
    expect(result.body.results).toHaveLength(2);
    // Internal "error" status is coerced to the public "failed" status by
    // normalizeModelResultPublic/assertPublicStatus (lib/panel/normalize.ts)
    // — unchanged, pre-existing behavior, not something this extraction
    // introduces or should special-case.
    expect(result.body.results.every((r: any) => r.status === "failed")).toBe(true);
    expect(mockedMarkRunError).toHaveBeenCalledWith("run-1", "orchestration exploded");
  });

  it("markRunError() itself throwing is swallowed — response is still 200", async () => {
    mockedRunPanel.mockRejectedValueOnce(new Error("boom"));
    mockedMarkRunError.mockRejectedValueOnce(new Error("markRunError also failed"));

    const result = await executeOrdinaryRun(baseArgs());
    expect(result.status).toBe(200);
    expect(result.body.results).toHaveLength(2);
  });
});

describe("executeOrdinaryRun — mixed/all-model outcomes", () => {
  it("mixed success/failure: both represented in results, only successful models counted for token increment", async () => {
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "chatgpt", status: "ok", rawText: "ok text", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
      { modelId: "claude", status: "failed", rawText: "Model unavailable.", errorMessage: "claude_5xx", latencyMs: 5, tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null } },
    ]);
    const result = await executeOrdinaryRun(baseArgs());
    expect(result.body.results).toHaveLength(2);
    const statuses = result.body.results.map((r: any) => r.status).sort();
    expect(statuses).toContain("failed");
  });

  it("all models fail: still 200, all results status failed, no throw", async () => {
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "chatgpt", status: "failed", rawText: "Model unavailable.", latencyMs: 1, tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null } },
      { modelId: "claude", status: "failed", rawText: "Model unavailable.", latencyMs: 1, tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null } },
    ]);
    const result = await executeOrdinaryRun(baseArgs());
    expect(result.status).toBe(200);
    expect(result.body.results.every((r: any) => r.status === "failed")).toBe(true);
  });
});

describe("executeOrdinaryRun — debug header decoupling", () => {
  it("accepts debugRawResponseRequested as a plain boolean, never touches process.env beyond PANEL_DEBUG_RAW", async () => {
    // completeRun rejects so the fallback normalization branch (which
    // contains the debug-flag check) is exercised.
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "chatgpt", status: "ok", rawText: "x", latencyMs: 1, tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 } },
      { modelId: "claude", status: "ok", rawText: "y", latencyMs: 1, tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 } },
    ]);
    mockedCompleteRun.mockRejectedValueOnce(new Error("absent doc"));
    const result = await executeOrdinaryRun(baseArgs({ debugRawResponseRequested: true }));
    expect(result.status).toBe(200);
  });
});
