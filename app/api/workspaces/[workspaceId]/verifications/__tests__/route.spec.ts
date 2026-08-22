/**
 * Team Claim Verification Creation, Phase 8C-E.1 —
 * `POST /api/workspaces/{workspaceId}/verifications` tests. Mocks every
 * underlying lib function (each independently tested elsewhere) — this
 * suite covers auth/telemetry, rate-limit ordering, body contract,
 * rollout, Gate 1/Gate 2 ordering and failure mapping, quota, token
 * accounting, governance/legacy-pipeline gating, and response shape.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: unknown[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockedCheckRateLimit(...args),
}));

let teamWorkspacesEnabled = true;
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  TEAM_WORKSPACES_ENABLED: true,
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return undefined;
  },
}));

// resolveTeamWorkspacesMode is the REAL, pure function — but the route
// also imports TEAM_WORKSPACES_ENABLED from @/lib/env above (mocked to a
// fixed `true`), so we mock the rollout resolver itself directly to
// control enabled/disabled per test without fighting module-level const
// binding.
const mockedResolveTeamWorkspacesMode = jest.fn();
jest.mock("@/lib/workspaces/teamWorkspacesRollout", () => ({
  resolveTeamWorkspacesMode: (...args: unknown[]) => mockedResolveTeamWorkspacesMode(...args),
}));

const mockedAuthorizeGate1 = jest.fn();
const mockedSaveGate2 = jest.fn();
jest.mock("@/lib/firestore/teamClaimVerifications", () => ({
  authorizeTeamClaimVerificationAdmission: (...args: unknown[]) => mockedAuthorizeGate1(...args),
  saveTeamClaimVerification: (...args: unknown[]) => mockedSaveGate2(...args),
}));

const mockedValidateUserSubscription = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/stripe/subscriptionValidation", () => ({
  validateUserSubscription: (...args: unknown[]) => mockedValidateUserSubscription(...args),
}));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedRunClaimVerificationPanel = jest.fn();
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({
  runClaimVerificationPanel: (...args: unknown[]) => mockedRunClaimVerificationPanel(...args),
}));

const mockedIncrementUserTokenUsage = jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() });
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedEvaluateAndStoreGovernance = jest.fn().mockResolvedValue(null);
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockedEvaluateAndStoreGovernance(...args),
}));

const mockedApplyTeamGovernancePipeline = jest.fn().mockResolvedValue({});
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({
  applyTeamGovernancePipeline: (...args: unknown[]) => mockedApplyTeamGovernancePipeline(...args),
  mergeGovernanceIntoBody: (body: unknown) => body,
}));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({ email: "user@example.com" }) }) }),
    }),
  },
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/verifications/route";

const UID = "member-1";
const WS_ID = "ws-team-1";

function modelResult(modelId: string, verdict: string) {
  return {
    modelId,
    status: "ok",
    rawText: JSON.stringify({ verdict, confidence: "high", summary: "s", correctParts: [], incorrectParts: [], unverifiableParts: [] }),
    latencyMs: 5,
    tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
  };
}

function buildPostRequest(bodyText: string): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/verifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
}

function buildBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ claim: "The sky is blue.", ...overrides });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() });
  mockedResolveTeamWorkspacesMode.mockReturnValue({ enabled: true, source: "global" });
  mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
  mockedRunClaimVerificationPanel.mockResolvedValue([modelResult("claude", "accurate"), modelResult("chatgpt", "accurate")]);
  mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vcl-team-1", workspaceId: WS_ID, projectId: null });
});

describe("POST /api/workspaces/[workspaceId]/verifications — identity & rate limit", () => {
  it("unauthenticated -> 401, correct telemetry, rate limiter never called", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
    expect(mockedLogIdentityResolutionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ route: "POST /api/workspaces/[workspaceId]/verifications", method: "POST", failureCategory: "missing_credentials" })
    );
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
  });

  it("authenticated malformed JSON -> rate limiter called BEFORE the parse failure", async () => {
    const res = await POST(buildPostRequest("{not valid json"), { params: { workspaceId: WS_ID } });
    expect(mockedCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: `team-claim-verification:${UID}` }));
    expect(res.status).toBe(400);
  });

  it("rate-limit denied -> 429, zero downstream work", async () => {
    mockedCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    expect(mockedAuthorizeGate1).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("rate-limit identifier is UID-only, never contains the Workspace id", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const identifier = mockedCheckRateLimit.mock.calls[0][0].identifier as string;
    expect(identifier).toBe(`team-claim-verification:${UID}`);
    expect(identifier).not.toContain(WS_ID);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — body contract", () => {
  it("unknown top-level field -> 400 unexpected_field", async () => {
    const res = await POST(buildPostRequest(buildBody({ workspaceId: "sneaky" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
  });

  it("empty claim -> 400 invalid_claim", async () => {
    const res = await POST(buildPostRequest(buildBody({ claim: "" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_claim");
  });

  it("claim over 2000 chars -> 400 claim_too_long", async () => {
    const res = await POST(buildPostRequest(buildBody({ claim: "x".repeat(2001) })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("claim_too_long");
  });

  it("no models field -> defaults to the 5-model set", async () => {
    mockedRunClaimVerificationPanel.mockResolvedValueOnce([
      modelResult("claude", "accurate"), modelResult("chatgpt", "accurate"), modelResult("gemini", "accurate"), modelResult("grok", "accurate"), modelResult("perplexity", "accurate"),
    ]);
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledWith("The sky is blue.", ["claude", "chatgpt", "gemini", "grok", "perplexity"], expect.any(Object));
  });

  it("model subset honored", async () => {
    await POST(buildPostRequest(buildBody({ models: ["claude", "chatgpt"] })), { params: { workspaceId: WS_ID } });
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledWith("The sky is blue.", ["claude", "chatgpt"], expect.any(Object));
  });

  it("< 2 models -> 400 not_enough_models, no Gate 1", async () => {
    const res = await POST(buildPostRequest(buildBody({ models: ["claude"] })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("not_enough_models");
    expect(mockedAuthorizeGate1).not.toHaveBeenCalled();
  });

  it("invalid model id filtered out silently (matches Personal's allowlist filter semantics)", async () => {
    await POST(buildPostRequest(buildBody({ models: ["claude", "chatgpt", "not-a-real-model"] })), { params: { workspaceId: WS_ID } });
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledWith("The sky is blue.", ["claude", "chatgpt"], expect.any(Object));
  });

  it("empty-string projectId -> 400 invalid_request_body", async () => {
    const res = await POST(buildPostRequest(buildBody({ projectId: "" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("projectId omitted -> Gate 1/Gate 2 called with projectId: null", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedAuthorizeGate1).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — rollout", () => {
  it("disabled -> 503 team_workspaces_disabled; zero Gate 1, quota, model calls", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: false, source: "off" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
    expect((await res.json()).errorCode).toBe("team_workspaces_disabled");
    expect(mockedAuthorizeGate1).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — Gate 1 ordering (before quota/models)", () => {
  it("Gate 1 denial -> Team error, zero quota, zero model calls, zero Gate 2", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "unauthorized", reason: "insufficient_capability" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("Gate 1 team_workspaces_disabled -> 503", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "team_workspaces_disabled" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("Gate 1 project_not_found -> 404", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "project_not_found" });
    const res = await POST(buildPostRequest(buildBody({ projectId: "proj-x" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("Gate 1 project_archived -> 409", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "project_archived" });
    const res = await POST(buildPostRequest(buildBody({ projectId: "proj-x" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(409);
  });

  it("Gate 1 success -> model execution proceeds", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — quota", () => {
  it("RUN_LIMIT denied -> 429, no model call, no Gate 2", async () => {
    mockedCheckAndIncrementUsage.mockResolvedValueOnce({ allowed: false, reason: "RUN_LIMIT", runsThisMonth: 8, maxRunsPerMonth: 8, maxModelsPerRun: 2, plan: "free", resetsAt: new Date("2026-09-01T00:00:00Z") });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.errorCode).toBe("RUN_LIMIT_REACHED");
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("MODEL_LIMIT denied -> 403", async () => {
    mockedCheckAndIncrementUsage.mockResolvedValueOnce({ allowed: false, reason: "MODEL_LIMIT", runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 2, plan: "free" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — Gate 2 (post-execution)", () => {
  it("Gate 2 success -> governance called, legacy pipeline called, response includes workspaceId/projectId/usage", async () => {
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verificationId).toBe("vcl-team-1");
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.projectId).toBeNull();
    expect(body.usage).toEqual({ runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5 });
    expect(body.status).toBeUndefined();
    expect(mockedEvaluateAndStoreGovernance).toHaveBeenCalledTimes(1);
    expect(mockedEvaluateAndStoreGovernance).toHaveBeenCalledWith(expect.objectContaining({ runId: "vcl-team-1", collection: "verifications" }));
    expect(mockedApplyTeamGovernancePipeline).toHaveBeenCalledTimes(1);
  });

  it("Gate 2 authorization denial after successful model execution -> quota remains consumed, no artifact, no governance, no legacy pipeline, no Personal fallback", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "unauthorized", reason: "membership_removed" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });

    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1); // quota WAS charged
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1); // models DID run
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockedApplyTeamGovernancePipeline).not.toHaveBeenCalled();
    expect(res.status).toBe(404); // concealed, matches teamProjectAuthorizationDeniedResponse's non-capability branch
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("Gate 2 project_archived after model execution -> 409, no artifact, no governance", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "project_archived" });
    const res = await POST(buildPostRequest(buildBody({ projectId: "proj-1" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(409);
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockedApplyTeamGovernancePipeline).not.toHaveBeenCalled();
  });

  it("token accounting: incrementUserTokenUsage is called regardless of Gate 2's outcome (both success and denial)", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "unauthorized", reason: "insufficient_capability" });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith(UID, 20); // 2 models x 10 tokens each from modelResult()

    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
    mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() });
    mockedResolveTeamWorkspacesMode.mockReturnValue({ enabled: true, source: "global" });
    mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
    mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
    mockedRunClaimVerificationPanel.mockResolvedValue([modelResult("claude", "accurate"), modelResult("chatgpt", "accurate")]);
    mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vcl-team-2", workspaceId: WS_ID, projectId: null });

    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith(UID, 20);
  });
});

describe("GET absence — E1 is create-only", () => {
  it("no GET export exists on this route module", async () => {
    const routeModule = await import("@/app/api/workspaces/[workspaceId]/verifications/route");
    expect((routeModule as any).GET).toBeUndefined();
  });
});
