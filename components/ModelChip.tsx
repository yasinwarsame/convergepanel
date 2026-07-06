"use client";

/**
 * ModelChip Component
 * 
 * Reusable chip/badge component for displaying model names with consistent styling.
 * Uses the centralized model configuration from lib/panelModels.ts to ensure
 * all model names across the app use the same colors.
 * 
 * Variants:
 * - "outline": Outlined pill chip (default, matches "Models in MVP" style)
 * - "solid": Solid background chip
 * - "text": Text-only with color (for headings/labels)
 */

import { PanelModelId, getPanelModelConfig } from "@/lib/panelModels";

interface ModelChipProps {
  modelId: PanelModelId | string;
  variant?: "outline" | "solid" | "text";
  size?: "xs" | "sm" | "md";
  className?: string;
  uppercase?: boolean;
}

// Small 2px identity dot per model — the only place model color shows up.
// Neutral chip background/border/text everywhere else (no rainbow pills).
const MODEL_DOT_COLORS: Record<string, string> = {
  chatgpt: "bg-emerald-500",
  claude: "bg-indigo-500",
  grok: "bg-amber-500",
  perplexity: "bg-sky-500",
  gemini: "bg-rose-500",
};

export default function ModelChip({
  modelId,
  variant = "outline",
  size = "xs",
  className = "",
  uppercase = true,
}: ModelChipProps) {
  const config = getPanelModelConfig(modelId);
  const displayName = config.label;
  const dotColor = MODEL_DOT_COLORS[modelId] ?? "bg-cp-faint";

  // Size classes
  const sizeClasses = {
    xs: "px-3 py-1 text-xs",
    sm: "px-3.5 py-1.5 text-sm",
    md: "px-4 py-2 text-base",
  };

  // Variant classes - neutral surfaces; the dot carries model identity
  let variantClasses: string;
  if (variant === "outline") {
    variantClasses = "bg-cp-surface text-cp-text border border-cp-border rounded-full font-semibold";
  } else if (variant === "solid") {
    variantClasses = "bg-cp-text text-cp-bg border border-cp-text rounded-full font-semibold";
  } else {
    variantClasses = "text-cp-text font-semibold";
  }

  const baseClasses = `${sizeClasses[size]} ${variantClasses}`;
  const trackingClass = uppercase ? "uppercase tracking-wide" : "";
  const combinedClasses = `inline-flex items-center gap-1.5 ${baseClasses} ${trackingClass} ${className}`.trim();

  return (
    <span className={combinedClasses}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden />
      {displayName}
    </span>
  );
}

