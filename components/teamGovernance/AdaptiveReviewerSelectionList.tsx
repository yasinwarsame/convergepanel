"use client";

/**
 * Multi-Reviewer Owner Override, Part F (§F12) — accessible reviewer
 * selection for creating or reconfiguring a panel. Reused identically for
 * BOTH create and reconfigure — the eligibility rules and bounds are the
 * same either way. Shows only `displayName` (already server-resolved via
 * `GET .../assignment`'s existing `eligibleReviewers`, the same eligible
 * set — owner|admin roles — this codebase already establishes for
 * single-reviewer assignment) — never an email. Duplicate selection is
 * structurally impossible: each reviewer is a single checkbox, toggled by
 * userId.
 */

import { MIN_ADAPTIVE_PANEL_REVIEWERS, MAX_ADAPTIVE_PANEL_REVIEWERS } from "@/lib/governance/adaptiveHumanReviewPanel";

export type EligiblePanelReviewer = { userId: string; displayName: string };

export default function AdaptiveReviewerSelectionList({
  eligibleReviewers,
  selected,
  onChange,
  disabled,
}: {
  eligibleReviewers: EligiblePanelReviewer[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const atMax = selected.length >= MAX_ADAPTIVE_PANEL_REVIEWERS;

  const toggle = (userId: string) => {
    if (selected.includes(userId)) {
      onChange(selected.filter((id) => id !== userId));
    } else {
      if (atMax) return;
      onChange([...selected, userId]);
    }
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-cp-text">
        Select reviewers ({selected.length}/{MAX_ADAPTIVE_PANEL_REVIEWERS})
      </legend>
      <p className="text-xs text-cp-muted">
        Choose between {MIN_ADAPTIVE_PANEL_REVIEWERS} and {MAX_ADAPTIVE_PANEL_REVIEWERS} eligible team members.
      </p>
      {eligibleReviewers.length === 0 ? (
        <p className="text-xs text-cp-muted">No eligible team members are available.</p>
      ) : (
        <ul role="listbox" aria-multiselectable="true" className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-cp-border p-2">
          {eligibleReviewers.map((reviewer) => {
            const checked = selected.includes(reviewer.userId);
            const disableThisOption = disabled || (!checked && atMax);
            return (
              <li key={reviewer.userId}>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    checked ? "bg-cp-primary-soft text-cp-text" : "text-cp-text hover:bg-cp-raised"
                  } ${disableThisOption ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disableThisOption}
                    onChange={() => toggle(reviewer.userId)}
                    className="h-4 w-4 shrink-0 accent-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                  />
                  {reviewer.displayName}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {atMax ? <p className="text-xs text-cp-muted">Maximum of {MAX_ADAPTIVE_PANEL_REVIEWERS} reviewers reached.</p> : null}
    </fieldset>
  );
}
