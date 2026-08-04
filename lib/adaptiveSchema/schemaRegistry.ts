/**
 * Adaptive Result Schema Registry
 *
 * Single source of truth for every ResultSchema instance. Each schema
 * declares exactly the sections a model must fill for a given QueryType —
 * no "(if applicable)" sections, no padding. If you need to change a
 * schema's fields or caps, update ONLY this file; the prompt builder and
 * renderers both read from here.
 *
 * Query-routing redesign, Milestone 1: every entry now also declares
 * `implementationStatus`. routeClassifiedQuery.ts is the ONLY place that
 * reads it to make a routing decision — a schema whose prompt/parser/
 * verification/renderer isn't fully built is registered here (so the
 * taxonomy is documented and type-checked) but marked "disabled" or
 * "handoff", never "active", until a later milestone actually builds it out.
 * Adding a registry entry does NOT make a schema live — only flipping
 * implementationStatus to "active" does.
 *
 * The 9 pre-existing entries (contested_empirical through generic) are
 * unchanged in substance — same fields, same prompts, same behavior — with
 * one deliberate exception: factual_lookup's `renderHint` moved from
 * "verdict_card" to "direct_answer" so it renders through the lightweight
 * DirectAnswerCard instead of the full synthesis-report shell. Its fields,
 * prompt content, parser, and alignment/verification logic are untouched.
 */

import { FieldSpec, QueryType, ResultSchema, HandoffTarget } from "./types";

/** Standard fallback for every active, pre-existing schema — matches the classifier's own long-standing low-confidence/error fallback (classifier.ts's genericFallback), not a new behavior. */
const LEGACY_FALLBACK: QueryType = "generic";

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

/** graceful_limitation (query-routing redesign, Milestone 1) — the one new schema built out fully, since it's the universal safety net every disabled/handoff entry routes to. */
const gracefulLimitationFields: FieldSpec[] = [
  {
    key: "limitation",
    type: "string",
    maxWords: 40,
    description: "Plainly state what can't be done and why, in one or two sentences. Never fabricate an answer to fill the gap.",
  },
  {
    key: "whyItMatters",
    type: "string",
    maxWords: 40,
    description: "Why this limitation exists — missing data source, undefined scope, missing prerequisite, impossible certainty, etc.",
  },
  {
    key: "nearestValidAlternative",
    type: "string",
    maxWords: 30,
    description: "The closest thing that CAN be answered right now, if anything. Use \"none\" if there isn't one.",
  },
  {
    key: "clarifyingQuestion",
    type: "string",
    maxWords: 25,
    description: "One focused question that would let this be answered, if applicable. Use \"none\" if not applicable.",
  },
];

/** ranked_enumeration (query-routing redesign, Milestone 2 — first activated schema). Aggregation/alignment lives in enumAlignment.ts (a parallel path, not funneled through AlignedClaim — see that file's header comment for why). */
const rankedEnumerationFields: FieldSpec[] = [
  {
    key: "items",
    type: "enumItem[]",
    maxItems: 50,
    description:
      "Ranked list items answering the user's question, ordered by rank (1 = most important/relevant/common). Each item must be a genuinely distinct thing — never list near-duplicates to pad the count.",
  },
];

/** comparison_matrix (query-routing redesign, Milestone 2 — second activated schema). Aggregation lives in comparisonAlignment.ts (a parallel path, not funneled through AlignedClaim — see that file's header comment for why). */
const comparisonMatrixFields: FieldSpec[] = [
  {
    key: "cells",
    type: "comparisonCell[]",
    maxItems: 60,
    description:
      "Every (subject, attribute) comparison point you can responsibly assess. Reuse the exact same subject name across all its cells, and the exact same attribute name across all its cells, so your response stays internally consistent.",
  },
];

/**
 * definition_explanation (query-routing redesign, Milestone 2 — third
 * activated schema). Richer/more heterogeneous than ranked_enumeration's or
 * comparison_matrix's single repeated field: 13 distinct top-level keys, per
 * definitionAlignment.ts's aggregation into interpretation clusters (a
 * parallel path, not funneled through AlignedClaim — see that file's header
 * comment for why). `analogy` is two flat fields here (analogyText/
 * analogyLimits) and recomposed into a nested object at the aggregation
 * layer — see DefinitionExplanationResult's doc comment in types.ts.
 */
const definitionExplanationFields: FieldSpec[] = [
  {
    key: "term",
    type: "string",
    description:
      "The primary term or concept being explained, in plain form (e.g. \"CAGR\", \"public-key encryption\"). Use \"none\" only if the question has no single defined term.",
  },
  {
    key: "directAnswer",
    type: "string",
    maxWords: 40,
    description:
      "Answer-first: what the term/concept/mechanism/role fundamentally IS or DOES, in one or two sentences, before any elaboration.",
  },
  {
    key: "explanation",
    type: "string",
    maxWords: 120,
    description:
      "The fuller explanation at the depth the question calls for — beginner-friendly if it asks to explain simply or like a beginner, technical/precise if it asks for expert or mathematical treatment, otherwise a clear general-audience explanation. Do not put exhaustive technical depth here — use advancedDetail for that.",
  },
  {
    key: "keyPoints",
    type: "string[]",
    maxItems: 5,
    description: "The most important supporting points a careful reader should retain. Empty array if directAnswer/explanation already cover everything that matters.",
  },
  {
    key: "example",
    type: "string",
    maxWords: 40,
    description: "A concrete illustrative example of the concept in action. Use \"none\" if no example adds value.",
  },
  {
    key: "analogyText",
    type: "string",
    maxWords: 40,
    description:
      "An analogy that makes the concept easier to grasp, ONLY if the question asks for one (e.g. \"using a banking analogy\") or a plain analogy would clearly help a beginner. Use \"none\" otherwise — never force an analogy onto an expert-level question.",
  },
  {
    key: "analogyLimits",
    type: "string",
    maxWords: 25,
    description: "Where the analogy above breaks down or oversimplifies. Use \"none\" if analogyText is \"none\", or if the analogy has no notable limitation worth mentioning.",
  },
  {
    key: "distinctions",
    type: "distinction[]",
    maxItems: 4,
    description:
      "Other concepts the user might confuse this with, each with a short explanation of how they differ (e.g. accuracy vs precision). Empty array if the question doesn't call for distinguishing this term from anything else.",
  },
  {
    key: "processSteps",
    type: "processStep[]",
    maxItems: 8,
    description:
      "If the question asks how a mechanism or process works, the ordered stages of that mechanism, explained (NOT imperative user instructions — that's procedural/step_by_step_plan's job, not this schema's). Empty array if the question isn't about a mechanism/process.",
  },
  {
    key: "advancedDetail",
    type: "string",
    maxWords: 100,
    description:
      "Deeper, expert-level technical detail beyond the main explanation — mathematical formalism, edge cases, implementation nuance. Only fill this in when the question explicitly asks for expert/technical/mathematical depth, or a genuinely useful deeper layer exists worth collapsing behind an \"advanced\" toggle. Use \"none\" otherwise — never pad this just to fill the field.",
  },
  {
    key: "commonMisconceptions",
    type: "string[]",
    maxItems: 3,
    description: "Widely-believed but inaccurate claims about this term/concept worth correcting. Empty array if none are common or the question isn't myth-clarification-shaped.",
  },
  {
    key: "relatedConcepts",
    type: "string[]",
    maxItems: 5,
    description: "Other terms/concepts worth exploring next, closely related to this one. Empty array if none are especially relevant.",
  },
  {
    key: "sources",
    type: "string[]",
    maxItems: 5,
    description:
      "Plain labels for authoritative sources backing a factual or technical definition (e.g. \"NIST glossary\", \"peer-reviewed source\"), when this is the kind of claim that benefits from citation. Empty array for general/common knowledge.",
  },
];

/**
 * causal_explanation (query-routing redesign, Milestone 2 — fourth
 * activated schema). Every field is a flat "string" or "string[]" —
 * deliberately no nested per-item objects (no per-factor evidenceStrength/
 * sources at the wire layer), per the approved design: prefer flat
 * primitives over invasive validator changes. The richer, tagged/clustered
 * structure (AggregatedCausalFactor's category/evidenceStrength/
 * sourceBacked, etc.) is built entirely at the aggregation layer — see
 * causalAlignment.ts.
 */
const causalExplanationFields: FieldSpec[] = [
  {
    key: "directAnswer",
    type: "string",
    maxWords: 50,
    description: "The direct answer to the causal question: what causes/explains the outcome, stated plainly before elaboration.",
  },
  {
    key: "directCauses",
    type: "string[]",
    maxItems: 5,
    description: "The most direct, well-supported cause(s) of the outcome — not just factors correlated with it.",
  },
  {
    key: "contributingFactors",
    type: "string[]",
    maxItems: 5,
    description: "Additional factors that contribute to or influence the outcome without being the primary direct cause.",
  },
  {
    key: "triggers",
    type: "string[]",
    maxItems: 3,
    description: "Specific events or conditions that set the causal process in motion, distinct from the underlying direct causes. Empty array if not applicable.",
  },
  {
    key: "amplifiers",
    type: "string[]",
    maxItems: 3,
    description: "Factors that make an existing cause's effect stronger or faster, without independently causing the outcome. Empty array if not applicable.",
  },
  {
    key: "alternativeExplanations",
    type: "string[]",
    maxItems: 3,
    description: "Credible alternative explanations for the outcome that compete with the main causal account above. Empty array if none are credible.",
  },
  {
    key: "causalLinks",
    type: "string[]",
    maxItems: 5,
    description:
      "The MECHANISM connecting cause to effect, one sentence each (e.g. \"Higher interest rates raise borrowing costs, which reduces mortgage demand and cools home prices.\"). Explain the mechanism, not just assert correlation.",
  },
  {
    key: "confounders",
    type: "string[]",
    maxItems: 3,
    description: "Plausible confounding variables that could explain the association without the proposed cause being the true driver. Empty array if none are plausible.",
  },
  {
    key: "disputedInterpretations",
    type: "string[]",
    maxItems: 3,
    description: "Causal interpretations where genuine expert disagreement exists — state the interpretation itself, not just that disagreement exists. Empty array if the causal picture is settled.",
  },
  {
    key: "unknowns",
    type: "string[]",
    maxItems: 3,
    description: "What remains genuinely unknown or unresolved about the causal picture. Empty array if nothing notable is unresolved.",
  },
  {
    key: "testsOrEvidenceNeeded",
    type: "string[]",
    maxItems: 3,
    description: "What evidence, data, or test would be needed to more confidently establish or rule out this causal account. Empty array if the causal account is already well-established.",
  },
  {
    key: "sources",
    type: "string[]",
    maxItems: 5,
    description: "Plain labels for authoritative sources backing this causal account, when applicable. Empty array for general/theoretical reasoning.",
  },
];

/**
 * checklist_taxonomy (query-routing redesign, Milestone 2 — fifth activated
 * schema). Unifies a plain checklist and a categorized taxonomy behind one
 * item shape (see ChecklistItem's doc comment in types.ts) — the
 * aggregation layer (checklistAlignment.ts) decides whether the panel's
 * output renders as a flat list or grouped sections, never the prompt.
 */
const checklistTaxonomyFields: FieldSpec[] = [
  {
    key: "summary",
    type: "string",
    maxWords: 40,
    description: "One or two sentences framing what this checklist/taxonomy covers and who it's for.",
  },
  {
    key: "items",
    type: "checklistItem[]",
    maxItems: 30,
    description:
      "The checklist items or taxonomy entries. Order does not matter — do not imply a ranking. If the question asks for a categorized taxonomy (types/kinds of something), group items under a `category`; for a plain checklist with no natural categories, omit `category` (or use \"none\") on every item.",
  },
  {
    key: "notes",
    type: "string[]",
    maxItems: 3,
    description: "Important caveats — e.g. this list isn't exhaustive, jurisdiction/context dependence, or when to consult a professional. Empty array if none apply.",
  },
];

/**
 * deep_research (query-routing redesign, Milestone 2 — sixth activated
 * schema). Broad research synthesis across multiple dimensions/sources —
 * NOT a replacement for contested_empirical (kept active and unchanged;
 * routes when disagreement itself IS the answer) or generic. `findings`
 * uses a dedicated flat array type rather than the existing `claim[]` —
 * Claim's stance/confidence vocabulary (asserts/disputes/settled/contested)
 * is built for a debate's claims, not a research finding's own
 * category/evidenceStrength shape.
 */
const deepResearchFields: FieldSpec[] = [
  {
    key: "executiveSummary",
    type: "string",
    maxWords: 80,
    description: "A concise executive summary of the research landscape — the major dimensions of the question and the headline takeaway.",
  },
  {
    key: "findings",
    type: "researchFinding[]",
    maxItems: 10,
    description:
      "The major research findings, each a distinct, well-formed idea — never a vague catch-all. Distinguish primary evidence, reviews, commentary, and speculation where relevant, and separate established findings from disputed ones (put genuine disagreement in `disagreements` instead).",
  },
  {
    key: "disagreements",
    type: "string[]",
    maxItems: 5,
    description: "Where the evidence or expert opinion genuinely disagrees, one sentence each stating the disagreement itself (not just that disagreement exists). Empty array if the research is largely settled.",
  },
  {
    key: "evidenceGaps",
    type: "string[]",
    maxItems: 5,
    description: "Major gaps in the evidence base — what's under-studied, methodologically weak, or simply missing. Empty array if the evidence base is thorough.",
  },
  {
    key: "openQuestions",
    type: "string[]",
    maxItems: 5,
    description: "Genuinely open questions this research area hasn't resolved. Empty array if none remain.",
  },
  {
    key: "researchBoundaries",
    type: "string[]",
    maxItems: 3,
    description:
      "State plainly what this review does NOT cover and any scope limits — never imply the review is exhaustive. If the user asked to use only specific sources and you cannot verify you're restricted to exactly those sources, say so here explicitly rather than silently supplementing with your own training knowledge.",
  },
  {
    key: "recommendedNextSteps",
    type: "string[]",
    maxItems: 3,
    description: "High-value follow-up questions or research directions the user could pursue next. Empty array if none are especially valuable.",
  },
  {
    key: "sources",
    type: "string[]",
    maxItems: 8,
    description: "Plain labels for authoritative sources/studies backing this synthesis. Empty array for general/theoretical reasoning.",
  },
];

/**
 * evidence_review (query-routing redesign, Milestone 2 — seventh activated
 * schema). Evaluates how strong/credible/reliable a body of evidence, a
 * study, a source, or a methodology is — NOT a substitute for deep_research
 * (which synthesizes substantive findings across a topic) or
 * causal_explanation (which explains why something happens). `dimensions`
 * uses a dedicated flat array type, close in shape to deep_research's
 * `researchFinding[]`, since each quality dimension (methodology, sample
 * size, conflicts of interest, replication, etc.) is its own
 * assessable unit with its own honest strength read.
 */
const evidenceReviewFields: FieldSpec[] = [
  {
    key: "overallAssessment",
    type: "string",
    maxWords: 60,
    description: "A direct, plain-language verdict on how strong/credible/reliable this evidence is overall, stated before any detail.",
  },
  {
    key: "dimensions",
    type: "evidenceDimension[]",
    maxItems: 8,
    description:
      "The specific quality dimensions worth assessing for this evidence (e.g. methodology, sample size, conflicts of interest, replication status, source credibility, generalizability) — each with your own honest strength read. Only include dimensions actually relevant to this evidence.",
  },
  {
    key: "redFlags",
    type: "string[]",
    maxItems: 5,
    description: "Concrete methodological or credibility red flags (e.g. no control group, undisclosed funding, small sample, cherry-picked data, not peer-reviewed). Empty array if none are present.",
  },
  {
    key: "strengths",
    type: "string[]",
    maxItems: 5,
    description: "Concrete positive credibility signals (e.g. peer-reviewed, pre-registered, large sample, independently replicated, transparent methodology). Empty array if none stand out.",
  },
  {
    key: "applicabilityCaveats",
    type: "string[]",
    maxItems: 3,
    description: "Where this evidence may not generalize — population, context, time period, or scope limits. Empty array if broadly applicable.",
  },
  {
    key: "recommendedChecks",
    type: "string[]",
    maxItems: 3,
    description: "What a careful reader should verify before trusting this evidence. Empty array if nothing further is needed.",
  },
  {
    key: "sources",
    type: "string[]",
    maxItems: 5,
    description: "Plain labels for the sources/studies being evaluated or cited in this review. Empty array if none are named.",
  },
];

/**
 * bias_blindspot_audit (query-routing redesign, Milestone 2 — eighth
 * activated schema). Every field is a flat "string" or "string[]" — no new
 * FieldType needed at all, the simplest wire schema of any Milestone 2
 * activation. Tier 1 (attributed bias) never reads these fields — it's
 * produced entirely by reusing the embedded system's own
 * `detectAdaptiveBiases` call on raw model responses, which already
 * enforces excerpt-evidence requirements a flat self-report field could
 * never meet. See biasBlindspotAlignment.ts for how these fields feed
 * Tier 2/Tier 3 instead.
 */
const biasBlindspotAuditFields: FieldSpec[] = [
  {
    key: "summary",
    type: "string",
    maxWords: 60,
    description: "A concise, plain-language summary of what this bias/blind-spot audit found overall.",
  },
  {
    key: "omittedDimensions",
    type: "string[]",
    maxItems: 5,
    description: "Specific dimensions you believe the panel's overall coverage is missing — concrete and relevant to the user's question, never a vague \"more context needed\" statement. Empty array if coverage looks complete.",
  },
  {
    key: "sharedAssumptions",
    type: "string[]",
    maxItems: 5,
    description: "Assumptions you believe are shared across the panel's responses (not just your own). Empty array if none are apparent.",
  },
  {
    key: "missingStakeholders",
    type: "string[]",
    maxItems: 5,
    description: "Stakeholders or perspectives the analysis overlooks, named specifically. Empty array if coverage looks complete.",
  },
  {
    key: "geographicBiases",
    type: "string[]",
    maxItems: 3,
    description: "Geographic, cultural, or institutional framing concerns — distinct from source/evidence concentration. Empty array if none apply.",
  },
  {
    key: "sourceConcentrationConcerns",
    type: "string[]",
    maxItems: 3,
    description: "Concerns that sources or evidence are too institutionally/methodologically similar — distinct from geographic concerns. Empty array if sourcing looks diverse.",
  },
  {
    key: "evidenceTypeConcerns",
    type: "string[]",
    maxItems: 3,
    description: "Concerns that the evidence base leans too heavily on one type (e.g. too theoretical, too anecdotal). Empty array if the evidence mix looks reasonable.",
  },
  {
    key: "followUpQuestions",
    type: "string[]",
    maxItems: 3,
    description: "Precise follow-up questions that would help close a gap or test an assumption identified above. Empty array if none are especially valuable.",
  },
  {
    key: "sources",
    type: "string[]",
    maxItems: 5,
    description: "Plain labels for sources cited in your own response, if any — used only to compute source-diversity diagnostics. Empty array if none.",
  },
];

/**
 * decision_support (query-routing redesign, Milestone 2 — ninth activated
 * schema). Helps the user choose/prioritize/approve/defer/escalate among
 * concrete options under uncertainty. Wire-layer fields are flat wherever
 * possible per the approved design; `assessments`/`risks` are the two fields
 * that genuinely need per-item structure (an option×criterion cross-
 * reference, and a risk's own likelihood/impact/mitigation) and get their
 * own dedicated shallow array types rather than deeply nested JSON.
 * `userProvidedCriteria` exists purely so decisionSupportAlignment.ts can
 * mark each aggregated criterion's provenance without inventing a third
 * "inferred" bucket a flat self-report can't reliably distinguish. No
 * numeric weight/score field anywhere — see types.ts's header comment on
 * DecisionSupportResult for why.
 */
const decisionSupportFields: FieldSpec[] = [
  {
    key: "decisionQuestion",
    type: "string",
    maxWords: 30,
    description: "The actual decision being made, stated plainly and neutrally — not the raw user question verbatim if it needs sharpening into a clear decision framing.",
  },
  {
    key: "options",
    type: "string[]",
    maxItems: 8,
    description: "The real, concrete options being decided among. Do not invent options the question doesn't support — if there are genuinely only two, list two.",
  },
  {
    key: "criteria",
    type: "string[]",
    maxItems: 8,
    description: "The decision criteria being weighed (e.g. \"Total cost\", \"Ease of integration\", \"Regulatory risk\"). Include both criteria the user explicitly stated and criteria you believe are genuinely relevant — mark the user-stated ones in `userProvidedCriteria` below.",
  },
  {
    key: "userProvidedCriteria",
    type: "string[]",
    maxItems: 8,
    description: "The subset of `criteria` above that came directly from the user's own question or stated constraints (not ones you inferred or added). Use the exact same strings as in `criteria`. Empty array if the user stated no explicit criteria.",
  },
  {
    key: "assessments",
    type: "decisionAssessment[]",
    maxItems: 40,
    description: "Your assessment of each option against each relevant criterion. Reuse the exact same strings from `options`/`criteria` for optionLabel/criterionLabel. Leave a combination out entirely rather than guessing — never fabricate an assessment for a combination you can't responsibly evaluate.",
  },
  {
    key: "recommendationAction",
    type: "string",
    description:
      "Your recommended action — use EXACTLY one of these values, exact casing: \"go\" | \"conditional_go\" | \"defer\" | \"no_go\" | \"escalate\" | \"monitor\" | \"choose_option\". Use \"choose_option\" when the decision is genuinely about picking among options rather than a go/no-go call; use \"defer\"/\"escalate\" when the decision cannot be responsibly made yet.",
  },
  {
    key: "recommendedOption",
    type: "string",
    description: "When recommendationAction is \"choose_option\", the exact string from `options` you recommend. Use \"none\" for every other action, or if you cannot responsibly recommend a single option.",
  },
  {
    key: "recommendationRationale",
    type: "string",
    maxWords: 80,
    description: "Why you reached this recommendation — reference the criteria and evidence that actually drove it, not just an assertion.",
  },
  {
    key: "recommendationCaveats",
    type: "string[]",
    maxItems: 4,
    description: "Conditions, exceptions, or caveats that qualify your recommendation. Empty array if your recommendation is unconditional.",
  },
  {
    key: "assumptions",
    type: "string[]",
    maxItems: 5,
    description: "Assumptions your recommendation depends on that the user has not confirmed. Empty array if you made none.",
  },
  {
    key: "uncertainties",
    type: "string[]",
    maxItems: 5,
    description: "Genuinely missing information that could change this recommendation if known (budget, timeline, jurisdiction, risk tolerance, etc.). Empty array if the decision is fully specified.",
  },
  {
    key: "risks",
    type: "decisionRisk[]",
    maxItems: 8,
    description: "Concrete risks and tradeoffs relevant to this decision, whether tied to one specific option (set optionLabel, matching an `options` entry) or broad across all options (omit optionLabel).",
  },
  {
    key: "sensitivityFindings",
    type: "string[]",
    maxItems: 4,
    description: "How the recommendation would change under different priorities, weights, or scenarios — e.g. \"If cost is the top priority, Option B wins instead.\" Empty array if the recommendation is robust to reasonable variation.",
  },
  {
    key: "reversibleNextStep",
    type: "string",
    maxWords: 30,
    description: "The lowest-regret, most reversible next action available right now, if one exists — prefer this over a large irreversible commitment when uncertainty is high. Use \"none\" if not applicable.",
  },
  {
    key: "sources",
    type: "string[]",
    maxItems: 5,
    description: "Plain labels for sources backing your assessments, if any. Empty array for general reasoning.",
  },
];

/** Disabled and handoff entries have no schema body — no fields to fill, since routeClassifiedQuery.ts guarantees they never reach a per-model prompt. */
const NO_FIELDS: FieldSpec[] = [];

function disabledEntry(id: QueryType, capabilityReason: string): ResultSchema {
  return {
    id,
    headlineField: "",
    renderHint: "limitation_notice",
    fields: NO_FIELDS,
    implementationStatus: "disabled",
    capabilityReason,
    fallbackQueryType: "graceful_limitation",
  };
}

function handoffEntry(id: QueryType, handoffTarget: HandoffTarget): ResultSchema {
  return {
    id,
    headlineField: "",
    renderHint: "limitation_notice",
    fields: NO_FIELDS,
    implementationStatus: "handoff",
    handoffTarget,
    fallbackQueryType: "graceful_limitation",
  };
}

const NOT_YET_IMPLEMENTED_REASON =
  "This request type hasn't been built yet — its prompt, parser, verification, and renderer don't exist. Showing an unfinished answer shape would be worse than saying so plainly.";

export const SCHEMA_REGISTRY: Record<QueryType, ResultSchema> = {
  // ── Active: existing production schemas, unchanged in substance ──
  contested_empirical: {
    id: "contested_empirical",
    headlineField: "disputedClaims",
    renderHint: "consensus_map",
    fields: contestedEmpiricalFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  legal_regulatory: {
    id: "legal_regulatory",
    headlineField: "applicableRule",
    renderHint: "rule_application",
    fields: legalRegulatoryFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  financial_valuation: {
    id: "financial_valuation",
    headlineField: "metrics",
    renderHint: "metrics_grid",
    fields: financialValuationFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  factual_lookup: {
    id: "factual_lookup",
    headlineField: "answer",
    // The one deliberate behavioral change in this registry (approved,
    // Milestone 1): render through DirectAnswerCard, not the full
    // synthesis-report shell. Fields/prompt/parser/alignment below are
    // untouched — same as every other line in this entry.
    renderHint: "direct_answer",
    fields: factualLookupFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  procedural: {
    id: "procedural",
    headlineField: "steps",
    renderHint: "step_diff",
    fields: proceduralFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  medical_health: {
    id: "medical_health",
    headlineField: "summary",
    renderHint: "evidence_tiers",
    fields: medicalHealthFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  forecast_speculative: {
    id: "forecast_speculative",
    headlineField: "scenarios",
    renderHint: "scenario_tree",
    fields: forecastSpeculativeFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  creative_generative: {
    id: "creative_generative",
    headlineField: "output",
    renderHint: "gallery",
    fields: creativeGenerativeFields,
    implementationStatus: "active",
    fallbackQueryType: LEGACY_FALLBACK,
  },
  generic: {
    id: "generic",
    headlineField: "summary",
    renderHint: "generic_sections",
    fields: genericFields,
    implementationStatus: "active",
    fallbackQueryType: "graceful_limitation",
  },

  // ── Active: new, Milestone 1 ──
  graceful_limitation: {
    id: "graceful_limitation",
    headlineField: "limitation",
    renderHint: "limitation_notice",
    fields: gracefulLimitationFields,
    implementationStatus: "active",
    fallbackQueryType: "graceful_limitation",
  },

  // ── Active: new, Milestone 2 — first schema activated behind the
  // query-routing redesign's full stack (prompt/parser/validation/
  // alignment/verification/renderer/analytics/acceptance tests). ──
  ranked_enumeration: {
    id: "ranked_enumeration",
    headlineField: "items",
    renderHint: "ranked_list",
    fields: rankedEnumerationFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },

  // ── Active: new, Milestone 2 — second schema activated, same standard
  // (full prompt/parser/validation/alignment/verification/renderer/
  // analytics/acceptance-tests stack required before flipping status). ──
  comparison_matrix: {
    id: "comparison_matrix",
    headlineField: "cells",
    renderHint: "comparison_grid",
    fields: comparisonMatrixFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  definition_explanation: {
    id: "definition_explanation",
    headlineField: "directAnswer",
    renderHint: "definition_card",
    fields: definitionExplanationFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  causal_explanation: {
    id: "causal_explanation",
    headlineField: "directCauses",
    renderHint: "causal_map",
    fields: causalExplanationFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  checklist_taxonomy: {
    id: "checklist_taxonomy",
    headlineField: "items",
    renderHint: "checklist_taxonomy_view",
    fields: checklistTaxonomyFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  deep_research: {
    id: "deep_research",
    headlineField: "findings",
    renderHint: "deep_research_view",
    fields: deepResearchFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  evidence_review: {
    id: "evidence_review",
    headlineField: "overallAssessment",
    renderHint: "evidence_review_view",
    fields: evidenceReviewFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  bias_blindspot_audit: {
    id: "bias_blindspot_audit",
    headlineField: "summary",
    renderHint: "bias_blindspot_audit_view",
    fields: biasBlindspotAuditFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },
  decision_support: {
    id: "decision_support",
    headlineField: "recommendationRationale",
    renderHint: "decision_support_view",
    fields: decisionSupportFields,
    implementationStatus: "active",
    fallbackQueryType: "generic",
  },

  // ── Handoff: no schema body — see handoffEntry() ──
  claim_verification: handoffEntry("claim_verification", "claim_verification"),
  media_authenticity_review: handoffEntry("media_authenticity_review", "video_verification"),

  // ── Disabled: missing capability (see docs/technical-documentation.md's
  // "Query Routing" section for the underlying infrastructure audit) ──
  document_qa: disabledEntry(
    "document_qa",
    "Document Q&A isn't available yet — exact page and section references can't be preserved across documents, so answers couldn't honestly cite their source location."
  ),
  document_comparison: disabledEntry(
    "document_comparison",
    "Document comparison isn't available yet — there's no way to align sections across multiple documents or preserve page/clause references for the differences found."
  ),
  data_analysis: disabledEntry(
    "data_analysis",
    "Data analysis isn't available yet — there's no dataset upload path and no sandboxed computation, so results couldn't be presented as genuine deterministic analysis."
  ),
  current_live_information: disabledEntry(
    "current_live_information",
    "Live information isn't available yet — no connector currently returns verified live data with real source timestamps, so an answer here would risk presenting stale model memory as current."
  ),

  // ── Disabled: not yet implemented (future milestones) ──
  scenario_analysis: disabledEntry("scenario_analysis", NOT_YET_IMPLEMENTED_REASON),
  step_by_step_plan: disabledEntry("step_by_step_plan", NOT_YET_IMPLEMENTED_REASON),
  transformation: disabledEntry("transformation", NOT_YET_IMPLEMENTED_REASON),
};

export function getResultSchema(queryType: QueryType): ResultSchema {
  return SCHEMA_REGISTRY[queryType] || SCHEMA_REGISTRY.generic;
}
