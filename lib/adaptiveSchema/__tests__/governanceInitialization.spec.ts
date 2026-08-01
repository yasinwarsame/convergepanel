/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part B —
 * initializeAdaptiveGovernanceRecord() tests.
 *
 * Covers: absent-record creation, existing-record preservation for every
 * humanReview status (unreviewed/pending → already_exists,
 * approved/approved_with_conditions/changes_requested/rejected →
 * blocked_reviewed), malformed/unsupported-version existing records,
 * invalid runId/now inputs, persistence failure/oversize mapping, safe
 * failure on an unexpected exception, non-mutation of adaptiveOutput, and
 * zero model/classifier/routing calls.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

jest.mock("@/lib/adaptiveSchema/classifier", () => ({
  classifyQuery: jest.fn(),
}));

const mockPersistGovernanceRecord = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  persistGovernanceRecord: (...args: unknown[]) => mockPersistGovernanceRecord(...args),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { initializeAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceInitialization";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { PersistedAdaptiveOutputV1, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";
import { CommonResponseMeta, DecisionSupportResult, QueryClassification } from "@/lib/adaptiveSchema/types";

const mockedClassifyQuery = classifyQuery as jest.MockedFunction<typeof classifyQuery>;

const NOW = "2026-07-29T12:00:00.000Z";

const decisionSupportResult: DecisionSupportResult = {
  decisionQuestion: "Which CRM should we choose?",
  options: [{ id: "hubspot", label: "HubSpot", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  criteria: [{ id: "cost", label: "Total cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  assessments: [],
  recommendation: {
    action: "choose_option",
    recommendedOptionId: "hubspot",
    rationale: "Lower cost fits the stated budget.",
    caveats: [],
    isContested: false,
    supportCount: 2,
    totalModelsWithRecommendation: 2,
  },
  assumptions: [],
  uncertainties: [],
  risks: [],
  sensitivityFindings: [],
  reversibleNextStep: "Run a 2-week pilot with HubSpot.",
  humanReviewNeeded: false,
  sourceBacked: false,
  totalModels: 2,
};

function classification(): QueryClassification {
  return {
    queryType: "decision_support",
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
    rationale: "test fixture",
  };
}

function meta(): CommonResponseMeta {
  return {
    schemaVersion: 1,
    queryType: "decision_support",
    answerShape: "decision_support_view",
    dataBasis: "training_prior",
    freshness: "timeless",
    riskLevel: "professional",
    evidenceQuality: "not_applicable",
    uncertainties: [],
    blindSpots: [],
    humanReviewNeeded: false,
    generatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function adaptiveOutput(): PersistedAdaptiveOutputV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: SCHEMA_ANSWER_SHAPE.decision_support,
    classification: classification(),
    meta: meta(),
    result: decisionSupportResult,
    generatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function existingRecord(overrides: Partial<GovernanceRecordV1> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "Existing conclusion.",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockedCallGemini.mockClear();
  mockedClassifyQuery.mockClear();
  mockPersistGovernanceRecord.mockReset();
});

describe("initializeAdaptiveGovernanceRecord", () => {
  describe("absent existing record — creation", () => {
    it("creates a new record and persists it", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const result = await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: adaptiveOutput(),
        existingGovernanceRecord: undefined,
        now: NOW,
      });

      expect(result.status).toBe("created");
      expect(result.record).toBeDefined();
      expect(mockPersistGovernanceRecord).toHaveBeenCalledTimes(1);
      expect(mockPersistGovernanceRecord).toHaveBeenCalledWith("run-1", result.record);
    });

    it("starts humanReview.status as unreviewed", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const result = await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: adaptiveOutput(),
        now: NOW,
      });
      expect(result.record?.humanReview).toEqual({ status: "unreviewed" });
    });

    it("sets createdAt equal to updatedAt on a new record", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result.record?.createdAt).toBe(NOW);
      expect(result.record?.updatedAt).toBe(NOW);
    });

    it("preserves schemaId, answerShape, and adaptiveOutputVersion from the adaptiveOutput", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const output = adaptiveOutput();
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: output, now: NOW });
      expect(result.record?.schemaId).toBe(output.schemaId);
      expect(result.record?.answerShape).toBe(output.answerShape);
      expect(result.record?.adaptiveOutputVersion).toBe(output.version);
    });

    it("does not mutate adaptiveOutput", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const output = adaptiveOutput();
      const snapshot = JSON.parse(JSON.stringify(output));
      await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: output, now: NOW });
      expect(output).toEqual(snapshot);
    });

    it("produces a deterministic record for the same input and injected timestamp", async () => {
      mockPersistGovernanceRecord.mockResolvedValue({ saved: true });
      const r1 = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      const r2 = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(r1.record).toEqual(r2.record);
    });

    it("does not include an automatedGovernance field (System A is not wired)", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result.record).not.toHaveProperty("automatedGovernance");
    });

    it("invokes the receipt builder exactly once via a real conclusion, not a placeholder", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: true });
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result.record?.decisionReceipt.conclusion).toContain("HubSpot");
    });
  });

  describe("existing record — unreviewed / pending preserved", () => {
    it.each(["unreviewed", "pending"])("returns already_exists for status %s without rebuilding or persisting", async (status) => {
      const existing = existingRecord({ humanReview: { status: status as any } });
      const result = await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: adaptiveOutput(),
        existingGovernanceRecord: existing,
        now: NOW,
      });

      expect(result).toEqual({ status: "already_exists", record: existing, reason: status });
      expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
    });
  });

  describe("existing record — terminal statuses blocked", () => {
    it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"])(
      "returns blocked_reviewed for status %s without rebuilding or persisting",
      async (status) => {
        const existing = existingRecord({ humanReview: { status: status as any } });
        const result = await initializeAdaptiveGovernanceRecord({
          runId: "run-1",
          adaptiveOutput: adaptiveOutput(),
          existingGovernanceRecord: existing,
          now: NOW,
        });

        expect(result).toEqual({ status: "blocked_reviewed", record: existing, reason: status });
        expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
      }
    );
  });

  describe("existing record — malformed / unsupported version", () => {
    it("returns malformed_existing_record and does not overwrite", async () => {
      const result = await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: adaptiveOutput(),
        existingGovernanceRecord: { version: 1, schemaId: "not_a_real_schema" },
        now: NOW,
      });
      expect(result).toEqual({ status: "malformed_existing_record", reason: "malformed" });
      expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
    });

    it("returns unsupported_existing_version and does not overwrite", async () => {
      const result = await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: adaptiveOutput(),
        existingGovernanceRecord: { ...existingRecord(), version: 2 },
        now: NOW,
      });
      expect(result).toEqual({ status: "unsupported_existing_version", reason: "unsupported_version" });
      expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
    });
  });

  describe("invalid inputs", () => {
    it.each(["", "   "])("returns failed for an empty runId %p without persisting", async (runId) => {
      const result = await initializeAdaptiveGovernanceRecord({ runId, adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result).toEqual({ status: "failed", reason: "invalid_run_id" });
      expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
    });

    it("returns failed for an invalid now without persisting", async () => {
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: "not-a-date" });
      expect(result).toEqual({ status: "failed", reason: "invalid_timestamp" });
      expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
    });

    it("returns not_applicable for an adaptiveOutput that fails validation (e.g. an unsafe cast)", async () => {
      const result = await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: { version: 1, schemaId: "not_a_real_schema" } as unknown as PersistedAdaptiveOutputV1,
        now: NOW,
      });
      expect(result.status).toBe("not_applicable");
      expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
    });
  });

  describe("persistence outcome mapping", () => {
    it("maps an oversized persistence result to omitted_size_limit and still returns the built record", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: false, reason: "oversized" });
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result.status).toBe("omitted_size_limit");
      expect(result.record).toBeDefined();
    });

    it("maps a write_failed persistence result to failed", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: false, reason: "write_failed" });
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result.status).toBe("failed");
    });

    it("maps a firestore_unavailable persistence result to failed", async () => {
      mockPersistGovernanceRecord.mockResolvedValueOnce({ saved: false, reason: "firestore_unavailable" });
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result.status).toBe("failed");
    });

    it("maps an unexpected exception thrown during persistence to failed, never rethrowing", async () => {
      mockPersistGovernanceRecord.mockRejectedValueOnce(new Error("boom"));
      const result = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      expect(result).toEqual({ status: "failed", reason: "unexpected_error" });
    });
  });

  describe("zero model / classifier / routing calls", () => {
    it("never calls a connector or the classifier, for creation or any existing-record branch", async () => {
      mockPersistGovernanceRecord.mockResolvedValue({ saved: true });
      await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
      await initializeAdaptiveGovernanceRecord({
        runId: "run-1",
        adaptiveOutput: adaptiveOutput(),
        existingGovernanceRecord: existingRecord({ humanReview: { status: "approved" } }),
        now: NOW,
      });

      expect(mockedCallGemini).not.toHaveBeenCalled();
      expect(mockedClassifyQuery).not.toHaveBeenCalled();
    });
  });
});
