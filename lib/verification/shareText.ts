/**
 * Builds share text for LinkedIn and X/Twitter for claim, video, and research results.
 */

export function formatVerdictLabel(verdict: string): string {
  const k = verdict.trim().toLowerCase().replace(/\s+/g, "_");
  const labels: Record<string, string> = {
    confirmed: "Confirmed",
    disputed: "Disputed",
    partially_true: "Partially True",
    unverifiable: "Unverifiable",
    accurate: "Accurate",
    partially_accurate: "Partially accurate",
    inaccurate: "Inaccurate",
    parse_error: "Parse error",
    failed: "Failed",
    authentic: "Authentic",
    authentic_captured: "Authentic (Camera Footage)",
    authentic_produced: "Authentic (Produced Content)",
    likely_manipulated: "Likely Manipulated",
    inconclusive: "Inconclusive",
    insufficient: "Insufficient",
  };
  return labels[k] || verdict;
}

export function buildClaimShareText(claim: string, verdict: string, score: number): string {
  const truncatedClaim = claim.length > 100 ? claim.substring(0, 97) + "..." : claim;
  const verdictLabel = formatVerdictLabel(verdict);
  return `Verified a claim using ConvergePanel:\n\n"${truncatedClaim}"\n\nVerdict: ${verdictLabel} | Consensus: ${score}/100\n5 AI models evaluated independently\n\nconvergepanel.com`;
}

export function buildVideoShareText(verdict: string, score: number): string {
  const verdictLabels: Record<string, string> = {
    authentic_captured: "Authentic Camera Footage",
    authentic_produced: "Produced Content (Not Deceptive)",
    likely_manipulated: "Likely Manipulated",
    inconclusive: "Inconclusive",
    insufficient: "Insufficient",
    authentic: "Authentic",
  };
  const label = verdictLabels[verdict.trim().toLowerCase().replace(/\s+/g, "_")] || formatVerdictLabel(verdict);
  return `Verified a video using ConvergePanel\n\nVerdict: ${label} | Consensus: ${score}/100\n3 AI vision models analyzed independently\n\nconvergepanel.com`;
}

export function buildResearchShareText(question: string, score: number): string {
  const truncatedQuestion = question.length > 100 ? question.substring(0, 97) + "..." : question;
  return `Researched across 5 AI models using ConvergePanel:\n\n"${truncatedQuestion}"\n\nConsensus: ${score}/100\nSee where models agree and disagree\n\nconvergepanel.com`;
}
