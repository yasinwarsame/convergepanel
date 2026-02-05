/**
 * Normalize Selected Models
 * 
 * Ensures selected models array respects plan limits (min 2, max based on plan).
 * This is the single source of truth for model selection normalization.
 * 
 * Rules:
 * - Remove duplicates and unknown providers
 * - If selected.length > maxModels: trim to maxModels using defaultOrder preference
 * - If selected.length < minModels: add providers from defaultOrder until minModels reached
 * - Always return at least 2 models (minimum requirement)
 * - For Free users (maxModels=2): always return exactly 2 if there are >=2 available
 */

import { ModelId } from "@/lib/types";
import { PanelModelId, PANEL_MODELS } from "@/lib/panelModels";

// Default order of models (preferred selection order)
const DEFAULT_MODEL_ORDER: PanelModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

const MIN_MODELS = 2; // Minimum 2 models required for all plans

/**
 * Normalize selected models array to respect plan limits
 * 
 * @param selected - Current selected model IDs
 * @param maxModels - Maximum models allowed for the user's plan (2, 3, or 5)
 * @param minModels - Minimum models required (default: 2)
 * @param defaultOrder - Preferred order for adding models (default: DEFAULT_MODEL_ORDER)
 * @returns Normalized array of model IDs
 */
export function normalizeSelectedModels(
  selected: ModelId[] | PanelModelId[],
  maxModels: number,
  minModels: number = MIN_MODELS,
  defaultOrder: PanelModelId[] = DEFAULT_MODEL_ORDER
): PanelModelId[] {
  // Validate maxModels is one of [2, 3, 5]
  if (maxModels !== 2 && maxModels !== 3 && maxModels !== 5) {
    if (process.env.NODE_ENV !== "production") {
      console.error(`[normalizeSelectedModels] Invalid maxModels: ${maxModels}, expected 2, 3, or 5. Defaulting to 2.`);
    }
    maxModels = 2; // Safe fallback
  }

  // Get valid model IDs from PANEL_MODELS (single source of truth)
  const validModelIds = new Set(PANEL_MODELS.map(m => m.id));

  // Step 1: Remove duplicates and invalid models
  const uniqueValid = Array.from(new Set(selected.filter(id => validModelIds.has(id as PanelModelId)))) as PanelModelId[];

  // Step 2: If exceeds maxModels, trim to maxModels using defaultOrder preference
  let normalized: PanelModelId[];
  if (uniqueValid.length > maxModels) {
    // Keep models in order of preference (defaultOrder), up to maxModels
    normalized = [];
    for (const modelId of defaultOrder) {
      if (uniqueValid.includes(modelId) && normalized.length < maxModels) {
        normalized.push(modelId);
      }
    }
    // If we still don't have enough (edge case), add remaining valid models
    for (const modelId of uniqueValid) {
      if (!normalized.includes(modelId) && normalized.length < maxModels) {
        normalized.push(modelId);
      }
    }
  } else {
    normalized = uniqueValid;
  }

  // Step 3: If below minModels, add models from defaultOrder until minModels reached
  if (normalized.length < minModels) {
    for (const modelId of defaultOrder) {
      if (!normalized.includes(modelId) && normalized.length < minModels) {
        normalized.push(modelId);
      }
    }
    // If we still don't have enough (edge case), add any available models
    for (const modelId of PANEL_MODELS.map(m => m.id)) {
      if (!normalized.includes(modelId) && normalized.length < minModels) {
        normalized.push(modelId);
      }
    }
  }

  // Step 4: Ensure we have at least minModels (should always be true after step 3, but defensive)
  if (normalized.length < minModels) {
    if (process.env.NODE_ENV !== "production") {
      console.error(`[normalizeSelectedModels] Could not reach minModels (${minModels}). Available models: ${PANEL_MODELS.length}`);
    }
    // Return whatever we have (shouldn't happen, but prevents crash)
    return normalized.length > 0 ? normalized : defaultOrder.slice(0, minModels);
  }

  // Step 5: For Free users (maxModels=2), ensure exactly 2 models (not more, not less)
  if (maxModels === 2 && normalized.length > 2) {
    normalized = normalized.slice(0, 2);
  }

  // Dev assertion: verify final result
  if (process.env.NODE_ENV !== "production") {
    if (normalized.length < minModels) {
      console.error(`[normalizeSelectedModels] Result has ${normalized.length} models, expected at least ${minModels}`);
    }
    if (normalized.length > maxModels) {
      console.error(`[normalizeSelectedModels] Result has ${normalized.length} models, expected at most ${maxModels}`);
    }
  }

  return normalized;
}

/**
 * Get default model selection for a plan
 * 
 * @param maxModels - Maximum models allowed for the user's plan (2, 3, or 5)
 * @param defaultOrder - Preferred order for models (default: DEFAULT_MODEL_ORDER)
 * @returns Default array of model IDs for the plan
 */
export function getDefaultModelSelection(
  maxModels: number,
  defaultOrder: PanelModelId[] = DEFAULT_MODEL_ORDER
): PanelModelId[] {
  return normalizeSelectedModels([], maxModels, MIN_MODELS, defaultOrder);
}

