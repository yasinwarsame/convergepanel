# Stripe Production Migration Summary

> **STALE — read the incident notice first.** This document records the
> **pre-incident** Stripe configuration (its Price IDs were correct only until
> September 2026). Do not copy any Price ID out of it.
>
> **September 2026 Full Annual billing incident.** The Price this document
> lists for `STRIPE_5_MODELS_ANNUAL` was sold as "$1,631.90 / year" but its
> Stripe `recurring.interval` was **month**, so annual subscribers were billed
> monthly. What is true now:
>
> - Production `STRIPE_5_MODELS_ANNUAL` points at a **corrected yearly Price**
>   ($1,631.90, `interval: year`, `interval_count: 1`). Verify with
>   `npm run billing:verify-prices` against a fresh Production env pull; never
>   trust a Price ID copied from this file.
> - **The retired monthly-cadence Price must never be used for new checkout.**
>   It is deliberately absent from the checkout price map and must stay absent.
>   One historical subscription still references it; that customer's repair is
>   a separate, individually approved operation.
> - Checkout verifies a Price's **real** cadence against the interval the
>   customer selected before any Stripe write, and refuses the sale on a
>   mismatch. Configuration alone is no longer trusted.
> - Plan resolution tolerates a **retired** Price via a validated,
>   server-written plan marker, and `trialing` carries full paid entitlement
>   alongside `active`.
> - **Local development must never combine live Stripe secrets with live Price
>   mappings.** Use Stripe **test** credentials and test Price IDs locally, or
>   leave local billing unconfigured so it fails closed. A local checkout run
>   against live credentials creates a real customer subscription.
>
> Everything below is retained for historical context only.

## Overview
Migrated from test mode fallbacks to production-only Stripe Price IDs. Removed all test mode code paths and updated environment variable names to match production configuration.

## Environment Variable Changes

### Before → After Mapping

| Old Env Var Name | New Env Var Name | Description |
|-----------------|------------------|-------------|
| `STRIPE_PRICE_2_MODELS` | `STRIPE_PRICE_3_MODELS` | 3-Model Plan monthly |
| `STRIPE_2_MODEL_ANNUAL` | `STRIPE_3_MODELS_ANNUAL` | 3-Model Plan annual |
| `STRIPE_PRICE_4_MODELS` | `STRIPE_PRICE_5_MODELS` | Full Plan (5 models) monthly |
| `STRIPE_4_MODEL_ANNUAL` | `STRIPE_5_MODELS_ANNUAL` | Full Plan (5 models) annual |

### Legacy Casing Support
The code supports both `STRIPE_5_MODELS_ANNUAL` (preferred) and `Stripe_5_Models_Annual` (legacy from .env.local) for backward compatibility. **Recommendation: Update .env.local to use `STRIPE_5_MODELS_ANNUAL`** for consistency.

### Removed Test Mode Variables
- ❌ `STRIPE_MONTHLY_2_MODELS_TEST` (removed)
- ❌ `STRIPE_MONTHLY_4_MODELS_TEST` (removed)
- ❌ `getTestPriceId()` helper function (removed)

## Final Price ID Mapping Table

| Plan | Billing Interval | Env Var | Price ID |
|------|-----------------|---------|----------|
| 3-Model Plan (lite) | Monthly | `STRIPE_PRICE_3_MODELS` | `price_… (redacted — read from Vercel env, not from this file)` |
| 3-Model Plan (lite) | Annual | `STRIPE_3_MODELS_ANNUAL` | `price_… (redacted — read from Vercel env, not from this file)` |
| Full Plan (full) | Monthly | `STRIPE_PRICE_5_MODELS` | `price_… (redacted — read from Vercel env, not from this file)` |
| Full Plan (full) | Annual | `STRIPE_5_MODELS_ANNUAL` | `price_… (redacted — read from Vercel env, not from this file)` |

## Files Changed

### 1. `lib/env.ts`
**Changes:**
- Removed `getTestPriceId()` helper function
- Removed test mode fallback logic (`STRIPE_MONTHLY_2_MODELS_TEST`, `STRIPE_MONTHLY_4_MODELS_TEST`)
- Updated env var names to match production:
  - `STRIPE_PRICE_2_MODELS` → `STRIPE_PRICE_3_MODELS`
  - `STRIPE_2_MODEL_ANNUAL` → `STRIPE_3_MODELS_ANNUAL`
  - `STRIPE_PRICE_4_MODELS` → `STRIPE_PRICE_5_MODELS`
  - `STRIPE_4_MODEL_ANNUAL` → `STRIPE_5_MODELS_ANNUAL` (supports legacy `Stripe_5_Models_Annual`)
- Added validation function that logs errors if required env vars are missing
- Validation runs at module load time (server-side only)

### 2. `lib/plans.ts`
**Changes:**
- Updated `PLAN_CONFIGS.lite.stripePriceIds` to use:
  - `process.env.STRIPE_PRICE_3_MODELS` (monthly)
  - `process.env.STRIPE_3_MODELS_ANNUAL` (annual)
- Updated `PLAN_CONFIGS.full.stripePriceIds` to use:
  - `process.env.STRIPE_PRICE_5_MODELS` (monthly)
  - `process.env.STRIPE_5_MODELS_ANNUAL || process.env.Stripe_5_Models_Annual` (annual, with legacy casing support)
- Removed test mode fallbacks from `stripePriceIds` configuration
- Updated error messages in `getStripePriceId()` to reference new env var names

### 3. `lib/billing/planConfig.ts`
**Changes:**
- Updated imports to use new env var names:
  - `STRIPE_PRICE_3_MODELS`, `STRIPE_3_MODELS_ANNUAL`
  - `STRIPE_PRICE_5_MODELS`, `STRIPE_5_MODELS_ANNUAL`
- Updated `STRIPE_PRICE_TO_PLAN` mapping initialization to use new env vars
- Updated console.log statements to reference new env var names

### 4. `lib/billing/planMapping.ts`
**Changes:**
- Updated imports to use new env var names
- Removed development-only validation warning (validation now happens in `lib/env.ts`)
- Updated price ID comparisons to use new env vars:
  - `STRIPE_PRICE_3_MODELS` (3-model monthly)
  - `STRIPE_3_MODELS_ANNUAL` (3-model annual)
  - `STRIPE_PRICE_5_MODELS` (5-model monthly)
  - `STRIPE_5_MODELS_ANNUAL` (5-model annual)
- Removed legacy naming comments

### 5. `app/api/billing/create-checkout-session/route.ts`
**Changes:**
- Updated imports to use new env var names
- Updated error messages to reference new env var names
- Updated upgrade detection logic to compare against new env vars (`STRIPE_PRICE_3_MODELS`, `STRIPE_3_MODELS_ANNUAL`)

### 6. `app/api/stripe/webhook/route.ts`
**Changes:**
- Updated documentation comments to reference new env var names
- Webhook handler logic unchanged (uses `getPlanFromPriceId()` which was already updated)

## Validation & Error Handling

### New Validation (in `lib/env.ts`)
- Runs at module load time (server-side only)
- Validates all 4 required Stripe price ID env vars
- Logs clear error messages if any are missing
- Errors are logged but don't crash the app (allows graceful degradation)

### Checkout Route Validation
- `getStripePriceId()` throws descriptive errors if price ID is missing
- Checkout route returns 500 with actionable error message
- Error messages include exact env var names that need to be configured

## Webhook Handler Status

✅ **Production Ready**
- Handles all required events:
  - `checkout.session.completed` - New subscription created
  - `customer.subscription.created` - New subscription created
  - `customer.subscription.updated` - Plan changes, upgrades, downgrades
  - `customer.subscription.deleted` - Subscription canceled → free plan
  - `invoice.payment_succeeded` - Payment successful
  - `invoice.payment_failed` - Payment failed (logged only)
- No test mode logic present
- Uses production price ID mapping via `getPlanFromPriceId()`
- Updates Firestore with correct plan entitlements and billing intervals

## Next Steps

1. **Update .env.local** (if not already done):
   ```bash
   STRIPE_PRICE_3_MODELS=price_… (redacted — read from Vercel env, not from this file)
   STRIPE_PRICE_5_MODELS=price_… (redacted — read from Vercel env, not from this file)
   STRIPE_3_MODELS_ANNUAL=price_… (redacted — read from Vercel env, not from this file)
   STRIPE_5_MODELS_ANNUAL=price_… (redacted — read from Vercel env, not from this file)  # Recommended: use uppercase
   ```

2. **Optional: Standardize casing** in .env.local:
   - Change `Stripe_5_Models_Annual` → `STRIPE_5_MODELS_ANNUAL` for consistency

3. **Verify checkout flow**:
   - Test checkout for 3-Model Plan (monthly/annual)
   - Test checkout for Full Plan (monthly/annual)
   - Verify Stripe dashboard shows correct price IDs

4. **Verify webhook events**:
   - Monitor Stripe webhook logs
   - Verify Firestore updates correctly after checkout
   - Verify plan changes update Firestore correctly

## Testing Checklist

- [ ] All 4 env vars set in .env.local
- [ ] App starts without env var validation errors
- [ ] Checkout creates session with correct price ID
- [ ] Webhook processes `checkout.session.completed` correctly
- [ ] User plan updates in Firestore after checkout
- [ ] Upgrade flow (lite → full) works correctly
- [ ] Subscription cancellation downgrades to free plan
- [ ] Invoice payment events update subscription status

## Plan Details (for reference)

| Plan | Monthly Price | Annual Price | Runs/Month | Models/Run |
|------|--------------|--------------|------------|------------|
| Free | $0 | N/A | 8 | 2 |
| 3-Model Plan (lite) | $99.99 | $959.90 | 80 | 3 |
| Full Plan (full) | $169.99 | $1,631.90 | 150 | 5 |

