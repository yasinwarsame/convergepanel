/**
 * Firestore Runs Collection Utilities
 * 
 * Handles storing panel runs in Firestore with token usage tracking.
 * 
 * Firestore Schema:
 * runs/{runId}
 *   - userId: string
 *   - question: string
 *   - selectedModels: string[] (ModelId[])
 *   - status: "running" | "complete" | "error"
 *   - createdAt: timestamp
 *   - completedAt?: timestamp
 *   - results: ModelResult[] (stored as JSON)
 *   - totalTokens: number (sum of all provider tokens)
 *   - tokensByProvider: { [providerKey]: number } (e.g., { openai: 1234, anthropic: 5678 })
 *   - promptTokensByProvider?: { [providerKey]: number }
 *   - completionTokensByProvider?: { [providerKey]: number }
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { ModelResult } from "@/lib/types";
import { modelIdToProviderKey, safeNum } from "@/lib/tokenExtraction";
import { Timestamp } from "firebase-admin/firestore";
import { normalizeTokens, ModelTokenUsage, RunTokenTotals, TokenUsageNormalized } from "@/lib/panel/normalizeTokens";
import { sanitizeModelText, truncateForStorage, isDocumentSizeSafe, estimateDocumentSize, MAX_CHARS_STORAGE_PER_MODEL, MAX_TOTAL_DOC_SIZE } from "@/lib/panel/sanitizeText";
import { RunDocument, PanelResultPublic } from "@/lib/panel/schemas";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { AdaptiveHumanReviewHistoryV1 } from "@/lib/governance/adaptiveHumanReviewHistory";
import { AdaptiveHumanReviewAssignmentV1, AdaptiveHumanReviewAssignmentHistoryV1, buildNextAdaptiveHumanReviewAssignment } from "@/lib/governance/adaptiveHumanReviewAssignment";
import {
  AdaptiveHumanReviewPanelV1,
  AdaptiveReviewFinalStatus,
  buildNextAdaptiveHumanReviewPanel,
  buildCancelledAdaptiveHumanReviewPanel,
  buildFinalizedAdaptiveHumanReviewPanel,
  buildOwnerOverriddenAdaptiveHumanReviewPanel,
  parseAdaptiveHumanReviewPanel,
  ELIGIBLE_PANEL_REVIEWER_ROLES,
} from "@/lib/governance/adaptiveHumanReviewPanel";
import {
  AdaptiveHumanReviewVoteV1,
  buildAdaptiveHumanReviewVoteId,
  buildAdaptiveHumanReviewVote,
  parseAdaptiveHumanReviewVote,
  isSemanticallyEquivalentAdaptiveHumanReviewVote,
} from "@/lib/governance/adaptiveHumanReviewVote";
import { AdaptiveReviewDecisionStatus } from "@/lib/governance/adaptiveHumanReviewRequest";
import {
  buildAdaptivePanelFinalDecisionId,
  buildFinalConditionsUnion,
  buildFinalizedMultiReviewerHumanReview,
  AdaptivePanelFinalizationHistoryV1,
} from "@/lib/governance/adaptivePanelFinalization";
import {
  buildAdaptivePanelOverrideDecisionId,
  buildOverriddenMultiReviewerHumanReview,
  AdaptivePanelOverrideHistoryV1,
} from "@/lib/governance/adaptivePanelOverride";
import { aggregateAdaptiveReviewVotes, ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION } from "@/lib/governance/adaptiveReviewAggregation";
import { logAdaptiveGovernanceEvent } from "@/lib/governance/adaptiveGovernanceTelemetry";
import { parseTeamDoc, memberRole } from "@/lib/teams/teamApiAuth";
import {
  parseGovernanceRecord,
  isHumanReviewStatusReviewable,
  applyHumanReviewUpdate,
  HumanReviewUpdate,
  HumanReviewUpdateFailureReason,
  HumanReviewStatus,
} from "@/lib/adaptiveSchema/governanceRecordParser";
import { logger } from "@/lib/logger";

// CRITICAL: Shared safeNum helper for consistency
// This ensures we use the same NaN protection everywhere
// safeNum is already imported from tokenExtraction, but we document it here for clarity

export interface PanelRun {
  userId: string;
  question: string;
  selectedModels: string[];
  status: "running" | "complete" | "error";
  createdAt: Timestamp | Date;
  completedAt?: Timestamp | Date;
  results?: ModelResult[]; // Legacy field - deprecated in favor of resultsCompact
  resultsCompact?: RunDocument; // Compact format without rawResponse
  totalTokens?: number;
  tokensByProvider?: Record<string, number>;
  tokensByModel?: Record<string, number>; // Per-model token breakdown for debugging
  promptTokensByProvider?: Record<string, number>;
  completionTokensByProvider?: Record<string, number>;
  geminiHasUsageMetadata?: boolean; // Audit field: whether Gemini provided usageMetadata (only set if Gemini was selected)
  documentSizeChars?: number; // Document size in chars for monitoring
  wasTruncated?: boolean; // Whether text was truncated to fit Firestore limits
  synthesizedReportV2?: any; // V2 structured synthesis report (SynthesisReportV2 type)
  synthesizedReportVersion?: number; // Version of synthesis report schema (2 for V2)
  synthesizedAt?: Timestamp | Date; // When synthesis was generated
}

/**
 * Create a new run document in Firestore
 * 
 * @param runId - Unique run identifier
 * @param userId - User ID who initiated the run
 * @param question - The question asked
 * @param selectedModels - Array of model IDs selected for this run
 * @returns Promise<void>
 */
export async function createRun(
  runId: string,
  userId: string,
  question: string,
  selectedModels: string[]
): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const runData: Partial<PanelRun> = {
    userId,
    question,
    selectedModels,
    status: "running",
    createdAt: Timestamp.now(),
  };

  await adminDb.collection("runs").doc(runId).set(runData);
  console.log(`[firestore/runs] Created run ${runId} for user ${userId}`);
}

/**
 * Complete run arguments
 */
export type CompleteRunArgs = {
  runId: string;
  userId: string;
  results: ModelResult[];
  question: string;
  selectedModels: string[];
  tokenUsageByModel: ModelTokenUsage[];
  tokenTotals: RunTokenTotals;
};

/**
 * Update run with results and token usage
 * 
 * This function accepts pre-computed token usage and writes it to Firestore.
 * Token usage should be computed in the route handler, not here.
 * 
 * @param args - Complete run arguments including token usage
 * @returns Promise<{ totalTokens: number; tokensByProvider: Record<string, number> }>
 */
export async function completeRun(
  args: CompleteRunArgs
): Promise<{ totalTokens: number; tokensByProvider: Record<string, number> }> {
  const { runId, userId, results, question: questionFromArgs, selectedModels, tokenUsageByModel, tokenTotals } = args;
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  // Initialize question variable (mutable)
  let question = questionFromArgs || "";

  // Build token usage map from passed-in data (no recomputation needed)
  const byModel: Record<string, TokenUsageNormalized> = {};
  for (const m of tokenUsageByModel) {
    byModel[m.modelId] = m.tokenUsage;
  }

  // Build tokensByModel record for backward compatibility
  const tokensByModel: Record<string, number> = {};
  for (const m of tokenUsageByModel) {
    tokensByModel[m.modelId] = m.tokenUsage.totalTokens;
  }
  // Include models that failed (0 tokens)
  for (const result of results) {
    if (!tokensByModel[result.modelId]) {
      tokensByModel[result.modelId] = 0;
    }
  }

  // Compute tokensByProvider for backward compatibility
  const tokensByProvider: Record<string, number> = {};
  const { modelIdToProviderKey } = await import("@/lib/tokenExtraction");
  for (const m of tokenUsageByModel) {
    const providerKey = modelIdToProviderKey(m.modelId);
    if (providerKey) {
      tokensByProvider[providerKey] = (tokensByProvider[providerKey] || 0) + m.tokenUsage.totalTokens;
    }
  }

  // Build compact per-model data (truncated for storage)
  const perModelCompact = results.map((result) => {
    // Use rawTextFull if available (from API response), otherwise rawText (backward compatibility)
    const fullText = (result as any).rawTextFull || result.rawText || "";
    const sanitizedText = sanitizeModelText(fullText);
    
    // Get token usage from passed-in data
    const tokenUsageNormalized = byModel[result.modelId] || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    
    // CRITICAL: Log Gemini specifically to debug 5-model runs (using only in-scope variables)
    if (result.modelId === "gemini") {
      // Compute hasUsageMetadata safely from available data
      const hasUsageMetadata = result.hasUsageMetadata ?? 
        (result.status === "ok" && 
         !!(result.rawResponse?.response?.usageMetadata || result.rawResponse?.usageMetadata));
      
      console.log(`[firestore/runs] 🔍 Gemini token extraction for run ${runId}:`, {
        modelId: result.modelId,
        status: result.status,
        tokenUsageNormalized,
        totalTokens: tokenUsageNormalized.totalTokens,
        promptTokens: tokenUsageNormalized.promptTokens,
        completionTokens: tokenUsageNormalized.completionTokens,
        reasoningTokens: tokenUsageNormalized.reasoningTokens,
        hasTokenUsage: !!tokenUsageNormalized,
        hasUsageMetadata,
        isFinite: Number.isFinite(tokenUsageNormalized.totalTokens),
        isNaN: Number.isNaN(tokenUsageNormalized.totalTokens),
      });
    }
    
    // IMPORTANT: Keep fullText and storageText separate
    // - fullText: Original unmodified text (stored separately if needed, currently only truncated version stored)
    // - rawTextTruncated: Truncated copy for Firestore storage (prevents 1 MiB limit)
    // This ensures Panel Response can show full text from API response, while Firestore stores safe version
    // Note: UI should always use API response (rawTextFull), not Firestore stored version
    const { text: rawTextTruncated, wasTruncated: wasStorageCapped } = truncateForStorage(sanitizedText, MAX_CHARS_STORAGE_PER_MODEL);
    
    // Diagnostics: Log storage truncation (dev-only, no content)
    if (process.env.NODE_ENV !== "production" && process.env.DEBUG_LOGS !== "false") {
      console.log(`[firestore/runs] Storage processing for ${result.modelId} (run ${runId}):`, {
        provider: result.modelId,
        fullTextLength: sanitizedText.length,
        storageTextLength: rawTextTruncated.length,
        wasStorageCapped,
        truncatedBy: sanitizedText.length - rawTextTruncated.length,
      });
    }
    
    return {
      modelId: result.modelId,
      status: result.status,
      rawTextTruncated, // Truncated for storage safety
      latencyMs: result.latencyMs,
      tokenUsage: tokenUsageNormalized,
      wasTruncated: wasStorageCapped, // Flag indicates if storage was capped
    };
  });

  // Retrieve existing run document to get createdAt and question (if missing)
  let createdAt: Timestamp = Timestamp.now();
  try {
    const existingDoc = await adminDb.collection("runs").doc(runId).get();
    if (existingDoc.exists) {
      const existingData = existingDoc.data();
      // Only overwrite question if it's empty and Firestore has one
      if ((!question || question.trim().length === 0) && existingData?.question) {
        question = existingData.question;
      }
      if (existingData?.createdAt) {
        createdAt = existingData.createdAt instanceof Timestamp 
          ? existingData.createdAt 
          : Timestamp.fromDate(existingData.createdAt.toDate());
      }
    }
  } catch (err) {
    console.warn(`[firestore/runs] Could not retrieve existing run document for ${runId}:`, err);
  }

  // Build compact document using RunDocument schema with passed-in token totals
  const compactDoc: RunDocument = {
    runId,
    userId,
    question,
    createdAt: createdAt as any,
    selectedModels,
    perModel: perModelCompact,
    totals: {
      promptTokens: tokenTotals.promptTokens,
      completionTokens: tokenTotals.completionTokens,
      reasoningTokens: tokenTotals.reasoningTokens || 0,
      totalTokens: tokenTotals.totalTokens,
    },
    flags: {
      storageTruncated: false, // Will be set below if needed
      synthesisTruncated: false,
    },
  };

  // Check document size and further truncate if needed
  let finalDoc: RunDocument = compactDoc;
  let storageTruncated = false;
  
  const docSize = estimateDocumentSize(compactDoc);
  if (docSize > MAX_TOTAL_DOC_SIZE) {
    console.warn(`[firestore/runs] Document size ${docSize} exceeds ${MAX_TOTAL_DOC_SIZE} for run ${runId}, applying aggressive truncation`);
    storageTruncated = true;
    
    const reducedMaxChars = Math.floor(MAX_CHARS_STORAGE_PER_MODEL / 2);
    finalDoc = {
      ...compactDoc,
      perModel: compactDoc.perModel.map((model) => {
        const { text: furtherTruncated, wasTruncated } = truncateForStorage(model.rawTextTruncated, reducedMaxChars);
        return {
          ...model,
          rawTextTruncated: furtherTruncated,
          wasTruncated: wasTruncated || model.wasTruncated,
        };
      }),
      flags: {
        ...compactDoc.flags,
        storageTruncated: true,
      },
    };
    
    const newDocSize = estimateDocumentSize(finalDoc);
    if (newDocSize > MAX_TOTAL_DOC_SIZE) {
      const veryReducedMaxChars = Math.floor(reducedMaxChars / 2);
      finalDoc.perModel = finalDoc.perModel.map((model) => {
        const { text: veryTruncated } = truncateForStorage(model.rawTextTruncated, veryReducedMaxChars);
        return {
          ...model,
          rawTextTruncated: veryTruncated,
          wasTruncated: true,
        };
      });
    }
  }

  // Update run document with token usage from parameters
  const updateData: any = {
    status: "complete",
    completedAt: Timestamp.now(),
    runDocument: finalDoc,
    // Store token usage structure
    tokenUsage: {
      byModel,
      totals: tokenTotals,
    },
    // Legacy fields for backward compatibility
    totalTokens: tokenTotals.totalTokens,
    tokensByModel,
    tokensByProvider: Object.keys(tokensByProvider).length > 0 ? tokensByProvider : undefined,
  };

  await adminDb.collection("runs").doc(runId).update(updateData);

  console.log(`[firestore/runs] ✅ Completed run ${runId} with ${tokenTotals.totalTokens} total tokens from ${Object.keys(tokensByProvider).length} provider(s)`);

  return { totalTokens: tokenTotals.totalTokens, tokensByProvider };
}

/**
 * Query-Routing Redesign, Phase 1 — additive persistence for the versioned
 * adaptive output envelope. See docs/adaptive-persistence-design.md for the
 * full design (why this is embedded on the run document rather than a
 * subcollection — the size assessment there showed even the largest
 * schema's worst-case envelope is under 10% of the existing document-size
 * safety budget).
 *
 * Called once, after finalizeAdaptiveRun() succeeds, from the SAME request
 * that already created and completed the run — never a separate retry job,
 * never a second model invocation, never a second quota charge. A write
 * failure here is caught by the caller (app/api/run-panel/route.ts) and
 * must never fail the overall run response — the live adaptiveOutput was
 * already computed in memory and is still returned to the client either way.
 *
 * `reason` is a real discriminator, not a free-form string — the caller
 * (route.ts) maps "oversized" to its own distinct `persistenceStatus:
 * "omitted_size_limit"`, deliberately never collapsed into the same
 * "failed" bucket as a genuine write error. The two mean different things:
 * a write failure is transient/infrastructure (worth alerting on if it
 * recurs); a size-limit omission is an expected, deterministic outcome of
 * this run's own content, and conflating the two would make "failed" both
 * over-broad and under-actionable.
 */
export type AdaptiveOutputPersistenceFailureReason = "firestore_unavailable" | "oversized" | "write_failed";

export async function persistAdaptiveOutput(
  runId: string,
  output: unknown
): Promise<{ saved: true } | { saved: false; reason: AdaptiveOutputPersistenceFailureReason }> {
  if (!adminDb) {
    return { saved: false, reason: "firestore_unavailable" };
  }

  // Same size-safety posture as completeRun()'s perModel truncation: a
  // lower-priority field must never risk the document exceeding Firestore's
  // limit and losing the raw model results/token accounting that already
  // wrote successfully. Omit, don't fail the run, don't throw.
  const estimatedSize = estimateDocumentSize({ adaptiveOutput: output });
  if (estimatedSize > MAX_TOTAL_DOC_SIZE) {
    console.warn(`[firestore/runs] adaptiveOutput for run ${runId} estimated at ${estimatedSize} chars, exceeds safety budget — omitting`);
    return { saved: false, reason: "oversized" };
  }

  try {
    await adminDb.collection("runs").doc(runId).set({ adaptiveOutput: output }, { merge: true });
    return { saved: true };
  } catch (err: unknown) {
    console.warn(`[firestore/runs] Failed to persist adaptiveOutput for run ${runId}:`, (err as Error)?.message);
    return { saved: false, reason: "write_failed" };
  }
}

/**
 * Phase 2 pilot history-reload fix — the `procedural`-only sibling of
 * `persistAdaptiveOutput` above. Writes to a SEPARATE field
 * (`legacyAdaptiveOutput`), never `adaptiveOutput`, so the two envelopes
 * can never collide and every existing `adaptiveOutput` consumer
 * (parsePersistedAdaptiveOutput, governance initialization, etc.) is
 * completely unaffected by this write. Same size-safety posture,
 * deliberately kept consistent rather than "improved" here for the same
 * reason persistGovernanceRecord's doc comment gives for its own copy of
 * this logic.
 */
export async function persistLegacyAdaptiveOutput(
  runId: string,
  output: unknown
): Promise<{ saved: true } | { saved: false; reason: AdaptiveOutputPersistenceFailureReason }> {
  if (!adminDb) {
    return { saved: false, reason: "firestore_unavailable" };
  }

  const estimatedSize = estimateDocumentSize({ legacyAdaptiveOutput: output });
  if (estimatedSize > MAX_TOTAL_DOC_SIZE) {
    console.warn(`[firestore/runs] legacyAdaptiveOutput for run ${runId} estimated at ${estimatedSize} chars, exceeds safety budget — omitting`);
    return { saved: false, reason: "oversized" };
  }

  try {
    await adminDb.collection("runs").doc(runId).set({ legacyAdaptiveOutput: output }, { merge: true });
    return { saved: true };
  } catch (err: unknown) {
    console.warn(`[firestore/runs] Failed to persist legacyAdaptiveOutput for run ${runId}:`, (err as Error)?.message);
    return { saved: false, reason: "write_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part B — additive persistence
 * for `GovernanceRecordV1` (governanceRecord.ts's contract), embedded
 * directly on `runs/{runId}.governanceRecord` — a second, independent
 * additive write, deliberately separate from `persistAdaptiveOutput`
 * above. See docs/governance-decision-receipts-design.md §8/§10 for the
 * full rationale: a combined write would make a governance-record problem
 * capable of taking down an already-successful `adaptiveOutput` write,
 * which Phase 2A's own non-negotiable rules forbid.
 *
 * Same size-safety posture and the same honest limitation as
 * `persistAdaptiveOutput`: `estimateDocumentSize` only ever sees the
 * payload passed to it here (`{ governanceRecord }`), not the full,
 * already-written run document — this mirrors `persistAdaptiveOutput`'s
 * own behavior exactly, kept consistent rather than "fixed" here, since
 * changing the estimation strategy for one write path and not the other
 * would make the two even harder to reason about together. A document
 * that's already near the limit from its `runDocument`/`adaptiveOutput`
 * fields could still, in principle, be pushed over Firestore's real 1 MiB
 * limit by a `governanceRecord` that individually measures under budget —
 * an accepted, pre-existing limitation of this size-check strategy, not
 * introduced by this function.
 *
 * Never retries. Never logs receipt content, source strings, the
 * question, or reviewer identity — only `runId`/`schemaId`/a fixed reason
 * code, per Phase 2A's standing "receipts and record content never reach
 * logs" rule (see governanceRecordParser.ts's own module doc for the same
 * rule applied to parse failures).
 */
export type GovernanceRecordPersistenceFailureReason = "firestore_unavailable" | "oversized" | "write_failed";

export async function persistGovernanceRecord(
  runId: string,
  governanceRecord: GovernanceRecordV1
): Promise<{ saved: true } | { saved: false; reason: GovernanceRecordPersistenceFailureReason }> {
  if (!adminDb) {
    return { saved: false, reason: "firestore_unavailable" };
  }

  const estimatedSize = estimateDocumentSize({ governanceRecord });
  if (estimatedSize > MAX_TOTAL_DOC_SIZE) {
    logger.warn("[firestore/runs] governanceRecord exceeds safety budget, omitting", {
      runId,
      schemaId: governanceRecord.schemaId,
    });
    return { saved: false, reason: "oversized" };
  }

  try {
    await adminDb.collection("runs").doc(runId).set({ governanceRecord }, { merge: true });
    return { saved: true };
  } catch (err: unknown) {
    logger.warn("[firestore/runs] Failed to persist governanceRecord", {
      runId,
      schemaId: governanceRecord.schemaId,
    });
    return { saved: false, reason: "write_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part C — narrow, read-only
 * lookup of an existing `governanceRecord` before initialization, so the
 * caller can pass a real value (or a positively-confirmed absence) to
 * `initializeAdaptiveGovernanceRecord` rather than guessing. Deliberately
 * does NOT parse the value — `parseGovernanceRecord` (governanceRecordParser.ts)
 * remains the one place that happens, so this helper's contract can't
 * silently drift from the parser's own validation rules over time.
 *
 * Does not return the full run document — only the one field, `unknown`
 * (untrusted, unparsed) or absent. Considered field-projection via
 * `Firestore.getAll(docRef, { fieldMask: [...] })` (the Admin SDK's only
 * server-side field-selection mechanism for a single document read) and
 * deliberately did not use it: a field mask only reduces network payload,
 * not Firestore's per-document read cost, `governanceRecord` is tiny
 * compared to the rest of the run document, and every other read in this
 * file already uses a plain `.get()` + `.data()` — matching that existing,
 * unanimous precedent was judged clearer than introducing a second read
 * pattern for a benefit that doesn't apply here.
 *
 * Never throws, never retries, uses `logger` (not `console.*`), and never
 * logs the record's own content — only `runId`.
 *
 * `"run_missing"` is a DISTINCT non-success state from `"absent"` — not
 * folded together, even though both originally returned the same thing.
 * The two mean different things downstream: `"absent"` means the run
 * document exists and simply has no `governanceRecord` field yet, which is
 * safe to treat as "OK to initialize" (`persistGovernanceRecord`'s
 * `.set(..., {merge:true})` only ever touches a field on an EXISTING
 * document in that case). `"run_missing"` means the run document itself
 * doesn't exist — and `.set(..., {merge:true})` against a missing document
 * CREATES one. If the caller silently treated a missing run the same as
 * "absent record" and passed `existingGovernanceRecord: undefined` through
 * to `initializeAdaptiveGovernanceRecord`, an unexpectedly-missing run
 * (e.g. `createRun`'s own earlier write failed, or the runId was wrong)
 * could result in an orphan `runs/{runId}` document containing nothing but
 * a `governanceRecord` field. The caller must treat `"run_missing"` as a
 * hard stop, exactly like `"firestore_unavailable"`/`"read_failed"` — never
 * as a stand-in for `"absent"`.
 */
export type GovernanceRecordReadResult =
  | { status: "found"; value: unknown }
  | { status: "absent" }
  | { status: "run_missing" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

export async function readGovernanceRecordForInitialization(runId: string): Promise<GovernanceRecordReadResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  try {
    const snapshot = await adminDb.collection("runs").doc(runId).get();
    // A missing run document is NOT "absent" — see the module doc above.
    // This helper never creates a run; it only reports what it found.
    if (!snapshot.exists) {
      return { status: "run_missing" };
    }
    const data = snapshot.data();
    const value = data?.governanceRecord;
    if (value === undefined || value === null) {
      return { status: "absent" };
    }
    return { status: "found", value };
  } catch (err: unknown) {
    logger.warn("[firestore/runs] Failed to read governanceRecord", { runId });
    return { status: "read_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part B — additive, NESTED
 * persistence for the adaptive automated-governance result
 * (docs/governance-decision-receipts-design.md §18.9). This is the
 * mandatory concurrency fix that section calls for: writes ONLY the two
 * leaf field paths `governanceRecord.automatedGovernance` and
 * `governanceRecord.updatedAt` via Firestore's dot-notation partial
 * update — `governanceRecord.humanReview` and `governanceRecord.decisionReceipt`
 * are never part of this write's payload at all, so a concurrent reviewer
 * update to `humanReview` (via its own, similarly narrow write) can never
 * be clobbered by this one, regardless of ordering. This is a genuinely
 * new pattern for this codebase (no prior dot-path nested Firestore update
 * was found in `lib/firestore/`/`lib/governance/` before this) —
 * verified against the Admin SDK's own documented `update()` behavior, not
 * exercised against a live Firestore/emulator in this step (§18.11's own
 * flagged open question).
 *
 * Deliberately uses `.update()`, not `.set(..., {merge:true})` — `.update()`
 * throws (rather than creating a new document) when the target doesn't
 * exist, which is exactly the behavior wanted here: automated evaluation
 * must never be the thing that brings a run document into existence.
 * `persistGovernanceRecord()` (Step 5B) remains the ONLY function that
 * writes a whole `governanceRecord` — reserved for first-time
 * initialization, where no concurrent reviewer write is possible against a
 * field that doesn't exist yet. This function must never be used as a
 * substitute for that one, and vice versa.
 */
export type AutomatedGovernanceUpdatePersistenceFailureReason = "firestore_unavailable" | "run_missing" | "write_failed";

export async function persistAutomatedGovernanceUpdate(
  runId: string,
  automatedGovernance: NonNullable<GovernanceRecordV1["automatedGovernance"]>,
  updatedAt: string
): Promise<{ saved: true } | { saved: false; reason: AutomatedGovernanceUpdatePersistenceFailureReason }> {
  if (!adminDb) {
    return { saved: false, reason: "firestore_unavailable" };
  }

  try {
    await adminDb
      .collection("runs")
      .doc(runId)
      .update({
        "governanceRecord.automatedGovernance": automatedGovernance,
        "governanceRecord.updatedAt": updatedAt,
      });
    return { saved: true };
  } catch (err: unknown) {
    // Best-effort classification of a "document doesn't exist" failure —
    // Firestore's Admin SDK surfaces this as a NOT_FOUND-coded error on
    // .update(). Not verified against a live emulator in this step; falls
    // back to the generic reason if the shape doesn't match.
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const isNotFound = code === 5 || code === "NOT_FOUND" || message.includes("NOT_FOUND") || message.includes("No document to update");
    if (isNotFound) {
      logger.warn("[firestore/runs] persistAutomatedGovernanceUpdate: run document missing", { runId });
      return { saved: false, reason: "run_missing" };
    }
    logger.warn("[firestore/runs] Failed to persist automated governance update", { runId });
    return { saved: false, reason: "write_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part B — optional
 * `governanceEvents` write for an adaptive automated-governance
 * evaluation (docs/governance-decision-receipts-design.md §18.10).
 * Verified directly against the real, LEGACY `governanceEvents` write
 * shape (`evaluateAndStore.ts`, `{action, byUid, byEmail, at, nextStatus,
 * reasons, policyVersion}`) before writing this — that shape is fully
 * generic, with zero claims-specific or `runType`-specific fields, so
 * reusing it verbatim for an adaptive evaluation needs no contract change.
 * This is DELIBERATELY NOT the same decision as `admin_audit_logs`
 * (`writeAuditEvent`), which §18.10 found requires `runType`/`question`/
 * `consensusScore` with no honest adaptive equivalent — that integration
 * remains deferred, and this function never calls it.
 *
 * A standalone, uncalled helper in this Part — like the two functions
 * above it, wiring WHEN this gets invoked is Part C's job, not Part B's.
 */
export async function writeAdaptiveGovernanceEvent(
  runId: string,
  automatedGovernance: NonNullable<GovernanceRecordV1["automatedGovernance"]>,
  at: string
): Promise<{ written: true } | { written: false; reason: "firestore_unavailable" | "write_failed" }> {
  if (!adminDb) {
    return { written: false, reason: "firestore_unavailable" };
  }

  try {
    await adminDb
      .collection("runs")
      .doc(runId)
      .collection("governanceEvents")
      .add({
        action: "evaluated",
        byUid: "system",
        byEmail: "system",
        // Query-Routing Redesign, Phase 2A, Step 6B, Part C — the SAME
        // timestamp used for the evaluator's evaluatedAt, the persisted
        // automatedGovernance.evaluatedAt, and the nested-write updatedAt.
        // Never independently generated — a single moment-in-time value
        // shared across every artifact this one evaluation produces.
        at,
        nextStatus: automatedGovernance.status,
        reasons: automatedGovernance.reasons,
        policyVersion: automatedGovernance.policyVersion,
      });
    return { written: true };
  } catch (err: unknown) {
    logger.warn("[firestore/runs] Failed to write adaptive governanceEvents entry", { runId });
    return { written: false, reason: "write_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D — the transaction-safe
 * canonical write for an adaptive human-review decision
 * (docs/governance-decision-receipts-design.md §21.7). Uses
 * `adminDb.runTransaction()` — a PROVEN, pre-existing pattern in this
 * codebase (`lib/stripe/usageCheck.ts`, `lib/security/rateLimit.ts`,
 * `app/api/verify-video/route.ts`), not a novel technique, unlike the
 * nested-field-path `.update()` pattern Step 6B introduced (§18.9).
 *
 * Two separate, verified-distinct requirements this satisfies together:
 * (a) sibling `governanceRecord` fields (`automatedGovernance`,
 * `decisionReceipt`, `schemaId`, `answerShape`, `adaptiveOutputVersion`,
 * `createdAt`) are NEVER part of this write's payload — solved by the
 * nested dot-path `txn.update()` call, identical to §18.9's own mechanism;
 * (b) two concurrent reviewers can never both silently "win" — solved by
 * the transaction itself, which re-reads the current record and its
 * `updatedAt` INSIDE the transaction (never trusting a value read before
 * the transaction started) and lets Firestore's transaction retry/conflict
 * machinery ensure only one caller's write can ever commit against a given
 * starting state.
 *
 * Every failure path is a typed result-union variant — this function never
 * throws to its caller. `run_missing`/`governance_record_absent`/
 * `governance_record_malformed`/`unsupported_version`/
 * `stale_expected_updated_at`/`terminal_review_exists` are all checked
 * INSIDE the transaction, against data read INSIDE the transaction —
 * never against a value the route layer read earlier (which could already
 * be stale by the time the transaction runs).
 *
 * `persistGovernanceRecord()` (whole-record `.set(..., {merge:true})`) and
 * a bare `.set()` are never used here — matching Step 6B's own established
 * rule for `automatedGovernance` (§18.9), now extended to `humanReview` for
 * the identical reason: a whole-record write could clobber a concurrent
 * automated-governance update to a sibling field.
 */
export type SubmitAdaptiveHumanReviewFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "stale_expected_updated_at"
  | "terminal_review_exists"
  | HumanReviewUpdateFailureReason
  | "write_failed";

export type SubmitAdaptiveHumanReviewResult =
  | {
      ok: true;
      record: GovernanceRecordV1;
      /** The status read INSIDE the transaction, before this decision was applied — needed verbatim for the governance event's `prevStatus` field (§21.10), and for that field alone (never returned to the client). */
      priorHumanReviewStatus: GovernanceRecordV1["humanReview"]["status"];
    }
  | { ok: false; reason: SubmitAdaptiveHumanReviewFailureReason };

export async function submitAdaptiveHumanReview(args: {
  runId: string;
  /** Status/comment/conditions only — validated shape from `parseAdaptiveReviewDecisionRequest` (`lib/governance/adaptiveHumanReviewRequest.ts`). Reviewer identity is supplied separately below, never inside this object, so a caller can never accidentally pass a client-controlled reviewer identity through. */
  update: Omit<HumanReviewUpdate, "reviewerId" | "reviewerName" | "reviewedAt">;
  reviewerId: string;
  reviewerName?: string;
  expectedUpdatedAt: string;
  now?: string;
}): Promise<SubmitAdaptiveHumanReviewResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<SubmitAdaptiveHumanReviewResult>(async (txn) => {
      const ref = adminDb!.collection("runs").doc(args.runId);
      const snap = await txn.get(ref);
      if (!snap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const data = snap.data();
      const parseResult = parseGovernanceRecord(data?.governanceRecord);
      if (!parseResult.ok) {
        if (parseResult.reason === "absent") {
          return { ok: false, reason: "governance_record_absent" };
        }
        if (parseResult.reason === "unsupported_version") {
          return { ok: false, reason: "unsupported_version" };
        }
        return { ok: false, reason: "governance_record_malformed" };
      }
      const record = parseResult.record;

      // Checked BEFORE the reviewable-status check, so a stale-data error
      // is never masked by a terminal-status error the caller's own UI
      // hasn't even seen yet (§21.7).
      if (record.updatedAt !== args.expectedUpdatedAt) {
        return { ok: false, reason: "stale_expected_updated_at" };
      }

      if (!isHumanReviewStatusReviewable(record.humanReview.status)) {
        return { ok: false, reason: "terminal_review_exists" };
      }

      const priorHumanReviewStatus = record.humanReview.status;

      const updateResult = applyHumanReviewUpdate(
        record,
        {
          ...args.update,
          reviewerId: args.reviewerId,
          reviewerName: args.reviewerName,
          reviewedAt: now,
        },
        now
      );
      if (!updateResult.ok) {
        return { ok: false, reason: updateResult.reason };
      }

      // Nested field paths only — governanceRecord.automatedGovernance,
      // .decisionReceipt, .schemaId, .answerShape, .adaptiveOutputVersion,
      // and .createdAt are never read into this payload at all, so there
      // is nothing to accidentally include.
      txn.update(ref, {
        "governanceRecord.humanReview": updateResult.record.humanReview,
        "governanceRecord.updatedAt": now,
      });

      return { ok: true, record: updateResult.record, priorHumanReviewStatus };
    });
  } catch (err: unknown) {
    logger.warn("[firestore/runs] submitAdaptiveHumanReview transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D — the
 * `governanceEvents` write for an adaptive human-review decision
 * (docs/governance-decision-receipts-design.md §21.10). Emitted ONLY after
 * `submitAdaptiveHumanReview()`'s transaction has already committed — never
 * before, and a failure here never rolls back or otherwise affects the
 * already-successful canonical decision (the caller is responsible for
 * treating this as best-effort, exactly like `writeAdaptiveGovernanceEvent`
 * above).
 *
 * A NEW, distinct `action` value (`"human_review_decided"`) — not
 * `"evaluated"`, which is reserved for automated evaluation — so the two
 * remain distinguishable in the same `governanceEvents` subcollection.
 * Reviewer uid IS included (`byUid`), matching System A's own existing
 * review route's established precedent of writing `byUid`/`byEmail` into
 * this exact same generic event shape — not a new privacy exposure.
 * Never included: question text, receipt conclusion, source strings,
 * comment text, conditions text, raw model output.
 */
export async function writeAdaptiveHumanReviewEvent(args: {
  runId: string;
  teamId: string;
  schemaId: GovernanceRecordV1["schemaId"];
  answerShape: GovernanceRecordV1["answerShape"];
  reviewerId: string;
  prevStatus: GovernanceRecordV1["humanReview"]["status"];
  nextStatus: GovernanceRecordV1["humanReview"]["status"];
  at: string;
}): Promise<{ written: true } | { written: false; reason: "firestore_unavailable" | "write_failed" }> {
  if (!adminDb) {
    return { written: false, reason: "firestore_unavailable" };
  }

  try {
    await adminDb
      .collection("runs")
      .doc(args.runId)
      .collection("governanceEvents")
      .add({
        action: "human_review_decided",
        byUid: args.reviewerId,
        at: args.at,
        teamId: args.teamId,
        schemaId: args.schemaId,
        answerShape: args.answerShape,
        prevStatus: args.prevStatus,
        nextStatus: args.nextStatus,
      });
    return { written: true };
  } catch (err: unknown) {
    logger.warn("[firestore/runs] Failed to write human-review governanceEvents entry", { runId: args.runId });
    return { written: false, reason: "write_failed" };
  }
}

/**
 * Immutable Adaptive Review History and Admin Audit Integration — the
 * create-only immutable history writer (docs/governance-decision-receipts-design.md
 * §27.6). Stored at `runs/{runId}/humanReviewHistory/{decisionId}` — a NEW
 * subcollection of the canonical `runs/{runId}` document, distinct from
 * `governanceEvents` (a governance-domain event stream) and from
 * `admin_audit_logs` (an administrative audit surface). This is a
 * run-scoped LIFECYCLE record, not a second mutable source of current
 * truth — `governanceRecord.humanReview` remains canonical; this
 * collection is only ever appended to, never read for "what is the current
 * state," and never influences authorization or reviewability.
 *
 * Uses `.create()`, exactly like `createAdaptiveTeamRunProjection()`
 * (Part C) — throws `ALREADY_EXISTS` rather than silently overwriting, so
 * a retried write after a transient failure (or the repair service running
 * again) can never produce a duplicate or clobber the first record.
 * `entry.decisionId` is ALWAYS server-derived (a deterministic hash — see
 * `buildAdaptiveReviewDecisionId()`) — this function never accepts or
 * trusts an ID from the client.
 */
export type AdaptiveHistoryWriteResult = { status: "recorded" } | { status: "already_exists" } | { status: "failed" };

export async function createAdaptiveHumanReviewHistory(runId: string, entry: AdaptiveHumanReviewHistoryV1): Promise<AdaptiveHistoryWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }

  try {
    await adminDb.collection("runs").doc(runId).collection("humanReviewHistory").doc(entry.decisionId).create(entry);
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    // Metadata-only — never the comment, conditions, or any content field.
    logger.warn("[firestore/runs] Failed to create adaptive human-review history entry", { runId, decisionId: entry.decisionId });
    return { status: "failed" };
  }
}

/**
 * Part E3 — Single-Reviewer Assignment for Adaptive Human Review. A
 * plain, non-transactional read of the current assignment document at
 * `runs/{runId}/humanReviewAssignment/current`. A missing document is a
 * valid, expected state (`status: "unassigned"`) — every run created
 * before this step, and every run nobody has ever assigned, has no such
 * document, and must behave exactly as before.
 */
export type GetAdaptiveHumanReviewAssignmentResult =
  | { status: "found"; assignment: AdaptiveHumanReviewAssignmentV1 }
  | { status: "unassigned" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

export async function getAdaptiveHumanReviewAssignment(runId: string): Promise<GetAdaptiveHumanReviewAssignmentResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const snap = await adminDb.collection("runs").doc(runId).collection("humanReviewAssignment").doc("current").get();
    if (!snap.exists) {
      return { status: "unassigned" };
    }
    return { status: "found", assignment: snap.data() as AdaptiveHumanReviewAssignmentV1 };
  } catch {
    logger.warn("[firestore/runs] Failed to read adaptive human-review assignment", { runId });
    return { status: "read_failed" };
  }
}

/**
 * Part E3 — the transactional canonical assignment write. Mirrors
 * `submitAdaptiveHumanReview()`'s own transaction shape exactly: re-reads
 * and re-validates everything fresh INSIDE the transaction (never trusting
 * a value read before it started), uses the SAME
 * `isHumanReviewStatusReviewable()` predicate to enforce "assignment may
 * only change while the review is pending" (§E3 objective 7), and uses
 * `expectedRevision` as the optimistic-concurrency token — the identical
 * pattern `expectedUpdatedAt` already established for the decision route,
 * just keyed to this document's own `revision` counter instead of a
 * timestamp, since this document (unlike `governanceRecord`) is not
 * updated by any other writer whose timestamp could double as a token.
 *
 * Writes via `.set()` (not `.create()`) — unlike the immutable history
 * subcollections, this document is a single, fixed-ID, EVOLVING record by
 * design (§E3's own `revision` field exists specifically to make
 * concurrent mutation of a mutable document safe) — `.create()`'s
 * create-only semantics would be wrong here, since a SECOND assignment
 * (reassignment) is an expected, legitimate write to the SAME document.
 */
export type SubmitAdaptiveHumanReviewAssignmentFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "not_pending"
  | "stale_revision"
  | "write_failed";

export type SubmitAdaptiveHumanReviewAssignmentResult =
  | { ok: true; assignment: AdaptiveHumanReviewAssignmentV1; previousReviewerUserId: string | null }
  | { ok: false; reason: SubmitAdaptiveHumanReviewAssignmentFailureReason };

export async function submitAdaptiveHumanReviewAssignment(args: {
  runId: string;
  teamId: string | null;
  newReviewerUserId: string | null;
  actorUserId: string;
  expectedRevision: number;
  now?: string;
}): Promise<SubmitAdaptiveHumanReviewAssignmentResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<SubmitAdaptiveHumanReviewAssignmentResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const assignmentRef = runRef.collection("humanReviewAssignment").doc("current");

      const [runSnap, assignmentSnap] = await Promise.all([txn.get(runRef), txn.get(assignmentRef)]);

      if (!runSnap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const parseResult = parseGovernanceRecord(runSnap.data()?.governanceRecord);
      if (!parseResult.ok) {
        if (parseResult.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (parseResult.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }
      const record = parseResult.record;

      if (!isHumanReviewStatusReviewable(record.humanReview.status)) {
        return { ok: false, reason: "not_pending" };
      }

      const current = assignmentSnap.exists ? (assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1) : null;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== args.expectedRevision) {
        return { ok: false, reason: "stale_revision" };
      }

      const previousReviewerUserId = current?.assignedReviewerUserId ?? null;
      const nextAssignment = buildNextAdaptiveHumanReviewAssignment({
        teamId: args.teamId,
        runId: args.runId,
        newReviewerUserId: args.newReviewerUserId,
        actorUserId: args.actorUserId,
        now,
        currentRevision,
        currentAssignedAt: current?.assignedAt ?? null,
        currentAssignedByUserId: current?.assignedByUserId ?? null,
      });

      txn.set(assignmentRef, nextAssignment);

      return { ok: true, assignment: nextAssignment, previousReviewerUserId };
    });
  } catch {
    logger.warn("[firestore/runs] submitAdaptiveHumanReviewAssignment transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Part E3 — the immutable assignment-history writer, at
 * `runs/{runId}/humanReviewAssignmentHistory/{eventId}`. Create-only,
 * exactly like `createAdaptiveHumanReviewHistory()` above — `ALREADY_EXISTS`
 * is idempotent success, never an overwrite.
 */
export type AdaptiveAssignmentHistoryWriteResult = { status: "recorded" } | { status: "already_exists" } | { status: "failed" };

export async function createAdaptiveHumanReviewAssignmentHistory(
  runId: string,
  entry: AdaptiveHumanReviewAssignmentHistoryV1
): Promise<AdaptiveAssignmentHistoryWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }
  try {
    await adminDb.collection("runs").doc(runId).collection("humanReviewAssignmentHistory").doc(entry.eventId).create(entry);
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    logger.warn("[firestore/runs] Failed to create adaptive human-review assignment-history entry", { runId, eventId: entry.eventId });
    return { status: "failed" };
  }
}

// ============================================
// Multi-Reviewer Panel Foundation, Part B
// (docs/governance-decision-receipts-design.md §29, §30)
// ============================================

export type GetAdaptiveHumanReviewPanelResult =
  | { status: "absent" }
  | { status: "found"; panel: AdaptiveHumanReviewPanelV1 }
  | { status: "malformed" }
  | { status: "unsupported_version" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

/**
 * Reads AND parses in one call — `runs/{runId}/humanReviewPanel/current`
 * is single-fixed-ID, mirroring `getAdaptiveHumanReviewAssignment` above.
 * Unlike that function, this one's caller (the decision route's panel
 * gate, §30.11) is REQUIRED to fail CLOSED on `firestore_unavailable`/
 * `read_failed` — a deliberate, documented asymmetry from the
 * single-reviewer assignment lookup's fail-OPEN behavior, since an
 * infrastructure failure here must never silently let a direct
 * single-reviewer decision bypass an active panel's governance.
 */
export async function getAdaptiveHumanReviewPanel(runId: string, teamId?: string): Promise<GetAdaptiveHumanReviewPanelResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const snap = await adminDb.collection("runs").doc(runId).collection("humanReviewPanel").doc("current").get();
    const parseResult = parseAdaptiveHumanReviewPanel(snap.exists ? snap.data() : undefined, {
      expectedRunId: runId,
      expectedTeamId: teamId,
    });
    if (parseResult.status === "valid") return { status: "found", panel: parseResult.panel };
    if (parseResult.status === "absent") return { status: "absent" };
    if (parseResult.status === "unsupported_version") return { status: "unsupported_version" };
    return { status: "malformed" };
  } catch {
    logger.warn("[firestore/runs] Failed to read adaptive human-review panel", { runId });
    return { status: "read_failed" };
  }
}

export type SubmitAdaptiveHumanReviewPanelFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "not_pending"
  | "panel_cancelled"
  /** Part E — a distinct, more precise reason than "panel_cancelled" for a panel that has reached the OTHER terminal status; no reconfiguration is possible after finalization either. */
  | "panel_finalized"
  | "panel_malformed"
  | "panel_unsupported_version"
  | "stale_revision"
  | "write_failed";

export type SubmitAdaptiveHumanReviewPanelResult =
  | { ok: true; panel: AdaptiveHumanReviewPanelV1 }
  | { ok: false; reason: SubmitAdaptiveHumanReviewPanelFailureReason };

/**
 * The transactional panel create/reconfigure write (PUT). Mirrors
 * `submitAdaptiveHumanReviewAssignment`'s transaction shape exactly:
 * re-reads and re-validates everything fresh INSIDE the transaction, uses
 * `isHumanReviewStatusReviewable()` to enforce "panel configuration may
 * only change while the review is pending," and uses `expectedRevision`
 * as the optimistic-concurrency token (`currentRevision = current?.revision ?? 0`
 * — a NEW panel is simply "revision 0", so creation and reconfiguration
 * share one code path with no separate branch needed).
 *
 * Team opt-in and reviewer eligibility are deliberately NOT re-checked
 * inside this transaction — both live on the TEAM document, not the RUN
 * document this transaction reads, and re-reading the entire team
 * document inside a run-scoped transaction would be a new, heavier
 * pattern for a low-value race window (a team's opt-in flag or a
 * reviewer's role changing in the few hundred milliseconds of this
 * transaction's execution is a materially narrower edge case than the
 * humanReview terminal-race this transaction IS built to close). This
 * matches the EXISTING codebase precedent exactly: the single-reviewer
 * assignment route already checks reviewer eligibility at the route
 * layer, not inside `submitAdaptiveHumanReviewAssignment`'s own
 * transaction — the caller (the review-panel route) is responsible for
 * having already validated opt-in and eligibility against a freshly
 * loaded team immediately before calling this function.
 *
 * A cancelled panel can never be reconfigured back to open by this
 * function — `panel_cancelled` is returned instead, regardless of
 * whether `expectedRevision` happens to match (§30's "no reopening in
 * Part B").
 */
export async function submitAdaptiveHumanReviewPanel(args: {
  runId: string;
  teamId: string;
  reviewerUserIds: string[];
  actorUserId: string;
  expectedRevision: number;
  now?: string;
}): Promise<SubmitAdaptiveHumanReviewPanelResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<SubmitAdaptiveHumanReviewPanelResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const panelRef = runRef.collection("humanReviewPanel").doc("current");

      const [runSnap, panelSnap] = await Promise.all([txn.get(runRef), txn.get(panelRef)]);

      if (!runSnap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const parseResult = parseGovernanceRecord(runSnap.data()?.governanceRecord);
      if (!parseResult.ok) {
        if (parseResult.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (parseResult.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }

      if (!isHumanReviewStatusReviewable(parseResult.record.humanReview.status)) {
        return { ok: false, reason: "not_pending" };
      }

      const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, {
        expectedTeamId: args.teamId,
        expectedRunId: args.runId,
      });

      let current: AdaptiveHumanReviewPanelV1 | null = null;
      if (panelParse.status === "valid") {
        current = panelParse.panel;
        if (current.status === "finalized") {
          return { ok: false, reason: "panel_finalized" };
        }
        if (current.status !== "open") {
          return { ok: false, reason: "panel_cancelled" };
        }
      } else if (panelParse.status === "malformed") {
        logAdaptiveGovernanceEvent("malformed_record_detected", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_malformed" });
        return { ok: false, reason: "panel_malformed" };
      } else if (panelParse.status === "unsupported_version") {
        logAdaptiveGovernanceEvent("unsupported_schema_version_detected", { runId: args.runId, teamId: args.teamId });
        return { ok: false, reason: "panel_unsupported_version" };
      }
      // "absent" — current stays null; this is the first-ever creation.

      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== args.expectedRevision) {
        return { ok: false, reason: "stale_revision" };
      }

      const isCreatingNewPanel = current === null;

      const nextPanel = buildNextAdaptiveHumanReviewPanel({
        teamId: args.teamId,
        runId: args.runId,
        reviewerUserIds: args.reviewerUserIds,
        actorUserId: args.actorUserId,
        now,
        current,
      });

      txn.set(panelRef, nextPanel);

      logAdaptiveGovernanceEvent(isCreatingNewPanel ? "panel_created" : "panel_reconfigured", {
        runId: args.runId,
        teamId: args.teamId,
        panelRevision: nextPanel.revision,
      });
      return { ok: true, panel: nextPanel };
    });
  } catch {
    logger.warn("[firestore/runs] submitAdaptiveHumanReviewPanel transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

export type CancelAdaptiveHumanReviewPanelFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "not_pending"
  | "panel_absent"
  | "panel_already_cancelled"
  /** Part E — a finalized panel can never be cancelled either; distinct from "panel_already_cancelled" for a precise, honest error. */
  | "panel_finalized"
  | "panel_malformed"
  | "panel_unsupported_version"
  | "stale_revision"
  | "write_failed";

export type CancelAdaptiveHumanReviewPanelResult =
  | { ok: true; panel: AdaptiveHumanReviewPanelV1 }
  | { ok: false; reason: CancelAdaptiveHumanReviewPanelFailureReason };

/**
 * The transactional panel cancellation write (DELETE). Never a physical
 * delete — writes a terminal `status: "cancelled"` configuration exactly
 * like `buildCancelledAdaptiveHumanReviewPanel` describes, preserving the
 * reviewer list for auditability. No reopening: a caller attempting to
 * cancel an already-cancelled panel gets `panel_already_cancelled`, not a
 * silent no-op success.
 */
export async function cancelAdaptiveHumanReviewPanel(args: {
  runId: string;
  teamId: string;
  actorUserId: string;
  expectedRevision: number;
  now?: string;
}): Promise<CancelAdaptiveHumanReviewPanelResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<CancelAdaptiveHumanReviewPanelResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const panelRef = runRef.collection("humanReviewPanel").doc("current");

      const [runSnap, panelSnap] = await Promise.all([txn.get(runRef), txn.get(panelRef)]);

      if (!runSnap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const parseResult = parseGovernanceRecord(runSnap.data()?.governanceRecord);
      if (!parseResult.ok) {
        if (parseResult.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (parseResult.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }

      if (!isHumanReviewStatusReviewable(parseResult.record.humanReview.status)) {
        return { ok: false, reason: "not_pending" };
      }

      const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, {
        expectedTeamId: args.teamId,
        expectedRunId: args.runId,
      });

      if (panelParse.status === "absent") return { ok: false, reason: "panel_absent" };
      if (panelParse.status === "malformed") {
        logAdaptiveGovernanceEvent("malformed_record_detected", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_malformed" });
        return { ok: false, reason: "panel_malformed" };
      }
      if (panelParse.status === "unsupported_version") {
        logAdaptiveGovernanceEvent("unsupported_schema_version_detected", { runId: args.runId, teamId: args.teamId });
        return { ok: false, reason: "panel_unsupported_version" };
      }

      const current = panelParse.panel;
      if (current.status === "finalized") {
        return { ok: false, reason: "panel_finalized" };
      }
      if (current.status !== "open") {
        return { ok: false, reason: "panel_already_cancelled" };
      }
      if (current.revision !== args.expectedRevision) {
        return { ok: false, reason: "stale_revision" };
      }

      const nextPanel = buildCancelledAdaptiveHumanReviewPanel({ current, actorUserId: args.actorUserId, now });

      txn.set(panelRef, nextPanel);

      logAdaptiveGovernanceEvent("panel_cancelled", { runId: args.runId, teamId: args.teamId, panelRevision: nextPanel.revision });
      return { ok: true, panel: nextPanel };
    });
  } catch {
    logger.warn("[firestore/runs] cancelAdaptiveHumanReviewPanel transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

// ============================================
// Immutable Multi-Reviewer Vote Contract and Submission, Part C
// (docs/governance-decision-receipts-design.md §29, §30, §31)
// ============================================

export type GetAdaptiveHumanReviewVoteResult =
  | { status: "absent" }
  | { status: "found"; vote: AdaptiveHumanReviewVoteV1 }
  | { status: "malformed" }
  | { status: "unsupported_version" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

/**
 * Reads AND parses a single reviewer's vote for a specific panel revision
 * by its deterministic ID — mirrors `getAdaptiveHumanReviewPanel` above.
 * The vote parser has no "absent" outcome of its own (§C6 — it is only
 * ever handed an object once a document is already known to exist), so
 * this getter checks `snap.exists` itself before ever calling it.
 */
export async function getAdaptiveHumanReviewVote(
  runId: string,
  panelRevision: number,
  reviewerUserId: string,
  teamId?: string
): Promise<GetAdaptiveHumanReviewVoteResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const voteId = buildAdaptiveHumanReviewVoteId(panelRevision, reviewerUserId);
    const snap = await adminDb.collection("runs").doc(runId).collection("humanReviewVotes").doc(voteId).get();
    if (!snap.exists) {
      return { status: "absent" };
    }
    const parseResult = parseAdaptiveHumanReviewVote(snap.data(), {
      expectedRunId: runId,
      expectedTeamId: teamId,
      expectedPanelRevision: panelRevision,
      expectedReviewerUserId: reviewerUserId,
    });
    if (parseResult.status === "valid") return { status: "found", vote: parseResult.vote };
    if (parseResult.status === "unsupported_version") return { status: "unsupported_version" };
    return { status: "malformed" };
  } catch {
    logger.warn("[firestore/runs] Failed to read adaptive human-review vote", { runId });
    return { status: "read_failed" };
  }
}

export type SubmitAdaptiveHumanReviewVoteFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "not_pending"
  | "panel_absent"
  | "panel_cancelled"
  | "panel_malformed"
  | "panel_unsupported_version"
  | "panel_stale"
  | "reviewer_not_assigned"
  | "vote_conflict"
  | "vote_malformed"
  | "write_failed";

export type SubmitAdaptiveHumanReviewVoteResult =
  | { ok: true; vote: AdaptiveHumanReviewVoteV1; submissionStatus: "submitted" | "already_submitted" }
  | { ok: false; reason: SubmitAdaptiveHumanReviewVoteFailureReason };

/**
 * The transactional vote-submission write (§C7-§C12). Re-reads and
 * re-validates EVERYTHING fresh inside the transaction, exactly like
 * every other adaptive-governance transaction in this file — including,
 * deliberately, a fresh read of the TEAM document itself (`teams/{teamId}`)
 * to re-verify the caller is STILL a current, eligible team member at the
 * moment of write. This is a genuine departure from the pattern
 * established in Part B (`submitAdaptiveHumanReviewPanel`, which checks
 * eligibility only at the route layer, never inside its own transaction)
 * — deliberate here because a vote, once created, is immutable and
 * irreversible; the extra transactional freshness is worth the heavier
 * "read a second document type inside a run-scoped transaction" pattern
 * specifically for this one write, where "the reviewer's eligibility
 * lapsed a moment before their vote was cast" is a real, disclosed risk
 * Part B's own lighter-weight pattern does not need to close.
 *
 * `reviewer_not_assigned` deliberately covers THREE distinct underlying
 * conditions — not present in `panel.reviewerUserIds`, not a current team
 * member at all, or a current member whose role is no longer eligible —
 * collapsed into one generic reason so the response never discloses WHICH
 * condition failed (§C11: "do not expose whether the user was previously
 * assigned").
 *
 * Idempotent duplicate semantics (§C9): if a vote already exists for this
 * exact `(panelRevision, reviewerUserId)` pair, its content is compared
 * SEMANTICALLY (never by `submittedAt`) against the incoming request — an
 * exact match returns `already_submitted` (the existing, original vote,
 * never a new document, never a mutated timestamp); any difference is
 * rejected as `vote_conflict`, never silently overwritten. `txn.set()` is
 * only ever reached on the "no existing vote" branch — the read against
 * the SAME transaction is what makes this create-only in effect, exactly
 * like `submitAdaptiveHumanReviewPanel`'s own established pattern.
 */
export async function submitAdaptiveHumanReviewVote(args: {
  runId: string;
  teamId: string;
  reviewerUserId: string;
  panelRevision: number;
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
  now?: string;
}): Promise<SubmitAdaptiveHumanReviewVoteResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<SubmitAdaptiveHumanReviewVoteResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const panelRef = runRef.collection("humanReviewPanel").doc("current");
      const teamRef = adminDb!.collection("teams").doc(args.teamId);
      const voteId = buildAdaptiveHumanReviewVoteId(args.panelRevision, args.reviewerUserId);
      const voteRef = runRef.collection("humanReviewVotes").doc(voteId);

      const [runSnap, panelSnap, teamSnap, voteSnap] = await Promise.all([
        txn.get(runRef),
        txn.get(panelRef),
        txn.get(teamRef),
        txn.get(voteRef),
      ]);

      if (!runSnap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const govParse = parseGovernanceRecord(runSnap.data()?.governanceRecord);
      if (!govParse.ok) {
        if (govParse.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (govParse.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }
      if (!isHumanReviewStatusReviewable(govParse.record.humanReview.status)) {
        return { ok: false, reason: "not_pending" };
      }

      const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, {
        expectedTeamId: args.teamId,
        expectedRunId: args.runId,
      });
      if (panelParse.status === "absent") return { ok: false, reason: "panel_absent" };
      if (panelParse.status === "malformed") {
        logAdaptiveGovernanceEvent("malformed_record_detected", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_malformed" });
        return { ok: false, reason: "panel_malformed" };
      }
      if (panelParse.status === "unsupported_version") {
        logAdaptiveGovernanceEvent("unsupported_schema_version_detected", { runId: args.runId, teamId: args.teamId });
        return { ok: false, reason: "panel_unsupported_version" };
      }

      const panel = panelParse.panel;
      if (panel.status !== "open") {
        return { ok: false, reason: "panel_cancelled" };
      }
      if (panel.revision !== args.panelRevision) {
        return { ok: false, reason: "panel_stale" };
      }
      if (!panel.reviewerUserIds.includes(args.reviewerUserId)) {
        return { ok: false, reason: "reviewer_not_assigned" };
      }

      // Fresh, in-transaction re-check of current team eligibility (§C11) —
      // deliberately re-reads the TEAM document, not just the panel's own
      // (possibly stale-relative-to-team-membership) reviewer list.
      if (!teamSnap.exists) {
        return { ok: false, reason: "reviewer_not_assigned" };
      }
      const team = parseTeamDoc(args.teamId, teamSnap.data()!);
      const role = memberRole(args.reviewerUserId, team);
      if (!role || !ELIGIBLE_PANEL_REVIEWER_ROLES.has(role)) {
        return { ok: false, reason: "reviewer_not_assigned" };
      }

      const nextVote = buildAdaptiveHumanReviewVote({
        teamId: args.teamId,
        runId: args.runId,
        panelRevision: args.panelRevision,
        reviewerUserId: args.reviewerUserId,
        status: args.status,
        comment: args.comment,
        conditions: args.conditions,
        now,
      });

      if (voteSnap.exists) {
        const existingParse = parseAdaptiveHumanReviewVote(voteSnap.data(), {
          expectedTeamId: args.teamId,
          expectedRunId: args.runId,
          expectedPanelRevision: args.panelRevision,
          expectedReviewerUserId: args.reviewerUserId,
        });
        if (existingParse.status !== "valid") {
          return { ok: false, reason: "vote_malformed" };
        }
        if (isSemanticallyEquivalentAdaptiveHumanReviewVote(existingParse.vote, nextVote)) {
          return { ok: true, vote: existingParse.vote, submissionStatus: "already_submitted" };
        }
        logAdaptiveGovernanceEvent("vote_conflict", { runId: args.runId, teamId: args.teamId, panelRevision: args.panelRevision });
        return { ok: false, reason: "vote_conflict" };
      }

      txn.set(voteRef, nextVote);

      logAdaptiveGovernanceEvent("vote_submitted", { runId: args.runId, teamId: args.teamId, panelRevision: args.panelRevision });
      return { ok: true, vote: nextVote, submissionStatus: "submitted" };
    });
  } catch {
    logger.warn("[firestore/runs] submitAdaptiveHumanReviewVote transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

// ============================================
// Transactional Multi-Reviewer Finalization, Part E
// (docs/governance-decision-receipts-design.md §29-§33)
// ============================================

export type FinalizeAdaptiveHumanReviewPanelFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "governance_stale"
  | "not_pending"
  | "panel_absent"
  | "panel_malformed"
  | "panel_unsupported_version"
  | "panel_cancelled"
  | "panel_stale"
  | "vote_malformed"
  | "vote_unsupported_version"
  | "quorum_not_met"
  | "panel_deadlocked"
  | "aggregation_invalid"
  | "inconsistent_finalization_state"
  | "panel_already_finalized"
  | "write_failed";

export type FinalizeAdaptiveHumanReviewPanelResult =
  | {
      ok: true;
      submissionStatus: "finalized" | "already_finalized";
      panel: AdaptiveHumanReviewPanelV1;
      humanReview: GovernanceRecordV1["humanReview"];
      priorHumanReviewStatus: HumanReviewStatus;
      schemaId: GovernanceRecordV1["schemaId"];
      answerShape: GovernanceRecordV1["answerShape"];
      /** The pre-finalization panel's submitted-vote count — read fresh even on the idempotent ("already_finalized") branch (a few cheap, bounded extra reads) so secondary-artifact callers never have to approximate it. */
      submittedCount: number;
    }
  | { ok: false; reason: FinalizeAdaptiveHumanReviewPanelFailureReason; submittedCount?: number; quorum?: number };

/**
 * The transactional finalization write (§E5-§E10). Re-reads and
 * re-validates EVERYTHING fresh inside the transaction, exactly like every
 * other adaptive-governance transaction in this file.
 *
 * VOTE-SET CONSISTENCY / ATOMICITY STRATEGY (§E5's own "critical issue",
 * §E6, §E19) — resolved WITHOUT any collection query: vote document
 * references are built DETERMINISTICALLY from `panel.reviewerUserIds`
 * (bounded ≤9, §30) and `panel.revision`, via the SAME
 * `buildAdaptiveHumanReviewVoteId()` used by vote submission — then each
 * is read via `txn.get()` individually (`Promise.all`), exactly mirroring
 * the read-side pattern already used by `GET .../votes` and the vote
 * submission transaction itself. This sidesteps any question of whether
 * the current Firestore Admin SDK/repository version supports
 * transaction-safe collection QUERIES at all — no query is ever attempted,
 * so the question never arises. Atomicity is achieved by Firestore's own,
 * already-relied-upon transaction contract: reading a document via
 * `txn.get()` — REGARDLESS of whether it exists at read time — registers
 * it as a dependency of this transaction; if ANY of those documents (the
 * run, the panel, or any one of the up-to-9 vote docs) is written by a
 * DIFFERENT transaction before this one commits, the Admin SDK
 * automatically retries this transaction, which then re-reads everything
 * fresh. This is the SAME guarantee every other transaction in this file
 * already depends on (e.g. the assignment/panel-config transactions'
 * "re-read fresh, closes the race" property) — no new SDK capability is
 * required, and none was invoked.
 *
 * A concrete consequence: a vote submitted concurrently with an in-flight
 * finalization attempt will cause the finalization transaction to observe
 * either (a) the vote's document not yet existing (if the vote transaction
 * hasn't committed yet — Firestore's isolation guarantees this
 * transaction never sees a partial/uncommitted write) or (b) a retry that
 * re-reads the now-fresh vote set including the new vote — never a torn or
 * partially-consistent read. Symmetrically, a vote submission racing
 * against an in-flight finalization observes the panel's `status` and
 * `revision` fresh on ITS OWN retry, so it will fail closed once the panel
 * finalizes (`panel_cancelled`-shaped rejection, since `status !== "open"`)
 * rather than silently succeeding against an already-decided panel.
 *
 * IDEMPOTENCY (§E10): if the panel is ALREADY `"finalized"`, this function
 * never recomputes or re-aggregates anything — it compares the CALLER's
 * `expectedPanelRevision` against the panel's own pre-finalization
 * revision (`panel.revision - 1`, since finalization always increments
 * revision by exactly 1, §E9) and either returns the ALREADY-STORED
 * finalization as an idempotent success (verifying `governanceRecord.humanReview`
 * is genuinely consistent with it first) or `panel_stale` if the caller's
 * view predates a DIFFERENT already-completed finalization. If the two
 * disagree in a way that isn't explained by simple staleness — e.g.
 * `humanReview` is still reviewable despite the panel claiming finalized,
 * or `humanReview`'s own stored provenance doesn't match the panel's
 * stored outcome — this fails closed as `inconsistent_finalization_state`
 * rather than ever guessing or silently overwriting either side.
 */
export async function finalizeAdaptiveHumanReviewPanel(args: {
  runId: string;
  teamId: string;
  actorUserId: string;
  expectedPanelRevision: number;
  expectedGovernanceUpdatedAt: string;
  now?: string;
}): Promise<FinalizeAdaptiveHumanReviewPanelResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<FinalizeAdaptiveHumanReviewPanelResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const panelRef = runRef.collection("humanReviewPanel").doc("current");

      const [runSnap, panelSnap] = await Promise.all([txn.get(runRef), txn.get(panelRef)]);

      if (!runSnap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const govParse = parseGovernanceRecord(runSnap.data()?.governanceRecord);
      if (!govParse.ok) {
        if (govParse.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (govParse.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }
      const record = govParse.record;

      const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, {
        expectedTeamId: args.teamId,
        expectedRunId: args.runId,
      });
      if (panelParse.status === "absent") return { ok: false, reason: "panel_absent" };
      if (panelParse.status === "malformed") {
        logAdaptiveGovernanceEvent("malformed_record_detected", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_malformed" });
        return { ok: false, reason: "panel_malformed" };
      }
      if (panelParse.status === "unsupported_version") {
        logAdaptiveGovernanceEvent("unsupported_schema_version_detected", { runId: args.runId, teamId: args.teamId });
        return { ok: false, reason: "panel_unsupported_version" };
      }
      const panel = panelParse.panel;

      // ---- Idempotency (§E10) ----
      if (panel.status === "finalized") {
        const preFinalizationRevision = panel.revision - 1;
        if (preFinalizationRevision !== args.expectedPanelRevision) {
          return { ok: false, reason: "panel_stale" };
        }

        // Multi-Reviewer Owner Override, Part F (§F5/§F7) — a panel
        // finalized via owner override was NOT produced by this function,
        // and never will be mistaken for its own output: `decidedVia` on
        // an override-finalized humanReview is always
        // `"multi_reviewer_owner_override"`, never `"multi_reviewer_panel"`,
        // so the aggregation-specific consistency check below would
        // otherwise (correctly, but misleadingly) report this as
        // `inconsistent_finalization_state` — implying corruption rather
        // than "already decided, just via a different valid path." Checked
        // via the panel's own `finalizedVia` (not `decidedVia`) so a
        // pre-Part-F legacy finalized panel (no `finalizedVia` at all)
        // still falls through unchanged to the exact same check as before.
        if (panel.finalizedVia === "owner_override") {
          return { ok: false, reason: "panel_already_finalized" };
        }

        const consistent =
          !isHumanReviewStatusReviewable(record.humanReview.status) &&
          record.humanReview.decidedVia === "multi_reviewer_panel" &&
          record.humanReview.status === panel.finalStatus &&
          record.humanReview.panelRevision === preFinalizationRevision;
        if (!consistent) {
          logger.warn("[firestore/runs] finalizeAdaptiveHumanReviewPanel found an inconsistent already-finalized state", { runId: args.runId });
          return { ok: false, reason: "inconsistent_finalization_state" };
        }

        // Re-read the (immutable, still-existing) pre-finalization-revision
        // votes fresh — cheap, bounded (≤9) — purely so secondary-artifact
        // callers on this idempotent-retry path get an ACCURATE
        // submittedCount rather than an approximation.
        const idemVoteRefs = panel.reviewerUserIds.map((reviewerUserId) =>
          runRef.collection("humanReviewVotes").doc(buildAdaptiveHumanReviewVoteId(preFinalizationRevision, reviewerUserId))
        );
        const idemVoteSnaps = await Promise.all(idemVoteRefs.map((ref) => txn.get(ref)));
        const idemSubmittedCount = idemVoteSnaps.filter((s) => s.exists).length;

        return {
          ok: true,
          submissionStatus: "already_finalized",
          panel,
          humanReview: record.humanReview,
          priorHumanReviewStatus: "unreviewed", // convention matches the existing repair services' own documented choice — see adaptiveHumanReviewAssignmentRepair.ts
          schemaId: record.schemaId,
          answerShape: record.answerShape,
          submittedCount: idemSubmittedCount,
        };
      }

      if (panel.status === "cancelled") {
        return { ok: false, reason: "panel_cancelled" };
      }

      // panel.status === "open" from here on.

      // Checked BEFORE the reviewable-status check, mirroring
      // submitAdaptiveHumanReview()'s own established precedent (§21.7) —
      // a stale-data error is never masked by a terminal-status error the
      // caller's own UI hasn't seen yet.
      if (record.updatedAt !== args.expectedGovernanceUpdatedAt) {
        logAdaptiveGovernanceEvent("finalization_stale", { runId: args.runId, teamId: args.teamId, failureCategory: "governance_stale" });
        return { ok: false, reason: "governance_stale" };
      }
      if (!isHumanReviewStatusReviewable(record.humanReview.status)) {
        return { ok: false, reason: "not_pending" };
      }
      if (panel.revision !== args.expectedPanelRevision) {
        logAdaptiveGovernanceEvent("finalization_stale", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_stale" });
        return { ok: false, reason: "panel_stale" };
      }

      // ---- Deterministic current-revision vote reads (§E5/§E6/§E19) ----
      const voteRefs = panel.reviewerUserIds.map((reviewerUserId) =>
        runRef.collection("humanReviewVotes").doc(buildAdaptiveHumanReviewVoteId(panel.revision, reviewerUserId))
      );
      const voteSnaps = await Promise.all(voteRefs.map((ref) => txn.get(ref)));

      const votes: AdaptiveHumanReviewVoteV1[] = [];
      for (const snap of voteSnaps) {
        if (!snap.exists) continue; // this reviewer has not voted yet — not an error
        const voteParse = parseAdaptiveHumanReviewVote(snap.data(), {
          expectedTeamId: args.teamId,
          expectedRunId: args.runId,
          expectedPanelRevision: panel.revision,
        });
        if (voteParse.status === "unsupported_version") return { ok: false, reason: "vote_unsupported_version" };
        if (voteParse.status !== "valid") return { ok: false, reason: "vote_malformed" };
        votes.push(voteParse.vote);
      }

      // ---- Aggregation, recomputed fresh from the votes just read (§E5) ----
      const aggregate = aggregateAdaptiveReviewVotes({ panel, votes });

      if (aggregate.status === "waiting") {
        logAdaptiveGovernanceEvent("finalization_waiting", { runId: args.runId, teamId: args.teamId, panelRevision: panel.revision });
        return { ok: false, reason: "quorum_not_met", submittedCount: aggregate.submittedCount, quorum: aggregate.quorum };
      }
      if (aggregate.status === "deadlocked") {
        logAdaptiveGovernanceEvent("finalization_deadlocked", { runId: args.runId, teamId: args.teamId, panelRevision: panel.revision });
        return { ok: false, reason: "panel_deadlocked" };
      }
      if (aggregate.status === "invalid") {
        // Should not be reachable — this transaction's own panel/vote
        // validation above already mirrors what the pure engine itself
        // re-checks. Fails closed rather than trusting an inconsistency.
        logger.warn("[firestore/runs] aggregateAdaptiveReviewVotes unexpectedly returned invalid inside finalization", { runId: args.runId, reason: aggregate.reason });
        return { ok: false, reason: "aggregation_invalid" };
      }

      // ---- Canonical build (§E8) ----
      const finalDecisionId = buildAdaptivePanelFinalDecisionId(
        args.teamId,
        args.runId,
        panel.revision,
        aggregate.finalStatus,
        aggregate.policyVersion
      );
      const conditions =
        aggregate.finalStatus === "approved_with_conditions" ? buildFinalConditionsUnion(votes, aggregate.supportingReviewerUserIds) : undefined;

      const humanReview = buildFinalizedMultiReviewerHumanReview({
        finalStatus: aggregate.finalStatus,
        finalizingActorUid: args.actorUserId,
        reviewedAt: now,
        conditions,
        panelRevision: panel.revision,
        aggregationPolicyVersion: aggregate.policyVersion,
        supportingReviewerCount: aggregate.supportingReviewerUserIds.length,
      });

      const finalizedPanel = buildFinalizedAdaptiveHumanReviewPanel({
        current: panel,
        actorUserId: args.actorUserId,
        now,
        finalStatus: aggregate.finalStatus,
        finalDecisionId,
        aggregationPolicyVersion: aggregate.policyVersion,
      });

      const priorHumanReviewStatus = record.humanReview.status;

      // ---- Commit — writes ONLY governanceRecord.humanReview/.updatedAt
      // and the panel document. Votes, teamRuns, assignment, and every
      // other collection are untouched. ----
      txn.update(runRef, {
        "governanceRecord.humanReview": humanReview,
        "governanceRecord.updatedAt": now,
      });
      txn.set(panelRef, finalizedPanel);

      logAdaptiveGovernanceEvent("finalization_completed", {
        runId: args.runId,
        teamId: args.teamId,
        panelRevision: finalizedPanel.revision,
        statusCategory: aggregate.finalStatus,
        aggregationPolicyVersion: aggregate.policyVersion,
      });
      return {
        ok: true,
        submissionStatus: "finalized",
        panel: finalizedPanel,
        humanReview,
        priorHumanReviewStatus,
        schemaId: record.schemaId,
        answerShape: record.answerShape,
        submittedCount: votes.length,
      };
    });
  } catch {
    logger.warn("[firestore/runs] finalizeAdaptiveHumanReviewPanel transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

export type AdaptivePanelFinalizationHistoryWriteResult = { status: "recorded" | "already_exists" | "failed" };

/**
 * §E12 — immutable, create-only, metadata-only panel finalization history
 * at `runs/{runId}/humanReviewPanelHistory/{eventId}`, mirroring
 * `createAdaptiveHumanReviewAssignmentHistory`'s exact create-only /
 * `ALREADY_EXISTS`-is-idempotent-success pattern.
 */
export async function createAdaptivePanelFinalizationHistory(
  runId: string,
  entry: AdaptivePanelFinalizationHistoryV1
): Promise<AdaptivePanelFinalizationHistoryWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }
  try {
    await adminDb.collection("runs").doc(runId).collection("humanReviewPanelHistory").doc(entry.eventId).create(entry);
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    logger.warn("[firestore/runs] Failed to create adaptive panel finalization history entry", { runId, eventId: entry.eventId });
    return { status: "failed" };
  }
}

export type AdaptivePanelFinalizationGovernanceEventWriteResult = { status: "recorded" | "already_exists" | "failed" };

/**
 * §E13 — a NEW, genuinely idempotent `governanceEvents` writer
 * (`.doc(id).create()`), deliberately NOT reusing `writeAdaptiveHumanReviewEvent`'s
 * `.add()`-based (random ID, non-idempotent) pattern — that legacy writer
 * and its existing callers remain completely untouched (§27.8's own
 * documented precedent: distinct collections/writers for distinct
 * concerns are never silently unified). The deterministic ID reuses the
 * SAME `finalDecisionId` every other finalization artifact shares (§E3).
 */
export async function writeAdaptivePanelFinalizationGovernanceEvent(args: {
  runId: string;
  teamId: string;
  schemaId: GovernanceRecordV1["schemaId"];
  answerShape: GovernanceRecordV1["answerShape"];
  finalStatus: string;
  finalDecisionId: string;
  aggregationPolicyVersion: number;
  supportingReviewerCount: number;
  actorUserId: string;
  finalizedAt: string;
}): Promise<AdaptivePanelFinalizationGovernanceEventWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }
  const eventId = `panel-finalized:${args.finalDecisionId}`;
  try {
    await adminDb
      .collection("runs")
      .doc(args.runId)
      .collection("governanceEvents")
      .doc(eventId)
      .create({
        action: "multi_reviewer_panel_finalized",
        byUid: args.actorUserId,
        at: args.finalizedAt,
        teamId: args.teamId,
        schemaId: args.schemaId,
        answerShape: args.answerShape,
        finalStatus: args.finalStatus,
        decisionId: args.finalDecisionId,
        aggregationPolicyVersion: args.aggregationPolicyVersion,
        supportingReviewerCount: args.supportingReviewerCount,
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    logger.warn("[firestore/runs] Failed to write multi-reviewer panel finalization governance event", { runId: args.runId });
    return { status: "failed" };
  }
}

export type OverrideAdaptiveHumanReviewPanelFailureReason =
  | "firestore_unavailable"
  | "run_missing"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  | "governance_stale"
  | "not_pending"
  | "panel_absent"
  | "panel_malformed"
  | "panel_unsupported_version"
  | "panel_cancelled"
  | "panel_stale"
  | "panel_already_finalized"
  | "inconsistent_finalization_state"
  | "write_failed";

export type OverrideAdaptiveHumanReviewPanelResult =
  | {
      ok: true;
      submissionStatus: "overridden" | "already_overridden";
      panel: AdaptiveHumanReviewPanelV1;
      humanReview: GovernanceRecordV1["humanReview"];
      priorHumanReviewStatus: HumanReviewStatus;
      schemaId: GovernanceRecordV1["schemaId"];
      answerShape: GovernanceRecordV1["answerShape"];
    }
  | { ok: false; reason: OverrideAdaptiveHumanReviewPanelFailureReason };

/**
 * Multi-Reviewer Owner Override, Part F (§34/§F5). Re-reads and
 * re-validates everything fresh inside the transaction, exactly like
 * `finalizeAdaptiveHumanReviewPanel` above. The one deliberate structural
 * difference: this transaction NEVER reads the `humanReviewVotes`
 * subcollection at all — an override's entire outcome is the owner's
 * already-validated request (`status`/`justification`/`conditions`), not
 * an aggregation over votes, so votes are neither a precondition nor an
 * input (§F5's own explicit instruction: "Do not read, mutate, delete, or
 * aggregate votes as an override precondition").
 *
 * IDEMPOTENCY (§F7): if the panel is already `"finalized"`, this function
 * computes what the override decision ID WOULD be for the caller's exact
 * request (against the panel's pre-finalization revision) and compares it
 * to the panel's actually-stored `finalDecisionId`. An exact match (and
 * `finalizedVia === "owner_override"`) is an idempotent retry — returned as
 * success without re-writing anything. Any mismatch — a panel finalized via
 * aggregation, via a DIFFERENT override request, or a stale caller view —
 * is `panel_already_finalized`/`panel_stale`, never silently overwritten.
 */
export async function overrideAdaptiveHumanReviewPanel(args: {
  runId: string;
  teamId: string;
  actorUserId: string;
  expectedPanelRevision: number;
  expectedGovernanceUpdatedAt: string;
  status: AdaptiveReviewFinalStatus;
  justification: string;
  conditions?: string[];
  now?: string;
}): Promise<OverrideAdaptiveHumanReviewPanelResult> {
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  try {
    return await adminDb.runTransaction<OverrideAdaptiveHumanReviewPanelResult>(async (txn) => {
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const panelRef = runRef.collection("humanReviewPanel").doc("current");

      const [runSnap, panelSnap] = await Promise.all([txn.get(runRef), txn.get(panelRef)]);

      if (!runSnap.exists) {
        return { ok: false, reason: "run_missing" };
      }

      const govParse = parseGovernanceRecord(runSnap.data()?.governanceRecord);
      if (!govParse.ok) {
        if (govParse.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (govParse.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }
      const record = govParse.record;

      const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, {
        expectedTeamId: args.teamId,
        expectedRunId: args.runId,
      });
      if (panelParse.status === "absent") return { ok: false, reason: "panel_absent" };
      if (panelParse.status === "malformed") {
        logAdaptiveGovernanceEvent("malformed_record_detected", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_malformed" });
        return { ok: false, reason: "panel_malformed" };
      }
      if (panelParse.status === "unsupported_version") {
        logAdaptiveGovernanceEvent("unsupported_schema_version_detected", { runId: args.runId, teamId: args.teamId });
        return { ok: false, reason: "panel_unsupported_version" };
      }
      const panel = panelParse.panel;

      // ---- Idempotency / already-finalized handling (§F7) ----
      if (panel.status === "finalized") {
        const preOverrideRevision = panel.revision - 1;
        if (preOverrideRevision !== args.expectedPanelRevision) {
          return { ok: false, reason: "panel_stale" };
        }

        const expectedOverrideDecisionId = buildAdaptivePanelOverrideDecisionId({
          teamId: args.teamId,
          runId: args.runId,
          panelRevision: preOverrideRevision,
          status: args.status,
          justification: args.justification,
          conditions: args.conditions,
        });

        if (panel.finalizedVia !== "owner_override" || panel.finalDecisionId !== expectedOverrideDecisionId) {
          return { ok: false, reason: "panel_already_finalized" };
        }

        const consistent =
          !isHumanReviewStatusReviewable(record.humanReview.status) &&
          record.humanReview.decidedVia === "multi_reviewer_owner_override" &&
          record.humanReview.status === panel.finalStatus &&
          record.humanReview.panelRevision === preOverrideRevision;
        if (!consistent) {
          logger.warn("[firestore/runs] overrideAdaptiveHumanReviewPanel found an inconsistent already-overridden state", { runId: args.runId });
          return { ok: false, reason: "inconsistent_finalization_state" };
        }

        return {
          ok: true,
          submissionStatus: "already_overridden",
          panel,
          humanReview: record.humanReview,
          priorHumanReviewStatus: "unreviewed", // convention matches finalizeAdaptiveHumanReviewPanel's own idempotent-retry choice
          schemaId: record.schemaId,
          answerShape: record.answerShape,
        };
      }

      if (panel.status === "cancelled") {
        return { ok: false, reason: "panel_cancelled" };
      }

      // panel.status === "open" from here on.

      // Checked BEFORE the reviewable-status check, mirroring
      // finalizeAdaptiveHumanReviewPanel's own established precedent.
      if (record.updatedAt !== args.expectedGovernanceUpdatedAt) {
        logAdaptiveGovernanceEvent("override_stale", { runId: args.runId, teamId: args.teamId, failureCategory: "governance_stale" });
        return { ok: false, reason: "governance_stale" };
      }
      if (!isHumanReviewStatusReviewable(record.humanReview.status)) {
        return { ok: false, reason: "not_pending" };
      }
      if (panel.revision !== args.expectedPanelRevision) {
        logAdaptiveGovernanceEvent("override_stale", { runId: args.runId, teamId: args.teamId, failureCategory: "panel_stale" });
        return { ok: false, reason: "panel_stale" };
      }

      // ---- Canonical build (§F5/§F6) — no vote reads at all. ----
      const finalDecisionId = buildAdaptivePanelOverrideDecisionId({
        teamId: args.teamId,
        runId: args.runId,
        panelRevision: panel.revision,
        status: args.status,
        justification: args.justification,
        conditions: args.conditions,
      });

      const humanReview = buildOverriddenMultiReviewerHumanReview({
        finalStatus: args.status,
        overridingOwnerUid: args.actorUserId,
        reviewedAt: now,
        justification: args.justification,
        conditions: args.conditions,
        panelRevision: panel.revision,
      });

      const overriddenPanel = buildOwnerOverriddenAdaptiveHumanReviewPanel({
        current: panel,
        actorUserId: args.actorUserId,
        now,
        finalStatus: args.status,
        finalDecisionId,
        aggregationPolicyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
      });

      const priorHumanReviewStatus = record.humanReview.status;

      // ---- Commit — writes ONLY governanceRecord.humanReview/.updatedAt
      // and the panel document. Votes, teamRuns, assignment, and every
      // other collection are untouched. ----
      txn.update(runRef, {
        "governanceRecord.humanReview": humanReview,
        "governanceRecord.updatedAt": now,
      });
      txn.set(panelRef, overriddenPanel);

      logAdaptiveGovernanceEvent("override_completed", {
        runId: args.runId,
        teamId: args.teamId,
        panelRevision: overriddenPanel.revision,
        statusCategory: args.status,
      });
      return {
        ok: true,
        submissionStatus: "overridden",
        panel: overriddenPanel,
        humanReview,
        priorHumanReviewStatus,
        schemaId: record.schemaId,
        answerShape: record.answerShape,
      };
    });
  } catch {
    logger.warn("[firestore/runs] overrideAdaptiveHumanReviewPanel transaction failed", { runId: args.runId });
    return { ok: false, reason: "write_failed" };
  }
}

export type AdaptivePanelOverrideHistoryWriteResult = { status: "recorded" | "already_exists" | "failed" };

/**
 * Multi-Reviewer Owner Override, Part F (§F8) — immutable, create-only,
 * metadata-only panel override history at
 * `runs/{runId}/humanReviewPanelHistory/{eventId}` — the SAME
 * subcollection `createAdaptivePanelFinalizationHistory` writes to,
 * distinguished by `eventType`/`eventId`, mirroring its exact
 * create-only / `ALREADY_EXISTS`-is-idempotent-success pattern.
 */
export async function createAdaptivePanelOverrideHistory(
  runId: string,
  entry: AdaptivePanelOverrideHistoryV1
): Promise<AdaptivePanelOverrideHistoryWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }
  try {
    await adminDb.collection("runs").doc(runId).collection("humanReviewPanelHistory").doc(entry.eventId).create(entry);
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    logger.warn("[firestore/runs] Failed to create adaptive panel override history entry", { runId, eventId: entry.eventId });
    return { status: "failed" };
  }
}

export type AdaptivePanelOverrideGovernanceEventWriteResult = { status: "recorded" | "already_exists" | "failed" };

/**
 * Multi-Reviewer Owner Override, Part F (§F8) — a NEW, genuinely
 * idempotent `governanceEvents` writer, mirroring
 * `writeAdaptivePanelFinalizationGovernanceEvent`'s exact pattern
 * (deterministic `.doc(id).create()`, same `finalDecisionId` reused as the
 * correlation key) but with a distinct `action` and event-ID prefix so an
 * override event can never be confused with an aggregation-finalization
 * event for the same run.
 */
export async function writeAdaptivePanelOverrideGovernanceEvent(args: {
  runId: string;
  teamId: string;
  schemaId: GovernanceRecordV1["schemaId"];
  answerShape: GovernanceRecordV1["answerShape"];
  finalStatus: string;
  finalDecisionId: string;
  overrideByUserId: string;
  finalizedAt: string;
}): Promise<AdaptivePanelOverrideGovernanceEventWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }
  const eventId = `panel-owner-overridden:${args.finalDecisionId}`;
  try {
    await adminDb
      .collection("runs")
      .doc(args.runId)
      .collection("governanceEvents")
      .doc(eventId)
      .create({
        action: "multi_reviewer_panel_owner_overridden",
        byUid: args.overrideByUserId,
        at: args.finalizedAt,
        teamId: args.teamId,
        schemaId: args.schemaId,
        answerShape: args.answerShape,
        finalStatus: args.finalStatus,
        decisionId: args.finalDecisionId,
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    logger.warn("[firestore/runs] Failed to write multi-reviewer panel owner-override governance event", { runId: args.runId });
    return { status: "failed" };
  }
}

/**
 * Mark run as error
 *
 * @param runId - Unique run identifier
 * @param errorMessage - Error message
 */
export async function markRunError(runId: string, errorMessage: string): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  await adminDb.collection("runs").doc(runId).update({
    status: "error",
    completedAt: Timestamp.now(),
    errorMessage,
  });

  console.log(`[firestore/runs] Marked run ${runId} as error: ${errorMessage}`);
}

