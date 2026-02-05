/**
 * Build Compact Evidence Pack for Synthesis
 * 
 * Creates a highly compressed "evidence pack" from clusters and model responses
 * to dramatically reduce LLM prompt size while preserving key information.
 * 
 * This is the key optimization for speeding up synthesis.
 */

export interface EvidencePack {
  /** Total character count of the evidence pack */
  totalChars: number;
  /** Compact cluster summaries */
  clusterSummaries: string;
  /** Compact model evidence snippets (for bias detection only) */
  modelEvidence: string;
}

/**
 * Build compact evidence pack from clusters
 * 
 * Hard caps:
 * - Max 30 clusters OR 15k chars, whichever comes first
 * - Keep "most important" clusters first (largest consensus weight or highest confidence)
 * - For each cluster: include clusterTitle/topic, top claim, supporting model IDs, 1-2 evidence snippets per model (240-400 chars each)
 * 
 * @param clusters - Agreement clusters from analysis
 * @param modelResponses - Map of modelId -> full text (for evidence extraction)
 * @param maxClusters - Maximum number of clusters to include (default: 30)
 * @param maxTotalChars - Maximum total characters (default: 15000)
 * @returns Compact evidence pack string
 */
export function buildEvidencePack(
  clusters: any[],
  modelResponses: Map<string, string>,
  maxClusters: number = 30,
  maxTotalChars: number = 15000
): EvidencePack {
  if (!clusters || clusters.length === 0) {
    return {
      totalChars: 0,
      clusterSummaries: "",
      modelEvidence: "",
    };
  }

  // Sort clusters by importance:
  // 1. By size (larger clusters = more consensus)
  // 2. By label (consensus > single > contested, but prioritize contested for disagreements section)
  const sorted = [...clusters].sort((a, b) => {
    const aSize = a.claims?.length || a.items?.length || 0;
    const bSize = b.claims?.length || b.items?.length || 0;
    const aLabel = a.label || "unknown";
    const bLabel = b.label || "unknown";
    
    // Prioritize larger clusters
    if (aSize !== bSize) {
      return bSize - aSize;
    }
    
    // For same size, prefer consensus > contested > single
    const labelPriority: Record<string, number> = {
      consensus: 3,
      contested: 2,
      single: 1,
      unknown: 0,
    };
    return (labelPriority[bLabel] || 0) - (labelPriority[aLabel] || 0);
  });

  // Take top N clusters
  const topClusters = sorted.slice(0, maxClusters);
  
  // Build compact cluster summaries
  const clusterParts: string[] = [];
  const modelEvidenceMap = new Map<string, string[]>(); // modelId -> evidence snippets
  
  let totalChars = 0;
  
  for (const cluster of topClusters) {
    // Extract cluster metadata
    const clusterTitle = cluster.topic || cluster.title || cluster.claim || "Untitled cluster";
    const clusterLabel = cluster.label || "unknown";
    const claims = cluster.claims || cluster.items || [];
    const supportingModels = cluster.models || cluster.modelIds || [];
    
    // Get top 1-2 representative claims
    const topClaims = claims.slice(0, 2).map((c: any) => {
      const claimText = typeof c === "string" ? c : (c.text || c.claim || "");
      // Truncate claim to 200 chars
      return claimText.length > 200 ? claimText.substring(0, 197) + "..." : claimText;
    });
    
    // Build compact cluster summary
    const clusterSummary = `[${clusterLabel.toUpperCase()}] ${clusterTitle}\n` +
      `  Models: ${supportingModels.join(", ")}\n` +
      `  Top claim: ${topClaims[0] || "N/A"}\n` +
      (topClaims.length > 1 ? `  Alt: ${topClaims[1]}\n` : "");
    
    // Extract evidence snippets for each model (for bias detection)
    for (const modelId of supportingModels) {
      const modelText = modelResponses.get(modelId);
      if (modelText && !modelEvidenceMap.has(modelId)) {
        // Extract 1-2 short snippets (240-400 chars each) from the model response
        // Look for sentences that mention keywords from the cluster
        const keywords = clusterTitle.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
        const snippets = extractEvidenceSnippets(modelText, keywords, 2, 350);
        if (snippets.length > 0) {
          modelEvidenceMap.set(modelId, snippets);
        }
      }
    }
    
    const clusterChars = clusterSummary.length;
    if (totalChars + clusterChars > maxTotalChars) {
      // Stop if we'd exceed the cap
      break;
    }
    
    clusterParts.push(clusterSummary);
    totalChars += clusterChars;
  }
  
  const clusterSummaries = clusterParts.join("\n\n");
  
  // Build compact model evidence section (only for models that appear in clusters)
  const modelEvidenceParts: string[] = [];
  for (const [modelId, snippets] of modelEvidenceMap.entries()) {
    if (snippets.length > 0) {
      const evidenceText = `<ModelResponse modelId="${modelId}">\n` +
        snippets.map(s => `  ${s}`).join("\n") +
        `\n</ModelResponse>`;
      modelEvidenceParts.push(evidenceText);
      totalChars += evidenceText.length;
    }
  }
  
  const modelEvidence = modelEvidenceParts.join("\n\n---\n\n");
  
  return {
    totalChars,
    clusterSummaries,
    modelEvidence,
  };
}

/**
 * Extract evidence snippets from model text
 * 
 * Finds sentences that mention keywords and extracts short snippets (240-400 chars)
 * 
 * @param text - Full model response text
 * @param keywords - Keywords to search for
 * @param maxSnippets - Maximum number of snippets to extract
 * @param maxCharsPerSnippet - Maximum characters per snippet
 * @returns Array of evidence snippets
 */
function extractEvidenceSnippets(
  text: string,
  keywords: string[],
  maxSnippets: number = 2,
  maxCharsPerSnippet: number = 350
): string[] {
  const snippets: string[] = [];
  
  if (!text || keywords.length === 0) {
    // If no keywords, take first 1-2 sentences
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    return sentences.slice(0, maxSnippets).map(s => {
      const trimmed = s.trim();
      return trimmed.length > maxCharsPerSnippet 
        ? trimmed.substring(0, maxCharsPerSnippet - 3) + "..." 
        : trimmed;
    });
  }
  
  // Find sentences that mention keywords
  const sentences = text.split(/[.!?]+/).filter(s => {
    const lower = s.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
  });
  
  // Take top N sentences, truncate if needed
  for (const sentence of sentences.slice(0, maxSnippets)) {
    const trimmed = sentence.trim();
    if (trimmed.length > 0) {
      const snippet = trimmed.length > maxCharsPerSnippet 
        ? trimmed.substring(0, maxCharsPerSnippet - 3) + "..." 
        : trimmed;
      snippets.push(snippet);
    }
  }
  
  // If we didn't find enough keyword matches, fill with general snippets
  if (snippets.length < maxSnippets) {
    const allSentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    for (const sentence of allSentences) {
      const trimmed = sentence.trim();
      if (trimmed.length > 0 && !snippets.includes(trimmed)) {
        const snippet = trimmed.length > maxCharsPerSnippet 
          ? trimmed.substring(0, maxCharsPerSnippet - 3) + "..." 
          : trimmed;
        snippets.push(snippet);
        if (snippets.length >= maxSnippets) break;
      }
    }
  }
  
  return snippets.slice(0, maxSnippets);
}

