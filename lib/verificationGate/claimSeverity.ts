/**
 * Claim Severity Classification
 *
 * Lightweight heuristic to classify synthesis claims into three
 * severity tiers based on downstream decision impact.
 */

export type ClaimSeverity = "low" | "important" | "decision-critical";

export interface ClaimSeverityResult {
  severity: ClaimSeverity;
  label: string;
}

const SEVERITY_LABELS: Record<ClaimSeverity, string> = {
  low: "Low stakes",
  important: "Important",
  "decision-critical": "Decision-critical",
};

const DECISION_CRITICAL_PATTERNS = [
  /\b(compliance|regulatory|regulation|legal|liability|lawsuit|litigation)\b/i,
  /\b(safety|health risk|patient|mortality|fatality|injury)\b/i,
  /\b(revenue|cost|budget|financial|profit|loss|funding|investment|valuation)\b/i,
  /\b(strategic|strategy|acquisition|merger|partnership)\b/i,
  /\b(security|vulnerability|breach|exploit|attack)\b/i,
  /\b(executive|board|c-suite|ceo|cfo|cto)\b/i,
  /\b(deadline|timeline|launch|ship|go.?live|release)\b/i,
  /\b(must|required|mandatory|critical|urgent)\b/i,
  /\b(recommend|should|advise|action\s+item)\b/i,
];

const IMPORTANT_PATTERNS = [
  /\b(significant|material|substantial|notable|considerable)\b/i,
  /\b(priority|prioritize|focus|key\s+factor|major)\b/i,
  /\b(risk|trade.?off|downside|limitation|constraint)\b/i,
  /\b(trend|shift|growth|decline|increase|decrease)\b/i,
  /\b(impact|affect|influence|implication|consequence)\b/i,
  /\b(performance|efficiency|scalability|reliability)\b/i,
  /\b(evidence\s+suggests|data\s+shows|research\s+indicates)\b/i,
];

/**
 * Classify claim severity based on text content and metadata.
 *
 * @param claim - The claim or topic text
 * @param confidence - Optional confidence level from the synthesis
 * @param modelCount - Number of models supporting the claim
 * @param isDisagreement - Whether this is a disagreement topic
 */
export function classifyClaimSeverity(
  claim: string,
  confidence?: "High" | "Medium" | "Low" | "Mixed",
  modelCount?: number,
  isDisagreement?: boolean
): ClaimSeverityResult {
  const text = claim.toLowerCase();

  // Disagreements with low confidence or mixed signals → decision-critical
  if (isDisagreement && (confidence === "Low" || confidence === "Mixed")) {
    return { severity: "decision-critical", label: SEVERITY_LABELS["decision-critical"] };
  }

  // Check for decision-critical keywords
  if (DECISION_CRITICAL_PATTERNS.some((p) => p.test(text))) {
    return { severity: "decision-critical", label: SEVERITY_LABELS["decision-critical"] };
  }

  // Disagreements are at least important
  if (isDisagreement) {
    return { severity: "important", label: SEVERITY_LABELS.important };
  }

  // Check for important keywords
  if (IMPORTANT_PATTERNS.some((p) => p.test(text))) {
    return { severity: "important", label: SEVERITY_LABELS.important };
  }

  // Low confidence with few models → important
  if (confidence === "Low" || (confidence === "Mixed" && (modelCount ?? 0) <= 2)) {
    return { severity: "important", label: SEVERITY_LABELS.important };
  }

  return { severity: "low", label: SEVERITY_LABELS.low };
}
