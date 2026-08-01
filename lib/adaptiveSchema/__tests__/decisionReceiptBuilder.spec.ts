/**
 * Query-Routing Redesign, Phase 2A, Step 3 —
 * buildAdaptiveDecisionReceipt() tests.
 *
 * Covers the shared contract (determinism, no mutation, zero model/
 * classifier/network calls, discriminator correctness, source/human-review/
 * limitation preservation, dedup, safe failure on impossible input) plus
 * schema-specific preservation for all 9 active Milestone 2 schemas.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

jest.mock("@/lib/adaptiveSchema/classifier", () => ({
  classifyQuery: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { buildAdaptiveDecisionReceipt, DecisionReceiptBuildError } from "@/lib/adaptiveSchema/decisionReceiptBuilder";
import { PersistedAdaptiveOutputV1, PersistedAdaptiveSchemaId, SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";
import {
  BiasBlindspotAuditResult,
  CausalExplanationResult,
  ChecklistTaxonomyResult,
  CommonResponseMeta,
  ComparisonMatrixResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EvidenceReviewResult,
  QueryClassification,
  RankedEnumerationResult,
} from "@/lib/adaptiveSchema/types";

const mockedClassifyQuery = classifyQuery as jest.MockedFunction<typeof classifyQuery>;

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

function meta(overrides: Partial<CommonResponseMeta> = {}): CommonResponseMeta {
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
    schemaId: "decision_support",
    routingKind: "active",
    totalModels: 2,
    successfulModels: 2,
    failedModels: 0,
    modelsWithUsableOutput: 2,
    sourceBacked: false,
    limitations: [],
    executionStatus: "completed",
    ...overrides,
  };
}

function envelope<S extends PersistedAdaptiveSchemaId>(
  schemaId: S,
  result: unknown,
  metaOverrides: Partial<CommonResponseMeta> = {}
): PersistedAdaptiveOutputV1 {
  return {
    version: 1,
    schemaId,
    answerShape: SCHEMA_ANSWER_SHAPE[schemaId],
    classification: classification({ queryType: schemaId }),
    meta: meta({ schemaId, queryType: schemaId, answerShape: SCHEMA_ANSWER_SHAPE[schemaId], ...metaOverrides }),
    result,
    generatedAt: "2026-07-29T00:00:00.000Z",
  } as unknown as PersistedAdaptiveOutputV1;
}

// ─── Fixtures ───────────────────────────────────────────────────────────

const rankedEnumerationResult: RankedEnumerationResult = {
  items: [
    { id: "a", label: "ChatGPT", panelRank: 1, coverageCount: 4, totalModels: 4, coverageRatio: 1, sourceRanks: {}, sources: ["Vendor site"] },
    { id: "b", label: "Claude", panelRank: 2, coverageCount: 3, totalModels: 4, coverageRatio: 0.75, sourceRanks: {} },
  ],
  lowConfidenceItems: [{ id: "c", label: "Grok", panelRank: 5, coverageCount: 1, totalModels: 4, coverageRatio: 0.25, sourceRanks: {} }],
  requestedCount: 3,
  actualCount: 3,
  rankCorrelation: 0.8,
  hasLiveQueryLogData: false,
  totalModels: 4,
};

const comparisonMatrixResult: ComparisonMatrixResult = {
  subjects: [{ id: "iphone-15", label: "iPhone 15", coverageCount: 2, totalModels: 2, coverageRatio: 1 }],
  lowConfidenceSubjects: [],
  attributes: [{ id: "price", label: "Price", coverageCount: 2, totalModels: 2, coverageRatio: 1 }],
  lowConfidenceAttributes: [],
  cells: [
    {
      subjectId: "iphone-15",
      subject: "iPhone 15",
      attributeId: "price",
      attribute: "Price",
      valuesByModel: {} as any,
      coverageCount: 2,
      totalModels: 2,
      coverageRatio: 1,
      agreement: "consensus",
      consensusValue: "$799",
      sources: ["Apple.com"],
    },
  ],
  hasVerifiedSourceData: false,
  totalModels: 2,
};

const definitionExplanationResult: DefinitionExplanationResult = {
  primary: {
    coverageCount: 2,
    totalModels: 2,
    coverageRatio: 1,
    contributingModels: [],
    term: "CAGR",
    directAnswer: "CAGR is the compound annual growth rate.",
    explanation: "It smooths growth over multiple years into one annualized rate.",
    keyPoints: ["Assumes steady compounding"],
    distinctions: [],
    processSteps: [],
    commonMisconceptions: [],
    relatedConcepts: [],
    sources: ["Investopedia"],
  },
  alternateInterpretations: [],
  isAmbiguous: false,
  sourceBacked: true,
  totalModels: 2,
};

const causalExplanationResult: CausalExplanationResult = {
  directAnswer: "Inflation rises mainly due to excess demand relative to supply.",
  factors: [
    { id: "demand", label: "Rising demand", category: "direct_cause", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [], evidenceStrength: "unknown", sourceBacked: false },
    { id: "supply", label: "Supply chain disruption", category: "contributing_factor", coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: [], evidenceStrength: "unknown", sourceBacked: false },
    { id: "monetary", label: "Monetary expansion", category: "alternative_explanation", coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: [], evidenceStrength: "contested", sourceBacked: false },
  ],
  causalChain: [],
  confounders: ["Seasonal demand spikes"],
  disputedInterpretations: [{ label: "Whether monetary policy is the primary driver", supportingModels: [] }],
  unknowns: ["Long-run elasticity of supply"],
  testsOrEvidenceNeeded: ["A controlled natural experiment"],
  sourceBacked: false,
  totalModels: 2,
};

const checklistTaxonomyResult: ChecklistTaxonomyResult = {
  summary: "A SaaS launch checklist.",
  categories: [
    {
      category: "Legal",
      items: [
        { id: "tos", label: "Publish terms of service", category: "Legal", critical: true, coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] },
      ],
    },
  ],
  lowConfidenceItems: [
    { id: "trademark", label: "File trademark", category: "Legal", critical: false, coverageCount: 1, totalModels: 4, coverageRatio: 0.25, contributingModels: [] },
  ],
  notes: ["This list is not exhaustive."],
  totalModels: 4,
};

const deepResearchResult: DeepResearchResult = {
  executiveSummary: "Remote work modestly reduces measured productivity in most studies.",
  findings: [
    { id: "f1", title: "Productivity decline", summary: "x", category: "Labor economics", evidenceStrength: "moderate", sourceBacked: true, coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] },
  ],
  lowConfidenceFindings: [],
  disagreements: [{ label: "Whether the effect is causal or selection-driven", supportingModels: [] }],
  evidenceGaps: ["Long-term panel data is scarce"],
  openQuestions: ["Does the effect persist post-pandemic?"],
  panelBlindSpots: [{ dimension: "International comparisons", whyItMatters: "x", followUpQuestion: "x" }],
  researchBoundaries: ["Limited to English-language studies"],
  recommendedNextSteps: ["Commission a longitudinal study"],
  sourceCoverage: { findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 },
  totalModels: 2,
};

const evidenceReviewResult: EvidenceReviewResult = {
  overallAssessment: "The evidence is moderate but methodologically sound.",
  overallStrength: "moderate",
  dimensions: [{ id: "sample-size", dimension: "Sample size", assessment: "Adequate for the claim.", strength: "moderate", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  lowConfidenceDimensions: [],
  redFlags: ["No pre-registration"],
  strengths: ["Peer-reviewed"],
  applicabilityCaveats: ["Only studied in one country"],
  recommendedChecks: ["Check for replication"],
  sourceBacked: true,
  totalModels: 2,
};

const biasBlindspotAuditResult: BiasBlindspotAuditResult = {
  summary: "Coverage looks reasonably balanced overall.",
  attributedBiases: [
    { biasType: "Western-centric framing", description: "Assumes a US regulatory context.", modelsImplicated: ["chatgpt" as any], evidence: [{ modelId: "chatgpt" as any, excerpt: "Under US law...", rationale: "Assumes US jurisdiction." }], likelyCauses: [], impact: "May mislead non-US readers.", mitigationSteps: [] },
  ],
  biasEmptyReason: null,
  panelBlindSpots: [{ id: "gap1", missingDimension: "International comparisons", coverageReason: "raised by 2 of 4 models" }],
  sharedAssumptions: ["Assumes stable interest rates"],
  missingStakeholders: ["Renters"],
  structuralDiagnostics: {
    citationCoverage: { modelsWithSources: 1, totalModels: 2, ratio: 0.5 },
    geographicBiasConcerns: ["US-centric framing"],
    sourceConcentrationConcerns: [],
    evidenceTypeConcerns: [],
    homogeneityFlag: true,
    homogeneityMessage: "Unusually uniform agreement. Models may share training data or assumptions, so strong consensus is not independent verification.",
  },
  followUpQuestions: ["How does this compare internationally?"],
  totalModels: 2,
};

const decisionSupportResult: DecisionSupportResult = {
  decisionQuestion: "Which CRM should we choose?",
  options: [
    { id: "hubspot", label: "HubSpot", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] },
    { id: "salesforce", label: "Salesforce", coverageCount: 1, totalModels: 2, coverageRatio: 0.5, contributingModels: [] },
  ],
  criteria: [{ id: "cost", label: "Total cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  assessments: [{ optionId: "hubspot", criterionId: "cost", assessment: "Cheaper for a small team.", evidenceStrength: "moderate", coverageCount: 2, totalModels: 2, contributingModels: [] }],
  recommendation: { action: "choose_option", recommendedOptionId: "hubspot", rationale: "Lower cost fits the stated budget.", caveats: ["Assumes team stays under 20 seats."], isContested: false, supportCount: 2, totalModelsWithRecommendation: 2 },
  assumptions: ["Budget stays flat"],
  uncertainties: ["Unclear rollout timeline"],
  risks: [{ id: "lockin", label: "Vendor lock-in", likelihood: "medium", impact: "high", mitigation: "Negotiate an exit clause.", coverageCount: 1, totalModels: 2, contributingModels: [] }],
  sensitivityFindings: ["If cost is the top priority, HubSpot wins by a wider margin."],
  reversibleNextStep: "Run a 2-week pilot with HubSpot.",
  humanReviewNeeded: false,
  sourceBacked: false,
  totalModels: 2,
};

const FIXTURES: Record<PersistedAdaptiveSchemaId, unknown> = {
  ranked_enumeration: rankedEnumerationResult,
  comparison_matrix: comparisonMatrixResult,
  definition_explanation: definitionExplanationResult,
  causal_explanation: causalExplanationResult,
  checklist_taxonomy: checklistTaxonomyResult,
  deep_research: deepResearchResult,
  evidence_review: evidenceReviewResult,
  bias_blindspot_audit: biasBlindspotAuditResult,
  decision_support: decisionSupportResult,
};

const ALL_SCHEMA_IDS = Object.keys(SCHEMA_ANSWER_SHAPE) as PersistedAdaptiveSchemaId[];

// ─── Shared contract ────────────────────────────────────────────────────

describe("buildAdaptiveDecisionReceipt — shared contract", () => {
  afterEach(() => jest.clearAllMocks());

  it.each(ALL_SCHEMA_IDS)("%s: is deterministic — the same input produces a deeply equal receipt", (schemaId) => {
    const input = envelope(schemaId, FIXTURES[schemaId]);
    const first = buildAdaptiveDecisionReceipt(input);
    const second = buildAdaptiveDecisionReceipt(input);
    expect(second).toEqual(first);
  });

  it.each(ALL_SCHEMA_IDS)("%s: never mutates the input envelope", (schemaId) => {
    const input = envelope(schemaId, FIXTURES[schemaId]);
    const snapshot = JSON.parse(JSON.stringify(input));
    buildAdaptiveDecisionReceipt(input);
    expect(input).toEqual(snapshot);
  });

  it.each(ALL_SCHEMA_IDS)("%s: never calls a model connector, the classifier, or triggers a network call", (schemaId) => {
    buildAdaptiveDecisionReceipt(envelope(schemaId, FIXTURES[schemaId]));
    expect(mockedCallGemini).not.toHaveBeenCalled();
    expect(mockedClassifyQuery).not.toHaveBeenCalled();
  });

  it.each(ALL_SCHEMA_IDS)("%s: produces a schema-specific conclusion, never a shared generic fallback string", (schemaId) => {
    const receipt = buildAdaptiveDecisionReceipt(envelope(schemaId, FIXTURES[schemaId]));
    expect(receipt.conclusion).not.toMatch(/^(no conclusion|not available|unknown result)$/i);
    expect(receipt.conclusion.trim().length).toBeGreaterThan(0);
  });

  it("preserves sourceBacked: true verbatim from CommonResponseMeta", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("decision_support", decisionSupportResult, { sourceBacked: true }));
    expect(receipt.sourceBacked).toBe(true);
  });

  it("preserves sourceBacked: false verbatim — never silently upgraded because the result has some source content", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("decision_support", decisionSupportResult, { sourceBacked: false }));
    expect(receipt.sourceBacked).toBe(false);
  });

  it("preserves humanReviewNeeded verbatim from CommonResponseMeta in both directions", () => {
    const receiptTrue = buildAdaptiveDecisionReceipt(envelope("decision_support", decisionSupportResult, { humanReviewNeeded: true }));
    const receiptFalse = buildAdaptiveDecisionReceipt(envelope("decision_support", decisionSupportResult, { humanReviewNeeded: false }));
    expect(receiptTrue.humanReviewNeeded).toBe(true);
    expect(receiptFalse.humanReviewNeeded).toBe(false);
  });

  it("preserves CommonResponseMeta.limitations inside the receipt's own limitations", () => {
    const receipt = buildAdaptiveDecisionReceipt(
      envelope("decision_support", decisionSupportResult, { limitations: ["1 of 2 selected models did not produce usable structured output."] })
    );
    expect(receipt.limitations).toContain("1 of 2 selected models did not produce usable structured output.");
  });

  it("deduplicates exact-duplicate source strings", () => {
    const dupedResult: ComparisonMatrixResult = {
      ...comparisonMatrixResult,
      cells: [
        { ...comparisonMatrixResult.cells[0], sources: ["Apple.com", "Apple.com"] },
        { ...comparisonMatrixResult.cells[0], attributeId: "weight", attribute: "Weight", sources: ["Apple.com"] },
      ],
    };
    const receipt = buildAdaptiveDecisionReceipt(envelope("comparison_matrix", dupedResult));
    expect(receipt.sources).toEqual(["Apple.com"]);
  });

  it("handles empty optional arrays safely across every schema without throwing", () => {
    const emptyFixtures: Record<PersistedAdaptiveSchemaId, unknown> = {
      ranked_enumeration: { items: [], lowConfidenceItems: [], requestedCount: null, actualCount: 0, rankCorrelation: null, hasLiveQueryLogData: false, totalModels: 0 },
      comparison_matrix: { subjects: [], lowConfidenceSubjects: [], attributes: [], lowConfidenceAttributes: [], cells: [], hasVerifiedSourceData: false, totalModels: 0 },
      definition_explanation: { primary: null, alternateInterpretations: [], isAmbiguous: false, sourceBacked: false, totalModels: 0 },
      causal_explanation: { directAnswer: "", factors: [], causalChain: [], confounders: [], disputedInterpretations: [], unknowns: [], testsOrEvidenceNeeded: [], sourceBacked: false, totalModels: 0 },
      checklist_taxonomy: { summary: "", categories: [], lowConfidenceItems: [], notes: [], totalModels: 0 },
      deep_research: { executiveSummary: "", findings: [], lowConfidenceFindings: [], disagreements: [], evidenceGaps: [], openQuestions: [], panelBlindSpots: [], researchBoundaries: [], recommendedNextSteps: [], sourceCoverage: { findingsWithSources: 0, totalFindings: 0, coverageRatio: 0 }, totalModels: 0 },
      evidence_review: { overallAssessment: "", overallStrength: "unknown", dimensions: [], lowConfidenceDimensions: [], redFlags: [], strengths: [], applicabilityCaveats: [], recommendedChecks: [], sourceBacked: false, totalModels: 0 },
      bias_blindspot_audit: { summary: "", attributedBiases: [], biasEmptyReason: null, panelBlindSpots: [], sharedAssumptions: [], missingStakeholders: [], structuralDiagnostics: { citationCoverage: { modelsWithSources: 0, totalModels: 0, ratio: 0 }, geographicBiasConcerns: [], sourceConcentrationConcerns: [], evidenceTypeConcerns: [], homogeneityFlag: false }, followUpQuestions: [], totalModels: 0 },
      decision_support: { decisionQuestion: "", options: [], criteria: [], assessments: [], recommendation: { action: "escalate", rationale: "", caveats: [], isContested: false, supportCount: 0, totalModelsWithRecommendation: 0 }, assumptions: [], uncertainties: [], risks: [], sensitivityFindings: [], humanReviewNeeded: true, sourceBacked: false, totalModels: 0 },
    };
    for (const schemaId of ALL_SCHEMA_IDS) {
      expect(() => buildAdaptiveDecisionReceipt(envelope(schemaId, emptyFixtures[schemaId]))).not.toThrow();
    }
  });

  it("fails safely (throws a dedicated error, never a partially fabricated or generic-fallback receipt) on an impossible schemaId that bypasses the type system", () => {
    const corrupted = envelope("decision_support", decisionSupportResult);
    (corrupted as unknown as { schemaId: string }).schemaId = "not_a_real_schema";
    expect(() => buildAdaptiveDecisionReceipt(corrupted)).toThrow(DecisionReceiptBuildError);
  });
});

// ─── Per-schema ─────────────────────────────────────────────────────────

describe("ranked_enumeration receipt", () => {
  it("preserves ranked items, requested count, shortfall, low-confidence items, and never adds certainty language", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("ranked_enumeration", rankedEnumerationResult));
    expect(receipt.basis.join(" ")).toContain("ChatGPT");
    expect(receipt.basis.join(" ")).toContain("Claude");
    expect(receipt.conclusion).toMatch(/meeting the requested count of 3/i);
    expect(receipt.uncertainties.join(" ")).toContain("Grok");
    expect(receipt.conclusion).not.toMatch(/definitively|proven/i);
  });

  it("uses the shortfall note verbatim as the conclusion when the panel fell short", () => {
    const shortfall: RankedEnumerationResult = { ...rankedEnumerationResult, shortfallNote: "You asked for 20 items; the panel could only responsibly identify 3." };
    const receipt = buildAdaptiveDecisionReceipt(envelope("ranked_enumeration", shortfall));
    expect(receipt.conclusion).toBe("You asked for 20 items; the panel could only responsibly identify 3.");
  });
});

describe("comparison_matrix receipt", () => {
  it("preserves subjects and criteria, and never invents a winner", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("comparison_matrix", comparisonMatrixResult));
    expect(receipt.basis.join(" ")).toContain("iPhone 15");
    expect(receipt.basis.join(" ")).toContain("Price");
    expect(receipt.conclusion).toMatch(/no single overall recommendation was produced/i);
  });

  it("preserves missing cells as an explicit limitation rather than inferring a value", () => {
    const withGap: ComparisonMatrixResult = {
      ...comparisonMatrixResult,
      attributes: [...comparisonMatrixResult.attributes, { id: "weight", label: "Weight", coverageCount: 1, totalModels: 2, coverageRatio: 0.5 }],
    };
    const receipt = buildAdaptiveDecisionReceipt(
      envelope("comparison_matrix", withGap, { limitations: ["1 comparison cell had no supported value."] })
    );
    expect(receipt.limitations).toContain("1 comparison cell had no supported value.");
  });
});

describe("definition_explanation receipt", () => {
  it("preserves the accepted interpretation as the conclusion, with no verdict/approval language", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("definition_explanation", definitionExplanationResult));
    expect(receipt.conclusion).toBe("CAGR is the compound annual growth rate.");
    expect(receipt.conclusion).not.toMatch(/approved|verified|confirmed/i);
  });

  it("preserves ambiguity and alternative meanings when the result is ambiguous", () => {
    const ambiguous: DefinitionExplanationResult = {
      ...definitionExplanationResult,
      isAmbiguous: true,
      alternateInterpretations: [{ ...definitionExplanationResult.primary!, directAnswer: "CAGR can also refer to a compound annual growth ratio in a different domain." }],
    };
    const receipt = buildAdaptiveDecisionReceipt(envelope("definition_explanation", ambiguous));
    expect(receipt.uncertainties.some((u) => /multiple accepted interpretations/i.test(u))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("a different domain"))).toBe(true);
  });
});

describe("causal_explanation receipt", () => {
  it("preserves principal causes, alternative explanations, confounders, and disputed interpretations, keeping alternatives out of the main cause list", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("causal_explanation", causalExplanationResult));
    expect(receipt.basis.some((b) => b.includes("Direct cause: Rising demand"))).toBe(true);
    expect(receipt.basis.some((b) => b.includes("Monetary expansion"))).toBe(false);
    expect(receipt.uncertainties.some((u) => u.includes("Monetary expansion"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("Seasonal demand spikes"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("primary driver"))).toBe(true);
  });

  it("never introduces causal-proof language", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("causal_explanation", causalExplanationResult));
    const allText = [receipt.conclusion, ...receipt.basis, ...receipt.uncertainties].join(" ");
    expect(allText).not.toMatch(/proves|proven|definitively caused/i);
  });
});

describe("checklist_taxonomy receipt", () => {
  it("preserves categories, critical flags, and low-confidence items without introducing rank", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("checklist_taxonomy", checklistTaxonomyResult));
    expect(receipt.basis.some((b) => b.includes("Publish terms of service") && b.includes("critical"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("File trademark"))).toBe(true);
    expect(receipt.basis.join(" ")).not.toMatch(/^\d+\./m);
  });
});

describe("deep_research receipt", () => {
  it("preserves the executive summary, findings, disagreements, gaps, and boundaries without claiming exhaustiveness", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("deep_research", deepResearchResult));
    expect(receipt.conclusion).toBe(deepResearchResult.executiveSummary);
    expect(receipt.basis.some((b) => b.includes("Productivity decline"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("causal or selection-driven"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("Long-term panel data"))).toBe(true);
    expect(receipt.limitations.some((l) => l.includes("English-language studies"))).toBe(true);
    expect(receipt.conclusion).not.toMatch(/exhaustive|complete review of all/i);
  });
});

describe("evidence_review receipt", () => {
  it("preserves overall assessment, strength, red flags, and applicability caveats without upgrading strength from coverage", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("evidence_review", evidenceReviewResult));
    expect(receipt.conclusion).toBe(evidenceReviewResult.overallAssessment);
    expect(receipt.basis.some((b) => b.includes("Overall strength: moderate"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("No pre-registration"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("one country"))).toBe(true);
    // The receipt never touches strength itself — it's read as-is, never recomputed.
    expect(receipt.basis.join(" ")).not.toMatch(/upgraded|strong consensus proves/i);
  });
});

describe("bias_blindspot_audit receipt", () => {
  it("preserves attributed model IDs, evidence descriptions, panel gaps, and the homogeneity flag, never concluding 'no bias'", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("bias_blindspot_audit", biasBlindspotAuditResult));
    expect(receipt.basis.some((b) => b.includes("chatgpt"))).toBe(true);
    expect(receipt.basis.some((b) => b.includes("Western-centric framing"))).toBe(true);
    expect(receipt.basis.some((b) => b.includes("International comparisons"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("Unusually uniform agreement"))).toBe(true);
    expect(receipt.conclusion).not.toMatch(/no bias (was )?found|unbiased/i);
  });

  it("preserves the no-attribution reason when Tier 1 is empty, never implying the answer is unbiased", () => {
    const empty: BiasBlindspotAuditResult = { ...biasBlindspotAuditResult, attributedBiases: [], biasEmptyReason: "below_threshold" };
    const receipt = buildAdaptiveDecisionReceipt(envelope("bias_blindspot_audit", empty));
    expect(receipt.uncertainties.some((u) => u.includes("below_threshold") && /not mean the answer is unbiased/i.test(u))).toBe(true);
  });
});

describe("decision_support receipt", () => {
  it("preserves the recommendation, action, option, risks, and sensitivity findings", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("decision_support", decisionSupportResult));
    expect(receipt.conclusion).toMatch(/^Choose option: HubSpot/);
    expect(receipt.limitations.some((l) => l.includes("Vendor lock-in"))).toBe(true);
    expect(receipt.uncertainties.some((u) => u.includes("HubSpot wins by a wider margin"))).toBe(true);
    expect(receipt.limitations.some((l) => l.includes("Run a 2-week pilot"))).toBe(true);
  });

  it("never hides an escalate/defer/conditional-go outcome behind generic language", () => {
    const escalated: DecisionSupportResult = {
      ...decisionSupportResult,
      recommendation: { action: "escalate", rationale: "Evidence is too thin to decide.", caveats: [], isContested: false, supportCount: 0, totalModelsWithRecommendation: 0 },
    };
    const receipt = buildAdaptiveDecisionReceipt(envelope("decision_support", escalated));
    expect(receipt.conclusion).toMatch(/^Escalate/);
  });

  it("does not introduce vote-count-based decision logic — isContested is surfaced verbatim, not re-derived", () => {
    const contested: DecisionSupportResult = {
      ...decisionSupportResult,
      recommendation: { ...decisionSupportResult.recommendation, isContested: true },
    };
    const receipt = buildAdaptiveDecisionReceipt(envelope("decision_support", contested));
    expect(receipt.uncertainties.some((u) => /did not converge/i.test(u))).toBe(true);
  });

  it("takes humanReviewNeeded from CommonResponseMeta, not from independent vote-count inference", () => {
    const receipt = buildAdaptiveDecisionReceipt(envelope("decision_support", decisionSupportResult, { humanReviewNeeded: true }));
    expect(receipt.humanReviewNeeded).toBe(true);
  });
});
