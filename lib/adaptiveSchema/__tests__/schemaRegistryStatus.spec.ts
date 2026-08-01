/**
 * Query-Routing Redesign, Milestone 1 (registry composition) / Milestone 1.5
 * (routing guarantee) — updated for the RoutedQuery discriminated union.
 *
 * No disabled or handoff schema may ever resolve to `kind: "active"`. This
 * is the single most important regression test in the whole redesign:
 * reproducing the old "wrong answer shape" bug for an unfinished schema is
 * exactly what this guarantee exists to prevent, and (as of Milestone 1.5)
 * it's also the guarantee that keeps the server from ever calling
 * runPanel() for a non-executable request.
 */

import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";

function baseClassification(queryType: QueryType, overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: "generic_sections",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
    ...overrides,
  };
}

const ALL_QUERY_TYPES = Object.keys(SCHEMA_REGISTRY) as QueryType[];
const ACTIVE_TYPES = ALL_QUERY_TYPES.filter((id) => SCHEMA_REGISTRY[id].implementationStatus === "active");
const DISABLED_TYPES = ALL_QUERY_TYPES.filter((id) => SCHEMA_REGISTRY[id].implementationStatus === "disabled");
const HANDOFF_TYPES = ALL_QUERY_TYPES.filter((id) => SCHEMA_REGISTRY[id].implementationStatus === "handoff");
// graceful_limitation is registered "active" but never runs the panel — see routeClassifiedQuery.ts.
const REAL_PANEL_ACTIVE_TYPES = ACTIVE_TYPES.filter((id) => id !== "graceful_limitation");

describe("Registry composition matches the approved Milestone 1 + Milestone 2 allocation", () => {
  it("has exactly 19 active, 2 handoff, and 7 disabled entries (28 total)", () => {
    expect(ALL_QUERY_TYPES).toHaveLength(28);
    expect(ACTIVE_TYPES.sort()).toEqual(
      [
        "contested_empirical",
        "legal_regulatory",
        "financial_valuation",
        "factual_lookup",
        "procedural",
        "medical_health",
        "forecast_speculative",
        "creative_generative",
        "generic",
        "graceful_limitation",
        "ranked_enumeration",
        "comparison_matrix",
        "definition_explanation",
        "causal_explanation",
        "checklist_taxonomy",
        "deep_research",
        "evidence_review",
        "bias_blindspot_audit",
        "decision_support",
      ].sort()
    );
    expect(HANDOFF_TYPES.sort()).toEqual(["claim_verification", "media_authenticity_review"].sort());
    expect(DISABLED_TYPES).toHaveLength(7);
  });

  it("decision_support (Milestone 2) is active and renders through decision_support_view, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.decision_support.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.decision_support.renderHint).toBe("decision_support_view");
    expect(SCHEMA_REGISTRY.decision_support.fields.map((f) => f.key)).toEqual([
      "decisionQuestion",
      "options",
      "criteria",
      "userProvidedCriteria",
      "assessments",
      "recommendationAction",
      "recommendedOption",
      "recommendationRationale",
      "recommendationCaveats",
      "assumptions",
      "uncertainties",
      "risks",
      "sensitivityFindings",
      "reversibleNextStep",
      "sources",
    ]);
  });

  it("ranked_enumeration (Milestone 2) is active and renders through ranked_list, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.ranked_enumeration.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.ranked_enumeration.renderHint).toBe("ranked_list");
    expect(SCHEMA_REGISTRY.ranked_enumeration.fields.map((f) => f.key)).toEqual(["items"]);
  });

  it("comparison_matrix (Milestone 2) is active and renders through comparison_grid, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.comparison_matrix.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.comparison_matrix.renderHint).toBe("comparison_grid");
    expect(SCHEMA_REGISTRY.comparison_matrix.fields.map((f) => f.key)).toEqual(["cells"]);
  });

  it("definition_explanation (Milestone 2) is active and renders through definition_card, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.definition_explanation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.definition_explanation.renderHint).toBe("definition_card");
    expect(SCHEMA_REGISTRY.definition_explanation.fields.map((f) => f.key)).toEqual([
      "term",
      "directAnswer",
      "explanation",
      "keyPoints",
      "example",
      "analogyText",
      "analogyLimits",
      "distinctions",
      "processSteps",
      "advancedDetail",
      "commonMisconceptions",
      "relatedConcepts",
      "sources",
    ]);
  });

  it("causal_explanation (Milestone 2) is active and renders through causal_map, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.causal_explanation.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.causal_explanation.renderHint).toBe("causal_map");
    expect(SCHEMA_REGISTRY.causal_explanation.fields.map((f) => f.key)).toEqual([
      "directAnswer",
      "directCauses",
      "contributingFactors",
      "triggers",
      "amplifiers",
      "alternativeExplanations",
      "causalLinks",
      "confounders",
      "disputedInterpretations",
      "unknowns",
      "testsOrEvidenceNeeded",
      "sources",
    ]);
  });

  it("bias_blindspot_audit (Milestone 2) is active and renders through bias_blindspot_audit_view, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.bias_blindspot_audit.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.bias_blindspot_audit.renderHint).toBe("bias_blindspot_audit_view");
    expect(SCHEMA_REGISTRY.bias_blindspot_audit.fields.map((f) => f.key)).toEqual([
      "summary",
      "omittedDimensions",
      "sharedAssumptions",
      "missingStakeholders",
      "geographicBiases",
      "sourceConcentrationConcerns",
      "evidenceTypeConcerns",
      "followUpQuestions",
      "sources",
    ]);
  });

  it("evidence_review (Milestone 2) is active and renders through evidence_review_view, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.evidence_review.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.evidence_review.renderHint).toBe("evidence_review_view");
    expect(SCHEMA_REGISTRY.evidence_review.fields.map((f) => f.key)).toEqual([
      "overallAssessment",
      "dimensions",
      "redFlags",
      "strengths",
      "applicabilityCaveats",
      "recommendedChecks",
      "sources",
    ]);
  });

  it("checklist_taxonomy (Milestone 2) is active and renders through checklist_taxonomy_view, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.checklist_taxonomy.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.checklist_taxonomy.renderHint).toBe("checklist_taxonomy_view");
    expect(SCHEMA_REGISTRY.checklist_taxonomy.fields.map((f) => f.key)).toEqual(["summary", "items", "notes"]);
  });

  it("deep_research (Milestone 2) is active and renders through deep_research_view, not the generic claims shell", () => {
    expect(SCHEMA_REGISTRY.deep_research.implementationStatus).toBe("active");
    expect(SCHEMA_REGISTRY.deep_research.renderHint).toBe("deep_research_view");
    expect(SCHEMA_REGISTRY.deep_research.fields.map((f) => f.key)).toEqual([
      "executiveSummary",
      "findings",
      "disagreements",
      "evidenceGaps",
      "openQuestions",
      "researchBoundaries",
      "recommendedNextSteps",
      "sources",
    ]);
  });

  it("every disabled entry declares a non-empty capabilityReason", () => {
    for (const id of DISABLED_TYPES) {
      expect(SCHEMA_REGISTRY[id].capabilityReason).toBeTruthy();
    }
  });

  it("every handoff entry declares a valid handoffTarget", () => {
    for (const id of HANDOFF_TYPES) {
      expect(["claim_verification", "video_verification"]).toContain(SCHEMA_REGISTRY[id].handoffTarget);
    }
  });

  it("every entry declares a fallbackQueryType", () => {
    for (const id of ALL_QUERY_TYPES) {
      expect(SCHEMA_REGISTRY[id].fallbackQueryType).toBeTruthy();
    }
  });
});

describe("routeClassifiedQuery — the routing guarantee", () => {
  it.each(REAL_PANEL_ACTIVE_TYPES)("routes active schema %s to kind 'active', ready for panel execution", (queryType) => {
    const routed = routeClassifiedQuery(baseClassification(queryType));
    expect(routed.kind).toBe("active");
    if (routed.kind === "active") {
      expect(routed.queryType).toBe(queryType);
      expect(routed.schema.id).toBe(queryType);
    }
  });

  it("routes graceful_limitation (no clarification) to kind 'unanswerable', never 'active'", () => {
    const routed = routeClassifiedQuery(baseClassification("graceful_limitation", { requiresClarification: false }));
    expect(routed.kind).toBe("unanswerable");
  });

  it("routes graceful_limitation (with clarification) to kind 'clarification', never 'active'", () => {
    const routed = routeClassifiedQuery(
      baseClassification("graceful_limitation", { requiresClarification: true, clarificationQuestion: "Which jurisdiction?" })
    );
    expect(routed.kind).toBe("clarification");
    if (routed.kind === "clarification") expect(routed.question).toBe("Which jurisdiction?");
  });

  it.each(DISABLED_TYPES)("routes disabled schema %s to kind 'disabled' with its own capabilityReason, never a real renderer", (queryType) => {
    const routed = routeClassifiedQuery(baseClassification(queryType));
    expect(routed.kind).toBe("disabled");
    if (routed.kind === "disabled") {
      expect(routed.queryType).toBe(queryType);
      expect(routed.capabilityReason).toBe(SCHEMA_REGISTRY[queryType].capabilityReason);
      expect(routed.response.kind).toBe("capability_gap");
      expect(routed.response.limitation).toBe(SCHEMA_REGISTRY[queryType].capabilityReason);
    }
  });

  it.each(DISABLED_TYPES)("disabled schema %s stays disabled even when requiresClarification is set — a capability gap isn't fixed by clarifying", (queryType) => {
    const routed = routeClassifiedQuery(
      baseClassification(queryType, { requiresClarification: true, clarificationQuestion: "would this help?" })
    );
    expect(routed.kind).toBe("disabled");
  });

  it.each(HANDOFF_TYPES)("routes handoff schema %s to kind 'handoff' with handoff copy, never a real renderer", (queryType) => {
    const routed = routeClassifiedQuery(baseClassification(queryType));
    expect(routed.kind).toBe("handoff");
    if (routed.kind === "handoff") {
      expect(routed.queryType).toBe(queryType);
      expect(routed.handoffTarget).toBe(SCHEMA_REGISTRY[queryType].handoffTarget);
      expect(routed.response.kind).toBe("handoff");
      expect(routed.response.handoffTarget).toBe(SCHEMA_REGISTRY[queryType].handoffTarget);
    }
  });

  it("routes an unrecognized queryType to kind 'invalid', never throws", () => {
    const classification = baseClassification("factual_lookup");
    (classification as any).queryType = "not_a_real_type";
    const routed = routeClassifiedQuery(classification);
    expect(routed.kind).toBe("invalid");
    if (routed.kind === "invalid") expect(routed.response.kind).toBe("unrecognized_or_invalid");
  });

  it("routes a registry entry with a malformed implementationStatus to kind 'invalid', never throws", () => {
    const original = SCHEMA_REGISTRY.procedural.implementationStatus;
    (SCHEMA_REGISTRY.procedural as any).implementationStatus = "not_a_real_status";
    try {
      const routed = routeClassifiedQuery(baseClassification("procedural"));
      expect(routed.kind).toBe("invalid");
    } finally {
      (SCHEMA_REGISTRY.procedural as any).implementationStatus = original;
    }
  });

  it("no disabled/handoff/graceful_limitation classification ever produces kind 'active'", () => {
    for (const queryType of [...DISABLED_TYPES, ...HANDOFF_TYPES, "graceful_limitation" as QueryType]) {
      const routed = routeClassifiedQuery(baseClassification(queryType));
      expect(routed.kind).not.toBe("active");
    }
  });
});
