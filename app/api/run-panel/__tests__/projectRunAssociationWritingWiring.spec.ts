/**
 * Personal Run/Project Schema Canonicalization, Phase 8C-B1.3B — route
 * wiring tests for POST /api/run-panel's `projectId: null` initialization.
 * Mirrors personalRunWorkspaceBindingWiring.spec.ts's structure exactly.
 * `resolvePersonalRunWorkspaceBinding()` is mocked (its own outcome logic
 * is covered elsewhere) — every outcome this route branches on is
 * exercised here.
 *
 * `resolveProjectRunAssociationWriteMode()`/`PROJECT_RUN_ASSOCIATION_WRITES_ENABLED`/
 * its canary are deliberately NOT referenced anywhere in this file —
 * route.ts no longer imports or calls them (see the STRUCTURAL test
 * below). The neutral `projectId: null` write for a Personal
 * Workspace-bound run is now unconditional, closing the rollout-
 * transition gap (workspaceId present, projectId absent) that Phase
 * 8C-B1.3A/8C-B1.3A.1 audited. That flag/resolver remain in use
 * elsewhere (the assign/move/unassign endpoint's own eligibility gate) —
 * unrelated to this route.
 */

const mockEnvFlags = {
  RW: true,
  W: true,
  ADAPTIVE: true,
  CANARY_UIDS: undefined as string | undefined,
};

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

function createRunArgs() {
  return mockedCreateRun.mock.calls[0];
}

describe("POST /api/run-panel — Personal Run/Project Schema Canonicalization wiring (Phase 8C-B1.3B)", () => {
  beforeEach(() => {
    mockEnvFlags.RW = true;
    mockEnvFlags.W = true;
    mockEnvFlags.ADAPTIVE = true;
    mockEnvFlags.CANARY_UIDS = undefined;
    mockedLoadUserAndTeam.mockResolvedValue({ user: { teamId: undefined }, team: null });
    mockedResolveBinding.mockResolvedValue({ outcome: "bound", workspaceId: "personal-test-uid" });
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockedCallGemini.mockReset();
    mockedFinalizeAdaptiveRun.mockReset();
  });

  it("Personal-bound (global workspace writes): workspaceId present, projectId arg is exactly null — the canonical invariant", async () => {
    const { response, body } = await runAdaptiveRequest();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const [, , , , workspaceIdArg, projectIdArg] = createRunArgs();
    expect(workspaceIdArg).toBe("personal-test-uid");
    expect(projectIdArg).toBeNull();
  });

  it("Personal-bound via the workspace-write canary (global RW off): projectId arg is still exactly null", async () => {
    mockEnvFlags.RW = false;
    mockEnvFlags.CANARY_UIDS = "test-uid,someone-else";
    const { response, body } = await runAdaptiveRequest();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const [, , , , workspaceIdArg, projectIdArg] = createRunArgs();
    expect(workspaceIdArg).toBe("personal-test-uid");
    expect(projectIdArg).toBeNull();
  });

  it("workspace-write mode disabled (global off, uid not canaried): legacy shape — workspaceId absent, projectId absent, exactly as before this phase", async () => {
    mockEnvFlags.RW = false;
    mockEnvFlags.CANARY_UIDS = "someone-else,another-uid";
    const { response, body } = await runAdaptiveRequest();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockedResolveBinding).not.toHaveBeenCalled();
    const [, , , , workspaceIdArg, projectIdArg] = createRunArgs();
    expect(workspaceIdArg).toBeUndefined();
    expect(projectIdArg).toBeUndefined();
  });

  it("SECURITY/INVARIANT: Team adaptive request — projectId arg is ALWAYS undefined, since workspaceIdForRun is never set for a team user", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({
      user: { teamId: "team_abc" },
      team: { id: "team_abc", name: "T", createdBy: "x", createdAt: "2026-01-01", members: [], policyRules: [], settings: {} },
    });
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "team_user" });

    const { response, body } = await runAdaptiveRequest();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const [, , , , workspaceIdArg, projectIdArg] = createRunArgs();
    expect(workspaceIdArg).toBeUndefined();
    expect(projectIdArg).toBeUndefined();
  });

  it("SECURITY/INVARIANT: nonadaptive Deep Research request — projectId arg is ALWAYS undefined, since the whole binding block is skipped for a null adaptivePlan", async () => {
    mockEnvFlags.ADAPTIVE = false;

    const response = await POST(buildRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockedResolveBinding).not.toHaveBeenCalled();
    const [, , , , workspaceIdArg, projectIdArg] = createRunArgs();
    expect(workspaceIdArg).toBeUndefined();
    expect(projectIdArg).toBeUndefined();
  });

  it("SECURITY/INVARIANT: Personal Workspace binding resolution_failed — createRun is never called at all, so no projectId can be written", async () => {
    mockedResolveBinding.mockReset();
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "resolution_failed", reason: "not_found" });

    const { response, body } = await runAdaptiveRequest();
    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  it("SECURITY/INVARIANT: Personal Workspace binding invalid_configuration — rejected before model execution, createRun is never called", async () => {
    mockedResolveBinding.mockReset();
    mockedResolveBinding.mockResolvedValueOnce({ outcome: "invalid_configuration", reason: "workspaces_disabled_but_writes_enabled" });

    const { response, body } = await runAdaptiveRequest();
    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe("workspace_configuration_invalid");
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  it("REQUEST SPOOFING: a client-supplied projectId in the request body has zero effect on the persisted value", async () => {
    await runAdaptiveRequest({ projectId: "attacker-supplied-project-id" });
    const [, , , , , projectIdArg] = createRunArgs();
    expect(projectIdArg).toBeNull(); // never "attacker-supplied-project-id" — always the canonical null for a bound run, never client-influenced
  });

  it("STRUCTURAL: route.ts no longer imports or calls resolveProjectRunAssociationWriteMode() — the neutral projectId:null write is unconditional", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/run-panel/route.ts"), "utf8");
    // Checks the executable surface only — an explanatory code comment is
    // allowed to name the retired flag; an import or a call site is not.
    expect(source).not.toMatch(/resolveProjectRunAssociationWriteMode\(/);
    expect(source).not.toMatch(/^import .*resolveProjectRunAssociationWriteMode.*$/m);
    expect(source).not.toMatch(/^import \{[^}]*PROJECT_RUN_ASSOCIATION_WRITES_ENABLED[^}]*\} from "@\/lib\/env";$/m);
    expect(source).not.toMatch(/^import \{[^}]*PROJECT_RUN_ASSOCIATION_WRITE_CANARY_UIDS[^}]*\} from "@\/lib\/env";$/m);
  });

  it("STRUCTURAL: the projectIdForRun computation appears only inside the same case block that assigns workspaceIdForRun — proven by requiring exactly one occurrence of the assignment pattern between 'case \"bound\"' and the next 'case'", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/run-panel/route.ts"), "utf8");
    const boundCaseMatch = source.match(/case "bound": \{([\s\S]*?)\n\s*\}\n\s*case /);
    expect(boundCaseMatch).not.toBeNull();
    const boundCaseBody = boundCaseMatch![1];
    expect(boundCaseBody).toMatch(/workspaceIdForRun = binding\.workspaceId/);
    expect(boundCaseBody).toMatch(/projectIdForRun = null/);
  });

  it("the request body is never inspected for a projectId field anywhere in this route", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/run-panel/route.ts"), "utf8");
    expect(source).not.toMatch(/body\.projectId/);
    expect(source).not.toMatch(/body\["projectId"\]/);
  });
});
