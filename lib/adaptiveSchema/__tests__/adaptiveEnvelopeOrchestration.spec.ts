/**
 * Query-Routing Redesign, Phase 1 — proves finalizeAdaptiveRun() attaches
 * commonResponseMeta/persistedOutput correctly: present when classification
 * is supplied, absent (not a crash) when it isn't (backward compatible with
 * existing callers/tests that omit it), and never attached for the 10
 * legacy-active schemas, which keep their existing persistence path
 * unchanged. Also proves non-execution outcomes never build or persist an
 * envelope at all.
 */

import { finalizeAdaptiveRun, buildNonExecutionPayload } from "@/lib/adaptiveSchema/orchestrate";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { QueryClassification } from "@/lib/adaptiveSchema/types";
import { ModelResult } from "@/lib/types";

function classification(overrides: Partial<QueryClassification> = {}): QueryClassification {
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
    ...overrides,
  };
}

function modelResult(modelId: string, overrides: Record<string, unknown> = {}): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: JSON.stringify({
      decisionQuestion: "Which CRM should we choose?",
      options: ["HubSpot"],
      criteria: [],
      userProvidedCriteria: [],
      assessments: [],
      recommendationAction: "go",
      recommendedOption: "none",
      recommendationRationale: "x",
      recommendationCaveats: [],
      assumptions: [],
      uncertainties: [],
      risks: [],
      sensitivityFindings: [],
      reversibleNextStep: "none",
      sources: [],
      ...overrides,
    }),
    latencyMs: 5,
  };
}

describe("finalizeAdaptiveRun — CommonResponseMeta / PersistedAdaptiveOutputV1 attachment", () => {
  it("attaches commonResponseMeta and persistedOutput when classification is supplied", async () => {
    const results = [modelResult("chatgpt"), modelResult("claude")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "q", undefined, classification());

    expect(output.commonResponseMeta).toBeDefined();
    expect(output.commonResponseMeta!.totalModels).toBe(2);
    expect(output.persistedOutput).toBeDefined();
    expect(output.persistedOutput!.schemaId).toBe("decision_support");
    expect(output.persistedOutput!.version).toBe(1);
    expect(output.persistedOutput!.result).toBe(output.decisionSupport);
  });

  it("omits commonResponseMeta/persistedOutput (never crashes) when classification is not supplied — matches every pre-Phase-1 test call site", async () => {
    const results = [modelResult("chatgpt")];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "q");

    expect(output.decisionSupport).toBeDefined();
    expect(output.commonResponseMeta).toBeUndefined();
    expect(output.persistedOutput).toBeUndefined();
  });

  it("never attaches an envelope for a legacy-active schema (factual_lookup) — that persistence path is unchanged by this phase", async () => {
    const results: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: JSON.stringify({ answer: "Nairobi", source: "general knowledge", caveat: "none" }), latencyMs: 5 },
    ];
    const output = await finalizeAdaptiveRun(SCHEMA_REGISTRY.factual_lookup, results, "What is the capital of Kenya?", undefined, classification({ queryType: "factual_lookup" }));

    expect(output.commonResponseMeta).toBeUndefined();
    expect(output.persistedOutput).toBeUndefined();
  });
});

describe("Non-execution outcomes never build or imply a persisted adaptive envelope", () => {
  it("buildNonExecutionPayload's adaptive payload carries no adaptiveOutput/persistenceStatus field", () => {
    const routing = routeClassifiedQuery(
      classification({ queryType: "document_qa" })
    );
    expect(routing.kind).toBe("disabled");
    const payload = buildNonExecutionPayload(classification({ queryType: "document_qa" }), routing);

    expect(payload.adaptive.executionStatus).toBe("not_started");
    expect(payload.adaptive.modelsInvoked).toBe(0);
    expect(payload.adaptive.tokensUsed).toBe(0);
    expect("adaptiveOutput" in payload.adaptive).toBe(false);
    expect("persistenceStatus" in payload.adaptive).toBe(false);
    expect(payload.results).toEqual([]);
  });

  it("a handoff outcome (claim_verification) also carries no adaptiveOutput", () => {
    const routing = routeClassifiedQuery(classification({ queryType: "claim_verification" }));
    expect(routing.kind).toBe("handoff");
    const payload = buildNonExecutionPayload(classification({ queryType: "claim_verification" }), routing);
    expect("adaptiveOutput" in payload.adaptive).toBe(false);
    expect(payload.adaptive.modelsInvoked).toBe(0);
  });
});
