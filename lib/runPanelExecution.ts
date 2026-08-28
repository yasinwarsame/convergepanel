/**
 * Phase 8C-D.1 — the shared "ordinary run" execution/finalization engine,
 * mechanically extracted from `app/api/run-panel/route.ts` (the `RUN PANEL`
 * section through the end of the adaptive-finalize block). Both the
 * Personal `/api/run-panel` route and the Team `POST
 * /api/workspaces/{workspaceId}/runs` route call this after their own,
 * distinct pre-execution/creation preambles complete.
 *
 * CRITICAL INVARIANT (Phase 8C-D.0.3): this function does NOT require or
 * assume that a `runs/{runId}` document exists. Personal's own initial
 * write (`createRun()`) is best-effort — it may fail and execution still
 * proceeds unchanged today, and this function preserves that exactly
 * (`completeRun()`/`persistAdaptiveOutput()`/governance-initialization all
 * already tolerate an absent run document via their own pre-existing
 * catch/status handling, moved here verbatim). Team's caller, by contrast,
 * only ever invokes this function after its own authoritative transaction
 * has committed a canonical row — but that guarantee is enforced by the
 * Team route/writer, never by this function, which stays Workspace- and
 * persistence-agnostic.
 *
 * This function owns no HTTP transport, no quota, no initial run creation,
 * and no Workspace/Team authorization. Every internal try/catch below is
 * unchanged from the original route — a truly uncaught error propagates
 * out of this function to the caller's own outer catch, exactly as it
 * would have propagated to `/api/run-panel`'s own outer catch before
 * extraction.
 */

import { ModelId, ModelResult } from "@/lib/types";
import { runPanel } from "@/lib/panel";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY } from "@/lib/env";
import {
  completeRun,
  markRunError,
  persistAdaptiveOutput,
  persistLegacyAdaptiveOutput,
  readGovernanceRecordForInitialization,
  persistAutomatedGovernanceUpdate,
  writeAdaptiveGovernanceEvent,
} from "@/lib/firestore/runs";
import { initializeAdaptiveGovernanceRecord, GovernanceInitializationResult, GovernanceInitializationStatus } from "@/lib/adaptiveSchema/governanceInitialization";
import { applyAutomatedGovernanceUpdate } from "@/lib/adaptiveSchema/governanceRecordParser";
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { loadGovernancePolicy } from "@/lib/governance/governancePolicyStore";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { CommonResponseMeta } from "@/lib/adaptiveSchema/types";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { routeAdaptiveTeamReview, buildAdaptiveTeamRunProjection } from "@/lib/governance/adaptiveTeamReview";
import { propagatePersonalReviewerAssignment } from "@/lib/governance/personalReviewerAssignment";
// Legacy adaptive-governance projection module — UNCHANGED, untouched by
// Phase 8C-D. Writes to the `teamRuns` collection, which has nothing to do
// with Team Workspaces. See lib/firestore/teamRuns.ts's own doc comment.
import { createAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { PersistedAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { normalizeTokens } from "@/lib/panel/normalizeTokens";
import { sanitizeModelText, truncateForSynthesis, MAX_CHARS_SYNTHESIS_PER_MODEL } from "@/lib/panel/sanitizeText";
import { PanelResultPublic } from "@/lib/panel/schemas";
import { normalizeModelResultPublic, assertPublicStatus } from "@/lib/panel/normalize";
import { logger } from "@/lib/logger";
import { finalizeAdaptiveRun, AdaptivePromptPlan } from "@/lib/adaptiveSchema/orchestrate";
import {
  trackPanelExecutionStarted,
  trackPanelExecutionCompleted,
  trackPanelExecutionFailed,
  trackRankedListShortfall,
  trackComparisonMatrixGap,
  trackDefinitionAmbiguity,
  trackCausalExplanationGap,
  trackChecklistTaxonomyGap,
  trackDeepResearchGap,
  trackEvidenceReviewGap,
  trackBiasAuditNoAttribution,
  trackBiasAuditPanelGapFound,
  trackBiasAuditHomogeneityFlagged,
  trackDecisionSupportContested,
  trackDecisionSupportHighSensitivity,
  trackDecisionSupportMissingCriteria,
} from "@/lib/adaptiveSchema/analytics";

export interface ExecuteOrdinaryRunArgs {
  uid: string;
  runId: string;
  trimmedQuestion: string;
  context: string | null;
  selectedModels: ModelId[];
  adaptivePlan: AdaptivePromptPlan | null;
  /**
   * Resolved by the caller from its own `req.headers.get("x-debug-raw")` —
   * this function is otherwise Request-agnostic (Phase 8C-D.0.2 Correction
   * 9). Dev-only diagnostic logging; never affects persisted data or the
   * returned response.
   */
  debugRawResponseRequested: boolean;
}

/**
 * Named verbatim from the original route's inline `adaptivePayload`
 * variable type (unchanged fields/comments) so both the local variable
 * declaration and this module's exported result type can reference it —
 * the only reason this was given a name at all during extraction.
 */
export type OrdinaryRunAdaptivePayload = {
  classification: AdaptivePromptPlan["classification"];
  schemaId: string;
  results: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["adaptiveResults"];
  alignedClaims?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["alignedClaims"];
  gate?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["gate"];
  synthesisReport?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["synthesisReport"];
  trustSummary?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["trustSummary"];
  rankedEnumeration?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["rankedEnumeration"];
  comparisonMatrix?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["comparisonMatrix"];
  definitionExplanation?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["definitionExplanation"];
  causalExplanation?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["causalExplanation"];
  checklistTaxonomy?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["checklistTaxonomy"];
  deepResearch?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["deepResearch"];
  evidenceReview?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["evidenceReview"];
  biasBlindspotAudit?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["biasBlindspotAudit"];
  decisionSupport?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["decisionSupport"];
  /**
   * Query-Routing Redesign, Phase 1 — the stable, versioned envelope.
   * Prefer this over the many optional schema-result fields above,
   * which remain for backward compatibility with existing clients but
   * are now DERIVED from this same envelope, not an independent source
   * of truth (both come from the same `finalizeAdaptiveRun()` call).
   */
  adaptiveOutput?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["persistedOutput"];
  /**
   * Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
   * §4.1) — top-level so the client never needs to reach into
   * `adaptiveOutput` (undefined for the original-9/factual_lookup
   * family). `meta` is likewise undefined for that family — see
   * reportSummary.ts's own module doc for why (buildCommonResponseMeta
   * only runs for the 9 Milestone-2 schemas).
   */
  generatedAt?: string;
  meta?: CommonResponseMeta;
  /**
   * Whether `adaptiveOutput` was durably saved.
   * - "not_applicable": legacy schema / no envelope was ever built.
   * - "omitted_size_limit": a genuinely distinct, expected outcome —
   *   the envelope was deliberately skipped by the document-size guard,
   *   not a failure. Kept separate from "failed" so a client (or an
   *   on-call engineer) never conflates "this run's own content was
   *   large" with "something is actually broken."
   * - "failed": a genuine write failure (Firestore unavailable, a
   *   thrown error) — the only status worth alerting on if it recurs.
   */
  persistenceStatus?: "saved" | "failed" | "omitted_size_limit" | "not_applicable";
  /**
   * Query-Routing Redesign, Phase 2A, Step 5C — compact status of the
   * one-time `GovernanceRecordV1` initialization attempt for this run.
   * Undefined whenever `adaptiveOutput` itself is undefined (legacy
   * schema — see `persistenceStatus`'s own doc). `"skipped_adaptive_not_saved"`
   * is a route-only value (not part of `GovernanceInitializationStatus`
   * itself): governance requires the durable `adaptiveOutput` to exist
   * first, so initialization is never attempted when `persistenceStatus`
   * isn't `"saved"`. Never includes receipt content, parser reasons, or
   * raw Firestore errors — status only.
   */
  governanceInitializationStatus?: GovernanceInitializationStatus | "skipped_adaptive_not_saved";
  /**
   * Query-Routing Redesign, Phase 2A, Step 6B, Part C — compact status
   * of the adaptive automated-governance evaluation attempt, separate
   * from `governanceInitializationStatus`. Omitted entirely (not set)
   * whenever automated evaluation was never applicable for this run —
   * `governanceInitializationStatus` is `"not_applicable"`,
   * `"malformed_existing_record"`, `"unsupported_existing_version"`,
   * `"omitted_size_limit"`, `"failed"`, or `"skipped_adaptive_not_saved"`.
   * Never includes reasons, policy internals, parser detail, or raw
   * Firestore errors — status only, same discipline as
   * `governanceInitializationStatus`.
   */
  automatedGovernanceStatus?: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";
  /**
   * Query-Routing Redesign, Phase 2A, Step 7, Part C — compact status
   * of the adaptive team-review QUEUE PROJECTION creation attempt
   * (not a review decision — no human review capability exists yet;
   * see docs/governance-decision-receipts-design.md §21). Omitted
   * entirely whenever the governance lifecycle itself never reached a
   * valid record (mirrors `automatedGovernanceStatus`'s own omission
   * rule). Never includes the projection ID, team ID, routing reason
   * detail, governance reasons, or raw Firestore errors — status only.
   */
  adaptiveTeamReviewProjectionStatus?: "created" | "already_exists" | "disabled" | "not_eligible" | "failed";
  /**
   * Reviewer Assignment Propagation — status of the automatic
   * personal (non-team) reviewer-assignment attempt. Only ever set
   * when the owner has no team (adaptiveTeamReviewProjectionStatus
   * === "disabled" for that reason) AND governance was freshly
   * created this request. Omitted for team runs and for reload/
   * already-initialized runs — never re-attempted or re-derived.
   */
  personalReviewerAssignmentStatus?:
    | "assigned"
    | "not_configured"
    | "reviewer_unavailable"
    | "already_assigned"
    | "not_pending"
    | "not_personal_association"
    | "failed";
  /**
   * Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
   * §4.1) — compact human-review state for the top summary bar. Never
   * reviewer name or comment text (same discipline as humanReviewHistory).
   * Omitted whenever no real GovernanceRecordV1 was captured this request.
   */
  humanReview?: {
    status: GovernanceRecordV1["humanReview"]["status"];
    conditions?: string[];
    decidedVia?: GovernanceRecordV1["humanReview"]["decidedVia"];
  };
  /**
   * Derived from `adaptiveTeamReviewProjectionStatus` above, not an
   * independent source of truth — "in_queue" when a review projection
   * was created/already existed, "not_configured" when routing decided
   * against one, "unknown" when routing was never attempted (legacy
   * schema, or the block above never ran).
   */
  reviewRouting?: "in_queue" | "not_configured" | "unknown";
};

export type OrdinaryRunExecutionResult = {
  status: 200;
  body: {
    ok: true;
    results: Array<PanelResultPublic & { rawTextFull: string; rawText: string }>;
    runId: string;
    governanceStatus?: "approved" | "needs_review" | "blocked";
    adaptive?: OrdinaryRunAdaptivePayload;
  };
};

export async function executeOrdinaryRun(args: ExecuteOrdinaryRunArgs): Promise<OrdinaryRunExecutionResult> {
  const { uid, runId, trimmedQuestion, context, selectedModels, adaptivePlan, debugRawResponseRequested } = args;

  // ============================================
  // RUN PANEL
  // ============================================

  // Build API keys object from environment variables
  // Import from centralized env module instead of accessing process.env directly
  const apiKeys = {
    chatgpt: OPENAI_API_KEY,
    claude: ANTHROPIC_API_KEY,
    grok: XAI_API_KEY,
    perplexity: PERPLEXITY_API_KEY,
    gemini: GEMINI_API_KEY,
  };

  // Call the existing panel orchestration logic.
  // IMPORTANT: runPanel uses Promise.allSettled, so it should never throw.
  // However, we ensure token finalization ALWAYS runs even if something unexpected happens.
  // runPanel handles per-model errors internally, so partial failures are OK.
  // panel_execution_started fires ONLY here — after the routing guard above has
  // already confirmed adaptivePlan.routing.kind === "active" (or adaptive is off
  // entirely) — never for a handoff/disabled/clarification/unanswerable outcome.
  if (adaptivePlan) {
    trackPanelExecutionStarted(uid, adaptivePlan.classification, selectedModels.length);
  }
  let results: ModelResult[] = [];
  try {
    results = await runPanel(
      trimmedQuestion,
      selectedModels as ModelId[],
      apiKeys,
      context,
      adaptivePlan?.promptOverrides
    );
    if (adaptivePlan) {
      const successfulModels = results.filter((r) => r.status === "ok" || r.status === "substituted").length;
      const failedModels = results.length - successfulModels;
      const totalTokens = results.reduce((sum, r) => sum + (r.tokenUsage?.totalTokens || 0), 0);
      trackPanelExecutionCompleted(uid, adaptivePlan.classification, {
        status: failedModels === 0 ? "completed" : successfulModels === 0 ? "failed" : "partial",
        successfulModels,
        failedModels,
        totalTokens,
      });
    }
  } catch (panelError: any) {
    // CRITICAL: Even if runPanel throws (shouldn't happen with Promise.allSettled),
    // we still need to finalize tokens for any results we got before the error
    // Create error results for all selected models that don't have results yet
    logger.error("[run-panel] runPanel threw unexpectedly", { error: panelError });
    // Pairs with panel_execution_started above — an orchestration-level
    // throw (not runPanel's normal per-model failure absorption) must
    // still get a terminal analytics event, never an orphaned "started".
    if (adaptivePlan) {
      trackPanelExecutionFailed(uid, adaptivePlan.classification, panelError?.message || "Panel execution failed");
    }

    // If we have no results yet, create error results for all models
    // This ensures completeRun can still process token accounting
    if (!results || results.length === 0) {
      results = selectedModels.map(modelId => ({
        modelId,
        status: "error" as const,
        rawText: null,
        errorMessage: panelError?.message || "Panel execution failed",
        latencyMs: 0,
        tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
      }));
    } else {
      // If we have some results, ensure all selected models are represented
      const resultModelIds = new Set(results.map(r => r.modelId));
      const missingModels = selectedModels.filter(id => !resultModelIds.has(id));
      missingModels.forEach(modelId => {
        results.push({
          modelId,
          status: "error" as const,
          rawText: null,
          errorMessage: panelError?.message || "Panel execution failed",
          latencyMs: 0,
          tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
        });
      });
    }

    // Mark run as error
    try {
      await markRunError(runId, panelError?.message || "Panel execution failed");
    } catch (markError: any) {
      logger.error("[run-panel] Failed to mark run as error", { error: markError });
    }

    // DO NOT re-throw - we still want to finalize tokens and return results
    // The outer catch will handle any errors in finalization
  }

  // ============================================
  // SAVE TOKEN USAGE
  // CRITICAL: This block ALWAYS runs, even if runPanel threw
  // ============================================

  /**
   * Helper to extract total tokens from a model result robustly
   * Tries multiple extraction methods to handle different provider response formats
   */
  const getTotalTokens = (result: any): number => {
    // Method 1: Use tokenUsage.totalTokens if present
    if (result.tokenUsage?.totalTokens !== undefined && typeof result.tokenUsage.totalTokens === "number") {
      return result.tokenUsage.totalTokens;
    }

    // Method 2: Try OpenAI-like format
    if (result.rawResponse?.usage?.total_tokens !== undefined && typeof result.rawResponse.usage.total_tokens === "number") {
      return result.rawResponse.usage.total_tokens;
    }

    // Method 3: Try Gemini format
    if (result.rawResponse?.response?.usageMetadata?.totalTokenCount !== undefined && typeof result.rawResponse.response.usageMetadata.totalTokenCount === "number") {
      return result.rawResponse.response.usageMetadata.totalTokenCount;
    }

    // Method 4: Try direct usageMetadata (if passed directly)
    if (result.rawResponse?.usageMetadata?.totalTokenCount !== undefined && typeof result.rawResponse.usageMetadata.totalTokenCount === "number") {
      return result.rawResponse.usageMetadata.totalTokenCount;
    }

    return 0;
  };

  let totalTokens = 0;
  let panelResultsPublic: PanelResultPublic[] = []; // Declare outside try block for response
  let panelGovernanceStatus: "approved" | "needs_review" | "blocked" | undefined;
  try {
    // CRITICAL: Convert results to public format and compute token usage BEFORE calling completeRun
    // This ensures token usage is computed once and passed in (no recomputation in completeRun)
    const computedPanelResultsPublic = results.map((result) => {
    // Determine canonical text - sanitize rawText (this is the FULL text for UI display)
    // CRITICAL: This is the full, untruncated text for UI display - never truncated here
    // We keep fullText (for UI) and synthesisText (truncated for synthesis) separate
    const canonicalText = sanitizeModelText(result.rawText);

    // Compute synthesis truncation metadata (for flag only, text is NOT returned)
    // The truncated text is computed separately in synthesize-panel API when needed
    // This flag is just for UI reference/display purposes
    const { wasTruncated: wasTruncatedForSynthesis } = truncateForSynthesis(canonicalText, MAX_CHARS_SYNTHESIS_PER_MODEL);

    // Diagnostics: Log text lengths (dev-only, no content)
    // Special diagnostics for Perplexity to track response completeness
    const isDebugMode = process.env.NODE_ENV !== "production" || process.env.DEBUG_LOGS !== "false";
    if (isDebugMode) {
      const logData: any = {
        provider: result.modelId,
        fullTextLength: canonicalText.length,
        synthesisTextLength: wasTruncatedForSynthesis ? MAX_CHARS_SYNTHESIS_PER_MODEL : canonicalText.length,
        wasTruncatedForSynthesis,
        wasStorageCapped: false, // Storage capping happens in completeRun, not here
      };

      // For Perplexity: log additional diagnostics
      if (result.modelId === "perplexity") {
        logData.finishReason = (result as any)?.finishReason || null;
        logData.wasTruncatedByAPI = (result as any)?.wasTruncated || false;
        logData.hasAllSections = canonicalText.includes("# Summary") &&
                                  canonicalText.includes("# Key Claims") &&
                                  (canonicalText.includes("# Evidence") || canonicalText.includes("# Evidence and Reasoning")) &&
                                  (canonicalText.includes("# Uncertainties") || canonicalText.includes("# Uncertainties and Disagreements"));
      }

      logger.debug(`[run-panel] Text processing for ${result.modelId}`, logData);
    }

      // Normalize tokens - pass rawResponse and fallback tokenUsage if available
      const tokenUsageNormalized = normalizeTokens(
        result.modelId,
        result.rawResponse || result,
        result.tokenUsage ? {
          promptTokens: result.tokenUsage.promptTokens ?? undefined,
          completionTokens: result.tokenUsage.completionTokens ?? undefined,
          totalTokens: result.tokenUsage.totalTokens,
        } : undefined
      );

      const raw: Record<string, unknown> = {
        modelId: result.modelId,
        status: result.status,
        rawTextFull: canonicalText,
        latencyMs: result.latencyMs,
        tokenUsage: tokenUsageNormalized,
        wasTruncatedForSynthesis,
        wasTruncated: result.wasTruncated || (result as any)?.finishReason === "length",
        requestedModel: result.requestedModel,
        provider: result.provider,
        actualModel: result.actualModel,
        substitutedFrom: result.substitutedFrom,
        substitutionReason: result.substitutionReason,
      };

      if ((result as any)?.finishReason) {
        raw.finishReason = (result as any).finishReason;
      }

      if (result.errorMessage) {
        raw.error = { message: result.errorMessage };
      }

      const publicResult = normalizeModelResultPublic(raw as any) as unknown as PanelResultPublic;
      assertPublicStatus(publicResult.status, `run-panel:${publicResult.modelId}`);
      return publicResult;
    });

    // Assign to outer variable for use in response
    panelResultsPublic = computedPanelResultsPublic;

    // Compute token usage for completeRun from normalized results
    // Include substituted results since they contain valid text
    const okResults = computedPanelResultsPublic.filter(r => (r.status === "ok" || r.status === "substituted") && r.tokenUsage);
    const tokenUsageByModel = okResults.map(r => ({
      modelId: r.modelId,
      tokenUsage: r.tokenUsage,
    }));

    const tokenTotals = tokenUsageByModel.reduce(
      (acc, r) => {
        acc.promptTokens += r.tokenUsage.promptTokens || 0;
        acc.completionTokens += r.tokenUsage.completionTokens || 0;
        acc.totalTokens += r.tokenUsage.totalTokens || 0;
        acc.reasoningTokens = (acc.reasoningTokens || 0) + (r.tokenUsage.reasoningTokens || 0);
        return acc;
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 as number | undefined }
    );

    // Remove reasoningTokens if 0 for cleanliness
    if (!tokenTotals.reasoningTokens) {
      delete (tokenTotals as any).reasoningTokens;
    }

    // Complete run with pre-computed token usage
    const { totalTokens: runTotalTokens, tokensByProvider } = await completeRun({
      runId,
      userId: uid,
      results,
      question: trimmedQuestion,
      selectedModels,
      tokenUsageByModel,
      tokenTotals,
    });

    // Org governance for research runs runs after synthesis (see /api/synthesize-panel)
    // so consensus score and evidence quality are available.

    // Use tokenTotals.totalTokens (from passed-in data)
    const { safeNum } = await import("@/lib/tokenExtraction");
    totalTokens = safeNum(tokenTotals.totalTokens);

    // Final NaN check before Firestore increment
    if (!Number.isFinite(totalTokens) || totalTokens < 0) {
      logger.error(`[run-panel] CRITICAL: totalTokens is invalid for run`, {
        runId,
        totalTokens,
        runTotalTokens,
        tokensByProvider,
        resultsCount: results.length,
      });
      totalTokens = 0; // Set to 0 to prevent NaN in Firestore increment
    }

    // Log token summary (debug level - verbose details)
    logger.debug(`[run-panel] Token extraction complete for run`, {
      runId,
      totalTokens,
      tokensByProvider,
      resultsCount: results.length,
      successfulResults: results.filter(r => r.status === "ok" || r.status === "substituted").length,
      resultsWithTokenUsage: results.filter(r => (r.status === "ok" || r.status === "substituted") && r.tokenUsage).length,
      rawTotalTokens: runTotalTokens,
      tokenBreakdown: results
        .filter(r => (r.status === "ok" || r.status === "substituted") && r.tokenUsage)
        .map(r => ({
          modelId: r.modelId,
          totalTokens: r.tokenUsage?.totalTokens ?? 0,
          promptTokens: r.tokenUsage?.promptTokens,
          completionTokens: r.tokenUsage?.completionTokens,
        })),
    });

    // Increment user's token counter
    // Always call incrementUserTokenUsage, even if totalTokens is 0, to ensure field exists
    // The function handles 0 tokens gracefully (initializes field if missing)

    // CRITICAL: Log detailed info before increment, especially when Gemini is included
    const hasGemini = selectedModels.includes("gemini");
    const geminiResult = results.find(r => r.modelId === "gemini");
    const geminiTokens = geminiResult?.tokenUsage?.totalTokens ?? 0;

    const succeededResults = results.filter(r => r.status === "ok" || r.status === "substituted");
    const hasSuccessfulModels = succeededResults.length > 0;
    const succeededModelIds = succeededResults.map(r => r.modelId);

    // Debug: detailed token increment preparation (verbose logging)
    logger.debug(`[run-panel] About to call incrementUserTokenUsage`, {
      runId,
      totalTokens,
      isFinite: Number.isFinite(totalTokens),
      selectedModels,
      hasGemini: selectedModels.includes("gemini"),
      geminiTokens: results.find(r => r.modelId === "gemini")?.tokenUsage?.totalTokens ?? 0,
      tokensByProvider,
      resultsCount: results.length,
      successfulResults: succeededResults.length,
      tokenBreakdown: results
        .filter(r => r.status === "ok" || r.status === "substituted")
        .map(r => ({
          modelId: r.modelId,
          totalTokens: r.tokenUsage?.totalTokens ?? 0,
          hasTokenUsage: !!r.tokenUsage,
        })),
      willIncrement: hasSuccessfulModels && totalTokens >= 0,
    });

    // CRITICAL: Call Firestore increment BEFORE returning the response and await it
    // Only increment if we have at least one successful model
    if (succeededModelIds.length > 0 && totalTokens >= 0) {
      try {
        // Production: log token increment (high-value info)
        logger.info(`[run-panel] Incrementing token usage`, {
          runId,
          totalTokens,
          succeededModels: succeededModelIds.length,
          totalModels: results.length,
        });

        const tokenResult = await incrementUserTokenUsage(uid, totalTokens);

        // Debug: Verify the update by reading back from Firestore (verbose)
        logger.debug(`[run-panel] Token usage update verified`, {
          runId,
          tokensAdded: totalTokens,
          tokensUsedCurrentPeriod: tokenResult.tokensUsedCurrentPeriod,
          periodStart: tokenResult.periodStart.toISOString(),
          tokensByProvider,
        });
      } catch (incrementError: any) {
        // CRITICAL: Log increment error with full context
        // This error is being caught and not re-thrown, so the increment silently fails
        logger.error(`[run-panel] incrementUserTokenUsage FAILED`, {
          runId,
          error: incrementError?.message,
          totalTokens,
          isFinite: Number.isFinite(totalTokens),
          isNaN: Number.isNaN(totalTokens),
          errorName: incrementError?.name,
          errorCode: incrementError?.code,
        });
        // Don't throw - token tracking is for analytics, not critical for execution
        // But log it prominently so we can debug
        // NOTE: The increment did NOT happen - tokensUsedCurrentPeriod was NOT updated
      }
    } else {
      // No successful models or totalTokens < 0 - log and skip increment
      logger.debug(`[run-panel] Skipping token increment`, {
        runId,
        succeededModelIds: succeededModelIds.length,
        totalTokens,
      });
    }
  } catch (tokenError: any) {
    // Log but don't fail - token tracking is for analytics, not critical for execution
    logger.error("[run-panel] Failed to save token usage", {
      error: tokenError?.message,
      runId,
    });
  }

  // CRITICAL: Convert results to public format (strip rawResponse, normalize tokens)
  // This is the fallback if token tracking failed - still need to return results
  // Only compute if not already computed in try block
  if (panelResultsPublic.length === 0) {
    panelResultsPublic = results.map((result) => {
    // Determine canonical text - sanitize rawText (this is the FULL text for UI display)
    const canonicalText = sanitizeModelText(result.rawText);

    // Compute synthesis truncation (for internal use, not returned to client)
    // This is only used if synthesize-panel is called, and it truncates internally
    const { wasTruncated: wasTruncatedForSynthesis } = truncateForSynthesis(canonicalText, MAX_CHARS_SYNTHESIS_PER_MODEL);

    // Normalize tokens - pass rawResponse and fallback tokenUsage if available
    const tokenUsageNormalized = normalizeTokens(
      result.modelId,
      result.rawResponse || result,
      result.tokenUsage ? {
        promptTokens: result.tokenUsage.promptTokens ?? undefined,
        completionTokens: result.tokenUsage.completionTokens ?? undefined,
        totalTokens: result.tokenUsage.totalTokens,
      } : undefined
    );

    const raw2: Record<string, unknown> = {
      modelId: result.modelId,
      status: result.status,
      rawTextFull: canonicalText,
      latencyMs: result.latencyMs,
      tokenUsage: tokenUsageNormalized,
      wasTruncatedForSynthesis,
      wasTruncated: result.wasTruncated,
      requestedModel: result.requestedModel,
      provider: result.provider,
      actualModel: result.actualModel,
      substitutedFrom: result.substitutedFrom,
      substitutionReason: result.substitutionReason,
    };

    if (result.errorMessage) {
      raw2.error = { message: result.errorMessage };
    }

    const publicResult = normalizeModelResultPublic(raw2 as any) as unknown as PanelResultPublic;
    assertPublicStatus(publicResult.status, `run-panel-fallback:${publicResult.modelId}`);

    // Server-only debug: log compact debug summary if flag is set
    const debugRawResponse = process.env.PANEL_DEBUG_RAW === "true" ||
                              debugRawResponseRequested === true;
    if (debugRawResponse) {
      const rawResponse = result.rawResponse;
      logger.debug(`[run-panel] rawResponse for ${result.modelId}`, {
        modelId: result.modelId,
        usage: rawResponse?.usage || rawResponse?.response?.usageMetadata,
        contentPreview: canonicalText.substring(0, 200),
        fullTextLength: canonicalText.length,
      });
      // Never persist or return rawResponse
    }

    return publicResult;
    });
  }

  // On success, return a consistent JSON payload with usage information.
  // CRITICAL: Return public results only (no rawResponse)
  // Normalize results to include both rawTextFull and rawText for backward compatibility
  const normalizedResults = panelResultsPublic.map((r) => {
    const textFull = r.rawTextFull || (r as any).rawText || "";
    return {
      ...r,
      rawTextFull: textFull, // Always include rawTextFull
      rawText: (r as any).rawText || textFull, // Include rawText as alias for backward compatibility
    };
  });

  logger.debug("[run-panel] Public results count", { count: normalizedResults.length });

  // ============================================
  // ADAPTIVE RESULT SCHEMA — VALIDATION + CLAIM ALIGNMENT (flag-gated)
  // ============================================
  let adaptivePayload: OrdinaryRunAdaptivePayload | null = null;

  if (adaptivePlan) {
    try {
      const adaptiveOutput = await finalizeAdaptiveRun(
        adaptivePlan.schema,
        results,
        trimmedQuestion,
        {
          apiKeys,
          promptOverrides: adaptivePlan.promptOverrides,
          context,
        },
        adaptivePlan.classification
      );
      adaptivePayload = {
        classification: adaptivePlan.classification,
        schemaId: adaptiveOutput.schemaId,
        results: adaptiveOutput.adaptiveResults,
        alignedClaims: adaptiveOutput.alignedClaims,
        gate: adaptiveOutput.gate,
        synthesisReport: adaptiveOutput.synthesisReport,
        trustSummary: adaptiveOutput.trustSummary,
        rankedEnumeration: adaptiveOutput.rankedEnumeration,
        comparisonMatrix: adaptiveOutput.comparisonMatrix,
        definitionExplanation: adaptiveOutput.definitionExplanation,
        causalExplanation: adaptiveOutput.causalExplanation,
        checklistTaxonomy: adaptiveOutput.checklistTaxonomy,
        deepResearch: adaptiveOutput.deepResearch,
        evidenceReview: adaptiveOutput.evidenceReview,
        biasBlindspotAudit: adaptiveOutput.biasBlindspotAudit,
        decisionSupport: adaptiveOutput.decisionSupport,
        adaptiveOutput: adaptiveOutput.persistedOutput,
        persistenceStatus: "not_applicable",
        // Adaptive Synthesis Report, Phase 1 — top-level so the client
        // never needs to reach into `.adaptiveOutput` (undefined for the
        // original-9/factual_lookup family, which has no persisted
        // envelope at all). Falls back to "now" for that family only —
        // the run genuinely did just complete at response-build time.
        generatedAt: adaptiveOutput.persistedOutput?.generatedAt ?? new Date().toISOString(),
        meta: adaptiveOutput.persistedOutput?.meta,
      };

      // Phase 2 pilot history-reload fix — additive persistence, same
      // request, after finalization succeeded. Only ever populated for
      // schema.id === "procedural" (see orchestrate.ts's
      // attachLegacyAdaptiveEnvelope) — every other schema's
      // adaptiveOutput.persistedLegacyOutput is undefined and this block
      // never runs. Deliberately independent of the persistedOutput
      // block below: a separate Firestore field, a separate try/catch, a
      // separate failure mode that never touches persistenceStatus or
      // governance (procedural has no GovernanceRecordV1 — unchanged by
      // this fix). A write failure here NEVER fails the run response:
      // the live payload above was already computed in memory and is
      // returned either way.
      if (adaptiveOutput.persistedLegacyOutput) {
        try {
          const legacyOutcome = await persistLegacyAdaptiveOutput(runId, adaptiveOutput.persistedLegacyOutput);
          if (!legacyOutcome.saved) {
            logger.warn("[run-panel] legacyAdaptiveOutput persistence did not save", {
              runId,
              schemaId: adaptiveOutput.schemaId,
              reason: legacyOutcome.reason,
            });
          }
        } catch (legacyPersistError: any) {
          logger.warn("[run-panel] legacyAdaptiveOutput persistence threw, run response unaffected", {
            runId,
            schemaId: adaptiveOutput.schemaId,
            error: legacyPersistError?.message,
          });
        }
      }

      // Query-Routing Redesign, Phase 1 — additive persistence, same
      // request, after finalization succeeded. Only applies to the 9
      // active Milestone 2 schemas (persistedOutput is undefined for the
      // 10 legacy-active schemas, which keep their existing persistence
      // path unchanged — see orchestrate.ts's attachAdaptiveEnvelope).
      // A write failure here NEVER fails the run response: the live
      // adaptiveOutput was already computed in memory and is returned
      // either way, just with persistenceStatus reflecting what happened.
      if (adaptiveOutput.persistedOutput) {
        try {
          const outcome = await persistAdaptiveOutput(runId, adaptiveOutput.persistedOutput);
          adaptivePayload.persistenceStatus = outcome.saved
            ? "saved"
            : outcome.reason === "oversized"
              ? "omitted_size_limit"
              : "failed";
          if (!outcome.saved) {
            logger.warn("[run-panel] adaptiveOutput persistence did not save", { runId, schemaId: adaptiveOutput.schemaId, reason: outcome.reason });
          }
        } catch (persistError: any) {
          adaptivePayload.persistenceStatus = "failed";
          logger.warn("[run-panel] adaptiveOutput persistence threw, run response unaffected", {
            runId,
            schemaId: adaptiveOutput.schemaId,
            error: persistError?.message,
          });
        }

        // ============================================
        // QUERY-ROUTING REDESIGN, PHASE 2A, STEP 5C — GOVERNANCE INITIALIZATION
        // ============================================
        // Governance requires the durable adaptiveOutput envelope to exist
        // first (Objective #8) — only attempted when the write above
        // actually succeeded, never from the in-memory result alone.
        // Never rerun models/classification, never touches quota or token
        // finalization (both already happened earlier in this same
        // request), and a failure here can never suppress the adaptive
        // answer already assembled on `adaptivePayload` above.
        // Query-Routing Redesign, Phase 2A, Step 6B, Part C — captured
        // only for the 3 statuses where a real GovernanceRecordV1 is
        // available to evaluate against (created/already_exists/
        // blocked_reviewed). Left undefined for every other status
        // (not_applicable/malformed_existing_record/unsupported_existing_version/
        // omitted_size_limit/failed), so the automated-governance block
        // below naturally never runs for them — `automatedGovernanceStatus`
        // stays omitted from the response entirely, per the response
        // contract's own "evaluation not applicable" rule.
        let initResultForAutomatedGovernance: GovernanceInitializationResult | undefined;

        if (adaptivePayload.persistenceStatus !== "saved") {
          adaptivePayload.governanceInitializationStatus = "skipped_adaptive_not_saved";
        } else {
          try {
            const existingRead = await readGovernanceRecordForInitialization(runId);
            switch (existingRead.status) {
              case "found":
              case "absent": {
                // The critical safety rule (Part C5): a failed read, and a
                // MISSING RUN, are NOT the same as an absent record.
                // `undefined` is only ever passed here when the read
                // POSITIVELY confirmed the run document exists and simply
                // has no governanceRecord field yet — never as a stand-in
                // for "the read didn't work" or "the run doesn't exist."
                const initResult = await initializeAdaptiveGovernanceRecord({
                  runId,
                  adaptiveOutput: adaptiveOutput.persistedOutput,
                  existingGovernanceRecord: existingRead.status === "found" ? existingRead.value : undefined,
                });
                adaptivePayload.governanceInitializationStatus = initResult.status;
                if (
                  initResult.status === "created" ||
                  initResult.status === "already_exists" ||
                  initResult.status === "blocked_reviewed"
                ) {
                  initResultForAutomatedGovernance = initResult;
                }
                break;
              }
              case "run_missing":
              case "firestore_unavailable":
              case "read_failed":
              default: {
                // Never call the initializer here. For "run_missing"
                // specifically: persistGovernanceRecord()'s
                // .set(..., {merge:true}) would CREATE a document if none
                // exists — passing `undefined` through in this case could
                // produce an orphan runs/{runId} doc containing nothing
                // but a governanceRecord field. Fail safe instead.
                adaptivePayload.governanceInitializationStatus = "failed";
                logger.warn("[run-panel] Could not confirm existing governanceRecord state before initialization, skipping", {
                  runId,
                  schemaId: adaptiveOutput.schemaId,
                  readStatus: existingRead.status,
                });
              }
            }
          } catch (governanceError: unknown) {
            adaptivePayload.governanceInitializationStatus = "failed";
            logger.warn("[run-panel] Governance initialization threw, run response unaffected", {
              runId,
              schemaId: adaptiveOutput.schemaId,
            });
          }
        }

        // ============================================
        // QUERY-ROUTING REDESIGN, PHASE 2A, STEP 6B, PART C — ADAPTIVE
        // AUTOMATED GOVERNANCE
        // ============================================
        // Runs only when a real GovernanceRecordV1 was captured above AND
        // it has no automatedGovernance yet (never automatically
        // re-evaluates an existing result — re-evaluation is a future,
        // explicit operation, not this lifecycle's job). Never reruns
        // models/classification/synthesis, never touches quota or token
        // finalization (both already happened earlier in this same
        // request), and every failure here is caught and left
        // subordinate to the adaptive answer already assembled on
        // `adaptivePayload` — nothing in this block can change the HTTP
        // response's success status or remove any field already set.
        if (initResultForAutomatedGovernance?.record) {
          const record: GovernanceRecordV1 = initResultForAutomatedGovernance.record;
          if (record.automatedGovernance) {
            // already_exists/blocked_reviewed with a prior automated
            // result — return it as-is, never re-evaluate.
            adaptivePayload.automatedGovernanceStatus = record.automatedGovernance.status;
          } else if (
            typeof adaptiveOutput.commonResponseMeta?.failedModels !== "number" ||
            typeof adaptiveOutput.commonResponseMeta?.successfulModels !== "number"
          ) {
            // No real model-health data to evaluate against — never
            // fabricate counts (e.g. defaulting to 0). Field stays
            // omitted (no status set). Not expected in practice for an
            // execution response — commonResponseMeta.ts always
            // populates both counts once a schema actually ran — but
            // both fields are optional on the type, so this is checked
            // rather than assumed.
            logger.warn("[run-panel] Skipping adaptive automated governance: no usable model-health counts available", {
              runId,
              schemaId: adaptiveOutput.schemaId,
            });
          } else {
            const failedModels = adaptiveOutput.commonResponseMeta.failedModels;
            const successfulModels = adaptiveOutput.commonResponseMeta.successfulModels;
            try {
              const evaluatedAt = new Date().toISOString();
              const policy = await loadGovernancePolicy();
              const automatedGovernance = evaluateAdaptiveGovernance({
                governanceRecord: record,
                policy,
                modelFailureCount: failedModels,
                successfulModelCount: successfulModels,
                evaluatedAt,
              });

              const updateResult = applyAutomatedGovernanceUpdate(record, automatedGovernance, evaluatedAt);
              if (!updateResult.ok) {
                adaptivePayload.automatedGovernanceStatus = "error";
                logger.warn("[run-panel] Adaptive automated governance update rejected before persistence", {
                  runId,
                  schemaId: adaptiveOutput.schemaId,
                  reason: updateResult.reason,
                });
              } else {
                const persistOutcome = await persistAutomatedGovernanceUpdate(runId, automatedGovernance, evaluatedAt);
                if (!persistOutcome.saved) {
                  adaptivePayload.automatedGovernanceStatus = "error";
                  logger.warn("[run-panel] Adaptive automated governance persistence did not save", {
                    runId,
                    schemaId: adaptiveOutput.schemaId,
                    reason: persistOutcome.reason,
                  });
                } else {
                  // Persisted successfully — the evaluator's own status is
                  // the one returned. An event-write failure below never
                  // changes this: it does not roll back the already-saved
                  // automatedGovernance, and it is not a reason to report
                  // "error" for a governance result that genuinely saved.
                  adaptivePayload.automatedGovernanceStatus = automatedGovernance.status;
                  try {
                    const eventOutcome = await writeAdaptiveGovernanceEvent(runId, automatedGovernance, evaluatedAt);
                    if (!eventOutcome.written) {
                      logger.warn("[run-panel] Adaptive governanceEvents write did not save (automatedGovernance itself is unaffected)", {
                        runId,
                        schemaId: adaptiveOutput.schemaId,
                        reason: eventOutcome.reason,
                      });
                    }
                  } catch (eventError: unknown) {
                    logger.warn("[run-panel] Adaptive governanceEvents write threw (automatedGovernance itself is unaffected)", {
                      runId,
                      schemaId: adaptiveOutput.schemaId,
                    });
                  }
                }
              }
            } catch (automatedGovernanceError: unknown) {
              adaptivePayload.automatedGovernanceStatus = "error";
              logger.warn("[run-panel] Adaptive automated governance evaluation failed, run response unaffected", {
                runId,
                schemaId: adaptiveOutput.schemaId,
              });
            }
          }

          // ============================================
          // QUERY-ROUTING REDESIGN, PHASE 2A, STEP 7, PART C — ADAPTIVE
          // TEAM-REVIEW QUEUE PROJECTION (creation only — no review
          // decision capability exists yet; see
          // docs/governance-decision-receipts-design.md §21)
          // ============================================
          // Runs after automated governance has resolved one way or
          // another (adaptivePayload.automatedGovernanceStatus reflects
          // whichever branch above set it, including "error"/undefined).
          // Never calls applyTeamGovernancePipeline()/policyEngine.ts —
          // every legacy team-policy rule requires a ConsensusSummary no
          // adaptive schema produces (§20.5). Never re-runs models,
          // classification, or automated governance itself. A failure
          // anywhere in this block is caught and left subordinate to the
          // adaptive answer already assembled on `adaptivePayload`.
          try {
            const teamCtx = await loadUserAndTeam(uid);
            if (!teamCtx?.team) {
              adaptivePayload.adaptiveTeamReviewProjectionStatus = "disabled";

              // Reviewer Assignment Propagation — the personal (non-team)
              // equivalent of the team projection/assignment path below.
              // Gated on "created" specifically (not "already_exists" or
              // "blocked_reviewed"): a genuinely NEW governance record,
              // exactly once per run, never on reload/retry. See
              // lib/governance/personalReviewerAssignment.ts for why this
              // exists and what it does and does not do.
              if (initResultForAutomatedGovernance.status === "created") {
                try {
                  const propagationResult = await propagatePersonalReviewerAssignment({ runId, ownerUserId: uid });
                  adaptivePayload.personalReviewerAssignmentStatus = propagationResult.status;
                } catch (personalAssignError: unknown) {
                  adaptivePayload.personalReviewerAssignmentStatus = "failed";
                  logger.warn("[run-panel] Personal reviewer-assignment propagation threw, run response unaffected", {
                    runId,
                    schemaId: adaptiveOutput.schemaId,
                  });
                }
              }
            } else {
              const routingResult = routeAdaptiveTeamReview({
                humanReviewNeeded: record.decisionReceipt.humanReviewNeeded,
                automatedGovernanceStatus: adaptivePayload.automatedGovernanceStatus,
                settings: teamCtx.team.adaptiveReviewSettings,
              });

              if (!routingResult.shouldCreateProjection) {
                adaptivePayload.adaptiveTeamReviewProjectionStatus = routingResult.reason === "disabled" ? "disabled" : "not_eligible";
              } else {
                const nowIso = new Date().toISOString();
                const projection = buildAdaptiveTeamRunProjection({
                  teamId: teamCtx.team.id,
                  userId: uid,
                  runId,
                  // GovernanceRecordV1.schemaId is typed as the broader
                  // QueryType, but a record only ever exists for one of
                  // the 9 Milestone-2 schemas (governanceRecord.ts's own
                  // contract) — the same narrowing every other adaptive
                  // governance function in this file already performs.
                  schemaId: record.schemaId as PersistedAdaptiveSchemaId,
                  answerShape: record.answerShape,
                  receiptConclusion: record.decisionReceipt.conclusion,
                  sourceBacked: record.decisionReceipt.sourceBacked,
                  humanReviewNeeded: record.decisionReceipt.humanReviewNeeded,
                  automatedGovernanceStatus: adaptivePayload.automatedGovernanceStatus,
                  humanReviewStatus: record.humanReview.status,
                  now: nowIso,
                });

                const createResult = await createAdaptiveTeamRunProjection(projection);
                if (createResult.status === "created" || createResult.status === "already_exists") {
                  adaptivePayload.adaptiveTeamReviewProjectionStatus = createResult.status;
                } else {
                  adaptivePayload.adaptiveTeamReviewProjectionStatus = "failed";
                  logger.warn("[run-panel] Adaptive team-review projection creation did not save", {
                    runId,
                    schemaId: adaptiveOutput.schemaId,
                    reason: createResult.status,
                  });
                }
              }
            }
          } catch (teamReviewError: unknown) {
            adaptivePayload.adaptiveTeamReviewProjectionStatus = "failed";
            logger.warn("[run-panel] Adaptive team-review projection routing/creation threw, run response unaffected", {
              runId,
              schemaId: adaptiveOutput.schemaId,
            });
          }
        }

        // Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
        // §4.1) — compact fields for the top summary bar's "Status".
        // `humanReview` mirrors the exact same shape GET /api/user/runs/[runId]
        // now returns on reload (never reviewer name/comment text — same
        // discipline as humanReviewHistory). `reviewRouting` is derived from
        // the SAME adaptiveTeamReviewProjectionStatus this block just set,
        // not re-computed independently — one source of truth.
        if (initResultForAutomatedGovernance?.record?.humanReview) {
          adaptivePayload.humanReview = {
            status: initResultForAutomatedGovernance.record.humanReview.status,
            conditions: initResultForAutomatedGovernance.record.humanReview.conditions,
            decidedVia: initResultForAutomatedGovernance.record.humanReview.decidedVia,
          };
        }
        adaptivePayload.reviewRouting =
          adaptivePayload.adaptiveTeamReviewProjectionStatus === "created" ||
          adaptivePayload.adaptiveTeamReviewProjectionStatus === "already_exists" ||
          // A personal account with a canonical assignment now in place
          // (fresh this request, or already present from an earlier
          // request) is exactly as "routed for review" as a team run
          // with a queue projection — reuses the same "in_queue" value
          // and label (Reviewer Assignment Propagation, Step 17)
          // deliberately, rather than inventing a second one.
          adaptivePayload.personalReviewerAssignmentStatus === "assigned" ||
          adaptivePayload.personalReviewerAssignmentStatus === "already_assigned"
            ? "in_queue"
            : adaptivePayload.adaptiveTeamReviewProjectionStatus === "disabled" ||
                adaptivePayload.adaptiveTeamReviewProjectionStatus === "not_eligible"
              ? "not_configured"
              : "unknown";
      }

      if (adaptiveOutput.rankedEnumeration?.shortfallNote && adaptiveOutput.rankedEnumeration.requestedCount != null) {
        trackRankedListShortfall(
          uid,
          adaptivePlan.classification,
          adaptiveOutput.rankedEnumeration.requestedCount,
          adaptiveOutput.rankedEnumeration.actualCount
        );
      }
      if (adaptiveOutput.comparisonMatrix) {
        const subjectCount = adaptiveOutput.comparisonMatrix.subjects.length + adaptiveOutput.comparisonMatrix.lowConfidenceSubjects.length;
        if (subjectCount < 2) {
          trackComparisonMatrixGap(
            uid,
            adaptivePlan.classification,
            subjectCount,
            adaptiveOutput.comparisonMatrix.attributes.length + adaptiveOutput.comparisonMatrix.lowConfidenceAttributes.length
          );
        }
      }
      if (adaptiveOutput.definitionExplanation?.isAmbiguous) {
        trackDefinitionAmbiguity(
          uid,
          adaptivePlan.classification,
          1 + adaptiveOutput.definitionExplanation.alternateInterpretations.length
        );
      }
      if (adaptiveOutput.causalExplanation) {
        const noDirectCauses = !adaptiveOutput.causalExplanation.factors.some((f) => f.category === "direct_cause");
        const unresolvedDisputes = adaptiveOutput.causalExplanation.disputedInterpretations.length > 1;
        if (noDirectCauses) {
          trackCausalExplanationGap(uid, adaptivePlan.classification, "no_direct_causes");
        } else if (unresolvedDisputes) {
          trackCausalExplanationGap(uid, adaptivePlan.classification, "unresolved_disputed_interpretations");
        }
      }
      if (adaptiveOutput.checklistTaxonomy) {
        const mainItemCount = adaptiveOutput.checklistTaxonomy.categories.reduce((sum, c) => sum + c.items.length, 0);
        if (mainItemCount === 0 && adaptiveOutput.checklistTaxonomy.lowConfidenceItems.length > 0) {
          trackChecklistTaxonomyGap(uid, adaptivePlan.classification, adaptiveOutput.checklistTaxonomy.lowConfidenceItems.length);
        }
      }
      if (adaptiveOutput.deepResearch) {
        const { sourceCoverage } = adaptiveOutput.deepResearch;
        if (sourceCoverage.totalFindings > 0 && sourceCoverage.findingsWithSources === 0) {
          trackDeepResearchGap(uid, adaptivePlan.classification, "no_sourced_findings");
        } else if (sourceCoverage.totalFindings > 0 && sourceCoverage.coverageRatio < 0.25) {
          trackDeepResearchGap(uid, adaptivePlan.classification, "low_source_coverage");
        }
      }
      if (adaptiveOutput.evidenceReview && (adaptiveOutput.evidenceReview.overallStrength === "weak" || adaptiveOutput.evidenceReview.overallStrength === "contested")) {
        trackEvidenceReviewGap(uid, adaptivePlan.classification, adaptiveOutput.evidenceReview.overallStrength);
      }
      if (adaptiveOutput.biasBlindspotAudit) {
        const { attributedBiases, biasEmptyReason, panelBlindSpots, structuralDiagnostics } = adaptiveOutput.biasBlindspotAudit;
        if (attributedBiases.length === 0 && biasEmptyReason) {
          trackBiasAuditNoAttribution(uid, adaptivePlan.classification, biasEmptyReason);
        }
        if (panelBlindSpots.length > 0) {
          trackBiasAuditPanelGapFound(uid, adaptivePlan.classification, panelBlindSpots.length);
        }
        if (structuralDiagnostics.homogeneityFlag) {
          trackBiasAuditHomogeneityFlagged(uid, adaptivePlan.classification);
        }
      }
      if (adaptiveOutput.decisionSupport) {
        const { recommendation, sensitivityFindings, uncertainties } = adaptiveOutput.decisionSupport;
        if (recommendation.isContested) {
          trackDecisionSupportContested(uid, adaptivePlan.classification, recommendation.action);
        }
        if (sensitivityFindings.length > 0) {
          trackDecisionSupportHighSensitivity(uid, adaptivePlan.classification, sensitivityFindings.length);
        }
        if (uncertainties.length > 0) {
          trackDecisionSupportMissingCriteria(uid, adaptivePlan.classification, uncertainties.length);
        }
      }
    } catch (adaptiveFinalizeError: any) {
      // Validation/alignment never throw by contract, but guard defensively:
      // a failure here must never take down an otherwise-successful run.
      logger.warn("[run-panel] Adaptive finalize failed, falling back to legacy results only", {
        error: adaptiveFinalizeError?.message,
      });
      adaptivePayload = null;
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      results: normalizedResults,
      runId,
      ...(panelGovernanceStatus ? { governanceStatus: panelGovernanceStatus } : {}),
      ...(adaptivePayload ? { adaptive: adaptivePayload } : {}),
    },
  };
}
