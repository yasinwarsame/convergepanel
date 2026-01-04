# Consensus Detection Fix - Summary

## Problem
After updating the deep-research prompt, the unified answer/trust summary no longer clearly identified consensus points across models. Consensus was often missing or very weak.

## Root Cause
The unified answer generation in `lib/consensus.ts` was generating basic HTML from clusters without explicitly highlighting:
- Where models agree (consensus)
- Where models disagree (contested areas)
- What is uncertain (single-model claims)

Additionally, the `labelCluster` function never returned "disagreement" - it only returned "consensus" or "single", so actual disagreements weren't being detected.

## Solution

### 1. Enhanced Unified Answer Generation (`lib/consensus.ts`)

**Before:** Basic trust summary with simple counts, minimal detail on consensus/disagreement.

**After:** Explicit, structured trust summary with three clear sections:

```html
<h3>Where the models agree</h3>
- Lists consensus claims with model names
- Shows count of agreeing models
- Clear labeling: "Consensus: X models agree — Model1, Model2"

<h3>Where the models disagree</h3>
- Lists contested claims with conflicting model names
- Shows which models have different perspectives
- Clear labeling: "Different perspectives from: Model1, Model2"

<h3>What is uncertain or weakly supported</h3>
- Lists single-model claims
- Notes which model mentioned it
- Clear labeling: "Mentioned only by ModelName"
```

**Key Improvements:**
- Trust Summary now has explicit headings for each category
- Each consensus claim shows which models agree
- Each disagreement shows which models conflict
- Uncertain claims are clearly marked as single-model insights
- More detailed "Overall Synthesis" section with expanded consensus/disagreement details

### 2. Added Disagreement Detection (`lib/agreementMap.ts`)

**Before:** `labelCluster` only returned "consensus" (2+ models) or "single" (1 model). Never returned "disagreement".

**After:** Added `isDisagreement()` function that detects:
- Opposing keywords (effective/ineffective, good/bad, support/oppose, etc.)
- Conflicting numeric values (e.g., "50%" vs "80%")
- Semantic opposition

**Enhanced `labelCluster()` function:**
- Checks if claims within a cluster disagree with each other
- Checks if a cluster disagrees with other consensus clusters
- Returns "disagreement" when conflicts are detected
- Still returns "consensus" when 2+ models agree
- Still returns "single" for unique single-model insights

### 3. Verified All Model Responses Are Included

**Confirmed:**
- `synthesizeReport()` filters to `status === "ok"` responses
- `buildAgreementMap()` includes all successful models dynamically
- No hard-coding of model IDs - all models (ChatGPT, Claude, Grok, Perplexity) are included
- Claims are extracted from all model responses
- Clustering includes all models

## Output Schema (Unchanged)

The TypeScript types and JSON structure remain unchanged:
- `SynthesizedReport` interface unchanged
- `ConsensusAnalysis` interface unchanged
- `unifiedAnswer` is still HTML string
- `agreementClusters` structure unchanged
- UI components continue to work without modification

## Testing

### Test Case: "What are the main pros and cons of universal basic income?"

**Expected Results:**
1. **Trust Summary** should clearly show:
   - "Where the models agree" section with consensus claims
   - "Where the models disagree" section with contested claims
   - "What is uncertain" section with single-model claims

2. **Agreement Map** should contain:
   - Clusters labeled "consensus" with multiple models
   - Clusters labeled "disagreement" when models conflict
   - Clusters labeled "single" for unique insights

3. **Unified Answer** should:
   - Explicitly list consensus claims with model names
   - Explicitly list disagreements with conflicting models
   - Clearly separate consensus from disagreement

## Files Changed

1. **`lib/consensus.ts`**
   - Enhanced `synthesizeReport()` unified answer generation
   - Added explicit "Where the models agree", "Where the models disagree", "What is uncertain" sections
   - Improved consensus/disagreement detail in "Overall Synthesis"

2. **`lib/agreementMap.ts`**
   - Added `isDisagreement()` function for conflict detection
   - Enhanced `labelCluster()` to detect and return "disagreement"
   - Updated cluster labeling to pass all clusters for cross-cluster disagreement detection

## Key Improvements

1. **Explicit Consensus Identification**: Trust Summary now clearly separates consensus, disagreement, and uncertainty
2. **Model Attribution**: Each claim shows which models agree/disagree
3. **Disagreement Detection**: Actually detects when models conflict, not just when they differ
4. **Better Structure**: Clear headings and organization make consensus easy to find
5. **Backward Compatible**: No breaking changes to types or UI components

## Next Steps

1. Test with a question that should produce both agreement and disagreement
2. Verify UI renders the enhanced trust summary correctly
3. Monitor consensus detection quality and adjust thresholds if needed
4. Consider adding more sophisticated disagreement detection (embeddings-based) in future

