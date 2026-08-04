/**
 * Query-Routing Redesign, Milestone 1 — capability gating.
 *
 * document_qa / document_comparison / data_analysis / current_live_information
 * are disabled due to a missing capability (confirmed by a live infra audit,
 * not guessed) — each must route to graceful_limitation with a reason
 * specific to ITS gap, not a generic "not available" message shared across
 * all four.
 */

import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";

function baseClassification(queryType: QueryType): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: "limitation_notice",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "none",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
  };
}

describe("Capability-gap disabled schemas", () => {
  const CAPABILITY_GAP_TYPES: QueryType[] = ["document_qa", "document_comparison", "data_analysis", "current_live_information"];

  it.each(CAPABILITY_GAP_TYPES)("%s is registered with implementationStatus 'disabled'", (queryType) => {
    expect(SCHEMA_REGISTRY[queryType].implementationStatus).toBe("disabled");
  });

  it("document_qa's reason cites missing page/section reference preservation", () => {
    expect(SCHEMA_REGISTRY.document_qa.capabilityReason).toMatch(/page.*section|section.*page/i);
  });

  it("document_comparison's reason cites missing multi-document alignment", () => {
    expect(SCHEMA_REGISTRY.document_comparison.capabilityReason).toMatch(/align/i);
  });

  it("data_analysis's reason cites missing dataset upload / sandboxed computation", () => {
    expect(SCHEMA_REGISTRY.data_analysis.capabilityReason).toMatch(/dataset|sandbox|computation/i);
  });

  it("current_live_information's reason cites missing verified live data / source timestamps", () => {
    expect(SCHEMA_REGISTRY.current_live_information.capabilityReason).toMatch(/live data|timestamp/i);
  });

  it("all four reasons are distinct from each other", () => {
    const reasons = CAPABILITY_GAP_TYPES.map((t) => SCHEMA_REGISTRY[t].capabilityReason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it.each(CAPABILITY_GAP_TYPES)("%s routes to kind 'disabled' with its own copy, never 'active' — invokes zero models", (queryType) => {
    const routed = routeClassifiedQuery(baseClassification(queryType));
    expect(routed.kind).toBe("disabled");
    if (routed.kind !== "disabled") throw new Error("unreachable");
    expect(routed.response.kind).toBe("capability_gap");
    expect(routed.response.limitation).toBe(SCHEMA_REGISTRY[queryType].capabilityReason);
  });
});

describe("Not-yet-implemented disabled schemas", () => {
  // ranked_enumeration, comparison_matrix, definition_explanation,
  // causal_explanation, checklist_taxonomy, deep_research,
  // evidence_review, bias_blindspot_audit, and decision_support were
  // activated in Milestone 2 — see enumAlignment.spec.ts/RankedListView.spec.tsx,
  // comparisonAlignment.spec.ts/ComparisonMatrixView.spec.tsx,
  // definitionAlignment.spec.ts/DefinitionExplanationView.spec.tsx,
  // causalAlignment.spec.ts/CausalExplanationView.spec.tsx,
  // checklistAlignment.spec.ts/ChecklistTaxonomyView.spec.tsx,
  // deepResearchAlignment.spec.ts/DeepResearchView.spec.tsx,
  // evidenceReviewAlignment.spec.ts/EvidenceReviewView.spec.tsx,
  // biasBlindspotAlignment.spec.ts/BiasBlindspotAuditView.spec.tsx, and
  // decisionSupportAlignment.spec.ts/DecisionSupportView.spec.tsx for
  // their own coverage.
  const NOT_YET_IMPLEMENTED_TYPES: QueryType[] = [
    "scenario_analysis",
    "step_by_step_plan",
    "transformation",
  ];

  it.each(NOT_YET_IMPLEMENTED_TYPES)("%s is registered with implementationStatus 'disabled' and routes to kind 'disabled'", (queryType) => {
    expect(SCHEMA_REGISTRY[queryType].implementationStatus).toBe("disabled");
    const routed = routeClassifiedQuery(baseClassification(queryType));
    expect(routed.kind).toBe("disabled");
    if (routed.kind !== "disabled") throw new Error("unreachable");
    expect(routed.response.kind).toBe("capability_gap");
  });
});
