/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part C — adaptive
 * automated-governance ROUTE WIRING tests.
 *
 * Mirrors governanceInitializationWiring.spec.ts's own approach (every
 * side-effecting dependency mocked, `finalizeAdaptiveRun` partially
 * mocked). `loadGovernancePolicy` (Firestore-dependent) is mocked;
 * `evaluateAdaptiveGovernance`/`applyAutomatedGovernanceUpdate` are left
 * REAL and pure (no I/O) — running them for real here tests genuine
 * end-to-end wiring (do the route's derived model counts and the loaded
 * policy actually flow through into a correct evaluator result?), not
 * just that a mock was called. The evaluator's own rule logic already has
 * full unit coverage in evaluateAdaptiveGovernance.spec.ts — this file's
 * job is the LIFECYCLE decision (when does evaluation run at all, what
 * happens to its result) documented in docs/governance-decision-receipts-design.md
 * §18.8/§18a.
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

describe("POST /api/run-panel — Step 6B Part C adaptive automated-governance wiring", () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockedCallGemini.mockReset();
    mockedFinalizeAdaptiveRun.mockReset();
    mockedReadGovernanceRecord.mockReset();
    mockedInitializeGovernance.mockReset();
    mockedPersistAutomatedGovernanceUpdate.mockReset();
    mockedWriteAdaptiveGovernanceEvent.mockReset();
    mockedLoadGovernancePolicy.mockReset();
  });

  beforeEach(() => {
    mockedLoadGovernancePolicy.mockResolvedValue(DEFAULT_POLICY);
    mockedPersistAutomatedGovernanceUpdate.mockResolvedValue({ saved: true });
    mockedWriteAdaptiveGovernanceEvent.mockResolvedValue({ written: true });
  });

  describe("lifecycle — governance initialization status determines whether evaluation runs", () => {
    it("created: evaluates, persists nested fields, emits the event, returns a status", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();

      expect(mockedLoadGovernancePolicy).toHaveBeenCalledTimes(1);
      expect(mockedPersistAutomatedGovernanceUpdate).toHaveBeenCalledTimes(1);
      expect(mockedWriteAdaptiveGovernanceEvent).toHaveBeenCalledTimes(1);
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
      expect(body.adaptive.governanceInitializationStatus).toBe("created");
    });

    it("already_exists WITHOUT automatedGovernance: evaluates, persists, emits event", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: governanceRecord() });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "already_exists", record: governanceRecord() });

      const body = await runRequest();

      expect(mockedPersistAutomatedGovernanceUpdate).toHaveBeenCalledTimes(1);
      expect(mockedWriteAdaptiveGovernanceEvent).toHaveBeenCalledTimes(1);
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
    });

    it("already_exists WITH automatedGovernance: does not reevaluate, does not persist, does not emit a second event, returns the existing status", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      const existing = governanceRecord({
        automatedGovernance: { status: "flagged", reasons: ["a prior reason"], evaluatedAt: "2020-01-01T00:00:00.000Z", policyVersion: 1 },
      });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: existing });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "already_exists", record: existing });

      const body = await runRequest();

      expect(mockedLoadGovernancePolicy).not.toHaveBeenCalled();
      expect(mockedPersistAutomatedGovernanceUpdate).not.toHaveBeenCalled();
      expect(mockedWriteAdaptiveGovernanceEvent).not.toHaveBeenCalled();
      expect(body.adaptive.automatedGovernanceStatus).toBe("flagged");
    });

    it("blocked_reviewed WITHOUT automatedGovernance: evaluates, preserves terminal humanReview, persists only nested fields", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      const reviewed = governanceRecord({ humanReview: { status: "approved", reviewerId: "u1" } });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: reviewed });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "blocked_reviewed", record: reviewed });

      const body = await runRequest();

      expect(mockedPersistAutomatedGovernanceUpdate).toHaveBeenCalledTimes(1);
      const [, persistedAutomatedGovernance] = mockedPersistAutomatedGovernanceUpdate.mock.calls[0];
      expect(persistedAutomatedGovernance.status).toBe("passed");
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
      expect(body.adaptive.governanceInitializationStatus).toBe("blocked_reviewed");
    });

    it("blocked_reviewed WITH automatedGovernance: does not reevaluate, preserves existing status", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      const reviewed = governanceRecord({
        humanReview: { status: "rejected", reviewerId: "u1" },
        automatedGovernance: { status: "blocked", reasons: [], evaluatedAt: "2020-01-01T00:00:00.000Z", policyVersion: 1 },
      });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: reviewed });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "blocked_reviewed", record: reviewed });

      const body = await runRequest();

      expect(mockedPersistAutomatedGovernanceUpdate).not.toHaveBeenCalled();
      expect(body.adaptive.automatedGovernanceStatus).toBe("blocked");
    });

    it.each(["malformed_existing_record", "unsupported_existing_version"])(
      "%s: skips evaluation entirely, omits automatedGovernanceStatus from the response",
      async (status) => {
        mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
        mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: { garbage: true } });
        mockedInitializeGovernance.mockResolvedValueOnce({ status });

        const body = await runRequest();

        expect(mockedLoadGovernancePolicy).not.toHaveBeenCalled();
        expect(mockedPersistAutomatedGovernanceUpdate).not.toHaveBeenCalled();
        expect(mockedWriteAdaptiveGovernanceEvent).not.toHaveBeenCalled();
        expect("automatedGovernanceStatus" in body.adaptive).toBe(false);
      }
    );

    it.each(["omitted_size_limit", "failed"])("%s: skips evaluation entirely", async (status) => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status, record: governanceRecord() });

      const body = await runRequest();

      expect(mockedLoadGovernancePolicy).not.toHaveBeenCalled();
      expect(mockedPersistAutomatedGovernanceUpdate).not.toHaveBeenCalled();
      expect("automatedGovernanceStatus" in body.adaptive).toBe(false);
    });

    it("skipped_adaptive_not_saved (adaptive persistence itself failed): skips evaluation entirely", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: false, reason: "write_failed" });

      const body = await runRequest();

      expect(mockedReadGovernanceRecord).not.toHaveBeenCalled();
      expect(mockedLoadGovernancePolicy).not.toHaveBeenCalled();
      expect(body.adaptive.governanceInitializationStatus).toBe("skipped_adaptive_not_saved");
      expect("automatedGovernanceStatus" in body.adaptive).toBe(false);
    });

    it("not_applicable: skips evaluation entirely", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "not_applicable" });

      const body = await runRequest();

      expect(mockedLoadGovernancePolicy).not.toHaveBeenCalled();
      expect("automatedGovernanceStatus" in body.adaptive).toBe(false);
    });
  });

  describe("model counts — real passthrough from commonResponseMeta, no re-derivation", () => {
    it("passes a real failure count through to a flagged result", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 2, successfulModels: 0 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();

      expect(body.adaptive.automatedGovernanceStatus).toBe("flagged");
      const [, automatedGovernance] = mockedPersistAutomatedGovernanceUpdate.mock.calls[0];
      expect(automatedGovernance.reasons).toContain("2 model(s) failed to produce usable output");
    });

    it("zero failures produces a passed result", async () => {
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
    });

    it("skips evaluation (omits the field) when commonResponseMeta itself is unavailable — never fabricates a count", async () => {
      mockFinalizeWithPersistedOutput(null as any);
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();

      expect(mockedLoadGovernancePolicy).not.toHaveBeenCalled();
      expect(mockedPersistAutomatedGovernanceUpdate).not.toHaveBeenCalled();
      expect("automatedGovernanceStatus" in body.adaptive).toBe(false);
    });
  });

  describe("policy loading", () => {
    it("calls the real policy loader exactly once", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();
      expect(mockedLoadGovernancePolicy).toHaveBeenCalledTimes(1);
    });

    it("preserves the numeric policyVersion into the persisted automatedGovernance", async () => {
      mockedLoadGovernancePolicy.mockResolvedValue({ ...DEFAULT_POLICY, policyVersion: 9 });
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();
      const [, automatedGovernance] = mockedPersistAutomatedGovernanceUpdate.mock.calls[0];
      expect(automatedGovernance.policyVersion).toBe(9);
    });

    it("policy load failure returns 'error' and writes nothing — no permissive fallback", async () => {
      mockedLoadGovernancePolicy.mockRejectedValueOnce(new Error("Firestore unavailable"));
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();

      expect(mockedPersistAutomatedGovernanceUpdate).not.toHaveBeenCalled();
      expect(mockedWriteAdaptiveGovernanceEvent).not.toHaveBeenCalled();
      expect(body.adaptive.automatedGovernanceStatus).toBe("error");
      expect(body.ok).toBe(true);
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
    });
  });

  describe("nested persistence", () => {
    it("passes only automatedGovernance + updatedAt semantics to persistAutomatedGovernanceUpdate — never humanReview or decisionReceipt", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();

      const [runIdArg, automatedGovernanceArg, updatedAtArg] = mockedPersistAutomatedGovernanceUpdate.mock.calls[0];
      expect(typeof runIdArg).toBe("string");
      expect(automatedGovernanceArg).not.toHaveProperty("humanReview");
      expect(automatedGovernanceArg).not.toHaveProperty("decisionReceipt");
      expect(typeof updatedAtArg).toBe("string");
    });

    it("uses one shared timestamp across the evaluator, the persisted updatedAt, and the governance event", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();

      const [, automatedGovernance, updatedAt] = mockedPersistAutomatedGovernanceUpdate.mock.calls[0];
      const [, eventAutomatedGovernance, eventAt] = mockedWriteAdaptiveGovernanceEvent.mock.calls[0];
      expect(automatedGovernance.evaluatedAt).toBe(updatedAt);
      expect(eventAt).toBe(updatedAt);
      expect(eventAutomatedGovernance).toEqual(automatedGovernance);
    });

    it("missing run (persistence reports run_missing) returns 'error' safely", async () => {
      mockedPersistAutomatedGovernanceUpdate.mockResolvedValueOnce({ saved: false, reason: "run_missing" });
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.automatedGovernanceStatus).toBe("error");
      expect(mockedWriteAdaptiveGovernanceEvent).not.toHaveBeenCalled();
    });

    it("a write failure returns 'error' and never emits the event", async () => {
      mockedPersistAutomatedGovernanceUpdate.mockResolvedValueOnce({ saved: false, reason: "write_failed" });
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.automatedGovernanceStatus).toBe("error");
      expect(mockedWriteAdaptiveGovernanceEvent).not.toHaveBeenCalled();
    });

    it("does not retry after a persistence failure", async () => {
      mockedPersistAutomatedGovernanceUpdate.mockResolvedValueOnce({ saved: false, reason: "write_failed" });
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();
      expect(mockedPersistAutomatedGovernanceUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("governance events", () => {
    it("is emitted only after persistence succeeds", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();
      expect(mockedWriteAdaptiveGovernanceEvent).toHaveBeenCalledTimes(1);
    });

    it("an event-write failure does not change the already-persisted evaluator status", async () => {
      mockedWriteAdaptiveGovernanceEvent.mockResolvedValueOnce({ written: false, reason: "write_failed" });
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
    });

    it("an event-write exception does not change the already-persisted evaluator status", async () => {
      mockedWriteAdaptiveGovernanceEvent.mockRejectedValueOnce(new Error("boom"));
      mockFinalizeWithPersistedOutput({ failedModels: 0, successfulModels: 2 });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
      expect(body.ok).toBe(true);
    });
  });

  describe("response contract", () => {
    it("preserves governanceInitializationStatus unchanged alongside the new automatedGovernanceStatus", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.governanceInitializationStatus).toBe("created");
      expect(body.adaptive.automatedGovernanceStatus).toBe("passed");
    });

    it("leaves all other existing adaptive response fields unchanged", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      expect(body.adaptive.schemaId).toBe("decision_support");
      expect(body.adaptive.persistenceStatus).toBe("saved");
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
      expect(body.runId).toEqual(expect.any(String));
      expect(body.usage).toBeDefined();
    });

    it("never exposes reasons, policy internals, or raw errors on the response", async () => {
      mockedLoadGovernancePolicy.mockRejectedValueOnce(new Error("SECRET POLICY LOAD ERROR"));
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      const body = await runRequest();
      const serialized = JSON.stringify(body.adaptive.automatedGovernanceStatus);
      expect(serialized).not.toContain("SECRET POLICY LOAD ERROR");
      expect(body.adaptive).not.toHaveProperty("automatedGovernanceReasons");
    });
  });

  describe("failure isolation", () => {
    it("a total evaluation failure still returns the live adaptive answer with HTTP 200", async () => {
      mockedLoadGovernancePolicy.mockRejectedValueOnce(new Error("boom"));
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: classificationJson("decision_support"), latencyMs: 5 } as any);
      const response = await POST(buildRequest("Which CRM should we choose?"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
    });

    it("does not call runPanel, checkAndIncrementUsageForRun, createRun, or completeRun a second time", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();

      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
      expect(mockedCreateRun).toHaveBeenCalledTimes(1);
      expect(mockedCompleteRun).toHaveBeenCalledTimes(1);
    });

    it("does not call finalizeAdaptiveRun a second time", async () => {
      mockFinalizeWithPersistedOutput();
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: governanceRecord() });

      await runRequest();
      expect(mockedFinalizeAdaptiveRun).toHaveBeenCalledTimes(1);
    });
  });
});
