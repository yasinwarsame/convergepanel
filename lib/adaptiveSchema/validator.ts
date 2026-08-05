/**
 * Adaptive Response Validator
 *
 * Parses and validates one model's raw JSON response against the ResultSchema
 * that drove its prompt. A response that fails to parse or fails schema
 * validation never throws — it becomes a `parseError` result so the
 * comparison view can render a failed cell instead of crashing.
 *
 * Word/item caps are enforced twice: once in the prompt (promptBuilder.ts)
 * and again here (soft-truncate with ellipsis, logged, never a hard failure).
 */

import "server-only";
import { z, ZodTypeAny } from "zod";
import { ModelId } from "@/lib/types";
import { logger } from "@/lib/logger";
import { AdaptiveEnumCoercion, AdaptiveModelResult, FieldSpec, FieldType, ResultSchema } from "./types";
import { stripJsonFences, truncateWords } from "./util";
import { coerceClaimEnums } from "./enumCoercion";

// Caps intrinsic to the atomic unit interfaces themselves (types.ts), not
// schema-specific — these apply regardless of which ResultSchema is active.
const CLAIM_TEXT_MAX_WORDS = 25;
const STEP_ACTION_MAX_WORDS = 20;
const SCENARIO_NARRATIVE_MAX_WORDS = 60;
const SCENARIO_LEADING_INDICATORS_MAX = 3;
const ENUM_ITEM_RATIONALE_MAX_WORDS = 30;
const COMPARISON_CELL_VALUE_MAX_WORDS = 20;
const COMPARISON_CELL_RATIONALE_MAX_WORDS = 30;
const DISTINCTION_EXPLANATION_MAX_WORDS = 30;
const PROCESS_STEP_EXPLANATION_MAX_WORDS = 30;
const CHECKLIST_ITEM_RATIONALE_MAX_WORDS = 30;
const RESEARCH_FINDING_SUMMARY_MAX_WORDS = 40;
const EVIDENCE_DIMENSION_ASSESSMENT_MAX_WORDS = 30;
const DECISION_ASSESSMENT_TEXT_MAX_WORDS = 30;
const DECISION_RISK_LABEL_MAX_WORDS = 25;
const DECISION_RISK_MITIGATION_MAX_WORDS = 25;

const ClaimZod = z.object({
  id: z.string(),
  claim: z.string(),
  stance: z.enum(["asserts", "disputes", "uncertain"]),
  confidence: z.enum(["settled", "majority_view", "contested", "speculative"]),
  evidenceType: z.enum(["empirical", "theoretical", "anecdotal", "authoritative"]),
  camps: z.array(z.object({ label: z.string(), position: z.string() })).optional(),
});

const MetricZod = z.object({
  label: z.string(),
  value: z.number().nullable(),
  unit: z.string(),
  asOf: z.string(),
  source: z.string(),
});

const StepZod = z.object({
  order: z.number(),
  action: z.string(),
  prerequisite: z.string().optional(),
  failureMode: z.string().optional(),
});

const ScenarioZod = z.object({
  label: z.string(),
  probability: z.number(),
  narrative: z.string(),
  leadingIndicators: z.array(z.string()),
});

const EnumItemZod = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string().optional(),
  rank: z.number(),
  rationale: z.string().optional(),
  sources: z.array(z.string()).optional(),
});

const ComparisonCellZod = z.object({
  subject: z.string(),
  attribute: z.string(),
  value: z.string(),
  verdict: z.enum(["better", "worse", "even"]).optional(),
  rationale: z.string().optional(),
  sources: z.array(z.string()).optional(),
});

const DistinctionZod = z.object({
  concept: z.string(),
  explanation: z.string(),
});

const ProcessStepZod = z.object({
  number: z.number(),
  title: z.string(),
  explanation: z.string(),
});

const ChecklistItemZod = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string().optional(),
  rationale: z.string().optional(),
  critical: z.boolean().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  likelihood: z.enum(["low", "medium", "high"]).optional(),
  impact: z.string().optional(),
  evidence: z.string().optional(),
  mitigation: z.string().optional(),
  monitoringSignal: z.string().optional(),
  residualRisk: z.string().optional(),
});

const ResearchFindingZod = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.string().optional(),
  evidenceStrength: z.enum(["strong", "moderate", "weak", "contested", "unknown"]).optional(),
  sources: z.array(z.string()).optional(),
});

const EvidenceDimensionZod = z.object({
  id: z.string(),
  dimension: z.string(),
  assessment: z.string(),
  strength: z.enum(["strong", "moderate", "weak", "contested", "unknown"]).optional(),
});

const DecisionAssessmentZod = z.object({
  id: z.string(),
  optionLabel: z.string(),
  criterionLabel: z.string(),
  assessment: z.string(),
  evidenceStrength: z.enum(["strong", "moderate", "weak", "contested", "unknown"]).optional(),
});

const DecisionRiskZod = z.object({
  id: z.string(),
  label: z.string(),
  likelihood: z.enum(["low", "medium", "high", "unknown"]).optional(),
  impact: z.enum(["low", "medium", "high", "unknown"]).optional(),
  mitigation: z.string().optional(),
  optionLabel: z.string().optional(),
});

function zodForFieldType(type: FieldType): ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "string[]":
      return z.array(z.string());
    case "claim[]":
      return z.array(ClaimZod);
    case "metric[]":
      return z.array(MetricZod);
    case "step[]":
      return z.array(StepZod);
    case "scenario[]":
      return z.array(ScenarioZod);
    case "enumItem[]":
      return z.array(EnumItemZod);
    case "comparisonCell[]":
      return z.array(ComparisonCellZod);
    case "distinction[]":
      return z.array(DistinctionZod);
    case "processStep[]":
      return z.array(ProcessStepZod);
    case "checklistItem[]":
      return z.array(ChecklistItemZod);
    case "researchFinding[]":
      return z.array(ResearchFindingZod);
    case "evidenceDimension[]":
      return z.array(EvidenceDimensionZod);
    case "decisionAssessment[]":
      return z.array(DecisionAssessmentZod);
    case "decisionRisk[]":
      return z.array(DecisionRiskZod);
    default:
      return z.unknown();
  }
}

function buildResponseZodSchema(fields: FieldSpec[]) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const field of fields) {
    shape[field.key] = zodForFieldType(field.type);
  }
  return z.object(shape);
}

/** The per-item schema for an array FieldType — used by field-level salvage to keep valid items and drop only the invalid ones. */
function itemZodForFieldType(type: FieldType): ZodTypeAny {
  switch (type) {
    case "string[]":
      return z.string();
    case "claim[]":
      return ClaimZod;
    case "metric[]":
      return MetricZod;
    case "step[]":
      return StepZod;
    case "scenario[]":
      return ScenarioZod;
    case "enumItem[]":
      return EnumItemZod;
    case "comparisonCell[]":
      return ComparisonCellZod;
    case "distinction[]":
      return DistinctionZod;
    case "processStep[]":
      return ProcessStepZod;
    case "checklistItem[]":
      return ChecklistItemZod;
    case "researchFinding[]":
      return ResearchFindingZod;
    case "evidenceDimension[]":
      return EvidenceDimensionZod;
    case "decisionAssessment[]":
      return DecisionAssessmentZod;
    case "decisionRisk[]":
      return DecisionRiskZod;
    default:
      return z.unknown();
  }
}

/**
 * Coerce recoverable enum drift (case/synonym normalization — see
 * enumCoercion.ts) in every claim[]-shaped field, in place on a shallow copy
 * of the parsed JSON. Returns the (possibly patched) object plus a flat log
 * of every coercion applied, across all fields in the schema.
 */
function coerceEnumDrift(
  modelId: ModelId,
  schema: ResultSchema,
  parsedJson: Record<string, unknown>
): { patched: Record<string, unknown>; coercions: AdaptiveEnumCoercion[] } {
  const patched: Record<string, unknown> = { ...parsedJson };
  const coercions: AdaptiveEnumCoercion[] = [];

  for (const field of schema.fields) {
    if (field.type !== "claim[]") continue;
    const value = patched[field.key];
    if (!Array.isArray(value)) continue;

    patched[field.key] = value.map((item, idx) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const { claim, log } = coerceClaimEnums(item as Record<string, unknown>, {
        modelId,
        schemaId: schema.id,
        path: `${field.key}[${idx}]`,
      });
      coercions.push(...log);
      return claim;
    });
  }

  return { patched, coercions };
}

/**
 * Field-level salvage: run once the whole-object parse has already failed.
 * Validates each schema field independently — array fields are salvaged
 * item-by-item (a broken item is dropped, valid ones are kept; the field is
 * marked invalid only if literally nothing in it validates), scalar fields
 * are all-or-nothing. Never discards a field just because a sibling field
 * failed.
 */
function salvageFields(
  fields: FieldSpec[],
  raw: Record<string, unknown>
): { data: Record<string, any>; invalidFields: string[]; issues: string[] } {
  const data: Record<string, any> = {};
  const invalidFields: string[] = [];
  const issues: string[] = [];

  for (const field of fields) {
    const value = raw[field.key];

    if (field.type === "string") {
      const result = z.string().safeParse(value);
      if (result.success) {
        data[field.key] = result.data;
      } else {
        invalidFields.push(field.key);
        issues.push(`${field.key}: ${result.error.issues.map((i) => i.message).join("; ")}`);
      }
      continue;
    }

    if (!Array.isArray(value)) {
      invalidFields.push(field.key);
      issues.push(`${field.key}: expected an array, received ${typeof value}`);
      continue;
    }

    const itemSchema = itemZodForFieldType(field.type);
    const validItems: unknown[] = [];
    for (let idx = 0; idx < value.length; idx++) {
      const itemResult = itemSchema.safeParse(value[idx]);
      if (itemResult.success) {
        validItems.push(itemResult.data);
      } else {
        issues.push(`${field.key}.${idx}: ${itemResult.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      }
    }

    // An empty input array is legitimately valid (e.g. "no settled claims") —
    // only mark the field invalid when it had items and NONE of them survived.
    if (value.length === 0 || validItems.length > 0) {
      data[field.key] = validItems;
    } else {
      invalidFields.push(field.key);
    }
  }

  return { data, invalidFields, issues };
}

/**
 * Validate one model's raw text against the schema that drove its prompt.
 * Never throws.
 */
export function validateAdaptiveResponse(
  modelId: ModelId,
  schema: ResultSchema,
  rawText: string | null
): AdaptiveModelResult {
  if (!rawText || !rawText.trim()) {
    return { modelId, schemaId: schema.id, ok: false, data: null, parseError: "Empty response" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripJsonFences(rawText));
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Response was not valid JSON", {
      modelId,
      schemaId: schema.id,
      error: err?.message,
    });
    return {
      modelId,
      schemaId: schema.id,
      ok: false,
      data: null,
      parseError: `Invalid JSON: ${err?.message || "parse error"}`,
    };
  }

  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    return { modelId, schemaId: schema.id, ok: false, data: null, parseError: "Response was not a JSON object" };
  }

  // Recover recoverable enum drift (case/synonym normalization) before Zod
  // ever sees it, e.g. Gemini's `"stance": "Agrees"` -> `"asserts"`.
  const { patched, coercions } = coerceEnumDrift(modelId, schema, parsedJson as Record<string, unknown>);
  if (coercions.length > 0) {
    logger.warn("[adaptiveSchema] Coerced enum drift before validation", {
      modelId,
      schemaId: schema.id,
      coercions: coercions.map((c) => ({ field: c.field, path: c.path, raw: c.raw, coerced: c.coerced })),
    });
  }

  const responseSchema = buildResponseZodSchema(schema.fields);
  const wholeResult = responseSchema.safeParse(patched);

  let data: Record<string, any>;
  let invalidFields: string[] = [];

  if (wholeResult.success) {
    data = { ...wholeResult.data };
  } else {
    // Whole-object parse still fails after coercion — fall back to
    // field-level salvage instead of discarding the entire response. Array
    // fields keep whichever items validate; scalar fields are all-or-nothing.
    const salvaged = salvageFields(schema.fields, patched);
    data = salvaged.data;
    invalidFields = salvaged.invalidFields;

    if (Object.keys(data).length === 0) {
      logger.warn("[adaptiveSchema] Response failed schema validation", {
        modelId,
        schemaId: schema.id,
        issues: salvaged.issues,
      });
      return {
        modelId,
        schemaId: schema.id,
        ok: false,
        data: null,
        parseError: `Schema validation failed: ${salvaged.issues.join("; ")}`,
        invalidFields: schema.fields.map((f) => f.key),
        ...(coercions.length > 0 ? { coercions } : {}),
      };
    }

    logger.warn("[adaptiveSchema] Salvaged partial response after schema validation failure", {
      modelId,
      schemaId: schema.id,
      invalidFields,
      issues: salvaged.issues,
    });
  }

  const truncatedFields: string[] = [];

  const markTruncated = (fieldKey: string) => {
    if (!truncatedFields.includes(fieldKey)) truncatedFields.push(fieldKey);
  };

  for (const field of schema.fields) {
    const value = data[field.key];

    if (field.type === "string" && field.maxWords && typeof value === "string") {
      const { text, truncated } = truncateWords(value, field.maxWords);
      if (truncated) {
        data[field.key] = text;
        markTruncated(field.key);
        logger.warn("[adaptiveSchema] Soft-truncated string field over word cap", {
          modelId,
          schemaId: schema.id,
          field: field.key,
          maxWords: field.maxWords,
        });
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (field.maxItems && value.length > field.maxItems) {
        data[field.key] = value.slice(0, field.maxItems);
        markTruncated(field.key);
        logger.warn("[adaptiveSchema] Truncated array field over item cap", {
          modelId,
          schemaId: schema.id,
          field: field.key,
          maxItems: field.maxItems,
          receivedItems: value.length,
        });
      }

      if (field.minItems && value.length < field.minItems) {
        logger.warn("[adaptiveSchema] Array field below minimum item count (not fabricated)", {
          modelId,
          schemaId: schema.id,
          field: field.key,
          minItems: field.minItems,
          receivedItems: value.length,
        });
      }

      // Nested word caps intrinsic to the atomic unit interfaces.
      if (field.type === "claim[]") {
        data[field.key] = (data[field.key] as any[]).map((claim) => {
          const { text, truncated } = truncateWords(claim.claim, CLAIM_TEXT_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...claim, claim: text } : claim;
        });
      } else if (field.type === "step[]") {
        data[field.key] = (data[field.key] as any[]).map((step) => {
          const { text, truncated } = truncateWords(step.action, STEP_ACTION_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...step, action: text } : step;
        });
      } else if (field.type === "scenario[]") {
        data[field.key] = (data[field.key] as any[]).map((scenario) => {
          const { text, truncated } = truncateWords(scenario.narrative, SCENARIO_NARRATIVE_MAX_WORDS);
          let next = truncated ? { ...scenario, narrative: text } : scenario;
          if (truncated) markTruncated(field.key);
          if (Array.isArray(next.leadingIndicators) && next.leadingIndicators.length > SCENARIO_LEADING_INDICATORS_MAX) {
            next = { ...next, leadingIndicators: next.leadingIndicators.slice(0, SCENARIO_LEADING_INDICATORS_MAX) };
            markTruncated(field.key);
          }
          return next;
        });
      } else if (field.type === "enumItem[]") {
        data[field.key] = (data[field.key] as any[]).map((item) => {
          if (typeof item.rationale !== "string") return item;
          const { text, truncated } = truncateWords(item.rationale, ENUM_ITEM_RATIONALE_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...item, rationale: text } : item;
        });
      } else if (field.type === "comparisonCell[]") {
        data[field.key] = (data[field.key] as any[]).map((cell) => {
          let next = cell;
          const value = truncateWords(cell.value, COMPARISON_CELL_VALUE_MAX_WORDS);
          if (value.truncated) {
            next = { ...next, value: value.text };
            markTruncated(field.key);
          }
          if (typeof cell.rationale === "string") {
            const rationale = truncateWords(cell.rationale, COMPARISON_CELL_RATIONALE_MAX_WORDS);
            if (rationale.truncated) {
              next = { ...next, rationale: rationale.text };
              markTruncated(field.key);
            }
          }
          return next;
        });
      } else if (field.type === "distinction[]") {
        data[field.key] = (data[field.key] as any[]).map((distinction) => {
          const { text, truncated } = truncateWords(distinction.explanation, DISTINCTION_EXPLANATION_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...distinction, explanation: text } : distinction;
        });
      } else if (field.type === "processStep[]") {
        data[field.key] = (data[field.key] as any[]).map((step) => {
          const { text, truncated } = truncateWords(step.explanation, PROCESS_STEP_EXPLANATION_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...step, explanation: text } : step;
        });
      } else if (field.type === "checklistItem[]") {
        data[field.key] = (data[field.key] as any[]).map((item) => {
          if (typeof item.rationale !== "string") return item;
          const { text, truncated } = truncateWords(item.rationale, CHECKLIST_ITEM_RATIONALE_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...item, rationale: text } : item;
        });
      } else if (field.type === "researchFinding[]") {
        data[field.key] = (data[field.key] as any[]).map((finding) => {
          const { text, truncated } = truncateWords(finding.summary, RESEARCH_FINDING_SUMMARY_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...finding, summary: text } : finding;
        });
      } else if (field.type === "evidenceDimension[]") {
        data[field.key] = (data[field.key] as any[]).map((dim) => {
          const { text, truncated } = truncateWords(dim.assessment, EVIDENCE_DIMENSION_ASSESSMENT_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...dim, assessment: text } : dim;
        });
      } else if (field.type === "decisionAssessment[]") {
        data[field.key] = (data[field.key] as any[]).map((item) => {
          const { text, truncated } = truncateWords(item.assessment, DECISION_ASSESSMENT_TEXT_MAX_WORDS);
          if (truncated) markTruncated(field.key);
          return truncated ? { ...item, assessment: text } : item;
        });
      } else if (field.type === "decisionRisk[]") {
        data[field.key] = (data[field.key] as any[]).map((risk) => {
          let next = risk;
          const label = truncateWords(risk.label, DECISION_RISK_LABEL_MAX_WORDS);
          if (label.truncated) {
            next = { ...next, label: label.text };
            markTruncated(field.key);
          }
          if (typeof risk.mitigation === "string") {
            const mitigation = truncateWords(risk.mitigation, DECISION_RISK_MITIGATION_MAX_WORDS);
            if (mitigation.truncated) {
              next = { ...next, mitigation: mitigation.text };
              markTruncated(field.key);
            }
          }
          return next;
        });
      }
    }
  }

  return {
    modelId,
    schemaId: schema.id,
    ok: true,
    data,
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
    ...(invalidFields.length > 0 ? { invalidFields } : {}),
    ...(coercions.length > 0 ? { coercions } : {}),
  };
}
