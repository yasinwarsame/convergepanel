/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 — route
 * wiring tests for POST /api/run-panel's workspaceId binding at run
 * creation. Mirrors personalReviewerAssignmentWiring.spec.ts's mock
 * scaffolding exactly. `resolvePersonalRunWorkspaceBinding()` itself is
 * mocked here — its own outcome logic already has full unit coverage in
 * personalRunWorkspaceBinding.spec.ts; this file only tests that the route
 * calls it at the right time, with the right arguments, wires its result
 * into createRun() correctly, and that adaptive planning is disabled so
 * the run always reaches the createRun() call under test.
 */

const mockEnvFlags = { RW: false, W: false };

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  ADAPTIVE_SCHEMAS_ENABLED: false, // adaptive planning disabled — keeps this file focused purely on the createRun() wiring, not classification
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
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
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

import { NextRequest } from "next/server";
import { POST } from "@/app/api/run-panel/route";

function buildRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/run-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Which CRM should we choose?", selectedModels: ["chatgpt", "claude"], ...body }),
  });
}

async function runRequest(body?: Record<string, unknown>) {
  const response = await POST(buildRequest(body));
  return response.json();
}

describe("POST /api/run-panel — Personal Run Workspace Binding wiring", () => {
  beforeEach(() => {
    mockEnvFlags.RW = false;
    mockEnvFlags.W = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("flag off (RW=false): resolvePersonalRunWorkspaceBinding is never called, createRun gets no workspaceId", async () => {
    mockEnvFlags.RW = false;
    const body = await runRequest();

    expect(body.ok).toBe(true);
    expect(mockedResolveBinding).not.toHaveBeenCalled();
    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
    expect(workspaceIdArg).toBeUndefined();
  });

  it("flag on + valid Workspace + non-team user: new run gets the deterministic workspaceId", async () => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = true;
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

    const body = await runRequest();

    expect(body.ok).toBe(true);
    expect(mockedResolveBinding).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "test-uid", writesEnabled: true, workspacesEnabled: true, hasTeam: false })
    );
    const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
    expect(workspaceIdArg).toBe("personal-test-uid");
  });

  it("flag on + Workspace missing (resolution_failed): createRun is never called at all — no legacy fallback, no mixed ownership", async () => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = true;
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "resolution_failed", reason: "not_found" });

    const body = await runRequest();

    // Non-fatal to the overall request — the run-panel route's existing
    // established pattern treats "run record could not be created" as a
    // non-blocking failure (research still proceeds).
    expect(body.ok).toBe(true);
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  it.each(["malformed", "wrong_owner", "wrong_type", "lookup_failed", "invalid_uid"])(
    "flag on + resolution_failed:%s: createRun is never called",
    async (reason) => {
      mockEnvFlags.RW = true;
      mockEnvFlags.W = true;
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedResolveBinding.mockResolvedValueOnce({ outcome: "resolution_failed", reason });

      const body = await runRequest();

      expect(body.ok).toBe(true);
      expect(mockedCreateRun).not.toHaveBeenCalled();
    }
  );

  it("flag on + invalid_configuration (W=false while RW=true is somehow still reached): degrades to legacy, no workspaceId, run still created", async () => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = false;
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "invalid_configuration", reason: "workspaces_disabled_but_writes_enabled" });

    const body = await runRequest();

    expect(body.ok).toBe(true);
    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
    expect(workspaceIdArg).toBeUndefined();
  });

  it("team user: no Personal workspaceId even with both flags on", async () => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = true;
    mockedLoadUserAndTeam.mockResolvedValueOnce({
      user: { teamId: "team_abc" },
      team: { id: "team_abc", name: "T", createdBy: "x", createdAt: "2026-01-01", members: [], policyRules: [], settings: {} },
    });
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "team_user" });

    const body = await runRequest();

    expect(mockedResolveBinding).toHaveBeenCalledWith(expect.objectContaining({ hasTeam: true }));
    expect(body.ok).toBe(true);
    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
    expect(workspaceIdArg).toBeUndefined();
  });

  it("workspace binding is resolved BEFORE model execution (runPanel), for both success and failure outcomes — a resolution failure never blocks the actual research", async () => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = true;
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
    mockedResolveBinding.mockImplementationOnce(async () => {
      expect(mockedRunPanel).not.toHaveBeenCalled(); // ordering: binding resolves before model execution starts
      return { outcome: "resolution_failed", reason: "not_found" };
    });

    const body = await runRequest();

    // Deliberate design choice, documented in docs/workspaces/architecture.md:
    // a Workspace resolution failure skips run-record creation (no mixed
    // ownership) but does NOT block the user's actual research — this
    // matches the pre-existing, established "run creation is for tracking,
    // not critical for execution" philosophy already in this exact
    // try/catch for any other createRun() failure.
    expect(mockedRunPanel).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
  });

  it("a malicious client-supplied workspaceId in the request body is never read or persisted", async () => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = true;
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "bound", workspaceId: "personal-test-uid" });

    await runRequest({ workspaceId: "personal-someone-else" });

    // The only workspaceId that could ever reach createRun() is whatever
    // resolvePersonalRunWorkspaceBinding() resolved server-side — the
    // client-supplied value is never even parsed out of the request body.
    const [, , , , workspaceIdArg] = mockedCreateRun.mock.calls[0];
    expect(workspaceIdArg).toBe("personal-test-uid");
    expect(workspaceIdArg).not.toBe("personal-someone-else");
  });
});
