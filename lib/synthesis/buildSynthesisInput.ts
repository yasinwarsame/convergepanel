/**
 * Build compact synthesis input from cluster data
 * 
 * Instead of sending 5×8000 char raw responses, we use the already-computed
 * agreement clusters and consensus analysis to create a compact input (~10-20KB).
 */

export interface BuildSynthesisInputParams {
  question: string;
  modelIds: string[];
  agreementClusters: Array<{
    id: string;
    representativeText: string;
    modelIds: string[];
    claims: Array<{ id: string; modelId: string; text: string }>;
    label: "consensus" | "single" | "disagreement";
  }>;
  clusters?: Array<{
    id: string;
    claims: Array<{ text: string; modelId: string }>;
    consensus: boolean;
  }>;
}

export function buildSynthesisInput(params: BuildSynthesisInputParams): string {
  const { question, modelIds, agreementClusters, clusters } = params;
  
  // Build compact cluster summary
  const consensusClusters = agreementClusters.filter(c => c.label === "consensus");
  const disagreementClusters = agreementClusters.filter(c => c.label === "disagreement");
  const singleClusters = agreementClusters.filter(c => c.label === "single");
  
  const clusterSummary = {
    question,
    models: modelIds,
    consensus: consensusClusters.map(c => ({
      text: c.representativeText,
      models: c.modelIds,
      claimCount: c.claims.length,
    })),
    disagreements: disagreementClusters.map(c => ({
      topic: c.representativeText,
      models: c.modelIds,
      positions: c.claims.map(claim => ({
        model: claim.modelId,
        text: claim.text,
      })),
    })),
    singleModelInsights: singleClusters.map(c => ({
      model: c.modelIds[0],
      text: c.representativeText,
    })),
  };
  
  // Convert to compact JSON string (max ~20KB)
  return JSON.stringify(clusterSummary, null, 0);
}

