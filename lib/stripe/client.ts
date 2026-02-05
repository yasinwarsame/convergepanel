/**
 * Stripe Client Initialization
 * 
 * Server-side Stripe client using the official Stripe Node SDK.
 * This client is used for all Stripe API operations (checkout, subscriptions, webhooks).
 */

import "server-only";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  console.warn("[Stripe] STRIPE_SECRET_KEY not set. Stripe operations will fail.");
}

/**
 * Stripe client instance
 * 
 * Initialized with secret key from environment variables.
 * Only available on the server (uses "server-only").
 */
export const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-12-15.clover", // Use latest stable API version
      typescript: true,
    })
  : null;

