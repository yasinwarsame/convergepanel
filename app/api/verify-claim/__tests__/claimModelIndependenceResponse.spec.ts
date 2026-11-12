/**
 * Review of 262ef64, MAJOR B1 — the LIVE claim result (the response the result view renders right after a verification
 * completes) carries `modelIndependence`, judged from the rows just persisted exactly as a later read of the record
 * judges them (storedVerificationConsensusIndependence). The stored document is unchanged (no new field persisted).
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
}));

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: jest.fn().mockResolvedValue({ uid: "uid-1", isAdmin: false }),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: jest.fn(),
}));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }),
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

function modelResult(modelId: string, verdict: string) {
  return {
    modelId,
    status: "ok",
    rawText: JSON.stringify({
      verdict,
      confidence: "high",
      summary: "test summary",
      correctParts: ["part a"],
      incorrectParts: [],
      unverifiableParts: [],
      reasoning: "test reasoning",
    }),
    latencyMs: 5,
    tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
  };
}

const mockedRunClaimVerificationPanel = jest.fn().mockResolvedValue([
  modelResult("claude", "accurate"),
  modelResult("chatgpt", "accurate"),
  modelResult("gemini", "accurate"),
  modelResult("grok", "accurate"),
  modelResult("perplexity", "accurate"),
]);
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({
  runClaimVerificationPanel: (...args: any[]) => mockedRunClaimVerificationPanel(...args),
}));

const mockedSaveClaimVerification = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/firestore/verifications", () => {
  const actual = jest.requireActual("@/lib/firestore/verifications");
  return {
    ...actual,
    saveClaimVerification: (...args: any[]) => mockedSaveClaimVerification(...args),
  };
});

const mockedIncrementUserTokenUsage = jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() });
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: any[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedEvaluateAndStoreGovernance = jest.fn().mockResolvedValue(null);
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: any[]) => mockedEvaluateAndStoreGovernance(...args),
}));

jest.mock("@/lib/governance/teamGovernancePipeline", () => ({
  applyTeamGovernancePipeline: jest.fn().mockResolvedValue({}),
  mergeGovernanceIntoBody: (body: unknown) => body,
}));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ email: "user@example.com" }) }),
      }),
    }),
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/verify-claim/route";

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/verify-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "__session=valid" },
    body: JSON.stringify(body),
  });
}
const failed = (modelId: string) => ({ modelId, status: "error", errorMessage: "boom", latencyMs: 1 });
const substituted = (modelId: string) => ({ ...modelResult(modelId, "accurate"), status: "substituted", provider: "deepseek" });

describe("POST /api/verify-claim — modelIndependence on the live result", () => {
  afterEach(() => jest.clearAllMocks());

  it.each([
    // C-b (CB-01/CB-02/CB-03): an own-provider answer is stored without a provider (buildClaimModelEvidence, m-B), so
    // the shared gate cannot verify who executed it: unverified — never presented as one model's assessment or as
    // agreement. (Was "insufficient" / "independent" before the gate.)
    ["one of three requested models responded", [modelResult("chatgpt", "accurate"), failed("claude"), failed("grok")], ["chatgpt", "claude", "grok"], "unverified"],
    ["two slots answered by the DeepSeek fallback", [substituted("chatgpt"), substituted("claude")], ["chatgpt", "claude"], "insufficient"],
    ["two own-provider answers (no recorded provider)", [modelResult("chatgpt", "accurate"), modelResult("claude", "inaccurate")], ["chatgpt", "claude"], "unverified"],
    ["every requested model failed", [failed("chatgpt"), failed("claude")], ["chatgpt", "claude"], "unverified"],
    ["a substitute without a recorded provider in two slots", [{ ...substituted("chatgpt"), provider: undefined }, { ...substituted("claude"), provider: undefined }], ["chatgpt", "claude"], "unverified"],
  ])("%s", async (_label, results, models, expected) => {
    mockedRunClaimVerificationPanel.mockResolvedValueOnce(results);
    const res = await POST(buildRequest({ claim: "A claim.", models }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.modelIndependence).toBe(expected);
    // The stored score is still returned (and persisted) unchanged; only its presentation depends on independence.
    expect(typeof body.consensusScore).toBe("number");
    const saved = mockedSaveClaimVerification.mock.calls[0][1];
    expect(saved.consensusScore).toBe(body.consensusScore);
    expect("modelIndependence" in saved).toBe(false);
  });
});
