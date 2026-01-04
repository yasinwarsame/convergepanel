# Webhook Troubleshooting Guide

## Problem: Stripe subscription created but Firestore not updated

If subscriptions are being created in Stripe but Firestore is not being updated, follow these steps:

## Step 1: Check Webhook Configuration

### Verify Webhook Endpoint in Stripe Dashboard

1. Go to Stripe Dashboard → Developers → Webhooks
2. Check if your webhook endpoint is configured:
   - **Local development**: Use Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
   - **Production**: Should be `https://your-domain.com/api/stripe/webhook`
3. Verify these events are enabled:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`

### Verify Webhook Secret

1. Check `.env.local` has `STRIPE_WEBHOOK_SECRET`
2. For local testing with Stripe CLI, use the webhook signing secret from the CLI output
3. For production, get the webhook secret from Stripe Dashboard → Webhooks → Your endpoint → Signing secret

## Step 2: Check Server Logs

Look for these log messages:

### Webhook Received
```
[webhook] ✅ Received event: { type: 'checkout.session.completed', ... }
```

### User Found
```
[webhook] ✅ Found user by stripeCustomerId: {uid}
```

### Plan Mapped
```
[webhook] Mapped subscription to plan: { mappedPlan: 'full', ... }
```

### Firestore Updated
```
[webhook] ✅ Firestore update successful for user {uid}
[webhook] ✅ Verified Firestore update: { plan: 'full', monthlyLimit: 400, ... }
```

### Errors to Look For
```
[webhook] ❌ CRITICAL: Cannot find user for subscription
[webhook] ❌ CRITICAL: Firestore update failed
[webhook] Could not map price ID to plan
```

## Step 3: Manual Sync (Immediate Fix)

If webhook hasn't fired, manually sync the plan:

### Option A: Use the Sync Endpoint

1. **From Browser Console** (on `/billing` page):
   ```javascript
   const token = await firebase.auth().currentUser.getIdToken();
   fetch('/api/billing/sync-plan', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${token}`
     },
     body: JSON.stringify({})
   }).then(r => r.json()).then(console.log);
   ```

2. **From Terminal** (with auth cookie):
   ```bash
   curl -X POST http://localhost:3000/api/billing/sync-plan \
     -H "Content-Type: application/json" \
     -H "Cookie: your-session-cookie" \
     -d '{}'
   ```

### Option B: Use Test Webhook Endpoint

For a specific subscription:
```bash
POST /api/admin/test-webhook
{
  "subscriptionId": "sub_xxx"
  // OR
  "customerId": "cus_xxx"
}
```

## Step 4: Verify Firestore Update

After sync, check Firestore console:
- User document should have:
  - `plan: "full"` (not "free")
  - `monthlyLimit: 400`
  - `maxModelsPerRun: 4`
  - `stripeSubscriptionId: "sub_xxx"`
  - `subscriptionStatus: "active"`

## Step 5: Common Issues & Fixes

### Issue: Webhook not firing

**Causes:**
- Webhook endpoint not configured in Stripe
- Webhook secret mismatch
- Network/firewall blocking webhook requests

**Fix:**
- Configure webhook in Stripe Dashboard
- Verify `STRIPE_WEBHOOK_SECRET` matches Stripe
- For local dev, use Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe/webhook`

### Issue: User not found

**Causes:**
- `firebaseUid` not in Stripe metadata
- `stripeCustomerId` not in Firestore
- Customer ID mismatch

**Fix:**
- Check server logs for user lookup attempts
- Verify `stripeCustomerId` exists in Firestore user document
- The webhook will try 4 methods to find the user (should work)

### Issue: Price ID not mapped

**Causes:**
- Test price ID not in environment variables
- Price ID doesn't match configured mappings

**Fix:**
- Check `.env.local` has `STRIPE_MONTHLY_4_MODELS_TEST=price_xxx`
- Verify price ID in logs matches environment variable
- Check `lib/billing/planConfig.ts` logs show price ID mapped

### Issue: Firestore update fails silently

**Causes:**
- Firestore permissions issue
- Network error
- Invalid data format

**Fix:**
- Check server logs for Firestore errors
- Verify Firestore Admin SDK is initialized
- Check Firestore rules allow updates

## Step 6: Test the Webhook Manually

### Using Stripe CLI (Local)

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login
stripe login

# Forward webhooks
stripe listen --forward-to localhost:3000/api/stripe/webhook

# In another terminal, trigger test event
stripe trigger checkout.session.completed
```

### Using Stripe Dashboard

1. Go to Stripe Dashboard → Developers → Webhooks
2. Click on your webhook endpoint
3. Click "Send test webhook"
4. Select event type (e.g., `customer.subscription.created`)
5. Check server logs for processing

## Step 7: Automatic Sync on Checkout Return

The billing page automatically syncs when user returns from checkout:

1. User completes checkout → redirected to `/billing?success=true`
2. Billing page calls `/api/billing/sync-plan`
3. Sync endpoint finds subscription and updates Firestore
4. UI refreshes to show updated plan

**If this doesn't work:**
- Check browser console for sync errors
- Check server logs for `[billing]` and `[sync-plan]` messages
- Verify user is authenticated when sync runs

## Debugging Checklist

- [ ] Webhook endpoint configured in Stripe Dashboard
- [ ] `STRIPE_WEBHOOK_SECRET` set in `.env.local`
- [ ] Webhook secret matches Stripe Dashboard
- [ ] Server logs show webhook events received
- [ ] Server logs show user found by `stripeCustomerId`
- [ ] Server logs show plan mapped correctly
- [ ] Server logs show Firestore update successful
- [ ] Firestore document has correct `plan`, `monthlyLimit`, `maxModelsPerRun`
- [ ] UI shows correct plan after refresh

## Still Not Working?

1. **Check webhook logs in Stripe Dashboard**:
   - Go to Stripe Dashboard → Developers → Webhooks → Your endpoint
   - Check "Recent events" for failed attempts
   - Click on failed events to see error details

2. **Test webhook manually**:
   - Use `/api/admin/test-webhook` endpoint with subscription ID
   - This bypasses webhook signature verification
   - Helps isolate if issue is webhook delivery or processing logic

3. **Check Firestore permissions**:
   - Verify Firestore Admin SDK has write permissions
   - Check Firestore security rules (if any)

4. **Verify environment variables**:
   - Ensure test price IDs are set: `STRIPE_MONTHLY_4_MODELS_TEST`
   - Check server logs show price IDs are mapped on startup
