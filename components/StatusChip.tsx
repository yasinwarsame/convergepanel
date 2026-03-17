"use client";

import { PanelModelId, getModelPillClasses, getPanelModelConfig } from "@/lib/panelModels";

/**
 * Status Chip Component
 * 
 * Small status indicator with model-specific colors and status dot.
 * Used in the "Querying models" section while panel is running.
 * Uses the same color scheme as model selection buttons and badges for consistency.
 */

interface StatusChipProps {
  label: string;
  status: "queued" | "thinking" | "ok" | "substituted" | "failed";
  modelId?: PanelModelId | string;
}

export default function StatusChip({ label, status, modelId }: StatusChipProps) {
  // Get status-specific dot color (independent of model color)
  const getStatusDotColor = () => {
    switch (status) {
      case "queued":
        return "bg-slate-400";
      case "thinking":
        return "bg-yellow-400 animate-pulse";
      case "ok":
        return "bg-green-500";
      case "substituted":
        return "bg-amber-500";
      case "failed":
        return "bg-red-500";
      default:
        return "bg-slate-400";
    }
  };

  const dotColor = getStatusDotColor();

  // If modelId is provided, use model-specific colors for the pill
  // This ensures "Querying models" chips match the model color system
  if (modelId) {
    const pillClasses = getModelPillClasses(modelId);
    return (
      <span className={pillClasses}>
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor} mr-1.5`} />
        <span>{label}</span>
      </span>
    );
  }

  // Fallback: use neutral colors if no modelId provided (backward compatibility)
  const getStatusTextColor = () => {
    switch (status) {
      case "queued":
        return "text-slate-600";
      case "thinking":
        return "text-yellow-700";
      case "ok":
        return "text-green-700";
      case "substituted":
        return "text-amber-700";
      case "failed":
        return "text-slate-500";
      default:
        return "text-slate-600";
    }
  };

  return (
    <span className={`inline-flex items-center gap-1.5 ${getStatusTextColor()}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span className="text-xs">{label}</span>
    </span>
  );
}

