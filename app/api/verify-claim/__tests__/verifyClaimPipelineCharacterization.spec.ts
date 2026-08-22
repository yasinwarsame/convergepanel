/**
 * Phase 8C-E.1 — full-pipeline characterization test for
 * `POST /api/verify-claim`, added specifically to cover the mechanical
 * extraction of the per-model JSON-parse/repair orchestration into
 * `lib/verification/buildClaimModelEvidence.ts` (previously inline route
 * code with zero test coverage — the pre-existing
 * `verifyClaimAuthRegression.spec.ts` deliberately stops at the rate-limit
 * gate and never reaches this logic). This suite exercises the real
 * business-logic path end to end (mocking only Firestore/model/env
 * boundaries), proving the extraction changed nothing observable.
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
// Deliberately the REAL, unmocked implementations — used only to prove the
// fixture below genuinely exercises the repair path (Phase 8C-E.1.2),
// never to mock buildClaimModelEvidence() or anything it calls.
import { cleanJsonResponse, repairTruncatedJson } from "@/lib/verification/cleanJsonResponse";

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/verify-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "__session=valid" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/verify-claim — full pipeline characterization (Phase 8C-E.1 extraction proof)", () => {
  afterEach(() => jest.clearAllMocks());

  it("default 5-model claim -> 200, well-formed modelEvidence built via the extracted buildClaimModelEvidence(), verificationId, consensus fields, usage", async () => {
    const res = await POST(buildRequest({ claim: "The sky is blue." }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.verificationId).toBe("string");
    expect(body.verificationId.startsWith("vcl-")).toBe(true);
    expect(body.claim).toBe("The sky is blue.");
    expect(body.modelEvidence).toHaveLength(5);
    for (const row of body.modelEvidence) {
      expect(row.status).toBe("ok");
      expect(row.verdict).toBe("accurate");
      expect(row.summary).toBe("test summary");
      expect(row.correctParts).toEqual(["part a"]);
    }
    expect(body.verdict).toBeDefined();
    expect(body.consensusScore).toBeDefined();
    expect(body.usage).toEqual({ runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5 });

    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledWith("The sky is blue.", ["claude", "chatgpt", "gemini", "grok", "perplexity"], expect.any(Object));
    expect(mockedSaveClaimVerification).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith("uid-1", 50);
  });

  it("malformed model JSON -> that row becomes parse_error via buildClaimModelEvidence, others remain ok, run still succeeds", async () => {
    mockedRunClaimVerificationPanel.mockResolvedValueOnce([
      { modelId: "claude", status: "ok", rawText: "not valid json {{{", latencyMs: 5, tokenUsage: { totalTokens: 5, promptTokens: 2, completionTokens: 3 } },
      modelResult("chatgpt", "accurate"),
    ]);
    const res = await POST(buildRequest({ claim: "Test claim.", models: ["claude", "chatgpt"] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    const claudeRow = body.modelEvidence.find((r: any) => r.modelId === "claude");
    expect(claudeRow.status).toBe("parse_error");
    const chatgptRow = body.modelEvidence.find((r: any) => r.modelId === "chatgpt");
    expect(chatgptRow.status).toBe("ok");
  });

  it("repairable truncated model JSON -> repairTruncatedJson() fixes it, that row becomes status:\"ok\" (not parse_error), sibling row unaffected and correctly ordered, repaired evidence reaches persistence (Phase 8C-E.1.2)", async () => {
    // A realistic max-output-tokens cutoff: the model's response is cut off
    // mid-string, inside the "summary" field's value, before the closing
    // quote or the object's closing brace. cleanJsonResponse() does not
    // alter this (no markdown fence, already starts with "{"), so it is
    // exactly what buildClaimModelEvidence() would hand to the first
    // JSON.parse() attempt.
    const truncatedRawText =
      '{"verdict": "accurate", "confidence": "high", "summary": "The claim is well-supported by evidence and widely confirmed by independent sources includ';

    // Prove, using the REAL functions (not mocked), that this fixture
    // genuinely requires the repair fallback rather than already being
    // valid JSON — satisfying Phase 8C-E.1.2's explicit "do not just
    // provide already-valid JSON" requirement.
    const cleaned = cleanJsonResponse(truncatedRawText);
    expect(() => JSON.parse(cleaned)).toThrow();
    const repaired = repairTruncatedJson(cleaned);
    const repairedParsed = JSON.parse(repaired); // must not throw
    expect(repairedParsed).toEqual({
      verdict: "accurate",
      confidence: "high",
      summary: "The claim is well-supported by evidence and widely confirmed by independent sources includ",
    });

    mockedRunClaimVerificationPanel.mockResolvedValueOnce([
      { modelId: "claude", status: "ok", rawText: truncatedRawText, latencyMs: 5, tokenUsage: { totalTokens: 8, promptTokens: 4, completionTokens: 4 } },
      modelResult("chatgpt", "inaccurate"),
    ]);

    const res = await POST(buildRequest({ claim: "Test claim.", models: ["claude", "chatgpt"] }));
    const body = await res.json();
    expect(res.status).toBe(200);

    // Exact row contents, not just HTTP 200 — and exact array order
    // matching the provider result order (claude first, chatgpt second),
    // proving the repair of one model's row did not reorder or corrupt
    // its sibling.
    expect(body.modelEvidence).toHaveLength(2);
    expect(body.modelEvidence[0]).toEqual({
      modelId: "claude",
      status: "ok",
      verdict: "accurate",
      confidence: "high",
      summary: "The claim is well-supported by evidence and widely confirmed by independent sources includ",
      correctParts: [],
      incorrectParts: [],
      unverifiableParts: [],
    });
    expect(body.modelEvidence[1]).toEqual(
      expect.objectContaining({ modelId: "chatgpt", status: "ok", verdict: "inaccurate" })
    );

    // The repaired evidence must reach the canonical Personal Claim
    // persistence input unchanged — proving it survives past response
    // construction into saveClaimVerification()'s own payload.
    expect(mockedSaveClaimVerification).toHaveBeenCalledTimes(1);
    const [, persistedDoc] = mockedSaveClaimVerification.mock.calls[0];
    const persistedClaudeRow = persistedDoc.modelResults.find((r: any) => r.modelId === "claude");
    expect(persistedClaudeRow).toEqual({
      modelId: "claude",
      status: "ok",
      verdict: "accurate",
      confidence: "high",
      summary: "The claim is well-supported by evidence and widely confirmed by independent sources includ",
      correctParts: [],
      incorrectParts: [],
      unverifiableParts: [],
    });
  });

  it("model subset via body.models is honored, still >= MIN_MODELS", async () => {
    mockedRunClaimVerificationPanel.mockResolvedValueOnce([modelResult("claude", "accurate"), modelResult("chatgpt", "accurate")]);
    const res = await POST(buildRequest({ claim: "Test.", models: ["claude", "chatgpt"] }));
    expect(res.status).toBe(200);
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledWith("Test.", ["claude", "chatgpt"], expect.any(Object));
  });

  it("< 2 models -> 400 not_enough_models, no model panel call", async () => {
    const res = await POST(buildRequest({ claim: "Test.", models: ["claude"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe("not_enough_models");
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
  });
});
