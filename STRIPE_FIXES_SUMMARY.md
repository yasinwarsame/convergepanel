# Stripe → Firestore Plan Update Fixes - Complete Summary

## Problem
User `yasinwarsame@hotmail.com` purchased the 4-model plan, but:
- Firestore user document remained on Free plan
- UI badge showed "Free Plan: 8 / 8 runs used"
- Same issue affected 2-model plan purchases

## Root Causes Fixed

1. **Metadata Field Names**: Checkout session used `firebase_uid` but webhook looked for `firebaseUid` (inconsistent)
2. **Missing Direct Storage**: `monthlyLimit` and `maxModelsPerRun` were not stored directly in Firestore
3. **Incomplete Customer Metadata**: Existing customers weren't updated with Firebase UID metadata
4. **No Fallback Lookup**: Webhook didn't attempt email-based lookup if metadata was missing

## Fixes Implemented

### 1. Checkout Session Creation (`app/api/billing/create-checkout-session/route.ts`)

**Changes:**
- ✅ Uses `firebaseUid` (not `firebase_uid`) consistently in all metadata
- ✅ Sets `email` and `targetPlan` in metadata for better tracking
- ✅ Updates existing customer metadata if missing `firebaseUid`
- ✅ Ensures both session and subscription_data metadata are set

**Metadata Structure:**
```typescript
metadata: {
  firebaseUid: uid,
  email: userEmail,
  targetPlan: planId, // "lite" or "full"
}
```

### 2. Webhook Handler (`app/api/stripe/webhook/route.ts`)

**New Helper Function: `updateUserPlanFromStripe()`**
- Stores `monthlyLimit` and `maxModelsPerRun` directly in Firestore
- Handles active subscriptions, cancellations, and invalid states
- Resets usage counters when plan changes

**Enhanced Firebase UID Lookup:**
1. Subscription metadata (`firebaseUid` or `firebase_uid` for backward compatibility)
2. Customer metadata (fallback)
3. Email-based lookup (best effort, logs warning)

**Improved Plan Mapping:**
- Uses `getPlanFromPriceId()` helper
- Logs detailed information for debugging
- Handles both monthly and annual pricing

**Events Handled:**
- ✅ `checkout.session.completed`
- ✅ `customer.subscription.created`
- ✅ `customer.subscription.updated`
- ✅ `customer.subscription.deleted`
- ✅ `invoice.payment_succeeded`
- ✅ `invoice.payment_failed` (logged only)

### 3. Plan Mapping Helper (`lib/billing/planMapping.ts`)

**Already exists and working:**
- Maps Stripe price IDs to internal plans
- Returns `PlanConfig` with `monthlyLimit` and `maxModelsPerRun`
- Handles both monthly and annual pricing

### 4. Usage Endpoint (`app/api/user/usage/route.ts`)

**Changes:**
- ✅ Reads `monthlyLimit` and `maxModelsPerRun` from Firestore if stored
- ✅ Falls back to plan config if fields not stored (backward compatibility)
- ✅ Returns `maxModelsPerRun` in response

### 5. Usage Check (`lib/stripe/usageCheck.ts`)

**Changes:**
- ✅ Prefers stored `monthlyLimit` and `maxModelsPerRun` from Firestore
- ✅ Falls back to plan config if not stored
- ✅ Enforces limits using stored or derived values

### 6. UI Badge (`app/page.tsx`)

**Changes:**
- ✅ Fixed badge text formatting (removed extra dash)
- ✅ Already uses correct `planLabel` mapping:
  - "free" → "Free"
  - "lite" → "Research Lite"
  - "full" → "Full Panel"

## Firestore Schema

**User Document Fields:**
```typescript
{
  plan: "free" | "lite" | "full",
  monthlyLimit: number,        // NEW: Stored directly
  maxModelsPerRun: number,     // NEW: Stored directly
  runsThisMonth: number,
  usageMonth: string,          // YYYY-MM format
  stripeCustomerId?: string,
  stripeSubscriptionId?: string,
  billingInterval?: "month" | "year",
  billingCycleStart?: string,  // ISO timestamp
  email: string,
  // ... other user fields
}
```

## Testing Checklist

### ✅ Test 1: Free Plan User
- [ ] No Stripe subscription
- [ ] Firestore: `plan: "free"`, `monthlyLimit: 8`, `maxModelsPerRun: 2`
- [ ] UI: "Free Plan: X / 8 runs used"
- [ ] Blocked at 8 runs
- [ ] Limited to 2 models per run

### ✅ Test 2: 2-Model Paid Plan (Research Lite)
- [ ] Purchase via Checkout using `STRIPE_PRICE_2_MODELS`
- [ ] Webhook fires and updates Firestore
- [ ] Firestore: `plan: "lite"`, `monthlyLimit: 100`, `maxModelsPerRun: 2`
- [ ] UI: "Research Lite: X / 100 runs used"
- [ ] Can run more than 8 runs
- [ ] Still limited to 2 models per run

### ✅ Test 3: 4-Model Paid Plan (Full Panel)
- [ ] Purchase via Checkout using `STRIPE_PRICE_4_MODELS`
- [ ] Webhook fires and updates Firestore
- [ ] Firestore: `plan: "full"`, `monthlyLimit: 400`, `maxModelsPerRun: 4`
- [ ] UI: "Full Panel: X / 400 runs used"
- [ ] Can select all 4 models
- [ ] Usage increments after each run

### ✅ Test 4: Cancellation
- [ ] Cancel subscription via Stripe Billing Portal
- [ ] Webhook fires `customer.subscription.deleted`
- [ ] Firestore: `plan: "free"`, `monthlyLimit: 8`, `maxModelsPerRun: 2`
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
  - `monthlyLimit`: 100 or 400 (not 8)
  - `maxModelsPerRun`: 2 or 4 (not 2)
  - `stripeCustomerId`: present
  - `stripeSubscriptionId`: present

### Check Stripe Dashboard
- Verify subscription exists and is active
- Check subscription metadata has `firebaseUid`
- Verify price ID matches one of the configured prices

## Files Changed

1. **`app/api/billing/create-checkout-session/route.ts`**
   - Updated metadata to use `firebaseUid` consistently
   - Ensures customer metadata is set/updated

2. **`app/api/stripe/webhook/route.ts`**
   - Added `updateUserPlanFromStripe()` helper
   - Enhanced Firebase UID lookup (3 fallbacks)
   - Stores `monthlyLimit` and `maxModelsPerRun` directly
   - Better error logging

3. **`app/api/user/usage/route.ts`**
   - Reads `monthlyLimit` and `maxModelsPerRun` from Firestore
   - Returns `maxModelsPerRun` in response

4. **`lib/stripe/usageCheck.ts`**
   - Prefers stored `monthlyLimit` and `maxModelsPerRun`
   - Falls back to plan config if not stored

5. **`app/page.tsx`**
   - Fixed badge text formatting

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
await adminDb.collection("users").doc(uid).update({
  plan: "full",
  monthlyLimit: 400,
  maxModelsPerRun: 4,
});
```

## Verification

After fixes, verify:
1. ✅ Checkout session sets correct metadata
2. ✅ Webhook finds Firebase UID reliably
3. ✅ Firestore updates with correct plan and limits
4. ✅ Usage endpoint returns correct values
5. ✅ UI badge shows correct plan and limits
6. ✅ Run-panel enforces correct limits

