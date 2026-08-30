/**
 * Query-Routing Redesign, Phase 2A, Step 3 — deterministic decision-receipt
 * builders for all 9 active Milestone 2 dedicated schemas.
 *
 * Pure data reshaping, nothing else: every builder reads only
 * `adaptiveOutput.result` (already-aggregated, already-validated schema
 * output) and `adaptiveOutput.meta` (Phase 1's CommonResponseMeta) — no
 * model connector, no classifier, no network call, no re-aggregation.
 * Aggregation already happened once, at generation time, inside each
 * schema's own alignment module (enumAlignment.ts, decisionSupportAlignment.ts,
 * etc.) — this module reshapes that result into a governance-readable
 * receipt, it never reinterprets it. Text-list "deduplication" here is
 * therefore exact-string only (`dedupeExact`, private to this module), not
 * `textSimilarity.ts`'s `dedupeTextList` — that helper does fuzzy
 * near-duplicate CLUSTERING (Levenshtein ratio + token overlap), which is
 * precisely the "aggressive semantic clustering" this module is required to
 * avoid. Same reasoning already applied to `CommonResponseMeta.limitations`
 * in commonResponseMeta.ts.
 *
 * `sourceBacked`/`humanReviewNeeded` are always read from `meta` (Phase 1's
 * already-computed, centrally-derived signals) and never independently
 * recomputed here — the exact same "one source of truth, reused" discipline
 * `commonResponseMeta.ts`'s own source-coverage/human-review adapters
 * already established.
 */

import "server-only";
import { PersistedAdaptiveOutputV1 } from "./persistedOutput";
import { AdaptiveDecisionReceipt } from "./governanceRecord";
import {
  BiasBlindspotAuditResult,
  CausalExplanationResult,
  CausalFactorCategory,
  ChecklistTaxonomyResult,
  CommonResponseMeta,
  ComparisonMatrixResult,
  DecisionRecommendationAction,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EvidenceReviewResult,
  RankedEnumerationResult,
} from "./types";

/** A truly unreachable state given a TYPE-VALID `PersistedAdaptiveOutputV1` (schemaId/result correspondence is enforced by the discriminated union) — only reachable if a caller bypasses the type system (an `as` cast on corrupted data) or a future schema variant is added without a matching builder case (caught at compile time by the exhaustiveness check below, and at runtime by this error if that check is ever suppressed). */
export class DecisionReceiptBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionReceiptBuildError";
  }
}

/** Exact-string dedup only — see module doc for why this is deliberately NOT textSimilarity.ts's dedupeTextList. */
function dedupeExact(items: string[]): string[] {
  return Array.from(new Set(items.map((s) => s.trim()).filter((s) => s.length > 0)));
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ─── ranked_enumeration ─────────────────────────────────────────────────

function buildRankedEnumerationReceipt(result: RankedEnumerationResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const conclusion = result.shortfallNote
    ? result.shortfallNote
    : result.requestedCount != null
      ? `The panel produced ${pluralize(result.actualCount, "ranked item")}, meeting the requested count of ${result.requestedCount}.`
      : `The panel identified ${pluralize(result.actualCount, "ranked item")} as the strongest-supported ranking under the available evidence.`;

  const basis = result.items.map((item) => `${item.label} (${item.coverageCount} of ${item.totalModels} models)`);

  const assumptions = result.hasLiveQueryLogData
    ? []
    : ["This ranking reflects the panel's own estimate, not measured live query-log or search-frequency data."];

  const uncertainties = result.lowConfidenceItems.map(
    (item) => `${item.label} — supported by only ${item.coverageCount} of ${item.totalModels} models.`
  );

  const sources = dedupeExact([...result.items, ...result.lowConfidenceItems].flatMap((item) => item.sources ?? []));

  return {
    conclusion,
    basis,
    assumptions,
    uncertainties,
    limitations: dedupeExact(meta.limitations ?? []),
    sources,
    sourceBacked: meta.sourceBacked ?? sources.length > 0,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── comparison_matrix ──────────────────────────────────────────────────

function buildComparisonMatrixReceipt(result: ComparisonMatrixResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const totalSubjects = result.subjects.length + result.lowConfidenceSubjects.length;
  const totalAttributes = result.attributes.length + result.lowConfidenceAttributes.length;

  const conclusion =
    totalSubjects > 0 && totalAttributes > 0
      ? `The panel compared ${pluralize(totalSubjects, "subject")} across ${pluralize(totalAttributes, "attribute")}; no single overall recommendation was produced.`
      : "The panel did not converge on enough shared subjects and attributes for a comparison.";

  const basis = [
    ...result.subjects.map((s) => `Subject: ${s.label} (${s.coverageCount} of ${s.totalModels} models)`),
    ...result.attributes.map((a) => `Attribute: ${a.label} (${a.coverageCount} of ${a.totalModels} models)`),
  ];

  const uncertainties = [
    ...result.lowConfidenceSubjects.map((s) => `Subject "${s.label}" is supported by only ${s.coverageCount} of ${s.totalModels} models.`),
    ...result.lowConfidenceAttributes.map((a) => `Attribute "${a.label}" is supported by only ${a.coverageCount} of ${a.totalModels} models.`),
  ];

  const sources = dedupeExact(result.cells.flatMap((cell) => cell.sources ?? []));

  return {
    conclusion,
    basis,
    assumptions: result.hasVerifiedSourceData
      ? []
      : ["Comparison values reflect the panel's own generated assessments, not live verified pricing, specs, or data."],
    uncertainties,
    limitations: dedupeExact(meta.limitations ?? []),
    sources,
    sourceBacked: meta.sourceBacked ?? sources.length > 0,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── definition_explanation ─────────────────────────────────────────────

function buildDefinitionExplanationReceipt(result: DefinitionExplanationResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  if (!result.primary) {
    return {
      conclusion: "No definition could be produced for this question.",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: dedupeExact(meta.limitations ?? []),
      sources: [],
      sourceBacked: meta.sourceBacked ?? false,
      humanReviewNeeded: meta.humanReviewNeeded,
    };
  }

  const uncertainties = result.isAmbiguous
    ? [
        "The term has multiple accepted interpretations.",
        ...result.alternateInterpretations.map((alt) => `Alternative interpretation: ${alt.directAnswer}`),
      ]
    : [];

  const sources = dedupeExact([result.primary, ...result.alternateInterpretations].flatMap((i) => i.sources));

  return {
    conclusion: result.primary.directAnswer,
    basis: [result.primary.explanation, ...result.primary.keyPoints],
    assumptions: [],
    uncertainties,
    limitations: dedupeExact(meta.limitations ?? []),
    sources,
    sourceBacked: meta.sourceBacked ?? result.sourceBacked,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── causal_explanation ─────────────────────────────────────────────────

const CAUSAL_CATEGORY_LABEL: Record<Exclude<CausalFactorCategory, "direct_cause" | "alternative_explanation">, string> = {
  contributing_factor: "Contributing factor",
  trigger: "Trigger",
  amplifier: "Amplifier",
  protective_factor: "Protective factor",
};

function buildCausalExplanationReceipt(result: CausalExplanationResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const principalCauses = result.factors.filter((f) => f.category === "direct_cause");
  const otherFactors = result.factors.filter((f) => f.category !== "direct_cause" && f.category !== "alternative_explanation");
  const alternativeExplanations = result.factors.filter((f) => f.category === "alternative_explanation");

  const basis = [
    ...principalCauses.map((f) => `Direct cause: ${f.label} (${f.coverageCount} of ${f.totalModels} models)`),
    ...otherFactors.map(
      (f) => `${CAUSAL_CATEGORY_LABEL[f.category as Exclude<CausalFactorCategory, "direct_cause" | "alternative_explanation">]}: ${f.label} (${f.coverageCount} of ${f.totalModels} models)`
    ),
  ];

  const uncertainties = [
    ...alternativeExplanations.map((f) => `Alternative explanation: ${f.label}`),
    ...result.disputedInterpretations.map((d) => `Disputed interpretation: ${d.label}`),
    ...result.confounders.map((c) => `Possible confounder: ${c}`),
    ...result.unknowns,
    ...result.testsOrEvidenceNeeded.map((t) => `Would need: ${t}`),
  ];

  return {
    conclusion: result.directAnswer,
    basis,
    // No explicit "assumptions" concept exists in this schema's aggregated
    // result — empty, not fabricated.
    assumptions: [],
    uncertainties,
    limitations: dedupeExact(meta.limitations ?? []),
    // Phase 10D.1 — recovered from the alignment module's own per-model
    // `fields.sources`, previously computed only into the `sourceBacked`
    // boolean and discarded. See causalAlignment.ts's `sources` computation.
    sources: dedupeExact(result.sources),
    sourceBacked: meta.sourceBacked ?? result.sourceBacked,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── checklist_taxonomy ─────────────────────────────────────────────────

function buildChecklistTaxonomyReceipt(result: ChecklistTaxonomyResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const isFlatChecklist = result.categories.length <= 1 && (result.categories.length === 0 || result.categories[0].category === "General");
  const totalItems = result.categories.reduce((sum, group) => sum + group.items.length, 0);

  const conclusion =
    result.summary.trim().length > 0
      ? result.summary
      : isFlatChecklist
        ? `The panel produced a checklist of ${pluralize(totalItems, "item")}.`
        : `The panel produced a taxonomy of ${pluralize(totalItems, "item")} across ${pluralize(result.categories.length, "category")}.`;

  const basis = result.categories.flatMap((group) =>
    group.items.map((item) => `${isFlatChecklist ? "" : `[${group.category}] `}${item.label}${item.critical ? " (critical)" : ""}`)
  );

  const uncertainties = result.lowConfidenceItems.map(
    (item) => `${item.label} — supported by only ${item.coverageCount} of ${item.totalModels} models.`
  );

  return {
    conclusion,
    basis,
    assumptions: [],
    uncertainties,
    limitations: dedupeExact([...(meta.limitations ?? []), ...result.notes]),
    // This schema's wire contract never asked models to cite sources — no
    // source signal exists at any level (verified in commonResponseMeta.ts).
    sources: [],
    sourceBacked: meta.sourceBacked ?? false,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── deep_research ──────────────────────────────────────────────────────

function buildDeepResearchReceipt(result: DeepResearchResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const basis = result.findings.map((f) => `${f.title} (${f.coverageCount} of ${f.totalModels} models)`);

  const uncertainties = [
    ...result.disagreements.map((d) => `Disagreement: ${d.label}`),
    ...result.evidenceGaps.map((g) => `Evidence gap: ${g}`),
    ...result.openQuestions.map((q) => `Open question: ${q}`),
    ...result.panelBlindSpots.map((gap) => `Panel blind spot: ${gap.dimension}`),
  ];

  return {
    conclusion: result.executiveSummary,
    basis,
    assumptions: [],
    uncertainties,
    limitations: dedupeExact([...(meta.limitations ?? []), ...result.researchBoundaries]),
    // Phase 10D.1 — union of every finding's own recovered `sources` list.
    // See deepResearchAlignment.ts's per-finding `sources` computation.
    sources: dedupeExact(result.findings.flatMap((f) => f.sources)),
    sourceBacked: meta.sourceBacked ?? result.sourceCoverage.findingsWithSources > 0,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── evidence_review ────────────────────────────────────────────────────

function buildEvidenceReviewReceipt(result: EvidenceReviewResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const basis = [
    `Overall strength: ${result.overallStrength}`,
    ...result.dimensions.map((d) => `${d.dimension}: ${d.assessment} (${d.strength})`),
    ...result.strengths.map((s) => `Strength: ${s}`),
  ];

  const uncertainties = [...result.redFlags.map((f) => `Red flag: ${f}`), ...result.applicabilityCaveats];

  return {
    conclusion: result.overallAssessment,
    basis,
    assumptions: [],
    uncertainties,
    limitations: dedupeExact([...(meta.limitations ?? []), ...result.recommendedChecks.map((c) => `Recommended check: ${c}`)]),
    // Phase 10D.1 — recovered from the alignment module's own per-model
    // `fields.sources`. See evidenceReviewAlignment.ts's `sources` computation.
    sources: dedupeExact(result.sources),
    sourceBacked: meta.sourceBacked ?? result.sourceBacked,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── bias_blindspot_audit ───────────────────────────────────────────────

function buildBiasBlindspotAuditReceipt(result: BiasBlindspotAuditResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const basis = [
    // Tier 1 and Tier 2 are kept explicitly labeled, never blurred together
    // — each entry states which tier it came from.
    ...result.attributedBiases.map((b) => `Attributed bias: ${b.biasType} — ${b.description} (models: ${b.modelsImplicated.join(", ")})`),
    ...result.panelBlindSpots.map((gap) => `Panel omission: ${gap.missingDimension} (${gap.coverageReason})`),
  ];

  const uncertainties = [
    ...(result.attributedBiases.length === 0 && result.biasEmptyReason
      ? [`No model-specific bias was confidently attributable (${result.biasEmptyReason}) — this does not mean the answer is unbiased.`]
      : []),
    ...result.sharedAssumptions.map((a) => `Shared assumption: ${a}`),
    ...result.missingStakeholders.map((s) => `Missing stakeholder or perspective: ${s}`),
    ...result.structuralDiagnostics.geographicBiasConcerns.map((c) => `Geographic concern: ${c}`),
    ...result.structuralDiagnostics.sourceConcentrationConcerns.map((c) => `Source concentration concern: ${c}`),
    ...result.structuralDiagnostics.evidenceTypeConcerns.map((c) => `Evidence-type concern: ${c}`),
    ...(result.structuralDiagnostics.homogeneityFlag && result.structuralDiagnostics.homogeneityMessage
      ? [result.structuralDiagnostics.homogeneityMessage]
      : []),
    ...result.followUpQuestions.map((q) => `Suggested follow-up: ${q}`),
  ];

  return {
    conclusion: result.summary,
    basis,
    assumptions: [],
    uncertainties,
    limitations: dedupeExact(meta.limitations ?? []),
    // Phase 10D.1 — recovered from the alignment module's own per-model
    // `fields.sources`, independent of Tier 3's citation-COUNT diagnostics.
    // See biasBlindspotAlignment.ts's `sources` computation.
    sources: dedupeExact(result.sources),
    sourceBacked: meta.sourceBacked ?? result.structuralDiagnostics.citationCoverage.modelsWithSources > 0,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── decision_support ───────────────────────────────────────────────────

const DECISION_RECOMMENDATION_ACTION_LABEL: Record<DecisionRecommendationAction, string> = {
  go: "Go",
  conditional_go: "Conditional go",
  defer: "Defer",
  no_go: "No go",
  escalate: "Escalate",
  monitor: "Monitor",
  choose_option: "Choose option",
};

function buildDecisionSupportReceipt(result: DecisionSupportResult, meta: CommonResponseMeta): AdaptiveDecisionReceipt {
  const recommendedOption = result.recommendation.recommendedOptionId
    ? result.options.find((o) => o.id === result.recommendation.recommendedOptionId)
    : undefined;

  const actionLabel = DECISION_RECOMMENDATION_ACTION_LABEL[result.recommendation.action];
  // Never hides the action itself behind the rationale prose — escalation/
  // deferral/conditional-go must be legible in the conclusion, not implied.
  const conclusion = recommendedOption
    ? `${actionLabel}: ${recommendedOption.label} — ${result.recommendation.rationale}`
    : `${actionLabel} — ${result.recommendation.rationale}`;

  const basis = [
    ...result.criteria.map((c) => `Criterion: ${c.label}${c.source === "user" ? " (user-provided)" : ""}`),
    ...result.assessments.map((a) => {
      const option = result.options.find((o) => o.id === a.optionId);
      const criterion = result.criteria.find((c) => c.id === a.criterionId);
      return `${option?.label ?? a.optionId} × ${criterion?.label ?? a.criterionId}: ${a.assessment}`;
    }),
  ];

  const uncertainties = [
    ...result.uncertainties,
    ...result.sensitivityFindings.map((s) => `Sensitivity: ${s}`),
    // isContested is a real, structurally-detected split (never a vote
    // count) — see decisionSupportAlignment.ts. Surfaced here verbatim, not
    // re-derived.
    ...(result.recommendation.isContested ? ["The panel's own recommendations did not converge on this outcome."] : []),
  ];

  const limitations = dedupeExact([
    ...(meta.limitations ?? []),
    ...result.risks.map((r) => `Risk: ${r.label}${r.mitigation ? ` (mitigation: ${r.mitigation})` : ""}`),
    ...result.recommendation.caveats,
    ...(result.reversibleNextStep ? [`Reversible next step available: ${result.reversibleNextStep}`] : []),
  ]);

  return {
    conclusion,
    basis,
    assumptions: result.assumptions,
    uncertainties,
    limitations,
    // Phase 10D.1 — recovered from the alignment module's own per-model
    // `fields.sources`. See decisionSupportAlignment.ts's `sources` computation.
    sources: dedupeExact(result.sources),
    // meta.humanReviewNeeded, for this schema specifically, already reuses
    // result.humanReviewNeeded directly (see
    // commonResponseMeta.ts::getAdaptiveHumanReviewSignals) — using meta
    // here (not OR-ing with result.humanReviewNeeded again) avoids implying
    // two independent computations that happen to agree.
    sourceBacked: meta.sourceBacked ?? result.sourceBacked,
    humanReviewNeeded: meta.humanReviewNeeded,
  };
}

// ─── central dispatcher ─────────────────────────────────────────────────

function assertNeverSchemaId(schemaId: never): never {
  throw new DecisionReceiptBuildError(`Unhandled adaptive schemaId in decision receipt builder: ${JSON.stringify(schemaId)}`);
}

/**
 * The single public entry point. Dispatches by `adaptiveOutput.schemaId` —
 * the `switch`'s `default` branch is a compile-time exhaustiveness check
 * (via `assertNeverSchemaId`): adding a 10th variant to
 * `PersistedAdaptiveOutputV1` without a matching `case` here fails
 * `tsc --noEmit`, not just a runtime test.
 */
export function buildAdaptiveDecisionReceipt(adaptiveOutput: PersistedAdaptiveOutputV1): AdaptiveDecisionReceipt {
  const { schemaId, result, meta } = adaptiveOutput;

  switch (schemaId) {
    case "ranked_enumeration":
      return buildRankedEnumerationReceipt(result, meta);
    case "comparison_matrix":
      return buildComparisonMatrixReceipt(result, meta);
    case "definition_explanation":
      return buildDefinitionExplanationReceipt(result, meta);
    case "causal_explanation":
      return buildCausalExplanationReceipt(result, meta);
    case "checklist_taxonomy":
      return buildChecklistTaxonomyReceipt(result, meta);
    case "deep_research":
      return buildDeepResearchReceipt(result, meta);
    case "evidence_review":
      return buildEvidenceReviewReceipt(result, meta);
    case "bias_blindspot_audit":
      return buildBiasBlindspotAuditReceipt(result, meta);
    case "decision_support":
      return buildDecisionSupportReceipt(result, meta);
    default:
      return assertNeverSchemaId(schemaId);
  }
}
