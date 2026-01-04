# Bug Fix Summary: Grok Token Mismatch & Firestore Write Failure

## Issues Fixed

### 1. Firestore Write Failure: `ReferenceError: totalTokensRaw is not defined`
**Location**: `/lib/firestore/runs.ts` line ~157

**Root Cause**: The code referenced `totalTokensRaw` variable which was never defined after migrating to `normalizeTokens()` function.

**Fix**: Removed the undefined `totalTokensRaw` reference from the debug log and updated to use `tokenUsageNormalized` object instead.

**Changed**:
```typescript
// Before (broken):
rawValue: totalTokensRaw, // ❌ undefined variable

// After (fixed):
tokenUsageNormalized: tokenUsageNormalized, // ✅ uses normalized tokens
```

---

### 2. Grok Token Mismatch: Reasoning Tokens Not Included in Total
**Location**: `/lib/panel/normalizeTokens.ts`

**Root Cause**: Grok reports `reasoning_tokens` separately in `completion_tokens_details.reasoning_tokens`, but the total tokens calculation was not properly including reasoning tokens. The previous logic incorrectly tried to subtract reasoning from completion tokens, when they should be added together.

**Observed Log**:
```
[normalizeTokens] Token mismatch for grok: provider reports 3761, computed 3320 (diff: 441)
```
The diff (441) equals the reasoning_tokens, confirming reasoning was not being added to total.

**Fix**: 
1. Removed logic that subtracted reasoning from completion tokens
2. Changed total calculation to: `totalTokens = promptTokens + completionTokens + reasoningTokens`
3. Updated tolerance check to 2 tokens (as per requirements) instead of 1%
4. Always use computed total when there's a mismatch (prefer computed over provider-reported)

**Changed**:
```typescript
// Before (broken):
// For Grok, completion_tokens includes reasoning, so subtract to get true completion
if (completionTokens >= grokReasoning) {
  completionTokens = completionTokens - grokReasoning;
}
// This incorrectly subtracted reasoning, making total too low

// After (fixed):
// Reasoning is a separate field, don't modify completion
// total = prompt + completion + reasoning (all three added together)
if (rawResponse.usage.completion_tokens_details?.reasoning_tokens !== undefined) {
  reasoningTokens = safeNum(rawResponse.usage.completion_tokens_details.reasoning_tokens);
}
// totalTokens computed as: promptTokens + completionTokens + (reasoningTokens || 0)
```

**Result**: Grok tokens now correctly computed as `prompt 1442 + completion 1878 + reasoning 441 = 3761` ✅

---

## Additional Improvements

### Schema Updates
- Added Zod validation schemas (`PanelResultPublicSchema`, `TokenUsageNormalizedSchema`)
- Changed field name from `tokenUsageNormalized` to `tokenUsage` in public API responses
- Added `error` object format (instead of just `errorMessage`)

### Token Normalization
- Updated `normalizeTokens()` signature: `(modelId, rawResponse, fallback?)`
- Properly handles reasoning tokens for Grok (separate field, added to total)
- All providers now normalize to consistent schema with reasoning support

### Text Sanitization
- Updated constants: `MAX_CHARS_STORAGE_PER_MODEL = 12000`, `MAX_CHARS_SYNTHESIS_PER_MODEL = 8000`
- Functions now return `{ text, wasTruncated }` objects
- Added `MAX_CHARS_SYNTHESIS_TOTAL = 30000` limit

### Firestore Storage
- Computes totals from normalized tokens (fixes undefined variable issue)
- Uses new `RunDocument` schema with `totals` object
- Aggressive truncation if document exceeds 850KB
- Stores minimal payload (no rawResponse, no citations)

### API Endpoints
- `/api/run-panel`: Returns only `PanelResultPublic[]` (no rawResponse)
- `/api/synthesize-panel`: Validates with Zod, truncates per model and total
- Debug flags: `PANEL_DEBUG_RAW=true` or header `x-debug-raw=1`

---

## What Is Now Stored/Returned

### HTTP Response (run-panel)
```typescript
{
  ok: true,
  results: PanelResultPublic[] // {
    modelId: string,
    status: "ok" | "error",
    rawText: string, // Canonical text only - sanitized
    latencyMs: number,
    tokenUsage: { // Normalized tokens
      promptTokens: number,
      completionTokens: number,
      reasoningTokens?: number, // For Grok, OpenAI o1/o3
      totalTokens: number, // = prompt + completion + reasoning
    },
    error?: { message: string, code?: string }
  }[]
}
// ❌ NO rawResponse field
```

### Firestore Document (RunDocument)
```typescript
{
  runId: string,
  userId: string,
  question: string,
  selectedModels: string[],
  perModel: [{
    modelId: string,
    status: ModelStatus,
    rawTextTruncated: string, // Truncated for storage
    latencyMs: number,
    tokenUsage: TokenUsageNormalized,
    wasTruncated: boolean
  }],
  totals: {
    promptTokens: number,
    completionTokens: number,
    reasoningTokens: number,
    totalTokens: number // Computed from per-model normalized tokens
  },
  flags: {
    storageTruncated: boolean,
    synthesisTruncated: boolean
  }
  // ❌ NO rawResponse, NO citations, NO search_results
}
```

---

## Files Changed

1. `/lib/firestore/runs.ts` - Fixed `totalTokensRaw` reference, compute totals from normalized tokens
2. `/lib/panel/normalizeTokens.ts` - Fixed Grok reasoning token calculation
3. `/lib/panel/schemas.ts` - Added Zod schemas, updated interfaces
4. `/lib/panel/sanitizeText.ts` - Updated constants, return objects with `wasTruncated`
5. `/app/api/run-panel/route.ts` - Use new normalizeTokens signature, strip rawResponse
6. `/app/api/synthesize-panel/route.ts` - Zod validation, truncation limits

---

## Testing Recommendations

1. **Grok Token Test**: Run panel with Grok and verify logs show:
   - `prompt + completion + reasoning = total` (no mismatch warnings)
   - Total matches provider-reported total

2. **Firestore Test**: Run panel and verify:
   - No `totalTokensRaw is not defined` errors
   - Document size under 850KB
   - `totals` object computed correctly from per-model tokens

3. **Truncation Test**: Use very long model responses and verify:
   - Synthesis truncates to 30K total
   - Storage truncates per model to 12K
   - `wasTruncated` flags set correctly

4. **Validation Test**: Send invalid payloads to synthesize-panel and verify:
   - Zod validation rejects bad data
   - Clear error messages returned

