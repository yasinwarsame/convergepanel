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

export default function ModelChip({
  modelId,
  variant = "outline",
  size = "xs",
  className = "",
  uppercase = true,
}: ModelChipProps) {
  const config = getPanelModelConfig(modelId);
  const displayName = config.label;

  // Size classes
  const sizeClasses = {
    xs: "px-3 py-1 text-xs",
    sm: "px-3.5 py-1.5 text-sm",
    md: "px-4 py-2 text-base",
  };

  // Variant classes - use colorClasses directly from panelModels.ts
  let variantClasses: string;
  if (variant === "outline") {
    // Use the exact colorClasses from panelModels.ts (matches "Models in MVP" style)
    variantClasses = `${config.colorClasses} rounded-full font-semibold`;
  } else if (variant === "solid") {
    // Extract color and create solid variant
    // Parse colorClasses to get the color name (e.g., "emerald-700" -> "emerald-600")
    const colorMatch = config.colorClasses.match(/text-(\w+-\d+)/);
    const colorName = colorMatch ? colorMatch[1].replace("-700", "-600") : "slate-600";
    variantClasses = `bg-${colorName} text-white border border-${colorName} rounded-full font-semibold`;
  } else {
    // Text variant - extract just the text color
    const colorMatch = config.colorClasses.match(/text-(\w+-\d+)/);
    const colorName = colorMatch ? colorMatch[1] : "slate-700";
    variantClasses = `text-${colorName} font-semibold`;
  }

  const baseClasses = `${sizeClasses[size]} ${variantClasses}`;
  const trackingClass = uppercase ? "uppercase tracking-wide" : "";
  const combinedClasses = `${baseClasses} ${trackingClass} ${className}`.trim();

  return (
    <span className={combinedClasses}>
      {displayName}
    </span>
  );
}

