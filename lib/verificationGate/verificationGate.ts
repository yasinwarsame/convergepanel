/**
 * Verification Gate — rules-based decision readiness scoring.
 *
 * Consumes signals already present in the StructuredSynthesis and
 * ConsensusAnalysis to produce a deterministic decision-readiness verdict.
 * No new model calls are made.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationGateStatus =
  | "SAFE_TO_EXPLORE"
  | "NEEDS_HUMAN_REVIEW"
  | "DO_NOT_RELY_YET";

export interface VerificationGateMetrics {
  disagreementsCount: number;
  contestedCount: number;
  missingSourcesCount: number;
  biasFlagsCount: number;
  uncertainCount: number;
  lowConfidenceCount: number;
}

export interface VerificationGateResult {
  status: VerificationGateStatus;
  label: string;
  reasons: string[];
  recommendedNextSteps: string[];
  metrics: VerificationGateMetrics;
}

/**
 * Input shape drawn directly from StructuredSynthesis + ConsensusAnalysis
 * fields already available client-side after a panel run.
 */
export interface VerificationGateInput {
  /** StructuredSynthesis.keyFindings */
  keyFindings?: Array<{
    claim: string;
    confidence: "High" | "Medium" | "Low" | "Mixed";
    evidenceRefs: string[];
    modelsSupporting: string[];
  }>;

  /** StructuredSynthesis.disagreements */
  disagreements?: Array<{
    topic: string;
    positionsByModel: Record<string, string>;
    whyTheyDiffer: string;
  }>;

  /** StructuredSynthesis.biasAndBlindSpots */
  biasAndBlindSpots?: Array<{
    biasType: string;
    description: string;
    modelsImplicated: string[];
  }>;

  /** StructuredSynthesis.openQuestions */
  openQuestions?: string[];

  /** ConsensusAnalysis.trustSummary (optional — used for legacy path) */
  trustSummary?: {
    strongConsensus: number;
    contestedAreas: number;
    uncertainPoints: number;
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<VerificationGateStatus, string> = {
  SAFE_TO_EXPLORE: "Broadly consistent",
  NEEDS_HUMAN_REVIEW: "Needs human review",
  DO_NOT_RELY_YET: "Low confidence — review required",
};

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export function computeVerificationGate(
  input: VerificationGateInput
): VerificationGateResult {
  const metrics = extractMetrics(input);
  const status = determineStatus(metrics);
  const reasons = buildReasons(metrics);
  const recommendedNextSteps = buildNextSteps(metrics, status);

  return {
    status,
    label: STATUS_LABELS[status],
    reasons,
    recommendedNextSteps,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Metrics extraction
// ---------------------------------------------------------------------------

function extractMetrics(input: VerificationGateInput): VerificationGateMetrics {
  const { keyFindings = [], disagreements = [], biasAndBlindSpots = [], openQuestions = [], trustSummary } = input;

  const disagreementsCount = disagreements.length;

  // Contested: use trustSummary.contestedAreas if available, otherwise count
  // findings with Mixed confidence or single-model support
  const contestedCount = trustSummary?.contestedAreas ??
    keyFindings.filter((f) => f.confidence === "Mixed").length;

  // Missing sources: findings with empty evidenceRefs
  const missingSourcesCount = keyFindings.filter(
    (f) => f.evidenceRefs.length === 0
  ).length;

  const biasFlagsCount = biasAndBlindSpots.length;

  // Uncertain: trustSummary.uncertainPoints if available, otherwise count of
  // Low-confidence findings + open questions
  const uncertainCount = trustSummary?.uncertainPoints ??
    (keyFindings.filter((f) => f.confidence === "Low").length + openQuestions.length);

  const lowConfidenceCount = keyFindings.filter(
    (f) => f.confidence === "Low" || f.confidence === "Mixed"
  ).length;

  return {
    disagreementsCount,
    contestedCount,
    missingSourcesCount,
    biasFlagsCount,
    uncertainCount,
    lowConfidenceCount,
  };
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

function determineStatus(m: VerificationGateMetrics): VerificationGateStatus {
  // Tier 1 — DO_NOT_RELY_YET
  if (m.missingSourcesCount >= 1 && (m.disagreementsCount >= 1 || m.lowConfidenceCount >= 2)) {
    return "DO_NOT_RELY_YET";
  }

  // Tier 2 — NEEDS_HUMAN_REVIEW
  if (
    m.disagreementsCount >= 1 ||
    m.contestedCount >= 3 ||
    (m.biasFlagsCount >= 1 && m.uncertainCount >= 5)
  ) {
    return "NEEDS_HUMAN_REVIEW";
  }

  // Tier 3 — SAFE_TO_EXPLORE
  return "SAFE_TO_EXPLORE";
}

// ---------------------------------------------------------------------------
// Reason bullets (only include triggered signals)
// ---------------------------------------------------------------------------

function buildReasons(m: VerificationGateMetrics): string[] {
  const reasons: string[] = [];

  if (m.disagreementsCount >= 1) {
    reasons.push(
      `Model disagreement on a core conclusion (${m.disagreementsCount})`
    );
  }
  if (m.contestedCount >= 1) {
    reasons.push(`Contested claims detected (${m.contestedCount})`);
  }
  if (m.missingSourcesCount >= 1) {
    reasons.push(
      `Missing sources/citations (${m.missingSourcesCount})`
    );
  }
  if (m.biasFlagsCount >= 1) {
    reasons.push(
      `Possible bias/blind spots (${m.biasFlagsCount})`
    );
  }
  if (m.uncertainCount >= 1) {
    reasons.push(`High uncertainty signals (${m.uncertainCount})`);
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Recommended next steps (3–6 bullets, context-aware)
// ---------------------------------------------------------------------------

function buildNextSteps(
  m: VerificationGateMetrics,
  status: VerificationGateStatus
): string[] {
  const steps: string[] = [];

  if (m.missingSourcesCount >= 1) {
    steps.push(
      "Request sources for the top claims and verify against primary references."
    );
  }
  if (m.disagreementsCount >= 1) {
    steps.push(
      "Isolate the disputed premise and rerun with a narrower question focused on that premise."
    );
  }
  if (m.contestedCount >= 1) {
    steps.push(
      "Extract the top contested claims and verify them independently before using in a memo."
    );
  }
  if (m.biasFlagsCount >= 1) {
    steps.push(
      "Run an alternative framing / counterfactual prompt to test for blind spots."
    );
  }
  if (status === "DO_NOT_RELY_YET") {
    steps.push(
      "Do not use for automated action; treat as hypothesis only until verified."
    );
  }

  // Always provide at least one actionable step
  if (steps.length === 0) {
    steps.push(
      "Models show broad agreement — suitable for exploratory use. Cross-check key claims with primary sources before acting on them."
    );
  }

  return steps;
}
