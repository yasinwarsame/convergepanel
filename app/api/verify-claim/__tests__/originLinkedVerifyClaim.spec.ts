/**
 * Evidence Workspace, Phase 11A.3 — origin-linked request-mode tests for
 * `POST /api/verify-claim`. Mocks `resolveClaimVerificationOrigin()`
 * directly (independently tested in `claimVerificationOrigin.spec.ts`) —
 * this suite covers request-mode classification, the origin-linked
 * sequence, project/origin persistence, length enforcement, and
 * ordinary-path non-regression only.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
}));

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }),
}));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({
  validateUserSubscription: jest.fn().mockResolvedValue(undefined),
}));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

function modelResult(modelId: string, verdict: string) {
  return {
    modelId,
    status: "ok",
    rawText: JSON.stringify({ verdict, confidence: "high", summary: "test summary", correctParts: ["part a"], incorrectParts: [], unverifiableParts: [], reasoning: "test reasoning" }),
    latencyMs: 5,
    tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
  };
}
const FIVE_MODEL_RESULTS = [
  modelResult("claude", "accurate"),
  modelResult("chatgpt", "accurate"),
  modelResult("gemini", "accurate"),
  modelResult("grok", "accurate"),
  modelResult("perplexity", "accurate"),
];

const mockedRunClaimVerificationPanel = jest.fn();
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({
  runClaimVerificationPanel: (...args: unknown[]) => mockedRunClaimVerificationPanel(...args),
}));

const mockedSaveClaimVerification = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/firestore/verifications", () => {
  const actual = jest.requireActual("@/lib/firestore/verifications");
  return { ...actual, saveClaimVerification: (...args: unknown[]) => mockedSaveClaimVerification(...args) };
});

jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({
  applyTeamGovernancePipeline: jest.fn().mockResolvedValue({}),
  mergeGovernanceIntoBody: (body: unknown) => body,
}));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ email: "user@example.com" }) }) }) }) },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedResolveClaimVerificationOrigin = jest.fn();
jest.mock("@/lib/verification/claimVerificationOrigin", () => ({
  resolveClaimVerificationOrigin: (...args: unknown[]) => mockedResolveClaimVerificationOrigin(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/verify-claim/route";

const UID = "uid-1";
const ORIGIN = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/verify-claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
  mockedRunClaimVerificationPanel.mockResolvedValue(FIVE_MODEL_RESULTS);
});

describe("POST /api/verify-claim — request mode classification", () => {
  it("claim + runId together -> ambiguous_request_mode, zero downstream calls", async () => {
    const res = await POST(buildRequest({ claim: "x", runId: "run-1", claimId: "id" }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("ambiguous_request_mode");
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
  });

  it("runId without claimId -> invalid_origin_locator", async () => {
    const res = await POST(buildRequest({ runId: "run-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_origin_locator");
  });

  it("claimId without runId -> invalid_origin_locator", async () => {
    const res = await POST(buildRequest({ claimId: "id" }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_origin_locator");
  });

  it("origin-linked request with an unexpected field (origin) -> unexpected_field, zero downstream calls", async () => {
    const res = await POST(buildRequest({ runId: "run-1", claimId: "id-1234567890123456789012345678901234567890123", origin: { type: "deep_research_claim", runId: "x", claimId: "y" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
  });

  it("origin-linked request with a client-supplied projectId -> unexpected_field", async () => {
    const res = await POST(buildRequest({ runId: "run-1", claimId: "id", projectId: "proj-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
  });
});

describe("POST /api/verify-claim — origin-linked success path", () => {
  it("owned Deep Research source run -> origin-linked verification succeeds", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "The sky is blue.", projectId: null, evidenceSources: [] });
    const res = await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockedResolveClaimVerificationOrigin).toHaveBeenCalledWith({ runId: ORIGIN.runId, claimId: ORIGIN.claimId, callerUid: UID, expectedWorkspaceId: null });
  });

  it("resolved claimText becomes the verified/persisted claim exactly (canonical claim text)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "Canonical finding summary.", projectId: null, evidenceSources: [] });
    const res = await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    const body = await res.json();
    expect(body.claim).toBe("Canonical finding summary.");
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledWith("Canonical finding summary.", expect.any(Array), expect.any(Object));
    const savedDoc = mockedSaveClaimVerification.mock.calls[0][1];
    expect(savedDoc.claim).toBe("Canonical finding summary.");
  });

  it("finding.title is never substituted — only the resolver's claimText is ever used (resolver itself owns that guarantee; this proves the route never re-derives claim text from anywhere else)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "Summary text, not a title.", projectId: null, evidenceSources: [] });
    await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    expect(mockedRunClaimVerificationPanel.mock.calls[0][0]).toBe("Summary text, not a title.");
  });

  it("client cannot provide/override the persisted origin — the route never reads an 'origin' field from the request body at all for origin-linked mode (rejected as unexpected_field, per the classification tests above)", () => {
    expect(true).toBe(true); // covered structurally by the "unexpected field (origin)" test above
  });

  it("source run projectId inherited into the Personal verification", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-abc", evidenceSources: [] });
    await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    const savedDoc = mockedSaveClaimVerification.mock.calls[0][1];
    expect(savedDoc.projectId).toBe("proj-abc");
  });

  it("source run without a project -> verification remains unprojected (projectId key absent, never null)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    const savedDoc = mockedSaveClaimVerification.mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(savedDoc, "projectId")).toBe(false);
  });

  it("persisted origin exactly equals the server-derived origin object", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    const savedDoc = mockedSaveClaimVerification.mock.calls[0][1];
    expect(savedDoc.origin).toEqual(ORIGIN);
  });

  it("successful origin-linked verification: quota increments exactly once, panel executes exactly once, persistence occurs exactly once", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1);
    expect(mockedSaveClaimVerification).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/verify-claim — origin denial paths (foreign run, Team-via-Personal, forged/stale claimId)", () => {
  it.each(["run_not_found", "not_deep_research", "claim_not_found", "not_owner", "workspace_mismatch"] as const)(
    "resolver denial reason '%s' -> generic origin_not_eligible 404, indistinguishable across reasons",
    async (reason) => {
      mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason });
      const res = await POST(buildRequest({ runId: "run-1", claimId: "claim-1" }));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.errorCode).toBe("origin_not_eligible");
      expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
      expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
      expect(mockedSaveClaimVerification).not.toHaveBeenCalled();
    }
  );

  it("foreign Personal source run -> not_owner -> denied, zero quota/model/persistence", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "not_owner" });
    await POST(buildRequest({ runId: "run-1", claimId: "claim-1" }));
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
  });

  it("Team source run through the Personal route -> workspace_mismatch -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "workspace_mismatch" });
    const res = await POST(buildRequest({ runId: "run-1", claimId: "claim-1" }));
    expect(res.status).toBe(404);
  });

  it("forged/stale claimId -> claim_not_found -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "claim_not_found" });
    const res = await POST(buildRequest({ runId: "run-1", claimId: "tampered" }));
    expect(res.status).toBe(404);
  });

  it("missing run -> run_not_found -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "run_not_found" });
    const res = await POST(buildRequest({ runId: "nonexistent", claimId: "claim-1" }));
    expect(res.status).toBe(404);
  });

  it("valid non-Deep-Research persisted output -> not_deep_research -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "not_deep_research" });
    const res = await POST(buildRequest({ runId: "run-1", claimId: "claim-1" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/verify-claim — claim length enforcement (origin-linked)", () => {
  it("claim length == MAX_CLAIM_LEN (2000) -> accepted", async () => {
    const exact = "a".repeat(2000);
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: exact, projectId: null, evidenceSources: [] });
    const res = await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    expect(res.status).toBe(200);
  });

  it("claim length > MAX_CLAIM_LEN -> claim_too_long, and quota/model/persistence are never touched (checked before all three)", async () => {
    const overLimit = "a".repeat(2001);
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: overLimit, projectId: null, evidenceSources: [] });
    const res = await POST(buildRequest({ runId: ORIGIN.runId, claimId: ORIGIN.claimId }));
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("claim_too_long");
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveClaimVerification).not.toHaveBeenCalled();
  });
});

describe("POST /api/verify-claim — ordinary mode remains unchanged", () => {
  it("ordinary claim request -> 200, unaffected by origin-linked wiring, origin resolver never called", async () => {
    const res = await POST(buildRequest({ claim: "The sky is blue." }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.claim).toBe("The sky is blue.");
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
    const savedDoc = mockedSaveClaimVerification.mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(savedDoc, "origin")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(savedDoc, "projectId")).toBe(false);
  });
});
