/**
 * Adaptive Prompt Builder
 *
 * Replaces the fixed 11-section template (lib/panelPrompt.ts) for adaptive
 * runs. Renders ONLY the fields declared by the selected ResultSchema into
 * the model prompt — no "(if applicable)" sections ever reach a model.
 */

import { FieldSpec, FieldType, QueryClassification, ResultSchema } from "./types";

const TYPE_DISPLAY: Record<FieldType, string> = {
  string: "string",
  "string[]": "string[]",
  "claim[]": "Claim[]",
  "metric[]": "Metric[]",
  "step[]": "Step[]",
  "scenario[]": "Scenario[]",
  "enumItem[]": "EnumItem[]",
  "comparisonCell[]": "ComparisonCell[]",
  "distinction[]": "Distinction[]",
  "processStep[]": "ProcessStep[]",
  "checklistItem[]": "ChecklistItem[]",
  "researchFinding[]": "ResearchFinding[]",
  "evidenceDimension[]": "EvidenceDimension[]",
  "decisionAssessment[]": "DecisionAssessment[]",
  "decisionRisk[]": "DecisionRisk[]",
};

const CLAIM_INTERFACE = `interface Claim {
  id: string;          // short kebab-case slug from the claim's core concept, e.g. "demand-pull-driver"
  claim: string;        // one sentence, max 25 words
  stance: "asserts" | "disputes" | "uncertain";
  confidence: "settled" | "majority_view" | "contested" | "speculative";
  evidenceType: "empirical" | "theoretical" | "anecdotal" | "authoritative";
  camps?: { label: string; position: string }[]; // only for contested/disputed claims
}`;

const METRIC_INTERFACE = `interface Metric {
  label: string;
  value: number | null;
  unit: string;
  asOf: string;   // ISO date, or "unknown"
  source: string;
}`;

const STEP_INTERFACE = `interface Step {
  order: number;
  action: string;         // max 20 words
  prerequisite?: string;
  failureMode?: string;
}`;

const SCENARIO_INTERFACE = `interface Scenario {
  label: string;
  probability: number;          // 0-1; all scenarios' probabilities in this response must sum to ~1
  narrative: string;            // max 60 words
  leadingIndicators: string[];  // falsifiable signals, max 3
}`;

const ENUM_ITEM_INTERFACE = `interface EnumItem {
  id: string;           // short kebab-case slug from the item's label, e.g. "chatgpt"
  label: string;         // the item itself, in your own words — do not copy another item's exact phrasing
  category?: string;     // optional grouping, only if the question implies natural categories
  rank: number;          // 1-indexed; 1 is the most important/relevant/common item on YOUR OWN list
  rationale?: string;    // one short sentence on why this item is ranked here
  sources?: string[];    // plain labels for anything you're drawing on, if applicable — omit if none
}`;

const COMPARISON_CELL_INTERFACE = `interface ComparisonCell {
  subject: string;        // the thing being compared, e.g. "iPhone 15 Pro" — reuse the exact same string across all its cells
  attribute: string;      // the dimension being compared, e.g. "Battery life" — reuse the exact same string across all its cells
  value: string;          // this subject's value/assessment on this attribute, one short phrase
  verdict?: "better" | "worse" | "even"; // only when there's a genuine winner/loser on this attribute
  rationale?: string;
  sources?: string[];     // plain labels for anything you're drawing on, if applicable — omit if none
}`;

const DISTINCTION_INTERFACE = `interface Distinction {
  concept: string;      // the other concept this could be confused with
  explanation: string;  // how it differs from the term being explained
}`;

const PROCESS_STEP_INTERFACE = `interface ProcessStep {
  number: number;        // 1-indexed order in the mechanism/process
  title: string;         // short stage name
  explanation: string;   // what happens at this stage, explained (not an instruction to the reader)
}`;

const CHECKLIST_ITEM_INTERFACE = `interface ChecklistItem {
  id: string;           // short kebab-case slug from the item's label, e.g. "data-processing-agreement"
  label: string;         // the item itself, in your own words
  category?: string;     // groups this item under a named category (e.g. "Legal") — omit or use "none" for a flat checklist with no natural categories
  rationale?: string;    // one short sentence on why this item matters, if useful
  critical?: boolean;    // true for a must-have/blocking item, omit or false for a nice-to-have/situational one
}`;

const RESEARCH_FINDING_INTERFACE = `interface ResearchFinding {
  id: string;                // short kebab-case slug from the finding's core concept, e.g. "remote-work-productivity-decline"
  title: string;              // short label for the finding
  summary: string;            // the finding itself, one or two sentences
  category?: string;          // which research dimension this belongs to, if the question has multiple — omit if undifferentiated
  evidenceStrength?: "strong" | "moderate" | "weak" | "contested" | "unknown"; // your own honest read of how well-supported this finding is
  sources?: string[];         // plain labels for anything backing this specific finding, if applicable — omit if none
}`;

const EVIDENCE_DIMENSION_INTERFACE = `interface EvidenceDimension {
  id: string;                // short kebab-case slug from the dimension's label, e.g. "sample-size"
  dimension: string;          // e.g. "Methodology", "Sample size", "Conflicts of interest", "Replication status"
  assessment: string;         // one sentence: what's good or concerning about this dimension
  strength?: "strong" | "moderate" | "weak" | "contested" | "unknown"; // your own honest read of this specific dimension
}`;

const DECISION_ASSESSMENT_INTERFACE = `interface DecisionAssessment {
  id: string;                // short kebab-case slug, e.g. "hubspot-cost"
  optionLabel: string;        // must exactly match one of YOUR OWN "options" entries
  criterionLabel: string;     // must exactly match one of YOUR OWN "criteria" entries
  assessment: string;         // one sentence: how this option performs on this criterion
  evidenceStrength?: "strong" | "moderate" | "weak" | "contested" | "unknown"; // your own honest read of how well-supported THIS assessment is
}`;

const DECISION_RISK_INTERFACE = `interface DecisionRisk {
  id: string;                 // short kebab-case slug
  label: string;               // the risk itself, one sentence
  likelihood?: "low" | "medium" | "high" | "unknown";
  impact?: "low" | "medium" | "high" | "unknown";
  mitigation?: string;
  optionLabel?: string;        // set ONLY if specific to one option (must match an "options" entry) — omit if it applies broadly
}`;

const INTERFACE_BY_TYPE: Partial<Record<FieldType, string>> = {
  "claim[]": CLAIM_INTERFACE,
  "metric[]": METRIC_INTERFACE,
  "step[]": STEP_INTERFACE,
  "scenario[]": SCENARIO_INTERFACE,
  "enumItem[]": ENUM_ITEM_INTERFACE,
  "comparisonCell[]": COMPARISON_CELL_INTERFACE,
  "distinction[]": DISTINCTION_INTERFACE,
  "processStep[]": PROCESS_STEP_INTERFACE,
  "checklistItem[]": CHECKLIST_ITEM_INTERFACE,
  "researchFinding[]": RESEARCH_FINDING_INTERFACE,
  "evidenceDimension[]": EVIDENCE_DIMENSION_INTERFACE,
  "decisionAssessment[]": DECISION_ASSESSMENT_INTERFACE,
  "decisionRisk[]": DECISION_RISK_INTERFACE,
};

function fieldCapsSuffix(field: FieldSpec): string {
  const parts: string[] = [];
  if (field.maxWords) parts.push(`Max ${field.maxWords} words.`);
  if (field.minItems && field.maxItems) {
    parts.push(`Between ${field.minItems} and ${field.maxItems} items.`);
  } else if (field.maxItems) {
    parts.push(`Max ${field.maxItems} items.`);
  }
  if (field.allowedConfidenceValues && field.allowedConfidenceValues.length > 0) {
    parts.push(`Allowed confidence values here: ${field.allowedConfidenceValues.join(", ")}.`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

const DEFAULT_CONFIDENCE_VALUES = ["settled", "majority_view", "contested", "speculative"] as const;
const EVIDENCE_TYPE_VALUES = ["empirical", "theoretical", "anecdotal", "authoritative"] as const;

/**
 * A model that drifts from these exact strings (e.g. "agrees" instead of
 * "asserts") gets salvaged by enumCoercion.ts, but the cheapest fix is never
 * needing that salvage — spell out every allowed value verbatim, with exact
 * casing, right next to the field it applies to, plus one filled-in example
 * object so the model sees the vocabulary used correctly.
 */
function claimEnumHint(field: FieldSpec): string {
  const confidenceValues = field.allowedConfidenceValues && field.allowedConfidenceValues.length > 0
    ? field.allowedConfidenceValues
    : DEFAULT_CONFIDENCE_VALUES;

  const stanceValues = ["asserts", "disputes", "uncertain"] as const;
  const quote = (values: readonly string[]) => values.map((v) => `"${v}"`).join(" | ");

  const example = `{ "id": "example-claim", "claim": "One sentence stating the claim.", "stance": "asserts", "confidence": "${confidenceValues[0]}", "evidenceType": "empirical" }`;

  return ` Use these exact values, exact casing — stance: ${quote(stanceValues)}; confidence: ${quote(confidenceValues)}; evidenceType: ${quote(EVIDENCE_TYPE_VALUES)}. Example: ${example}`;
}

function fieldLine(field: FieldSpec): string {
  const typeLabel = TYPE_DISPLAY[field.type];
  const enumHint = field.type === "claim[]" ? claimEnumHint(field) : "";
  return `- "${field.key}" (${typeLabel}): ${field.description}${fieldCapsSuffix(field)}${enumHint}`;
}

/**
 * Build the system prompt for one model, scoped to exactly the fields the
 * selected schema declares.
 *
 * @param query - Primary research question
 * @param classification - The query's epistemic classification (drives steering context)
 * @param schema - The ResultSchema selected for this classification
 * @param context - Optional supporting material (same convention as buildPanelPrompt)
 */
export function buildModelPrompt(
  query: string,
  classification: QueryClassification,
  schema: ResultSchema,
  context?: string | null
): string {
  const usedTypes = new Set(schema.fields.map((f) => f.type));
  const interfaceBlocks = (Object.keys(INTERFACE_BY_TYPE) as FieldType[])
    .filter((type) => usedTypes.has(type))
    .map((type) => INTERFACE_BY_TYPE[type]!);

  const fieldLines = schema.fields.map(fieldLine).join("\n");

  let prompt = `You are one model in a multi-LLM expert research panel inside a product called ConvergePanel.

Answer the user's question by producing ONLY a JSON object with exactly the keys listed below. Do not add extra keys, do not wrap the JSON in markdown fences, and do not add any commentary before or after the JSON.

Domain: ${classification.domain}. The user's intent: ${classification.userIntent}.`;

  if (interfaceBlocks.length > 0) {
    prompt += `\n\n${interfaceBlocks.join("\n\n")}`;
  }

  if (usedTypes.has("enumItem[]") && classification.requestedCount) {
    prompt += `\n\nThe user asked for ${classification.requestedCount} items. Provide up to ${classification.requestedCount} distinct, non-overlapping items ranked by importance/relevance/commonality. If you cannot responsibly identify that many genuinely distinct items, provide fewer — never pad the list with near-duplicates or filler to hit the count.`;
  }

  if (usedTypes.has("comparisonCell[]")) {
    prompt += `\n\nIdentify the specific named things being compared and the dimensions worth comparing them on directly from the question. Emit one cell per (subject, attribute) pair you can responsibly assess — it is fine to leave a pair out rather than guess. Do not invent a subject or attribute the question doesn't call for just to fill the grid.`;
  }

  if (schema.id === "definition_explanation") {
    prompt += `\n\nDetect the depth the question calls for from its own phrasing — "like I'm a beginner"/"simply" means beginner depth, "technically"/"mathematically"/"for an expert" means expert depth, otherwise use a clear general-audience depth. Preserve any explicitly requested style (e.g. "using a [X] analogy"). If the term has more than one commonly accepted meaning and the question gives no domain context to narrow it, answer for the most likely meaning but say plainly in directAnswer/explanation that other meanings exist — never silently pick one and hide the ambiguity.`;
  }

  if (usedTypes.has("checklistItem[]")) {
    prompt += `\n\nList order does not matter — do not imply importance or sequence through position in the list. Use \`category\` only when the question genuinely asks for a categorized taxonomy (types/kinds of something); for an ordinary checklist, leave every item's category unset. Mark \`critical\` only for genuinely must-have/blocking items, not everything.`;
  }

  if (schema.id === "deep_research") {
    prompt += `\n\nThis is a broad research synthesis question. Follow all of these:
1. Identify the major dimensions of the research question and cover the most important ones.
2. Provide a concise executive summary before any detail.
3. Separate established findings (findings, with a confident evidenceStrength) from disputed findings (put those in disagreements instead).
4. Identify major evidence gaps (evidenceGaps) — what's under-studied or methodologically weak.
5. Preserve materially different interpretations rather than picking one and hiding the rest.
6. State research boundaries and scope limits (researchBoundaries) — what this review does NOT cover.
7. Never imply this review is exhaustive.
8. Distinguish primary evidence, reviews, commentary, and speculation where it matters to the finding.
9. Flag outdated evidence or time-window ambiguity when relevant.
10. Suggest high-value follow-up questions (recommendedNextSteps).
If the user asked you to use only specific provided sources and you cannot verify you are actually restricted to exactly those sources, say so plainly in researchBoundaries rather than silently supplementing with your own training knowledge.`;
  }

  if (schema.id === "evidence_review") {
    prompt += `\n\nThis is an evidence-quality review, not a substantive research summary — you are evaluating HOW STRONG/CREDIBLE/RELIABLE the evidence, study, source, or methodology itself is, not what it concludes. Follow all of these:
1. Give a direct, plain-language overall assessment before any detail.
2. Break the review into concrete, relevant quality dimensions (methodology, sample size, conflicts of interest, replication status, source credibility, generalizability, etc.) — only the ones that actually matter here, not a rote checklist.
3. Give your own honest strength read per dimension — never inflate a dimension's strength just because evidence exists; weak evidence stays weak.
4. Name concrete red flags when present (e.g. no control group, undisclosed funding, small sample, cherry-picked data, not peer-reviewed) — do not soften a genuine red flag.
5. Name concrete positive credibility signals when present (e.g. peer-reviewed, pre-registered, large sample, independently replicated).
6. State where this evidence may not generalize (population, context, time period).
7. Suggest what a careful reader should still verify before trusting this evidence.
Never rate evidence "strong" merely because it's widely cited or repeated — popularity is not proof of quality.`;
  }

  if (schema.id === "bias_blindspot_audit") {
    prompt += `\n\nThis is a bias and blind-spot audit — you are auditing the PANEL's overall coverage and framing, not answering the underlying question from scratch. Follow all of these:
1. Distinguish model-specific bias (which needs a separate dedicated evidence-based check, not your own self-report) from shared panel-level omissions, which is what omittedDimensions/sharedAssumptions below are for.
2. Never label ordinary, well-supported disagreement as bias — bias is about skewed framing/coverage, not differing conclusions.
3. Never infer ideological or political motive without direct evidence.
4. Name specific missing dimensions, not vague "more context needed" statements.
5. Name affected stakeholders specifically where relevant, not generically.
6. Identify assumptions you believe are shared across the panel, not just your own response.
7. Identify concentration in sources or evidence types, and keep geographic/institutional concerns separate from source-concentration concerns.
8. Distinguish geographic or institutional bias from a plain factual error — a wrong fact is not a bias finding.
9. Suggest precise, runnable follow-up questions, not generic advice.
10. If you cannot identify a genuine gap or assumption, say so with empty arrays rather than inventing one to fill the field.
No invented bias. No unsupported political labeling. No demographic inference. No generic boilerplate. Every omission you name must be plausible and specifically relevant to the user's actual question.`;
  }

  if (schema.id === "decision_support") {
    prompt += `\n\nThis is a decision-support question — the user must choose, prioritize, approve, defer, escalate, or decide among concrete options under uncertainty. Follow all of these:
1. State the decision being made clearly in decisionQuestion.
2. Identify the real options actually available — never invent options the question doesn't support.
3. Use explicit decision criteria, and distinguish criteria the user actually stated (userProvidedCriteria) from ones you're adding.
4. Never invent a user preference or constraint they did not provide — if a criterion's importance isn't stated, don't assert a weighting for it.
5. Identify missing information that could change the decision (uncertainties) rather than silently deciding for the user.
6. Surface major risks and tradeoffs (risks) — do not bury a real downside just because you're recommending an option.
7. Prefer a reversible, low-regret next step (reversibleNextStep) over a large irreversible commitment when uncertainty is high.
8. Use a conditional recommendation (conditional_go) when the evidence is incomplete, rather than a confident one you can't support.
9. Do not give a single universal recommendation when different plausible scenarios genuinely favor different options — say so in sensitivityFindings instead.
10. State what would change your recommendation (sensitivityFindings/uncertainties), not just what it currently is.
11. Escalate (recommendationAction "escalate") when the decision is high-stakes and the evidence available to you is not sufficient to responsibly resolve it.
12. If the decision cannot be responsibly made without information you don't have (budget, jurisdiction, timeline, risk tolerance), say so explicitly in uncertainties and prefer "defer" or a conditional recommendation over guessing.
Do not let model popularity become the sole basis of the recommendation — a recommendation must be justified by the assessments/criteria/risks above it, not merely asserted.`;
  }

  if (schema.id === "causal_explanation") {
    prompt += `\n\nThis is a causal question. Follow all of these:
1. Answer the causal question directly in directAnswer.
2. Separate direct causes (directCauses) from contributing factors (contributingFactors) — do not blur them together.
3. In causalLinks, explain the MECHANISM connecting cause to effect, not just that they're correlated.
4. Identify plausible confounders (confounders) — variables that could explain the association without your proposed cause being the true driver.
5. Include credible alternative explanations (alternativeExplanations) that compete with your main account.
6. Distinguish established causes from disputed or speculative ones — put genuine expert disagreement in disputedInterpretations, not directCauses.
7. Avoid monocausal explanations when the issue is genuinely multi-causal — use contributingFactors/triggers/amplifiers to reflect that.
8. State what evidence or test (testsOrEvidenceNeeded) would be needed to more confidently establish or rule out this causal account.
9. Never treat temporal sequence alone as proof of causation ("X happened before Y" is not "X caused Y").
10. Never overstate causality when only association is supported — say so plainly in directAnswer/causalLinks rather than implying a stronger causal claim than the evidence supports.
If this touches a medical, legal, financial, or public-policy domain where being wrong carries real consequences, hold yourself to a higher evidence bar and say so if the evidence doesn't meet it.`;
  }

  prompt += `\n\nRequired JSON keys:\n${fieldLines}`;

  if (context && context.trim().length > 0) {
    prompt += `\n\nQUESTION:\n"""${query}"""\n\nCONTEXT (supporting source material — integrate it, note contradictions, but keep a skeptical stance):\n"""${context}"""`;
  } else {
    prompt += `\n\nQUESTION:\n"""${query}"""`;
  }

  prompt += `\n\nReturn ONLY the JSON object with exactly these keys. No markdown fences, no commentary.`;

  return prompt;
}
