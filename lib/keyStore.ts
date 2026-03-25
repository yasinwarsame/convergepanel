/**
 * Shared library module (keyStore.ts): domain logic used by API routes and UI.
 */

import "server-only";
import fs from "fs";
import path from "path";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY } from "@/lib/env";

type ModelId = "chatgpt" | "claude" | "grok" | "perplexity";

interface KeyStore {
  chatgpt: string | null;
  claude: string | null;
  grok: string | null;
  perplexity: string | null;
}

class KeyStoreManager {
  private keys: KeyStore = {
    chatgpt: null,
    claude: null,
    grok: null,
    perplexity: null,
  };

  private dataDir = path.join(process.cwd(), ".data");
  private keysFile = path.join(this.dataDir, "keys.json");

  constructor() {
    this.loadFromEnv();
    this.loadFromFile();
  }

  // Load keys from environment variables (fallback)
  // Import from centralized env module instead of accessing process.env directly
  private loadFromEnv() {
    this.keys.chatgpt = OPENAI_API_KEY || null;
    this.keys.claude = ANTHROPIC_API_KEY || null;
    this.keys.grok = XAI_API_KEY || null;
    this.keys.perplexity = PERPLEXITY_API_KEY || null;
  }

  // Load keys from JSON file (dev persistence)
  private loadFromFile() {
    try {
      if (fs.existsSync(this.keysFile)) {
        const data = fs.readFileSync(this.keysFile, "utf-8");
        const savedKeys = JSON.parse(data) as KeyStore;
        
        // Only override if saved keys exist (don't overwrite env vars with null)
        Object.keys(savedKeys).forEach((key) => {
          const modelId = key as ModelId;
          if (savedKeys[modelId]) {
            this.keys[modelId] = savedKeys[modelId];
          }
        });
      }
    } catch (error) {
      console.error("Error loading keys from file:", error);
    }
  }

  // Save keys to JSON file (dev only)
  private saveToFile() {
    try {
      // Create .data directory if it doesn't exist
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      // Save keys to file
      fs.writeFileSync(
        this.keysFile,
        JSON.stringify(this.keys, null, 2),
        "utf-8"
      );
    } catch (error) {
      console.error("Error saving keys to file:", error);
      // In production, this should use a secure secret manager
      // For MVP, we continue without file persistence
    }
  }

  getKey(modelId: ModelId): string | null {
    return this.keys[modelId];
  }

  setKey(modelId: ModelId, value: string | null): void {
    this.keys[modelId] = value;
    this.saveToFile();
  }

  setKeys(keys: Partial<KeyStore>): void {
    Object.keys(keys).forEach((key) => {
      const modelId = key as ModelId;
      if (keys[modelId] !== undefined) {
        this.keys[modelId] = keys[modelId] || null;
      }
    });
    this.saveToFile();
  }

  getAllKeys(): KeyStore {
    return { ...this.keys };
  }

  getKeysStatus(): Record<ModelId, { configured: boolean; masked: string }> {
    return {
      chatgpt: {
        configured: !!this.keys.chatgpt,
        masked: this.maskKey(this.keys.chatgpt),
      },
      claude: {
        configured: !!this.keys.claude,
        masked: this.maskKey(this.keys.claude),
      },
      grok: {
        configured: !!this.keys.grok,
        masked: this.maskKey(this.keys.grok),
      },
      perplexity: {
        configured: !!this.keys.perplexity,
        masked: this.maskKey(this.keys.perplexity),
      },
    };
  }

  private maskKey(key: string | null): string {
    if (!key) return "";
    if (key.length <= 8) return "••••••••";
    return key.substring(0, 4) + "••••••••" + key.substring(key.length - 4);
  }
}

// Singleton instance
export const keyStore = new KeyStoreManager();

