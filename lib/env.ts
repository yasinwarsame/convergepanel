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
 * Adaptive Research Export, Phase 1 — release gate (defaults off, same
 * fail-closed convention as every flag above). A dedicated flag, never the
 * legacy `MemoInput`/`generateMemo.ts` export path's gating (there isn't
 * one — that path has no flag at all) and never reused from any other
 * feature — per docs/adaptive-research-export-design.md's own finding,
 * this is a genuinely new, independent capability.
 *
 * Both the export API route and the export UI entry point check this flag
 * independently — it is not a substitute for `canExportAdaptiveResearch()`
 * (lib/adaptiveSchema/exportAuthorization.ts)'s per-request authorization;
 * both must pass.
 */
export const ADAPTIVE_RESEARCH_EXPORT_ENABLED = process.env.ADAPTIVE_RESEARCH_EXPORT_ENABLED === "true";

/**
 * Adaptive Research Export, Phase 3 — a SEPARATE release flag for DOCX,
 * deliberately not reusing `ADAPTIVE_RESEARCH_EXPORT_ENABLED`. That flag
 * already gates PDF in production; if DOCX were gated behind the same
 * flag, it would go live immediately on merge, before this phase's own
 * verification/rollout is ready. Default OFF. PDF export is completely
 * unaffected by this flag's value either way — `format: "pdf"` requests
 * only ever check `ADAPTIVE_RESEARCH_EXPORT_ENABLED`.
 *
 * Same two-flag independence discipline as the PDF flag above: this is a
 * release/rollout gate, never a substitute for
 * `canExportAdaptiveResearch()`'s per-request authorization — both must
 * still pass for a DOCX request to succeed.
 */
export const ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED = process.env.ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED === "true";

/**
 * Adaptive Research Export, Phase 4 — a SEPARATE release flag for JSON,
 * same independence discipline as the DOCX flag above: neither
 * `ADAPTIVE_RESEARCH_EXPORT_ENABLED` (PDF) nor
 * `ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED` gate JSON, and this flag gates
 * only JSON — PDF and DOCX are completely unaffected by its value either
 * way. Default OFF. Never a substitute for `canExportAdaptiveResearch()`'s
 * per-request authorization — both must still pass for a JSON request to
 * succeed.
 */
export const ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED = process.env.ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED === "true";

/**
 * Workspace Compatibility Foundation, Phase 1 (docs/workspaces/architecture.md)
 * — a server-side-only kill switch, default OFF (same fail-closed
 * convention as every flag above). Phase 1 introduces the `lib/workspaces/`
 * resolver/access-check modules and a `workspaces` Firestore collection but
 * wires NEITHER into any route yet — this flag currently has no caller in
 * production code at all. It exists now so `resolveWorkspaceContext()`
 * itself is flag-aware from day one: when false, resolution ALWAYS
 * collapses to legacy ownership regardless of any `workspaceId` a resource
 * might (hypothetically — nothing writes one yet) carry, giving a single,
 * global, pre-route-level way to fully disable workspace-mode resolution
 * once later phases do start calling it. Never a public/client flag —
 * workspace membership must always be server-derived (see
 * `lib/workspaces/workspaceAccess.ts`).
 */
export const WORKSPACES_ENABLED = process.env.WORKSPACES_ENABLED === "true";

/**
 * Personal Workspace Provisioning, Phase 2 (docs/workspaces/architecture.md)
 * — a SEPARATE server-side-only kill switch from `WORKSPACES_ENABLED`
 * above, default OFF, same fail-closed convention. Deliberately not
 * reusing `WORKSPACES_ENABLED`: that flag is an authorization/security-
 * boundary concern (does the resolver honor a persisted `workspaceId`?);
 * this one is a rollout concern (is the system currently allowed to
 * CREATE new Personal Workspace documents?). They must be able to move
 * independently — most importantly, disabling this flag must NEVER alter
 * how the Phase-1 resolver treats an already-existing workspace document;
 * it only stops NEW ones from being created. See
 * `lib/workspaces/ensurePersonalWorkspace.ts`.
 *
 * Gates workspace creation only. `POST /api/user/workspace` checks it;
 * nothing else does yet — this flag has no effect on any existing route,
 * and is not wired into login, signup, session refresh, or any other
 * automatic flow. Provisioning remains explicitly-callable-only in Phase 2.
 */
export const PERSONAL_WORKSPACE_PROVISIONING_ENABLED = process.env.PERSONAL_WORKSPACE_PROVISIONING_ENABLED === "true";

/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3
 * (docs/workspaces/architecture.md) — a THIRD independent server-side-only
 * kill switch, default OFF, same fail-closed convention as the two flags
 * above. `WORKSPACES_ENABLED` answers "does the resolver honor a persisted
 * workspaceId" (authorization); `PERSONAL_WORKSPACE_PROVISIONING_ENABLED`
 * answers "can new Workspace documents be created" (Phase 2 provisioning
 * rollout); this one answers "should a newly created Personal adaptive run
 * be persisted WITH a workspaceId at all" (Phase 3 write rollout). All
 * three must be able to move independently.
 *
 * Enabling this while `WORKSPACES_ENABLED` is false is an invalid
 * configuration — see `checkPersonalRunWorkspaceWriteConfiguration()` in
 * `lib/workspaces/personalRunWorkspaceWriteConfig.ts`, the single place
 * that invariant is enforced. A newly bound run would otherwise be
 * immediately inaccessible to its own owner, since the resolver denies
 * (never falls back to legacy) whenever a `workspaceId` is present but
 * `WORKSPACES_ENABLED` is off.
 */
export const PERSONAL_RUN_WORKSPACE_WRITES_ENABLED = process.env.PERSONAL_RUN_WORKSPACE_WRITES_ENABLED === "true";

/**
 * Account-Scoped Workspace Write Canary, Phase 3A
 * (docs/workspaces/architecture.md) — an optional, server-only comma-
 * separated Firebase uid allowlist letting the ALREADY-BUILT Phase 3
 * write path (see `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED` above) be
 * activated for a small number of explicitly named accounts while the
 * global flag stays `false`. Deliberately a raw, unparsed string here —
 * `lib/workspaces/personalRunWorkspaceWriteCanary.ts` owns all parsing/
 * validation/matching logic, so this module stays a pure passthrough
 * like every other env binding in this file.
 *
 * Never prefixed `NEXT_PUBLIC_` — this must never reach a client bundle;
 * canary membership is a server-only decision, resolved once per request
 * against the authenticated uid, never exposed to any response body or
 * client-readable config (see that module's own doc comment for why: an
 * allowlist is a legitimate uid list, sensitive enough to keep entirely
 * server-side even though it doesn't gate anything security-critical by
 * itself).
 */
export const PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS = process.env.PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS;

/**
 * Personal Workspace UI Shell, Phase 5C — a PRESENTATION-only rollout
 * flag, unrelated to and with no effect on `WORKSPACES_ENABLED` /
 * `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` /
 * `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED` above. Those three gate whether
 * Workspace association/provisioning/writes are authorized at all; this
 * one only decides whether the `/workspace` UI route and its `TopNav`
 * entry are visible. Phase 5B's read APIs (`GET /api/user/workspace`,
 * `GET /api/user/workspace/runs`) never check this flag and remain
 * reachable to any authenticated user regardless of its value — a flag
 * this narrow must never become a second authorization boundary.
 *
 * Default OFF (absent), same fail-closed convention as every flag above
 * — this is the required dark-deployment state: shipping this phase's
 * code must never require setting this variable to remain safe.
 */
export const PERSONAL_WORKSPACE_UI_ENABLED = process.env.PERSONAL_WORKSPACE_UI_ENABLED === "true";

/**
 * Account-Scoped Workspace UI Canary, Phase 5C — structural sibling of
 * `PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS` above: an optional, server-
 * only comma-separated Firebase uid allowlist letting the Workspace UI be
 * activated for a small number of explicitly named accounts while
 * `PERSONAL_WORKSPACE_UI_ENABLED` stays `false`. Raw, unparsed string —
 * `lib/workspaces/workspaceUiRollout.ts` owns all parsing/validation/
 * matching/precedence logic.
 *
 * Never prefixed `NEXT_PUBLIC_` — canary membership is a server-only
 * decision, resolved once per request against the authenticated uid via
 * `GET /api/user/usage`, never exposed to any response body or client-
 * readable config. The browser only ever receives the final boolean
 * (`workspaceUiEnabled`) that decision produces.
 */
export const PERSONAL_WORKSPACE_UI_CANARY_UIDS = process.env.PERSONAL_WORKSPACE_UI_CANARY_UIDS;

/**
 * Projects Foundation, Phase 6B — backend Project-capability rollout flag
 * (CRUD availability + `projectId` authorization together). Unrelated to
 * and with no effect on any Workspace flag above — Projects is an
 * additive organizational layer on top of an already-provisioned Personal
 * Workspace, never a replacement for Workspace's own gating.
 *
 * Deliberately does NOT also gate `PROJECT_RUN_ASSOCIATION_WRITES_ENABLED`
 * or `PROJECTS_UI_ENABLED` — those are Phase 6D's and Phase 7's own,
 * separate flags (not yet implemented; see
 * docs/workspaces/architecture.md), kept independent so backend rollout,
 * run-association writes, and UI exposure can each move on their own
 * schedule, exactly mirroring how `WORKSPACES_ENABLED` /
 * `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED` / `PERSONAL_WORKSPACE_UI_ENABLED`
 * are already kept independent.
 *
 * No route reads this yet (Phase 6C). Default OFF (absent) — the required
 * dark-deployment state; shipping Phase 6B must never require setting
 * this variable to remain safe, since Phase 6B has no route that could
 * even read it.
 */
export const PROJECTS_ENABLED = process.env.PROJECTS_ENABLED === "true";

/**
 * Account-Scoped Projects Backend Canary, Phase 6B — structural sibling
 * of `PERSONAL_WORKSPACE_UI_CANARY_UIDS` above: an optional, server-only
 * comma-separated Firebase uid allowlist letting Project backend
 * capability be activated for a small number of explicitly named accounts
 * while `PROJECTS_ENABLED` stays `false`. Raw, unparsed string —
 * `lib/projects/projectsRollout.ts` owns all parsing/validation/matching/
 * precedence logic.
 *
 * Never prefixed `NEXT_PUBLIC_`, for the same reason as every other
 * canary allowlist in this file — server-only decision, never exposed to
 * any response body or client-readable config.
 */
export const PROJECTS_CANARY_UIDS = process.env.PROJECTS_CANARY_UIDS;

/**
 * Going-Forward Run/Project Association Writer, Phase 6D.2 — a FOURTH
 * independent server-side-only kill switch, default OFF, deliberately
 * separate from `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS` above.
 * `PROJECTS_ENABLED` answers "can this uid use Project CRUD"; this one
 * answers "should a newly created Personal Workspace-bound run be
 * persisted with `projectId: null` at all." These must be able to move
 * independently — once this flag is globalized, EVERY newly-created
 * Personal Workspace-bound run gets `projectId: null` regardless of
 * whether that uid has Project CRUD/UI eligibility, so the missing-field
 * cohort stops growing for everyone, not just the Project CRUD canary
 * population. See `lib/projects/projectRunAssociationWriteCanary.ts` for
 * the rollout-mode resolver this gates — precedence mirrors
 * `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED`/`resolvePersonalRunWorkspaceWriteMode()`
 * exactly (Phase 3A), not a new interpretation: the canary below is an
 * independent activation path, not subordinate to this flag.
 *
 * This flag governs ONLY whether the initial `projectId: null` field is
 * written — it never independently produces a `workspaceId`. The
 * existing, unmodified Personal Workspace run-write path
 * (`PERSONAL_RUN_WORKSPACE_WRITES_ENABLED`) remains the sole source of
 * `workspaceId`; this writer only piggybacks on that already-resolved
 * binding when one exists.
 */
export const PROJECT_RUN_ASSOCIATION_WRITES_ENABLED = process.env.PROJECT_RUN_ASSOCIATION_WRITES_ENABLED === "true";

/**
 * Account-Scoped Run/Project Association Write Canary, Phase 6D.2 —
 * structural sibling of `PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS`: an
 * optional, server-only comma-separated Firebase uid allowlist letting
 * the `projectId: null` writer be activated for a small number of
 * explicitly named accounts while `PROJECT_RUN_ASSOCIATION_WRITES_ENABLED`
 * stays `false` — an INDEPENDENT activation path, exactly mirroring
 * `resolvePersonalRunWorkspaceWriteMode()`'s proven precedence, not a
 * value that only narrows an already-`true` global flag. Raw, unparsed
 * string — `lib/projects/projectRunAssociationWriteCanary.ts` owns all
 * parsing/validation/matching/precedence logic.
 *
 * Never prefixed `NEXT_PUBLIC_`, for the same reason as every other
 * canary allowlist in this file.
 */
export const PROJECT_RUN_ASSOCIATION_WRITE_CANARY_UIDS = process.env.PROJECT_RUN_ASSOCIATION_WRITE_CANARY_UIDS;

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

