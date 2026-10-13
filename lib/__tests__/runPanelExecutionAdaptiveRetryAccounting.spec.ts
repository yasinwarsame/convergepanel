/**
 * ADAPTIVE_RETRY_CORRECTION — executeOrdinaryRun() wiring of the
 * supplemental retry accounting (A2′): primary accounting order unchanged,
 * gates reflect what actually resolved, the request budget reaches the
 * retry, the sink is frozen before accounting, and no accounting failure can
 * fail the response.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
}));

const calls: string[] = [];
const mockedCompleteRun = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  completeRun: (...args: any[]) => {
    calls.push("completeRun");
    return mockedCompleteRun(...args);
  },
  markRunError: jest.fn().mockResolvedValue(undefined),
  persistAdaptiveOutput: jest.fn(),
  persistLegacyAdaptiveOutput: jest.fn(),
  readGovernanceRecordForInitialization: jest.fn(),
  persistAutomatedGovernanceUpdate: jest.fn(),
  writeAdaptiveGovernanceEvent: jest.fn(),
}));

const mockedIncrementUserTokenUsage = jest.fn();
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: any[]) => {
    calls.push("incrementUserTokenUsage");
    return mockedIncrementUserTokenUsage(...args);
  },
}));

const mockedApplyAccounting = jest.fn();
jest.mock("@/lib/firestore/adaptiveRetryAccounting", () => ({
  applyAdaptiveRetryAccounting: (...args: any[]) => {
    calls.push("applyAdaptiveRetryAccounting");
    return mockedApplyAccounting(...args);
  },
}));

const mockedFinalize = jest.fn();
jest.mock("@/lib/adaptiveSchema/orchestrate", () => ({
  finalizeAdaptiveRun: (...args: any[]) => {
    calls.push("finalizeAdaptiveRun");
    return mockedFinalize(...args);
  },
}));

const mockedTrackCompleted = jest.fn();
jest.mock("@/lib/adaptiveSchema/analytics", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/analytics");
  const stubs: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stubs[key] = typeof actual[key] === "function" ? jest.fn() : actual[key];
  stubs.trackPanelExecutionCompleted = (...args: any[]) => mockedTrackCompleted(...args);
  return stubs;
});

const mockedRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({ runPanel: (...args: any[]) => mockedRunPanel(...args) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/firestore/teamRuns", () => ({ createAdaptiveTeamRunProjection: jest.fn() }));
// No real Firebase Admin initialization (and no network) in this spec.
jest.mock("@/lib/firebase/admin", () => ({ adminDb: null, adminAuth: null, FIREBASE_PROJECT_ID: "test" }));

import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import type { AdaptiveRetryContext } from "@/lib/adaptiveSchema/orchestrate";

const REQUEST_BUDGET = { startedAtMonoMs: 4242, budgetMs: 300_000 };
const ADAPTIVE_RESULTS = [{ modelId: "claude", schemaId: "comparison_matrix", ok: true, data: { directConclusion: "x" }, retried: true, retryOutcome: "adopted_partial" }];

function args() {
  return {
    uid: "uid-1",
    runId: "run-1",
    trimmedQuestion: "Compare A and B",
    context: null,
    selectedModels: ["claude", "perplexity"] as any,
    adaptivePlan: {
      classification: { queryType: "comparison_matrix" } as any,
      schema: { id: "comparison_matrix", fields: [] } as any,
      promptOverrides: { claude: "P", perplexity: "P" },
      routing: { kind: "active" } as any,
    },
    debugRawResponseRequested: false,
    requestBudget: REQUEST_BUDGET,
  };
}

/** finalizeAdaptiveRun stand-in: records one retry's usage into the sink it was handed, like the real retry path. */
function finalizeRecordingRetry(opts: { throwAfter?: boolean } = {}) {
  return async (_schema: unknown, _results: unknown, _q: unknown, retryContext: AdaptiveRetryContext) => {
    retryContext.usageSink.record(0, "claude", { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    if (opts.throwAfter) throw new Error("aggregation exploded after the retry");
    return { schemaId: "comparison_matrix", adaptiveResults: ADAPTIVE_RESULTS };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockedRunPanel.mockResolvedValue([
    { modelId: "claude", status: "ok", rawText: "{}", latencyMs: 5, tokenUsage: { totalTokens: 50, promptTokens: 30, completionTokens: 20 } },
    { modelId: "perplexity", status: "ok", rawText: "{}", latencyMs: 5, tokenUsage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 } },
  ]);
  mockedCompleteRun.mockResolvedValue({ totalTokens: 80, tokensByProvider: { anthropic: 50, perplexity: 30 } });
  mockedIncrementUserTokenUsage.mockResolvedValue({ tokensUsedCurrentPeriod: 80, periodStart: new Date() });
  mockedApplyAccounting.mockResolvedValue({ status: "applied", userCounter: "applied" });
  mockedFinalize.mockImplementation(finalizeRecordingRetry());
});

describe("ordering and wiring", () => {
  it("primary accounting first, then adaptive finalization, then one supplemental accounting call", async () => {
    const result = await executeOrdinaryRun(args());
    expect(calls).toEqual(["completeRun", "incrementUserTokenUsage", "finalizeAdaptiveRun", "applyAdaptiveRetryAccounting"]);
    expect(result.status).toBe(200);
    expect(result.body.adaptive?.results).toEqual(ADAPTIVE_RESULTS);
  });

  it("the reset-aware user helper is called exactly once, with the primary total only", async () => {
    await executeOrdinaryRun(args());
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith("uid-1", 80);
  });

  it("hands the caller's request budget and a usage sink to the retry path", async () => {
    await executeOrdinaryRun(args());
    const retryContext = mockedFinalize.mock.calls[0][3] as AdaptiveRetryContext;
    expect(retryContext.budget).toBe(REQUEST_BUDGET);
    expect(retryContext.usageSink).toBeDefined();
  });

  it("passes the frozen retry usage and both gates", async () => {
    await executeOrdinaryRun(args());
    const [{ runId, uid, usage, gates }] = mockedApplyAccounting.mock.calls[0];
    expect({ runId, uid, gates }).toEqual({ runId: "run-1", uid: "uid-1", gates: { completeRunSucceeded: true, primaryUserAccountingSucceeded: true } });
    expect(usage).toMatchObject({ calls: 1, totals: { totalTokens: 30 } });
    const retryContext = mockedFinalize.mock.calls[0][3] as AdaptiveRetryContext;
    expect(retryContext.usageSink.isFrozen).toBe(true);
    expect(retryContext.usageSink.record(5, "grok", { promptTokens: 1, completionTokens: 1, totalTokens: 2 })).toBe(false);
  });

  it("primary analytics totalTokens is unchanged (primary panel results only)", async () => {
    await executeOrdinaryRun(args());
    expect(mockedTrackCompleted).toHaveBeenCalledWith("uid-1", expect.anything(), expect.objectContaining({ totalTokens: 80 }));
  });
});

describe("gates reflect what actually resolved", () => {
  it("completeRun failed → both gates false (the user helper never ran)", async () => {
    mockedCompleteRun.mockRejectedValueOnce(new Error("NOT_FOUND"));
    await executeOrdinaryRun(args());
    expect(mockedApplyAccounting.mock.calls[0][0].gates).toEqual({ completeRunSucceeded: false, primaryUserAccountingSucceeded: false });
  });

  it("primary user accounting failed → run gate true, user gate false", async () => {
    mockedIncrementUserTokenUsage.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    await executeOrdinaryRun(args());
    expect(mockedApplyAccounting.mock.calls[0][0].gates).toEqual({ completeRunSucceeded: true, primaryUserAccountingSucceeded: false });
  });

  it("primary total 0 still counts as a successful primary user accounting (retry usage is then added)", async () => {
    mockedRunPanel.mockResolvedValueOnce([
      { modelId: "claude", status: "ok", rawText: "{}", latencyMs: 5 },
      { modelId: "perplexity", status: "ok", rawText: "{}", latencyMs: 5 },
    ]);
    mockedCompleteRun.mockResolvedValueOnce({ totalTokens: 0, tokensByProvider: {} });
    await executeOrdinaryRun(args());
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith("uid-1", 0);
    expect(mockedApplyAccounting.mock.calls[0][0].gates.primaryUserAccountingSucceeded).toBe(true);
  });
});

describe("failure containment", () => {
  it("retry usage captured before an aggregation failure is still accounted; response still 200", async () => {
    mockedFinalize.mockImplementation(finalizeRecordingRetry({ throwAfter: true }));
    const result = await executeOrdinaryRun(args());
    expect(result.status).toBe(200);
    expect(result.body.adaptive).toBeUndefined();
    expect(mockedApplyAccounting.mock.calls[0][0].usage).toMatchObject({ totals: { totalTokens: 30 } });
  });

  it("supplemental accounting throwing never fails the response or the adaptive payload", async () => {
    mockedApplyAccounting.mockRejectedValueOnce(new Error("Firestore down"));
    const result = await executeOrdinaryRun(args());
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.adaptive?.results).toEqual(ADAPTIVE_RESULTS);
  });

  it("supplemental accounting resolving 'failed' is equally harmless", async () => {
    mockedApplyAccounting.mockResolvedValueOnce({ status: "failed" });
    const result = await executeOrdinaryRun(args());
    expect(result.status).toBe(200);
    expect(result.body.adaptive?.results).toEqual(ADAPTIVE_RESULTS);
  });

  it("a non-adaptive run never calls supplemental accounting", async () => {
    await executeOrdinaryRun({ ...args(), adaptivePlan: null });
    expect(mockedApplyAccounting).not.toHaveBeenCalled();
  });
});
