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

import { parsePersistedAdaptiveOutput, PersistedAdaptiveSchemaId, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";

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
