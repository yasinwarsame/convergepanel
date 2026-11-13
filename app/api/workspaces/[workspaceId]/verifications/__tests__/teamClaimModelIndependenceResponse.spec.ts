/**
 * Review of 262ef64, MAJOR B1 — the Team claim result returned by POST /api/workspaces/{id}/verifications (rendered by
 * the Team composer right after a verification completes) carries `modelIndependence`, judged from the rows just
 * persisted exactly as the Team detail read judges them. The persisted document is unchanged.
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
let teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
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
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return teamWorkspacesCanaryWorkspaceIds;
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
  teamWorkspacesCanaryWorkspaceIds = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() });
  mockedResolveTeamWorkspacesMode.mockReturnValue({ enabled: true, source: "global" });
  mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
  mockedRunClaimVerificationPanel.mockResolvedValue([modelResult("claude", "accurate"), modelResult("chatgpt", "accurate")]);
  mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vcl-team-1", workspaceId: WS_ID, projectId: null });
});

const failed = (modelId: string) => ({ modelId, status: "error", errorMessage: "boom", latencyMs: 1 });
const substituted = (modelId: string) => ({ ...modelResult(modelId, "accurate"), status: "substituted", provider: "deepseek" });

describe("POST /api/workspaces/[workspaceId]/verifications — modelIndependence on the live Team result", () => {
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
    const res = await POST(buildPostRequest(buildBody({ models })), { params: { workspaceId: WS_ID } } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.modelIndependence).toBe(expected);
    const saved = JSON.stringify(mockedSaveGate2.mock.calls[0]);
    expect(saved).not.toContain("modelIndependence");
  });
});
