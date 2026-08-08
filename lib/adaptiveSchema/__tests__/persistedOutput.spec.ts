/**
 * Query-Routing Redesign, Phase 1 — parsePersistedAdaptiveOutput() tests.
 *
 * Covers: all 9 schemas serialize/deserialize (round-trip through JSON, the
 * same transform Firestore data undergoes), discriminators select the
 * correct variant, mismatched schemaId/answerShape rejected, mismatched
 * schemaId/result rejected, unknown version fails safe, malformed data
 * fails safe, absent data fails safe, optional fields and source arrays
 * survive round-trip, and the parser never throws regardless of input shape.
 */

import {
  isPersistedLegacyAdaptiveSchemaId,
  parsePersistedAdaptiveOutput,
  parsePersistedLegacyAdaptiveOutput,
  PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS,
  PersistedAdaptiveSchemaId,
  PersistedLegacyAdaptiveSchemaId,
  SCHEMA_ANSWER_SHAPE,
} from "@/lib/adaptiveSchema/persistedOutput";

const BASE_CLASSIFICATION = {
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

const BASE_META = {
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
  generatedAt: "2026-07-28T00:00:00.000Z",
};

/** Minimal, shape-check-satisfying fixture per schema — mirrors each result type's own "empty perModel" default, per each alignment module's own contract. */
const MINIMAL_RESULT: Record<PersistedAdaptiveSchemaId, Record<string, unknown>> = {
  ranked_enumeration: {
    items: [],
    lowConfidenceItems: [],
    requestedCount: null,
    actualCount: 0,
    rankCorrelation: null,
    hasLiveQueryLogData: false,
    totalModels: 2,
  },
  comparison_matrix: {
    subjects: [],
    lowConfidenceSubjects: [],
    attributes: [],
    lowConfidenceAttributes: [],
    cells: [],
    hasVerifiedSourceData: false,
    totalModels: 2,
  },
  definition_explanation: {
    primary: null,
    alternateInterpretations: [],
    isAmbiguous: false,
    sourceBacked: false,
    totalModels: 2,
  },
  causal_explanation: {
    directAnswer: "x",
    factors: [],
    causalChain: [],
    confounders: [],
    disputedInterpretations: [],
    unknowns: [],
    testsOrEvidenceNeeded: [],
    sourceBacked: false,
    totalModels: 2,
  },
  checklist_taxonomy: {
    summary: "",
    categories: [],
    lowConfidenceItems: [],
    notes: [],
    totalModels: 2,
  },
  deep_research: {
    executiveSummary: "x",
    findings: [],
    lowConfidenceFindings: [],
    disagreements: [],
    evidenceGaps: [],
    openQuestions: [],
    panelBlindSpots: [],
    researchBoundaries: [],
    recommendedNextSteps: [],
    sourceCoverage: { findingsWithSources: 0, totalFindings: 0, coverageRatio: 0 },
    totalModels: 2,
  },
  evidence_review: {
    overallAssessment: "x",
    overallStrength: "unknown",
    dimensions: [],
    lowConfidenceDimensions: [],
    redFlags: [],
    strengths: [],
    applicabilityCaveats: [],
    recommendedChecks: [],
    sourceBacked: false,
    totalModels: 2,
  },
  bias_blindspot_audit: {
    summary: "x",
    attributedBiases: [],
    biasEmptyReason: null,
    panelBlindSpots: [],
    sharedAssumptions: [],
    missingStakeholders: [],
    structuralDiagnostics: {
      citationCoverage: { modelsWithSources: 0, totalModels: 2, ratio: 0 },
      geographicBiasConcerns: [],
      sourceConcentrationConcerns: [],
      evidenceTypeConcerns: [],
      homogeneityFlag: false,
    },
    followUpQuestions: [],
    totalModels: 2,
  },
  decision_support: {
    decisionQuestion: "x",
    options: [],
    criteria: [],
    assessments: [],
    recommendation: { action: "escalate", rationale: "x", caveats: [], isContested: false, supportCount: 0, totalModelsWithRecommendation: 0 },
    assumptions: [],
    uncertainties: [],
    risks: [],
    sensitivityFindings: [],
    humanReviewNeeded: true,
    sourceBacked: false,
    totalModels: 2,
  },
};

function buildEnvelope(schemaId: PersistedAdaptiveSchemaId, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId,
    answerShape: SCHEMA_ANSWER_SHAPE[schemaId],
    classification: BASE_CLASSIFICATION,
    meta: BASE_META,
    generatedAt: BASE_META.generatedAt,
    result: MINIMAL_RESULT[schemaId],
    ...overrides,
  };
}

/** JSON round-trip — the exact transform Firestore-stored data undergoes (Timestamps aside, irrelevant to this envelope's own fields). */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const ALL_SCHEMA_IDS = Object.keys(SCHEMA_ANSWER_SHAPE) as PersistedAdaptiveSchemaId[];

describe("parsePersistedAdaptiveOutput — all 9 schemas serialize and deserialize", () => {
  it.each(ALL_SCHEMA_IDS)("%s: a well-formed envelope round-trips through JSON and parses as valid", (schemaId) => {
    const envelope = buildEnvelope(schemaId);
    const parsed = parsePersistedAdaptiveOutput(roundTrip(envelope));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.output.schemaId).toBe(schemaId);
      expect(parsed.output.answerShape).toBe(SCHEMA_ANSWER_SHAPE[schemaId]);
    }
  });

  it.each(ALL_SCHEMA_IDS)("%s: the discriminator selects the correct variant's result shape", (schemaId) => {
    const envelope = buildEnvelope(schemaId, { result: { ...MINIMAL_RESULT[schemaId], totalModels: 4 } });
    const parsed = parsePersistedAdaptiveOutput(roundTrip(envelope));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && "totalModels" in parsed.output.result) {
      expect((parsed.output.result as { totalModels: number }).totalModels).toBe(4);
    }
  });
});

describe("parsePersistedAdaptiveOutput — optional fields and source arrays survive round-trip", () => {
  it("preserves a populated sources array on a ranked_enumeration item", () => {
    const envelope = buildEnvelope("ranked_enumeration", {
      result: {
        ...MINIMAL_RESULT.ranked_enumeration,
        items: [{ id: "a", label: "A", panelRank: 1, coverageCount: 1, totalModels: 2, coverageRatio: 0.5, sourceRanks: {}, sources: ["Vendor site"] }],
      },
    });
    const parsed = parsePersistedAdaptiveOutput(roundTrip(envelope));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const result = parsed.output.result as { items: { sources?: string[] }[] };
      expect(result.items[0].sources).toEqual(["Vendor site"]);
    }
  });

  it("preserves an undefined optional field (reversibleNextStep) as genuinely absent, not fabricated", () => {
    const envelope = buildEnvelope("decision_support");
    // JSON.stringify drops keys with an undefined value entirely — proving
    // the parser doesn't require every optional field to be present.
    const parsed = parsePersistedAdaptiveOutput(roundTrip(envelope));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect("reversibleNextStep" in (parsed.output.result as object)).toBe(false);
    }
  });
});

describe("parsePersistedAdaptiveOutput — rejection cases", () => {
  it("rejects a mismatched schemaId/answerShape pair", () => {
    const envelope = buildEnvelope("decision_support", { answerShape: "ranked_list" });
    const parsed = parsePersistedAdaptiveOutput(envelope);
    expect(parsed).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a mismatched schemaId/result pair (result shaped like a different schema)", () => {
    const envelope = buildEnvelope("ranked_enumeration", { result: MINIMAL_RESULT.decision_support });
    const parsed = parsePersistedAdaptiveOutput(envelope);
    expect(parsed).toEqual({ ok: false, reason: "malformed" });
  });

  it("returns 'absent' for null or undefined — the expected, common case for pre-Phase-1 runs", () => {
    expect(parsePersistedAdaptiveOutput(null)).toEqual({ ok: false, reason: "absent" });
    expect(parsePersistedAdaptiveOutput(undefined)).toEqual({ ok: false, reason: "absent" });
  });

  it("returns 'unsupported_version' for a version other than 1, never throwing", () => {
    const envelope = buildEnvelope("decision_support", { version: 2 });
    expect(parsePersistedAdaptiveOutput(envelope)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it.each([
    ["a bare string", "not an object"],
    ["a number", 42],
    ["an array", []],
    ["an object with an unrecognized schemaId", buildEnvelope("decision_support", { schemaId: "not_a_real_schema" })],
    ["an object missing classification", (() => { const e = buildEnvelope("decision_support") as Record<string, unknown>; delete e.classification; return e; })()],
    ["an object missing meta", (() => { const e = buildEnvelope("decision_support") as Record<string, unknown>; delete e.meta; return e; })()],
    ["an object with a non-string generatedAt", buildEnvelope("decision_support", { generatedAt: 12345 })],
    ["an object whose result is missing required fields", buildEnvelope("decision_support", { result: { decisionQuestion: "x" } })],
  ])("returns 'malformed' (never throws) for %s", (_label, malformed) => {
    expect(() => parsePersistedAdaptiveOutput(malformed)).not.toThrow();
    const parsed = parsePersistedAdaptiveOutput(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });
});

/**
 * Phase 2 pilot history-reload fix — parsePersistedLegacyAdaptiveOutput()
 * tests. Same posture as the 9-schema suite above (round-trips through
 * JSON, fails safe on absent/malformed/unsupported-version input, never
 * throws) for the separate `procedural`-only envelope.
 */
const LEGACY_CLASSIFICATION = {
  queryType: "procedural",
  domain: "test",
  answerShape: "step_diff",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "learn_process",
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

const LEGACY_SYNTHESIS_REPORT = {
  unifiedAnswer: "Do the thing in order.",
  panelVerdict: "Panel converges.",
  gate: "pass",
  runCertainty: 0.8,
  whereModelsAgree: [],
  whereModelsDisagree: [],
  certaintyAssessment: "Run certainty 80% (gate: pass).",
  narrativeSections: [],
  executiveSummary: "Summary.",
  disagreements: [],
  biasAndBlindSpots: [],
  biasEmptyReason: "insufficient_models",
  panelCoverageGaps: [],
  diagnostics: {
    citedClaimCount: 0,
    totalClaimCount: 0,
    evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 },
    homogeneityFlag: false,
    meanAgreement: 0.8,
  },
  verdictCard: {
    question: "A question",
    topConsensus: "Step 1 agreed.",
    consensusModelCount: 2,
    keyDisagreement: null,
    disagreementDetail: null,
    disagreementModelCount: 0,
    caveat: null,
    recommendedNextSteps: [],
  },
  degraded: false,
};

const LEGACY_GATE = { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] };

function buildLegacyEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "procedural" as const,
    classification: LEGACY_CLASSIFICATION,
    generatedAt: "2026-08-06T00:00:00.000Z",
    results: [{ modelId: "chatgpt", schemaId: "procedural", ok: true, data: { goal: "x", prerequisites: [], steps: [], commonFailures: [] } }],
    alignedClaims: [],
    gate: LEGACY_GATE,
    synthesisReport: LEGACY_SYNTHESIS_REPORT,
    trustSummary: { perModel: [], overallTrust: 0.8 },
    ...overrides,
  };
}

describe("isPersistedLegacyAdaptiveSchemaId — Batch 3 persistence foundation (2C-1) type guard", () => {
  it.each(PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS.map((id) => [id]))("returns true for the supported schema '%s'", (id) => {
    expect(isPersistedLegacyAdaptiveSchemaId(id)).toBe(true);
  });

  it.each([
    ["a Milestone-2 schema (comparison_matrix)", "comparison_matrix"],
    ["generic", "generic"],
    ["graceful_limitation", "graceful_limitation"],
    ["an arbitrary unrecognized string", "not_a_real_schema"],
    ["a non-string value", 42],
    ["null", null],
    ["undefined", undefined],
  ])("returns false for %s — this allowlist is deliberately not 'every QueryType'", (_label, value) => {
    expect(isPersistedLegacyAdaptiveSchemaId(value)).toBe(false);
  });

  it("exposes exactly the 8 documented schema IDs — procedural plus the 7 remaining Batch 3 schemas, no more, no fewer", () => {
    expect([...PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS].sort()).toEqual(
      [
        "procedural",
        "contested_empirical",
        "legal_regulatory",
        "financial_valuation",
        "factual_lookup",
        "medical_health",
        "forecast_speculative",
        "creative_generative",
      ].sort()
    );
  });
});

describe("parsePersistedLegacyAdaptiveOutput — legacy-active schema family envelope (widened in Batch 3 persistence foundation, 2C-1)", () => {
  it("a well-formed procedural envelope round-trips through JSON and parses as valid", () => {
    const parsed = parsePersistedLegacyAdaptiveOutput(roundTrip(buildLegacyEnvelope()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.output.schemaId).toBe("procedural");
      expect(parsed.output.results).toHaveLength(1);
      expect(parsed.output.synthesisReport.unifiedAnswer).toBe("Do the thing in order.");
    }
  });

  it.each(
    PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS.filter((id) => id !== "procedural").map((id) => [id])
  )("a well-formed envelope for the Batch 3 schema '%s' round-trips through JSON and parses as valid, with schema identity surviving", (id) => {
    const parsed = parsePersistedLegacyAdaptiveOutput(roundTrip(buildLegacyEnvelope({ schemaId: id })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.output.schemaId).toBe(id);
      expect(parsed.output.alignedClaims).toEqual([]);
      expect(parsed.output.gate).toEqual(LEGACY_GATE);
      expect(parsed.output.synthesisReport.unifiedAnswer).toBe("Do the thing in order.");
      expect(parsed.output.trustSummary).toEqual({ perModel: [], overallTrust: 0.8 });
    }
  });

  it("trustSummary is optional — a well-formed envelope without it still parses as valid", () => {
    const envelope = buildLegacyEnvelope() as Record<string, unknown>;
    delete envelope.trustSummary;
    const parsed = parsePersistedLegacyAdaptiveOutput(roundTrip(envelope));
    expect(parsed.ok).toBe(true);
  });

  it("returns 'absent' for null or undefined — the expected, common case for every run made before this fix shipped (procedural before Phase 2, and every Batch 3 schema before 2C-1)", () => {
    expect(parsePersistedLegacyAdaptiveOutput(null)).toEqual({ ok: false, reason: "absent" });
    expect(parsePersistedLegacyAdaptiveOutput(undefined)).toEqual({ ok: false, reason: "absent" });
  });

  it("returns 'unsupported_version' for a version other than 1, never throwing", () => {
    expect(parsePersistedLegacyAdaptiveOutput(buildLegacyEnvelope({ version: 2 }))).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it.each([
    ["a Milestone-2 schema (comparison_matrix)", "comparison_matrix"],
    ["generic", "generic"],
    ["graceful_limitation", "graceful_limitation"],
    ["an arbitrary unrecognized string", "not_a_real_schema"],
  ])("rejects a schemaId outside the supported allowlist (%s) — this envelope is deliberately scoped to the 8-member legacy-active family, not every QueryType", (_label, schemaId) => {
    expect(parsePersistedLegacyAdaptiveOutput(buildLegacyEnvelope({ schemaId }))).toEqual({ ok: false, reason: "malformed" });
  });

  /**
   * gate/synthesisReport optionality is a STRUCTURAL invariant tied to
   * alignedClaims, never a schemaId special case — orchestrate.ts can only
   * ever produce "non-empty alignedClaims WITH gate/synthesisReport" or
   * "empty alignedClaims WITHOUT them," never a mix. A record claiming
   * non-empty alignedClaims but missing gate/synthesisReport cannot come
   * from the real orchestrator — accepting it would silently trust
   * corrupted or hand-edited data. These tests pin that this stays strict
   * for every schema, including the claims-matrix ones, and is not
   * accidentally weakened just because creative_generative needed the
   * fields to be optional in the type.
   */
  it.each(
    PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS.filter((id) => id !== "creative_generative").map((id) => [id])
  )(
    "rejects a '%s' record with non-empty alignedClaims but a missing gate — this combination the real orchestrator can never produce",
    (schemaId) => {
      const envelope = buildLegacyEnvelope({
        schemaId,
        alignedClaims: [{ id: "c1", claimText: "x", cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
      }) as Record<string, unknown>;
      delete envelope.gate;
      expect(parsePersistedLegacyAdaptiveOutput(envelope)).toEqual({ ok: false, reason: "malformed" });
    }
  );

  it("rejects a claims-matrix record (contested_empirical) with non-empty alignedClaims but a missing synthesisReport", () => {
    const envelope = buildLegacyEnvelope({
      schemaId: "contested_empirical",
      alignedClaims: [{ id: "c1", claimText: "x", cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
    }) as Record<string, unknown>;
    delete envelope.synthesisReport;
    expect(parsePersistedLegacyAdaptiveOutput(envelope)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects ANY schema (not just creative_generative) with non-empty alignedClaims but missing gate — proves the check keys on alignedClaims.length, never on schemaId", () => {
    const envelope = buildLegacyEnvelope({
      schemaId: "creative_generative",
      alignedClaims: [{ id: "c1", claimText: "x", cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
    }) as Record<string, unknown>;
    delete envelope.gate;
    delete envelope.synthesisReport;
    // Even creative_generative must be rejected here — this state (non-empty
    // claims, no gate) is impossible from the real pipeline for ANY schema,
    // so schemaId alone must never be what makes it pass.
    expect(parsePersistedLegacyAdaptiveOutput(envelope)).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts a creative_generative record with EMPTY alignedClaims and no gate/synthesisReport — the one genuinely valid absent-fields state", () => {
    const envelope = buildLegacyEnvelope({ schemaId: "creative_generative", alignedClaims: [] }) as Record<string, unknown>;
    delete envelope.gate;
    delete envelope.synthesisReport;
    delete envelope.trustSummary;
    const parsed = parsePersistedLegacyAdaptiveOutput(envelope);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.output.gate).toBeUndefined();
      expect(parsed.output.synthesisReport).toBeUndefined();
    }
  });

  it("rejects an empty-alignedClaims record whose gate IS present but malformed — 'absent' is valid, 'present but broken' never is", () => {
    const envelope = buildLegacyEnvelope({ schemaId: "creative_generative", alignedClaims: [], gate: { runCertainty: 0.8 } });
    expect(parsePersistedLegacyAdaptiveOutput(envelope)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["a bare string", "not an object"],
    ["a number", 42],
    ["an array", []],
    ["an object missing classification", (() => { const e = buildLegacyEnvelope() as Record<string, unknown>; delete e.classification; return e; })()],
    ["an object with a non-string generatedAt", buildLegacyEnvelope({ generatedAt: 12345 })],
    ["an object whose results is not an array", buildLegacyEnvelope({ results: "not-an-array" })],
    ["an object whose alignedClaims is not an array", buildLegacyEnvelope({ alignedClaims: "not-an-array" })],
    ["an object whose gate is missing status", buildLegacyEnvelope({ gate: { runCertainty: 0.8 } })],
    ["an object whose synthesisReport is missing unifiedAnswer", buildLegacyEnvelope({ synthesisReport: { panelVerdict: "x" } })],
  ])("returns 'malformed' (never throws) for %s — this is the exact 'incomplete or malformed persisted data fails safely' guarantee the history-reload fix depends on", (_label, malformed) => {
    expect(() => parsePersistedLegacyAdaptiveOutput(malformed)).not.toThrow();
    const parsed = parsePersistedLegacyAdaptiveOutput(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });
});
