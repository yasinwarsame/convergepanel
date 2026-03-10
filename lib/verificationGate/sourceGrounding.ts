/**
 * Source-Grounding Classification
 *
 * Lightweight heuristic to estimate whether a claim appears to be
 * backed by explicit sources, based on model reasoning, or a mix.
 */

export type GroundingLevel = "source-backed" | "model-reasoned" | "mixed";

export interface GroundingResult {
  level: GroundingLevel;
  label: string;
}

const GROUNDING_LABELS: Record<GroundingLevel, string> = {
  "source-backed": "Source-backed",
  "model-reasoned": "Model-reasoned",
  mixed: "Mixed / unclear",
};

const SOURCE_PATTERNS = [
  /\b(according to|cited|source|reference|study|paper|report|survey|journal)\b/i,
  /\b(published|peer.?reviewed|meta.?analysis|systematic review)\b/i,
  /\b(data from|statistics from|figures from|evidence from)\b/i,
  /\b(https?:\/\/|\.org|\.gov|\.edu)\b/i,
  /\b(Bureau|Institute|Agency|Commission|Department|Ministry)\b/i,
  /\b(WHO|CDC|FDA|NIH|NIST|OECD|IMF|World Bank)\b/i,
  /\b(\d{4})\b/, // Years often indicate dated sources
];

const REASONING_PATTERNS = [
  /\b(likely|probably|suggests|implies|indicates|appears)\b/i,
  /\b(generally|typically|often|tends to|may|might|could)\b/i,
  /\b(reasoning|infer|extrapolat|hypothe|conjecture|speculat)\b/i,
  /\b(based on .*(logic|analysis|pattern|understanding))\b/i,
  /\b(it follows that|therefore|thus|consequently|given that)\b/i,
];

/**
 * Classify source grounding of a claim.
 *
 * @param claimText - The claim text
 * @param evidenceRefs - Structured evidence references (from StructuredSynthesis)
 * @param supportingContext - Additional context (e.g. model positions, whyTheyDiffer)
 */
export function classifyGrounding(
  claimText: string,
  evidenceRefs?: string[],
  supportingContext?: string
): GroundingResult {
  const fullText = [claimText, supportingContext ?? ""].join(" ");

  const hasStructuredRefs = (evidenceRefs?.length ?? 0) > 0;
  const sourceHits = SOURCE_PATTERNS.filter((p) => p.test(fullText)).length;
  const reasoningHits = REASONING_PATTERNS.filter((p) => p.test(fullText)).length;

  // Strong evidence: structured refs + source language
  if (hasStructuredRefs && sourceHits >= 2) {
    return { level: "source-backed", label: GROUNDING_LABELS["source-backed"] };
  }

  // Structured refs alone count as source-backed
  if (hasStructuredRefs && sourceHits >= 1) {
    return { level: "source-backed", label: GROUNDING_LABELS["source-backed"] };
  }

  // Predominantly source language
  if (sourceHits >= 3 && reasoningHits <= 1) {
    return { level: "source-backed", label: GROUNDING_LABELS["source-backed"] };
  }

  // Predominantly reasoning language
  if (reasoningHits >= 2 && sourceHits === 0 && !hasStructuredRefs) {
    return { level: "model-reasoned", label: GROUNDING_LABELS["model-reasoned"] };
  }

  return { level: "mixed", label: GROUNDING_LABELS.mixed };
}
