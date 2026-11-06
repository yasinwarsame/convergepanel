/**
 * Verification Gate — rules-based decision readiness scoring.
 *
 * Consumes signals already present in the StructuredSynthesis and
 * ConsensusAnalysis to produce a deterministic decision-readiness verdict.
 * No new model calls are made.
 */

import { MIN_INDEPENDENT_SYNTHESIS_MODELS } from "@/lib/panel/independentVoices";

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
  /**
   * Present only when independent-model coverage is reduced (see `VerificationGateResult.independentCoverage`):
   * contested / uncertain ("Mixed" findings, `trustSummary.contestedAreas`) signals that come from ONE independent
   * model. Relabelled, never erased; `contestedCount` then holds only contests BETWEEN independent models (0).
   */
  singleModelContestedCount?: number;
  /**
   * Present only when some passed `disagreements` are not between independent executing models (below two independent
   * models: all of them; otherwise those outside `independentDisagreements`). `disagreementsCount` /
   * `materialDisagreementsCount` count only genuine cross-model disagreements.
   */
  nonIndependentDisagreementsCount?: number;
}

/**
 * Independent-model coverage of the run the gate judged, when reduced:
 *  - "insufficient": fewer than two independent executing models responded;
 *  - "unverified": which models actually executed could not be established.
 */
export type ReducedIndependentCoverage = "insufficient" | "unverified";

export interface VerificationGateResult {
  status: VerificationGateStatus;
  label: string;
  reasons: string[];
  recommendedNextSteps: string[];
  metrics: VerificationGateMetrics;
  /** Present only when independent-model coverage is reduced (absent: ≥ 2 independent models, or not supplied). */
  independentCoverage?: ReducedIndependentCoverage;
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

  /**
   * Independent executing models among the run's usable responses (`independentSynthesisResponders`; slots answered by
   * one substitute model are one model). When supplied and below `MIN_INDEPENDENT_SYNTHESIS_MODELS` (or not a finite
   * number), the gate never reads as cross-model agreement: label `INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL`, status at
   * least NEEDS_HUMAN_REVIEW, and no "broad agreement" step. Absent → exactly the gate as before (callers without rows).
   */
  independentModelCount?: number;

  /**
   * The subset of `disagreements` that are genuine disagreements between independent executing models (the caller's
   * `crossModelDisagreements`). `disagreements` itself stays the full stored list: the status is never more permissive
   * than the gate over the full list, while only this subset is presented as model disagreement. Absent → every passed
   * disagreement is genuine (when coverage is sufficient).
   */
  independentDisagreements?: Array<{
    topic: string;
    positionsByModel: Record<string, string>;
    whyTheyDiffer: string;
  }>;

  /**
   * True when the caller cannot establish which models actually executed (e.g. rows without recorded execution
   * identity): coverage "unverified" — never presumed independent. Takes precedence over `independentModelCount`.
   */
  executionProvenanceUnverified?: boolean;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Gate label when fewer than two independent executing models responded — no cross-model check was possible. */
export const INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL = "Insufficient independent models";
export const INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON =
  "Fewer than two independent models responded — no cross-model comparison was possible (slots answered by the same substitute model count as one)";
export const INSUFFICIENT_INDEPENDENT_MODELS_GATE_STEP =
  "Treat this as a single model's answer: rerun when at least two independent models are available, and verify key claims against primary sources before acting on them.";
/**
 * Below two independent models a finding marked "Mixed" is one model's uncertainty, not a contest between models: the
 * gate states it under this label (with its count) instead of "Contested claims detected", and recommends
 * `SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP` instead of "Extract the top contested claims…".
 */
export const SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON = "Claims marked uncertain or mixed — from one independent model, not a disagreement between models";
export const SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP =
  "Verify the claims marked uncertain or mixed against primary sources before using them in a memo.";

/** Gate label / reason / step when the executing models could not be established (unknown execution provenance). */
export const UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL = "Independent-model coverage unverified";
export const UNVERIFIED_INDEPENDENT_COVERAGE_GATE_REASON =
  "Which models actually executed could not be established — independent-model coverage unverified, so nothing here is presented as agreement or disagreement between models";
export const UNVERIFIED_INDEPENDENT_COVERAGE_GATE_STEP =
  "Treat this as unverified: rerun, or confirm which models answered, before relying on any cross-model signal; verify key claims against primary sources.";

/**
 * Stored disagreement items whose positions are NOT from two or more independent executing models (one model in
 * several slots, or any item below two independent models): one model's differing / contested assertions.
 */
export const NON_INDEPENDENT_DISAGREEMENTS_REASON =
  "Differing positions from one independent model — not a disagreement between models";

/** The coverage the caller supplied, or null when sufficient / not supplied (fail closed on a non-finite count). */
function reducedIndependentCoverage(input: VerificationGateInput): ReducedIndependentCoverage | null {
  if (input.executionProvenanceUnverified === true) return "unverified";
  if (input.independentModelCount === undefined) return null;
  const n = input.independentModelCount;
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_INDEPENDENT_SYNTHESIS_MODELS ? null : "insufficient";
}

const STATUS_SEVERITY: Record<VerificationGateStatus, number> = {
  SAFE_TO_EXPLORE: 0,
  NEEDS_HUMAN_REVIEW: 1,
  DO_NOT_RELY_YET: 2,
};

/** The stricter of two statuses. */
function stricterStatus(a: VerificationGateStatus, b: VerificationGateStatus): VerificationGateStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

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
  const coverage = reducedIndependentCoverage(input);
  const all = input.disagreements ?? [];
  // Genuine disagreements between independent executing models: none below two independent models.
  const genuine = coverage ? [] : input.independentDisagreements ?? all;
  const nonIndependentDisagreementsCount = Math.max(0, all.length - genuine.length);

  if (!coverage && nonIndependentDisagreementsCount === 0) {
    // Coverage sufficient (or not supplied) and every disagreement genuine: exactly the gate as before.
    const metrics = extractMetrics({ ...input, disagreements: genuine });
    const status = determineStatus(metrics);
    if (process.env.NODE_ENV !== "production") {
      console.log("[VerificationGate]", { status, metrics });
    }
    return {
      status,
      label: STATUS_LABELS[status],
      reasons: buildReasons(metrics),
      recommendedNextSteps: buildNextSteps(metrics, status, null),
      metrics,
    };
  }

  // Stricter-only: the status over the FULL stored signals (every disagreement, contested hint unchanged) is the floor —
  // reduced independent coverage relabels signals, it never makes the verdict more permissive.
  const baseline = extractMetrics({ ...input, disagreements: all });
  const presented = extractMetrics({ ...input, disagreements: genuine });
  const metrics: VerificationGateMetrics = coverage
    ? {
        ...presented,
        // Nothing is contested BETWEEN models below two independent models; the same signals are kept, relabelled.
        contestedCount: 0,
        singleModelContestedCount: baseline.contestedCount,
        nonIndependentDisagreementsCount,
      }
    : { ...presented, nonIndependentDisagreementsCount };
  let status = stricterStatus(determineStatus(baseline), determineStatus(metrics));
  // One independent model (or unknown execution) is never "broadly consistent": nothing was compared.
  if (coverage) status = stricterStatus(status, "NEEDS_HUMAN_REVIEW");
  const coverageReason =
    coverage === "insufficient"
      ? [INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON]
      : coverage === "unverified"
        ? [UNVERIFIED_INDEPENDENT_COVERAGE_GATE_REASON]
        : [];
  const reasons = [...coverageReason, ...buildReasons(metrics)];
  const recommendedNextSteps = buildNextSteps(metrics, status, coverage);

  if (process.env.NODE_ENV !== "production") {
    console.log("[VerificationGate]", { status, metrics });
  }

  return {
    status,
    label:
      coverage === "insufficient"
        ? INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL
        : coverage === "unverified"
          ? UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL
          : STATUS_LABELS[status],
    reasons,
    recommendedNextSteps,
    metrics,
    ...(coverage ? { independentCoverage: coverage } : {}),
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
  // Only contests between independent models are "Contested claims detected"; one model's are stated as such.
  if (m.contestedCount >= 1) {
    reasons.push(`Contested claims detected (${m.contestedCount})`);
  }
  if ((m.singleModelContestedCount ?? 0) >= 1) {
    reasons.push(`${SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON} (${m.singleModelContestedCount})`);
  }
  if ((m.nonIndependentDisagreementsCount ?? 0) >= 1) {
    reasons.push(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (${m.nonIndependentDisagreementsCount})`);
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
  status: VerificationGateStatus,
  coverage: ReducedIndependentCoverage | null
): string[] {
  const steps: string[] = [];

  if (coverage === "insufficient") {
    steps.push(INSUFFICIENT_INDEPENDENT_MODELS_GATE_STEP);
  } else if (coverage === "unverified") {
    steps.push(UNVERIFIED_INDEPENDENT_COVERAGE_GATE_STEP);
  }

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
  if ((m.singleModelContestedCount ?? 0) >= 1 || (m.nonIndependentDisagreementsCount ?? 0) >= 1) {
    steps.push(SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP);
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
