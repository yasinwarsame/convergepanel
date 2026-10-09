"use client";

/**
 * Step 6 D5.2A — "Consensus thresholds by score type" (Governance Dashboard, Policies tab).
 *
 * Every control here corresponds to behaviour the evaluator actually enforces:
 * - Default review threshold → `minConsensusToAvoidReview`, used by any score
 *   type without its own value.
 * - Video / Research → optional `scoreFamilyReviewThresholds` overrides. Blank
 *   means "uses default". Editable only when family writes are enabled server-side.
 * - Claims → no control: the general threshold is not decision-binding for
 *   current claim verification behaviour (see lib/governance/familyReviewThresholds.ts).
 * - Legacy approval value (`minConsensusToApprove`) → read-only; never used.
 */
import type { GovernancePolicy } from "@/lib/governance/evaluateGovernance";
import type { FamilyReviewThresholdFamily } from "@/lib/governance/familyReviewThresholds";

type Props = {
  policy: GovernancePolicy;
  isAdminUser: boolean;
  /** Server capability `familyReviewThresholdWritesEnabled` from the policy GET. */
  familyWritesEnabled: boolean;
  onChange: (next: GovernancePolicy) => void;
};

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-cp-text disabled:opacity-50";

const FAMILY_ROWS: ReadonlyArray<{ family: FamilyReviewThresholdFamily; label: string; help: string }> = [
  {
    family: "video_agreement_v1",
    label: "Video verification review threshold",
    help: "Based on the share of models agreeing on the most common verdict, after video-specific penalties.",
  },
  {
    family: "research_synthesis_v1",
    label: "Research synthesis review threshold",
    help: "Based on how strongly panel responses support synthesized findings, after research-specific penalties.",
  },
];

/** Set (number) or remove (blank input) one score-type override, keeping the other untouched. */
export function withFamilyThreshold(
  policy: GovernancePolicy,
  family: FamilyReviewThresholdFamily,
  raw: string
): GovernancePolicy {
  const map = { ...(policy.scoreFamilyReviewThresholds ?? {}) };
  if (raw.trim() === "") delete map[family];
  else map[family] = Number(raw);
  const next: GovernancePolicy = { ...policy };
  if (Object.keys(map).length > 0) next.scoreFamilyReviewThresholds = map;
  else delete next.scoreFamilyReviewThresholds;
  return next;
}

export default function ScoreTypeThresholdsSection({ policy, isAdminUser, familyWritesEnabled, onChange }: Props) {
  const shared = policy.minConsensusToAvoidReview;
  const familyEditable = isAdminUser && familyWritesEnabled;
  return (
    <section className="rounded-xl border border-cp-border bg-cp-surface p-6 shadow-sm" data-testid="score-type-thresholds">
      <h2 className="text-lg font-semibold text-cp-text">Consensus thresholds by score type</h2>
      <p className="mt-2 text-sm text-cp-text/75">
        Claim, video and research scores use different formulas. The same number does not mean the same thing across
        them.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-cp-text">
          Default review threshold
          <input
            type="number"
            min={0}
            max={100}
            disabled={!isAdminUser}
            value={shared}
            onChange={(e) => onChange({ ...policy, minConsensusToAvoidReview: Number(e.target.value) })}
            className={INPUT_CLASS}
          />
          <span className="text-cp-muted"> /100</span>
          <span className="mt-1 block text-xs text-cp-text/70">
            Used when a score type does not have its own review threshold. A run scoring below it goes to the Review
            Queue.
          </span>
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {FAMILY_ROWS.map(({ family, label, help }) => {
          const value = policy.scoreFamilyReviewThresholds?.[family];
          return (
            <label key={family} className="text-sm text-cp-text" data-testid={`family-threshold-${family}`}>
              {label}
              <input
                type="number"
                min={0}
                max={100}
                placeholder={`Uses default (${shared})`}
                disabled={!familyEditable}
                value={value ?? ""}
                onChange={(e) => onChange(withFamilyThreshold(policy, family, e.target.value))}
                className={INPUT_CLASS}
              />
              <span className="mt-1 block text-xs text-cp-text/70">
                {value === undefined ? `Uses default (${shared}). ` : ""}
                {help}
              </span>
            </label>
          );
        })}
      </div>
      {!familyWritesEnabled && (
        <p className="mt-3 text-xs text-cp-text/70" data-testid="family-writes-disabled">
          Score-type review thresholds can&apos;t be changed yet. Video and research currently use the default review
          threshold unless a value is shown above.
        </p>
      )}

      <div className="mt-4 rounded-lg border border-cp-border-soft bg-cp-raised px-4 py-3 text-sm text-cp-text" data-testid="claim-threshold-explainer">
        <p className="font-medium">Claim verification</p>
        <p className="mt-1 text-xs text-cp-text/75">
          The general score threshold is not decision-binding for current claim verification behavior. Claim approval
          is governed by the verdict, evidence quality, model health and the other governance rules.
        </p>
      </div>

      <div className="mt-4 text-sm text-cp-text" data-testid="legacy-approval-value">
        <p className="font-medium">
          Legacy approval value: <span className="font-normal">{policy.minConsensusToApprove}</span>
          <span className="text-cp-muted"> /100</span>
        </p>
        <p className="mt-1 text-xs text-cp-text/70">
          Stored for backward compatibility. It is not currently used to make a governance decision.
        </p>
      </div>
    </section>
  );
}
