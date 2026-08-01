"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — bounded conditions
 * editor for the "Approve with Conditions" decision
 * (docs/governance-decision-receipts-design.md §26.5). Plain text only —
 * no rich text, no markdown, no HTML, no nesting, no drag-and-drop. Draft
 * conditions live only in the parent's in-memory form state — never
 * persisted anywhere (not Firestore, not localStorage/sessionStorage).
 */

import { MAX_REVIEW_CONDITIONS_COUNT, MAX_REVIEW_CONDITION_LENGTH } from "@/lib/governance/adaptiveReviewFormContract";

export default function AdaptiveReviewConditionsEditor({
  conditions,
  onChange,
  disabled,
}: {
  conditions: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const atMaxCount = conditions.length >= MAX_REVIEW_CONDITIONS_COUNT;

  const updateAt = (index: number, value: string) => {
    const next = [...conditions];
    next[index] = value;
    onChange(next);
  };

  const removeAt = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
  };

  const add = () => {
    if (atMaxCount) return;
    onChange([...conditions, ""]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-cp-text">Conditions</span>
        <span className="text-xs text-cp-muted">
          {conditions.length}/{MAX_REVIEW_CONDITIONS_COUNT}
        </span>
      </div>

      <ul className="space-y-2">
        {conditions.map((condition, index) => {
          const nearLimit = condition.length >= MAX_REVIEW_CONDITION_LENGTH - 40;
          const overLimit = condition.length > MAX_REVIEW_CONDITION_LENGTH;
          return (
            <li key={index} className="flex items-start gap-2">
              <label className="sr-only" htmlFor={`adaptive-review-condition-${index}`}>
                Condition {index + 1}
              </label>
              <div className="flex-1">
                <input
                  id={`adaptive-review-condition-${index}`}
                  type="text"
                  value={condition}
                  disabled={disabled}
                  onChange={(e) => updateAt(index, e.target.value)}
                  className="w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent disabled:opacity-60"
                  placeholder={`Condition ${index + 1}`}
                />
                {nearLimit ? (
                  <p className={`mt-1 text-xs ${overLimit ? "text-red-400" : "text-cp-muted"}`}>
                    {condition.length}/{MAX_REVIEW_CONDITION_LENGTH}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => removeAt(index)}
                disabled={disabled}
                aria-label={`Remove condition ${index + 1}`}
                className="rounded-md border border-cp-border px-2 py-2 text-xs font-medium text-cp-muted hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={add}
        disabled={disabled || atMaxCount}
        className="rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
      >
        + Add condition
      </button>
    </div>
  );
}
