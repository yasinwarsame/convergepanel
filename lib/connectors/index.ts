/**
 * Connector Index
 * 
 * This module provides a centralized map of all model connectors.
 * Every ModelId must have an entry in CONNECTOR_MAP to ensure we can always
 * produce a result entry, even if the connector fails.
 * 
 * IMPORTANT: All ModelId values must have an entry here, even if their call will error.
 * This prevents models from silently disappearing from results.
 */

import { ModelId, ModelResult } from "@/lib/types";
import { callChatGPT } from "./chatgpt";
import { callClaude } from "./claude";
import { callGrok } from "./grok";
import { callPerplexity } from "./perplexity";
import { callGemini } from "./gemini";

/**
 * Connector function type
 * 
 * All connectors follow this signature:
 * - Takes: question (string), optional context (string | null), optional apiKey (string)
 * - Returns: Promise<ModelResult> (always returns a result, never throws)
 */
type ConnectorFunction = (
  question: string,
  context?: string | null,
  apiKey?: string
) => Promise<ModelResult>;

/**
 * Map of all known connectors by their stable model ID.
 * 
 * NOTE: All ModelId values must have an entry here, even if their call will error.
 * This ensures that for every selected model, we can always produce a result entry
 * (either status: "ok" or status: "error"), preventing models from silently disappearing.
 * 
 * If a connector is missing from this map, runPanel will return an error result
 * for that model instead of crashing or silently skipping it.
 */
export const CONNECTOR_MAP: Record<ModelId, ConnectorFunction> = {
  chatgpt: callChatGPT,
  claude: callClaude,
  grok: callGrok,
  perplexity: callPerplexity,
  gemini: callGemini,
};

/**
 * Get connector function for a model ID
 * 
 * @param modelId - The model identifier
 * @returns The connector function, or undefined if not found
 */
export function getConnector(modelId: ModelId): ConnectorFunction | undefined {
  return CONNECTOR_MAP[modelId];
}

/**
 * Check if a connector exists for a model ID
 * 
 * @param modelId - The model identifier
 * @returns True if connector exists, false otherwise
 */
export function hasConnector(modelId: ModelId): boolean {
  return modelId in CONNECTOR_MAP;
}
