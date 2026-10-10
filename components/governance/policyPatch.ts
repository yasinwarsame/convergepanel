/**
 * Step 6 D5.2A — the policy POST body for a Dashboard save: only fields that
 * changed against the loaded baseline.
 *
 * - `minConsensusToApprove` is never sent: the Dashboard shows it read-only
 *   (it decides nothing). The API still accepts it for other callers.
 * - Score-type overrides are diffed per family and sent in mutation form
 *   (number = set, null = clear), so one family's edit cannot touch the other.
 */
import type { GovernancePolicy } from "@/lib/governance/evaluateGovernance";
import { FAMILY_REVIEW_THRESHOLD_FAMILIES } from "@/lib/governance/familyReviewThresholds";

const NOT_GENERIC = new Set<keyof GovernancePolicy>(["policyVersion", "minConsensusToApprove", "scoreFamilyReviewThresholds"]);

export function buildPolicyPatch(policy: GovernancePolicy, baseline: GovernancePolicy): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  (Object.keys(baseline) as (keyof GovernancePolicy)[]).forEach((k) => {
    if (NOT_GENERIC.has(k)) return;
    if (JSON.stringify(policy[k]) !== JSON.stringify(baseline[k])) patch[k] = policy[k];
  });
  const family: Record<string, number | null> = {};
  for (const f of FAMILY_REVIEW_THRESHOLD_FAMILIES) {
    const before = baseline.scoreFamilyReviewThresholds?.[f];
    const after = policy.scoreFamilyReviewThresholds?.[f];
    if (before !== after) family[f] = after ?? null;
  }
  if (Object.keys(family).length > 0) patch.scoreFamilyReviewThresholds = family;
  return patch;
}
