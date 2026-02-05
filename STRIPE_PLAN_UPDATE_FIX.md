# Stripe → Firestore Plan Update Fix - Complete Implementation

## Problem
When users upgraded to paid Stripe subscriptions (2-model or 4-model plans), Firestore was not being updated:
- User's `plan` field stayed "free"
- `monthlyLimit` never changed (still 8)
- `runsThisMonth` continued to be tracked as if on free plan
- UI badge showed "Free Plan: 8 / 8 runs used" even after purchasing Full Panel

## Solution
Implemented a complete Stripe → Webhook → Firestore sync pipeline with:
1. **Single source of truth** for plan configuration
2. **Robust user identification** in webhook (4 fallback methods)
3. **Direct Firestore storage** of plan limits (not just derived from plan)
4. **UI badge** uses plan config for labels

## Changes Made

### 1. New Plan Configuration (`lib/billing/planConfig.ts`)

Created a new single source of truth for plan configuration:

```typescript
export const PLAN_CONFIG: Record<BillingPlanId, PlanConfig> = {
  free: { id: "free", label: "Free Plan", maxModels: 2, monthlyLimit: 8 },
  lite: { id: "lite", label: "Research Lite", maxModels: 2, monthlyLimit: 100 },
  full: { id: "full", label: "Full Panel", maxModels: 4, monthlyLimit: 400 },
};

export const STRIPE_PRICE_TO_PLAN: Record<string, BillingPlanId> = {
  [STRIPE_PRICE_2_MODELS]: "lite",
  [STRIPE_2_MODEL_ANNUAL]: "lite",
  [STRIPE_PRICE_4_MODELS]: "full",
  [STRIPE_4_MODEL_ANNUAL]: "full",
};
```

**Key Functions:**
- `getPlanConfigById(planId)`: Get plan config by ID
- `getPlanIdFromPriceId(priceId)`: Map Stripe price ID to plan ID

### 2. Enhanced Webhook Handler (`app/api/stripe/webhook/route.ts`)

**Improved User Identification (4 fallback methods):**
1. Subscription metadata (`firebaseUid` or `firebase_uid`)
2. Customer metadata (fallback)
3. **NEW:** Query Firestore by `stripeCustomerId` (reliable fallback)
4. Email lookup (last resort)

**Enhanced Plan Mapping:**
- Uses `getPlanIdFromPriceId()` from new `planConfig.ts`
- Logs detailed information for debugging
- Handles both monthly and annual pricing

**Direct Firestore Storage:**
- Stores `plan`, `planLabel`, `maxModels`, `monthlyLimit`, `maxModelsPerRun` directly
- Stores `subscriptionStatus`, `billingInterval`, `planUpdatedAt`
- Resets usage counters when plan changes

**Events Handled:**
- ✅ `checkout.session.completed`
- ✅ `customer.subscription.created`
- ✅ `customer.subscription.updated`
- ✅ `customer.subscription.deleted`
- ✅ `invoice.payment_succeeded`
- ✅ `invoice.payment_failed` (logged only)

### 3. Checkout Session (`app/api/billing/create-checkout-session/route.ts`)

**Already correct:**
- Creates/retrieves Stripe customer
- Sets `firebaseUid` in customer metadata
- Sets `firebaseUid` in session metadata
- Sets `firebaseUid` in subscription metadata
- Stores `stripeCustomerId` in Firestore

### 4. Run Panel API (`app/api/run-panel/route.ts`)

**Already correct:**
- Uses `checkAndIncrementUsageForRun()` which:
  - Reads `plan`, `monthlyLimit`, `maxModelsPerRun` from Firestore
  - Enforces limits based on stored values
  - Atomically increments `runsThisMonth`
  - Handles monthly resets

### 5. Usage API (`app/api/user/usage/route.ts`)

**Already correct:**
- Reads `plan`, `monthlyLimit`, `maxModelsPerRun` from Firestore
- Falls back to plan config if fields not stored
- Returns usage data for UI

### 6. UI Badge (`app/page.tsx`)

**Updated to use PLAN_CONFIG:**
- Uses `getPlanConfigById()` to get plan label
- Handles legacy plan IDs ("solo" → "lite", "pro" → "full")
- Displays correct plan name and limits
- Fixed spacing in badge text

### 7. Type Definitions (`lib/types.ts`)

**Updated RunPanelApiResponse:**
- Added `usage` field with `runsThisMonth`, `maxRunsPerMonth`, `maxModelsPerRun`
- Added `maxModelsPerRun` and `maxRunsPerMonth` to error responses

## Firestore Schema

**User Document Fields (after webhook update):**
```typescript
{
  plan: "free" | "lite" | "full",
  planLabel: "Free Plan" | "Research Lite" | "Full Panel",  // NEW
  maxModels: 2 | 4,                                          // NEW
  monthlyLimit: 8 | 100 | 400,                              // Stored directly
  maxModelsPerRun: 2 | 4,                                   // Stored directly
  runsThisMonth: number,
  usageMonth: string,                                       // YYYY-MM format
  stripeCustomerId?: string,
  stripeSubscriptionId?: string,
  subscriptionStatus?: "active" | "canceled" | "trialing",  // NEW
  billingInterval?: "month" | "year",
  billingCycleStart?: string,                               // ISO timestamp
  planUpdatedAt?: Timestamp,                                // NEW
  email: string,
  // ... other user fields
}
```

## Testing Checklist

### ✅ Test 1: Free Plan User
- [ ] No Stripe subscription
- [ ] Firestore: `plan: "free"`, `monthlyLimit: 8`, `maxModels: 2`
- [ ] UI: "Free Plan: X / 8 runs used"
- [ ] Blocked at 8 runs
- [ ] Limited to 2 models per run

### ✅ Test 2: 2-Model Paid Plan (Research Lite)
- [ ] Purchase via Checkout using `STRIPE_PRICE_2_MODELS`
- [ ] Webhook fires and updates Firestore
- [ ] Firestore: `plan: "lite"`, `planLabel: "Research Lite"`, `maxModels: 2`, `monthlyLimit: 100`
- [ ] UI: "Research Lite: X / 100 runs used"
- [ ] Can run more than 8 runs
- [ ] Still limited to 2 models per run

### ✅ Test 3: 4-Model Paid Plan (Full Panel)
- [ ] Purchase via Checkout using `STRIPE_PRICE_4_MODELS`
- [ ] Webhook fires and updates Firestore
- [ ] Firestore: `plan: "full"`, `planLabel: "Full Panel"`, `maxModels: 4`, `monthlyLimit: 400`
- [ ] UI: "Full Panel: X / 400 runs used"
- [ ] Can select all 4 models
- [ ] Usage increments after each run

### ✅ Test 4: Cancellation
- [ ] Cancel subscription via Stripe Billing Portal
- [ ] Webhook fires `customer.subscription.deleted`
- [ ] Firestore: `plan: "free"`, `planLabel: "Free Plan"`, `maxModels: 2`, `monthlyLimit: 8`
- [ ] UI: "Free Plan: X / 8 runs used"
- [ ] Limited to 2 models per run

## Debugging

### Check Webhook Logs
```bash
# Look for webhook processing logs
grep "[webhook]" your-log-file.log
```

### Verify Environment Variables
```bash
echo $STRIPE_PRICE_2_MODELS
echo $STRIPE_PRICE_4_MODELS
echo $STRIPE_2_MODEL_ANNUAL
echo $STRIPE_4_MODEL_ANNUAL
```

### Check Firestore
- Verify user document has:
  - `plan`: "lite" or "full" (not "free")
  - `planLabel`: "Research Lite" or "Full Panel"
  - `maxModels`: 2 or 4
  - `monthlyLimit`: 100 or 400 (not 8)
  - `maxModelsPerRun`: 2 or 4
  - `stripeCustomerId`: present
  - `stripeSubscriptionId`: present
  - `subscriptionStatus`: "active"
  - `planUpdatedAt`: recent timestamp

### Check Stripe Dashboard
- Verify subscription exists and is active
- Check subscription metadata has `firebaseUid`
- Verify price ID matches one of the configured prices

## Files Changed

1. **`lib/billing/planConfig.ts`** (NEW)
   - Single source of truth for plan configuration
   - `PLAN_CONFIG` with labels and limits
   - `STRIPE_PRICE_TO_PLAN` mapping

2. **`app/api/stripe/webhook/route.ts`**
   - Added Firestore query by `stripeCustomerId` as fallback
   - Uses new `getPlanIdFromPriceId()` for plan mapping
   - Stores `planLabel`, `maxModels`, `subscriptionStatus`, `planUpdatedAt`
   - Enhanced logging

3. **`app/page.tsx`**
   - Uses `PLAN_CONFIG` for plan labels
   - Handles legacy plan IDs
   - Fixed badge spacing

4. **`lib/types.ts`**
   - Updated `RunPanelApiResponse` to include `usage` field

## Key Improvements

1. **Single Source of Truth**: All plan configuration in `lib/billing/planConfig.ts`
2. **Robust User Lookup**: 4 fallback methods to find Firebase UID
3. **Direct Storage**: Plan limits stored directly in Firestore for fast lookups
4. **Better Logging**: Detailed logs for debugging webhook issues
5. **Type Safety**: Updated TypeScript types to match actual API responses

## Next Steps for User `yasinwarsame@hotmail.com`

**Option 1: Wait for Next Webhook Event**
- Any subscription update will trigger webhook
- Webhook will update Firestore automatically

**Option 2: Manually Trigger Webhook**
- Use Stripe Dashboard to send test webhook
- Or use Stripe CLI: `stripe trigger customer.subscription.updated`

**Option 3: Manual Firestore Update (Temporary)**
```javascript
// In Firestore console or via script
const planConfig = getPlanConfigById("full");
await adminDb.collection("users").doc(uid).update({
  plan: "full",
  planLabel: planConfig.label,
  maxModels: planConfig.maxModels,
  monthlyLimit: planConfig.monthlyLimit,
  maxModelsPerRun: planConfig.maxModels,
});
```

## Verification

After fixes, verify:
1. ✅ Checkout session sets correct metadata
2. ✅ Webhook finds Firebase UID reliably (4 fallback methods)
3. ✅ Firestore updates with correct plan, limits, and labels
4. ✅ Usage endpoint returns correct values
5. ✅ UI badge shows correct plan and limits
6. ✅ Run-panel enforces correct limits

