/**
 * Query-Routing Redesign, Milestone 1.5 — narrow HTTP-level proof.
 *
 * The library-level tests (lib/adaptiveSchema/__tests__/panelExecutionGuard.spec.ts)
 * prove routeClassifiedQuery()/planAdaptiveRun() make the right decision.
 * This file proves the ROUTE itself actually acts on that decision — every
 * side-effecting dependency (auth, rate limit, request validation,
 * subscription check, quota increment, run persistence, the panel runner,
 * token/PostHog side effects) is mocked, per the explicit guidance that this
 * doesn't need to reproduce the full auth/Firestore environment. Three
 * things only:
 *   1. A handoff classification returns before checkAndIncrementUsageForRun.
 *   2. A disabled classification returns before createRun.
 *   3. An active classification reaches runPanel.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  ADAPTIVE_SCHEMAS_ENABLED: true,
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
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
}));

// rawText must be valid JSON matching factual_lookup's schema — otherwise
// finalizeAdaptiveRun's validator fails and its one-shot retry path calls
// the REAL (unmocked) CONNECTOR_MAP directly, reaching out to actual
// OpenAI/Anthropic endpoints with a fake key. Valid output here keeps this
// test hermetic.
const FACTUAL_LOOKUP_JSON = JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" });
const mockedRunPanel = jest.fn().mockResolvedValue([
  { modelId: "chatgpt", status: "ok", rawText: FACTUAL_LOOKUP_JSON, latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
  { modelId: "claude", status: "ok", rawText: FACTUAL_LOOKUP_JSON, latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
]);
jest.mock("@/lib/panel", () => ({
  runPanel: (...args: any[]) => mockedRunPanel(...args),
}));

jest.mock("@/lib/posthog-server", () => ({
  getPostHogClient: jest.fn().mockImplementation(() => {
    throw new Error("PostHog not configured in test");
  }),
}));

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

import { callGemini } from "@/lib/connectors/gemini";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/run-panel/route";

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

function classificationJson(queryType: string) {
  return JSON.stringify({
    queryType,
    domain: "test",
    answerShape: "generic_sections",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    clarificationQuestion: null,
    rationale: "test fixture",
  });
}

function buildRequest(question: string): NextRequest {
  return new NextRequest("http://localhost/api/run-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, selectedModels: ["chatgpt", "claude"] }),
  });
}

describe("POST /api/run-panel — Milestone 1.5 pre-execution guard", () => {
  afterEach(() => jest.clearAllMocks());

  it("a Claim Verification handoff returns before checkAndIncrementUsageForRun (and before createRun/runPanel)", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "ok",
      rawText: classificationJson("claim_verification"),
      latencyMs: 5,
    });

    const response = await POST(buildRequest("The unemployment rate is 4.2%. Is this true?"));
    const body = await response.json();

    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedCreateRun).not.toHaveBeenCalled();
    expect(mockedRunPanel).not.toHaveBeenCalled();
    expect(body.ok).toBe(true);
    expect(body.runId).toBeNull();
    expect(body.adaptive.routingOutcome).toBe("handoff");
    expect(body.adaptive.modelsInvoked).toBe(0);
  });

  it("a disabled schema (document_qa) returns before createRun (and before runPanel) — quota check may still run, since it happens before routing in today's ordering is irrelevant here: it must not reach createRun/runPanel", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "ok",
      rawText: classificationJson("document_qa"),
      latencyMs: 5,
    });

    const response = await POST(buildRequest("What does this contract say about termination?"));
    const body = await response.json();

    expect(mockedCreateRun).not.toHaveBeenCalled();
    expect(mockedRunPanel).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(body.ok).toBe(true);
    expect(body.adaptive.routingOutcome).toBe("capability_gap");
    expect(body.adaptive.modelsInvoked).toBe(0);
  });

  it("an active schema (factual_lookup) reaches runPanel", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "ok",
      rawText: classificationJson("factual_lookup"),
      latencyMs: 5,
    });

    await POST(buildRequest("What is the capital of Kenya?"));

    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    expect(mockedRunPanel).toHaveBeenCalledTimes(1);
  });
});
