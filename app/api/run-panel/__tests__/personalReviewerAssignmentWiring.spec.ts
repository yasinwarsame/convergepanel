/**
 * Reviewer Assignment Propagation — route wiring tests for the personal
 * (non-team) automatic assignment trigger in POST /api/run-panel.
 *
 * Mirrors adaptiveTeamReviewProjectionWiring.spec.ts's approach and mock
 * scaffolding exactly. `propagatePersonalReviewerAssignment` itself is
 * mocked here — its own logic (eligibility, transaction reuse, audit)
 * already has full unit coverage in personalReviewerAssignment.spec.ts;
 * this file only tests that the route calls it at the right time, with the
 * right arguments, and wires its result into `reviewRouting` correctly —
 * and, just as importantly, that it is NEVER called at all for a team run.
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

const mockedPropagatePersonalReviewerAssignment = jest.fn();
jest.mock("@/lib/governance/personalReviewerAssignment", () => ({
  propagatePersonalReviewerAssignment: (...args: any[]) => mockedPropagatePersonalReviewerAssignment(...args),
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

function team() {
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
      adaptiveReviewSettings: { enabled: false, mode: "all" },
    },
  };
}

/** "created" governance record — the only status this trigger ever fires on. */
function setupCreatedGovernance(metaOverrides: Record<string, unknown> = { failedModels: 0, successfulModels: 2 }) {
  mockFinalizeWithPersistedOutput(metaOverrides);
  mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
  mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });
}

/** "already_exists" — a reload/retry of an already-initialized run; must never re-trigger the propagation attempt. */
function setupAlreadyExistsGovernance() {
  mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
  mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: governanceRecord() });
  mockedInitializeGovernance.mockResolvedValueOnce({ status: "already_exists", record: governanceRecord() });
}

describe("POST /api/run-panel — Reviewer Assignment Propagation wiring", () => {
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
    mockedPropagatePersonalReviewerAssignment.mockReset();
  });

  beforeEach(() => {
    mockedLoadGovernancePolicy.mockResolvedValue(DEFAULT_POLICY);
    mockedPersistAutomatedGovernanceUpdate.mockResolvedValue({ saved: true });
    mockedWriteAdaptiveGovernanceEvent.mockResolvedValue({ written: true });
  });

  describe("trigger conditions", () => {
    it("no team + freshly created governance -> propagation attempted with the run's own uid/runId", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "assigned", reviewerUserId: "reviewer-1" });

      const body = await runRequest();

      expect(mockedPropagatePersonalReviewerAssignment).toHaveBeenCalledTimes(1);
      const [callArg] = mockedPropagatePersonalReviewerAssignment.mock.calls[0];
      expect(callArg.ownerUserId).toBe("test-uid");
      expect(typeof callArg.runId).toBe("string");
      expect(body.adaptive.personalReviewerAssignmentStatus).toBe("assigned");
      expect(body.adaptive.adaptiveTeamReviewProjectionStatus).toBe("disabled");
    });

    it("a TEAM run never triggers personal propagation at all, regardless of team review settings", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce(team());

      await runRequest();

      expect(mockedPropagatePersonalReviewerAssignment).not.toHaveBeenCalled();
    });

    it("governance status 'already_exists' (reload/retry) never re-triggers propagation, even with no team", async () => {
      setupAlreadyExistsGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });

      const body = await runRequest();

      expect(mockedPropagatePersonalReviewerAssignment).not.toHaveBeenCalled();
      expect(body.adaptive.personalReviewerAssignmentStatus).toBeUndefined();
    });

    it("loadUserAndTeam returning null (Firestore unavailable) is treated as no-team but still attempts propagation, and never throws", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce(null);
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "not_configured" });

      const body = await runRequest();

      expect(mockedPropagatePersonalReviewerAssignment).toHaveBeenCalledTimes(1);
      expect(body.ok).toBe(true);
    });
  });

  describe("reviewRouting consistency (Step 17)", () => {
    it("personalReviewerAssignmentStatus 'assigned' maps reviewRouting to 'in_queue', same label a team queue projection gets", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "assigned", reviewerUserId: "reviewer-1" });

      const body = await runRequest();
      expect(body.adaptive.reviewRouting).toBe("in_queue");
    });

    it("personalReviewerAssignmentStatus 'already_assigned' also maps reviewRouting to 'in_queue' (an assignment genuinely exists, whichever request created it)", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "already_assigned" });

      const body = await runRequest();
      expect(body.adaptive.reviewRouting).toBe("in_queue");
    });

    it("personalReviewerAssignmentStatus 'not_configured' leaves reviewRouting at 'not_configured' — no reviewer configured means no review configured", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "not_configured" });

      const body = await runRequest();
      expect(body.adaptive.reviewRouting).toBe("not_configured");
    });

    it("personalReviewerAssignmentStatus 'reviewer_unavailable' leaves reviewRouting at 'not_configured' (the reviewer opted out; not a routing failure)", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "reviewer_unavailable" });

      const body = await runRequest();
      expect(body.adaptive.reviewRouting).toBe("not_configured");
    });
  });

  describe("failure isolation (Step 21)", () => {
    it("propagatePersonalReviewerAssignment throwing is caught, reported as 'failed', and never breaks the HTTP response or the adaptive answer", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockRejectedValueOnce(new Error("boom"));

      const body = await runRequest();

      expect(body.adaptive.personalReviewerAssignmentStatus).toBe("failed");
      expect(body.ok).toBe(true);
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
    });

    it("a 'failed' propagation status never falsely claims 'in_queue'", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "failed" });

      const body = await runRequest();
      expect(body.adaptive.reviewRouting).not.toBe("in_queue");
    });
  });

  describe("response contract — no sensitive detail leaked", () => {
    it("never exposes the reviewer uid or any identity in the response", async () => {
      setupCreatedGovernance();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { teamId: undefined }, team: null });
      mockedPropagatePersonalReviewerAssignment.mockResolvedValueOnce({ status: "assigned", reviewerUserId: "SECRET_REVIEWER_UID" });

      const body = await runRequest();

      const serialized = JSON.stringify(body.adaptive);
      expect(serialized).not.toContain("SECRET_REVIEWER_UID");
    });
  });
});
