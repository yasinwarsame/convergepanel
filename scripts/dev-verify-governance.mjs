/**
 * Dev verification for lib/governance/evaluateGovernance.ts — KEEP IN SYNC with TypeScript source.
 * Run: npm run verify:governance
 */

const SENSITIVE_DOMAINS = {
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

function detectSensitiveDomain(text) {
  const lower = text.toLowerCase();
  for (const [domain, keywords] of Object.entries(SENSITIVE_DOMAINS)) {
    if (keywords.some((kw) => lower.includes(kw))) return domain;
  }
  return null;
}

function getDefaultGovernancePolicy() {
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

function verificationVerdictToPolicyLabel(verdict) {
  const map = {
    confirmed: "Confirmed",
    disputed: "Disputed",
    partially_true: "Partially True",
    unverifiable: "Unverifiable",
  };
  return map[verdict] ?? verdict;
}

function evaluateGovernance(input, policy) {
  const reasons = [];
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

  let status;
  if (hasBlocked) status = "blocked";
  else if (hasReview) status = "needs_review";
  else status = "approved";

  return {
    status,
    reasons,
    meta: { policyVersion: policy.policyVersion, evaluatedAt: new Date().toISOString() },
  };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function stripMeta(r) {
  return { status: r.status, reasons: r.reasons };
}

const policy = getDefaultGovernancePolicy();

// 1) High consensus, no issues → approved
{
  const input = {
    consensusScore: 85,
    evidenceQuality: "strong",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "How does photosynthesis work?",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "approved", "1 expected approved");
  assert(r.reasons.length === 0, "1 expected no reasons");
}

// 2) Missing sources + source-backed → blocked
{
  const input = {
    consensusScore: 90,
    evidenceQuality: "strong",
    sourceBacked: true,
    missingSourcesCount: 2,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "Test",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "blocked", "2 expected blocked");
  assert(r.reasons.some((x) => x.includes("Missing sources")), "2 missing sources reason");
}

// 3) Substituted model → needs_review
{
  const input = {
    consensusScore: 75,
    evidenceQuality: "mixed",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 4, substituted: 1, failed: 0 },
    question: "Test",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "needs_review", "3 needs_review");
  assert(r.reasons.some((x) => x.toLowerCase().includes("substituted")), "3 substituted reason");
}

// 4) Sensitive domain (legal) mid consensus → needs_review
{
  const input = {
    consensusScore: 72,
    evidenceQuality: "strong",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "What are the liability implications of this contract?",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "needs_review", "4 needs_review");
  assert(r.reasons.some((x) => x.includes("Sensitive domain")), "4 sensitive reason");
}

// 5) Verification verdict Disputed
{
  const input = {
    consensusScore: 60,
    evidenceQuality: "mixed",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 3, substituted: 0, failed: 0 },
    verificationVerdict: "disputed",
    question: "Some claim",
    runType: "verification",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "needs_review", "5 needs_review");
  assert(
    r.reasons.some((x) => x.toLowerCase().includes("verification verdict")),
    "5 verdict reason"
  );
}

// 6) Weak evidence
{
  const input = {
    consensusScore: 75,
    evidenceQuality: "weak",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "Test",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "needs_review", "6 needs_review");
  assert(r.reasons.some((x) => x.includes("Evidence quality is weak")), "6 weak evidence");
}

// 7) Low consensus
{
  const input = {
    consensusScore: 55,
    evidenceQuality: "mixed",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "Test",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "needs_review", "7 needs_review");
  assert(r.reasons.some((x) => x.includes("Consensus 55 below 70")), "7 low consensus");
}

// 8) Everything perfect
{
  const input = {
    consensusScore: 95,
    evidenceQuality: "strong",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "Simple topic",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "approved", "8 approved");
  assert(r.reasons.length === 0, "8 no reasons");
}

// Deterministic (ignore meta)
{
  const input = {
    consensusScore: 82,
    evidenceQuality: "strong",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "X",
    runType: "research",
  };
  const a = stripMeta(evaluateGovernance(input, policy));
  const b = stripMeta(evaluateGovernance(input, policy));
  assert(JSON.stringify(a) === JSON.stringify(b), "deterministic");
}

// Blocked outranks review
{
  const input = {
    consensusScore: 95,
    evidenceQuality: "weak",
    sourceBacked: true,
    missingSourcesCount: 1,
    modelHealth: { ok: 4, substituted: 1, failed: 0 },
    question: "Test",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.status === "blocked", "blocked wins");
}

// Multiple reasons
{
  const input = {
    consensusScore: 55,
    evidenceQuality: "weak",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: "Test",
    runType: "research",
  };
  const r = evaluateGovernance(input, policy);
  assert(r.reasons.length >= 2, "multiple reasons");
  assert(r.reasons.some((x) => x.includes("Evidence quality is weak")), "multi weak");
  assert(r.reasons.some((x) => x.includes("Consensus 55 below 70")), "multi consensus");
}

console.log("OK: governance evaluation fixtures passed.");
