/**
 * ADD-TO-TEAM-PROJECT §M — PARITY: the pure `buildAdaptiveGovernanceRecord()`
 * must produce byte-identical records to what
 * `initializeAdaptiveGovernanceRecord()` persists on its absent-record
 * path, and the initializer's own statuses/reasons must be unchanged by
 * the refactor. Persistence is captured through the same mock the
 * initializer suite uses.
 */

const mockPersistGovernanceRecord = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  persistGovernanceRecord: (...args: unknown[]) => mockPersistGovernanceRecord(...args),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from "fs";
import { join } from "path";
import { buildAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordBuilder";
import { initializeAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceInitialization";
import { PersistedAdaptiveOutputV1, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";
import type { CommonResponseMeta, DecisionSupportResult, QueryClassification } from "@/lib/adaptiveSchema/types";

const NOW = "2026-07-29T12:00:00.000Z";

const decisionSupportResult: DecisionSupportResult = {
  decisionQuestion: "Which CRM should we choose?",
  options: [{ id: "hubspot", label: "HubSpot", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  criteria: [{ id: "cost", label: "Total cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  assessments: [],
  recommendation: { action: "choose_option", recommendedOptionId: "hubspot", rationale: "Lower cost fits the stated budget.", caveats: [], isContested: false, supportCount: 2, totalModelsWithRecommendation: 2 },
  assumptions: [],
  uncertainties: [],
  risks: [],
  sensitivityFindings: [],
  reversibleNextStep: "Run a 2-week pilot with HubSpot.",
  humanReviewNeeded: false,
  sourceBacked: false,
  sources: [],
  totalModels: 2,
};
function classification(): QueryClassification {
  return { queryType: "decision_support", domain: "test", answerShape: "decision_support_view", quantExpected: false, timeSensitivity: "low", userIntent: "make_decision", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless", inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, rationale: "test fixture" };
}
function meta(): CommonResponseMeta {
  return { schemaVersion: 1, queryType: "decision_support", answerShape: "decision_support_view", dataBasis: "training_prior", freshness: "timeless", riskLevel: "professional", evidenceQuality: "not_applicable", uncertainties: [], blindSpots: [], humanReviewNeeded: false, generatedAt: "2026-07-29T00:00:00.000Z" };
}
function adaptiveOutput(): PersistedAdaptiveOutputV1 {
  return { version: 1, schemaId: "decision_support", answerShape: SCHEMA_ANSWER_SHAPE.decision_support, classification: classification(), meta: meta(), result: decisionSupportResult, generatedAt: "2026-07-29T00:00:00.000Z" };
}

beforeEach(() => {
  mockPersistGovernanceRecord.mockReset();
  mockPersistGovernanceRecord.mockResolvedValue({ saved: true });
});

describe("parity", () => {
  it("the builder's record is byte-identical to what the initializer persists and returns", async () => {
    const built = buildAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("expected ok");

    const init = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
    expect(init.status).toBe("created");
    expect(mockPersistGovernanceRecord).toHaveBeenCalledTimes(1);
    const persisted = mockPersistGovernanceRecord.mock.calls[0][1];
    expect(JSON.stringify(persisted)).toBe(JSON.stringify(built.record));
    expect(JSON.stringify(init.record)).toBe(JSON.stringify(built.record));
    expect(built.record.humanReview).toEqual({ status: "unreviewed" });
    expect(built.record.createdAt).toBe(NOW);
    expect(built.record.updatedAt).toBe(NOW);
  });

  it("the builder never touches Firestore, imports no writer, and does not mutate its input", () => {
    const source = readFileSync(join(__dirname, "..", "governanceRecordBuilder.ts"), "utf8");
    expect(source).not.toContain("@/lib/firestore");
    expect(source).not.toContain("adminDb");
    const input = adaptiveOutput();
    const before = JSON.stringify(input);
    buildAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: input, now: NOW });
    expect(JSON.stringify(input)).toBe(before);
    expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
  });

  it("the builder's failure reasons mirror the initializer's (invalid run id / timestamp / not applicable) — and the initializer still reports them identically", async () => {
    expect(buildAdaptiveGovernanceRecord({ runId: " ", adaptiveOutput: adaptiveOutput(), now: NOW })).toEqual({ ok: false, status: "failed", reason: "invalid_run_id" });
    expect(buildAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: "not-a-date" })).toEqual({ ok: false, status: "failed", reason: "invalid_timestamp" });
    const notApplicable = buildAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: { version: 2 } as unknown as PersistedAdaptiveOutputV1, now: NOW });
    expect(notApplicable.ok).toBe(false);
    if (notApplicable.ok) throw new Error("expected not ok");
    expect(notApplicable.status).toBe("not_applicable");

    expect(await initializeAdaptiveGovernanceRecord({ runId: " ", adaptiveOutput: adaptiveOutput(), now: NOW })).toEqual({ status: "failed", reason: "invalid_run_id" });
    expect(await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: "not-a-date" })).toEqual({ status: "failed", reason: "invalid_timestamp" });
    const initNa = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: { version: 2 } as unknown as PersistedAdaptiveOutputV1, now: NOW });
    expect(initNa.status).toBe("not_applicable");
    expect(initNa.reason).toBe(notApplicable.reason);
    expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
  });

  it("an existing reviewed record still blocks the initializer WITHOUT building or persisting (the builder is only reached on the absent path)", async () => {
    const existing = buildAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), now: NOW });
    if (!existing.ok) throw new Error("expected ok");
    const reviewed = { ...existing.record, humanReview: { status: "approved" as const }, updatedAt: "2026-08-01T00:00:00.000Z" };
    const init = await initializeAdaptiveGovernanceRecord({ runId: "run-1", adaptiveOutput: adaptiveOutput(), existingGovernanceRecord: reviewed, now: NOW });
    expect(init.status).toBe("blocked_reviewed");
    expect(mockPersistGovernanceRecord).not.toHaveBeenCalled();
  });
});
