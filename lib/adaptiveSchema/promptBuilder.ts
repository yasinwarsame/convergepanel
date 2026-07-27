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

const INTERFACE_BY_TYPE: Partial<Record<FieldType, string>> = {
  "claim[]": CLAIM_INTERFACE,
  "metric[]": METRIC_INTERFACE,
  "step[]": STEP_INTERFACE,
  "scenario[]": SCENARIO_INTERFACE,
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

function fieldLine(field: FieldSpec): string {
  const typeLabel = TYPE_DISPLAY[field.type];
  return `- "${field.key}" (${typeLabel}): ${field.description}${fieldCapsSuffix(field)}`;
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

  prompt += `\n\nRequired JSON keys:\n${fieldLines}`;

  if (context && context.trim().length > 0) {
    prompt += `\n\nQUESTION:\n"""${query}"""\n\nCONTEXT (supporting source material — integrate it, note contradictions, but keep a skeptical stance):\n"""${context}"""`;
  } else {
    prompt += `\n\nQUESTION:\n"""${query}"""`;
  }

  prompt += `\n\nReturn ONLY the JSON object with exactly these keys. No markdown fences, no commentary.`;

  return prompt;
}
