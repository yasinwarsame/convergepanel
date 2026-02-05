/**
 * Unit tests for Trust Summary classification and computation
 * 
 * Tests that cluster classification is deterministic and consistent,
 * and that counts match what's rendered in the Agreement Map.
 */

import { classifyClusterType, isAnalysisReady, deriveTrustSummaryItems } from './trustSummary';

describe('classifyClusterType', () => {
  it('should classify consensus cluster (2+ models, consensus label)', () => {
    const cluster = {
      id: 'cluster-1',
      label: 'consensus',
      modelIds: ['model1', 'model2'],
      representativeText: 'Models agree on this point',
      claims: [
        { id: 'c1', modelId: 'model1', text: 'Agreed point' },
        { id: 'c2', modelId: 'model2', text: 'Agreed point' },
      ],
    };
    
    expect(classifyClusterType(cluster)).toBe('consensus');
  });

  it('should classify contested cluster (disagreement label, 2+ models)', () => {
    const cluster = {
      id: 'cluster-2',
      label: 'disagreement',
      modelIds: ['model1', 'model2'],
      representativeText: 'Models disagree',
      claims: [
        { id: 'c1', modelId: 'model1', text: 'Position A' },
        { id: 'c2', modelId: 'model2', text: 'Position B' },
      ],
    };
    
    expect(classifyClusterType(cluster)).toBe('contested');
  });

  it('should classify single-model cluster (1 model)', () => {
    const cluster = {
      id: 'cluster-3',
      label: 'single',
      modelIds: ['model1'],
      representativeText: 'Unique insight',
      claims: [
        { id: 'c1', modelId: 'model1', text: 'Unique claim' },
      ],
    };
    
    expect(classifyClusterType(cluster)).toBe('single');
  });

  it('should classify single-model even if label is missing but has 1 model', () => {
    const cluster = {
      id: 'cluster-4',
      modelIds: ['model1'],
      representativeText: 'Single model claim',
      claims: [
        { id: 'c1', modelId: 'model1', text: 'Claim' },
      ],
    };
    
    expect(classifyClusterType(cluster)).toBe('single');
  });

  it('should classify consensus if 2+ models even without explicit label', () => {
    const cluster = {
      id: 'cluster-5',
      modelIds: ['model1', 'model2'],
      representativeText: 'Agreed point',
      claims: [
        { id: 'c1', modelId: 'model1', text: 'Point' },
        { id: 'c2', modelId: 'model2', text: 'Point' },
      ],
    };
    
    expect(classifyClusterType(cluster)).toBe('consensus');
  });
});

describe('isAnalysisReady', () => {
  it('should return true for structured format with valid arrays', () => {
    const preGenerated = {
      keyFindings: [],
      disagreements: [],
    };
    
    expect(isAnalysisReady(null, preGenerated)).toBe(true);
  });

  it('should return true for legacy format with valid clusters', () => {
    const synthesized = {
      consensusAnalysis: {
        agreementClusters: [
          {
            id: 'c1',
            modelIds: ['model1'],
            representativeText: 'Test',
            claims: [{ id: 'c1', modelId: 'model1', text: 'Test' }],
          },
        ],
      },
    };
    
    expect(isAnalysisReady(synthesized, null)).toBe(true);
  });

  it('should return true for empty clusters array (valid state)', () => {
    const synthesized = {
      consensusAnalysis: {
        agreementClusters: [],
      },
    };
    
    expect(isAnalysisReady(synthesized, null)).toBe(true);
  });

  it('should return false when consensusAnalysis is missing', () => {
    expect(isAnalysisReady(null, null)).toBe(false);
    expect(isAnalysisReady({}, null)).toBe(false);
  });

  it('should return false when clusters have invalid structure', () => {
    const synthesized = {
      consensusAnalysis: {
        agreementClusters: [
          { id: 'c1' }, // Missing modelIds and claims
        ],
      },
    };
    
    expect(isAnalysisReady(synthesized, null)).toBe(false);
  });
});

describe('deriveTrustSummaryItems - regression: stable counts', () => {
  it('should return stable counts for same input (no flicker)', () => {
    const synthesized = {
      consensusAnalysis: {
        agreementClusters: [
          {
            id: 'consensus-1',
            label: 'consensus',
            modelIds: ['model1', 'model2'],
            representativeText: 'Agreed point',
            claims: [
              { id: 'c1', modelId: 'model1', text: 'Point' },
              { id: 'c2', modelId: 'model2', text: 'Point' },
            ],
          },
          {
            id: 'contested-1',
            label: 'disagreement',
            modelIds: ['model1', 'model2'],
            representativeText: 'Disagreement',
            claims: [
              { id: 'c3', modelId: 'model1', text: 'Position A' },
              { id: 'c4', modelId: 'model2', text: 'Position B' },
            ],
          },
          {
            id: 'single-1',
            label: 'single',
            modelIds: ['model1'],
            representativeText: 'Unique insight',
            claims: [
              { id: 'c5', modelId: 'model1', text: 'Unique' },
            ],
          },
        ],
      },
    };
    
    const result1 = deriveTrustSummaryItems(synthesized, null);
    const result2 = deriveTrustSummaryItems(synthesized, null);
    
    // Same input should produce same output
    expect(result1.strongConsensusItems.length).toBe(result2.strongConsensusItems.length);
    expect(result1.contestedItems.length).toBe(result2.contestedItems.length);
    expect(result1.uncertainCount).toBe(result2.uncertainCount);
    
    // Verify correct counts
    expect(result1.strongConsensusItems.length).toBe(1);
    expect(result1.contestedItems.length).toBe(1);
    expect(result1.uncertainCount).toBe(1);
  });
});
