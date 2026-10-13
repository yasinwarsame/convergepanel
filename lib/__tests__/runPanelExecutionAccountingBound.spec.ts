/**
 * ADAPTIVE_RETRY_CORRECTION hardening — a stalled supplemental accounting
 * transaction can never hold the research response beyond the bounded
 * foreground wait. Runs the REAL executeOrdinaryRun() and the REAL
 * applyAdaptiveRetryAccounting() against a Firestore whose transaction never
 * settles; fake timers, no real sleeps.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
}));

const mockedCompleteRun = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  completeRun: (...args: any[]) => mockedCompleteRun(...args),
  markRunError: jest.fn().mockResolvedValue(undefined),
  persistAdaptiveOutput: jest.fn(),
  persistLegacyAdaptiveOutput: jest.fn(),
  readGovernanceRecordForInitialization: jest.fn(),
  persistAutomatedGovernanceUpdate: jest.fn(),
  writeAdaptiveGovernanceEvent: jest.fn(),
}));

const mockedIncrementUserTokenUsage = jest.fn();
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: any[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedFinalize = jest.fn();
jest.mock("@/lib/adaptiveSchema/orchestrate", () => ({
  finalizeAdaptiveRun: (...args: any[]) => mockedFinalize(...args),
}));

jest.mock("@/lib/adaptiveSchema/analytics", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/analytics");
  const stubs: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stubs[key] = typeof actual[key] === "function" ? jest.fn() : actual[key];
  return stubs;
});

const mockedRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({ runPanel: (...args: any[]) => mockedRunPanel(...args) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/firestore/teamRuns", () => ({ createAdaptiveTeamRunProjection: jest.fn() }));

/** A Firestore whose supplemental transaction never settles on its own. */
const transactionCalls: Array<{ fn: (txn: any) => Promise<unknown>; options: unknown }> = [];
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    runTransaction: (fn: (txn: any) => Promise<unknown>, options: unknown) => {
      transactionCalls.push({ fn, options });
      return new Promise(() => undefined);
    },
    collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
  },
  adminAuth: null,
  FIREBASE_PROJECT_ID: "test",
}));

import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import type { AdaptiveRetryContext } from "@/lib/adaptiveSchema/orchestrate";
import { ADAPTIVE_RETRY_ACCOUNTING_WAIT_MS } from "@/lib/adaptiveSchema/retryBudget";

const ADAPTIVE_RESULTS = [
  { modelId: "claude", schemaId: "comparison_matrix", ok: true, data: { directConclusion: "corrected" }, retried: true, retryOutcome: "adopted_full" },
];

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
    requestBudget: { startedAtMonoMs: performance.now(), budgetMs: 300_000 },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  transactionCalls.length = 0;
  mockedRunPanel.mockResolvedValue([
    { modelId: "claude", status: "ok", rawText: "{}", latencyMs: 5, tokenUsage: { totalTokens: 50, promptTokens: 30, completionTokens: 20 } },
    { modelId: "perplexity", status: "ok", rawText: "{}", latencyMs: 5, tokenUsage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 } },
  ]);
  mockedCompleteRun.mockResolvedValue({ totalTokens: 80, tokensByProvider: { anthropic: 50, perplexity: 30 } });
  mockedIncrementUserTokenUsage.mockResolvedValue({ tokensUsedCurrentPeriod: 80, periodStart: new Date() });
  mockedFinalize.mockImplementation(async (_s: unknown, _r: unknown, _q: unknown, retryContext: AdaptiveRetryContext) => {
    retryContext.usageSink.record(0, "claude", { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    return { schemaId: "comparison_matrix", adaptiveResults: ADAPTIVE_RESULTS };
  });
});

afterEach(() => jest.useRealTimers());

it("a never-settling accounting transaction delays the response by at most the bounded wait, then the full response returns", async () => {
  let settled: any = "pending";
  const pending = executeOrdinaryRun(args()).then((r) => (settled = r));

  await jest.advanceTimersByTimeAsync(ADAPTIVE_RETRY_ACCOUNTING_WAIT_MS - 1);
  expect(settled).toBe("pending"); // still inside the foreground wait
  expect(transactionCalls).toHaveLength(1);

  await jest.advanceTimersByTimeAsync(1);
  await pending;

  // Response returned, successful, with the adaptive result and primary results intact.
  expect(settled.status).toBe(200);
  expect(settled.body.ok).toBe(true);
  expect(settled.body.results).toHaveLength(2);
  expect(settled.body.adaptive.results).toEqual(ADAPTIVE_RESULTS);
  // Primary accounting ran exactly as before.
  expect(mockedCompleteRun).toHaveBeenCalledTimes(1);
  expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith("uid-1", 80);
  // One supplemental transaction, single attempt, never restarted after the wait expired.
  expect(transactionCalls).toEqual([{ fn: expect.any(Function), options: { maxAttempts: 1 } }]);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(transactionCalls).toHaveLength(1);
  // Nothing late can reach the already-returned adaptive result.
  expect(settled.body.adaptive.results).toEqual(ADAPTIVE_RESULTS);
});
