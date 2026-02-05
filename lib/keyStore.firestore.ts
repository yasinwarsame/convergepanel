/**
 * Firestore-Backed API Key Store
 * 
 * This module manages API keys for LLM models (ChatGPT, Claude, Grok, Perplexity).
 * Keys are stored in Firestore and cached in memory for performance.
 * 
 * Key Priority (highest to lowest):
 * 1. Firestore database (set via Admin UI)
 * 2. Environment variables (fallback)
 */

import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY } from "@/lib/env";

/**
 * IMPORTANT: This is server-only code. Keys are never exposed to the client.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import type { ModelId } from "./types";

// Firestore document path where API keys are stored
// Only admins can read/write this document (enforced by Firestore security rules)
const MODEL_KEYS_DOC = "appConfig/modelKeys";

/**
 * FirestoreKeyStore Class
 * 
 * Manages API keys with the following features:
 * - Caches keys in memory to avoid repeated Firestore reads
 * - Falls back to environment variables if Firestore keys are missing
 * - Only loads from Firestore once per server instance
 */
class FirestoreKeyStore {
  // In-memory cache of API keys (keyed by model ID)
  private cache: Map<ModelId, string | null> = new Map();
  
  // Flag to track if we've loaded keys from Firestore yet
  private cacheLoaded = false;

  /**
   * Load keys from Firestore into memory cache
   * 
   * This is called lazily on first key access. Subsequent calls return immediately
   * if cache is already loaded (performance optimization).
   * 
   * If Firestore read fails, we continue with empty cache and will fall back
   * to environment variables. This ensures the app works even if Firestore
   * is unavailable or Admin SDK is not configured.
   */
  private async loadCache() {
    // Don't reload if already loaded
    if (this.cacheLoaded) return;

    try {
      // Read the modelKeys document from Firestore
      // Uses Admin SDK which bypasses security rules
      if (!adminDb) {
        throw new Error("Firestore is not available");
      }
      const doc = await adminDb.doc(MODEL_KEYS_DOC).get();
      const data = doc.data() || {};

      // Store each model's key in cache (null if not set)
      this.cache.set("chatgpt", data.chatgpt || null);
      this.cache.set("claude", data.claude || null);
      this.cache.set("grok", data.grok || null);
      this.cache.set("perplexity", data.perplexity || null);

      // Mark cache as loaded to prevent redundant reads
      this.cacheLoaded = true;
    } catch (error: any) {
      // Log error but don't throw - fall back to env vars
      // This allows the app to work even if:
      // - Firestore is unavailable
      // - Admin SDK is not configured
      // - Network issues
      console.warn("Could not load keys from Firestore, falling back to environment variables:", error.message);
      // Continue with empty cache - will fall back to env vars
      // This allows the app to work even if Firestore is temporarily unavailable
      this.cacheLoaded = true; // Mark as loaded to prevent retry loops
    }
  }

  /**
   * Get API key for a specific model
   * 
   * Priority order:
   * 1. Check Firestore cache (if loaded)
   * 2. Fall back to environment variables
   * 
   * @param modelId - The model identifier (chatgpt, claude, grok, or perplexity)
   * @returns API key string, or null if not configured
   */
  async getKey(modelId: ModelId): Promise<string | null> {
    // Ensure cache is loaded (lazy loading)
    await this.loadCache();

    // Check Firestore cache first
    const cached = this.cache.get(modelId);
    if (cached !== undefined && cached !== null) {
      // Key found in Firestore
      return cached;
    }

    // Fallback to environment variables
    // This allows keys to be set via .env.local for development
    // Import from centralized env module instead of accessing process.env directly
    const envKeyMap: Record<ModelId, string | undefined> = {
      chatgpt: OPENAI_API_KEY,
      claude: ANTHROPIC_API_KEY,
      grok: XAI_API_KEY,
      perplexity: PERPLEXITY_API_KEY,
      gemini: GEMINI_API_KEY,
    };

    const envKey = envKeyMap[modelId];
    // Return env key if it exists and is not empty
    return envKey && envKey.trim() ? envKey : null;
  }
}

/**
 * Singleton instance of FirestoreKeyStore
 * 
 * Exporting a single instance ensures:
 * - Cache is shared across all requests
 * - Firestore is only read once per server instance
 * - Consistent behavior throughout the application
 */
export const firestoreKeyStore = new FirestoreKeyStore();

