/**
 * Centralized Environment Variable Access for ConvergePanel
 * 
 * This is the single source of truth for LLM API keys.
 * All connectors must import from this module instead of accessing process.env directly.
 * 
 * NOTE: Do not use process.env.OPENAI_API_KEY etc. directly in other files.
 * Always import from this module instead.
 * 
 * These keys are server-side only and must NOT be exposed as NEXT_PUBLIC_* variables.
 * 
 * IMPORTANT: This file may be imported in client components (via planConfig), so we only
 * log warnings on the server to avoid browser console noise.
 */

// Warn if keys are missing (helps with debugging during development)
// Only log on server-side to avoid browser console warnings
// (API keys are server-only, so they'll always be undefined in the browser)
// 
// IMPORTANT: This check must run at module load time, but we guard it to only run on server.
// Next.js may bundle this code, so we use multiple checks to ensure we're on the server.
(function checkApiKeys() {
  // Only run on server (Node.js environment)
  // Check multiple conditions to be absolutely sure we're not in the browser
  if (
    typeof window === "undefined" &&
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env === "object"
  ) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[env] Missing OPENAI_API_KEY – OpenAI connector will be disabled.");
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("[env] Missing ANTHROPIC_API_KEY – Anthropic connector will be disabled.");
    }

    if (!process.env.XAI_API_KEY) {
      console.warn("[env] Missing XAI_API_KEY – Grok connector will be disabled.");
    }

    if (!process.env.PERPLEXITY_API_KEY) {
      console.warn("[env] Missing PERPLEXITY_API_KEY – Perplexity connector will be disabled.");
    }

    if (!process.env.GEMINI_API_KEY) {
      console.warn("[env] Missing GEMINI_API_KEY – Gemini connector will be disabled.");
    }
  }
})();

// Export the API keys
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const XAI_API_KEY = process.env.XAI_API_KEY;
export const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Grok Model Configuration
 * 
 * Controls which Grok model ConvergePanel uses.
 * - Default: "grok-4-1-fast-reasoning" (fast, cost-efficient, reasoning-capable)
 *   This model offers excellent reasoning capabilities at $0.20/$0.50 pricing with 2M context,
 *   making it ideal for research-style panel questions that require structured analysis.
 * - Can be overridden in .env.local or hosting provider env settings
 * - Example: GROK_MODEL=grok-4-1-fast-non-reasoning (for non-reasoning variant)
 */
export const GROK_MODEL = process.env.GROK_MODEL || "grok-4-1-fast-reasoning";

/**
 * Stripe Configuration
 * 
 * Stripe keys for subscription management.
 * Get these from Stripe Dashboard: https://dashboard.stripe.com/apikeys
 */
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe Price IDs for subscription plans
// Get these from Stripe Dashboard > Products > Prices
// These are the actual Stripe price IDs (starting with price_...), not dollar amounts
// Production-only: All price IDs must be configured in .env.local
export const STRIPE_PRICE_3_MODELS = process.env.STRIPE_PRICE_3_MODELS; // 3-Model Plan monthly
export const STRIPE_3_MODELS_ANNUAL = process.env.STRIPE_3_MODELS_ANNUAL; // 3-Model Plan annual
export const STRIPE_PRICE_5_MODELS = process.env.STRIPE_PRICE_5_MODELS; // Full Plan (5 models) monthly
// Handle legacy casing: Stripe_5_Models_Annual -> STRIPE_5_MODELS_ANNUAL
export const STRIPE_5_MODELS_ANNUAL = process.env.STRIPE_5_MODELS_ANNUAL || process.env.Stripe_5_Models_Annual; // Full Plan (5 models) annual

// Validate Stripe configuration (all environments)
// This ensures critical env vars are set before the app runs
(function validateStripeConfig() {
  if (
    typeof window === "undefined" &&
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env === "object"
  ) {
    const missing: string[] = [];
    
    if (!STRIPE_PRICE_3_MODELS) missing.push("STRIPE_PRICE_3_MODELS");
    if (!STRIPE_3_MODELS_ANNUAL) missing.push("STRIPE_3_MODELS_ANNUAL");
    if (!STRIPE_PRICE_5_MODELS) missing.push("STRIPE_PRICE_5_MODELS");
    if (!STRIPE_5_MODELS_ANNUAL) missing.push("STRIPE_5_MODELS_ANNUAL (or Stripe_5_Models_Annual)");
    
    if (missing.length > 0) {
      console.error(
        `[env] CRITICAL: Missing required Stripe price ID environment variables:\n` +
        `  ${missing.join("\n  ")}\n` +
        `  Please configure these in .env.local`
      );
    }
    
    if (process.env.NODE_ENV === "production") {
      if (!STRIPE_SECRET_KEY) {
        console.warn("[env] Missing STRIPE_SECRET_KEY – Stripe integration will be disabled.");
      }
      if (!STRIPE_WEBHOOK_SECRET) {
        console.warn("[env] Missing STRIPE_WEBHOOK_SECRET – Webhooks will not be verified.");
      }
    }
  }
})();

