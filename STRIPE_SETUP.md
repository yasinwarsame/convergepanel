# Stripe Integration Setup Guide

This document explains how to set up and configure Stripe subscriptions for ConvergePanel with monthly and annual billing.

## Environment Variables

Add the following to your `.env.local` file:

```bash
# Stripe API Keys (get from https://dashboard.stripe.com/apikeys)
STRIPE_SECRET_KEY=sk_live_xxx  # or sk_test_xxx for test mode
STRIPE_PUBLISHABLE_KEY=pk_live_xxx  # or pk_test_xxx for test mode
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_xxx  # Same as above, but with NEXT_PUBLIC_ prefix for client-side

# Stripe Webhook Secret (get from https://dashboard.stripe.com/webhooks)
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Stripe Price IDs (create products/prices in Stripe Dashboard)
# 2-model plan (Research Lite)
STRIPE_PRICE_2_MODELS=price_xxx  # $60.00/month price ID
STRIPE_2_MODEL_ANNUAL=price_xxx   # $576.00/year price ID

# 4-model plan (Full Panel)
STRIPE_PRICE_4_MODELS=price_xxx  # $99.00/month price ID
STRIPE_4_MODEL_ANNUAL=price_xxx   # $950.40/year price ID

# App URL (for redirects)
NEXT_PUBLIC_APP_URL=http://localhost:3001  # or your production URL
```

## Setting Up Stripe Products and Prices

1. Go to [Stripe Dashboard > Products](https://dashboard.stripe.com/products)
2. Create two products:
   - **Research Lite — 2 Models**: 
     - Monthly price: $60.00/month recurring
     - Annual price: $576.00/year recurring
   - **Full Panel — 4 Models**:
     - Monthly price: $99.00/month recurring
     - Annual price: $950.40/year recurring
3. Copy the Price IDs (format: `price_xxx`) and add them to `.env.local`:
   - `STRIPE_PRICE_2_MODELS` (Research Lite monthly)
   - `STRIPE_2_MODEL_ANNUAL` (Research Lite annual)
   - `STRIPE_PRICE_4_MODELS` (Full Panel monthly)
   - `STRIPE_4_MODEL_ANNUAL` (Full Panel annual)

## Setting Up Webhooks

1. Go to [Stripe Dashboard > Webhooks](https://dashboard.stripe.com/webhooks)
2. Click "Add endpoint"
3. Set endpoint URL to: `https://yourdomain.com/api/stripe/webhook`
4. Select events to listen for:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Copy the webhook signing secret (format: `whsec_xxx`) and add it to `.env.local` as `STRIPE_WEBHOOK_SECRET`

## Usage Tracking

ConvergePanel uses **calendar month** tracking for usage limits:
- Usage resets on the first day of each calendar month
- The `usageMonth` field stores the current month in `YYYY-MM` format (e.g., "2025-12")
- When a new month starts, the system automatically resets `runsThisMonth` to 0

## Plan Limits

### Free Plan (Starter)
- 8 runs per month
- Max 2 models per run
- Last 7 days of history only
- No advanced exports

### Research Lite ($60/month or $576/year)
- 100 runs per month
- Max 2 models per run
- Unlimited history
- Basic exports enabled

### Full Panel ($99/month or $950.40/year)
- 400 runs per month
- Max 4 models per run
- Unlimited history
- Advanced exports enabled

## Testing

For local development with Stripe webhooks, use [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3001/api/stripe/webhook
```

This will give you a webhook signing secret starting with `whsec_` that you can use in `.env.local` for local testing.

## Troubleshooting

### Webhook signature verification fails
- Ensure `STRIPE_WEBHOOK_SECRET` matches the secret from your webhook endpoint
- For local testing, use the secret from `stripe listen` command

### Checkout session creation fails
- Verify all four price IDs (`STRIPE_PRICE_2_MODELS`, `STRIPE_2_MODEL_ANNUAL`, `STRIPE_PRICE_4_MODELS`, `STRIPE_4_MODEL_ANNUAL`) are valid price IDs
- Ensure prices are set to "Recurring" and correct interval (Monthly or Yearly) in Stripe Dashboard
- Check that the environment variables are set in your `.env.local` file (or your hosting provider's environment settings)

### Usage not incrementing
- Check that `/api/run-panel` is calling `incrementRunCount()` after successful panel runs
- Verify Firestore permissions allow writes to `users/{uid}` collection

### Annual billing not working
- Ensure annual price IDs are correctly set in `.env.local`
- Verify annual prices are created as "Yearly" recurring prices in Stripe Dashboard

