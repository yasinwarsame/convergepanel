"use client";

/**
 * Model Picker Component
 * 
 * Allows users to select which models to include in a panel run.
 * Enforces plan-based model limits on the client side for better UX.
 * Server-side enforcement remains the source of truth.
 */

import { ModelId } from "@/lib/types";
import { PANEL_MODELS, PanelModelId } from "@/lib/panelModels";
import { useState } from "react";
import { PlanId, getPlanConfig } from "@/lib/plans";
import { Check } from "lucide-react";

const MODEL_DOT_COLORS: Record<PanelModelId, string> = {
  chatgpt: "bg-emerald-500",
  claude: "bg-indigo-500",
  grok: "bg-amber-500",
  perplexity: "bg-sky-500",
  gemini: "bg-rose-500",
};

interface ModelPickerProps {
  selectedModels: PanelModelId[];
  onSelectionChange: (models: PanelModelId[]) => void;
  maxModels?: number; // Optional override, otherwise uses plan limit
  plan?: PlanId | null; // User's plan ("free" | "lite" | "full")
}

type PanelPreset = "two" | "three" | "five";

const PRESETS: Record<PanelPreset, { models: PanelModelId[]; label: string }> = {
  two: {
    models: ["chatgpt", "claude"],
    label: "2-Model Panel",
  },
  three: {
    models: ["chatgpt", "claude", "grok"],
    label: "3-Model Panel",
  },
  five: {
    models: ["chatgpt", "claude", "grok", "perplexity", "gemini"],
    label: "5-Model Panel",
  },
};

const MIN_MODELS = 2; // Minimum 2 models required

export default function ModelPicker({
  selectedModels,
  onSelectionChange,
  maxModels,
  plan = null,
}: ModelPickerProps) {
  // Determine max models based on plan or override
  // Plans: Free=2, Lite=3, Full=5 (normalize 4→5 for legacy)
  const rawMaxModels = maxModels ?? (plan ? getPlanConfig(plan).maxModelsPerRun : 5);
  const effectiveMaxModels = rawMaxModels === 4 ? 5 : rawMaxModels; // Only normalize 4→5, keep 2/3/5 as-is
  
  // Dev assertion: maxModels must be in [2, 3, 5]
  if (process.env.NODE_ENV !== "production" && effectiveMaxModels !== 2 && effectiveMaxModels !== 3 && effectiveMaxModels !== 5) {
    console.error(`[ModelPicker] CRITICAL: effectiveMaxModels is ${effectiveMaxModels}, expected 2, 3, or 5.`);
  }
  
  const isFree = plan === "free";

  // Use PANEL_MODELS as the single source of truth for all model data
  // Default preset based on maxModels: 2 → "two", 3 → "three", 5 → "five"
  const defaultPreset: PanelPreset = 
    effectiveMaxModels === 2 ? "two" :
    effectiveMaxModels === 3 ? "three" : "five";
  const [preset, setPreset] = useState<PanelPreset>(defaultPreset);

  const handlePresetChange = (newPreset: PanelPreset) => {
    setPreset(newPreset);
    const presetModels = PRESETS[newPreset].models;
    // Limit to effectiveMaxModels if preset exceeds it
    // This ensures Free users (maxModels=2) can never select more than 2, even if they somehow select a 3/5 preset
    const limitedModels = presetModels.slice(0, effectiveMaxModels);
    onSelectionChange(limitedModels);
    
    // Dev assertion: verify selection doesn't exceed plan limit
    if (process.env.NODE_ENV !== "production" && limitedModels.length > effectiveMaxModels) {
      console.error(`[ModelPicker] CRITICAL: Preset selection (${limitedModels.length}) exceeds plan limit (${effectiveMaxModels}).`);
    }
  };

  const handleModelToggle = (modelId: PanelModelId) => {
    if (selectedModels.includes(modelId)) {
      // Trying to uncheck - only allowed if >2 models selected (minimum requirement)
      if (selectedModels.length > MIN_MODELS) {
        onSelectionChange(selectedModels.filter((id) => id !== modelId));
        // Update preset if selection doesn't match any preset
        const matchesPreset = Object.values(PRESETS).some(
          (p) => JSON.stringify(p.models.sort()) === JSON.stringify(selectedModels.filter((id) => id !== modelId).sort())
        );
        if (!matchesPreset) {
          // Reset to appropriate preset based on selection count
          const newCount = selectedModels.filter((id) => id !== modelId).length;
          setPreset(
            newCount === 2 ? "two" :
            newCount === 3 ? "three" : "five"
          );
        }
      }
    } else {
      // Check plan-based limit before adding
      if (selectedModels.length >= effectiveMaxModels) {
        // Can't add more models (reached plan limit)
        return;
      }
      onSelectionChange([...selectedModels, modelId]);
      // Update preset if selection doesn't match any preset
      const matchesPreset = Object.values(PRESETS).some(
        (p) => JSON.stringify(p.models.sort()) === JSON.stringify([...selectedModels, modelId].sort())
      );
      if (!matchesPreset) {
        // Reset to appropriate preset based on selection count
        const newCount = [...selectedModels, modelId].length;
        setPreset(
          newCount === 2 ? "two" :
          newCount === 3 ? "three" : "five"
        );
      }
    }
  };

  // Enforce minimum (2 models) and maximum based on plan
  const isMinimumReached = selectedModels.length <= MIN_MODELS;
  const isMaxReached = selectedModels.length >= effectiveMaxModels;
  // For Free users: disable all unselected models when 2 are already selected
  // For other plans: disable unselected models when max is reached
  const disableAnother = selectedModels.length >= effectiveMaxModels;

  return (
    <div className="space-y-5">
      {/* NOTE: For MVP testing, all five models (ChatGPT, Claude, Grok, Perplexity, Gemini 3 Pro)
          are fully enabled regardless of plan. Gating will be reintroduced later. */}

      {/* Panel Preset Select */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-cp-faint">Preset</p>
        <select
          value={preset}
          onChange={(e) => handlePresetChange(e.target.value as PanelPreset)}
          className="block w-full rounded-[10px] border border-cp-border bg-cp-surface px-3 py-2.5 text-sm font-medium text-cp-text shadow-sm focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-primary-soft"
        >
          {effectiveMaxModels >= 2 && <option value="two">2-Model Panel</option>}
          {effectiveMaxModels >= 3 && <option value="three">3-Model Panel</option>}
          {effectiveMaxModels >= 5 && <option value="five">5-Model Panel</option>}
        </select>
      </div>

      {/* Model Rows */}
      {/* Use PANEL_MODELS as the single source of truth so Run Panel buttons
          and Agreement/Disagreement Map badges always match colors and labels. */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-cp-faint">Models</p>
        <div className="flex flex-col gap-2">
          {PANEL_MODELS.map((model) => {
            const isSelected = selectedModels.includes(model.id);
            // Disable based on plan limits:
            // - Disable unchecking if we're at minimum (2 models)
            // - Disable checking if we're at maximum (plan limit)
            const isDisabled = (isSelected && isMinimumReached) || (!isSelected && disableAnother);

            // Tooltip message for disabled unselected models (Free plan upgrade prompt)
            const tooltipMessage = !isSelected && disableAnother && isFree
              ? "Free plan allows up to 2 models per run. Upgrade to run 3 or 5 models."
              : !isSelected && disableAnother
              ? `Your plan allows up to ${effectiveMaxModels} models per run. Upgrade to run more.`
              : isSelected && isMinimumReached
              ? "You must select at least 2 models."
              : null;

            const dotColor = MODEL_DOT_COLORS[model.id];

            return (
              <div key={model.id} className="relative group">
                <button
                  type="button"
                  onClick={() => handleModelToggle(model.id)}
                  disabled={isDisabled}
                  className={`relative flex w-full items-center gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 ${
                    isSelected
                      ? "border-[1.5px] border-cp-primary bg-cp-primary-tint text-cp-text"
                      : "border-cp-border bg-cp-surface text-cp-text hover:border-cp-faint"
                  } ${isDisabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
                  title={tooltipMessage || undefined}
                >
                  <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border ${
                    isSelected ? "border-cp-primary bg-cp-primary" : "border-cp-border bg-cp-surface"
                  }`}>
                    {isSelected && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
                  </span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden />
                  <span className="flex-1">{model.label}</span>
                </button>
                {/* Tooltip for disabled models */}
                {tooltipMessage && (
                  <div className="absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 transform group-hover:block">
                    <div className="whitespace-nowrap rounded-lg bg-cp-text px-3 py-2 text-xs text-cp-bg shadow-lg">
                      {tooltipMessage}
                      <div className="absolute top-full left-1/2 -mt-1 -translate-x-1/2 transform">
                        <div className="border-4 border-transparent border-t-cp-text"></div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Helper Text */}
      <p className="text-xs text-cp-muted">
        {selectedModels.length} of up to {effectiveMaxModels} models selected.
        {plan === "free" && " Free plan allows up to 2 models per run."}
        {plan === "lite" && " 3-Model plan allows up to 3 per run."}
        {plan === "full" && " Full Plan allows up to 5 per run."}
        {!plan && ` You can use up to ${effectiveMaxModels} models at once.`}
      </p>
    </div>
  );
}
