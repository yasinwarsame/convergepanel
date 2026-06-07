"use client";

/**
 * Model Picker Component
 * 
 * Allows users to select which models to include in a panel run.
 * Enforces plan-based model limits on the client side for better UX.
 * Server-side enforcement remains the source of truth.
 */

import { ModelId } from "@/lib/types";
import { PANEL_MODELS, PanelModelId, getPanelModelConfig } from "@/lib/panelModels";
import { useState } from "react";
import { PlanId, getPlanConfig } from "@/lib/plans";

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
    <div className="space-y-4">
      {/* NOTE: For MVP testing, all five models (ChatGPT, Claude, Grok, Perplexity, Gemini 3 Pro)
          are fully enabled regardless of plan. Gating will be reintroduced later. */}
      
      {/* Panel Preset Select */}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">Panel preset:</span>
          <span className="ml-2">Choose a default model set or customize below.</span>
        </div>
        <select
          value={preset}
          onChange={(e) => handlePresetChange(e.target.value as PanelPreset)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-200"
        >
          {effectiveMaxModels >= 2 && <option value="two">2-Model Panel</option>}
          {effectiveMaxModels >= 3 && <option value="three">3-Model Panel</option>}
          {effectiveMaxModels >= 5 && <option value="five">5-Model Panel</option>}
        </select>
      </div>

      {/* Model Buttons */}
      {/* Use PANEL_MODELS as the single source of truth so Run Panel buttons
          and Agreement/Disagreement Map badges always match colors and labels. */}
      <div className="mt-3 flex flex-wrap gap-3">
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

          // Get model config - this is the single source of truth for colors and labels
          const config = getPanelModelConfig(model.id);
          
          // Selected state colors (darker version of badge colors)
          // These match the color scheme from PANEL_MODELS but use darker shades for selected state
          const selectedColors = {
            chatgpt: "bg-emerald-600 text-white border-emerald-600",
            claude: "bg-indigo-600 text-white border-indigo-600",
            grok: "bg-amber-500 text-white border-amber-500",
            perplexity: "bg-sky-600 text-white border-sky-600",
            gemini: "bg-rose-600 text-white border-rose-600",
          }[model.id];
          
          const checkmarkColor = {
            chatgpt: "bg-emerald-600",
            claude: "bg-indigo-600",
            grok: "bg-amber-500",
            perplexity: "bg-sky-600",
            gemini: "bg-rose-600",
          }[model.id];

          return (
            <div key={model.id} className="relative group">
              <button
                type="button"
                onClick={() => handleModelToggle(model.id)}
                disabled={isDisabled}
                className={`relative flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-400 ${
                  isSelected
                    ? `${selectedColors} shadow-sm`
                    : `${config.colorClasses} hover:border-opacity-60 hover:bg-opacity-80`
                } ${isDisabled ? "opacity-70 cursor-not-allowed" : "cursor-pointer"}`}
                title={tooltipMessage || undefined}
              >
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded-sm border ${
                  isSelected ? "border-white" : "border-slate-300 bg-white"
                }`}>
                  {isSelected && <span className={`h-2 w-2 rounded-[2px] ${checkmarkColor}`} />}
                </span>
                {model.label}
              </button>
              {/* Tooltip for disabled models */}
              {tooltipMessage && (
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                  <div className="bg-slate-900 text-white text-xs rounded-lg py-2 px-3 whitespace-nowrap shadow-lg">
                    {tooltipMessage}
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                      <div className="border-4 border-transparent border-t-slate-900"></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Helper Text */}
      <p className="mt-1 text-xs text-slate-600">
        Select at least <span className="font-semibold">2 models</span>.
        {plan === "free" && (
          <> Free plan allows up to <span className="font-semibold">2 models</span> per run.</>
        )}
        {plan && plan !== "free" && (
          <> You can use up to <span className="font-semibold">{effectiveMaxModels} models</span> on your {getPlanConfig(plan).name} plan.</>
        )}
        {!plan && <> You can use up to {effectiveMaxModels} models at once.</>}
      </p>
    </div>
  );
}
