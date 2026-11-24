/**
 * Adaptive Research Export, Phase 4 — a Zod validator for the
 * customer-facing `AdaptiveResearchJsonExportV1` contract (jsonExport.ts).
 * Reuses the project's existing Zod dependency (already used throughout
 * lib/adaptiveSchema/ and lib/synthesis/) rather than adding a new
 * validation library.
 *
 * This validates the CONTRACT shape — the fixed outer fields every JSON
 * export must have (formatVersion, export, report, panel, governance,
 * classification, provenance) and the `result` discriminated union's own
 * fixed keys. It deliberately does NOT re-validate the deeply nested
 * schema-specific payloads (`result.result` for Milestone-2,
 * `result.modelResponses[].data` for legacy schemas) — those were already
 * Zod-validated once, at panel-run ingestion time, against their own
 * per-schema types; re-validating them here would be redundant and would
 * force this file to import all 9+8 schema-specific shapes just to
 * duplicate a check that already happened.
 */

import { z } from "zod";

const modelSummarySchema = z.object({
  modelId: z.string(),
  ok: z.boolean().optional(),
});

const consensusLevelSchema = z.enum(["strong", "moderate", "weak", "split", "unscored"]);
const sourceGroundingLevelSchema = z.enum(["strong", "moderate", "weak", "unscored"]);
const classificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);

const reportStatusKindSchema = z.enum([
  "unreviewed_in_queue",
  "not_reviewed_no_review_configured",
  "approved",
  "approved_with_conditions",
  "changes_requested",
  "rejected",
  "incomplete",
]);

const governanceStatusSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("milestone2"),
    kind: z.union([reportStatusKindSchema, z.literal("superseded")]),
    isOwnerOverride: z.boolean(),
    conditions: z.array(z.string()).optional(),
  }),
  z.object({
    family: z.literal("legacy"),
    status: z.union([z.literal("approved"), z.literal("needs_review"), z.literal("blocked"), z.null()]),
  }),
]);

const jsonExportResultSchema = z.discriminatedUnion("schemaFamily", [
  z.object({
    schemaFamily: z.literal("milestone2"),
    schemaId: z.string(),
    result: z.unknown(),
    decisionReceipt: z.unknown().optional(),
    // Item 6A (F2/F6): optional, additive, derived at render time (see jsonExport.ts); absent on every unaffected export.
    derivedCriteriaProvenanceDisclosure: z
      .object({
        derivedAtExport: z.literal(true),
        derivedRule: z.literal("request_text_v1"),
        note: z.string(),
        resultProvenanceMarker: z.union([z.literal("request_text_v1"), z.null()]),
        storedReceiptHasLegacyUserProvidedLabels: z.boolean(),
        criteria: z.array(
          z.object({ id: z.string(), label: z.string(), recordedSource: z.enum(["user", "model"]), derivedProvenance: z.enum(["user", "model", "unverified_legacy"]) })
        ),
      })
      .optional(),
    // Item 7A: optional, additive, derived at render time from the frozen meta; absent for complete runs.
    derivedStructuredOutputDisclosure: z
      .object({
        derivedAtExport: z.literal(true),
        selected: z.number().int().nonnegative(),
        completedCalls: z.union([z.number().int().nonnegative(), z.null()]),
        usable: z.number().int().nonnegative(),
        affected: z.union([
          z.array(
            z.object({
              modelId: z.string(),
              state: z.enum(["unavailable", "partial"]),
              providerCall: z.enum(["completed", "failed"]),
              fieldsNotRecovered: z.number().int().nonnegative(),
              itemsDiscarded: z.number().int().nonnegative(),
              itemsOverLimit: z.number().int().nonnegative(),
              textShortenedFields: z.number().int().nonnegative(),
              affectedFields: z.number().int().nonnegative(),
              decisionCriticalAffected: z.boolean(),
              material: z.boolean(),
            })
          ),
          z.null(),
        ]),
        prominent: z.boolean(),
        lines: z.array(z.string()),
      })
      .optional(),
  }),
  z.object({
    schemaFamily: z.literal("legacy"),
    schemaId: z.string(),
    alignedClaims: z.array(z.unknown()),
    gate: z.unknown().optional(),
    synthesisReport: z.unknown().optional(),
    trustSummary: z.unknown().optional(),
    modelResponses: z.array(z.unknown()).optional(),
  }),
]);

export const adaptiveResearchJsonExportV1Schema = z.object({
  formatVersion: z.literal("1"),
  export: z.object({
    exportId: z.string(),
    reportVersion: z.number(),
    createdAt: z.string(),
    format: z.literal("json"),
    /** Export Generator Provenance — absent for any export created before this feature shipped, never fabricated for those. */
    generatedBy: z
      .object({
        displayName: z.string().nullable(),
        maskedEmail: z.string().nullable(),
      })
      .optional(),
  }),
  report: z.object({
    runId: z.string(),
    schemaId: z.string(),
    schemaVersion: z.literal(1),
    schemaFamily: z.union([z.literal("milestone2"), z.literal("legacy")]),
    question: z.string(),
    generatedAt: z.string(),
  }),
  panel: z.object({
    models: z.array(modelSummarySchema),
    consensus: z.object({ level: consensusLevelSchema }),
    sourceGrounding: z.object({ level: sourceGroundingLevelSchema }),
  }),
  governance: governanceStatusSchema,
  classification: classificationSchema,
  result: jsonExportResultSchema,
  provenance: z.object({
    runId: z.string(),
    exportId: z.string(),
    reportVersion: z.number(),
    contractVersion: z.literal(1),
    schemaId: z.string(),
    schemaVersion: z.literal(1),
    schemaFamily: z.union([z.literal("milestone2"), z.literal("legacy")]),
    generatedAt: z.string(),
    exportedAt: z.string(),
    models: z.array(modelSummarySchema),
    governanceStatusAtExport: governanceStatusSchema,
    classification: classificationSchema,
    /** Step 6.2b — absent for every export created before 6.2b, never synthesized. */
    run: z
      .object({
        policyVersion: z.number().int().min(1).optional(),
        models: z.array(
          z.object({
            modelId: z.string(),
            provider: z.string().optional(),
            requestedModel: z.string().optional(),
            substituted: z.boolean().optional(),
            substitutedFrom: z.string().optional(),
          })
        ),
      })
      .optional(),
  }),
});

export type AdaptiveResearchJsonExportV1Parsed = z.infer<typeof adaptiveResearchJsonExportV1Schema>;
