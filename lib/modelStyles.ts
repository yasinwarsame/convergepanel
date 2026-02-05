/**
 * Centralized Model Color Styles
 * 
 * This module provides consistent color mappings for model badges and selectors
 * across the application. When a model's color is updated here, it automatically
 * applies to both the model selection buttons and the Agreement/Disagreement Map badges.
 * 
 * Colors are based on Tailwind CSS utility classes and match the visual identity
 * established in the ModelPicker component.
 */

import { ModelId } from "./types";

/**
 * Centralized color mapping for all models so UI stays consistent.
 * 
 * DEPRECATED: Use getPanelModelConfig() from lib/panelModels.ts instead.
 * This file is kept for backward compatibility but will be removed in a future version.
 * 
 * The single source of truth for model colors is now lib/panelModels.ts.
 * 
 * @deprecated Use getPanelModelConfig(modelId).colorClasses from lib/panelModels.ts
 */
export const MODEL_COLOR_CLASSES: Record<string, string> = {
  chatgpt: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  claude: "bg-indigo-50 text-indigo-700 border border-indigo-200", // Updated to match panelModels.ts
  grok: "bg-amber-50 text-amber-700 border border-amber-200",
  perplexity: "bg-sky-50 text-sky-700 border border-sky-200",
  gemini: "bg-rose-50 text-rose-700 border border-rose-200",
};

/**
 * Default color for unknown models
 */
export const DEFAULT_MODEL_COLOR = "bg-slate-50 text-slate-700 border border-slate-200";

/**
 * Normalize model IDs/names coming from different places into our canonical keys.
 * 
 * Handles variations like:
 * - "chatgpt" -> "chatgpt"
 * - "grok-4-fast-reasoning" -> "grok"
 * - "sonar" -> "perplexity"
 * - "claude-3-opus" -> "claude"
 * 
 * @param raw - Raw model identifier from any source
 * @returns Canonical model key for color lookup
 */
export function getModelColorKey(raw: string): string {
  if (!raw) return "default";
  
  const lower = raw.toLowerCase();

  if (lower.includes("chatgpt") || lower.includes("openai") || lower.includes("gpt")) {
    return "chatgpt";
  }
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return "claude";
  }
  if (lower.includes("grok") || lower.includes("xai")) {
    return "grok";
  }
  if (lower.includes("perplexity") || lower.includes("sonar")) {
    return "perplexity";
  }

  return "default";
}

/**
 * Base color classes for model badges (unselected state)
 * 
 * These colors are used for:
 * - Model badges in Agreement/Disagreement Map
 * - Unselected model buttons in ModelPicker
 * 
 * Format: background, text color, and border color
 */
export const MODEL_BADGE_COLORS: Record<ModelId, string> = {
  chatgpt: MODEL_COLOR_CLASSES.chatgpt,
  claude: MODEL_COLOR_CLASSES.claude,
  grok: MODEL_COLOR_CLASSES.grok,
  perplexity: MODEL_COLOR_CLASSES.perplexity,
  gemini: MODEL_COLOR_CLASSES.gemini,
};

/**
 * Get color classes for a model badge
 * 
 * Uses normalization to handle variations in model IDs (e.g., "grok-4-fast-reasoning" -> "grok")
 * 
 * @param modelId - The model identifier (can be any string)
 * @returns Tailwind CSS classes for the model badge, or default gray style if model not found
 */
export function getModelBadgeColors(modelId: ModelId | string): string {
  const colorKey = getModelColorKey(modelId);
  return MODEL_COLOR_CLASSES[colorKey] ?? DEFAULT_MODEL_COLOR;
}

/**
 * Model color configuration for selection buttons
 * 
 * Contains base (unselected), selected, and checkmark colors for each model.
 * Used in ModelPicker component for the toggle buttons.
 */
export interface ModelColorConfig {
  base: string; // Unselected state: border, text, background
  selected: string; // Selected state: background, text, border
  checkmark: string; // Checkmark color when selected
}

export const MODEL_COLOR_CONFIG: Record<ModelId, ModelColorConfig> = {
  chatgpt: {
    base: "border-emerald-200 text-emerald-800 bg-emerald-50",
    selected: "bg-emerald-600 text-white border-emerald-600",
    checkmark: "bg-emerald-600",
  },
  claude: {
    base: "border-violet-200 text-violet-800 bg-violet-50",
    selected: "bg-violet-600 text-white border-violet-600",
    checkmark: "bg-violet-600",
  },
  grok: {
    base: "border-amber-200 text-amber-800 bg-amber-50",
    selected: "bg-amber-500 text-white border-amber-500",
    checkmark: "bg-amber-500",
  },
  perplexity: {
    base: "border-sky-200 text-sky-800 bg-sky-50",
    selected: "bg-sky-600 text-white border-sky-600",
    checkmark: "bg-sky-600",
  },
  gemini: {
    base: "border-rose-200 text-rose-800 bg-rose-50",
    selected: "bg-rose-600 text-white border-rose-600",
    checkmark: "bg-rose-600",
  },
};

/**
 * Get color configuration for a model selection button
 * 
 * Uses normalization to handle variations in model IDs (e.g., "grok-4-fast-reasoning" -> "grok")
 * 
 * @param modelId - The model identifier (can be any string)
 * @returns Color configuration object, or default sky colors if model not found
 */
export function getModelColorConfig(modelId: ModelId | string): ModelColorConfig {
  const colorKey = getModelColorKey(modelId);
  const normalizedId = colorKey === "default" ? "perplexity" : (colorKey as ModelId);
  return MODEL_COLOR_CONFIG[normalizedId] ?? {
    base: "border-slate-200 text-slate-700 bg-white",
    selected: "bg-sky-600 text-white border-sky-600",
    checkmark: "bg-sky-600",
  };
}

