/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part B — the adaptive-aware
 * automated-governance evaluator. Implements the design in
 * docs/governance-decision-receipts-design.md §18 exactly — that document
 * is the source of truth wherever an earlier prompt disagreed with it.
 *
 * Deliberately a SEPARATE module from `evaluateGovernance.ts` — never
 * calls it, never modifies it, never touches its 3 existing callers
 * (`/api/synthesize-panel`, `/api/verify-claim`, `/api/verify-video`).
 * Reuses the SAME `GovernancePolicy` type and the SAME two policy fields
 * that have a real, honest adaptive equivalent
 * (`blockIfSourceBackedMissingSources`, `reviewIfAnyModelFailed`) — every
 * other legacy policy field (`minConsensusToApprove`,
 * `sensitiveDomainsEnabled`, `reviewIfEvidenceQualityWeak`,
 * `reviewIfVerificationVerdictIn`, etc.) is never read here, not silently
 * treated as satisfied.
 *
 * Only 2 of System A's 8 rules carry over, per §18.1's reconfirmed
 * inventory:
 *   - SOURCE_COMPLETENESS — only for the 3 schemas with real per-unit
 *     source tracking (`ranked_enumeration`, `comparison_matrix`,
 *     `definition_explanation`); the other 6 are honestly "not evaluated
 *     for this schema", never silently passed or incorrectly flagged.
 *   - MODEL_FAILURES — all 9 schemas, direct port of
 *     `reviewIfAnyModelFailed` (NOT a nonexistent `maxModelFailures` —
 *     verified against the real `GovernancePolicy` type before writing
 *     this).
 * Consensus-threshold, model-substitution, sensitive-domain, and
 * evidence-quality rules are excluded entirely — no per-run reason is
 * emitted for these (their exclusion is a permanent property of this
 * rule set, documented here and in §18, not a per-record fact) — see
 * §18.1/§18.3 for the full reasoning on each.
 *
 * Zero I/O: no model call, no classifier call, no network call, no
 * Firestore call. Deterministic: identical input always produces an
 * identical result. Never throws — invalid input (e.g. a negative model
 * count) produces an honest `status: "error"` result, never a fabricated
 * pass.
 */

import { GovernancePolicy } from "./evaluateGovernance";
import { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";
import { PersistedAdaptiveSchemaId } from "../adaptiveSchema/persistedOutput";

/** The only 3 of the 9 active Milestone 2 schemas whose `AdaptiveDecisionReceipt.sources` reflects real per-unit source tracking — verified against `decisionReceiptBuilder.ts`'s own per-schema source-handling table (§18.2/§18.3). */
const SOURCE_TRACKING_SCHEMA_IDS: ReadonlySet<PersistedAdaptiveSchemaId> = new Set([
  "ranked_enumeration",
  "comparison_matrix",
  "definition_explanation",
]);

type AutomatedGovernance = NonNullable<GovernanceRecordV1["automatedGovernance"]>;

const REASON = {
  sourceCompletenessFlagged: "Source completeness: run reported source-backed with no preserved source labels",
  sourceCompletenessNotEvaluated: "Source completeness not evaluated for this schema (no per-unit source tracking)",
  modelFailures: (count: number) => `${count} model(s) failed to produce usable output`,
  noCompatibleRule: "No automated governance rule could be evaluated for this run",
  unexpectedError: "Automated governance evaluation failed unexpectedly",
  invalidCounts: "Model health counts were invalid",
} as const;

type RuleOutcome =
  | { evaluated: true; result: "passed" | "flagged" | "blocked"; reason?: string }
  | { evaluated: false; reason: string };

/**
 * §18.3: gated on `policy.blockIfSourceBackedMissingSources` (the SAME
 * flag the legacy rule uses) and on the run's schema being one of the 3
 * with real per-unit source tracking. Flags (never blocks — the adaptive
 * signal is a coarser, less certain binary than legacy's granular
 * missing-count, so it's treated as a review trigger, per §18.3's own
 * reasoning — this is a deliberate, considered divergence from a looser
 * "blocking source rule" framing, kept because §18 already worked through
 * why FLAGGED is the honest choice here).
 */
function evaluateSourceCompleteness(governanceRecord: GovernanceRecordV1, policy: GovernancePolicy): RuleOutcome {
  const schemaId = governanceRecord.schemaId as PersistedAdaptiveSchemaId;
  if (!SOURCE_TRACKING_SCHEMA_IDS.has(schemaId)) {
    return { evaluated: false, reason: REASON.sourceCompletenessNotEvaluated };
  }
  if (!policy.blockIfSourceBackedMissingSources) {
    // Policy has this check turned off — mirrors legacy's own behavior of
    // simply never consulting `sourceBacked`/`missingSourcesCount` at all
    // when the flag is off. Counts as evaluated-and-passed, not skipped:
    // the check ran, found nothing to flag under the active policy, per
    // Part B4's explicit "rule passes; do not generate a failure reason".
    return { evaluated: true, result: "passed" };
  }
  const { sourceBacked, sources } = governanceRecord.decisionReceipt;
  if (sourceBacked && sources.length === 0) {
    return { evaluated: true, result: "flagged", reason: REASON.sourceCompletenessFlagged };
  }
  return { evaluated: true, result: "passed" };
}

/** §18.3: direct port of `reviewIfAnyModelFailed` — the real policy field, not a nonexistent numeric threshold. */
function evaluateModelFailures(modelFailureCount: number, policy: GovernancePolicy): RuleOutcome {
  if (!policy.reviewIfAnyModelFailed) {
    return { evaluated: true, result: "passed" };
  }
  if (modelFailureCount > 0) {
    return { evaluated: true, result: "flagged", reason: REASON.modelFailures(modelFailureCount) };
  }
  return { evaluated: true, result: "passed" };
}

function isValidCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function evaluateAdaptiveGovernance(args: {
  governanceRecord: GovernanceRecordV1;
  policy: GovernancePolicy;
  modelFailureCount: number;
  successfulModelCount: number;
  evaluatedAt: string;
}): AutomatedGovernance {
  const { governanceRecord, policy, modelFailureCount, successfulModelCount, evaluatedAt } = args;

  if (!isValidCount(modelFailureCount) || !isValidCount(successfulModelCount)) {
    return {
      status: "error",
      reasons: [REASON.invalidCounts],
      evaluatedAt,
      policyVersion: policy.policyVersion,
    };
  }

  const sourceOutcome = evaluateSourceCompleteness(governanceRecord, policy);
  const modelFailuresOutcome = evaluateModelFailures(modelFailureCount, policy);
  const outcomes = [sourceOutcome, modelFailuresOutcome];

  const reasons: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.evaluated) {
      reasons.push(outcome.reason);
    } else if (outcome.reason) {
      reasons.push(outcome.reason);
    }
  }

  const evaluatedOutcomes = outcomes.filter((o): o is Extract<RuleOutcome, { evaluated: true }> => o.evaluated);

  if (evaluatedOutcomes.length === 0) {
    // Not practically reachable under the current 2-rule set (MODEL_FAILURES
    // always evaluates, since MIN_MODELS guarantees real data exists) —
    // kept honest and defined for forward-compatibility per §18.4.
    return {
      status: "not_evaluated",
      reasons: [REASON.noCompatibleRule, ...reasons],
      evaluatedAt,
      policyVersion: policy.policyVersion,
      notEvaluatedReason: REASON.noCompatibleRule,
    };
  }

  const hasBlocked = evaluatedOutcomes.some((o) => o.result === "blocked");
  const hasFlagged = evaluatedOutcomes.some((o) => o.result === "flagged");
  const status: AutomatedGovernance["status"] = hasBlocked ? "blocked" : hasFlagged ? "flagged" : "passed";

  return {
    status,
    reasons,
    evaluatedAt,
    policyVersion: policy.policyVersion,
  };
}
