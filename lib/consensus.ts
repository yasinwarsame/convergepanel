/**
 * Consensus Engine
 * 
 * This module analyzes responses from multiple AI models and identifies:
 * - Areas of agreement (consensus)
 * - Areas of disagreement (contested points)
 * - Numeric conflicts (when models provide different numbers)
 * Consensus aggregation entrypoint: synthesizeReport()
 * The engine works in several steps:
 * 1. Extract claims from each model's response (sentence-level)
 * 2. Cluster similar claims using keyword-based similarity
 * 3. Identify consensus (≥2 models agree) vs disagreements
 * 4. Detect numeric conflicts
 * 5. Generate a unified synthesized report
 * 
 * This is a heuristic-based approach. For production, consider using
 * embeddings (e.g., OpenAI embeddings) for more accurate similarity.
 * 
 * SYNTHESIZED REPORT SCHEMA:
 * The synthesizeReport() function returns a SynthesizedReport object with this structure:
 * {
 *   unifiedAnswer: string (HTML-formatted synthesis),
 *   consensusAnalysis: {
 *     clusters: ClaimCluster[] (legacy format),
 *     trustSummary: { strongConsensus: number, contestedAreas: number, uncertainPoints: number },
 *     agreementClusters: Array<{ id, representativeText, modelIds, claims, label }> (preferred format),
 *     consensusFindings: Array<{ text, modelIds }>,
 *     contestedFindings: Array<{ text, modelIds }>,
 *     singleModelInsightsCount: number
 *   },
 *   rawResponses: Array<{ modelId, text, status }>
 * }
 * 
 * The client-side code in app/page.tsx calls synthesizeReport() and expects this exact shape.
 * The UI component ResultsDisplay.tsx reads synthesizedReport.consensusAnalysis.agreementClusters
 * to render the Agreement/Disagreement Map.
 */

import {
  ModelResult,
  Claim,
  ClaimCluster,
  ConsensusAnalysis,
  SynthesizedReport,
  ModelId,
} from "@/lib/types";
import { buildAgreementMap, ClaimCluster as AgreementClaimCluster } from "@/lib/agreementMap";
import { MODEL_INFO } from "@/lib/modelInfo";
import { isUsableResult } from "@/lib/panel/publicize";

const SYSTEM_WRAPPER =
  "Answer clearly. Provide your key claims and any relevant figures. If unsure, say so.";

type ClusterLabel = AgreementClaimCluster["label"];

function normalizeClusterLabel(label: unknown): ClusterLabel {
  if (label === "contested") {
    return "disagreement";
  }
  if (label === "consensus" || label === "single" || label === "disagreement") {
    return label;
  }
  return "single";
}

/**
 * Extract claims from a model's response text
 * 
 * Handles both structured markdown format (with headers) and plain text.
 * Extracts claims from:
 * - Bullet points (lines starting with - or *)
 * - Numbered lists
 * - Sentences in structured sections
 * 
 * @param text - The model's response text
 * @param modelId - Which model this response came from
 * @returns Array of claim objects with text, model ID, and original index
 */
function extractClaims(text: string, modelId: ModelId): Claim[] {
  const claims: Claim[] = [];
  let claimIndex = 0;

  // Remove markdown headers and normalize
  const normalizedText = text
    .replace(/^#+\s+/gm, "") // Remove markdown headers
    .replace(/\*\*/g, "") // Remove bold markers
    .replace(/\*/g, "") // Remove italic markers
    .trim();

  // Split into lines for structured extraction
  const lines = normalizedText.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    // Extract bullet points (lines starting with - or *)
    if (/^[-*•]\s+/.test(line)) {
      const claimText = line.replace(/^[-*•]\s+/, "").trim();
      if (claimText.length > 10) {
        claims.push({
          text: claimText,
          modelId,
          originalIndex: claimIndex++,
        });
      }
    }
    // Extract numbered list items
    else if (/^\d+[.)]\s+/.test(line)) {
      const claimText = line.replace(/^\d+[.)]\s+/, "").trim();
      if (claimText.length > 10) {
        claims.push({
          text: claimText,
          modelId,
          originalIndex: claimIndex++,
        });
      }
    }
    // Extract regular sentences (split by sentence boundaries)
    else {
      const sentences = line
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
      
      for (const sentence of sentences) {
        claims.push({
          text: sentence,
          modelId,
          originalIndex: claimIndex++,
        });
      }
    }
  }

  return claims;
}

/**
 * Common stop words that don't add semantic meaning
 * These are filtered out to improve similarity matching
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "must", "can", "this",
  "that", "these", "those", "it", "its", "they", "them", "their",
  "there", "then", "than", "what", "which", "who", "when", "where",
  "why", "how", "about", "into", "through", "during", "before", "after",
  "above", "below", "up", "down", "out", "off", "over", "under", "again",
  "further", "then", "once", "here", "when", "where", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "now"
]);

/**
 * Calculate similarity between two claims using keyword overlap
 * 
 * Improved version that:
 * 1. Filters out stop words
 * 2. Uses a more lenient similarity threshold
 * 3. Handles markdown and structured text better
 * 
 * Returns a value between 0 (no similarity) and 1 (identical).
 * 
 * @param claim1 - First claim text
 * @param claim2 - Second claim text
 * @returns Similarity score (0-1)
 */
function calculateSimilarity(claim1: string, claim2: string): number {
  // Normalize and extract meaningful words
  const normalize = (text: string): Set<string> => {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ") // Remove punctuation
        .replace(/\s+/g, " ") // Normalize whitespace
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)) // Filter short words and stop words
    );
  };

  const words1 = normalize(claim1);
  const words2 = normalize(claim2);

  // If either set is empty after filtering, return 0
  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  // Calculate Jaccard similarity: intersection / union
  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  
  const similarity = intersection.size / union.size;
  
  // Boost similarity if there's significant overlap (helps with structured responses)
  // If more than 40% of words overlap, increase the score slightly
  const overlapRatio = intersection.size / Math.min(words1.size, words2.size);
  if (overlapRatio > 0.4) {
    return Math.min(1, similarity * 1.2);
  }
  
  return similarity;
}

/**
 * Extract numeric values from text
 * 
 * Finds all numbers, percentages, and numeric values in a claim.
 * Used to detect numeric conflicts when models provide different numbers
 * for the same claim.
 * 
 * @param text - The claim text to search
 * @returns Array of found numbers with surrounding context
 */
function extractNumbers(text: string): Array<{ value: string; fullText: string }> {
  // Pattern matches:
  // - Simple numbers: 42, 3.14
  // - Percentages: 50%
  // - Formatted numbers: 1,000, 1,234.56
  const numberPattern = /(\d+(?:\.\d+)?%?|\d+(?:,\d{3})*(?:\.\d+)?)/g;
  const matches: Array<{ value: string; fullText: string }> = [];
  let match;

  while ((match = numberPattern.exec(text)) !== null) {
    // Include surrounding context (20 chars before and after) for better understanding
    matches.push({
      value: match[1],
      fullText: text.substring(Math.max(0, match.index - 20), match.index + match[0].length + 20),
    });
  }

  return matches;
}

const NEGATION_MARKERS = [
  "not",
  "no ",
  "unlikely",
  "cannot",
  "can't",
  "little evidence",
  "insufficient evidence",
  "doesn't",
  "does not",
];

function normalizeNumericValue(rawValue: string): number | null {
  const cleaned = rawValue.replace(/[,%]/g, "");
  const parsed = parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function extractNumericValues(text: string): number[] {
  return extractNumbers(text)
    .map((entry) => normalizeNumericValue(entry.value))
    .filter((n): n is number => typeof n === "number" && n > 0);
}

function hasNegationMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return NEGATION_MARKERS.some((marker) => lower.includes(marker));
}

function buildNumericConflictsForAgreementCluster(cluster: {
  label: ClusterLabel;
  claims: Array<{ text: string; modelId: ModelId }>;
  modelIds: ModelId[];
  id?: string;
  representativeText?: string;
}): ClaimCluster["numericConflicts"] {
  const conflicts: ClaimCluster["numericConflicts"] = [];
  const numericClaims = cluster.claims.filter(
    (claim) => extractNumericValues(claim.text).length > 0
  );

  for (let i = 0; i < numericClaims.length; i++) {
    for (let j = i + 1; j < numericClaims.length; j++) {
      const nums1 = extractNumericValues(numericClaims[i].text);
      const nums2 = extractNumericValues(numericClaims[j].text);

      if (nums1.length === 0 || nums2.length === 0) continue;

      const hasConflict = nums1.some(
        (n1) => !nums2.some((n2) => Math.abs(n1 - n2) < 0.01)
      );

      if (hasConflict) {
        conflicts.push({
          claim1: {
            text: numericClaims[i].text,
            modelId: numericClaims[i].modelId,
            originalIndex: 0,
          },
          claim2: {
            text: numericClaims[j].text,
            modelId: numericClaims[j].modelId,
            originalIndex: 0,
          },
          values: Array.from(
            new Set([
              ...extractNumbers(numericClaims[i].text).map((n) => n.value),
              ...extractNumbers(numericClaims[j].text).map((n) => n.value),
            ])
          ),
        });
      }
    }
  }

  return conflicts;
}

function hasNumericConflictInAgreementCluster(cluster: AgreementClaimCluster): boolean {
  return buildNumericConflictsForAgreementCluster({
    ...cluster,
    label: normalizeClusterLabel(cluster.label),
  }).length > 0;
}

function hasPolarityConflictInAgreementCluster(
  cluster: AgreementClaimCluster
): boolean {
  const claimsByModel = new Map<ModelId, string>();
  for (const claim of cluster.claims) {
    if (!claimsByModel.has(claim.modelId)) {
      claimsByModel.set(claim.modelId, claim.text);
    }
  }

  if (claimsByModel.size < 2) return false;

  const polarities = Array.from(claimsByModel.values()).map((text) =>
    hasNegationMarker(text)
  );
  return polarities.some((p) => p) && polarities.some((p) => !p);
}

/**
 * Cluster similar claims together
 * 
 * Groups claims that are similar (talking about the same thing) into clusters.
 * Uses a similarity threshold to determine if claims should be grouped.
 * 
 * After clustering, determines:
 * - Consensus: If ≥2 models have claims in the same cluster
 * - Numeric conflicts: If claims in a cluster have different numbers
 * 
 * @param claims - Array of all claims from all models
 * @returns Array of claim clusters with consensus and conflict information
 */
function clusterClaims(claims: Claim[]): ClaimCluster[] {
  const clusters: ClaimCluster[] = [];
  
  // Similarity threshold: claims with similarity >= 0.25 are considered related
  // Lowered from 0.3 to 0.25 to be more lenient and catch more consensus
  // This helps with structured markdown responses where wording may vary
  const SIMILARITY_THRESHOLD = 0.25;

  /**
   * Clustering Algorithm
   * 
   * For each claim:
   * 1. Try to find an existing cluster where it fits (similarity >= threshold)
   * 2. Uses maximum similarity (not average) to be more lenient
   * 3. If found, add claim to that cluster
   * 4. If not found, create a new cluster
   * 
   * This is a simple greedy clustering approach. Using max similarity instead
   * of average helps catch more consensus cases where one claim is very similar
   * even if others in the cluster are less similar.
   */
  for (const claim of claims) {
    let assigned = false;
    let bestCluster: ClaimCluster | null = null;
    let bestSimilarity = 0;

    // Try to find the best matching cluster
    for (const cluster of clusters) {
      // Calculate maximum similarity to any claim in this cluster
      // This is more lenient than average and helps catch consensus better
      const maxSimilarity = Math.max(
        ...cluster.claims.map((c) => calculateSimilarity(claim.text, c.text))
      );

      // Track the best match
      if (maxSimilarity >= SIMILARITY_THRESHOLD && maxSimilarity > bestSimilarity) {
        bestSimilarity = maxSimilarity;
        bestCluster = cluster;
      }
    }

    // Add to best matching cluster if found
    if (bestCluster) {
      bestCluster.claims.push(claim);
      assigned = true;
    }

    // Create new cluster if no existing cluster matches
    if (!assigned) {
      clusters.push({
        id: `cluster-${clusters.length}`,
        claims: [claim],
        consensus: false, // Will be determined below
        numericConflicts: [], // Will be populated below if conflicts found
      });
    }
  }

  /**
   * Post-Processing: Determine Consensus and Conflicts
   * 
   * After clustering, analyze each cluster to:
   * 1. Determine if it represents consensus (≥2 models agree)
   * 2. Detect numeric conflicts (different numbers for same claim)
   */
  for (const cluster of clusters) {
    // Consensus: If ≥2 different models have claims in this cluster
    const uniqueModels = new Set(cluster.claims.map((c) => c.modelId));
    cluster.consensus = uniqueModels.size >= 2;

    /**
     * Numeric Conflict Detection
     * 
     * If multiple claims in a cluster contain numbers, check if they conflict.
     * A conflict exists if:
     * - Two claims have different numeric values
     * - They're in the same cluster (talking about the same thing)
     */
    const numericClaims = cluster.claims.filter((c) =>
      extractNumbers(c.text).length > 0
    );

    if (numericClaims.length >= 2) {
      // Extract all numbers from each numeric claim
      const numbers = numericClaims.map((c) => ({
        claim: c,
        numbers: extractNumbers(c.text),
      }));

      // Compare all pairs of numeric claims
      for (let i = 0; i < numbers.length; i++) {
        for (let j = i + 1; j < numbers.length; j++) {
          const nums1 = numbers[i].numbers;
          const nums2 = numbers[j].numbers;

          // Get all numeric values from each claim
          const values1 = nums1.map((n) => n.value);
          const values2 = nums2.map((n) => n.value);

          // Check if there are different numeric values
          // (ignoring zero values as they might be placeholders)
          const hasConflict = values1.some(
            (v1) => !values2.includes(v1) && parseFloat(v1.replace(/[%,]/g, "")) > 0
          );

          // If conflict found, record it
          if (hasConflict) {
            cluster.numericConflicts.push({
              claim1: numbers[i].claim,
              claim2: numbers[j].claim,
              values: [...new Set([...values1, ...values2])], // All conflicting values
            });
          }
        }
      }
    }
  }

  return clusters;
}

/**
 * Generate Synthesized Report
 * 
 * This is the main entry point for consensus analysis. It:
 * 1. Filters to only successful responses (status === "ok")
 * 2. Extracts claims from each response
 * 3. Clusters similar claims
 * 4. Identifies consensus vs disagreements
 * 5. Generates a unified report with trust summary
 * 
 * IMPORTANT: Returns null if <2 successful responses. This enforces the
 * core rule that convergence requires multiple perspectives.
 * 
 * @param results - Array of model results from panel execution
 * @returns Synthesized report with unified answer and analysis, or null if <2 responses
 */
export function synthesizeReport(
  results: ModelResult[]
): SynthesizedReport | null {
  // Only use successful responses (status === "ok" and has text)
  // This is now fully dynamic and will include all models with OK status, including Gemini, Grok, and Perplexity
  // No hard-coding of specific model IDs - any model that returns status: "ok" is included
  // Includes Gemini, Perplexity, and all other models as full panel members in clustering / agreement analysis.
  // Use safe text getter to handle both rawTextFull and rawText fields
  const getModelText = (r: ModelResult | any): string => 
    (r as any).rawTextFull ?? (r as any).rawText ?? (r as any).text ?? "";
  const successfulResults = results.filter((r) => isUsableResult(r) && getModelText(r).trim().length > 0);

  /**
   * Core Rule: Cannot synthesize with <2 responses
   * 
   * If only 1 model responded, there's no basis for convergence analysis.
   * The client will show a warning banner instead of synthesis.
   */
  if (successfulResults.length < 2) {
    return null; // Cannot synthesize with <2 responses
  }

  // Build agreement map using claim extraction + similarity clustering
  // Wrap in try-catch to prevent crashes if buildAgreementMap fails
  let agreementClusters: AgreementClaimCluster[];
  
  try {
    // Log input for debugging
    console.log("[synthesizeReport] Starting synthesis:", {
      totalResults: results.length,
      successfulResults: successfulResults.length,
      modelIds: successfulResults.map(r => r.modelId),
    });
    
    agreementClusters = buildAgreementMap(results);
    
    // Log claim extraction results (buildAgreementMap logs internally, but summarize here)
    // We'll get detailed logs from buildAgreementMap, but add a summary
    console.log("[synthesizeReport] Agreement map built:", {
      totalClusters: agreementClusters.length,
      consensusClusters: agreementClusters.filter(c => c.label === "consensus").length,
      disagreementClusters: agreementClusters.filter(c => c.label === "disagreement").length,
      singleClusters: agreementClusters.filter(c => c.label === "single").length,
    });
  } catch (error: any) {
    console.error("[synthesizeReport] Error building agreement map:", error);
    // Return a safe minimal synthesized report with empty agreement map
    // This prevents the UI from crashing when agreement map generation fails
    agreementClusters = [];
  }

  const adjustedAgreementClusters: AgreementClaimCluster[] = agreementClusters.map(
    (cluster): AgreementClaimCluster => {
    const modelIds = cluster.modelIds?.length
      ? cluster.modelIds
      : Array.from(new Set(cluster.claims.map((claim) => claim.modelId)));
    const modelCount = modelIds.length;

    const normalizedLabel = normalizeClusterLabel(cluster.label);

    if (normalizedLabel === "disagreement" || modelCount < 2) {
      return { ...cluster, modelIds, label: normalizedLabel };
    }

    const numericConflict = hasNumericConflictInAgreementCluster(cluster);
    const polarityConflict = hasPolarityConflictInAgreementCluster(cluster);

    if (numericConflict || polarityConflict) {
      return { ...cluster, modelIds, label: "disagreement" };
    }

    return { ...cluster, modelIds, label: normalizedLabel };
  });

  // Convert agreementClusters to legacy structures for backward compatibility
  const clusters: ClaimCluster[] = adjustedAgreementClusters.map((ac) => ({
    id: ac.id,
    claims: ac.claims.map((c) => ({
      text: c.text,
      modelId: c.modelId,
      originalIndex: 0, // Not used in new format
    })),
    consensus: ac.label === "consensus",
    numericConflicts: buildNumericConflictsForAgreementCluster({
      ...ac,
      label: normalizeClusterLabel(ac.label),
    }),
  }));

  // Calculate trust summary - filter clusters by label
  const consensusClusters = adjustedAgreementClusters.filter((c) => c.label === "consensus");
  const singleClusters = adjustedAgreementClusters.filter((c) => c.label === "single");
  const disagreementClusters = adjustedAgreementClusters.filter((c) => c.label === "disagreement");

  const consensusAnalysis: ConsensusAnalysis = {
    clusters,
    trustSummary: {
      strongConsensus: consensusClusters.length,
      contestedAreas: disagreementClusters.length,
      uncertainPoints: singleClusters.length,
    },
    // Add new agreement map data
    agreementClusters: adjustedAgreementClusters.map((ac) => ({
      id: ac.id,
      representativeText: ac.representativeText,
      modelIds: ac.modelIds,
      claims: ac.claims,
      label: ac.label,
    })),
    consensusFindings: consensusClusters.map((c) => ({
      text: c.representativeText,
      modelIds: c.modelIds,
    })),
    contestedFindings: disagreementClusters.map((c) => ({
      text: c.representativeText,
      modelIds: c.modelIds,
    })),
    singleModelInsightsCount: singleClusters.length,
  };

  // Generate unified answer with explicit consensus identification
  // Note: Trust Summary is displayed as visual pills in the UI, but we include it in HTML for fallback
  let unifiedAnswer = "<h2>Trust Summary</h2>\n\n";
  
  // Enhanced Trust Summary with explicit grouping
  unifiedAnswer += "<h3>Where the models agree</h3>\n\n";
  if (consensusClusters.length > 0) {
    unifiedAnswer += `<p><strong>Strong Consensus:</strong> ${consensusClusters.length} areas where multiple models agree</p>\n\n`;
    unifiedAnswer += "<ul>\n";
    consensusClusters.slice(0, 7).forEach((cluster) => {
      const modelCount = new Set(cluster.claims.map((c) => c.modelId)).size;
      const modelNames = Array.from(new Set(cluster.claims.map((c) => c.modelId)))
        .map((id) => MODEL_INFO[id]?.displayName || id)
        .join(", ");
      unifiedAnswer += `<li><strong>${cluster.representativeText}</strong> — <em>Agreed by ${modelCount} models (${modelNames})</em></li>\n`;
    });
    unifiedAnswer += "</ul>\n\n";
  } else {
    unifiedAnswer += "<p><em>No strong consensus areas identified across the models.</em></p>\n\n";
  }

  unifiedAnswer += "<h3>Where the models disagree</h3>\n\n";
  if (disagreementClusters.length > 0) {
    unifiedAnswer += `<p><strong>Contested Areas:</strong> ${disagreementClusters.length} points where models provide conflicting or incompatible perspectives</p>\n\n`;
    unifiedAnswer += "<ul>\n";
    disagreementClusters.slice(0, 7).forEach((cluster) => {
      const modelNames = cluster.modelIds
        .map((id) => MODEL_INFO[id]?.displayName || id)
        .join(", ");
      unifiedAnswer += `<li class="bg-orange-50 border-l-4 border-orange-400 pl-4 py-2 rounded-r-md my-2"><strong>${cluster.representativeText}</strong> — <em>Different perspectives from: ${modelNames}</em></li>\n`;
    });
    unifiedAnswer += "</ul>\n\n";
  } else {
    unifiedAnswer += "<p><em>No major disagreements identified across the models.</em></p>\n\n";
  }

  unifiedAnswer += "<h3>What is uncertain or weakly supported</h3>\n\n";
  if (singleClusters.length > 0) {
    // Keep a concise note only; detailed single-model bullets are shown in the Agreement/Disagreement map
    unifiedAnswer += `<p><strong>Uncertain Points:</strong> ${singleClusters.length} claim${singleClusters.length === 1 ? "" : "s"} mentioned by only one model. See the Agreement / Disagreement map and Single-model insights below for details.</p>\n\n`;
  } else {
    unifiedAnswer += "<p><em>No uncertain or single-model claims identified.</em></p>\n\n";
  }

  // Main synthesis body heading - H3 level (H2 is "Unified Answer" main section title in UI)
  unifiedAnswer += "<h3>Overall Synthesis</h3>\n\n";

  // Add consensus claims with more detail
  // Heading hierarchy: H4 level (under H3 "Overall Synthesis")
  if (consensusClusters.length > 0) {
    unifiedAnswer += "<h4>Areas of Agreement</h4>\n\n";
    unifiedAnswer += "<p>The following points represent <strong>consensus claims</strong> supported by multiple models:</p>\n\n";
    consensusClusters.slice(0, 8).forEach((cluster) => {
      const representativeClaim = cluster.claims[0];
      const modelCount = new Set(cluster.claims.map((c) => c.modelId)).size;
      const modelNames = Array.from(new Set(cluster.claims.map((c) => c.modelId)))
        .map((id) => MODEL_INFO[id]?.displayName || id)
        .join(", ");
      unifiedAnswer += `<p class="bg-green-50 border-l-4 border-green-400 pl-4 py-2 rounded-r-md my-2"><strong>• ${representativeClaim.text}</strong> <em>(Consensus: ${modelCount} models agree — ${modelNames})</em></p>\n`;
    });
    unifiedAnswer += "\n";
  }

  // Add contested areas (disagreements) with more detail
  // Heading hierarchy: H4 level (under H3 "Overall Synthesis")
  if (disagreementClusters.length > 0) {
    unifiedAnswer += "<h4>Model Split / Disagreements</h4>\n\n";
    unifiedAnswer += "<p>The following points represent <strong>contested claims</strong> where models provide conflicting or incompatible perspectives:</p>\n\n";
    disagreementClusters.slice(0, 8).forEach((cluster) => {
      const models = cluster.modelIds;
      const modelNames = models.map((id) => MODEL_INFO[id]?.displayName || id).join(", ");
      // Wrap entire disagreement cluster in light orange container
      unifiedAnswer += `<div class="bg-orange-50 border-l-4 border-orange-400 pl-4 py-3 rounded-r-md my-2">\n`;
      unifiedAnswer += `<p class="mb-2"><strong>Different perspectives on:</strong> ${cluster.representativeText}</p>\n`;
      unifiedAnswer += `<p class="text-sm text-slate-700 mb-2"><em>Models with conflicting views: ${modelNames}</em></p>\n`;
      
      // Show individual claims from different models if available
      const uniqueModelClaims = new Map<ModelId, string>();
      cluster.claims.forEach((claim) => {
        if (!uniqueModelClaims.has(claim.modelId)) {
          uniqueModelClaims.set(claim.modelId, claim.text);
        }
      });
      if (uniqueModelClaims.size > 1) {
        unifiedAnswer += "<ul class=\"ml-4 mt-2 space-y-1\">\n";
        uniqueModelClaims.forEach((text, modelId) => {
          const modelName = MODEL_INFO[modelId]?.displayName || modelId;
          unifiedAnswer += `<li class="mb-1"><strong>${modelName}:</strong> ${text}</li>\n`;
        });
        unifiedAnswer += "</ul>\n";
      }
      unifiedAnswer += `</div>\n\n`;
    });
  }

  // Do NOT render detailed single-model bullets here to avoid duplication.
  // Single-model insights are displayed in the Agreement / Disagreement map below.

  // Ensure consensusAnalysis is always defined (never null/undefined)
  // This prevents UI crashes when accessing consensusAnalysis properties
  const safeConsensusAnalysis = consensusAnalysis || {
    clusters: [],
    trustSummary: {
      strongConsensus: 0,
      contestedAreas: 0,
      uncertainPoints: 0,
    },
    agreementClusters: [],
    consensusFindings: [],
    contestedFindings: [],
    singleModelInsightsCount: 0,
  };

  return {
    unifiedAnswer,
    consensusAnalysis: safeConsensusAnalysis,
    rawResponses: successfulResults.map((r) => ({
      modelId: r.modelId,
      text: getModelText(r),
      status: r.status,
    })),
  };
}

