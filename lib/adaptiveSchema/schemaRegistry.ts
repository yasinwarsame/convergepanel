/**
 * Adaptive Result Schema Registry
 *
 * Single source of truth for the 9 concrete ResultSchema instances. Each
 * schema declares exactly the sections a model must fill for a given
 * QueryType — no "(if applicable)" sections, no padding. If you need to
 * change a schema's fields or caps, update ONLY this file; the prompt
 * builder and renderers both read from here.
 */

import { FieldSpec, QueryType, ResultSchema } from "./types";

const CLAIM_INTERFACE_NOTE =
  "Generate a short kebab-case `id` slug from the claim's core concept (e.g. \"demand-pull-driver\") so claims can be aligned across models.";

const contestedEmpiricalFields: FieldSpec[] = [
  {
    key: "summary",
    type: "string",
    maxWords: 60,
    description: "High-level synthesis of the debate: what's being asked and why experts disagree.",
  },
  {
    key: "settledClaims",
    type: "claim[]",
    maxItems: 4,
    allowedConfidenceValues: ["settled", "majority_view"],
    description:
      `Claims that are well-established or hold majority expert support (confidence must be "settled" or "majority_view"). ${CLAIM_INTERFACE_NOTE}`,
  },
  {
    key: "disputedClaims",
    type: "claim[]",
    maxItems: 4,
    description:
      `Claims where reputable experts genuinely disagree. Each disputed claim MUST include \`camps\` describing the competing positions. ${CLAIM_INTERFACE_NOTE}`,
  },
  {
    key: "keyMetrics",
    type: "metric[]",
    maxItems: 4,
    description: "Concrete numbers relevant to the debate (rates, magnitudes, dates), with source and as-of date.",
  },
  {
    key: "openQuestions",
    type: "string[]",
    maxItems: 3,
    description: "Questions that remain unresolved even among informed experts.",
  },
];

const legalRegulatoryFields: FieldSpec[] = [
  {
    key: "applicableRule",
    type: "string",
    maxWords: 50,
    description: "The legal rule or standard that applies to the question, stated plainly.",
  },
  {
    key: "jurisdiction",
    type: "string",
    description: "The jurisdiction(s) this rule applies in (e.g. \"US federal\", \"California\", \"EU\").",
  },
  {
    key: "elements",
    type: "string[]",
    maxItems: 6,
    description: "The legal test broken into its individual elements a claimant/defendant must satisfy.",
  },
  {
    key: "keyAuthority",
    type: "string[]",
    maxItems: 3,
    description: "The controlling cases or statutes this rule derives from.",
  },
  {
    key: "exceptions",
    type: "string[]",
    maxItems: 3,
    description: "Recognized exceptions or defenses to the general rule.",
  },
  {
    key: "unsettledIssues",
    type: "claim[]",
    maxItems: 2,
    description:
      `Points of unsettled law. In this schema, confidence "settled" means black-letter law, "majority_view" means the majority rule among jurisdictions, and "contested" means a circuit split or jurisdictional divergence. ${CLAIM_INTERFACE_NOTE}`,
  },
  {
    key: "attorneyQuestions",
    type: "string[]",
    maxItems: 3,
    description: "Frame these as questions to raise with a licensed attorney — never as a recommendation or advice.",
  },
];

const financialValuationFields: FieldSpec[] = [
  {
    key: "thesis",
    type: "string",
    maxWords: 40,
    description: "The core investment thesis or valuation takeaway in one tight paragraph.",
  },
  {
    key: "metrics",
    type: "metric[]",
    maxItems: 8,
    description:
      "The quantitative centerpiece of this schema — valuation multiples, growth rates, margins, price targets, etc. Include unit, source, and as-of date for each.",
  },
  {
    key: "bullCase",
    type: "string",
    maxWords: 50,
    description: "The strongest case for a positive outcome.",
  },
  {
    key: "bearCase",
    type: "string",
    maxWords: 50,
    description: "The strongest case for a negative outcome.",
  },
  {
    key: "keyAssumptions",
    type: "string[]",
    maxItems: 4,
    description: "Assumptions underlying the thesis and metrics (growth rates, multiples, macro conditions).",
  },
  {
    key: "riskFactors",
    type: "string[]",
    maxItems: 3,
    description: "Concrete risks that could invalidate the thesis.",
  },
];

const factualLookupFields: FieldSpec[] = [
  {
    key: "answer",
    type: "string",
    description: "The single verifiable answer to the question. No hedging, no essay — just the answer.",
  },
  {
    key: "source",
    type: "string",
    description: "What kind of source this answer draws on (e.g. \"official record\", \"widely cited reference\", \"general knowledge\").",
  },
  {
    key: "caveat",
    type: "string",
    maxWords: 25,
    description: "Any important caveat, ambiguity, or edge case affecting the answer. Use \"none\" if there isn't one.",
  },
];

const proceduralFields: FieldSpec[] = [
  {
    key: "goal",
    type: "string",
    maxWords: 25,
    description: "What the user will have accomplished after following these steps.",
  },
  {
    key: "prerequisites",
    type: "string[]",
    maxItems: 4,
    description: "Things the user needs before starting (accounts, tools, information).",
  },
  {
    key: "steps",
    type: "step[]",
    maxItems: 10,
    description: "The ordered sequence of actions. Each step is one short action, in order.",
  },
  {
    key: "commonFailures",
    type: "string[]",
    maxItems: 3,
    description: "Common mistakes or failure points people hit when following this process.",
  },
];

const medicalHealthFields: FieldSpec[] = [
  {
    key: "summary",
    type: "string",
    maxWords: 60,
    description: "High-level answer to the health question, written for a layperson.",
  },
  {
    key: "mechanism",
    type: "string",
    maxWords: 60,
    description: "The biological or clinical mechanism behind the answer.",
  },
  {
    key: "evidenceByTier",
    type: "claim[]",
    maxItems: 5,
    description:
      `Claims ordered strongest evidence first: RCT/meta-analysis > observational > anecdotal. \`evidenceType\` is required on every claim. ${CLAIM_INTERFACE_NOTE}`,
  },
  {
    key: "guidelinePositions",
    type: "string[]",
    maxItems: 3,
    description: "Positions taken by major clinical guidelines or health authorities.",
  },
  {
    key: "redFlags",
    type: "string[]",
    maxItems: 3,
    description: "Symptoms or situations that warrant urgent in-person medical attention.",
  },
  {
    key: "clinicianQuestions",
    type: "string[]",
    maxItems: 3,
    description: "Questions to raise with a licensed clinician — never presented as medical advice.",
  },
];

const forecastSpeculativeFields: FieldSpec[] = [
  {
    key: "scenarios",
    type: "scenario[]",
    minItems: 2,
    maxItems: 4,
    description:
      "Probability-weighted future scenarios. Probabilities across all scenarios in this response must sum to approximately 1.",
  },
  {
    key: "baseRates",
    type: "string[]",
    maxItems: 3,
    description: "Historical base rates or reference-class outcomes relevant to this forecast.",
  },
  {
    key: "keyUncertainties",
    type: "string[]",
    maxItems: 3,
    description: "The biggest unknowns that could swing which scenario plays out.",
  },
];

const creativeGenerativeFields: FieldSpec[] = [
  {
    key: "output",
    type: "string",
    description: "The generated content itself, in full.",
  },
  {
    key: "styleNotes",
    type: "string[]",
    maxItems: 3,
    description: "Brief notes on the stylistic or creative choices made.",
  },
];

const genericFields: FieldSpec[] = [
  {
    key: "summary",
    type: "string",
    maxWords: 80,
    description: "High-level answer to the question.",
  },
  {
    key: "keyClaims",
    type: "claim[]",
    maxItems: 6,
    description: `The most important claims a careful reader should know. ${CLAIM_INTERFACE_NOTE}`,
  },
  {
    key: "uncertainties",
    type: "string[]",
    maxItems: 3,
    description: "What's uncertain, unresolved, or under-explored about this answer.",
  },
  {
    key: "followUps",
    type: "string[]",
    maxItems: 3,
    description: "Concrete follow-up questions the user could ask next.",
  },
];

export const SCHEMA_REGISTRY: Record<QueryType, ResultSchema> = {
  contested_empirical: {
    id: "contested_empirical",
    headlineField: "disputedClaims",
    renderHint: "consensus_map",
    fields: contestedEmpiricalFields,
  },
  legal_regulatory: {
    id: "legal_regulatory",
    headlineField: "applicableRule",
    renderHint: "rule_application",
    fields: legalRegulatoryFields,
  },
  financial_valuation: {
    id: "financial_valuation",
    headlineField: "metrics",
    renderHint: "metrics_grid",
    fields: financialValuationFields,
  },
  factual_lookup: {
    id: "factual_lookup",
    headlineField: "answer",
    renderHint: "verdict_card",
    fields: factualLookupFields,
  },
  procedural: {
    id: "procedural",
    headlineField: "steps",
    renderHint: "step_diff",
    fields: proceduralFields,
  },
  medical_health: {
    id: "medical_health",
    headlineField: "summary",
    renderHint: "evidence_tiers",
    fields: medicalHealthFields,
  },
  forecast_speculative: {
    id: "forecast_speculative",
    headlineField: "scenarios",
    renderHint: "scenario_tree",
    fields: forecastSpeculativeFields,
  },
  creative_generative: {
    id: "creative_generative",
    headlineField: "output",
    renderHint: "gallery",
    fields: creativeGenerativeFields,
  },
  generic: {
    id: "generic",
    headlineField: "summary",
    renderHint: "generic_sections",
    fields: genericFields,
  },
};

export function getResultSchema(queryType: QueryType): ResultSchema {
  return SCHEMA_REGISTRY[queryType] || SCHEMA_REGISTRY.generic;
}
