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

