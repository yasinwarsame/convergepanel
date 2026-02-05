/**
 * Agreement Map Engine
 * 
 * Extracts and clusters claims from model responses to build an agreement map
 * showing consensus, single-model insights, and disagreements.
 * Consensus/contested aggregation entrypoint: buildAgreementMap()
 * 
 * ROOT CAUSE NOTE: Claude was missing from Agreement/Disagreement Map because
 * extractClaimsFromResponse relied too heavily on "# Key Claims" section. If a model
 * doesn't have this exact section format, it would return 0 claims. The fix adds
 * a robust fallback that extracts from any structured content (bullets, numbered lists,
 * declarative sentences) to ensure all models with valid text are included.
 */

import { ModelId, ModelResult } from "@/lib/types";

/**
 * Check if debug logging is enabled (dev-only or localhost)
 */
function isDebugEnabled(): boolean {
  return (
    (typeof process !== "undefined" && process.env.NODE_ENV !== "production") ||
    (typeof window !== "undefined" && (
      window.location?.hostname === "localhost" || 
      window.location?.hostname === "127.0.0.1" ||
      (window as any).NEXT_PUBLIC_DEBUG_AGREEMENT_MAP === "true"
    ))
  );
}

/**
 * A single claim extracted from a model response
 */
export type Claim = {
  id: string; // unique id
  modelId: ModelId;
  text: string;
  section?: "keyClaims" | "evidence" | "uncertainties" | "biases" | string; // Which section this claim came from
  isBiasRelated?: boolean; // True if this claim is from the "Potential Biases and Blind Spots" section
};

/**
 * A cluster of similar claims grouped together
 */
export type ClaimCluster = {
  id: string;
  representativeText: string; // Representative text for this cluster
  modelIds: ModelId[]; // Models that support this cluster
  claims: Claim[]; // Original claims grouped together
  label: "consensus" | "single" | "disagreement";
};

/**
 * Extract claims from a model's markdown response
 * 
 * This function works for all models (ChatGPT, Claude, Grok, Perplexity, Gemini) that use
 * the structured format with section headers:
 * - # Summary: splits into 1-3 sentences
 * - # Key Claims: each bullet becomes one claim
 * 
 * All models now use PANEL_ANSWER_INSTRUCTIONS which ensures they produce responses
 * with these sections, making claim extraction consistent across models.
 * 
 * Includes Gemini, Perplexity, and all other models as full panel members in clustering / agreement analysis.
 * 
 * @param modelId - Which model this response is from
 * @param markdown - The markdown response text
 * @returns Array of extracted claims
 */
export function extractClaimsFromResponse(
  modelId: ModelId,
  markdown: string
): Claim[] {
  const claims: Claim[] = [];
  let claimIndex = 0;

  // Split by sections (headers)
  // Handle markdown headers with optional colons or extra whitespace
  // e.g., "# Key Claims", "# Key Claims:", "## Key Claims", etc.
  const parts = markdown.split(/^#+\s+/gm);
  
  let keyClaimsFound = false;
  let summaryText = "";
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    
    const lines = part.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    // First line is the header (or empty if it's the first part before any header)
    // Normalize header: lowercase, remove colons and extra whitespace
    const rawHeader = i === 0 ? "" : lines[0] || "";
    const header = rawHeader.toLowerCase().replace(/[:：]/g, "").trim();
    const contentLines = i === 0 ? lines : lines.slice(1);
    
    // Extract from Key Claims section (PRIORITY - this is the main source)
    // Perplexity now uses the same structured # Key Claims format;
    // ensure we use its extracted claims instead of falling back to the whole summary.
    if (header.includes("key claims") || header.includes("key claim")) {
      keyClaimsFound = true;
      for (const line of contentLines) {
        // Match bullet points: - **label:** text or - text or * text or • text
        // Also handle numbered lists: 1. text or 1) text
        // Make regex more flexible to handle various formats
        let bulletMatch = line.match(/^[-*•]\s+(?:\*\*[^*]+\*\*[:：]?\s*)?(.+)$/);
        if (!bulletMatch) {
          // Try numbered list format
          bulletMatch = line.match(/^\d+[.)]\s+(.+)$/);
        }
        if (!bulletMatch) {
          // Try plain bullet without marker (just indented)
          bulletMatch = line.match(/^\s{2,}(.+)$/);
        }
        
        if (bulletMatch) {
          const claimText = bulletMatch[1]
            .replace(/\*\*/g, "") // Remove bold markers
            .replace(/\*/g, "") // Remove italic markers
            .trim();
          
          if (claimText.length > 10) {
            claims.push({
              id: `${modelId}-keyclaim-${claimIndex++}`,
              modelId,
              text: claimText,
              section: "keyClaims",
            });
          }
        }
      }
    }
    
    // Extract from Potential Biases and Blind Spots section
    // Bias-related claims are clustered like other claims, but the UI will render them with
    // special styling to highlight potential model/discourse bias.
    if (header.includes("potential biases") || header.includes("biases") || header.includes("blind spots")) {
      for (const line of contentLines) {
        // Match bullet points: - **label:** text or - text or * text or • text
        // Also handle numbered lists: 1. text or 1) text
        let bulletMatch = line.match(/^[-*•]\s+(?:\*\*[^*]+\*\*[:：]?\s*)?(.+)$/);
        if (!bulletMatch) {
          // Try numbered list format
          bulletMatch = line.match(/^\d+[.)]\s+(.+)$/);
        }
        if (!bulletMatch) {
          // Try plain bullet without marker (just indented)
          bulletMatch = line.match(/^\s{2,}(.+)$/);
        }
        
        if (bulletMatch) {
          const claimText = bulletMatch[1]
            .replace(/\*\*/g, "") // Remove bold markers
            .replace(/\*/g, "") // Remove italic markers
            .trim();
          
          if (claimText.length > 10) {
            claims.push({
              id: `${modelId}-bias-${claimIndex++}`,
              modelId,
              text: claimText,
              section: "biases",
              isBiasRelated: true, // Flag this as a bias-related claim
            });
          }
        }
      }
    }
    
    // Extract from Summary section (ONLY if no Key Claims found)
    // We prefer Key Claims over Summary for better granularity in the agreement map
    if (header.includes("summary") && !keyClaimsFound) {
      summaryText = contentLines.join(" ");
    }
  }

  // Only use Summary if we didn't find any Key Claims
  // Perplexity now uses the same structured # Key Claims format;
  // ensure we use its extracted claims instead of falling back to the whole summary.
  if (!keyClaimsFound && summaryText) {
    // Split into sentences (1-3 sentences per claim)
    const sentences = summaryText
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15); // Filter very short fragments
    
    // Group into 1-3 sentence chunks
    for (let i = 0; i < sentences.length; i += 2) {
      const chunk = sentences.slice(i, i + 2).join(". ").trim();
      if (chunk.length > 15) {
        claims.push({
          id: `${modelId}-summary-${claimIndex++}`,
          modelId,
          text: chunk,
          section: "summary",
        });
      }
    }
  }

  // HARD CAP: If still no claims after structured extraction, use aggressive fallback
  // This ensures we NEVER return an empty list when there is clearly content
  // Extract from:
  // - Any bullet points (anywhere in the response)
  // - Numbered lists
  // - Paragraphs under headings
  // - Long sentences that look declarative
  // - JSON-like structures (if model returns structured data)
  if (claims.length === 0 && markdown.trim().length > 50) {
    // Try JSON parsing first (some models return structured JSON)
    try {
      // Look for JSON object in the response
      const jsonMatch = markdown.match(/\{[\s\S]*"claims"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.claims && Array.isArray(parsed.claims)) {
          for (const claimItem of parsed.claims.slice(0, 12)) {
            const claimText = typeof claimItem === "string" ? claimItem : (claimItem.text || claimItem.claim || String(claimItem));
            if (claimText && claimText.length > 10) {
              claims.push({
                id: `${modelId}-json-${claimIndex++}`,
                modelId,
                text: claimText.trim(),
                section: "json",
              });
            }
          }
        }
      }
    } catch (e) {
      // JSON parsing failed, continue with heuristic extraction
    }
    
    // If JSON parsing didn't yield claims, use heuristic extraction
    if (claims.length === 0) {
    const lines = markdown.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    
    for (const line of lines) {
      // Skip markdown headers
      if (line.match(/^#+\s/)) continue;
      
      // Extract bullet points (any format)
      let bulletMatch = line.match(/^[-*•]\s+(.+)$/);
      if (!bulletMatch) {
        // Try numbered lists
        bulletMatch = line.match(/^\d+[.)]\s+(.+)$/);
      }
      if (!bulletMatch) {
        // Try indented bullets (2+ spaces)
        bulletMatch = line.match(/^\s{2,}[-*•]?\s*(.+)$/);
      }
      
      if (bulletMatch) {
        const claimText = bulletMatch[1]
          .replace(/\*\*/g, "")
          .replace(/\*/g, "")
          .trim();
        
        if (claimText.length > 15 && claimText.length < 500) {
          claims.push({
            id: `${modelId}-fallback-${claimIndex++}`,
            modelId,
            text: claimText,
            section: "fallback",
          });
          
          // Limit fallback claims to 12 to avoid noise
          if (claims.length >= 12) break;
        }
      }
    }
    
    // If still no claims, extract from long declarative sentences
    if (claims.length === 0) {
      const sentences = markdown
        .replace(/^#+\s+[^\n]+\n?/gm, "") // Remove headers
        .replace(/\*\*/g, "") // Remove bold
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20 && s.length < 300);
      
      // Take up to 10 most declarative sentences (longer ones, not questions)
      const declarative = sentences
        .filter(s => !s.endsWith("?") && s.length > 30)
        .slice(0, 10);
      
      for (const sentence of declarative) {
        claims.push({
          id: `${modelId}-sentence-${claimIndex++}`,
          modelId,
          text: sentence,
          section: "sentences",
        });
      }
    }
    
    // FINAL FALLBACK: If still no claims, take first 12 sentences as claims
    // This ensures we always return at least some claims when there's content
    if (claims.length === 0 && markdown.trim().length > 100) {
      const allSentences = markdown
        .replace(/^#+\s+[^\n]+\n?/gm, "")
        .replace(/\*\*/g, "")
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20 && s.length < 400);
      
      for (let i = 0; i < Math.min(12, allSentences.length); i++) {
        claims.push({
          id: `${modelId}-final-${claimIndex++}`,
          modelId,
          text: allSentences[i],
          section: "final",
        });
      }
    }
    }
  }

  // Debug logging: Log claims count by model to verify extraction
  if (isDebugEnabled()) {
    const sanitizedPreview = markdown.substring(0, 200).replace(/\n/g, " ");
    console.log(`[extractClaimsFromResponse] ${modelId}:`, {
      textLength: markdown.length,
      hasText: markdown.trim().length > 0,
      preview: sanitizedPreview,
      claimsCount: claims.length,
      keyClaimsFound,
      sampleClaims: claims.slice(0, 3).map(c => ({ text: c.text.substring(0, 80), section: c.section })),
    });
  }

  return claims;
}

/**
 * Normalize claim text for comparison
 * - lowercase, trim
 * - strip leading bullets (-, •, ·)
 * - remove trailing confidence markers (e.g., "Confidence: ...")
 * - remove trailing parenthetical attributions
 */
function normalizeClaimText(text: string): string {
  let t = text.toLowerCase().trim();
  t = t.replace(/^[-•·]\s+/, "");
  t = t.replace(/\s*confidence:.*$/i, "");
  t = t.replace(/\s*\([^)]*\)\s*$/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Calculate similarity between two claim texts
 * 
 * Uses Jaccard similarity on normalized words (stop words filtered)
 */
function calculateSimilarity(text1: string, text2: string): number {
  // Quick exact-match check after normalization
  const n1 = normalizeClaimText(text1);
  const n2 = normalizeClaimText(text2);
  if (n1 === n2) return 1;

  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "must", "can", "this",
    "that", "these", "those", "it", "its", "they", "them", "their",
  ]);

  const normalizeWords = (text: string): Set<string> => {
    return new Set(
      normalizeClaimText(text)
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    );
  };

  const words1 = normalizeWords(text1);
  const words2 = normalizeWords(text2);

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  
  const jaccardSimilarity = intersection.size / union.size;
  
  // Boost similarity if there's significant overlap (helps catch consensus even with different phrasing)
  // Calculate overlap ratio based on the smaller set (more lenient)
  const minSize = Math.min(words1.size, words2.size);
  const overlapRatio = minSize > 0 ? intersection.size / minSize : 0;
  
  // If there's significant word overlap (30%+), boost the similarity score
  // This helps catch cases where models say the same thing with different words
  if (overlapRatio > 0.3 && jaccardSimilarity > 0.15) {
    // More aggressive boost for higher overlap
    const boostFactor = overlapRatio > 0.5 ? 1.5 : 1.3;
    return Math.min(1, jaccardSimilarity * boostFactor);
  }
  
  // Also boost if there are at least 3-4 common words (indicating similar concepts)
  if (intersection.size >= 3 && jaccardSimilarity > 0.15) {
    return Math.min(1, jaccardSimilarity * 1.2);
  }
  
  return jaccardSimilarity;
}

/**
 * Cluster similar claims together
 * 
 * Groups claims that are semantically similar (above threshold) into clusters.
 * 
 * @param claims - Array of all claims from all models
 * @returns Array of claim clusters
 */
export function clusterClaims(claims: Claim[]): ClaimCluster[] {
  const clusters: ClaimCluster[] = [];
  const SIMILARITY_THRESHOLD = 0.2; // Further lowered to catch consensus even when models use very different phrasing

  for (const claim of claims) {
    let bestCluster: ClaimCluster | null = null;
    let bestSimilarity = 0;

    // Find the best matching cluster
    for (const cluster of clusters) {
      // Calculate max similarity to any claim in the cluster
      const maxSimilarity = Math.max(
        ...cluster.claims.map((c) => calculateSimilarity(claim.text, c.text))
      );

      if (maxSimilarity >= SIMILARITY_THRESHOLD && maxSimilarity > bestSimilarity) {
        bestSimilarity = maxSimilarity;
        bestCluster = cluster;
      }
    }

    // Add to best matching cluster or create new one
    if (bestCluster) {
      bestCluster.claims.push(claim);
      // Update modelIds set - preserve ALL model IDs, including Grok
      // We preserve all model IDs present in modelsAgree/modelsDisagree (chatgpt, claude, grok, etc.)
      // so that the Agreement / Disagreement Map supports any number of models
      const uniqueModels = new Set([...bestCluster.modelIds, claim.modelId]);
      bestCluster.modelIds = Array.from(uniqueModels);
    } else {
      clusters.push({
        id: `cluster-${clusters.length}`,
        representativeText: claim.text,
        modelIds: [claim.modelId],
        claims: [claim],
        label: "single", // Will be relabeled below
      });
    }
  }

  // Update representative text for each cluster (use the first claim's text)
  for (const cluster of clusters) {
    if (cluster.claims.length > 0) {
      cluster.representativeText = cluster.claims[0].text;
    }
  }

  // Second pass: Try to merge clusters that are similar but have different models
  // This helps catch consensus when models phrase things very differently
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cluster1 = clusters[i];
        const cluster2 = clusters[j];
        
        // Only try to merge if they have different models (potential consensus)
        const models1 = new Set(cluster1.modelIds);
        const models2 = new Set(cluster2.modelIds);
        const hasOverlap = Array.from(models1).some(m => models2.has(m));
        
        // If no model overlap, check if they're similar enough to merge
        if (!hasOverlap) {
          const similarity = calculateSimilarity(cluster1.representativeText, cluster2.representativeText);
          // Use a slightly lower threshold for merging (0.15) since we know they're from different models
          // BUT: Don't merge if they're actually disagreeing (opposing views)
          if (similarity >= 0.15 && !isDisagreement(cluster1.representativeText, cluster2.representativeText)) {
            // Merge cluster2 into cluster1
            cluster1.claims.push(...cluster2.claims);
            cluster1.modelIds = Array.from(new Set([...cluster1.modelIds, ...cluster2.modelIds]));
            // Update representative text to the longer/more detailed one
            if (cluster2.representativeText.length > cluster1.representativeText.length) {
              cluster1.representativeText = cluster2.representativeText;
            }
            // Remove cluster2
            clusters.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
      if (merged) break;
    }
  }

  return clusters;
}

/**
 * Check if two claims represent a disagreement (conflicting perspectives)
 * 
 * Uses keyword-based heuristics to detect:
 * - Opposing keywords (effective/ineffective, good/bad, support/oppose, etc.)
 * - Conflicting numeric values
 * - Semantic opposition
 * 
 * @param claim1 - First claim text
 * @param claim2 - Second claim text
 * @returns True if claims appear to conflict
 */
function isDisagreement(claim1: string, claim2: string): boolean {
  const text1 = normalizeClaimText(claim1);
  const text2 = normalizeClaimText(claim2);
  
  // Opposing keyword pairs - expanded list
  const opposingPairs = [
    ["effective", "ineffective"], ["effective", "not effective"], ["effective", "fails"], ["effective", "ineffective"],
    ["good", "bad"], ["beneficial", "harmful"], ["positive", "negative"], ["favorable", "unfavorable"],
    ["support", "oppose"], ["support", "against"], ["support", "reject"], ["support", "criticize"],
    ["agree", "disagree"], ["true", "false"], ["correct", "incorrect"], ["accurate", "inaccurate"],
    ["works", "doesn't work"], ["works", "fails"], ["succeeds", "fails"], ["succeed", "fail"],
    ["increases", "decreases"], ["raises", "lowers"], ["improves", "worsens"], ["better", "worse"],
    ["pro", "con"], ["advantage", "disadvantage"], ["strength", "weakness"], ["benefit", "drawback"],
    ["best", "worst"], ["superior", "inferior"], ["optimal", "suboptimal"], ["preferable", "undesirable"],
    ["democracy", "autocracy"], ["democratic", "authoritarian"], ["freedom", "oppression"],
    ["democracy is", "democracy is not"], ["democracy provides", "democracy fails"], ["democracy works", "democracy doesn't work"],
  ];
  
  // Check for opposing keywords
  for (const [word1, word2] of opposingPairs) {
    if ((text1.includes(word1) && text2.includes(word2)) ||
        (text1.includes(word2) && text2.includes(word1))) {
      return true;
    }
  }
  
  // Check for negation patterns (e.g., "is not", "does not", "cannot")
  const negationPatterns = [
    /\b(is|are|was|were)\s+not\b/i,
    /\b(does|do|did)\s+not\b/i,
    /\b(cannot|cannot|can't|won't|shouldn't|wouldn't)\b/i,
    /\b(no|never|neither|none)\b/i,
  ];
  
  const hasNegation1 = negationPatterns.some(pattern => pattern.test(text1));
  const hasNegation2 = negationPatterns.some(pattern => pattern.test(text2));
  
  // If one claim has negation and the other doesn't, and they're about the same topic, it's likely a disagreement
  if (hasNegation1 !== hasNegation2) {
    // Check if they're talking about similar topics (have some word overlap)
    const words1Set = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const words2Set = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const commonWords = [...words1Set].filter(w => words2Set.has(w));
    // If they share at least 2 meaningful words, it's likely a disagreement
    if (commonWords.length >= 2) {
      return true;
    }
  }
  
  // Check for conflicting numeric values (e.g., "50%" vs "80%")
  const numbers1 = text1.match(/\d+%/g) || [];
  const numbers2 = text2.match(/\d+%/g) || [];
  if (numbers1.length > 0 && numbers2.length > 0) {
    const nums1 = numbers1.map(n => parseInt(n));
    const nums2 = numbers2.map(n => parseInt(n));
    // If numbers differ significantly (>20 percentage points), might be disagreement
    const max1 = Math.max(...nums1);
    const max2 = Math.max(...nums2);
    if (Math.abs(max1 - max2) > 20) {
      return true;
    }
  }
  
  return false;
}

/**
 * Label clusters and detect disagreements
 * 
 * Rules:
 * - consensus: 2+ models making essentially the same claim
 * - single: 1 model (unique insight)
 * - disagreement: 2+ models making conflicting claims about the same topic
 * 
 * @param cluster - The cluster to label
 * @param allClusters - All clusters (to detect cross-cluster disagreements)
 * @returns The appropriate label
 */
function labelCluster(cluster: ClaimCluster, allClusters: ClaimCluster[] = []): ClaimCluster["label"] {
  const uniqueModels = new Set(cluster.modelIds);
  const modelCount = uniqueModels.size;

  if (modelCount >= 2) {
    // Check if claims within this cluster disagree with each other
    const claims = cluster.claims;
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        if (isDisagreement(claims[i].text, claims[j].text)) {
          return "disagreement";
        }
      }
    }
    
    // Check if this cluster disagrees with other clusters that have 2+ models
    // (e.g., "X is effective" vs "X is ineffective")
    // Note: We check modelIds directly rather than label, since labels may not be set yet
    for (const otherCluster of allClusters) {
      if (otherCluster.id === cluster.id) continue;
      const otherModels = new Set(otherCluster.modelIds);
      // Only check for disagreement if the other cluster also has 2+ models
      if (otherModels.size >= 2) {
        // If different models are involved, check for disagreement
        const hasOverlap = Array.from(uniqueModels).some(m => otherModels.has(m));
        if (!hasOverlap || uniqueModels.size !== otherModels.size) {
          if (isDisagreement(cluster.representativeText, otherCluster.representativeText)) {
            return "disagreement";
          }
        }
      }
    }
    
    // At least 2 models are making essentially the same claim
    return "consensus";
  }

  // Single model cluster = unique insight
  if (modelCount === 1) {
    return "single";
  }

  return "single";
}

/**
 * Build the agreement map from model results
 * 
 * @param results - Array of model results
 * @returns Array of labeled claim clusters
 */
export function buildAgreementMap(results: ModelResult[]): ClaimCluster[] {
  // Safe text getter - handles both rawTextFull and rawText fields
  const getModelText = (r: ModelResult | any): string => 
    (r as any).rawTextFull ?? (r as any).rawText ?? (r as any).text ?? "";

  // Only use successful responses
  // This is fully dynamic - includes all models with status: "ok", including Gemini, Grok, Perplexity
  // No hard-coding of specific model IDs; any model that succeeds is included in the analysis
  const successfulResults = results.filter(
    (r) => r.status === "ok" && getModelText(r).trim().length > 0
  );

  // Debug log: Verify input includes all OK models (including Gemini, Grok, Perplexity)
  // This verifies that all models (chatgpt, claude, grok, perplexity, gemini) are included when they are OK
  console.log("[buildAgreementMap] Input to analysis:", JSON.stringify({
    totalResults: results.length,
    successfulResults: successfulResults.map((r) => {
      const text = getModelText(r);
      return {
        modelId: r.modelId,
        hasText: text.trim().length > 0,
        textLength: text.length,
      };
    }),
  }, null, 2));

  if (successfulResults.length === 0) {
    return [];
  }

  // Extract claims from each model
  // This loop processes ALL successful models dynamically (ChatGPT, Claude, Grok, Perplexity, Gemini, etc.)
  // No filtering by model ID - all OK models are included
  // Includes Gemini, Perplexity, and all other models as full panel members in clustering / agreement analysis.
  const allClaims: Claim[] = [];
  // Track claim extraction for debug assertion (only used if debug is enabled)
  const claimExtractionLog: Array<{ modelId: ModelId; extractedClaimsCount: number; textLength: number; preview: string }> = [];
  for (const result of successfulResults) {
    const modelText = getModelText(result);
    if (modelText.trim().length > 0) {
      const claims = extractClaimsFromResponse(result.modelId, modelText);
      allClaims.push(...claims);
      const preview = modelText.substring(0, 200).replace(/\n/g, " ");
      claimExtractionLog.push({ 
        modelId: result.modelId, 
        extractedClaimsCount: claims.length,
        textLength: modelText.length,
        preview,
      });
      // Debug log: Verify claims are extracted for all models including Gemini, Perplexity
      console.log(`[buildAgreementMap] Extracted ${claims.length} claims from ${result.modelId} (text length: ${modelText.length})`);
    }
  }

  // Comprehensive logging for synthesis debugging
  console.log("[buildAgreementMap] Claim extraction summary:", {
    totalClaims: allClaims.length,
    claimsByModel: claimExtractionLog.reduce((acc, log) => {
      acc[log.modelId] = log.extractedClaimsCount;
      return acc;
    }, {} as Record<string, number>),
    textLengthsByModel: claimExtractionLog.reduce((acc, log) => {
      acc[log.modelId] = log.textLength;
      return acc;
    }, {} as Record<string, number>),
    previewsByModel: claimExtractionLog.reduce((acc, log) => {
      acc[log.modelId] = log.preview;
      return acc;
    }, {} as Record<string, string>),
  });

  // Debug log: Verify all model IDs are represented in claims
  const modelIdsInClaims = new Set(allClaims.map(c => c.modelId));
  console.log(`[buildAgreementMap] Model IDs in extracted claims:`, Array.from(modelIdsInClaims));

  // Cluster similar claims
  const clusters = clusterClaims(allClaims);
  
  // Always log cluster summary (not just in debug mode) for synthesis debugging
  console.log(`[buildAgreementMap] Total clusters created: ${clusters.length} (from ${allClaims.length} total claims)`);
  
  // Debug log: Verify all model IDs are preserved in clusters
  if (isDebugEnabled()) {
    clusters.forEach((cluster, idx) => {
      console.log(`[buildAgreementMap] Cluster ${idx}: modelIds=${cluster.modelIds.join(", ")}, label=${cluster.label}, claims=${cluster.claims.length}`);
    });
  }

  // Label each cluster (pass all clusters for cross-cluster disagreement detection)
  for (const cluster of clusters) {
    cluster.label = labelCluster(cluster, clusters);
  }
  
  // Always log final counts (not just in debug mode) for synthesis debugging
  const consensusCount = clusters.filter(c => c.label === "consensus").length;
  const disagreementCount = clusters.filter(c => c.label === "disagreement").length;
  const singleCount = clusters.filter(c => c.label === "single").length;
  console.log(`[buildAgreementMap] Final cluster counts: ${consensusCount} consensus, ${disagreementCount} disagreement, ${singleCount} single`);
  
  // Debug log: Verify labels after assignment
  if (isDebugEnabled()) {
    
    // Additional debug: Show clusters with 2+ models to verify they're being created
    const multiModelClusters = clusters.filter(c => c.modelIds.length >= 2);
    console.log(`[buildAgreementMap] Clusters with 2+ models: ${multiModelClusters.length}`);
    multiModelClusters.forEach((c, idx) => {
      console.log(`[buildAgreementMap] Multi-model cluster ${idx}: models=${c.modelIds.join(", ")}, label=${c.label}, claims=${c.claims.length}`);
    });
    
    // CRITICAL ASSERTION: Every model with extracted claims must appear in at least one cluster
    const successfulModelIdsWithClaims = new Set(
      claimExtractionLog
        .filter(log => log.extractedClaimsCount > 0)
        .map(log => log.modelId)
    );
    
    const modelIdsInClusters = new Set(
      clusters.flatMap(c => c.modelIds)
    );
    
    const missingModels = Array.from(successfulModelIdsWithClaims).filter(
      modelId => !modelIdsInClusters.has(modelId)
    );
    
    if (missingModels.length > 0) {
      console.error(`[buildAgreementMap] ❌ BUG: Models with claims are missing from clusters:`, missingModels);
      for (const modelId of missingModels) {
        const log = claimExtractionLog.find(l => l.modelId === modelId);
        const modelClaims = allClaims.filter(c => c.modelId === modelId);
        console.error(`[buildAgreementMap] Model ${modelId} details:`, {
          extractedClaimsCount: log?.extractedClaimsCount,
          claims: modelClaims.slice(0, 5).map(c => ({ id: c.id, text: c.text.substring(0, 100), section: c.section })),
        });
      }
    } else if (isDebugEnabled()) {
      console.log(`[buildAgreementMap] ✅ All models with claims appear in clusters`);
    }
  }

  return clusters;
}

