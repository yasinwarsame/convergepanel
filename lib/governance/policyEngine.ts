/**
 * Team governance: policies, consensus thresholds, and review workflows.
 */

import type { ConsensusSummary } from "@/lib/verification/consensusScoring";

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  condition: {
    type: "consensus_below" | "evidence_quality" | "model_health";
    threshold?: number;
  };
  action: "flag" | "block" | "require_review";
}

export type TriggeredRule = {
  rule: PolicyRule;
  matchReason: string;
};

export type PolicyEvaluation = {
  triggered: TriggeredRule[];
  blocked: boolean;
  requiresReview: boolean;
};

/** Default rules when a team is created. */
export const DEFAULT_POLICIES: PolicyRule[] = [
  {
    id: "low-consensus-flag",
    name: "Low consensus flag",
    description: "Flag any run with consensus score below 50 for human review",
    enabled: true,
    condition: { type: "consensus_below", threshold: 50 },
    action: "flag",
  },
  {
    id: "low-model-health-flag",
    name: "Low model health flag",
    description: "Flag when fewer than 4 models responded successfully",
    enabled: true,
    condition: { type: "model_health", threshold: 4 },
    action: "flag",
  },
  {
    id: "weak-evidence-review",
    name: "Weak evidence requires review",
    description: "Require human review when any claim has weak evidence quality",
    enabled: false,
    condition: { type: "evidence_quality" },
    action: "require_review",
  },
];

export function evaluatePolicies(rules: PolicyRule[], consensusSummary: ConsensusSummary): PolicyEvaluation {
  const triggered: TriggeredRule[] = [];
  let blocked = false;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    let matches = false;
    switch (rule.condition.type) {
      case "consensus_below":
        matches =
          consensusSummary.overallConsensusScore < (rule.condition.threshold ?? 60);
        break;
      case "evidence_quality":
        matches = consensusSummary.lowEvidenceClaims > 0;
        break;
      case "model_health":
        matches = consensusSummary.modelsHealthy < (rule.condition.threshold ?? 4);
        break;
      default:
        matches = false;
    }

    if (matches) {
      triggered.push({
        rule,
        matchReason: `${rule.condition.type}: threshold not met`,
      });
      if (rule.action === "block") {
        blocked = true;
      }
    }
  }

  return {
    triggered,
    blocked,
    requiresReview: triggered.some((t) => t.rule.action === "require_review"),
  };
}
