"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — one decision choice,
 * rendered as an accessible radio input inside a label (never an icon-only
 * control, never color-only semantics).
 */

export default function AdaptiveReviewDecisionOption({
  name,
  value,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  value: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        checked ? "border-cp-accent bg-cp-primary-soft" : "border-cp-border bg-cp-surface hover:bg-cp-raised"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-1 h-4 w-4 shrink-0 accent-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
      />
      <span>
        <span className="block text-sm font-semibold text-cp-text">{label}</span>
        <span className="block text-xs text-cp-muted">{description}</span>
      </span>
    </label>
  );
}
