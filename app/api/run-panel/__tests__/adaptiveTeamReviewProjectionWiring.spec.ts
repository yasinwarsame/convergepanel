/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C — adaptive team-review
 * QUEUE PROJECTION route wiring tests.
 *
 * Mirrors adaptiveAutomatedGovernanceWiring.spec.ts's approach. Every
 * side-effecting dependency is mocked EXCEPT `routeAdaptiveTeamReview` /
 * `buildAdaptiveTeamRunProjection` (from `@/lib/governance/adaptiveTeamReview`),
 * which are left real and pure — this file tests genuine end-to-end wiring
 * (does the route's derived automatedGovernanceStatus/humanReviewNeeded and
 * the loaded team settings actually flow through into a correct routing
 * decision?), not just that a mock was called. The routing/projection
 * logic itself already has full unit coverage in
 * adaptiveTeamReviewRouting.spec.ts and adaptiveTeamRunProjection.spec.ts.
 *
 * This is Part C only — no human-review decision route exists yet
 * (docs/governance-decision-receipts-design.md §21/§22, Part D not started).
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
const mockedPersistAdaptiveOutput = jest.fn().mockResolvedValue({ saved: true });
const mockedReadGovernanceRecord = jest.fn();
const mockedInitializeGovernance = jest.fn();
const mockedPersistAutomatedGovernanceUpdate = jest.fn();
const mockedWriteAdaptiveGovernanceEvent = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  createRun: (...args: any[]) => mockedCreateRun(...args),
  completeRun: (...args: any[]) => mockedCompleteRun(...args),
  markRunError: (...args: any[]) => mockedMarkRunError(...args),
  persistAdaptiveOutput: (...args: any[]) => mockedPersistAdaptiveOutput(...args),
  readGovernanceRecordForInitialization: (...args: any[]) => mockedReadGovernanceRecord(...args),
  persistAutomatedGovernanceUpdate: (...args: any[]) => mockedPersistAutomatedGovernanceUpdate(...args),
  writeAdaptiveGovernanceEvent: (...args: any[]) => mockedWriteAdaptiveGovernanceEvent(...args),
}));
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/adaptiveSchema/governanceInitialization", () => ({
  initializeAdaptiveGovernanceRecord: (...args: any[]) => mockedInitializeGovernance(...args),
}));

const mockedLoadGovernancePolicy = jest.fn();
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: (...args: any[]) => mockedLoadGovernancePolicy(...args),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));

const mockedCreateAdaptiveTeamRunProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({
  createAdaptiveTeamRunProjection: (...args: any[]) => mockedCreateAdaptiveTeamRunProjection(...args),
}));

const mockedRunPanel = jest.fn().mockResolvedValue([
  { modelId: "chatgpt", status: "ok", rawText: "irrelevant, finalizeAdaptiveRun is mocked", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
  { modelId: "claude", status: "ok", rawText: "irrelevant, finalizeAdaptiveRun is mocked", latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } },
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

function buildRequest(question: string): NextRequest {
  return new NextRequest("http://localhost/api/run-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, selectedModels: ["chatgpt", "claude"] }),
  });
}

const DEFAULT_POLICY = {
  policyVersion: 3,
  minConsensusToApprove: 80,
  minConsensusToAvoidReview: 70,
  blockIfSourceBackedMissingSources: true,
  reviewIfAnyModelSubstituted: true,
  reviewIfAnyModelFailed: true,
  sensitiveDomainsEnabled: true,
  sensitiveMinConsensusToApprove: 85,
  sensitiveMinConsensusToAvoidReview: 75,
  reviewIfEvidenceQualityWeak: true,
  reviewIfVerificationVerdictIn: [],
};

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

const PERSISTED_OUTPUT = {
  version: 1,
  schemaId: "decision_support",
  answerShape: "decision_support_view",
  classification: {},
  meta: {},
  result: { totalModels: 2 },
  generatedAt: "2026-07-29T00:00:00.000Z",
};

function commonResponseMeta(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    queryType: "decision_support",
    answerShape: "decision_support_view",
    totalModels: 2,
    successfulModels: 2,
    failedModels: 0,
    modelsWithUsableOutput: 2,
    executionStatus: "completed",
    humanReviewNeeded: false,
    generatedAt: "2026-07-29T00:00:00.000Z",
    uncertainties: [],
    blindSpots: [],
    dataBasis: "training_prior",
    freshness: "timeless",
    riskLevel: "professional",
    evidenceQuality: "not_applicable",
    ...overrides,
  };
}

function mockFinalizeWithPersistedOutput(commonResponseMetaOverrides?: Record<string, unknown>) {
  mockedFinalizeAdaptiveRun.mockResolvedValueOnce({
    schemaId: "decision_support",
    adaptiveResults: [],
    persistedOutput: PERSISTED_OUTPUT,
    commonResponseMeta: commonResponseMetaOverrides === null ? undefined : commonResponseMeta(commonResponseMetaOverrides),
  });
}

async function runRequest() {
  mockedCallGemini.mockResolvedValueOnce({
    modelId: "gemini",
    status: "ok",
    rawText: classificationJson("decision_support"),
    latencyMs: 5,
  } as any);
  const response = await POST(buildRequest("Which CRM should we choose?"));
  return response.json();
}

function team(adaptiveReviewSettings: { enabled: boolean; mode: string } | undefined) {
  return {
    user: { teamId: "team_abc12345_1700000000000" },
    team: {
      id: "team_abc12345_1700000000000",
      name: "Test Team",
      createdBy: "test-uid",
      createdAt: "2026-01-01T00:00:00.000Z",
      members: [],
      policyRules: [],
      settings: { minimumConsensusForAction: 60, flagThreshold: 50 },
      adaptiveReviewSettings,
    },
  };
}

/** Standard setup for a "created" governance record with no automatedGovernance yet, so the automated-governance block runs and sets a real status. */
function setupCreatedGovernance(governanceOverrides: Record<string, unknown> = {}, metaOverrides: Record<string, unknown> = { failedModels: 0, successfulModels: 2 }) {
  mockFinalizeWithPersistedOutput(metaOverrides);
  mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
  mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord(governanceOverrides) });
}

describe("POST /api/run-panel — Step 7 Part C adaptive team-review projection wiring", () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockedCallGemini.mockReset();
    mockedFinalizeAdaptiveRun.mockReset();
    mockedReadGovernanceRecord.mockReset();
    mockedInitializeGovernance.mockReset();
    mockedPersistAutomatedGovernanceUpdate.mockReset();
    mockedWriteAdaptiveGovernanceEvent.mockReset();
    mockedLoadGovernancePolicy.mockReset();
    mockedLoadUserAndTeam.mockReset();
    mockedCreateAdaptiveTeamRunProjection.mockReset();
  });

  beforeEach(() => {
    mockedLoadGovernancePolicy.mockResolvedValue(DEFAULT_POLICY);
    mockedPersistAutomatedGovernanceUpdate.mockResolvedValue({ saved: true });
    mockedWriteAdaptiveGovernanceEvent.mockResolvedValue({ written: true });
  });

  describe("eligibility and creation", () => {
    it("flagged_only + a flagged automated-governance result creates a projection", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "team_abc12345_1700000000000:run-x" });

      const body = await runRequest();

      expect(body.adaptive.automatedGovernanceStatus).toBe("flagged");
      expect(mockedCreateAdaptiveTeamRunProjection).toHaveBeenCalledTimes(1);
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("created");
    });

    it("an already-existing projection returns 'already_exists'", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "already_exists", projectionId: "team_abc12345_1700000000000:run-x" });

      const body = await runRequest();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("already_exists");
    });

    it("mode: human_review_needed routes on decisionReceipt.humanReviewNeeded alone, independent of automatedGovernanceStatus", async () => {
      setupCreatedGovernance({ decisionReceipt: { ...governanceRecord().decisionReceipt, humanReviewNeeded: true } });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "human_review_needed" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "x" });

      const body = await runRequest();

      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
      expect(mockedCreateAdaptiveTeamRunProjection).toHaveBeenCalledTimes(1);
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("created");
    });

    it("mode: all creates a projection regardless of governance status", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "all" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "x" });

      const body = await runRequest();

      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
      expect(mockedCreateAdaptiveTeamRunProjection).toHaveBeenCalledTimes(1);
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("created");
    });
  });

  describe("non-creation paths", () => {
    it("disabled team settings never create a projection", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: false, mode: "all" }));

      const body = await runRequest();

      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("disabled");
    });

    it("no team (user has no teamId, or team doc absent) never creates a projection", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });

      const body = await runRequest();

      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("disabled");
    });

    it("loadUserAndTeam returning null (Firestore unavailable) never creates a projection and is treated as disabled, not a route failure", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(null);

      const body = await runRequest();

      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("disabled");
      expect(body.ok).toBe(true);
    });

    it("malformed settings (fails closed inside parseAdaptiveReviewSettings) result in no creation", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      // Simulate what teamApiAuth would produce for a malformed stored value —
      // loadUserAndTeam itself is mocked here, so we directly provide the
      // already-parsed fail-closed result its real implementation would give.
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: false, mode: "flagged_only" }));

      const body = await runRequest();

      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("disabled");
    });

    it("flagged_only + passed automated-governance status is not eligible", async () => {
      setupCreatedGovernance({}, { failedModels: 0, successfulModels: 2 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));

      const body = await runRequest();

      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("not_eligible");
    });

    it("a malformed/unsupported existing governance record (no valid record captured) never reaches the team-review block at all", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: { garbage: true } });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "malformed_existing_record" });

      const body = await runRequest();

      expect(mockedLoadUserAndTeam).not.toHaveBeenCalled();
      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect("adaptiveTeamReviewProjectionStatus" in body.adaptive).toBe(false);
    });

    it("an automated-governance evaluation error under flagged_only is not eligible (an error is not evidence of a flag)", async () => {
      mockedLoadGovernancePolicy.mockRejectedValueOnce(new Error("boom"));
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));

      const body = await runRequest();

      expect(body.adaptive.automatedGovernanceStatus).toBe("error");
      expect(mockedCreateAdaptiveTeamRunProjection).not.toHaveBeenCalled();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("not_eligible");
    });
  });

  describe("failure isolation", () => {
    it("projection-creation failure preserves the adaptive answer and HTTP 200", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "write_failed" });

      mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: classificationJson("decision_support"), latencyMs: 5 } as any);
      const response = await POST(buildRequest("Which CRM should we choose?"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("failed");
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
    });

    it("loadUserAndTeam throwing is caught and reported as 'failed', without affecting the HTTP response", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockRejectedValueOnce(new Error("boom"));

      const body = await runRequest();

      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("failed");
      expect(body.ok).toBe(true);
    });

    it("createAdaptiveTeamRunProjection throwing is caught and reported as 'failed'", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockRejectedValueOnce(new Error("boom"));

      const body = await runRequest();
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("failed");
      expect(body.ok).toBe(true);
    });
  });

  describe("response contract — no sensitive detail leaked", () => {
    it("never exposes the projection ID, team ID, routing reason, or governance reasons", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "SECRET_PROJECTION_ID" });

      const body = await runRequest();

      const serialized = JSON.stringify(body.adaptive);
      expect(serialized).not.toContain("SECRET_PROJECTION_ID");
      expect(serialized).not.toContain("team_abc12345_1700000000000");
      expect(body.adaptive).not.toHaveProperty("adaptiveTeamReviewRoutingReason");
      expect(body.adaptive).not.toHaveProperty("automatedGovernanceReasons");
    });
  });

  describe("ordering and no double-execution", () => {
    it("team-review routing is attempted only after automated governance resolves, using its final status", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockImplementationOnce(async () => {
        expect(mockedPersistAutomatedGovernanceUpdate).toHaveBeenCalledTimes(1);
        return team({ enabled: true, mode: "flagged_only" });
      });
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "x" });

      await runRequest();
      expect(mockedLoadUserAndTeam).toHaveBeenCalledTimes(1);
    });

    it("does not call runPanel, checkAndIncrementUsageForRun, createRun, completeRun, or finalizeAdaptiveRun a second time", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "x" });

      await runRequest();

      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
      expect(mockedCreateRun).toHaveBeenCalledTimes(1);
      expect(mockedCompleteRun).toHaveBeenCalledTimes(1);
      expect(mockedFinalizeAdaptiveRun).toHaveBeenCalledTimes(1);
      expect(mockedLoadUserAndTeam).toHaveBeenCalledTimes(1);
      expect(mockedCreateAdaptiveTeamRunProjection).toHaveBeenCalledTimes(1);
    });

    it("does not call persistAutomatedGovernanceUpdate or writeAdaptiveGovernanceEvent again from this block", async () => {
      setupCreatedGovernance({}, { failedModels: 2, successfulModels: 0 });
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "x" });

      await runRequest();

      expect(mockedPersistAutomatedGovernanceUpdate).toHaveBeenCalledTimes(1);
      expect(mockedWriteAdaptiveGovernanceEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("projection contents — real passthrough from the record and route context", () => {
    it("passes the real runId, schemaId, answerShape, receipt fields, and team/user IDs into the projection builder", async () => {
      setupCreatedGovernance(
        {
          schemaId: "decision_support",
          answerShape: "decision_support_view",
          decisionReceipt: {
            conclusion: "Custom conclusion text.",
            basis: [],
            assumptions: [],
            uncertainties: [],
            limitations: [],
            sources: [],
            sourceBacked: true,
            humanReviewNeeded: false,
          },
        },
        { failedModels: 2, successfulModels: 0 }
      );
      mockedLoadUserAndTeam.mockResolvedValueOnce(team({ enabled: true, mode: "flagged_only" }));
      mockedCreateAdaptiveTeamRunProjection.mockResolvedValueOnce({ status: "created", projectionId: "x" });

      await runRequest();

      const [projectionArg] = mockedCreateAdaptiveTeamRunProjection.mock.calls[0];
      expect(projectionArg.teamId).toBe("team_abc12345_1700000000000");
      expect(projectionArg.userId).toBe("test-uid");
      expect(projectionArg.schemaId).toBe("decision_support");
      expect(projectionArg.answerShape).toBe("decision_support_view");
      expect(projectionArg.receiptConclusion).toBe("Custom conclusion text.");
      expect(projectionArg.sourceBacked).toBe(true);
      expect(projectionArg.automatedGovernanceStatus).toBe("flagged");
      expect(projectionArg.humanReviewStatus).toBe("unreviewed");
      expect(typeof projectionArg.runId).toBe("string");
    });
  });
});
