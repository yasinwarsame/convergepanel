# Stripe Webhook → Firestore Plan Update Fix

## Problem Summary

User `yasinwarsame@hotmail.com` successfully purchased the 4-model plan, but:
- Their Firestore user record was not updated to reflect the new plan
- The app still treated them as being on the Free plan (8 runs/month, 2 models)
- Usage counters did not track correctly

## Root Causes Identified

1. **Fragile Price ID Mapping**: The webhook handler used hardcoded inline comparisons with environment variables, which could fail if env vars were undefined or mismatched.

2. **Missing Firebase UID Lookup**: The webhook only checked `subscription.metadata.firebase_uid`, but didn't fall back to `customer.metadata.firebase_uid` or `session.metadata.firebase_uid`.

3. **No Centralized Plan Mapping**: Price ID → plan mapping was duplicated and error-prone.

4. **Insufficient Error Logging**: When plan mapping failed, errors weren't logged clearly enough for debugging.

## Fixes Implemented

### 1. Created Robust Plan Mapping Helper (`lib/billing/planMapping.ts`)

- Centralized function `getPlanFromPriceId()` that maps Stripe price IDs to internal plans
- Handles both monthly and annual pricing for 2-model and 4-model plans
- Returns plan configuration with `monthlyLimit` and `maxModelsPerRun`
- Fails fast with clear warnings if environment variables are missing

### 2. Enhanced Webhook Handler (`app/api/stripe/webhook/route.ts`)

**Improved Firebase UID Lookup:**
- Checks `subscription.metadata.firebase_uid` first
- Falls back to `customer.metadata.firebase_uid` if not found
- For `checkout.session.completed`, also checks `session.metadata.firebase_uid`
- Updates subscription metadata if missing (ensures future webhooks work)

**Robust Plan Mapping:**
- Uses `getPlanFromPriceId()` helper instead of inline comparisons
- Handles both monthly and annual billing intervals
- Logs detailed information for debugging

**Better Firestore Updates:**
- Updates plan, subscription IDs, billing interval, and billing cycle start
- Calls `resetUsageForNewPlan()` to reset usage counters
- Handles subscription status (active, trialing, canceled, etc.)

**Enhanced Error Handling:**
- Comprehensive logging at each step
- Clear error messages when Firebase UID or price ID cannot be found
- Idempotent operations (safe to retry)

### 3. Verified Existing Endpoints

**`/api/user/usage`:**
- ✅ Already reads from Firestore correctly
- ✅ Returns plan, runsThisMonth, and monthlyLimit
- ✅ Applies month-reset logic correctly

**`/api/run-panel`:**
- ✅ Already uses `checkAndIncrementUsageForRun()` which reads from Firestore
- ✅ Enforces model limits and run limits based on plan
- ✅ Atomically increments usage after successful runs

## How It Works Now

### Subscription Flow

1. **User Purchases Plan:**
   - Checkout session created with `firebase_uid` in metadata (both session and subscription_data)
   - User completes payment

2. **Webhook Receives Event:**
   - `checkout.session.completed` or `customer.subscription.created` fires
   - Webhook extracts price ID from subscription
   - Maps price ID to plan using `getPlanFromPriceId()`
   - Finds Firebase UID from metadata (checks multiple sources)

3. **Firestore Updated:**
   - Plan set to "lite" or "full"
   - Subscription IDs stored
   - Billing interval stored
   - Usage counters reset to 0

4. **Usage Tracking:**
   - `/api/user/usage` reads plan from Firestore
   - `/api/run-panel` enforces limits based on plan
   - Usage increments atomically after each run

### Plan Mapping

| Stripe Price ID Env Var | Plan | Monthly Limit | Max Models |
|------------------------|------|---------------|------------|
| `STRIPE_PRICE_2_MODELS` | lite | 100 | 2 |
| `STRIPE_2_MODEL_ANNUAL` | lite | 100 | 2 |
| `STRIPE_PRICE_4_MODELS` | full | 400 | 4 |
| `STRIPE_4_MODEL_ANNUAL` | full | 400 | 4 |

### Cancellation Flow

1. User cancels via Stripe Billing Portal
2. `customer.subscription.deleted` webhook fires
3. Webhook finds Firebase UID from metadata
4. Firestore updated:
   - Plan set to "free"
   - Subscription ID cleared
   - Usage counters reset

## Testing Checklist

### Test 1: Free Plan User
- [ ] No Stripe subscription
- [ ] Firestore shows `plan: "free"`
- [ ] Badge shows "Free Plan: X / 8 runs used"
- [ ] Blocked at 8 runs
- [ ] Limited to 2 models per run

### Test 2: 2-Model Paid Plan (Research Lite)
- [ ] Purchase via Checkout using `STRIPE_PRICE_2_MODELS`
- [ ] Webhook fires and updates Firestore
- [ ] Firestore shows `plan: "lite"`
- [ ] Badge shows "Research Lite: X / 100 runs used"
- [ ] Can run more than 8 runs
- [ ] Still limited to 2 models per run

### Test 3: 4-Model Paid Plan (Full Panel)
- [ ] Purchase via Checkout using `STRIPE_PRICE_4_MODELS`
- [ ] Webhook fires and updates Firestore
- [ ] Firestore shows `plan: "full"`
- [ ] Badge shows "Full Panel: X / 400 runs used"
- [ ] Can select all 4 models
- [ ] Usage increments after each run

### Test 4: Cancellation
- [ ] Cancel subscription via Stripe Billing Portal
- [ ] Webhook fires `customer.subscription.deleted`
- [ ] Firestore shows `plan: "free"`
- [ ] Badge shows "Free Plan: X / 8 runs used"
- [ ] Limited to 2 models per run

## Debugging

If a user's plan is not updating:

1. **Check Webhook Logs:**
   ```bash
   # Look for webhook events in your server logs
   grep "[webhook]" your-log-file.log
   ```

2. **Verify Environment Variables:**
   ```bash
   # Ensure all Stripe price IDs are set
   echo $STRIPE_PRICE_2_MODELS
   echo $STRIPE_PRICE_4_MODELS
   echo $STRIPE_2_MODEL_ANNUAL
   echo $STRIPE_4_MODEL_ANNUAL
   ```

3. **Check Firestore:**
   - Verify user document has `stripeCustomerId` and `stripeSubscriptionId`
   - Check `plan` field matches expected value
   - Verify `runsThisMonth` and `usageMonth` are set

4. **Check Stripe Dashboard:**
   - Verify subscription exists and is active
   - Check subscription metadata has `firebase_uid`
   - Verify price ID matches one of the configured prices

5. **Test Webhook Manually:**
   - Use Stripe CLI to forward webhooks locally
   - Trigger test events and watch logs

## Files Changed

1. **`lib/billing/planMapping.ts`** (NEW)
   - Centralized plan mapping helper
   - `getPlanFromPriceId()` function
   - `getFreePlanConfig()` function

2. **`app/api/stripe/webhook/route.ts`** (UPDATED)
   - Enhanced Firebase UID lookup (multiple fallbacks)
   - Uses plan mapping helper
   - Better error logging
   - Handles subscription status correctly
   - Updates subscription metadata if missing

## Environment Variables Required

```bash
# Stripe API Keys
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Stripe Price IDs (from Stripe Dashboard > Products > Prices)
STRIPE_PRICE_2_MODELS=price_xxx  # Research Lite monthly
STRIPE_2_MODEL_ANNUAL=price_xxx   # Research Lite annual
STRIPE_PRICE_4_MODELS=price_xxx  # Full Panel monthly
STRIPE_4_MODEL_ANNUAL=price_xxx   # Full Panel annual
```

## Next Steps

1. **Test with Real User:**
   - For user `yasinwarsame@hotmail.com`, manually trigger a webhook event or wait for next subscription event
   - Alternatively, manually update their Firestore document if needed

2. **Monitor Webhook Logs:**
   - Watch for any errors in webhook processing
   - Verify all subscription events are handled correctly

3. **Set Up Webhook Monitoring:**
   - Consider adding webhook event logging to a database
   - Set up alerts for webhook failures

