/**
 * Input Compression Utilities for Synthesis
 * 
 * Compresses model responses and clusters to reduce LLM token budget.
 * Helps improve synthesis speed and reduce costs.
 */

/**
 * Extract summary and key claims from a model response
 * 
 * @param text - Full model response text
 * @param maxSummaryChars - Maximum characters for summary (default: 1200)
 * @param maxClaims - Maximum number of claims to extract (default: 12)
 * @returns Compressed representation with summary, claims, and citations
 */
export function compressModelResponse(
  text: string,
  maxSummaryChars: number = 1200,
  maxClaims: number = 12
): {
  summary: string;
  claims: string[];
  citations?: string[];
} {
  if (!text || text.length === 0) {
    return { summary: "", claims: [] };
  }

  // If text is already short, return as-is
  if (text.length <= maxSummaryChars) {
    // Extract bullet points for claims
    const claims = extractClaims(text, maxClaims);
    return {
      summary: text.substring(0, maxSummaryChars),
      claims,
      citations: extractCitations(text),
    };
  }

  // For long text: take first portion as summary (often contains overview)
  // Truncate at sentence boundary if possible
  let summary = text.substring(0, maxSummaryChars);
  const lastPeriod = summary.lastIndexOf(".");
  const lastNewline = summary.lastIndexOf("\n");
  const cutoffPoint = Math.max(lastPeriod, lastNewline);
  
  if (cutoffPoint > maxSummaryChars * 0.7) {
    // Only truncate at sentence if it's not too aggressive
    summary = summary.substring(0, cutoffPoint + 1);
  } else {
    // Otherwise, truncate at word boundary
    const lastSpace = summary.lastIndexOf(" ");
    if (lastSpace > maxSummaryChars * 0.8) {
      summary = summary.substring(0, lastSpace) + "...";
    }
  }

  // Extract claims from full text (better than truncated)
  const claims = extractClaims(text, maxClaims);
  const citations = extractCitations(text);

  return { summary, claims, citations };
}

/**
 * Extract bullet points or numbered list items as claims
 */
function extractClaims(text: string, maxClaims: number): string[] {
  const claims: string[] = [];
  
  // Match bullet points (-, *, •) and numbered items
  const bulletRegex = /^[\s]*[-*•]\s+(.+)$/gm;
  const numberedRegex = /^[\s]*\d+[\.)]\s+(.+)$/gm;
  
  let match;
  
  // Extract bullet points
  while ((match = bulletRegex.exec(text)) !== null && claims.length < maxClaims) {
    const claim = match[1].trim();
    if (claim.length > 10 && claim.length < 500) {
      // Filter out very short or very long items
      claims.push(claim);
    }
  }
  
  // Extract numbered items if we need more
  while ((match = numberedRegex.exec(text)) !== null && claims.length < maxClaims) {
    const claim = match[1].trim();
    if (claim.length > 10 && claim.length < 500 && !claims.includes(claim)) {
      claims.push(claim);
    }
  }
  
  // If no structured claims found, extract sentences from first paragraphs
  if (claims.length === 0) {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    claims.push(...sentences.slice(0, maxClaims).map(s => s.trim().substring(0, 200)));
  }
  
  return claims.slice(0, maxClaims);
}

/**
 * Extract URLs or citations from text
 */
function extractCitations(text: string): string[] {
  const citations: string[] = [];
  
  // Match URLs
  const urlRegex = /https?:\/\/[^\s\)]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null && citations.length < 10) {
    citations.push(match[0]);
  }
  
  // Match citation patterns like [1], (Source: ...), etc.
  const citationRegex = /(?:Source|Cite|Reference)[:\s]+([^\n\(\)]+)/gi;
  while ((match = citationRegex.exec(text)) !== null && citations.length < 10) {
    const citation = match[1].trim();
    if (citation.length < 200) {
      citations.push(citation);
    }
  }
  
  return citations.slice(0, 10);
}

/**
 * Compress clusters to top N representative items
 * 
 * @param clusters - Array of cluster objects
 * @param topN - Number of top items to keep per cluster type (default: 10)
 */
export function compressClusters(
  clusters: any[],
  topN: number = 10
): any[] {
  if (!Array.isArray(clusters) || clusters.length <= topN) {
    return clusters;
  }

  // Sort by size (larger clusters likely more important) or confidence if available
  const sorted = [...clusters].sort((a, b) => {
    const aSize = a.claims?.length || a.items?.length || 0;
    const bSize = b.claims?.length || b.items?.length || 0;
    return bSize - aSize;
  });

  return sorted.slice(0, topN);
}

/**
 * Compute deterministic input hash for cache validation
 * 
 * Uses question + model summaries + cluster counts/ids
 * This ensures cache invalidation if inputs change
 */
export function computeInputHash(
  question: string,
  modelResponses: Array<{ modelId: string; text: string }>,
  agreementClusters?: any[],
  clusters?: any[]
): string {
  // Import crypto dynamically (Node.js only)
  const crypto = require("crypto");
  
  // Build hash components
  const components = [
    question.trim(),
    ...modelResponses.map(r => `${r.modelId}:${r.text.substring(0, 500)}`), // First 500 chars per model
    agreementClusters?.length || 0,
    clusters?.length || 0,
    // Include cluster IDs if available (for deterministic hashing)
    ...(agreementClusters?.map((c, i) => `${i}:${c.id || c.claim || ""}`) || []).slice(0, 10),
  ];
  
  const hashString = components.join("|");
  return crypto.createHash("sha256").update(hashString).digest("hex").substring(0, 16);
}

