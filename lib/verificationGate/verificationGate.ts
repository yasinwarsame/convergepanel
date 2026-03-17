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
  materialDisagreementsCount: number;
  contestedCount: number;
  missingSourcesCount: number;
  biasFlagsCount: number;
  uncertainCount: number;
  lowConfidenceCount: number;
  /** Whether the run was source-backed (affects missing-sources strictness) */
  sourceBacked?: boolean;
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

  /** ConsensusAnalysis.trustSummary (optional — used as capped hint only) */
  trustSummary?: {
    strongConsensus: number;
    contestedAreas: number;
    uncertainPoints: number;
  };

  /** Whether the run used evidence pack / source-backed mode (optional, defaults to false) */
  sourceBacked?: boolean;

  /** Approximate question length for factoid heuristic (optional) */
  questionLength?: number;
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
// Text normalization
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

// ---------------------------------------------------------------------------
// Canonical answer token extraction
// ---------------------------------------------------------------------------

const COMMON_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "of", "in", "to", "for",
  "at", "by", "on", "it", "its", "this", "that", "and", "or", "but", "not",
  "all", "no", "yes", "has", "have", "had", "do", "does", "did", "will",
  "can", "may", "should", "could", "would", "be", "been", "being",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "there", "here", "some", "most", "many", "much", "more", "than",
  "also", "each", "every", "both", "few", "other", "such", "only",
  "if", "then", "so", "as", "with", "from", "about", "into", "over",
  "after", "before", "between", "under", "above", "up", "down",
]);

function extractCanonicalTokens(claim: string): string[] {
  const tokens: string[] = [];
  const c = claim.trim();

  const quotedMatches = c.matchAll(/["']([^"']+)["']/g);
  for (const m of quotedMatches) {
    const t = normalizeText(m[1]);
    if (t.length >= 2) tokens.push(t);
  }

  const words = c.split(/\s+/);
  for (const w of words) {
    if (/^[A-Z]/.test(w) && !COMMON_WORDS.has(w.toLowerCase())) {
      const cleaned = w.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleaned.length >= 2) tokens.push(cleaned);
    }
  }

  const eqNum = c.match(/(?:=|\bis\b|\bequals?\b)\s*(\d+)/i);
  if (eqNum?.[1]) tokens.push(eqNum[1]);
  else {
    const anyNum = c.match(/\b(\d{1,6})\b/);
    if (anyNum?.[1]) tokens.push(anyNum[1]);
  }

  return [...new Set(tokens)];
}

// ---------------------------------------------------------------------------
// Nuance-only disagreement detection
// ---------------------------------------------------------------------------

const NUANCE_KEYWORDS = [
  "legal", "statutory", "formalization", "de jure", "de facto",
  "terminology", "wording", "framing", "definition", "semantics",
  "technicality", "pedantic", "clarification", "distinction",
  "axiom", "theorem", "proof", "formal system", "peano", "zfc",
  "foundations", "formalism", "convention",
];

const POLARITY_PAIRS: [string, string][] = [
  ["yes", "no"], ["before", "after"], ["increase", "decrease"],
  ["true", "false"], ["agree", "disagree"], ["support", "oppose"],
  ["positive", "negative"], ["likely", "unlikely"],
  ["higher", "lower"], ["more", "less"], ["better", "worse"],
];

function hasOpposingPolarity(positions: string[]): boolean {
  const joined = positions.map(normalizeText).join(" ");
  return POLARITY_PAIRS.some(([a, b]) => joined.includes(a) && joined.includes(b));
}

function isNuanceOnlyDisagreement(
  d: { topic: string; positionsByModel: Record<string, string>; whyTheyDiffer: string },
  canonicalTokens: string[],
): boolean {
  const positions = Object.values(d.positionsByModel).map(normalizeText);
  if (positions.length === 0) return false;

  // Use only the primary answer token (first) to avoid context words like "japan" in "capital of Japan"
  // spoiling the check when the actual answers ("Tokyo" vs "Osaka") disagree
  if (canonicalTokens.length > 0) {
    const primary = canonicalTokens[0];
    const matchCount = positions.filter((p) => p.includes(primary)).length;
    if (matchCount / positions.length >= 0.8) return true;
  }

  const combined = normalizeText(d.topic + " " + d.whyTheyDiffer);
  const hasNuanceKeyword = NUANCE_KEYWORDS.some((kw) => combined.includes(kw));
  if (hasNuanceKeyword && !hasOpposingPolarity(positions)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Material disagreement detection
// ---------------------------------------------------------------------------

function isMaterialDisagreement(
  d: { topic: string; positionsByModel: Record<string, string>; whyTheyDiffer: string },
  canonicalTokens: string[],
): boolean {
  if (isNuanceOnlyDisagreement(d, canonicalTokens)) return false;

  const modelCount = Object.keys(d.positionsByModel).length;
  const positions = Object.values(d.positionsByModel).map(normalizeText);

  // True contradiction: canonical answer exists but <80% of positions contain it (requires 3+ models)
  if (canonicalTokens.length > 0 && positions.length > 0 && modelCount >= 3) {
    const noTokenMatches = !canonicalTokens.some((token) => {
      const matchCount = positions.filter((p) => p.includes(token)).length;
      return matchCount / positions.length >= 0.8;
    });
    if (noTokenMatches) return true;
  }

  return (
    modelCount >= 3 &&
    (d.whyTheyDiffer.length >= 80 || d.topic.length >= 25)
  );
}

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

  if (process.env.NODE_ENV !== "production") {
    console.log("[VerificationGate]", { status, metrics });
  }

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
  const { keyFindings = [], disagreements = [], biasAndBlindSpots = [], openQuestions = [], trustSummary, sourceBacked = false, questionLength } = input;

  const canonicalTokens = keyFindings.length > 0
    ? extractCanonicalTokens(keyFindings[0].claim)
    : [];

  const disagreementsCount = disagreements.length;
  const materialDisagreementsCount = disagreements.filter(
    (d) => isMaterialDisagreement(d, canonicalTokens),
  ).length;

  // Non-source-backed: never penalize missing sources (evidenceRefs often empty by design).
  // Source-backed: count findings with empty evidenceRefs.
  const emptyEvidenceCount = keyFindings.filter((f) => f.evidenceRefs.length === 0).length;
  const missingSourcesCount = sourceBacked ? emptyEvidenceCount : 0;

  const biasFlagsCount = biasAndBlindSpots.length;

  const lowConfidenceCount = keyFindings.filter(
    (f) => f.confidence === "Low" || f.confidence === "Mixed"
  ).length;

  const contestedFromFindings = keyFindings.filter((f) => f.confidence === "Mixed").length;
  const lowFromFindings = keyFindings.filter((f) => f.confidence === "Low").length;

  const isLikelyFactoid =
    questionLength != null &&
    questionLength <= 80 &&
    keyFindings.length <= 1;

  const openQuestionsCount = isLikelyFactoid ? 0 : openQuestions.length;

  const contestedHint = trustSummary?.contestedAreas ?? 0;
  const uncertainHint = trustSummary?.uncertainPoints ?? 0;

  const contestedCount = Math.max(
    contestedFromFindings,
    Math.min(contestedHint, contestedFromFindings + 2)
  );

  const uncertainCount = Math.max(
    lowFromFindings + openQuestionsCount,
    Math.min(uncertainHint, lowFromFindings + openQuestionsCount + 3)
  );

  return {
    disagreementsCount,
    materialDisagreementsCount,
    contestedCount,
    missingSourcesCount,
    biasFlagsCount,
    uncertainCount,
    lowConfidenceCount,
    sourceBacked,
  };
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

function determineStatus(m: VerificationGateMetrics): VerificationGateStatus {
  // Tier 1 — DO_NOT_RELY_YET
  if (m.missingSourcesCount >= 1 && (m.materialDisagreementsCount >= 1 || m.lowConfidenceCount >= 2)) {
    return "DO_NOT_RELY_YET";
  }

  // Tier 2 — NEEDS_HUMAN_REVIEW (all four must exceed 2)
  if (
    m.contestedCount > 2 &&
    m.materialDisagreementsCount > 2 &&
    m.biasFlagsCount > 2 &&
    m.uncertainCount > 2
  ) {
    return "NEEDS_HUMAN_REVIEW";
  }
  // Source-backed with missing citations still triggers review
  if (m.sourceBacked && m.missingSourcesCount >= 1) {
    return "NEEDS_HUMAN_REVIEW";
  }
  // True contradictions (e.g. 2+2=5, Osaka as capital) must trigger review
  if (m.materialDisagreementsCount >= 1) {
    return "NEEDS_HUMAN_REVIEW";
  }
  // Low confidence alone isn't enough (avoids false positives for borderline cases).
  // Low confidence + another risk signal => review (non-source-backed panels with multiple Low/Mixed findings).
  if (
    m.lowConfidenceCount >= 2 &&
    (m.contestedCount >= 1 || m.materialDisagreementsCount >= 1 || m.uncertainCount >= 3)
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
  const nuanceCount = m.disagreementsCount - m.materialDisagreementsCount;

  if (m.materialDisagreementsCount >= 1) {
    reasons.push(
      `Model disagreement on a core conclusion (${m.materialDisagreementsCount})`
    );
  } else if (nuanceCount >= 1) {
    reasons.push(
      `Minor nuance differences noted (${nuanceCount})`
    );
  }
  if (m.contestedCount >= 1) {
    reasons.push(`Contested claims detected (${m.contestedCount})`);
  }
  if (m.sourceBacked && m.missingSourcesCount >= 1) {
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

  if (m.sourceBacked && m.missingSourcesCount >= 1) {
    steps.push(
      "Request sources for the top claims and verify against primary references."
    );
  }
  if (m.materialDisagreementsCount >= 1) {
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

  if (steps.length === 0) {
    steps.push(
      "Models show broad agreement — suitable for exploratory use. Cross-check key claims with primary sources before acting on them."
    );
  }

  return steps;
}
