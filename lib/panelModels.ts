/**
 * Panel Models - Single Source of Truth
 * 
 * This is the ONLY canonical place for model IDs, labels, and colors.
 * Both the Run Panel selection buttons and the Agreement/Disagreement Map badges
 * must use this exact same data to ensure perfect consistency.
 * 
 * IMPORTANT: If you need to add a new model or change a color, update ONLY this file.
 * All other components will automatically use the updated values.
 */

export type PanelModelId = "chatgpt" | "claude" | "grok" | "perplexity" | "gemini";

export interface PanelModelConfig {
  id: PanelModelId;
  label: string;
  provider: "openai" | "anthropic" | "xai" | "perplexity" | "google";
  // Tailwind classes used for both selector buttons and badges
  colorClasses: string;
}

/**
 * Single source of truth: IDs, labels, and colors for all panel models.
 * 
 * This array defines:
 * - Canonical model IDs (used throughout frontend and backend)
 * - Display labels (shown in UI)
 * - Provider names (for API key lookup)
 * - Color classes (for consistent styling across buttons and badges)
 */
export const PANEL_MODELS: PanelModelConfig[] = [
  {
    id: "chatgpt",
    label: "GPT 5.1",
    provider: "openai",
    colorClasses: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  },
  {
    id: "claude",
    label: "Claude Opus 4.5",
    provider: "anthropic",
    colorClasses: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  },
  {
    id: "grok",
    label: "Grok 4",
    provider: "xai",
    colorClasses: "bg-amber-50 text-amber-700 border border-amber-200",
  },
  {
    id: "perplexity",
    label: "Perplexity Pro",
    provider: "perplexity",
    colorClasses: "bg-sky-50 text-sky-700 border border-sky-200",
  },
  {
    id: "gemini",
    label: "Gemini 2.0 Flash", // Updated to match actual model ID: gemini-2.0-flash
    provider: "google",
    colorClasses: "bg-rose-50 text-rose-700 border border-rose-200",
  },
];

/**
 * Get panel model configuration by ID
 * 
 * Safe version that never throws - returns a fallback config for unknown IDs.
 * This prevents UI crashes when model IDs are missing or malformed.
 * 
 * @param id - Canonical panel model ID (can be any string, will be validated)
 * @returns PanelModelConfig for the given ID, or a safe fallback if ID is unknown
 */
export function getPanelModelConfig(id: PanelModelId | string): PanelModelConfig {
  const model = PANEL_MODELS.find((m) => m.id === id);
  if (!model) {
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
      console.warn("[ConvergePanel] Unknown PanelModelId in PanelResponses:", id);
    }
    // Fallback with neutral styling so UI never crashes
    return {
      id: id as PanelModelId,
      label: id,
      provider: "openai",
      colorClasses: "bg-slate-50 text-slate-700 border border-slate-200",
    } as PanelModelConfig;
  }
  return model;
}

/**
 * Get all panel model IDs
 * 
 * @returns Array of all canonical model IDs
 */
export function getAllPanelModelIds(): PanelModelId[] {
  return PANEL_MODELS.map((m) => m.id);
}

/**
 * Check if a string is a valid PanelModelId
 * 
 * @param id - String to check
 * @returns True if id is a valid PanelModelId
 */
export function isValidPanelModelId(id: string): id is PanelModelId {
  return PANEL_MODELS.some((m) => m.id === id);
}

/**
 * Safe helper to get a human-readable name for a model ID.
 * 
 * Never throws - always returns a string, even for unknown/missing IDs.
 * This prevents UI crashes when model IDs are missing or malformed.
 * 
 * @param rawId - Model identifier (can be string, null, undefined, or any value)
 * @returns Human-readable model label, or "Unknown model" if ID is missing/invalid
 */
export function getModelDisplayNameSafe(rawId?: string | null): string {
  if (!rawId) {
    return "Unknown model";
  }

  const id = rawId as PanelModelId;
  const match = PANEL_MODELS.find((m) => m.id === id);

  if (match) {
    return match.label;
  }

  // Log once in dev so we notice mis-wired IDs, but don't crash the UI.
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    console.warn("[ConvergePanel] Unknown modelId in results:", rawId);
  }

  // Fall back to the raw ID so the user still sees *something*.
  return rawId;
}

/**
 * Get Tailwind classes for model pill labels (small chips/badges)
 * 
 * Used for small pill labels like "Querying models" chips, status badges, etc.
 * These use the same color scheme as model selection buttons and Agreement/Disagreement Map badges.
 * 
 * @param modelId - Canonical panel model ID
 * @returns Tailwind classes for the model pill (background, text, border)
 */
export function getModelPillClasses(modelId: PanelModelId | string): string {
  const config = getPanelModelConfig(modelId);
  // Use the same colorClasses from PANEL_MODELS for consistency
  // This ensures "Querying models" chips match model buttons and badges
  return `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${config.colorClasses}`;
}

