# Plan Limits Fix Summary

**Date:** 2026-01-02  
**Status:** ✅ **COMPLETED**

---

## Problem

The UI header was showing incorrect plan limits:
- Full Plan users saw: "Full panel · 33 / 400 runs used" (should be 150)
- 3-Model Plan users saw: "3-model panel · X / 100 runs used" (should be 80)

Hardcoded values were scattered across the codebase, causing inconsistency.

---

## Solution

Consolidated all plan limits to a **single source of truth** and added defensive checks to prevent drift.

---

## Files Changed

### 1. **`lib/plans.ts`** ✅ (Single Source of Truth)
- **Updated limits:**
  - `lite.maxRunsPerMonth`: 100 → **80**
  - `full.maxRunsPerMonth`: 400 → **150**
- **Added defensive validation** in `getPlanConfig()` to validate plan IDs
- **Added missing functions:**
  - `normalizeMaxModels()` - Normalizes legacy 4→5, ensures only 2/3/5
  - `getStripePriceId()` - Gets Stripe price ID for plan
  - `formatUsageText()` - Formats usage display text
  - `formatPlanNameWithInterval()` - Formats plan name with billing interval
  - `isRunLimitExceeded()` - Checks if limit exceeded
  - `canUseModels()` - Validates model count
  - `getPlanConfigById()` - Alias for backward compatibility
- **Updated comment** to reflect 150 (not 400)

### 2. **`lib/userUsage.ts`** ✅
- **Fixed `getMonthlyLimit()`** to use `getPlanConfig()` from `lib/plans.ts` instead of hardcoded values
- **Updated fallback values** to match new limits (80 for lite, 150 for full)
- **Marked as deprecated** - encourages use of plan config directly

### 3. **`app/api/user/usage/route.ts`** ✅
- **Always uses plan config as source of truth** (not Firestore values)
- **Added defensive checks:**
  - Validates plan ID exists (fallback to free)
  - Logs warning if Firestore has stale `monthlyLimit` (e.g., 400)
  - Optionally updates Firestore with correct value (non-blocking)
  - Ensures `monthlyLimit` is never null/undefined
- **Added logging** to identify stale Firestore values

### 4. **`lib/stripe/usageCheck.ts`** ✅
- **Always uses plan config as source of truth** for enforcement
- **Added defensive checks:**
  - Validates plan ID (fallback to free)
  - Logs warning if Firestore has stale limits
  - **Safety check: Never allows 400 for full plan** (forces to 150)
  - Verifies limits match expected values in dev mode
  - Updates Firestore with correct values if stale (non-blocking)

### 5. **`app/page.tsx`** ✅ (Header Pill)
- **Added defensive validation** for plan config
- **Added safety check** to detect if `monthlyLimit` is 400 for full plan
- **Logs warnings** if API returns stale values
- Header pill displays: `{runsThisMonth} / {monthlyLimit}` where `monthlyLimit` comes from API (which uses plan config)

### 6. **`app/billing/page.tsx`** ✅
- **Fixed hardcoded text:** "400 runs per month" → "150 runs per month"
- Uses `formatUsageText()` which uses plan config

### 7. **`lib/types.ts`** ✅
- **Updated comment** to reflect correct limits (80 for lite, 150 for full)

### 8. **`app/api/stripe/webhook/route.ts`** ✅
- **Updated comment** to reflect correct limits (150 for full plan)

### 9. **`lib/__tests__/planLimits.test.ts`** ✅ (NEW)
- **Added unit tests** to verify:
  - Free plan: 8 runs/month, 2 models
  - Lite plan: 80 runs/month, 3 models
  - Full plan: 150 runs/month, 5 models
  - No hardcoded 400 values in plan limits
  - `normalizeMaxModels()` works correctly

---

## Single Source of Truth

**Location:** `lib/plans.ts`

```typescript
export const PLAN_CONFIGS: Record<PlanId, PlanConfig> = {
  free: { maxRunsPerMonth: 8, maxModelsPerRun: 2 },
  lite: { maxRunsPerMonth: 80, maxModelsPerRun: 3 },
  full: { maxRunsPerMonth: 150, maxModelsPerRun: 5 },
};
```

**All code paths now use:**
- `getPlanConfig(planId).maxRunsPerMonth` - For run limits
- `getPlanConfig(planId).maxModelsPerRun` - For model limits

---

## Header Pill Flow

1. **User loads page** → `app/page.tsx` renders
2. **`useUserPlan()` hook** → Fetches from `/api/user/usage`
3. **`/api/user/usage` route** → Gets plan from Firestore, looks up config from `lib/plans.ts`
4. **Returns `monthlyLimit`** → Always from plan config (not Firestore)
5. **Header pill displays:** `{runsThisMonth} / {monthlyLimit}`

**Result:** Full Plan user sees "Full panel · 33 / 150 runs used" ✅

---

## Defensive Checks Added

### 1. **API Route (`/api/user/usage`)**
- Validates plan ID exists (fallback to free)
- Logs warning if Firestore has stale `monthlyLimit`
- Optionally updates Firestore with correct value
- Never returns null/undefined for `monthlyLimit`

### 2. **Usage Enforcement (`lib/stripe/usageCheck.ts`)**
- Always uses plan config (not Firestore)
- Safety check: Forces 400 → 150 for full plan
- Logs warnings for stale values
- Updates Firestore if stale (non-blocking)

### 3. **UI Component (`app/page.tsx`)**
- Validates plan config before using
- Checks if `monthlyLimit` matches expected value
- Logs error if full plan shows 400 limit

---

## Guardrails

### Test File: `lib/__tests__/planLimits.test.ts`
- ✅ Verifies free plan: 8 runs/month
- ✅ Verifies lite plan: 80 runs/month  
- ✅ Verifies full plan: 150 runs/month
- ✅ Ensures no hardcoded 400 in plan limits

### CI Check (Recommended)
Add to CI pipeline:
```bash
# Fail if "400" appears in plan limit context
grep -r "\"400\"\|'/ 400'" --include="*.ts" --include="*.tsx" lib app | \
  grep -v "status.*400\|HTTP.*400\|Bad Request\|border-sky-400\|text-slate-400" | \
  grep -i "plan\|limit\|monthly" && exit 1 || exit 0
```

---

## Migration Notes

### Existing Users in Firestore
- **Stale `monthlyLimit` values:** The API routes now prioritize plan config over Firestore
- **Automatic correction:** Both `/api/user/usage` and `checkAndIncrementUsageForRun` will:
  1. Use plan config value (correct)
  2. Log warning if Firestore has stale value
  3. Optionally update Firestore with correct value (non-blocking)
- **No manual migration needed:** Users will see correct limits immediately

### Backward Compatibility
- ✅ All changes are backward compatible
- ✅ Legacy plan IDs ("solo" → "lite", "pro" → "full") still work
- ✅ Legacy `maxModelsPerRun: 4` → normalized to 5 automatically

---

## Verification

### Manual Testing Checklist
- [ ] Free Plan user sees: "Free plan · X / 8 runs used"
- [ ] Lite Plan user sees: "Research Lite · X / 80 runs used"
- [ ] Full Plan user sees: "Full panel · X / 150 runs used"
- [ ] Header pill uses correct denominator from plan config
- [ ] Usage enforcement blocks at correct limit (80 for lite, 150 for full)
- [ ] Billing page shows correct limits in upgrade text

### Automated Tests
```bash
npm test -- lib/__tests__/planLimits.test.ts
```

---

## Summary

✅ **Single source of truth:** `lib/plans.ts`  
✅ **All hardcoded 400s removed** (except defensive checks)  
✅ **All code paths use plan config**  
✅ **Defensive checks prevent stale values**  
✅ **Tests added to prevent drift**  
✅ **Build passes**  

**Result:** Header pill and all UI now correctly display:
- Full Plan: **150 runs/month** (not 400)
- 3-Model Plan: **80 runs/month** (not 100)

