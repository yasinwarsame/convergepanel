/**
 * Org-wide governance evaluation (deterministic). UI / persistence wiring lives in API routes.
 */

export interface GovernanceInput {
  consensusScore: number | null;
  evidenceQuality: "strong" | "mixed" | "weak" | null;
  sourceBacked: boolean;
  missingSourcesCount: number;
  modelHealth: {
    ok: number;
    substituted: number;
    failed: number;
  };
  verificationVerdict?: "confirmed" | "disputed" | "partially_true" | "unverifiable" | null;
  question: string;
  runType: "research" | "verification";
}

export interface GovernancePolicy {
  policyVersion: number;
  minConsensusToApprove: number;
  minConsensusToAvoidReview: number;
  blockIfSourceBackedMissingSources: boolean;
  reviewIfAnyModelSubstituted: boolean;
  reviewIfAnyModelFailed: boolean;
  sensitiveDomainsEnabled: boolean;
  sensitiveMinConsensusToApprove: number;
  sensitiveMinConsensusToAvoidReview: number;
  reviewIfEvidenceQualityWeak: boolean;
  reviewIfVerificationVerdictIn: string[];
}

export interface GovernanceResult {
  status: "approved" | "needs_review" | "blocked";
  reasons: string[];
  meta: {
    policyVersion: number;
    evaluatedAt: string;
  };
}

export const SENSITIVE_DOMAINS: Record<string, string[]> = {
  legal: [
    "lawsuit",
    "contract",
    "liability",
    "regulation",
    "compliance",
    "statute",
    "court",
    "attorney",
    "legal",
  ],
  medical: [
    "diagnosis",
    "treatment",
    "patient",
    "clinical",
    "medication",
    "dosage",
    "symptom",
    "medical",
    "healthcare",
  ],
  financial: [
    "investment",
    "revenue",
    "valuation",
    "portfolio",
    "trading",
    "fiscal",
    "dividend",
    "financial",
    "earnings",
  ],
};

export function detectSensitiveDomain(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [domain, keywords] of Object.entries(SENSITIVE_DOMAINS)) {
    if (keywords.some((kw) => lower.includes(kw))) return domain;
  }
  return null;
}

function verificationVerdictToPolicyLabel(
  verdict: NonNullable<GovernanceInput["verificationVerdict"]>
): string {
  const map: Record<string, string> = {
    confirmed: "Confirmed",
    disputed: "Disputed",
    partially_true: "Partially True",
    unverifiable: "Unverifiable",
  };
  return map[verdict] ?? verdict;
}

export function getDefaultGovernancePolicy(): GovernancePolicy {
  return {
    policyVersion: 1,
    minConsensusToApprove: 80,
    minConsensusToAvoidReview: 70,
    blockIfSourceBackedMissingSources: true,
    reviewIfAnyModelSubstituted: true,
    reviewIfAnyModelFailed: true,
    sensitiveDomainsEnabled: true,
    sensitiveMinConsensusToApprove: 85,
    sensitiveMinConsensusToAvoidReview: 75,
    reviewIfEvidenceQualityWeak: true,
    reviewIfVerificationVerdictIn: ["Disputed", "Unverifiable", "Partially True"],
  };
}

export function evaluateGovernance(input: GovernanceInput, policy: GovernancePolicy): GovernanceResult {
  const reasons: string[] = [];
  let hasBlocked = false;
  let hasReview = false;

  const rawScore = input.consensusScore;
  const effectiveScore = rawScore == null ? 0 : rawScore;

  if (
    policy.blockIfSourceBackedMissingSources &&
    input.sourceBacked &&
    input.missingSourcesCount >= 1
  ) {
    reasons.push(`Missing sources in source-backed run (${input.missingSourcesCount} missing)`);
    hasBlocked = true;
  }

  if (policy.sensitiveDomainsEnabled) {
    const domain = detectSensitiveDomain(input.question);
    if (domain) {
      const csDisplay = rawScore == null ? "N/A" : String(rawScore);
      if (effectiveScore < policy.sensitiveMinConsensusToAvoidReview) {
        reasons.push(
          `Sensitive domain (${domain}): consensus ${csDisplay} below ${policy.sensitiveMinConsensusToAvoidReview}`
        );
        hasReview = true;
      }
      if (effectiveScore < policy.sensitiveMinConsensusToApprove) {
        reasons.push(
          `Sensitive domain (${domain}): consensus ${csDisplay} below approval threshold ${policy.sensitiveMinConsensusToApprove}`
        );
        hasReview = true;
      }
    }
  }

  if (policy.reviewIfEvidenceQualityWeak && input.evidenceQuality === "weak") {
    reasons.push("Evidence quality is weak");
    hasReview = true;
  }

  if (policy.reviewIfAnyModelFailed && input.modelHealth.failed > 0) {
    reasons.push(`${input.modelHealth.failed} model(s) failed`);
    hasReview = true;
  }

  if (policy.reviewIfAnyModelSubstituted && input.modelHealth.substituted > 0) {
    reasons.push(`${input.modelHealth.substituted} model(s) substituted`);
    hasReview = true;
  }

  if (input.runType === "verification" && input.verificationVerdict) {
    const titled = verificationVerdictToPolicyLabel(input.verificationVerdict);
    if (policy.reviewIfVerificationVerdictIn.includes(titled)) {
      reasons.push(`Claim verification verdict: ${input.verificationVerdict}`);
      hasReview = true;
    }
  }

  if (rawScore == null) {
    reasons.push("Consensus score not available");
    hasReview = true;
  } else if (rawScore < policy.minConsensusToAvoidReview) {
    reasons.push(`Consensus ${rawScore} below ${policy.minConsensusToAvoidReview}`);
    hasReview = true;
  }

  let status: GovernanceResult["status"];
  if (hasBlocked) status = "blocked";
  else if (hasReview) status = "needs_review";
  else status = "approved";

  return {
    status,
    reasons,
    meta: {
      policyVersion: policy.policyVersion,
      evaluatedAt: new Date().toISOString(),
    },
  };
}
