/**
 * Phase 8C-D.0.3 / 8C-D.1 — permanent regression proving the exact
 * Personal compatibility contract uncovered during the shared-execution
 * architecture audit: `createRun()` is best-effort. When it rejects,
 * `/api/run-panel` must still proceed into `runPanel()` and return a
 * normal 200 with the executed results — exactly as it did before the
 * `lib/runPanelExecution.ts` extraction.
 *
 * Traced from source (not assumed):
 *   - `completeRun()` is called from inside the same try/catch as the
 *     token-usage increment (`catch (tokenError)`), and `panelResultsPublic`
 *     is assigned to an outer-scoped variable BEFORE `completeRun()` is
 *     even called — so a `completeRun()` failure (e.g. `.update()` on a
 *     document that was never created) leaves `results` intact in the
 *     response but skips `incrementUserTokenUsage()` entirely (it sits
 *     after `completeRun()` in the same try block).
 *   - `usage` in the response comes from `checkAndIncrementUsageForRun()`,
 *     called long before `createRun()`, and is therefore unaffected.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  ADAPTIVE_SCHEMAS_ENABLED: false,
}));

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: jest.fn().mockResolvedValue({ uid: "test-uid" }),
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
  runsThisMonth: 3,
  maxRunsPerMonth: 100,
  maxModelsPerRun: 5,
  plan: "full",
});
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: any[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedCreateRun = jest.fn().mockRejectedValue(new Error("Firestore write failed"));
const mockedCompleteRun = jest.fn().mockRejectedValue(new Error("NOT_FOUND: no document to update"));
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

describe("POST /api/run-panel — createRun() best-effort failure (Phase 8C-D.0.3 compatibility contract)", () => {
  afterEach(() => jest.clearAllMocks());

  it("createRun() rejects -> runPanel() is still called, response is 200 with full results and usage, token increment is skipped because completeRun() subsequently fails on the absent document", async () => {
    const response = await POST(buildRequest("What is the capital of Kenya?"));
    const body = await response.json();

    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    // Execution proceeds despite the createRun() rejection above.
    expect(mockedRunPanel).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: any) => r.modelId).sort()).toEqual(["chatgpt", "claude"]);
    expect(body.results.every((r: any) => r.status === "ok")).toBe(true);

    // usage comes from checkAndIncrementUsageForRun(), unaffected by the
    // createRun()/completeRun() failures below it.
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(body.usage).toEqual({ runsThisMonth: 3, maxRunsPerMonth: 100, maxModelsPerRun: 5 });

    // completeRun() was attempted (and rejected, simulating the absent
    // document) — traced: it sits inside the same try/catch as the token
    // increment, before the increment call, so a completeRun() throw skips
    // incrementUserTokenUsage() entirely without affecting the response.
    expect(mockedCompleteRun).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();

    // No new Workspace behavior: markRunError() is never called for a
    // completeRun()/createRun() failure — only for a runPanel() throw,
    // which did not happen here.
    expect(mockedMarkRunError).not.toHaveBeenCalled();

    // No quota refund/decrement of any kind — checkAndIncrementUsageForRun
    // was called exactly once, already asserted above.
  });
});
