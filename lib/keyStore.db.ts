/**
 * Shared library module (keyStore.db.ts): domain logic used by API routes and UI.
 */

import "server-only";
import { prisma } from "./db";
import type { ModelId } from "./types";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY } from "@/lib/env";

/**
 * Database-backed key store (replaces file-based keyStore)
 * Falls back to environment variables if database keys are not set
 */
class DatabaseKeyStore {
  private cache: Map<ModelId, string | null> = new Map();
  private cacheLoaded = false;

  /**
   * Load keys from database into cache
   */
  private async loadCache() {
    if (this.cacheLoaded) return;

    try {
      const keys = await prisma.apiKey.findMany();
      keys.forEach((key) => {
        this.cache.set(key.modelId as ModelId, key.keyValue);
      });
      this.cacheLoaded = true;
    } catch (error) {
      console.error("Error loading keys from database:", error);
      // Continue with empty cache - will fall back to env vars
    }
  }

  /**
   * Get API key for a model
   * Priority: Database > Environment Variables
   */
  async getKey(modelId: ModelId): Promise<string | null> {
    await this.loadCache();

    // Check database cache first
    const cached = this.cache.get(modelId);
    if (cached !== undefined) {
      return cached;
    }

    // Fallback to environment variables
    // Import from centralized env module instead of accessing process.env directly
    const envKeyMap: Record<ModelId, string | undefined> = {
      chatgpt: OPENAI_API_KEY,
      claude: ANTHROPIC_API_KEY,
      grok: XAI_API_KEY,
      perplexity: PERPLEXITY_API_KEY,
      gemini: GEMINI_API_KEY,
    };

    const envKey = envKeyMap[modelId];
    return envKey && envKey.trim() ? envKey : null;
  }

  /**
   * Set API key in database
   */
  async setKey(modelId: ModelId, value: string | null): Promise<void> {
    try {
      if (value) {
        // Upsert key
        await prisma.apiKey.upsert({
          where: { modelId },
          update: { keyValue: value, updatedAt: new Date() },
          create: { modelId, keyValue: value },
        });
        this.cache.set(modelId, value);
      } else {
        // Delete key
        await prisma.apiKey.deleteMany({ where: { modelId } });
        this.cache.set(modelId, null);
      }
    } catch (error) {
      console.error(`Error setting key for ${modelId}:`, error);
      throw error;
    }
  }

  /**
   * Set multiple keys at once
   */
  async setKeys(keys: Partial<Record<ModelId, string | null>>): Promise<void> {
    const updates = Object.entries(keys).map(([modelId, value]) =>
      this.setKey(modelId as ModelId, value || null)
    );
    await Promise.all(updates);
  }

  /**
   * Get all keys status
   */
  async getKeysStatus(): Promise<
    Record<ModelId, { configured: boolean; masked: string }>
  > {
    await this.loadCache();

    const modelIds: ModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
    const status: Record<ModelId, { configured: boolean; masked: string }> = {
      chatgpt: { configured: false, masked: "" },
      claude: { configured: false, masked: "" },
      grok: { configured: false, masked: "" },
      perplexity: { configured: false, masked: "" },
      gemini: { configured: false, masked: "" },
    };

    for (const modelId of modelIds) {
      const key = await this.getKey(modelId);
      status[modelId] = {
        configured: !!key,
        masked: this.maskKey(key),
      };
    }

    return status;
  }

  /**
   * Mask key for display (shows first 4 and last 4 chars)
   */
  private maskKey(key: string | null): string {
    if (!key) return "";
    if (key.length <= 8) return "••••••••";
    return key.substring(0, 4) + "••••••••" + key.substring(key.length - 4);
  }

  /**
   * Get all keys (for internal use only)
   */
  async getAllKeys(): Promise<Record<ModelId, string | null>> {
    await this.loadCache();

    const modelIds: ModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
    const keys: Record<ModelId, string | null> = {
      chatgpt: null,
      claude: null,
      grok: null,
      perplexity: null,
      gemini: null,
    };

    for (const modelId of modelIds) {
      keys[modelId] = await this.getKey(modelId);
    }

    return keys;
  }
}

// Singleton instance
export const dbKeyStore = new DatabaseKeyStore();

