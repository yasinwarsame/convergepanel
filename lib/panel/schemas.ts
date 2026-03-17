/**
 * Panel Schemas and Validation
 * 
 * Type definitions and Zod schemas for panel data structures.
 */

import { z } from "zod";
import type { ModelId, ModelStatus, ConnectorStatus } from "@/lib/types";
import type { TokenUsageNormalized } from "./normalizeTokens";

/**
 * Token usage normalized schema (Zod)
 */
export const TokenUsageNormalizedSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
});

/**
 * Backward-compatible substitutedFrom: accepts either a string ("openai:gpt-4o-mini")
 * or a legacy object ({ provider, model, reason? }) from older stored runs.
 */
const SubstitutedFromSchema = z.union([
  z.string(),
  z.object({
    provider: z.string(),
    model: z.string(),
    reason: z.string().optional(),
  }),
]).optional();

/**
 * Panel result public schema (Zod)
 * This is what run-panel returns and synthesize-panel accepts.
 * rawResponse is NEVER included - only rawTextFull (full canonical text for UI display).
 *
 * Status accepts legacy values ("error"/"timeout"/"refused") for backward compat
 * when reading old stored runs; the normalizer coerces them to "failed".
 */
export const PanelResultPublicSchema = z.object({
  modelId: z.string(),
  status: z.enum(["ok", "substituted", "failed", "error", "timeout", "refused"]),
  rawTextFull: z.string(),
  rawText: z.string().optional(),
  latencyMs: z.number().nonnegative(),
  tokenUsage: TokenUsageNormalizedSchema,
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }).optional(),
  wasTruncatedForSynthesis: z.boolean().optional(),
  wasTruncatedForStorage: z.boolean().optional(),
  wasTruncated: z.boolean().optional(),
  // Per-slot metadata — requestedModel and actualModel are required at the public boundary
  requestedModel: z.string().optional(),
  provider: z.string().optional(),
  actualModel: z.string().optional(),
  substitutedFrom: SubstitutedFromSchema,
  substitutionReason: z.string().optional(),
});

/**
 * TypeScript interface matching the Zod schema (post-normalization).
 * After normalization:
 *  - status is always "ok" | "substituted" | "failed"
 *  - requestedModel and actualModel are always present
 *  - substitutedFrom is always a string in "<provider>:<model>" format (when present)
 */
export interface PanelResultPublic {
  modelId: ModelId;
  status: ModelStatus;
  rawTextFull: string;
  rawText?: string;
  latencyMs: number;
  tokenUsage: TokenUsageNormalized;
  error?: {
    message: string;
    code?: string;
  };
  wasTruncatedForSynthesis?: boolean;
  wasTruncatedForStorage?: boolean;
  wasTruncated?: boolean;
  requestedModel: string;
  provider: string;
  actualModel: string;
  substitutedFrom?: string;
  substitutionReason?: string;
}

/**
 * Minimal panel result for synthesis (only text needed)
 */
export interface PanelForSynthesis {
  modelId: ModelId;
  status: ConnectorStatus;
  text: string;
}

/**
 * Zod schema for synthesize-panel request body
 * Accepts array of PanelResultPublic
 */
export const SynthesizePanelRequestSchema = z.object({
  question: z.string().min(1).max(5000),
  results: z.array(PanelResultPublicSchema).min(2), // At least 2 results
});

export type SynthesizePanelRequest = z.infer<typeof SynthesizePanelRequestSchema>;

/**
 * Firestore RunDocument minimal schema
 * Stores only essential data - no rawResponse, minimal payload
 */
export interface RunDocument {
  runId: string;
  userId: string;
  createdAt: any; // Firestore Timestamp
  question: string;
  selectedModels: string[];
  perModel: Array<{
    modelId: string;
    status: ConnectorStatus;
    rawTextTruncated: string;
    latencyMs: number;
    tokenUsage: TokenUsageNormalized;
    wasTruncated: boolean;
  }>;
  synthesizedAnswer?: string;
  totals: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  flags: {
    storageTruncated: boolean;
    synthesisTruncated: boolean;
  };
}

