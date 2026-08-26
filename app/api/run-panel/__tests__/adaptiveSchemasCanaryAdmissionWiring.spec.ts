/**
 * Phase 9D.0-A — adaptive-schema canary admission ROUTE WIRING tests for
 * `/api/run-panel`, mirroring the equivalent Workspace-run-route coverage.
 * `resolveAdaptiveSchemasAdmission()` itself is left REAL (not mocked) so
 * this exercises genuine admission logic reading the mocked env getters,
 * not merely a mocked boolean. Minimal dependency mock set, following
 * this directory's established "one small wiring file per integration
 * point" convention (see createRunFailureRegression.spec.ts).
 */

let adaptiveSchemasEnabled = false;
let adaptiveSchemasCanaryUids: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  get ADAPTIVE_SCHEMAS_ENABLED() {
    return adaptiveSchemasEnabled;
  },
  get ADAPTIVE_SCHEMAS_CANARY_UIDS() {
    return adaptiveSchemasCanaryUids;
  },
}));

let authUid = "uid-legacy";
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: jest.fn().mockImplementation(() => Promise.resolve({ uid: authUid })),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: jest.fn(),
}));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }),
}));
jest.mock("@/lib/security/requestValidation", () => ({
  validateRunPanelRequest: jest.fn().mockReturnValue({ valid: true }),
  validateRequestBodySize: jest.fn().mockReturnValue({ valid: true }),
  MAX_REQUEST_BODY_SIZE: 1_000_000,
}));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({
  validateUserSubscription: jest.fn().mockResolvedValue(undefined),
}));

const mockedCheckAndIncrementUsage = jest.fn().mockResolvedValue({
  allowed: true,
  runsThisMonth: 1,
  maxRunsPerMonth: 100,
  maxModelsPerRun: 5,
  plan: "full",
});
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: any[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedCreateRun = jest.fn().mockResolvedValue(undefined);
const mockedCompleteRun = jest.fn().mockResolvedValue({ totalTokens: 0, tokensByProvider: {} });
const mockedMarkRunError = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/firestore/runs", () => ({
  createRun: (...args: any[]) => mockedCreateRun(...args),
  completeRun: (...args: any[]) => mockedCompleteRun(...args),
  markRunError: (...args: any[]) => mockedMarkRunError(...args),
}));

const mockedIncrementUserTokenUsage = jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() });
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: any[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedRunPanel = jest.fn().mockResolvedValue([
  { modelId: "chatgpt", status: "ok", rawText: "Nairobi is the capital of Kenya.", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
  { modelId: "claude", status: "ok", rawText: "The capital of Kenya is Nairobi.", latencyMs: 5, tokenUsage: { totalTokens: 12, promptTokens: 6, completionTokens: 6 } },
]);
jest.mock("@/lib/panel", () => ({
  runPanel: (...args: any[]) => mockedRunPanel(...args),
}));

const mockedPlanAdaptiveRun = jest.fn();
jest.mock("@/lib/adaptiveSchema/orchestrate", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/orchestrate");
  return {
    ...actual,
    planAdaptiveRun: (...args: any[]) => mockedPlanAdaptiveRun(...args),
  };
});

// Left REAL (not hand-mocked): every exported tracker is a never-throw
// safeCapture() wrapper around getPostHogClient() (mocked to throw below),
// so all of them safely no-op via their own internal catch — matching
// this route's own "a PostHog outage must not block a panel run" contract.
// A hand-picked mock object risks silently omitting a tracker the route
// calls (as first observed here), which is exactly the failure this
// avoids.

jest.mock("@/lib/posthog-server", () => ({
  getPostHogClient: jest.fn().mockImplementation(() => {
    throw new Error("PostHog not configured in test");
  }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/run-panel/route";

function buildRequest(question: string): NextRequest {
  return new NextRequest("http://localhost/api/run-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, selectedModels: ["chatgpt", "claude"] }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  adaptiveSchemasEnabled = false;
  adaptiveSchemasCanaryUids = undefined;
  authUid = "uid-legacy";
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
});

describe("POST /api/run-panel — Phase 9D.0-A adaptive schemas canary admission", () => {
  it("global=false, no canary, non-canary uid -> planAdaptiveRun NOT called; legacy pipeline executes exactly as today", async () => {
    const res = await POST(buildRequest("What is the capital of Kenya?"));
    expect(res.status).toBe(200);
    expect(mockedPlanAdaptiveRun).not.toHaveBeenCalled();
    expect(mockedRunPanel).toHaveBeenCalledTimes(1);
  });

  it("global=false, authenticated uid present in ADAPTIVE_SCHEMAS_CANARY_UIDS -> planAdaptiveRun IS called exactly once", async () => {
    authUid = "uid-canary";
    adaptiveSchemasCanaryUids = "other-uid,uid-canary";
    mockedPlanAdaptiveRun.mockResolvedValueOnce({
      classification: { queryType: "factual_lookup" },
      schema: { id: "factual_lookup" },
      promptOverrides: {},
      routing: { kind: "active", queryType: "factual_lookup", schema: { id: "factual_lookup" } },
    });
    const res = await POST(buildRequest("What is the capital of Kenya?"));
    expect(res.status).toBe(200);
    expect(mockedPlanAdaptiveRun).toHaveBeenCalledTimes(1);
  });

  it("global=false, uid NOT in canary list -> planAdaptiveRun NOT called, legacy pipeline executes (non-canary behavior unchanged for this route too)", async () => {
    authUid = "uid-legacy";
    adaptiveSchemasCanaryUids = "uid-a,uid-b,uid-c";
    const res = await POST(buildRequest("What is the capital of Kenya?"));
    expect(res.status).toBe(200);
    expect(mockedPlanAdaptiveRun).not.toHaveBeenCalled();
    expect(mockedRunPanel).toHaveBeenCalledTimes(1);
  });

  it("global=true still admits every uid regardless of canary list — backward-compatible regression proof", async () => {
    adaptiveSchemasEnabled = true;
    mockedPlanAdaptiveRun.mockResolvedValueOnce({
      classification: { queryType: "factual_lookup" },
      schema: { id: "factual_lookup" },
      promptOverrides: {},
      routing: { kind: "active", queryType: "factual_lookup", schema: { id: "factual_lookup" } },
    });
    const res = await POST(buildRequest("What is the capital of Kenya?"));
    expect(res.status).toBe(200);
    expect(mockedPlanAdaptiveRun).toHaveBeenCalledTimes(1);
  });
});
