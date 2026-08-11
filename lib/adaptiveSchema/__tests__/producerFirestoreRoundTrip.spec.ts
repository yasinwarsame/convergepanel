/**
 * Firestore round-trip proof for the 6 Milestone-2 producers fixed under
 * the JSON-determinism producer canonicalization effort (comparison_matrix,
 * ranked_enumeration, checklist_taxonomy, bias_blindspot_audit,
 * decision_support, definition_explanation).
 *
 * Each producer already has its own `hasOwnProperty`-based absent-vs-
 * explicit-undefined tests (see the sibling *Alignment.spec.ts files). This
 * file proves the missing half of that guarantee: that a producer's output,
 * once it flows through `sanitizeForFirestore()` (the exact function every
 * Firestore write in this codebase goes through — see
 * lib/firestore/adaptiveExports.ts and lib/firestore/runs.ts), does not
 * gain a spurious `null`-valued key for a field that was never actually
 * present. `sanitizeForFirestore` iterates `Object.entries(obj)`, which only
 * yields OWN properties that exist — so a genuinely absent key is never
 * visited and never becomes `null`; only an explicit-undefined-valued own
 * property would be (incorrectly) converted. This is the concrete
 * mechanism, not an assumption — this test proves it against real producer
 * output, not a hand-built fixture.
 */

import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { buildComparisonMatrixResult } from "@/lib/adaptiveSchema/comparisonAlignment";
import { buildRankedEnumerationResult } from "@/lib/adaptiveSchema/enumAlignment";
import { buildChecklistTaxonomyResult } from "@/lib/adaptiveSchema/checklistAlignment";
import { buildDecisionSupportResult, DecisionSupportFields } from "@/lib/adaptiveSchema/decisionSupportAlignment";
import { buildDefinitionExplanationResult, DefinitionExplanationFields } from "@/lib/adaptiveSchema/definitionAlignment";
import { ModelId } from "@/lib/types";

/** Deep-diffs two values, asserting they are structurally identical after JSON round-trip (mirrors what an actual Firestore read/write cycle preserves). */
function assertNoNewKeys(before: unknown, after: unknown) {
  expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
}

describe("Producer output -> sanitizeForFirestore round-trip — no spurious null keys", () => {
  it("comparison_matrix: absent-field cells survive sanitizeForFirestore with no new keys", () => {
    const result = buildComparisonMatrixResult([
      {
        modelId: "chatgpt" as ModelId,
        cells: [{ subject: "X", attribute: "Verdict", value: "Best overall choice" }],
      },
      {
        modelId: "claude" as ModelId,
        cells: [{ subject: "X", attribute: "Verdict", value: "Not recommended at all" }],
      },
    ]);
    const cell = result.cells[0];
    expect(Object.prototype.hasOwnProperty.call(cell, "consensusValue")).toBe(false);

    const sanitized = sanitizeForFirestore(result) as typeof result;
    const sanitizedCell = sanitized.cells[0];
    expect(Object.prototype.hasOwnProperty.call(sanitizedCell, "consensusValue")).toBe(false);
    assertNoNewKeys(result, sanitized);
  });

  it("ranked_enumeration: absent-field items survive sanitizeForFirestore with no new keys", () => {
    const result = buildRankedEnumerationResult(
      [{ modelId: "chatgpt" as ModelId, items: [{ id: "x", label: "X", rank: 1 }] }],
      null
    );
    const item = result.items[0];
    expect(Object.prototype.hasOwnProperty.call(item, "category")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "shortfallNote")).toBe(false);

    const sanitized = sanitizeForFirestore(result) as typeof result;
    expect(Object.prototype.hasOwnProperty.call(sanitized.items[0], "category")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sanitized, "shortfallNote")).toBe(false);
    assertNoNewKeys(result, sanitized);
  });

  it("checklist_taxonomy: absent-field items survive sanitizeForFirestore with no new keys", () => {
    const result = buildChecklistTaxonomyResult([
      { modelId: "chatgpt" as ModelId, fields: { summary: "", items: [{ id: "dpa", label: "Sign a data processing agreement" }], notes: [] } },
    ]);
    const item = result.categories.flatMap((c) => c.items)[0];
    expect(Object.prototype.hasOwnProperty.call(item, "severity")).toBe(false);

    const sanitized = sanitizeForFirestore(result) as typeof result;
    const sanitizedItem = sanitized.categories.flatMap((c) => c.items)[0];
    expect(Object.prototype.hasOwnProperty.call(sanitizedItem, "severity")).toBe(false);
    assertNoNewKeys(result, sanitized);
  });

  it("bias_blindspot_audit: absent structural-diagnostics fields survive sanitizeForFirestore with no new keys", async () => {
    jest.doMock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn().mockResolvedValue({ modelId: "gemini", status: "ok", rawText: "{}", latencyMs: 5 }) }));
    const { buildBiasBlindspotAuditResult } = await import("@/lib/adaptiveSchema/biasBlindspotAlignment");
    const results = [{ modelId: "chatgpt" as ModelId, status: "ok" as const, rawText: "x", latencyMs: 5 }];
    const result = await buildBiasBlindspotAuditResult(
      [{ modelId: "chatgpt" as ModelId, fields: { summary: "", omittedDimensions: [], sharedAssumptions: [], missingStakeholders: [], geographicBiases: [], sourceConcentrationConcerns: [], evidenceTypeConcerns: [], followUpQuestions: [], sources: [] } }],
      1,
      "q",
      results
    );
    expect(Object.prototype.hasOwnProperty.call(result.structuralDiagnostics, "sourceConcentration")).toBe(false);

    const sanitized = sanitizeForFirestore(result) as typeof result;
    expect(Object.prototype.hasOwnProperty.call(sanitized.structuralDiagnostics, "sourceConcentration")).toBe(false);
    assertNoNewKeys(result, sanitized);
    jest.dontMock("@/lib/connectors/gemini");
  });

  it("decision_support: absent recommendation/risk fields survive sanitizeForFirestore with no new keys", () => {
    const fields = (overrides: Partial<DecisionSupportFields> = {}): DecisionSupportFields => ({
      decisionQuestion: "", options: [], criteria: [], userProvidedCriteria: [], assessments: [],
      recommendationAction: "", recommendedOption: "none", recommendationRationale: "", recommendationCaveats: [],
      assumptions: [], uncertainties: [], risks: [], sensitivityFindings: [], reversibleNextStep: "", sources: [],
      ...overrides,
    });
    const result = buildDecisionSupportResult([
      { modelId: "chatgpt" as ModelId, fields: fields({ risks: [{ id: "r", label: "Vendor lock-in" }] }) },
    ]);
    expect(Object.prototype.hasOwnProperty.call(result, "reversibleNextStep")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.risks[0], "likelihood")).toBe(false);

    const sanitized = sanitizeForFirestore(result) as typeof result;
    expect(Object.prototype.hasOwnProperty.call(sanitized, "reversibleNextStep")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sanitized.risks[0], "likelihood")).toBe(false);
    assertNoNewKeys(result, sanitized);
  });

  it("definition_explanation: absent example/analogy/advancedDetail survive sanitizeForFirestore with no new keys", () => {
    const fields = (overrides: Partial<DefinitionExplanationFields> = {}): DefinitionExplanationFields => ({
      term: "none", directAnswer: "", explanation: "", keyPoints: [], example: "none", analogyText: "none",
      analogyLimits: "none", distinctions: [], processSteps: [], advancedDetail: "none", commonMisconceptions: [],
      relatedConcepts: [], sources: [],
      ...overrides,
    });
    const result = buildDefinitionExplanationResult(
      [{ modelId: "chatgpt" as ModelId, fields: fields({ directAnswer: "X is Y." }) }],
      1
    );
    const primary = result.primary!;
    expect(Object.prototype.hasOwnProperty.call(primary, "example")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(primary, "analogy")).toBe(false);

    const sanitized = sanitizeForFirestore(result) as typeof result;
    const sanitizedPrimary = sanitized.primary!;
    expect(Object.prototype.hasOwnProperty.call(sanitizedPrimary, "example")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sanitizedPrimary, "analogy")).toBe(false);
    assertNoNewKeys(result, sanitized);
  });
});
