/**
 * Order 6 / S-E.2: export fixtures for Decision Support (and non-DS controls), version-agnostic.
 *
 * This module must build the same inputs at the base commit (0249a4e5, before S-E.2) and at the S-E.2 head, so the
 * historical baseline (captured at the base with the base builder and renderers) and the head comparison see identical
 * inputs. It therefore imports only modules that exist unchanged at the base: the real DS producer, the real meta
 * builder, and the export snapshot builder. Nothing here is hand-assembled where a producer exists.
 *
 * Everything is fixed: ids, timestamps, the meta `generatedAt` (the real builder stamps `new Date()`), so every render
 * is a pure function of these inputs.
 */
import { buildDecisionSupportResult, type DecisionSupportFields } from "@/lib/adaptiveSchema/decisionSupportAlignment";
import { buildCommonResponseMeta } from "@/lib/adaptiveSchema/commonResponseMeta";
import { buildExportSnapshot, type BuildExportSnapshotInput } from "@/lib/adaptiveSchema/exportSnapshot";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import type { AdaptiveResearchExportV1, AdaptiveExportFormat } from "@/lib/adaptiveSchema/researchExport";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import type { PersistedAdaptiveOutputV1, PersistedLegacyAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import type { AdaptiveModelResult, QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";
import type { ModelId, ModelResult } from "@/lib/types";

export const FIXED_AT = "2026-03-04T05:06:07.000Z";
export const FORMATS: AdaptiveExportFormat[] = ["pdf", "docx", "json"];

/** Model-authored text is passed through `wrap`: identity for real rendering, a sentinel for the wording scanner. */
export type Wrap = (text: string) => string;
const plain: Wrap = (t) => t;

function classification(queryType: QueryType, riskLevel: QueryClassification["riskLevel"] = "professional"): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: SCHEMA_REGISTRY[queryType].renderHint,
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel,
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
  } as QueryClassification;
}

const MODEL_IDS = ["chatgpt", "claude", "gemini", "grok", "perplexity"] as ModelId[];

type PerModel = { modelId: ModelId; fields: DecisionSupportFields }[];

/** One DS state: per-model producer inputs, the dispatched-slot count, and the risk level. */
export type DsState = { name: string; perModel: PerModel; totalModels: number; risk?: "safety_critical" };

/** The S-E.1 state matrix (same producer inputs as seSurfaceHarness.dsFixtures), plus the :488 collision state. */
export function dsStates(wrap: Wrap = plain): DsState[] {
  const fields = (over: Partial<DecisionSupportFields> = {}): DecisionSupportFields => ({
    decisionQuestion: wrap("Which vendor should we choose?"),
    options: [],
    criteria: [],
    userProvidedCriteria: [],
    assessments: [],
    recommendationAction: "",
    recommendedOption: "none",
    recommendationRationale: wrap("Model rationale text."),
    recommendationCaveats: [wrap("Model caveat text.")],
    assumptions: [wrap("Model assumption text.")],
    uncertainties: [wrap("Model uncertainty text.")],
    risks: [{ id: "r1", label: wrap("Model risk text."), likelihood: "medium", impact: "high", mitigation: wrap("Model mitigation text.") }],
    sensitivityFindings: [wrap("Model sensitivity text.")],
    reversibleNextStep: wrap("Model next step text."),
    sources: [wrap("Model-listed source")],
    ...over,
  });
  const OPT_A = wrap("Option Alpha plan");
  const OPT_B = wrap("Option Bravo route");
  const CRIT_1 = wrap("Total cost");
  const CRIT_2 = wrap("Time to deploy");
  const assessed = (option: string, strengths: [string, string]): DecisionSupportFields["assessments"] => [
    { id: `${option}-c1`, optionLabel: option, criterionLabel: CRIT_1, assessment: wrap("Model assessment text."), evidenceStrength: strengths[0] as never },
    { id: `${option}-c2`, optionLabel: option, criterionLabel: CRIT_2, assessment: wrap("Model assessment text."), evidenceStrength: strengths[1] as never },
  ];
  const choose = (option: string, extra: Partial<DecisionSupportFields> = {}): DecisionSupportFields =>
    fields({
      options: [OPT_A, OPT_B],
      criteria: [CRIT_1, CRIT_2],
      assessments: [...assessed(OPT_A, ["strong", "moderate"]), ...assessed(OPT_B, ["weak", "strong"])],
      recommendationAction: "choose_option",
      recommendedOption: option,
      ...extra,
    });
  const models = (...f: DecisionSupportFields[]): PerModel => f.map((fl, i) => ({ modelId: MODEL_IDS[i], fields: fl }));
  const state = (name: string, perModel: PerModel, totalModels = perModel.length, risk?: "safety_critical"): DsState => ({ name, perModel, totalModels, risk });
  const approve = wrap("Approve the vendor contract");
  const disapprove = wrap("Disapprove the vendor contract");
  const unlisted = wrap("An option nobody listed");
  // The producer's own :488 sentence, written verbatim by every model as its rationale (R3 collision, receipt-side limit).
  const stored488 = "Models agree a specific option should be chosen but did not name one this system could confidently resolve.";
  return [
    state("uncontested_choose_option", models(choose(OPT_A), choose(OPT_A), choose(OPT_A))),
    state("uncontested_go_with_failed_slots", models(fields({ recommendationAction: "go", options: [OPT_A] }), fields({ recommendationAction: "go", options: [OPT_A] })), 5),
    state("contested_on_action", models(fields({ recommendationAction: "go", options: [OPT_A] }), fields({ recommendationAction: "defer", options: [OPT_A] }), fields({ recommendationAction: "no_go", options: [OPT_A] }))),
    state("contested_on_option", models(choose(OPT_A), choose(OPT_B), choose(OPT_A))),
    state("no_recommendation", models(fields({ options: [OPT_A, OPT_B] }), fields({ options: [OPT_A, OPT_B] }))),
    state("no_recommendation_no_options", models(fields(), fields())),
    state("all_models_failed", [], 3),
    state("single_model", models(fields({ recommendationAction: "go", options: [OPT_A], criteria: [CRIT_1], assessments: assessed(OPT_A, ["strong", "weak"]).slice(0, 1) }))),
    state(
      "merged_opposite_options",
      models(
        fields({ options: [approve, disapprove], recommendationAction: "choose_option", recommendedOption: approve }),
        fields({ options: [disapprove, approve], recommendationAction: "choose_option", recommendedOption: disapprove })
      )
    ),
    state("blank_source_list", models(fields({ recommendationAction: "go", options: [OPT_A], sources: [""] }), fields({ recommendationAction: "go", options: [OPT_A], sources: ["  "] }))),
    state("no_sources", models(fields({ recommendationAction: "go", options: [OPT_A], sources: [] }))),
    state("high_stakes_review_needed", models(fields({ recommendationAction: "go", options: [OPT_A] })), 1, "safety_critical"),
    state("unresolved_option_488", models(choose(unlisted), choose(unlisted))),
    state("split_option_498", models(choose(OPT_A), choose(OPT_B), choose(OPT_B))),
    state("partial_option_resolution_498", models(choose(OPT_A), choose(OPT_A), choose(unlisted))),
    state(
      "conditional_go_collision_488",
      models(
        fields({ recommendationAction: "conditional_go", options: [OPT_A], recommendationRationale: stored488 }),
        fields({ recommendationAction: "conditional_go", options: [OPT_A], recommendationRationale: stored488 })
      )
    ),
  ];
}

/** The DS persisted output, through the real producer and the real meta builder (generatedAt fixed afterwards). */
export function dsOutput(s: DsState): PersistedAdaptiveOutputV1 {
  const result = buildDecisionSupportResult(s.perModel, s.totalModels, s.risk);
  const cls = classification("decision_support", s.risk ?? "professional");
  const modelResults: ModelResult[] = Array.from({ length: s.totalModels }, (_, i) => ({
    modelId: MODEL_IDS[i],
    status: i < s.perModel.length ? "ok" : "error",
    rawText: null,
    latencyMs: 1,
  }));
  const adaptiveResults: AdaptiveModelResult[] = s.perModel.map((p) => ({ modelId: p.modelId, schemaId: "decision_support", ok: true, data: p.fields }) as AdaptiveModelResult);
  const meta = { ...buildCommonResponseMeta({ schema: SCHEMA_REGISTRY.decision_support, classification: cls, modelResults, adaptiveResults, schemaResult: result }), generatedAt: FIXED_AT };
  return { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", classification: cls, meta, generatedAt: FIXED_AT, result } as PersistedAdaptiveOutputV1;
}

type Review = GovernanceRecordV1["humanReview"];
/** A governance record carrying only what the snapshot builder reads (its presence, and humanReview). */
function governance(humanReview: Review): GovernanceRecordV1 {
  return { version: 1, humanReview, createdAt: FIXED_AT, updatedAt: FIXED_AT } as unknown as GovernanceRecordV1;
}

export type GovernanceVariant = { name: string; record?: GovernanceRecordV1; reviewRouting?: "in_queue" | "not_configured" | "unknown" };
export const GOVERNANCE_VARIANTS: GovernanceVariant[] = [
  { name: "unreviewed_in_queue", record: governance({ status: "unreviewed" }), reviewRouting: "in_queue" },
  { name: "not_configured", record: governance({ status: "unreviewed" }), reviewRouting: "not_configured" },
  { name: "approved", record: governance({ status: "approved", decidedVia: "single_reviewer" }) },
  { name: "approved_with_conditions", record: governance({ status: "approved_with_conditions", conditions: ["Confirm the vendor's SLA in writing."] }) },
  { name: "changes_requested", record: governance({ status: "changes_requested" }) },
  { name: "rejected", record: governance({ status: "rejected" }) },
  { name: "owner_override_approved", record: governance({ status: "approved", decidedVia: "multi_reviewer_owner_override" }) },
  { name: "no_governance_record" },
];

export type ExportCase = { name: string; schemaId: string; input: BuildExportSnapshotInput };

function dsCase(s: DsState, g: GovernanceVariant): ExportCase {
  const selected = MODEL_IDS.slice(0, Math.max(s.totalModels, 1));
  return {
    name: `ds.${s.name}.${g.name}`,
    schemaId: "decision_support",
    input: {
      question: "Which vendor should we choose for the platform migration?",
      selectedModels: selected,
      modelResultsOkByModelId: Object.fromEntries(selected.map((m, i) => [m, i < s.perModel.length])),
      runDocument: undefined,
      milestone2: { output: dsOutput(s), governanceRecord: g.record, reviewRouting: g.reviewRouting },
    },
  };
}

/** Non-DS controls built through the same builder: one Milestone-2 schema and one legacy schema. */
function nonDsCases(): ExportCase[] {
  const cm: PersistedAdaptiveOutputV1 = {
    version: 1,
    schemaId: "comparison_matrix",
    answerShape: "comparison_grid",
    classification: classification("comparison_matrix"),
    meta: { schemaVersion: 1, queryType: "comparison_matrix", answerShape: "comparison_grid", dataBasis: "mixed", freshness: "timeless", riskLevel: "professional", evidenceQuality: "moderate", uncertainties: [], blindSpots: [], humanReviewNeeded: false, generatedAt: FIXED_AT, sourceBacked: true },
    generatedAt: FIXED_AT,
    result: { subjects: [], attributes: [], cells: [], totalModels: 2, lowConfidenceSubjects: [], lowConfidenceAttributes: [], hasVerifiedSourceData: false, tradeoffs: ["Cost against speed."], bestUseRecommendations: ["Use A for small teams."] },
  } as unknown as PersistedAdaptiveOutputV1;
  const legacy: PersistedLegacyAdaptiveOutputV1 = {
    version: 1,
    schemaId: "financial_valuation",
    classification: classification("financial_valuation"),
    generatedAt: FIXED_AT,
    results: [
      { modelId: "chatgpt" as ModelId, schemaId: "financial_valuation", ok: true, data: { thesis: "Thesis A", metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026" }] } },
      { modelId: "claude" as ModelId, schemaId: "financial_valuation", ok: true, data: { thesis: "Thesis B", metrics: [{ label: "P/E", value: 22, unit: "x", asOf: "2026" }] } },
    ] as AdaptiveModelResult[],
    alignedClaims: [],
  } as PersistedLegacyAdaptiveOutputV1;
  const selected = ["chatgpt", "claude"] as ModelId[];
  return [
    { name: "nonds.comparison_matrix.unreviewed_in_queue", schemaId: "comparison_matrix", input: { question: "Compare A and B.", selectedModels: selected, runDocument: undefined, milestone2: { output: cm, governanceRecord: GOVERNANCE_VARIANTS[0].record, reviewRouting: "in_queue" } } },
    { name: "nonds.comparison_matrix.no_governance_record", schemaId: "comparison_matrix", input: { question: "Compare A and B.", selectedModels: selected, runDocument: undefined, milestone2: { output: cm } } },
    { name: "nonds.financial_valuation.approved", schemaId: "financial_valuation", input: { question: "Value the company.", selectedModels: selected, runDocument: undefined, legacy: { output: legacy, governanceStatus: "approved", governanceMeta: undefined } } },
  ];
}

/** Every state with the in-queue review; every review state on two representative DS states; the non-DS controls. */
export function exportCases(wrap: Wrap = plain): ExportCase[] {
  const states = dsStates(wrap);
  const cases: ExportCase[] = states.map((s) => dsCase(s, GOVERNANCE_VARIANTS[0]));
  for (const name of ["uncontested_choose_option", "unresolved_option_488"]) {
    const s = states.find((x) => x.name === name)!;
    for (const g of GOVERNANCE_VARIANTS.slice(1)) cases.push(dsCase(s, g));
  }
  return [...cases, ...nonDsCases()];
}

/** The export record the creation route composes (export/route.ts:188-224), with fixed ids and timestamps. */
export function exportRecord(c: ExportCase, format: AdaptiveExportFormat): AdaptiveResearchExportV1 {
  const built = buildExportSnapshot(c.input);
  const exportId = `exp-${c.name}-${format}`;
  const runId = `run-${c.name}`;
  const family = c.input.milestone2 ? "milestone2" : "legacy";
  return {
    version: 1,
    exportId,
    runId,
    schemaId: c.schemaId as AdaptiveResearchExportV1["schemaId"],
    schemaFamily: family,
    schemaVersion: 1,
    reportVersion: 3,
    createdAt: FIXED_AT,
    createdBy: "uid-fixture",
    generatedBy: { displayName: "Fixture Exporter", maskedEmail: "f***@example.com" },
    format,
    artifactStatus: "generating",
    classification: built.classification,
    governanceStatusAtExport: built.governanceStatusAtExport,
    reportSnapshot: built.reportSnapshot,
    exportMetadata: {
      exportId,
      runId,
      schemaVersion: 1,
      exportedSections: family === "milestone2" ? ["reportSnapshot.milestone2"] : ["reportSnapshot.legacy"],
      createdAt: FIXED_AT,
      requestingUser: "uid-fixture",
      finalReportVersion: 3,
    },
  };
}

/**
 * The record as Firestore stores and returns it: `sanitizeForFirestore` (lib/firestore/sanitizeForFirestore.ts) turns
 * every `undefined` into `null`, recursively, then the ready transition sets status and hash. A spec pins this mirror
 * equal to the real function.
 */
export function asStored<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value) as T;
}
