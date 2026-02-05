import { ModelId, ModelResult } from "@/lib/types";
import { CONNECTOR_MAP } from "@/lib/connectors";
import { isSuspiciouslyShort } from "@/lib/textLimits";

type ApiKeys = Partial<Record<ModelId, string | undefined>>;

/**
 * Run Panel Function
 * 
 * Orchestrates calling multiple AI models in parallel and returns results for each.
 * 
 * CRITICAL GUARANTEE: This function ALWAYS returns exactly one result per selected model.
 * - If a model succeeds → status: "ok" with rawText
 * - If a model fails → status: "error" with errorMessage
 * - No model ever silently disappears from results
 * 
 * IMPORTANT: Always attach the canonical PanelModelId (from lib/panelModels.ts) so the frontend
 * can color and label consistently. The modelId field in ModelResult must be one of:
 * "chatgpt" | "claude" | "grok" | "perplexity" | "gemini"
 * 
 * @param question - The user's question to ask all models
 * @param selectedModels - Array of model IDs to query (must be valid ModelId values matching PanelModelId)
 * @param apiKeys - Object mapping model IDs to their API keys
 * @returns Promise<ModelResult[]> - One result per selected model, guaranteed
 */
export async function runPanel(
  question: string,
  selectedModels: ModelId[],
  apiKeys: ApiKeys,
  context?: string | null
): Promise<ModelResult[]> {
  const normalizedQuestion = question.trim();
  const normalizedContext = context ? context.trim() : null;

  // Log which models are supposed to run (for debugging)
  console.log("[runPanel] Selected models:", selectedModels);
  console.log("[runPanel] API keys present:", {
    chatgpt: Boolean(apiKeys.chatgpt),
    claude: Boolean(apiKeys.claude),
    grok: Boolean(apiKeys.grok),
    perplexity: Boolean(apiKeys.perplexity),
    gemini: Boolean(apiKeys.gemini),
  });

  // Iterate over selectedModels directly and ensure every model gets a result
  // This guarantees that there is always one result per selected model
  // Models can fail but they never vanish—failures are encoded as status: "error"
  // 
  // IMPORTANT: Use Promise.allSettled to ensure we always get results for all models,
  // even if some fail. This guarantees finalization always happens.
  // Promise.allSettled ensures all model connectors run in parallel and we get results
  // for every model, regardless of success or failure.
  const settledResults = await Promise.allSettled(
    selectedModels.map(async (modelId) => {
      const startTime = Date.now();
      
      // Get connector from CONNECTOR_MAP
      // If no connector is found, return an error entry immediately
      const connector = CONNECTOR_MAP[modelId];
      
      if (!connector) {
        console.error(
          `[runPanel] No connector defined for modelId="${modelId}"`
        );
        return {
          modelId,
          status: "error" as const,
          rawText: null,
          latencyMs: 0,
        };
      }

      // Get API key for this model
      const apiKey = apiKeys[modelId];

      // Call connector in try/catch to handle any errors
      // Most connectors now return error results instead of throwing, but we keep try/catch
      // as a safety net for any unexpected errors that might still throw
      try {
        console.log(`[runPanel] Calling connector for model: ${modelId}`);
            const result = await connector(normalizedQuestion, normalizedContext, apiKey);
        
        // Verify the result has the correct modelId (safety check)
        if (result.modelId !== modelId) {
          console.warn(
            `[runPanel] Connector ${modelId} returned result with mismatched modelId: ${result.modelId}`
          );
        }
        
        // Validate response length for successful responses
        // Suspiciously short responses likely indicate refusals, errors, or superficial answers
        if (result.status === "ok" && result.rawText) {
          if (isSuspiciouslyShort(result.rawText)) {
            console.warn(
              `[runPanel] Model ${modelId} returned suspiciously short response (${result.rawText.split(/\s+/).length} words). ` +
              `This may indicate a refusal, error, or superficial answer that doesn't meet depth requirements.`
            );
            // Mark the response as potentially incomplete by adding a warning to the errorMessage
            // We don't change the status to "error" because the model did respond, but we want to flag it
            // The UI can check for this warning and display it appropriately
            result.errorMessage = "Unusually short answer – this model may have refused or returned less detail than requested.";
          }
        }
        
        // If connector returned an error result, return it as-is (no need to throw)
        // This ensures error messages are displayed cleanly in the UI
        return result;
      } catch (err: any) {
        // Safety net: if a connector unexpectedly throws (shouldn't happen with updated connectors),
        // catch it and return an error result with errorMessage set
        // IMPORTANT: errorMessage must always be a non-empty string if an error occurs
        console.error(
          `[runPanel] Unexpected error while calling model "${modelId}":`,
          err
        );
        
        // Extract error message from the thrown error
        // This ensures we capture meaningful error messages
        const message = String(err?.message || err || "Unknown error");
        
        return {
          modelId,
          status: "error" as const,
          rawText: null,
          errorMessage: message, // Set errorMessage so UI can display the real error
          latencyMs: Date.now() - startTime,
          tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage, even on error
        };
      }
    })
  );

  // Process Promise.allSettled results - convert to ModelResult[]
  // This ensures we always have one result per selected model, even if some failed
  const results: ModelResult[] = settledResults.map((settled, index) => {
    const modelId = selectedModels[index];
    
    if (settled.status === "fulfilled") {
      // Model call succeeded - return the result as-is
      return settled.value;
    } else {
      // Model call was rejected (unexpected error in connector)
      // This should rarely happen since connectors catch errors internally,
      // but we handle it defensively
      console.error(`[runPanel] Promise rejected for model ${modelId}:`, settled.reason);
      return {
        modelId,
        status: "error" as const,
        rawText: null,
        errorMessage: String(settled.reason?.message || settled.reason || "Unexpected error"),
        latencyMs: 0,
        tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage
      };
    }
  });

  // Log completion and verify all models are present
  console.log(`[runPanel] All model calls completed. Results count: ${results.length}`);
  console.log(`[runPanel] Results summary:`, results.map(r => ({ modelId: r.modelId, status: r.status })));
  
  // CRITICAL: Verify that all selected models are present in results
  // This is a safety check - with the new map-based approach, this should never happen
  // But we check anyway to catch any bugs
  const resultModelIds = new Set(results.map(r => r.modelId));
  const missingModels = selectedModels.filter(id => !resultModelIds.has(id));
  if (missingModels.length > 0) {
    console.error(`[runPanel] ERROR: Missing results for models: ${missingModels.join(", ")}`);
    console.error(`[runPanel] Selected models: ${selectedModels.join(", ")}`);
    console.error(`[runPanel] Result model IDs: ${Array.from(resultModelIds).join(", ")}`);
    // Add error results for missing models to ensure they appear in UI
    // This should never happen with the new map-based approach, but we handle it anyway
    missingModels.forEach(modelId => {
      results.push({
        modelId,
        status: "error",
        rawText: `No result returned from ${modelId} connector. This should not happen.`,
        latencyMs: 0,
        tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage
      });
    });
  }
  
  // Ensure results are in the same order as selectedModels for consistency
  const orderedResults = selectedModels.map(modelId => 
    results.find(r => r.modelId === modelId)!
  );
  
  return orderedResults;
}

