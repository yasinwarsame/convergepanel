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

    if (!process.env.DEEPSEEK_API_KEY) {
      console.warn("[env] Missing DEEPSEEK_API_KEY – DeepSeek fallback will be disabled.");
    }
  }
})();

// Export the API keys
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const XAI_API_KEY = process.env.XAI_API_KEY;
export const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

/**
 * Adaptive Result Schema System feature flag (defaults off).
 *
 * When enabled, /api/run-panel classifies the query and builds per-model
 * prompts from lib/adaptiveSchema/schemaRegistry.ts instead of the fixed
 * 11-section template in lib/panelPrompt.ts. The legacy path (and the
 * markdown-parsing synthesis/agreement-map pipeline) is untouched when this
 * is off.
 */
export const ADAPTIVE_SCHEMAS_ENABLED = process.env.ADAPTIVE_SCHEMAS_ENABLED === "true";

/**
 * Adaptive Verification Engine feature flag (defaults off, requires
 * ADAPTIVE_SCHEMAS_ENABLED to have any effect).
 *
 * When enabled, adaptive runs get the full restored verification layer on
 * top of the aligned claims matrix: schema-adaptive agreement scoring,
 * certainty scoring, the pass/caution/fail verification gate, the Synthesis
 * Report (Unified Answer + Panel Verdict), and the three-tab List/Compare/
 * Synthesis UI. When off, adaptive runs keep today's behavior — the raw
 * aligned-claims matrix rendered by AdaptiveResultsView only, no scoring —
 * so this can be rolled out independently of ADAPTIVE_SCHEMAS_ENABLED.
 */
export const ADAPTIVE_VERIFICATION_ENABLED = process.env.ADAPTIVE_VERIFICATION_ENABLED === "true";

/**
 * Multi-Reviewer Governance production-readiness hardening (Step 5.11) —
 * a global, server-side-only kill switch for NEW multi-reviewer panel
 * activity, defaulting OFF in every environment unless explicitly set to
 * the literal string `"true"` (same fail-closed convention as
 * `ADAPTIVE_SCHEMAS_ENABLED` above). This is deliberately a SECOND,
 * independent layer on top of each team's own `adaptiveMultiReviewerSettings.enabled`
 * opt-in (`lib/governance/adaptiveTeamReview.ts`) — never a replacement for
 * it. Its only purpose is incident-response speed: flipping ONE env var
 * (requiring a redeploy/restart, not a Firestore write) can instantly stop
 * NEW panel creation/reconfiguration across every team at once, without
 * needing to locate and edit N separate team documents.
 *
 * Scope is deliberately narrow, matching the same "block new activity,
 * never block draining an existing panel" policy the team-level opt-in
 * itself now follows (see the review-panel PUT route): this flag is
 * checked ONLY at panel creation/reconfiguration. It is NEVER checked by
 * vote submission, finalization, owner override, or panel cancellation —
 * an already-open panel must always remain completable or cancellable
 * regardless of this flag's value, so no panel can ever become stranded by
 * an incident-response kill-switch flip. Read access (`GET .../review-panel`)
 * is likewise never gated by this flag.
 */
export const MULTI_REVIEWER_GOVERNANCE_ENABLED = process.env.MULTI_REVIEWER_GOVERNANCE_ENABLED === "true";

/**
 * Search engine site-verification tokens.
 *
 * Optional — when unset, the corresponding verification meta tag is simply
 * omitted from the page (see app/layout.tsx generateMetadata). Set these in
 * Vercel project env vars after claiming the property in Google Search
 * Console / Bing Webmaster Tools. See README-SEO.md for the exact steps.
 */
export const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION;
export const BING_SITE_VERIFICATION = process.env.BING_SITE_VERIFICATION;

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

