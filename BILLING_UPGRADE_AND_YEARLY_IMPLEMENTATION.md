# Billing Upgrade and Yearly Subscription Implementation

## Overview

This document describes the implementation of:
1. **Upgrade path from 2-model (lite) to 4-model (full) plans**
2. **Yearly subscription support for both plan tiers**

## Current Architecture Summary

### Key Files

1. **`app/api/billing/create-checkout-session/route.ts`**
   - Creates Stripe checkout sessions for new subscriptions
   - **NEW**: Detects existing subscriptions and upgrades them directly (lite → full)
   - Handles both monthly and yearly billing intervals

2. **`app/api/stripe/webhook/route.ts`**
   - Handles Stripe webhook events
   - Maps subscriptions to internal plans
   - Updates Firestore with plan, limits, and billing interval
   - **Already supports yearly subscriptions** via `billingInterval` field

3. **`lib/billing/subscriptionMapper.ts`**
   - Maps Stripe subscription objects to internal plan configurations
   - Determines plan based on price ID matching

4. **`lib/stripe/webhookHelpers.ts`**
   - Shared function for updating Firestore with subscription data
   - Stores `billingInterval: "month" | "year" | null`

5. **`app/billing/page.tsx`**
   - Billing UI component
   - **NEW**: Shows upgrade options for lite plan users
   - **NEW**: Displays current billing interval (monthly/yearly)

6. **`app/api/user/usage/route.ts`**
   - Returns user plan and usage data
   - **NEW**: Returns `billingInterval` field

7. **`hooks/useUserPlan.ts`**
   - React hook for accessing plan/usage data
   - **NEW**: Returns `billingInterval` field

## Implementation Details

### 1. Upgrade Logic (2-model → 4-model)

**Location**: `app/api/billing/create-checkout-session/route.ts`

**How it works**:
1. Checks if user has an existing active subscription
2. If user is on lite plan and requesting full plan, upgrades the subscription directly
3. Uses Stripe's `subscription.update()` API with proration
4. Webhook automatically fires `customer.subscription.updated` event
5. Webhook updates Firestore with new plan and limits

**Upgrade scenarios handled**:
- ✅ lite monthly → full monthly
- ✅ lite yearly → full yearly
- ✅ lite monthly → full yearly (cross-interval upgrade)
- ✅ lite yearly → full monthly (cross-interval upgrade)

**Code flow**:
```typescript
// Detect if this is an upgrade
const isUpgrade = existingSubscription && 
                  existingSubscription.status === "active" &&
                  planId === "full" &&
                  isLitePlan;

if (isUpgrade) {
  // Update subscription directly (no checkout needed)
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: "always_invoice",
  });
  // Redirect to billing page - webhook will update Firestore
}
```

### 2. Yearly Subscription Support

**Stripe Price IDs** (from `.env.local`):
- `STRIPE_PRICE_2_MODELS` - 2-model monthly
- `STRIPE_2_MODEL_ANNUAL` - 2-model yearly
- `STRIPE_PRICE_4_MODELS` - 4-model monthly
- `STRIPE_4_MODEL_ANNUAL` - 4-model yearly

**Firestore Storage**:
- `billingInterval: "month" | "year" | null`
- Stored by webhook when subscription is created/updated
- Used by UI to display current billing period

**Webhook Detection**:
```typescript
// In webhook handler
const isAnnual = subscription.items.data[0]?.price.recurring?.interval === "year";
const billingInterval: BillingInterval = isAnnual ? "year" : "month";
```

**Usage Limits**:
- Monthly limits remain **per month** regardless of billing interval
- Yearly subscriptions still track `runsThisMonth` and reset monthly
- Billing period (monthly vs yearly) only affects Stripe charges, not usage tracking

### 3. Billing Page UI Updates

**For Free Users**:
- Shows both lite and full plan options
- Monthly/Yearly toggle
- Both tiers available for selection

**For Lite Plan Users**:
- Shows upgrade section with "Upgrade to Full Panel" options
- Monthly/Yearly toggle for upgrade selection
- "Manage Billing" button to access Stripe Customer Portal

**For Full Plan Users**:
- Shows "Manage Billing" button only
- No upgrade options (already on highest tier)

**Current Plan Display**:
- Shows plan name and price
- Displays billing interval (monthly/yearly)
- Shows equivalent monthly price for yearly plans

## Firestore Document Structure

```typescript
{
  plan: "lite" | "full" | "free",
  monthlyLimit: number,        // 100 for lite, 400 for full, 8 for free
  maxModelsPerRun: number,      // 2 for lite/free, 4 for full
  billingInterval: "month" | "year" | null,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  subscriptionStatus: "active" | "trialing" | "past_due" | "canceled" | ...,
  runsThisMonth: number,
  usageMonth: "YYYY-MM",
  // ... other fields
}
```

## Testing Scenarios

### Scenario 1: New User Purchases 2-model Monthly
1. User selects "Research Lite — 2 Models" with "Monthly" toggle
2. Checkout session created with `STRIPE_PRICE_2_MODELS`
3. After payment, webhook fires `checkout.session.completed`
4. Webhook updates Firestore: `plan: "lite"`, `billingInterval: "month"`, `monthlyLimit: 100`
5. User sees updated plan on billing page

### Scenario 2: Existing 2-model Monthly User Upgrades to 4-model Monthly
1. User on lite monthly plan clicks "Upgrade to Full Panel (Monthly)"
2. API detects existing subscription
3. Subscription updated directly (no checkout): `subscription.update()` called
4. Stripe fires `customer.subscription.updated` webhook
5. Webhook updates Firestore: `plan: "full"`, `monthlyLimit: 400`, `maxModelsPerRun: 4`
6. User redirected to billing page with success message

### Scenario 3: New User Purchases 2-model Yearly
1. User selects "Research Lite — 2 Models" with "Annual" toggle
2. Checkout session created with `STRIPE_2_MODEL_ANNUAL`
3. After payment, webhook fires `checkout.session.completed`
4. Webhook detects `price.recurring.interval === "year"`
5. Webhook updates Firestore: `plan: "lite"`, `billingInterval: "year"`, `monthlyLimit: 100`
6. User sees yearly plan on billing page

### Scenario 4: New User Purchases 4-model Yearly
1. User selects "Full Panel — 4 Models" with "Annual" toggle
2. Checkout session created with `STRIPE_4_MODEL_ANNUAL`
3. After payment, webhook fires and updates Firestore
4. Firestore: `plan: "full"`, `billingInterval: "year"`, `monthlyLimit: 400`

### Scenario 5: 2-model Yearly User Upgrades to 4-model Yearly
1. User on lite yearly plan clicks "Upgrade to Full Panel (Yearly)"
2. API detects existing subscription and upgrades it
3. Subscription price changed from `STRIPE_2_MODEL_ANNUAL` to `STRIPE_4_MODEL_ANNUAL`
4. Webhook updates Firestore: `plan: "full"`, `billingInterval: "year"`, `monthlyLimit: 400`

## Logging

All billing operations include comprehensive logging:

**Checkout Session Creation**:
- `[create-checkout-session]` - Logs plan, interval, price ID, upgrade detection

**Subscription Updates**:
- `[create-checkout-session] Upgrading existing subscription` - Logs upgrade details
- `[create-checkout-session] ✅ Subscription upgraded successfully` - Confirms upgrade

**Webhook Processing**:
- `[webhook] Processing subscription change` - Logs subscription details
- `[webhook] Mapped subscription to plan` - Logs plan mapping
- `[webhook] Processing subscription change` - Logs billing interval detection
- `[webhookHelpers] Updating Firestore` - Logs Firestore update details

## Environment Variables Required

```bash
# Monthly price IDs
STRIPE_PRICE_2_MODELS=price_xxx  # 2-model monthly
STRIPE_PRICE_4_MODELS=price_xxx  # 4-model monthly

# Yearly price IDs
STRIPE_2_MODEL_ANNUAL=price_xxx   # 2-model yearly
STRIPE_4_MODEL_ANNUAL=price_xxx  # 4-model yearly

# Stripe API keys
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## Backwards Compatibility

✅ **All existing functionality preserved**:
- Monthly 2-model subscriptions continue to work
- Monthly 4-model subscriptions continue to work
- Webhook handling unchanged (only extended)
- Firestore structure backwards compatible (billingInterval is optional)

✅ **No breaking changes**:
- Existing TypeScript types extended, not changed
- API responses include new fields but remain compatible
- UI gracefully handles missing billingInterval (shows as monthly)

## Future Enhancements

Potential improvements (not implemented):
- Downgrade path (full → lite)
- Billing interval change (monthly ↔ yearly) without plan change
- Proration preview before upgrade
- Usage-based upgrade recommendations
