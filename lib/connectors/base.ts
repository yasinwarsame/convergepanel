/**
 * Base Connector Class
 * 
 * This is the abstract base class for all LLM model connectors (ChatGPT, Claude, etc.).
 * It provides common functionality that all connectors share:
 * - API key retrieval from Firestore (with env var fallback)
 * - Mock response generation when keys are missing
 * 
 * Each specific model connector (chatgpt.ts, claude.ts, etc.) extends this class
 * and implements the sendPrompt() method with model-specific API calls.
 */

import { ModelConnector, ModelStatus } from "@/lib/types";
import { firestoreKeyStore } from "@/lib/keyStore.firestore";

/**
 * BaseConnector Abstract Class
 * 
 * All model connectors must extend this class and implement:
 * - id: The model identifier
 * - displayName: Human-readable model name
 * - sendPrompt(): Model-specific API call implementation
 */
export abstract class BaseConnector implements ModelConnector {
  // Model identifier (must be one of the supported models)
  abstract id: "chatgpt" | "claude" | "grok" | "perplexity";
  
  // Human-readable name for UI display
  abstract displayName: string;

  /**
   * Get API key for this model
   * 
   * Retrieves the API key from Firestore (or env vars as fallback).
   * Returns null if no key is configured, which triggers mock response.
   * 
   * @returns API key string or null if not configured
   */
  protected async getApiKey(): Promise<string | null> {
    // Use Firestore-backed key store (with env var fallback)
    // Firestore keys take precedence over environment variables
    return await firestoreKeyStore.getKey(this.id);
  }

  /**
   * Generate a mock response when API key is missing
   * 
   * This allows the app to work even when keys aren't configured,
   * showing a helpful message to the user.
   * 
   * @returns Mock response object with status "ok" and informative message
   */
  protected getMockResponse(): {
    status: ModelStatus;
    rawText: string | null;
    latencyMs: number;
  } {
    return {
      status: "ok" as const,
      rawText: `[Mock response — configure ${this.id.toUpperCase()} API key to enable live output]`,
      // Simulate realistic latency (100-300ms)
      latencyMs: Math.floor(Math.random() * 200) + 100,
    };
  }

  /**
   * Send a prompt to the LLM model
   * 
   * This is the main method that each connector must implement.
   * It should:
   * 1. Get the API key (using getApiKey())
   * 2. If no key, return mock response
   * 3. Make API call to the model
   * 4. Handle errors (timeout, rate limit, etc.)
   * 5. Return standardized response format
   * 
   * @param question - User's question/prompt
   * @param systemWrapper - System message to guide model behavior
   * @returns Response with status, text, and latency
   */
  abstract sendPrompt(
    question: string,
    systemWrapper: string
  ): Promise<{
    status: ModelStatus;
    rawText: string | null;
    latencyMs: number;
  }>;
}

