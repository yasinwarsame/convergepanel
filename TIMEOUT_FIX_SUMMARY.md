# Per-Model Timeout Configuration - Implementation Summary

## Problem
Grok was frequently timing out after 30 seconds, causing the entire panel to fail. Other models (ChatGPT, Claude, Perplexity) completed successfully, but Grok's slower response time was breaking the panel experience.

## Solution
Implemented centralized per-model timeout configuration with:
- **Grok**: Increased timeout from 30s to 60s (slower model, needs more time)
- **ChatGPT**: 60s (already configured, now centralized)
- **Claude**: 30s (fast model)
- **Perplexity**: 60s (web search adds latency)

## Changes Made

### 1. Centralized Timeout Config (`lib/modelConfig.ts`)

Added `MODEL_TIMEOUTS` configuration:
```typescript
export const MODEL_TIMEOUTS: Record<ModelId, ModelTimeoutConfig> = {
  chatgpt: { hardTimeoutMs: 60_000 },  // 60 seconds
  claude: { hardTimeoutMs: 30_000 },   // 30 seconds
  grok: { hardTimeoutMs: 60_000 },      // 60 seconds (increased from 30s)
  perplexity: { hardTimeoutMs: 60_000 }, // 60 seconds
};
```

Added helper function:
```typescript
export function getModelTimeout(modelId: ModelId): ModelTimeoutConfig
```

### 2. Updated All Connectors

**Grok (`lib/connectors/grok.ts`):**
- ✅ Removed hardcoded `TIMEOUT_MS = 30_000`
- ✅ Uses `getModelTimeout("grok")` to get 60s timeout
- ✅ Enhanced error handling to detect timeout and set status to "timeout"
- ✅ Added logging for timeout cases

**Claude (`lib/connectors/claude.ts`):**
- ✅ Removed hardcoded `TIMEOUT_MS = 30_000`
- ✅ Uses `getModelTimeout("claude")` to get 30s timeout
- ✅ Updated `createTimeout()` to accept timeout parameter
- ✅ Enhanced timeout error message with actual timeout duration

**ChatGPT (`lib/connectors/chatgpt.ts`):**
- ✅ Removed hardcoded `CHATGPT_TIMEOUT_MS = 60_000`
- ✅ Uses `getModelTimeout("chatgpt")` to get 60s timeout
- ✅ Updated `createTimeout()` to accept timeout parameter
- ✅ Enhanced timeout error message with actual timeout duration

**Perplexity (`lib/connectors/perplexity.ts`):**
- ✅ Removed hardcoded `REQUEST_TIMEOUT_MS = 60_000`
- ✅ Uses `getModelTimeout("perplexity")` to get 60s timeout
- ✅ Enhanced timeout detection to check both `AbortError` and `controller.signal.aborted`
- ✅ Enhanced timeout error message with actual timeout duration

### 3. Updated UI (`components/ResultsDisplay.tsx`)

**Compare View:**
- ✅ Timeout message now uses `result.errorMessage` (which includes model name and timeout duration)
- ✅ Falls back to dynamic message using `getModelDisplayNameSafe(result.modelId)`
- ✅ Removed hardcoded "ChatGPT" and "60 seconds" text

**List View:**
- ✅ Same updates as Compare View
- ✅ Timeout message is now model-specific

## Timeout Behavior

### Before
- All models used 30s timeout (except ChatGPT which used 60s)
- Grok frequently timed out
- Timeout errors broke the panel experience
- UI showed hardcoded "ChatGPT" timeout messages

### After
- **Grok**: 60s timeout (doubled from 30s)
- **ChatGPT**: 60s timeout (unchanged, now centralized)
- **Claude**: 30s timeout (unchanged, now centralized)
- **Perplexity**: 60s timeout (unchanged, now centralized)
- Timeout errors are handled gracefully - other models still show results
- UI shows model-specific timeout messages with actual timeout duration

## Error Messages

Each connector now returns clear timeout messages:
- **Grok**: "Grok request timed out after 60 seconds."
- **ChatGPT**: "ChatGPT request timed out after 60 seconds. This request took longer than 60 seconds and was cancelled to keep the panel responsive."
- **Claude**: "Claude request timed out after 30 seconds."
- **Perplexity**: "Perplexity request timed out after 60 seconds."

## Logging

Added development-only logging for timeout cases:
```typescript
console.warn("[Model connector] Request timed out", {
  hardTimeoutMs: modelTimeout.hardTimeoutMs,
  latencyMs,
});
```

This helps debug timeout issues without spamming logs on success.

## Testing

### Manual Test Checklist

1. **Test Grok with 60s timeout:**
   - [ ] Run panel with Grok on a heavy question
   - [ ] Verify Grok completes within 60s (should succeed more often)
   - [ ] If timeout occurs, verify message shows "Grok request timed out after 60 seconds"

2. **Test timeout handling:**
   - [ ] Temporarily set Grok timeout to 1s to force timeout
   - [ ] Run panel with all 4 models
   - [ ] Verify:
     - [ ] Panel completes (doesn't crash)
     - [ ] Grok shows timeout message
     - [ ] Other models (ChatGPT, Claude, Perplexity) show normally
     - [ ] UI displays model-specific timeout message

3. **Test other models:**
   - [ ] Verify ChatGPT still works with 60s timeout
   - [ ] Verify Claude still works with 30s timeout
   - [ ] Verify Perplexity still works with 60s timeout

## Files Changed

1. **`lib/modelConfig.ts`**
   - Added `ModelTimeoutConfig` interface
   - Added `MODEL_TIMEOUTS` configuration
   - Added `getModelTimeout()` helper function

2. **`lib/connectors/grok.ts`**
   - Removed hardcoded timeout
   - Uses centralized timeout config (60s)
   - Enhanced timeout detection and error handling

3. **`lib/connectors/claude.ts`**
   - Removed hardcoded timeout
   - Uses centralized timeout config (30s)
   - Enhanced timeout error messages

4. **`lib/connectors/chatgpt.ts`**
   - Removed hardcoded timeout
   - Uses centralized timeout config (60s)
   - Enhanced timeout error messages

5. **`lib/connectors/perplexity.ts`**
   - Removed hardcoded timeout
   - Uses centralized timeout config (60s)
   - Enhanced timeout detection

6. **`components/ResultsDisplay.tsx`**
   - Updated timeout messages to be model-specific
   - Uses `result.errorMessage` which includes model name and timeout duration

## Benefits

1. **Grok gets more time**: 60s instead of 30s reduces timeout failures
2. **Centralized configuration**: All timeouts in one place, easy to adjust
3. **Graceful degradation**: One model timing out doesn't break the panel
4. **Better UX**: Model-specific timeout messages help users understand what happened
5. **Easier debugging**: Centralized logging for timeout cases

## Future Improvements

- Consider making timeouts configurable via environment variables
- Add retry logic for timeout cases (optional)
- Monitor timeout rates per model to optimize timeouts further

