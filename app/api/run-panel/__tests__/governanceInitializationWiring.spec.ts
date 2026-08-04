/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part C — governance
 * initialization route wiring tests.
 *
 * Mirrors routingGuard.spec.ts's own approach: every side-effecting
 * dependency is mocked, including `finalizeAdaptiveRun` itself (a partial
 * mock of `@/lib/adaptiveSchema/orchestrate` — `planAdaptiveRun` and
 * `buildNonExecutionPayload` stay real, driven by a mocked classification
 * response, so the pre-execution routing guard still behaves correctly;
 * only `finalizeAdaptiveRun` is overridden, since exercising the real
 * per-model validation/alignment pipeline for a Milestone 2 schema isn't
 * this file's concern — `governanceInitialization.spec.ts` already proves
 * the initializer itself). This lets each test control exactly what
 * `adaptiveOutput.persistedOutput` and `persistenceStatus` are, and observe
 * exactly how the route reacts.
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
const mockedPersistAdaptiveOutput = jest.fn();
const mockedReadGovernanceRecord = jest.fn();
// Step 6B, Part C additions — none of THIS file's existing tests set
// `commonResponseMeta` on their mocked `finalizeAdaptiveRun` return value,
// so the route's automated-governance block always hits its own
// commonResponseMeta gate and skips before ever calling these — mocked
// here only so the module import itself resolves cleanly, not because
// these existing tests exercise automated governance (that's
// adaptiveAutomatedGovernanceWiring.spec.ts's job).
const mockedPersistAutomatedGovernanceUpdate = jest.fn().mockResolvedValue({ saved: true });
const mockedWriteAdaptiveGovernanceEvent = jest.fn().mockResolvedValue({ written: true });
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
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: jest.fn().mockResolvedValue({
    policyVersion: 1,
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
  }),
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

const mockedInitializeGovernance = jest.fn();
jest.mock("@/lib/adaptiveSchema/governanceInitialization", () => ({
  initializeAdaptiveGovernanceRecord: (...args: any[]) => mockedInitializeGovernance(...args),
}));

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

const PERSISTED_OUTPUT = {
  version: 1,
  schemaId: "decision_support",
  answerShape: "decision_support_view",
  classification: {},
  meta: {},
  result: { totalModels: 2 },
  generatedAt: "2026-07-29T00:00:00.000Z",
};

function mockFinalizeWithPersistedOutput() {
  mockedFinalizeAdaptiveRun.mockResolvedValueOnce({
    schemaId: "decision_support",
    adaptiveResults: [],
    persistedOutput: PERSISTED_OUTPUT,
  });
}

function mockFinalizeWithoutPersistedOutput() {
  mockedFinalizeAdaptiveRun.mockResolvedValueOnce({
    schemaId: "factual_lookup",
    adaptiveResults: [],
    persistedOutput: undefined,
  });
}

async function runDecisionSupportRequest() {
  mockedCallGemini.mockResolvedValueOnce({
    modelId: "gemini",
    status: "ok",
    rawText: classificationJson("decision_support"),
    latencyMs: 5,
  } as any);
  const response = await POST(buildRequest("Which CRM should we choose?"));
  return response.json();
}

describe("POST /api/run-panel — Step 5C governance initialization wiring", () => {
  afterEach(() => {
    jest.clearAllMocks();
    // clearAllMocks() clears call history but NOT queued
    // mockResolvedValueOnce/mockImplementationOnce values — these five
    // mocks are configured per-test with `Once` variants and have no
    // module-level default, so a leftover unconsumed queue entry could
    // otherwise bleed into the next test. mockReset() removes those too.
    mockedCallGemini.mockReset();
    mockedFinalizeAdaptiveRun.mockReset();
    mockedPersistAdaptiveOutput.mockReset();
    mockedReadGovernanceRecord.mockReset();
    mockedInitializeGovernance.mockReset();
  });

  describe("governance runs only after a successful adaptive save", () => {
    it("adaptive saved + no existing record → initializer called, status surfaced as created", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: {} });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).toHaveBeenCalledTimes(1);
      expect(mockedInitializeGovernance).toHaveBeenCalledWith(
        expect.objectContaining({ runId: expect.any(String), adaptiveOutput: PERSISTED_OUTPUT, existingGovernanceRecord: undefined })
      );
      expect(body.adaptive.persistenceStatus).toBe("saved");
      expect(body.adaptive.governanceInitializationStatus).toBe("created");
    });

    it("adaptive saved + existing unreviewed record found → passes the real existing record, surfaces already_exists", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      const existing = { version: 1, humanReview: { status: "unreviewed" } };
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: existing });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "already_exists", record: existing });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).toHaveBeenCalledWith(expect.objectContaining({ existingGovernanceRecord: existing }));
      expect(body.adaptive.governanceInitializationStatus).toBe("already_exists");
    });

    it("adaptive saved + existing blocked_reviewed record → surfaces blocked_reviewed", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: { humanReview: { status: "approved" } } });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "blocked_reviewed", record: {} });

      const body = await runDecisionSupportRequest();
      expect(body.adaptive.governanceInitializationStatus).toBe("blocked_reviewed");
    });

    it("adaptive saved + malformed existing record → surfaces malformed_existing_record", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: { garbage: true } });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "malformed_existing_record", reason: "malformed" });

      const body = await runDecisionSupportRequest();
      expect(body.adaptive.governanceInitializationStatus).toBe("malformed_existing_record");
    });

    it("adaptive saved + unsupported existing version → surfaces unsupported_existing_version", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "found", value: { version: 99 } });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "unsupported_existing_version", reason: "unsupported_version" });

      const body = await runDecisionSupportRequest();
      expect(body.adaptive.governanceInitializationStatus).toBe("unsupported_existing_version");
    });

    it("initializer reports oversized → the live adaptive answer is still returned in full", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "omitted_size_limit", record: {} });

      const body = await runDecisionSupportRequest();
      expect(body.adaptive.governanceInitializationStatus).toBe("omitted_size_limit");
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
      expect(body.ok).toBe(true);
    });

    it("initializer reports failed → the live adaptive answer is still returned in full and HTTP is still 200", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "failed", reason: "write_failed" });

      const response = await (async () => {
        mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: classificationJson("decision_support"), latencyMs: 5 } as any);
        return POST(buildRequest("Which CRM should we choose?"));
      })();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.adaptive.governanceInitializationStatus).toBe("failed");
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
    });
  });

  describe("governance is skipped when adaptive persistence did not succeed", () => {
    it("adaptive persistence failed → governance skipped, initializer never called", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: false, reason: "write_failed" });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(mockedReadGovernanceRecord).not.toHaveBeenCalled();
      expect(body.adaptive.persistenceStatus).toBe("failed");
      expect(body.adaptive.governanceInitializationStatus).toBe("skipped_adaptive_not_saved");
    });

    it("adaptive persistence omitted for size → governance skipped, initializer never called", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: false, reason: "oversized" });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(body.adaptive.persistenceStatus).toBe("omitted_size_limit");
      expect(body.adaptive.governanceInitializationStatus).toBe("skipped_adaptive_not_saved");
    });

    it("no persistedOutput at all (legacy schema) → governance status omitted entirely, initializer never called", async () => {
      mockFinalizeWithoutPersistedOutput();

      mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: classificationJson("factual_lookup"), latencyMs: 5 } as any);
      const response = await POST(buildRequest("What is the capital of Kenya?"));
      const body = await response.json();

      expect(mockedPersistAdaptiveOutput).not.toHaveBeenCalled();
      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(mockedReadGovernanceRecord).not.toHaveBeenCalled();
      expect(body.adaptive.governanceInitializationStatus).toBeUndefined();
      expect("governanceInitializationStatus" in body.adaptive).toBe(false);
    });
  });

  describe("existing-record read failure — the critical safety rule", () => {
    it("a failed read never becomes undefined passed to the initializer — governance skipped, status failed", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "read_failed" });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(body.adaptive.governanceInitializationStatus).toBe("failed");
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
    });

    it("firestore_unavailable on the read is treated the same as a failed read, not absent", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "firestore_unavailable" });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(body.adaptive.governanceInitializationStatus).toBe("failed");
    });

    it("a missing run document (run_missing) never calls the initializer — orphan-document prevention", async () => {
      // persistGovernanceRecord()'s .set(..., {merge:true}) would CREATE a
      // document if the run doesn't exist. The ONLY caller of
      // persistGovernanceRecord is initializeAdaptiveGovernanceRecord, which
      // is mocked here — so asserting it's never called is a direct,
      // structural proof that no write (and therefore no orphan
      // runs/{runId} document containing only governanceRecord) can happen
      // on this path, not just an inference.
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "run_missing" });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(body.adaptive.governanceInitializationStatus).toBe("failed");
    });

    it("run_missing is never treated the same as absent — the initializer is never invoked with existingGovernanceRecord: undefined for a missing run", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "run_missing" });

      await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).not.toHaveBeenCalledWith(expect.objectContaining({ existingGovernanceRecord: undefined }));
      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
    });

    it("positive absence (run exists, no governanceRecord field) still allows initialization, unlike run_missing", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: {} });

      const body = await runDecisionSupportRequest();

      expect(mockedInitializeGovernance).toHaveBeenCalledTimes(1);
      expect(mockedInitializeGovernance).toHaveBeenCalledWith(expect.objectContaining({ existingGovernanceRecord: undefined }));
      expect(body.adaptive.governanceInitializationStatus).toBe("created");
    });
  });

  describe("non-execution and handoff paths never reach governance initialization", () => {
    it("a Claim Verification handoff never calls the initializer, the read helper, or finalizeAdaptiveRun", async () => {
      mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: classificationJson("claim_verification"), latencyMs: 5 } as any);

      const response = await POST(buildRequest("The unemployment rate is 4.2%. Is this true?"));
      const body = await response.json();

      expect(mockedFinalizeAdaptiveRun).not.toHaveBeenCalled();
      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(mockedReadGovernanceRecord).not.toHaveBeenCalled();
      expect(body.adaptive.routingOutcome).toBe("handoff");
    });

    it("a disabled schema never calls the initializer, the read helper, or finalizeAdaptiveRun", async () => {
      mockedCallGemini.mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: classificationJson("document_qa"), latencyMs: 5 } as any);

      const response = await POST(buildRequest("What does this contract say about termination?"));
      const body = await response.json();

      expect(mockedFinalizeAdaptiveRun).not.toHaveBeenCalled();
      expect(mockedInitializeGovernance).not.toHaveBeenCalled();
      expect(mockedReadGovernanceRecord).not.toHaveBeenCalled();
      expect(body.adaptive.routingOutcome).toBe("capability_gap");
    });
  });

  describe("no double-charging or re-execution side effects from governance", () => {
    it("governance initialization does not call runPanel, checkAndIncrementUsageForRun, createRun, or completeRun a second time", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: {} });

      await runDecisionSupportRequest();

      expect(mockedRunPanel).toHaveBeenCalledTimes(1);
      expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
      expect(mockedCreateRun).toHaveBeenCalledTimes(1);
      expect(mockedCompleteRun).toHaveBeenCalledTimes(1);
    });

    it("governance initialization happens after persistAdaptiveOutput, not before", async () => {
      mockFinalizeWithPersistedOutput();
      const callOrder: string[] = [];
      mockedPersistAdaptiveOutput.mockImplementationOnce(async () => {
        callOrder.push("persistAdaptiveOutput");
        return { saved: true };
      });
      mockedReadGovernanceRecord.mockImplementationOnce(async () => {
        callOrder.push("readGovernanceRecordForInitialization");
        return { status: "absent" };
      });
      mockedInitializeGovernance.mockImplementationOnce(async () => {
        callOrder.push("initializeAdaptiveGovernanceRecord");
        return { status: "created", record: {} };
      });

      await runDecisionSupportRequest();

      expect(callOrder).toEqual(["persistAdaptiveOutput", "readGovernanceRecordForInitialization", "initializeAdaptiveGovernanceRecord"]);
    });
  });

  describe("response shape", () => {
    it("keeps all existing adaptive response fields unchanged alongside the new governance field", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({ status: "created", record: {} });

      const body = await runDecisionSupportRequest();

      expect(body.adaptive.schemaId).toBe("decision_support");
      expect(body.adaptive.persistenceStatus).toBe("saved");
      expect(body.adaptive.adaptiveOutput).toEqual(PERSISTED_OUTPUT);
      expect(body.runId).toEqual(expect.any(String));
      expect(body.usage).toBeDefined();
    });

    it("never exposes a raw error message, reason, or receipt content on the response's governance field", async () => {
      mockFinalizeWithPersistedOutput();
      mockedPersistAdaptiveOutput.mockResolvedValueOnce({ saved: true });
      mockedReadGovernanceRecord.mockResolvedValueOnce({ status: "absent" });
      mockedInitializeGovernance.mockResolvedValueOnce({
        status: "failed",
        reason: "unexpected_error",
        record: { decisionReceipt: { conclusion: "SHOULD NOT LEAK" } },
      });

      const body = await runDecisionSupportRequest();

      expect(body.adaptive.governanceInitializationStatus).toBe("failed");
      expect(body.adaptive).not.toHaveProperty("governanceReason");
      const serialized = JSON.stringify(body.adaptive.governanceInitializationStatus);
      expect(serialized).not.toContain("SHOULD NOT LEAK");
    });
  });
});
