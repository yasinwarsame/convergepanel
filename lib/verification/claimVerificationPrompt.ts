/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

export function buildClaimVerificationPrompt(claim: string): string {
  return `You are a fact-checking analyst. A user has submitted the following claim for verification.

CLAIM:
${claim}

Your task:
1. Evaluate whether this claim is accurate, partially accurate, inaccurate, or unverifiable based on your knowledge.
2. Identify specific parts that are correct and specific parts that are wrong or misleading.
3. If the claim contains numbers, dates, names, or statistics, verify each one individually.
4. If you cannot verify the claim, explain why (e.g., too recent, too vague, conflicting sources).
5. Cite specific facts or reasoning that support or contradict the claim.
6. IMPORTANT: Distinguish between "I know this is wrong" and "I don't have information about this." These are different — one is inaccuracy, the other is unverifiability.

Respond in this exact JSON format:
{
  "verdict": "accurate" | "partially_accurate" | "inaccurate" | "unverifiable",
  "confidence": "high" | "medium" | "low",
  "summary": "One sentence summary of your verdict",
  "correctParts": ["list of specific parts that are correct"],
  "incorrectParts": ["list of specific parts that are wrong, with corrections"],
  "unverifiableParts": ["list of parts you cannot verify and why"],
  "reasoning": "Your detailed reasoning"
}

Return ONLY the JSON object.`;
}
