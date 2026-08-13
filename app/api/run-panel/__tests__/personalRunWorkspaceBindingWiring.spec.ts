/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 — route
 * wiring tests for POST /api/run-panel's workspaceId binding, hardened per
 * independent review. `resolvePersonalRunWorkspaceBinding()` itself is
 * mocked here — its own outcome logic already has full unit coverage in
 * personalRunWorkspaceBinding.spec.ts; this file tests that the route:
 *   - resolves the Workspace prerequisite BEFORE any model execution
 *     (mockedRunPanel), BEFORE usage/token accounting, and BEFORE
 *     createRun(), for every failure outcome;
 *   - rejects the whole request (no run, no models, no usage) on both
 *     resolution_failed and invalid_configuration — never a silent
 *     legacy fallback;
 *   - only ever attempts binding for a genuinely adaptive request
 *     (adaptivePlan !== null) — a plain Deep Research request never even
 *     calls resolvePersonalRunWorkspaceBinding();
 *   - never lets a client-supplied workspaceId influence anything.
 */

const mockEnvFlags = { RW: false, W: false, ADAPTIVE: true };

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  get ADAPTIVE_SCHEMAS_ENABLED() {
    return mockEnvFlags.ADAPTIVE;
  },
  get PERSONAL_RUN_WORKSPACE_WRITES_ENABLED() {
    return mockEnvFlags.RW;
  },
  get WORKSPACES_ENABLED() {
    return mockEnvFlags.W;
  },
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
  persistAdaptiveOutput: jest.fn(),
  persistLegacyAdaptiveOutput: jest.fn(),
  readGovernanceRecordForInitialization: jest.fn(),
  persistAutomatedGovernanceUpdate: jest.fn(),
  writeAdaptiveGovernanceEvent: jest.fn(),
}));

const mockedIncrementUserTokenUsage = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: any[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));

const mockedResolveBinding = jest.fn();
jest.mock("@/lib/workspaces/personalRunWorkspaceBinding", () => ({
  resolvePersonalRunWorkspaceBinding: (...args: any[]) => mockedResolveBinding(...args),
}));

const mockedRunPanel = jest.fn().mockResolvedValue([
  { modelId: "chatgpt", status: "ok", rawText: "irrelevant", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
  { modelId: "claude", status: "ok", rawText: "irrelevant", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
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

const mockedFinalizeAdaptiveRun = jest.fn();
jest.mock("@/lib/adaptiveSchema/orchestrate", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/orchestrate");
  return {
    ...actual,
    finalizeAdaptiveRun: (...args: any[]) => mockedFinalizeAdaptiveRun(...args),
  };
});

import { callGemini } from "@/lib/connectors/gemini";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/run-panel/route";

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

function classificationJson(queryType: string) {
  return JSON.stringify({
    queryType,
    domain: "test",
    answerShape: "decision_support_view",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "make_decision",
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

function buildRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/run-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Which CRM should we choose?", selectedModels: ["chatgpt", "claude"], ...body }),
  });
}

async function runAdaptiveRequest(body?: Record<string, unknown>) {
  mockedCallGemini.mockResolvedValueOnce({
    modelId: "gemini",
    status: "ok",
    rawText: classificationJson("decision_support"),
    latencyMs: 5,
  } as any);
  mockedFinalizeAdaptiveRun.mockResolvedValueOnce({
    schemaId: "decision_support",
    adaptiveResults: [],
    persistedOutput: {
      version: 1,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      classification: {},
      meta: {},
      result: { totalModels: 2 },
      generatedAt: "2026-07-29T00:00:00.000Z",
    },
    commonResponseMeta: undefined,
  });
  const response = await POST(buildRequest(body));
  return { response, body: await response.json() };
}

async function runNonAdaptiveRequest() {
  const response = await POST(buildRequest());
  return { response, body: await response.json() };
}

describe("POST /api/run-panel — Personal Run Workspace Binding wiring (hardened)", () => {
  beforeEach(() => {
    mockEnvFlags.RW = false;
    mockEnvFlags.W = false;
    mockEnvFlags.ADAPTIVE = true;
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockedCallGemini.mockReset();
    mockedFinalizeAdaptiveRun.mockReset();
  });

  describe("scope: adaptive vs. Deep Research", () => {
    it("Deep Research / non-adaptive request (ADAPTIVE_SCHEMAS_ENABLED=false): resolvePersonalRunWorkspaceBinding is never called, even with both flags on", async () => {
      mockEnvFlags.ADAPTIVE = false;
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;

      const { response, body } = await runNonAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled();
      expect(mockedLoadUserAndTeam).not.toHaveBeenCalled();
      expect(mockedRunPanel).toHaveBeenCalledTimes(1); // Deep Research still executes normally
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("adaptive personal request with a valid Workspace: bound, model execution proceeds normally", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "test-uid", writesEnabled: true, workspacesEnabled: true, hasTeam: false })
      );
      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBe("personal-test-uid");
    });

    it("adaptive TEAM request: no Personal workspaceId even with both flags on, model execution still proceeds", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockedLoadUserAndTeam.mockResolvedValueOnce({
        user: { teamId: "team_abc" },
        team: { id: "team_abc", name: "T", createdBy: "x", createdAt: "2026-01-01", members: [], policyRules: [], settings: {} },
      });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "team_user" });

      const { response, body } = await runAdaptiveRequest();

      expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ hasTeam: true }));
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("flag off (RW=false), adaptive request: resolvePersonalRunWorkspaceBinding is never called", async () => {
      mockEnvFlags.RW = false;
      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled();
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });
  });

  describe("failure-before-spend: every resolution_failed reason rejects before any model/usage/run activity", () => {
    it.each([
      ["not_found", "workspace_missing" as const, 409],
      ["malformed", "workspace_invalid" as const, 409],
      ["wrong_owner", "workspace_invalid" as const, 409],
      ["wrong_type", "workspace_invalid" as const, 409],
      ["lookup_failed", "workspace_unavailable" as const, 503],
      ["invalid_uid", "workspace_invalid" as const, 409],
    ])("resolution_failed:%s -> %s (HTTP %d), zero model/usage/run calls", async (reason, _sanitized, expectedStatus) => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "resolution_failed", reason });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(expectedStatus);
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe("workspace_prerequisite_failed");
      // The exact request/owner-identifying detail is never leaked.
      expect(JSON.stringify(body)).not.toContain("test-uid");
      expect(JSON.stringify(body)).not.toContain("Firestore");
      expect(JSON.stringify(body)).not.toContain(reason);

      expect(mockedRunPanel).not.toHaveBeenCalled();
      expect(mockedCreateRun).not.toHaveBeenCalled();
      expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
      // Plan-quota increment happens even earlier, before adaptive
      // classification's downstream Workspace check — unaffected by
      // Phase 3 either way (pre-existing ordering, out of this phase's
      // scope), so it is NOT asserted as zero here.
    });
  });

  describe("invalid configuration: W=false/RW=true must reject, never downgrade to legacy", () => {
    it("adaptive personal request, W=false/RW=true: request rejected before model execution, no legacy run created", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = false;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "invalid_configuration", reason: "workspaces_disabled_but_writes_enabled" });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe("workspace_configuration_invalid");
      expect(mockedRunPanel).not.toHaveBeenCalled();
      expect(mockedCreateRun).not.toHaveBeenCalled(); // no legacy fallback
      expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    });
  });

  describe("model-spend / persistence ordering for the successful path", () => {
    it("resolvePersonalRunWorkspaceBinding is called before runPanel, and createRun is called with the resolved workspaceId in its initial arguments (never a later call)", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockImplementationOnce(async () => {
        expect(mockedRunPanel).not.toHaveBeenCalled();
        expect(mockedCreateRun).not.toHaveBeenCalled();
        return { outcome: "bound", workspaceId: "personal-test-uid" };
      });

      await runAdaptiveRequest();

      expect(mockedCreateRun).toHaveBeenCalledTimes(1);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBe("personal-test-uid");
    });
  });

  describe("request spoofing", () => {
    it("a malicious client-supplied workspaceId/userId/ownerUserId in the request body cannot influence the resolved binding or persisted owner", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

      await runAdaptiveRequest({ workspaceId: "personal-other-user", userId: "other-user", ownerUserId: "other-user" });

      const [, ownerArg, , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(ownerArg).toBe("test-uid"); // authenticated uid, never the spoofed body field
      expect(workspaceIdArg).toBe("personal-test-uid"); // server-resolved, never the spoofed body field
    });
  });
});
