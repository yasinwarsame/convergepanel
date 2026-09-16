/**
 * Team Research Parity, Phase R1 — REAL, parser-valid run-document fixtures
 * shared by the builder, viewer-role, Team detail route and byte-equality
 * specs. Every envelope here passes the genuine runtime parsers
 * (`parsePersistedAdaptiveOutput`, `parsePersistedLegacyAdaptiveOutput`,
 * `parseGovernanceRecord`) unmocked, so the specs exercise the real
 * interpretation boundary rather than an assumed one.
 */

export const FIXTURE_RUN_ID = "run-parity-1";
export const FIXTURE_OWNER_UID = "creator-1";
export const FIXTURE_WORKSPACE_ID = "aTeamWorkspaceAutoId12345";
export const FIXTURE_PROJECT_ID = "projAutoId0001";

export function deepResearchAdaptiveOutput() {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    classification: { queryType: "deep_research", confidence: 0.9 },
    meta: { limitations: ["l1"] },
    generatedAt: "2026-09-01T00:00:00.000Z",
    result: {
      executiveSummary: "Summary",
      findings: [
        { id: "f1", summary: "Finding one", supportingModels: ["chatgpt"], confidence: "high" },
        { id: "f2", summary: "Finding two", supportingModels: ["claude"], confidence: "medium" },
      ],
      lowConfidenceFindings: [{ id: "f3", summary: "Weak finding", supportingModels: [], confidence: "low" }],
      totalModels: 2,
    },
  };
}

export function comparisonMatrixAdaptiveOutput() {
  return {
    version: 1,
    schemaId: "comparison_matrix",
    answerShape: "comparison_grid",
    classification: { queryType: "comparison_matrix", confidence: 0.8 },
    meta: {},
    generatedAt: "2026-09-01T00:00:00.000Z",
    result: { subjects: ["a", "b"], attributes: ["x"], cells: [], totalModels: 2 },
  };
}

export function legacyAdaptiveOutput() {
  return {
    version: 1,
    schemaId: "procedural",
    classification: { queryType: "procedural", confidence: 0.7 },
    generatedAt: "2026-09-01T00:00:00.000Z",
    results: [{ modelId: "chatgpt", status: "ok" }],
    alignedClaims: [{ text: "c1" }],
    gate: { status: "pass" },
    synthesisReport: { unifiedAnswer: "Unified" },
  };
}

export function governanceRecord(humanReviewStatus = "unreviewed", overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    adaptiveOutputVersion: 1,
    automatedGovernance: { status: "passed", reasons: [] },
    humanReview: { status: humanReviewStatus, conditions: ["cond-a"], decidedVia: "workspace_review", reviewerId: "rev-secret", reviewerName: "Secret Name", comment: "secret comment" },
    decisionReceipt: {
      conclusion: "Concluded",
      basis: ["b1"],
      assumptions: ["a1"],
      uncertainties: ["u1"],
      limitations: ["l1"],
      sources: ["s1"],
      sourceBacked: true,
      humanReviewNeeded: false,
      version: 1,
      schemaId: "deep_research",
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

export function runDocumentWithPerModel() {
  return {
    perModel: [
      { modelId: "chatgpt", status: "ok", rawTextTruncated: "ChatGPT says", tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, latencyMs: 120, wasTruncated: false },
      { modelId: "claude", status: "ok", rawTextTruncated: "Claude says", tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 }, latencyMs: 340, wasTruncated: false },
    ],
  };
}

/** A complete, Team-bound, filed run document carrying every persisted envelope the read surfaces. */
export function fullTeamRunData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: FIXTURE_OWNER_UID,
    workspaceId: FIXTURE_WORKSPACE_ID,
    projectId: FIXTURE_PROJECT_ID,
    question: "What should we build?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    runDocument: runDocumentWithPerModel(),
    synthesizedStructuredReport: { headline: "Report" },
    schemaVersion: 1,
    synthesizedBy: "claude",
    synthesisConsensusSummary: { agreement: 0.8 },
    governanceStatus: "needs_review",
    teamGovernance: { policyFlags: ["pii"], blocked: false, blockMessage: "", governanceReviewRequired: true },
    adaptiveOutput: deepResearchAdaptiveOutput(),
    legacyAdaptiveOutput: legacyAdaptiveOutput(),
    governanceRecord: governanceRecord("unreviewed"),
    ...overrides,
  };
}
