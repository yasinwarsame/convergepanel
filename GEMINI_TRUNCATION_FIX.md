# Gemini Output Truncation Fix

## Problem
Gemini (and other long model) outputs were being cut off mid-sentence in the panel display. The root cause was that truncation logic intended for synthesis prompts was being applied to UI display, or the UI was rendering a Firestore-truncated field instead of the immediate run response.

## Root Cause
The UI was using `result.rawText` which could be:
1. Truncated for synthesis (if synthesis truncation was applied before UI rendering)
2. Truncated for Firestore storage (if reading from stored documents)
3. CSS-clamped with `max-h-[600px] overflow-auto` (visual clipping, not text truncation)

The canonical text per model should be `rawTextFull` - the full, untruncated canonical text from the API response.

## Solution Implemented

### 1. Schema Updates
- Added `rawTextFull: string` to `PanelResultPublic` - full canonical text for UI display (never truncated)
- Kept `rawText` for backward compatibility (deprecated)
- Added optional `wasTruncatedForSynthesis` and `wasTruncatedForStorage` flags for reference

### 2. API Endpoint Changes

#### `/app/api/run-panel/route.ts`
- Returns `rawTextFull` with full canonical text (sanitized but never truncated)
- Computes synthesis truncation internally but doesn't mutate the response
- UI always receives full text

#### `/app/api/synthesize-panel/route.ts`
- Accepts `rawTextFull` (or `rawText` for backward compatibility)
- Truncates internally for synthesis prompt only
- Never mutates or overwrites panel results
- Returns only synthesized output

### 3. Firestore Storage
- Increased `MAX_CHARS_STORAGE_PER_MODEL` from 12000 to 20000 (Gemini can easily exceed 8000 chars)
- Stores `rawTextTruncated` for storage safety (prevents 1 MiB limit)
- UI never reads from Firestore for current run - always uses API response

### 4. UI Component Fixes (`components/ResultsDisplay.tsx`)
- Changed to use `rawTextFull` (or `rawText` for backward compatibility)
- Removed `max-h-[600px]` constraint - text scrolls naturally
- Always shows full text - no silent truncation
- If collapse is needed, use explicit "Show more" interaction

### 5. Gemini Connector
- Increased `maxTokens` from 2200 to 4096 in `lib/modelConfig.ts`
- Ensures Gemini can return full responses including "Suggested Follow-Up Questions" section

## Changes Summary

### Files Modified

1. **`/lib/panel/schemas.ts`**
   - Added `rawTextFull` field to `PanelResultPublicSchema`
   - Added truncation flags

2. **`/lib/panel/sanitizeText.ts`**
   - Increased `MAX_CHARS_STORAGE_PER_MODEL` to 20000

3. **`/app/api/run-panel/route.ts`**
   - Returns `rawTextFull` with full canonical text
   - Never truncates for UI display

4. **`/app/api/synthesize-panel/route.ts`**
   - Uses `rawTextFull` as input
   - Truncates only for synthesis prompt (internal)

5. **`/lib/firestore/runs.ts`**
   - Uses `rawTextFull` if available
   - Stores truncated version for Firestore safety
   - Never returns truncated version to UI

6. **`/components/ResultsDisplay.tsx`**
   - Uses `rawTextFull` for display
   - Removed height clamping
   - Always shows full text

7. **`/lib/modelConfig.ts`**
   - Increased Gemini `maxTokens` to 4096

## Verification

After these changes:
1. ✅ UI shows full Gemini output including "Suggested Follow-Up Questions" section
2. ✅ Synthesis still bounded (truncates internally, doesn't affect UI)
3. ✅ Firestore stores bounded text (20K chars per model) with truncation flags
4. ✅ No endpoint returns rawResponse or provider metadata that bloats payloads

## Key Principle

**UI display must use full canonical text from API response. Truncation applies only to:**
- Synthesis prompts (internal, bounded to 8K per model, 30K total)
- Firestore storage (bounded to 20K per model for safety)

The UI never sees truncated text for current runs - it always gets the full response.

