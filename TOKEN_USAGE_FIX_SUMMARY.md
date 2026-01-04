# Token Usage Saving Fix - Summary

## Root Cause
`completeRun()` was trying to write token usage fields using undefined variables (`totalTokensRaw`, `tokenUsage`), causing Firestore writes to throw and token usage to not be saved.

## Solution
1. **Made `completeRun()` accept token usage as parameters** - No recomputation, uses exactly what is passed in
2. **Computed token usage in route handler** - Token usage is computed once in `/app/api/run-panel/route.ts` and passed to `completeRun()`
3. **Fixed Grok token normalization** - Properly handles reasoning tokens (separate field, added to total)
4. **Fixed synthesize-panel crash** - Made request body parsing resilient to different key names

## Changes Made

### 1. Type Definitions (`lib/panel/normalizeTokens.ts`)
- Added `ModelTokenUsage` and `RunTokenTotals` types
- Changed `TokenUsageNormalized` from interface to type

### 2. Grok Token Handling (`lib/panel/normalizeTokens.ts`)
- Special handling for Grok: `totalTokens = promptTokens + completionTokens + reasoningTokens`
- Grok reasoning tokens are extracted from `completion_tokens_details.reasoning_tokens`
- Increased tolerance for Grok token mismatch warnings (10 tokens vs 2 for others)

### 3. `completeRun()` Signature (`lib/firestore/runs.ts`)
- Changed to accept `CompleteRunArgs` object with:
  - `runId`, `userId`, `results`, `question`, `selectedModels`
  - `tokenUsageByModel: ModelTokenUsage[]` (pre-computed)
  - `tokenTotals: RunTokenTotals` (pre-computed)
- Removed all token computation logic - uses passed-in data only
- Removed undefined variable references (`totalTokensRaw`, `tokenUsage`)

### 4. Route Handler (`app/api/run-panel/route.ts`)
- Computes `panelResultsPublic` with normalized tokens
- Extracts `tokenUsageByModel` and `tokenTotals` from normalized results
- Passes pre-computed token usage to `completeRun()`
- Uses `tokenTotals.totalTokens` for user token increment

### 5. Synthesize Panel (`app/api/synthesize-panel/route.ts`)
- Made request body parsing resilient to different key names:
  - `body.results ?? body.modelResults ?? body.panelResults ?? body.publicResults ?? body.responses`
- Returns 400 with clear error message if results array is missing

## Firestore Document Structure
After fix, documents store:
```typescript
{
  tokenUsage: {
    byModel: {
      [modelId]: {
        promptTokens: number,
        completionTokens: number,
        totalTokens: number,
        reasoningTokens?: number
      }
    },
    totals: {
      promptTokens: number,
      completionTokens: number,
      totalTokens: number,
      reasoningTokens?: number
    }
  },
  // Legacy fields for backward compatibility
  totalTokens: number,
  tokensByModel: Record<string, number>,
  tokensByProvider?: Record<string, number>
}
```

## Verification
After these changes:
1. ✅ No "Failed to save token usage" errors
2. ✅ Firestore documents have `tokenUsage.byModel` and `tokenUsage.totals`
3. ✅ Grok token mismatch warnings are gone (or only for true inconsistencies)
4. ✅ `/api/synthesize-panel` returns 200 instead of 500
5. ✅ All token usage is computed once and passed in (no undefined variables)

