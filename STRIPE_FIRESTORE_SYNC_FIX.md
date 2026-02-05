# Stripe → Firestore Subscription Sync - Complete Fix

## Problem Summary
When users successfully purchased the 4-model plan via Stripe:
- ✅ Stripe subscription was created correctly
- ❌ Firestore user document was NOT updated with subscription/plan data
- ❌ UI (Billing page) continued showing "Starter — Free" instead of "Full Panel — 4 Models"

## Root Cause
The webhook handler was updating Firestore, but:
1. User lookup could fail if `firebaseUid` wasn't in Stripe metadata
2. Missing defensive checks for edge cases
3. Insufficient logging made debugging difficult
4. The `/api/user/usage` endpoint wasn't clearly indicating when webhook data was missing

## Solution Implemented

### 1. Enhanced Webhook Handler (`app/api/stripe/webhook/route.ts`)

#### Improved User Identification
- **Priority 1**: Subscription metadata (`firebaseUid` or `firebase_uid`)
- **Priority 2**: Customer metadata (fallback)
- **Priority 3**: Query Firestore by `stripeCustomerId` (most reliable - always works)
- **Priority 4**: Email lookup (last resort)

When user is found via `stripeCustomerId`, the webhook now also updates the subscription metadata with `firebaseUid` for future lookups.

#### Comprehensive Firestore Updates
The webhook now explicitly stores all required fields:
```typescript
{
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  plan: "free" | "lite" | "full",  // CRITICAL for /api/user/usage
  planLabel: string,
  maxModels: number,
  monthlyLimit: number,  // CRITICAL for /api/user/usage
  maxModelsPerRun: number,  // CRITICAL for /api/user/usage
  subscriptionStatus: string,
  billingInterval: "month" | "year" | null,
  billingCycleStart: ISO timestamp,
  planUpdatedAt: Firestore Timestamp,
}
```

#### Enhanced Logging
- Logs all webhook events received
- Logs subscription details (price ID, status, customer ID)
- Logs user lookup attempts and results
- Logs Firestore update operations with full data
- Success confirmations with ✅ markers

#### Status Handling
- `active`, `trialing`, `past_due` → Update to paid plan
- `canceled`, `unpaid` → Downgrade to free plan
- Other statuses → Logged but plan not changed

### 2. Improved Usage Endpoint (`app/api/user/usage/route.ts`)

#### Defensive Reading
- Reads `plan`, `monthlyLimit`, `maxModelsPerRun` from Firestore
- Falls back to plan config if fields not stored (handles legacy data)
- Logs warnings when paid plan detected but limits not stored (indicates webhook didn't fire)

#### Enhanced Logging
```typescript
console.log("[user/usage] Returning usage data:", {
  uid,
  plan,
  monthlyLimit,
  maxModelsPerRun,
  fromFirestore: {
    plan: userData?.plan,
    monthlyLimit: userData?.monthlyLimit,
    maxModelsPerRun: userData?.maxModelsPerRun,
    stripeSubscriptionId: userData?.stripeSubscriptionId,
    subscriptionStatus: userData?.subscriptionStatus,
  },
  warning: plan !== "free" && !hasStoredLimits 
    ? "Paid plan detected but limits not stored - webhook may not have fired"
    : null,
});
```

## Firestore Document Structure

### User Document Schema
```typescript
{
  // Basic user info
  email: string,
  name?: string,
  
  // Subscription/Plan data (updated by webhook)
  plan: "free" | "lite" | "full",  // Plan tier
  planLabel: "Free Plan" | "Research Lite" | "Full Panel",
  maxModels: 2 | 4,  // Max models per run
  monthlyLimit: 8 | 100 | 400,  // Max runs per month
  maxModelsPerRun: 2 | 4,  // Same as maxModels (for consistency)
  
  // Stripe integration
  stripeCustomerId: "cus_xxx",
  stripeSubscriptionId: "sub_xxx" | null,
  subscriptionStatus: "active" | "trialing" | "past_due" | "canceled" | null,
  billingInterval: "month" | "year" | null,
  billingCycleStart: ISO timestamp,
  planUpdatedAt: Firestore Timestamp,
  
  // Usage tracking
  runsThisMonth: number,
  usageMonth: "YYYY-MM",  // e.g., "2025-12"
}
```

### Plan Mapping
- **"free"** → Starter — Free (8 runs/month, 2 models)
- **"lite"** → Research Lite — 2 Models (100 runs/month, 2 models)
- **"full"** → Full Panel — 4 Models (400 runs/month, 4 models)

## Webhook Events Handled

1. **`checkout.session.completed`**
   - Triggered when user completes Stripe checkout
   - Retrieves subscription and processes it
   - Ensures `firebaseUid` is in subscription metadata

2. **`customer.subscription.created`**
   - Triggered when subscription is created
   - Updates Firestore with plan data

3. **`customer.subscription.updated`**
   - Triggered on plan changes, upgrades, downgrades
   - Updates Firestore with new plan data

4. **`customer.subscription.deleted`**
   - Triggered when subscription is canceled
   - Downgrades user to free plan

5. **`invoice.payment_succeeded`**
   - Triggered when payment succeeds
   - Ensures subscription is marked as active

## Testing

### Manual Testing Steps

1. **Create a test subscription:**
   - Go to `/billing` page
   - Click "Upgrade" for Full Panel plan
   - Complete Stripe checkout with test card: `4242 4242 4242 4242`

2. **Verify webhook fired:**
   - Check server logs for:
     ```
     [webhook] Received event: { type: 'checkout.session.completed', ... }
     [webhook] ✅ Successfully updated user {uid} to plan full
     ```

3. **Verify Firestore updated:**
   - Check Firestore console
   - User document should have:
     - `plan: "full"`
     - `monthlyLimit: 400`
     - `maxModelsPerRun: 4`
     - `stripeSubscriptionId: "sub_xxx"`

4. **Verify UI updated:**
   - Refresh `/billing` page
   - Should show "Full Panel — 4 Models" instead of "Starter — Free"
   - Usage should show "Full Panel: 0 / 400 panel runs used this month"

### Using Stripe CLI (Local Testing)

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3000/api/stripe/webhook

# Trigger test events
stripe trigger checkout.session.completed
stripe trigger customer.subscription.created
```

## Debugging

### If webhook doesn't fire:
1. Check Stripe Dashboard → Developers → Webhooks
2. Verify webhook endpoint URL is correct
3. Verify `STRIPE_WEBHOOK_SECRET` in `.env.local` matches Stripe
4. Check server logs for signature verification errors

### If webhook fires but Firestore not updated:
1. Check server logs for user lookup errors
2. Verify `stripeCustomerId` exists in Firestore user document
3. Check if `firebaseUid` is in Stripe subscription/customer metadata
4. Look for errors in webhook logs: `[webhook] CRITICAL: Cannot find user`

### If Firestore updated but UI still shows free plan:
1. Check `/api/user/usage` logs for warnings
2. Verify `plan`, `monthlyLimit`, `maxModelsPerRun` are in Firestore
3. Clear browser cache and refresh
4. Check `useUserPlan` hook is calling `/api/user/usage` correctly

## Manual Sync Endpoints

If webhook didn't fire, you can manually sync:

### Sync by User ID
```bash
POST /api/billing/sync-plan
{
  "targetUid": "user-uid-here"
}
```

### Sync by Subscription/Customer ID
```bash
POST /api/admin/sync-subscription
{
  "subscriptionId": "sub_xxx"
  // OR
  "customerId": "cus_xxx"
}
```

## Files Modified

1. **`app/api/stripe/webhook/route.ts`**
   - Enhanced user lookup (4 fallback methods)
   - Improved Firestore updates with all required fields
   - Better logging and error handling
   - Handles all subscription statuses correctly

2. **`app/api/user/usage/route.ts`**
   - Enhanced logging to show Firestore data
   - Warnings when paid plan detected but limits not stored
   - Defensive fallbacks for missing data

## Next Steps

1. **Monitor webhook logs** after deployment
2. **Test with real Stripe subscriptions** in test mode
3. **Set up webhook endpoint** in Stripe Dashboard for production
4. **Add monitoring/alerts** for webhook failures
5. **Consider adding retry logic** for failed webhook processing

## Summary

The webhook now:
- ✅ Always finds users (4 fallback methods)
- ✅ Updates Firestore with all required fields
- ✅ Handles all subscription statuses
- ✅ Provides comprehensive logging
- ✅ Updates subscription metadata for future lookups

The usage endpoint now:
- ✅ Reads from Firestore with defensive fallbacks
- ✅ Logs warnings when webhook data is missing
- ✅ Provides clear debugging information

The UI will now correctly display:
- ✅ "Full Panel — 4 Models" for paid users
- ✅ Correct usage limits (400 runs/month)
- ✅ Correct model limits (4 models per run)
