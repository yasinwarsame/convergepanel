/**
 * Model Information (Client-Safe)
 * 
 * This module provides model display names and metadata that can be safely
 * used in client components. It has no server dependencies (no Firebase, no
 * connectors, no file system).
 * 
 * IMPORTANT: This is separate from lib/connectors because connectors use
 * server-only code (Firestore, API keys). Client components should use
 * this module instead to avoid client/server boundary issues.
 */

import { ModelId } from "./types";
import { getPanelModelConfig, PanelModelId, isValidPanelModelId } from "./panelModels";

/**
 * Model information mapping (DEPRECATED - use panelModels.ts instead)
 * 
 * @deprecated Use getPanelModelConfig() from lib/panelModels.ts instead.
 * This is kept for backward compatibility but will be removed in a future version.
 * 
 * The single source of truth for model metadata is now lib/panelModels.ts.
 */
export const MODEL_INFO: Record<ModelId, { displayName: string }> = {
  chatgpt: { displayName: "GPT 5.1" },
  claude: { displayName: "Claude Opus 4.5" },
  grok: { displayName: "Grok 4" },
  perplexity: { displayName: "Perplexity Pro" },
  gemini: { displayName: "Gemini 3 Pro" },
};

/**
 * Get display name for a model
 * 
 * @deprecated Use getPanelModelConfig() from lib/panelModels.ts instead.
 * 
 * @param modelId - The model identifier
 * @returns Human-readable display name, or modelId if not found
 */
export function getModelDisplayName(modelId: ModelId | string): string {
  // Try to use panelModels first (single source of truth)
  if (isValidPanelModelId(modelId)) {
    return getPanelModelConfig(modelId).label;
  }
  // Fallback to old mapping for backward compatibility
  return MODEL_INFO[modelId as ModelId]?.displayName || modelId;
}

/**
 * Get all available model IDs
 * 
 * @returns Array of all supported model IDs
 */
export function getAllModelIds(): ModelId[] {
  return Object.keys(MODEL_INFO) as ModelId[];
}

