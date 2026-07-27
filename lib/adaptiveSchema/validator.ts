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
import { AdaptiveModelResult, FieldSpec, FieldType, ResultSchema } from "./types";
import { stripJsonFences, truncateWords } from "./util";

// Caps intrinsic to the atomic unit interfaces themselves (types.ts), not
// schema-specific — these apply regardless of which ResultSchema is active.
const CLAIM_TEXT_MAX_WORDS = 25;
const STEP_ACTION_MAX_WORDS = 20;
const SCENARIO_NARRATIVE_MAX_WORDS = 60;
const SCENARIO_LEADING_INDICATORS_MAX = 3;

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

  const responseSchema = buildResponseZodSchema(schema.fields);
  const result = responseSchema.safeParse(parsedJson);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    logger.warn("[adaptiveSchema] Response failed schema validation", {
      modelId,
      schemaId: schema.id,
      issues,
    });
    return {
      modelId,
      schemaId: schema.id,
      ok: false,
      data: null,
      parseError: `Schema validation failed: ${issues.join("; ")}`,
    };
  }

  const data: Record<string, any> = { ...result.data };
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
      }
    }
  }

  return {
    modelId,
    schemaId: schema.id,
    ok: true,
    data,
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
  };
}
