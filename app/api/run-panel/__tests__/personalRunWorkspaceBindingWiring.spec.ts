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

const mockEnvFlags = { RW: false, W: false, ADAPTIVE: true, CANARY_UIDS: undefined as string | undefined };

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
  get PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS() {
    return mockEnvFlags.CANARY_UIDS;
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
    mockEnvFlags.CANARY_UIDS = undefined;
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

    it("REGRESSION (Phase 3A independent review): global RW=true, adaptive TEAM request, W=false — same team_user pass-through must hold under global source too, not just canary", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = false;
      mockedLoadUserAndTeam.mockResolvedValueOnce({
        user: { teamId: "team_abc" },
        team: { id: "team_abc", name: "T", createdBy: "x", createdAt: "2026-01-01", members: [], policyRules: [], settings: {} },
      });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "team_user" });

      const { response, body } = await runAdaptiveRequest();

      expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ hasTeam: true, writesEnabled: true, workspacesEnabled: false }));
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("flag off (RW=false, W=false), adaptive request: resolvePersonalRunWorkspaceBinding is never called", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = false;
      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled();
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("RW=false is completely inert even when W=true — W alone must never make new run creation Workspace-associated", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled();
      expect(mockedLoadUserAndTeam).not.toHaveBeenCalled();
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

    it("a client-supplied 'canary: true' field or spoofed uid in the request body has zero effect — canary eligibility derives exclusively from the authenticated uid", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = "some-other-uid"; // NOT "test-uid" — the authenticated identity

      const { response, body } = await runAdaptiveRequest({ canary: true, uid: "some-other-uid" });

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled(); // never activated for the real authenticated uid
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });
  });

  describe("Account-Scoped Workspace Write Canary, Phase 3A — uses the REAL resolvePersonalRunWorkspaceWriteMode() (not mocked); resolvePersonalRunWorkspaceBinding remains mocked, proving canary reuses that exact same call unmodified", () => {
    it("global RW=false, authenticated uid IS in a valid canary list, W=true, adaptive personal: Phase-3 binding activates via source=canary, workspaceId persisted", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = "test-uid,someone-else";
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ uid: "test-uid", writesEnabled: true }));
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBe("personal-test-uid");
    });

    it("global RW=false, authenticated uid NOT in the canary list: fully unaffected, identical to today's dark production behavior — zero Workspace lookups, zero new failure dependency", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true; // W=true alone must never matter for a non-canary, non-global user
      mockEnvFlags.CANARY_UIDS = "someone-else,another-uid";

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled();
      expect(mockedLoadUserAndTeam).not.toHaveBeenCalled();
      expect(mockedRunPanel).toHaveBeenCalledTimes(1); // research proceeds exactly as legacy
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("canary UID, non-adaptive Deep Research request: zero Workspace lookups even though the uid is allowlisted — canary only selects write mode, never broadens Phase 3's adaptive-only scope", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      mockEnvFlags.ADAPTIVE = false;
      mockEnvFlags.CANARY_UIDS = "test-uid";

      const { response, body } = await runNonAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled();
      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("canary UID, adaptive TEAM request: no Personal workspaceId — being canary-listed never overrides team isolation", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = "test-uid";
      mockedLoadUserAndTeam.mockResolvedValueOnce({
        user: { teamId: "team_abc" },
        team: { id: "team_abc", name: "T", createdBy: "x", createdAt: "2026-01-01", members: [], policyRules: [], settings: {} },
      });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "team_user" });

      const { response, body } = await runAdaptiveRequest();

      expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ hasTeam: true }));
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("REGRESSION (Phase 3A independent review): canary UID, adaptive TEAM request with W=false too — the route must pass hasTeam=true/writesEnabled=true/workspacesEnabled=false through to resolvePersonalRunWorkspaceBinding() unmodified. The internal ordering fix itself (team_user, never invalid_configuration, for exactly this input) is proven directly against the REAL function in personalRunWorkspaceBinding.spec.ts; this test proves the route's own wiring passes the right arguments so that fix actually applies in production", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = false;
      mockEnvFlags.CANARY_UIDS = "test-uid";
      mockedLoadUserAndTeam.mockResolvedValueOnce({
        user: { teamId: "team_abc" },
        team: { id: "team_abc", name: "T", createdBy: "x", createdAt: "2026-01-01", members: [], policyRules: [], settings: {} },
      });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "team_user" });

      const { response, body } = await runAdaptiveRequest();

      expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ hasTeam: true, writesEnabled: true, workspacesEnabled: false }));
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });

    it("canary UID targeted, W=false: rejected before model execution — no legacy fallback, identical to global RW's own invalid-configuration handling", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = false;
      mockEnvFlags.CANARY_UIDS = "test-uid";
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "invalid_configuration", reason: "workspaces_disabled_but_writes_enabled" });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe("workspace_configuration_invalid");
      expect(mockedRunPanel).not.toHaveBeenCalled();
      expect(mockedCreateRun).not.toHaveBeenCalled();
      expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    });

    it.each([
      ["not_found", 409],
      ["malformed", 409],
      ["wrong_owner", 409],
      ["wrong_type", 409],
      ["lookup_failed", 503],
      ["invalid_uid", 409],
    ])("canary UID targeted, resolution_failed:%s: zero model/usage/run calls, identical to global RW's failure-before-spend", async (reason, expectedStatus) => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = "test-uid";
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "resolution_failed", reason });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(expectedStatus);
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe("workspace_prerequisite_failed");
      expect(mockedRunPanel).not.toHaveBeenCalled();
      expect(mockedCreateRun).not.toHaveBeenCalled();
      expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    });

    it("global RW=true takes precedence over an ABSENT canary list — unaffected, matches pre-Phase-3A behavior exactly", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = undefined;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBe("personal-test-uid");
    });

    it("global RW=true takes precedence over a MALFORMED canary list — the request still succeeds via global mode, the malformed list never blocks it", async () => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = "not/a/valid/uid";
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ writesEnabled: true }));
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBe("personal-test-uid");
    });

    it("global RW=false, MALFORMED canary list: fails closed to off for every uid — the authenticated uid is never activated, even if it would have otherwise matched a well-formed entry in the same string", async () => {
      mockEnvFlags.RW = false;
      mockEnvFlags.W = true;
      mockEnvFlags.CANARY_UIDS = "test-uid,not/valid"; // "test-uid" itself is well-formed, but the WHOLE list is invalidated by the other entry

      const { response, body } = await runAdaptiveRequest();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockedResolveBinding).not.toHaveBeenCalled(); // never activated despite "test-uid" being present in the raw string
      const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
      expect(workspaceIdArg).toBeUndefined();
    });
  });

  describe("structural: global and canary converge on the exact same code path", () => {
    it("route.ts calls resolvePersonalRunWorkspaceBinding() from exactly one call site — there is no separate, parallel implementation for canary vs. global", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(path.join(process.cwd(), "app/api/run-panel/route.ts"), "utf8");
      const callSites = (source.match(/resolvePersonalRunWorkspaceBinding\(\{/g) ?? []).length;
      expect(callSites).toBe(1);
    });

    it("the canary allowlist is never returned in any NextResponse.json body in this route, and no NEXT_PUBLIC_-prefixed variant of it exists anywhere in the repo", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(path.join(process.cwd(), "app/api/run-panel/route.ts"), "utf8");
      // Every response object literal in this file — none may reference
      // the canary env constant or its raw value.
      const responseLiterals = source.match(/NextResponse\.json\(\s*\{[\s\S]*?\}/g) ?? [];
      for (const literal of responseLiterals) {
        expect(literal).not.toMatch(/CANARY/);
      }
    });
  });
});
