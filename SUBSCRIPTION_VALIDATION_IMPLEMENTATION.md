# Subscription Validation Implementation

## Overview

Added subscription validation to ensure Firestore stays in sync with Stripe even if webhooks fail. The validation is **defensive and non-blocking** - it never prevents users from accessing the app.

## When Subscription Status is Checked

### 1. **On Login** (`app/login/page.tsx`)
- **When**: After successful login, if user has a paid plan
- **How**: Calls `/api/billing/validate-subscription` asynchronously
- **Behavior**: Non-blocking - login completes even if validation fails

### 2. **When Fetching Usage Data** (`app/api/user/usage/route.ts`)
- **When**: Every time `/api/user/usage` is called for paid plan users
- **How**: Runs `validateUserSubscription()` asynchronously (doesn't block response)
- **Behavior**: Returns usage data immediately, validation happens in background

### 3. **Before Running Panels** (`app/api/run-panel/route.ts`)
- **When**: Before checking plan limits and executing panel
- **How**: Calls `validateUserSubscription()` synchronously but catches errors
- **Behavior**: If validation fails, logs warning but continues with panel run

## Implementation Details

### New Files Created

1. **`lib/stripe/subscriptionValidation.ts`**
   - `validateUserSubscription()`: Main validation function
   - `isSubscriptionLikelyActive()`: Quick check without Stripe API call
   - Validates subscription status with Stripe
   - Updates Firestore if subscription status has changed
   - Downgrades to free plan if subscription is canceled

2. **`lib/stripe/webhookHelpers.ts`**
   - `updateUserPlanInFirestore()`: Shared function for updating Firestore
   - Used by both webhook handler and validation
   - Ensures consistent Firestore updates

3. **`app/api/billing/validate-subscription/route.ts`**
   - API endpoint for client-side validation calls
   - Authenticates user and calls validation function
   - Returns success/failure status

### Modified Files

1. **`app/api/stripe/webhook/route.ts`**
   - Now imports `updateUserPlanInFirestore` from shared helper
   - No functional changes - just uses shared code

2. **`app/api/user/usage/route.ts`**
   - Added async validation call for paid plan users
   - Validation runs in background, doesn't block response

3. **`app/api/run-panel/route.ts`**
   - Added validation before plan limit checks
   - Wrapped in try/catch to never block panel execution

4. **`app/login/page.tsx`**
   - Added async validation call after login for paid plan users
   - Validation doesn't block login redirect

## Validation Logic

### What It Does

1. **Checks if validation is needed**:
   - Only validates paid plans (free plan users skip validation)
   - Requires `stripeCustomerId` to be present

2. **Fetches subscription from Stripe**:
   - Lists all subscriptions for the customer
   - Finds most recent active subscription (active, trialing, or past_due)

3. **Compares with Firestore**:
   - If subscription exists in Stripe but Firestore plan doesn't match → Updates Firestore
   - If no active subscription in Stripe but user has paid plan → Downgrades to free
   - If plans match → No action needed

4. **Updates Firestore** (if needed):
   - Uses `updateUserPlanInFirestore()` helper
   - Updates plan, limits, subscription status, etc.
   - Resets usage counters for new plan

### Defensive Design

- **Never throws errors**: All errors are caught and logged
- **Never blocks users**: Validation failures don't prevent access
- **Best-effort**: If Stripe API is down, validation fails gracefully
- **Non-blocking**: Async validation doesn't delay responses

## Example Scenarios

### Scenario 1: Subscription Canceled in Stripe
- **Stripe**: Subscription status = "canceled"
- **Firestore**: plan = "full"
- **Action**: Validation detects mismatch, downgrades user to "free" plan
- **Result**: User sees free plan limits on next page load

### Scenario 2: Webhook Failed, Subscription Still Active
- **Stripe**: Subscription status = "active"
- **Firestore**: plan = "free" (webhook didn't fire)
- **Action**: Validation detects active subscription, upgrades user to paid plan
- **Result**: User gets access to paid features immediately

### Scenario 3: Plans Already Match
- **Stripe**: Subscription status = "active", plan = "full"
- **Firestore**: plan = "full"
- **Action**: No update needed
- **Result**: No Firestore write, validation completes quickly

## Logging

All validation operations are logged with clear prefixes:
- `[subscriptionValidation]` - Validation function logs
- `[validate-subscription]` - API endpoint logs
- `[run-panel]` - Panel run validation logs
- `[user/usage]` - Usage endpoint validation logs

## Testing

To test validation:
1. Cancel a subscription in Stripe dashboard
2. Log in or run a panel
3. Check server logs for validation messages
4. Verify Firestore is updated to "free" plan

## Summary

✅ **Subscription validation is now active** at three key points:
- On login (for paid plan users)
- When fetching usage data (for paid plan users)
- Before running panels (for paid plan users)

✅ **All validation is defensive**:
- Never blocks users
- Never throws unhandled errors
- Logs all issues for debugging

✅ **Existing logic is preserved**:
- Webhook handler still works as before
- All existing flows continue to function
- Validation is additive, not replacing existing logic
