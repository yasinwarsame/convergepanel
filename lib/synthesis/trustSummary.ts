/**
 * Trust Summary Derivation Helper
 * 
 * Derives Strong Consensus and Contested Areas items from either:
 * 1. Legacy synthesis format (consensusAnalysis with agreementClusters)
 * 2. New structured synthesis format (StructuredSynthesis with keyFindings/disagreements)
 */

export interface TrustSummaryItem {
  id: string;
  text: string;
  confidence?: string;
  models: string[];
  refs?: string[];
}

export interface TrustSummaryItems {
  strongConsensusItems: TrustSummaryItem[];
  contestedItems: TrustSummaryItem[];
  uncertainCount: number;
}

/**
 * Normalize text for comparison (lowercase, trim, remove punctuation)
 */
function normalizeTextForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/["""'`]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect numeric conflicts in claims
 * Returns true if claims have materially different numeric values
 */
function hasNumericConflict(claims: Array<{ text: string }>): boolean {
  if (claims.length < 2) return false;
  
  const extractNumbers = (text: string): number[] => {
    const matches = text.match(/\d+(?:\.\d+)?/g) || [];
    return matches.map(m => parseFloat(m)).filter(n => n > 0); // Ignore zeros
  };
  
  const numberSets = claims.map(c => new Set(extractNumbers(c.text)));
  
  // Check if any two claims have different numbers
  for (let i = 0; i < numberSets.length; i++) {
    for (let j = i + 1; j < numberSets.length; j++) {
      const nums1 = Array.from(numberSets[i]);
      const nums2 = Array.from(numberSets[j]);
      
      // If both have numbers but they don't match, it's a conflict
      if (nums1.length > 0 && nums2.length > 0) {
        const allMatch = nums1.every(n1 => nums2.some(n2 => Math.abs(n1 - n2) < 0.01));
        if (!allMatch) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Check if claims are materially different (not just minor rewordings)
 */
function areClaimsMateriallyDifferent(claims: Array<{ text: string }>): boolean {
  if (claims.length < 2) return false;
  
  const normalized = claims.map(c => normalizeTextForComparison(c.text));
  
  // Check if we have at least 2 materially different claim texts
  const uniqueNormalized = new Set(normalized);
  if (uniqueNormalized.size >= 2) {
    // Check word overlap - if normalized texts share few words, they're materially different
    const words = normalized.map(text => new Set(text.split(/\s+/).filter(w => w.length > 3)));
    
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j < words.length; j++) {
        const words1 = words[i];
        const words2 = words[j];
        const common = Array.from(words1).filter(w => words2.has(w));
        const totalUnique = new Set([...words1, ...words2]).size;
        const similarity = totalUnique > 0 ? common.length / totalUnique : 0;
        
        // If similarity is low (< 0.3), claims are materially different
        if (similarity < 0.3) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Canonical classification helper: Determine cluster type from cluster data
 * 
 * This function is the SINGLE SOURCE OF TRUTH for cluster classification.
 * It matches the exact logic used in ResultsDisplay.tsx for rendering clusters.
 * 
 * Enhanced rules:
 * - consensus: label === "consensus" OR (2+ unique models AND no material differences AND no numeric conflicts)
 * - contested: label === "disagreement" OR (2+ unique models AND (material differences OR numeric conflicts))
 * - single: label === "single" OR (unique models === 1) OR default fallback
 * 
 * @param cluster - Cluster object with label, modelIds, and/or claims
 * @returns "consensus" | "contested" | "single"
 */
export function classifyClusterType(cluster: any): "consensus" | "contested" | "single" {
  // Extract unique model IDs from either modelIds array or claims array
  let uniqueModels: string[] = [];
  let claims: Array<{ text: string; modelId?: string }> = [];
  
  if (Array.isArray(cluster.modelIds)) {
    uniqueModels = Array.from(new Set(cluster.modelIds));
  }
  
  if (Array.isArray(cluster.claims)) {
    if (uniqueModels.length === 0) {
      uniqueModels = Array.from(new Set(cluster.claims.map((c: any) => c.modelId || c.model)));
    }
    claims = cluster.claims;
  }
  
  const modelCount = uniqueModels.length;
  const label = cluster.label || cluster.type || "";
  
  // Handle explicit labels first (but validate with heuristics if 2+ models)
  if (label === "disagreement" && modelCount >= 2) {
    return "contested";
  }
  
  // Single-model clusters (always single-model insight, even if mislabeled)
  if (label === "single" || modelCount === 1) {
    return "single";
  }
  
  // For clusters with 2+ models, apply heuristics to detect contested
  if (modelCount >= 2) {
    // If explicitly labeled consensus, trust it (unless we detect conflicts)
    if (label === "consensus") {
      // But check for numeric conflicts even with consensus label
      if (claims.length >= 2 && hasNumericConflict(claims)) {
        return "contested";
      }
      return "consensus";
    }
    
    // For clusters with 2+ models but no explicit label, check for material differences
    if (claims.length >= 2) {
      // Check for numeric conflicts
      if (hasNumericConflict(claims)) {
        return "contested";
      }
      
      // Check if claims are materially different
      if (areClaimsMateriallyDifferent(claims)) {
        return "contested";
      }
    }
    
    // Default for 2+ models with no conflicts: consensus
    return "consensus";
  }
  
  // Default fallback: treat as single-model insight if uncertain
  return "single";
}

/**
 * Normalize claim text for deduplication
 */
function normalizeClaim(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/["""'`]/g, "")
    .trim();
}

/**
 * Create a stable key for deduplication based on claim text and models
 * Exported for debug/validation purposes
 */
export function makeTrustSummaryKey(claim: string, models: string[]): string {
  const normalizedClaim = normalizeClaim(claim);
  const sortedModels = [...models].sort().join("|");
  return `${normalizedClaim}__${sortedModels}`;
}

/**
 * Internal helper for makeKey (used in dedupeItems)
 */
function makeKey(claim: string, models: string[]): string {
  return makeTrustSummaryKey(claim, models);
}

/**
 * Deduplicate items by normalized claim text + sorted model IDs
 */
function dedupeItems<T extends { claim?: string; text?: string; models: string[] }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const claimText = (it.claim ?? it.text ?? "").trim();
    if (!claimText) continue;
    const key = makeKey(claimText, it.models || []);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Check if analysis data is ready for trust summary computation
 * 
 * Returns true only when clusters/analysis data is complete and valid.
 * Prevents showing incorrect counts during intermediate loading states.
 */
export function isAnalysisReady(
  synthesizedReport: any,
  preGeneratedSynthesisReport: any
): boolean {
  // Check if we have new structured synthesis format (from API)
  const hasStructured = preGeneratedSynthesisReport && 
    Array.isArray(preGeneratedSynthesisReport.keyFindings) &&
    Array.isArray(preGeneratedSynthesisReport.disagreements);

  if (hasStructured) {
    // Structured format: ready if keyFindings exists and is an array
    // (even if empty, as long as the structure is valid)
    return Array.isArray(preGeneratedSynthesisReport.keyFindings) &&
           Array.isArray(preGeneratedSynthesisReport.disagreements);
  }

  // Legacy format: ready if consensusAnalysis exists and clusters are valid
  const ca = synthesizedReport?.consensusAnalysis;
  if (!ca) {
    return false;
  }

  const clusters = ca.agreementClusters || ca.clusters || [];
  
  // Ready if clusters array exists and all clusters have valid structure
  // (at minimum: id and either modelIds or claims)
  if (clusters.length === 0) {
    // Empty array is valid (means no clusters found, not incomplete data)
    return true;
  }
  
  // Check that clusters have valid structure (not partially loaded)
  return clusters.every((c: any) => 
    c && 
    (Array.isArray(c.modelIds) || Array.isArray(c.claims)) &&
    (c.representativeText || (c.claims && c.claims.length > 0))
  );
}

/**
 * Derive Trust Summary items from synthesis data
 * 
 * Supports both legacy (consensusAnalysis) and new structured (StructuredSynthesis) formats.
 * 
 * IMPORTANT: This function returns deduplicated items. The counts in the returned object
 * are the single source of truth for both KPI pills and rendered cards.
 * 
 * If analysis is not ready, returns empty result (call isAnalysisReady first).
 */
export function deriveTrustSummaryItems(
  synthesizedReport: any,
  preGeneratedSynthesisReport: any
): TrustSummaryItems {
  const result: TrustSummaryItems = {
    strongConsensusItems: [],
    contestedItems: [],
    uncertainCount: 0,
  };

  // Check if we have new structured synthesis format (from API)
  const hasStructured = preGeneratedSynthesisReport && 
    Array.isArray(preGeneratedSynthesisReport.keyFindings) &&
    Array.isArray(preGeneratedSynthesisReport.disagreements);

  if (hasStructured) {
    // Use structured format
    const structured = preGeneratedSynthesisReport;

    // Strong Consensus = keyFindings where modelsSupporting.length >= 2
    // THRESHOLD: >= 2 models (consistent across all checks)
    if (Array.isArray(structured.keyFindings)) {
      const rawStrongConsensus = structured.keyFindings
        .filter((finding: any) => 
          Array.isArray(finding.modelsSupporting) && 
          finding.modelsSupporting.length >= 2
        )
        .map((finding: any, idx: number) => ({
          id: `structured-consensus-${idx}`,
          text: finding.claim || '',
          confidence: finding.confidence || undefined,
          models: finding.modelsSupporting || [],
          refs: Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : undefined,
        }));
      // Deduplicate before returning
      result.strongConsensusItems = dedupeItems(rawStrongConsensus);
    }

    // Contested = disagreements where positionsByModel has >=2 distinct positions
    // THRESHOLD: >= 2 distinct model positions (consistent)
    if (Array.isArray(structured.disagreements)) {
      const rawContested = structured.disagreements
        .filter((disagreement: any) => {
          const positions = disagreement.positionsByModel;
          if (!positions || typeof positions !== 'object') return false;
          const positionKeys = Object.keys(positions);
          return positionKeys.length >= 2;
        })
        .map((disagreement: any, idx: number) => {
          const positions = disagreement.positionsByModel || {};
          const modelIds = Object.keys(positions);
          // Create a summary text from topic + whyTheyDiffer
          const summaryText = disagreement.topic 
            ? `${disagreement.topic}: ${disagreement.whyTheyDiffer || ''}`
            : disagreement.whyTheyDiffer || '';
          
          return {
            id: `structured-contested-${idx}`,
            text: summaryText,
            models: modelIds,
            refs: undefined,
          };
        });
      // Deduplicate before returning
      result.contestedItems = dedupeItems(rawContested);
    }

    // Uncertain count: count keyFindings with single model OR use existing count if available
    if (Array.isArray(structured.keyFindings)) {
      result.uncertainCount = structured.keyFindings.filter(
        (finding: any) => 
          !Array.isArray(finding.modelsSupporting) || 
          finding.modelsSupporting.length === 1
      ).length;
    }
  } else {
    // Use legacy format (consensusAnalysis)
    const ca = synthesizedReport?.consensusAnalysis;
    if (!ca) {
      return result;
    }

    // Get clusters (agreementClusters preferred, fallback to clusters)
    const clusters = ca.agreementClusters || ca.clusters || [];
    
    // Strong Consensus = clusters classified as "consensus" using canonical helper
    // THRESHOLD: >= 2 models (consistent with structured format)
    const rawStrongConsensus = clusters
      .filter((cluster: any) => classifyClusterType(cluster) === "consensus")
      .map((cluster: any, idx: number) => ({
        id: cluster.id || `legacy-consensus-${idx}`,
        text: cluster.representativeText || cluster.claims?.[0]?.text || '',
        models: cluster.modelIds || Array.from(new Set(cluster.claims?.map((c: any) => c.modelId) || [])),
        refs: undefined,
      }));
    // Deduplicate before returning
    result.strongConsensusItems = dedupeItems(rawStrongConsensus);

    // Contested = clusters classified as "contested" using canonical helper
    const rawContested = clusters
      .filter((cluster: any) => classifyClusterType(cluster) === "contested")
      .map((cluster: any, idx: number) => ({
        id: cluster.id || `legacy-contested-${idx}`,
        text: cluster.representativeText || cluster.claims?.[0]?.text || '',
        models: cluster.modelIds || Array.from(new Set(cluster.claims?.map((c: any) => c.modelId) || [])),
        refs: undefined,
      }));
    // Deduplicate before returning
    result.contestedItems = dedupeItems(rawContested);

    // Single-model insight count: Count from the ACTUAL clusters being rendered
    // This must match the Agreement Map rendering logic exactly
    // Use the canonical classification helper to ensure consistency
    const singleModelClusters = clusters.filter((c: any) => classifyClusterType(c) === "single");
    result.uncertainCount = singleModelClusters.length;
    
    // Fallback: If count is 0 but we have clusters, try legacy fields as backup
    // (but prefer the actual cluster count)
    if (result.uncertainCount === 0 && clusters.length > 0) {
      const legacyCount = ca.trustSummary?.uncertainPoints ?? ca.singleModelInsightsCount;
      if (typeof legacyCount === "number" && legacyCount > 0) {
        // In dev, log a warning if counts don't match
        if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
          console.warn("[trustSummary] Single-model count mismatch:", {
            clusterBasedCount: result.uncertainCount,
            legacyCount,
            totalClusters: clusters.length,
            clustersWithSingleLabel: clusters.filter((c: any) => c.label === "single").length,
            clustersWithOneModel: clusters.filter((c: any) => {
              const modelIds = c.modelIds || [];
              const claimModels = Array.isArray(c.claims) 
                ? Array.from(new Set(c.claims.map((cl: any) => cl.modelId))) 
                : [];
              return (Array.isArray(modelIds) && modelIds.length === 1) || claimModels.length === 1;
            }).length,
          });
        }
        // Use legacy count only if our classification found zero (might indicate a bug)
        // But prefer to trust the actual cluster classification
        result.uncertainCount = legacyCount;
      }
    }
  }

  return result;
}

