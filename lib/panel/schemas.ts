/**
 * Panel Schemas and Validation
 * 
 * Type definitions and Zod schemas for panel data structures.
 */

import { z } from "zod";
import { ModelId, ModelStatus } from "@/lib/types";
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
 * Panel result public schema (Zod)
 * This is what run-panel returns and synthesize-panel accepts.
 * rawResponse is NEVER included - only rawTextFull (full canonical text for UI display).
 */
export const PanelResultPublicSchema = z.object({
  modelId: z.string(),
  status: z.enum(["ok", "error", "timeout", "refused"]),
  rawTextFull: z.string(), // Full canonical text for UI display - never truncated
  rawText: z.string().optional(), // Deprecated: use rawTextFull instead
  latencyMs: z.number().nonnegative(),
  tokenUsage: TokenUsageNormalizedSchema,
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }).optional(),
  // Optional truncation flags for synthesis/storage (not for UI display)
  wasTruncatedForSynthesis: z.boolean().optional(),
  wasTruncatedForStorage: z.boolean().optional(),
  // Model output truncation (e.g., Gemini MAX_OUTPUT_TOKENS)
  wasTruncated: z.boolean().optional(), // True if model response hit max output tokens limit
});

/**
 * TypeScript interface matching the Zod schema
 * UI should use rawTextFull for display, never truncated versions
 */
export interface PanelResultPublic {
  modelId: ModelId;
  status: ModelStatus;
  rawTextFull: string; // Full canonical text for UI display - never truncated
  rawText?: string; // Deprecated: kept for backward compatibility, use rawTextFull
  latencyMs: number;
  tokenUsage: TokenUsageNormalized;
  error?: {
    message: string;
    code?: string;
  };
  // Optional truncation flags (for internal use, not for UI display)
  wasTruncatedForSynthesis?: boolean;
  wasTruncatedForStorage?: boolean;
  // Model output truncation (e.g., Gemini MAX_OUTPUT_TOKENS)
  wasTruncated?: boolean; // True if model response hit max output tokens limit
}

/**
 * Minimal panel result for synthesis (only text needed)
 */
export interface PanelForSynthesis {
  modelId: ModelId;
  status: ModelStatus;
  text: string; // Sanitized and truncated for synthesis
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
    status: ModelStatus;
    rawTextTruncated: string; // Truncated for storage
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

