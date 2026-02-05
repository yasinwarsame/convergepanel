/**
 * Text Sanitization and Truncation Utilities
 * 
 * Provides safe text processing to prevent oversized payloads and storage issues.
 */

// Truncation limits (exported constants)
export const MAX_CHARS_STORAGE_PER_MODEL = 20000; // Max chars per model text in Firestore (increased for Gemini)
export const MAX_CHARS_SYNTHESIS_PER_MODEL = 8000; // Max chars per model text in synthesis
export const MAX_CHARS_SYNTHESIS_TOTAL = 30000; // Max total chars for synthesis prompt body
export const MAX_TOTAL_DOC_SIZE = 850000; // Max document size in chars (safety margin for 1 MiB Firestore limit)

/**
 * Sanitize model text
 * - Coerces to string safely
 * - Trims whitespace
 * - Removes accidental duplicated segments (if text > 2000 chars and first half === second half)
 */
export function sanitizeModelText(text: unknown): string {
  // Coerce to string safely
  let str: string;
  if (typeof text === "string") {
    str = text;
  } else if (text === null || text === undefined) {
    return "";
  } else {
    str = String(text);
  }

  let sanitized = str.trim();

  // Basic duplication heuristic: if text length > 2000 and first half === second half, keep first half
  if (sanitized.length > 2000) {
    const midpoint = Math.floor(sanitized.length / 2);
    const firstHalf = sanitized.substring(0, midpoint).trim();
    const secondHalf = sanitized.substring(midpoint).trim();
    
    if (firstHalf === secondHalf && firstHalf.length > 100) {
      console.warn(`[sanitizeText] Detected duplicated text segment, removing duplicate (${sanitized.length} -> ${firstHalf.length} chars)`);
      sanitized = firstHalf;
    }
  }

  return sanitized;
}

/**
 * Truncate text for synthesis prompts
 * Returns object with text and wasTruncated flag
 */
export function truncateForSynthesis(
  text: string,
  maxChars: number = MAX_CHARS_SYNTHESIS_PER_MODEL
): { text: string; wasTruncated: boolean } {
  if (!text || typeof text !== "string") {
    return { text: "", wasTruncated: false };
  }

  if (text.length <= maxChars) {
    return { text, wasTruncated: false };
  }

  // Log truncation (expected behavior for long responses) - only in development to reduce noise
  if (process.env.NODE_ENV !== "production") {
    console.log(`[truncateForSynthesis] Truncating text from ${text.length} to ${maxChars} chars (expected for long responses)`);
  }
  return {
    text: text.substring(0, maxChars) + "\n\n[Text truncated for synthesis...]",
    wasTruncated: true,
  };
}

/**
 * Truncate text for Firestore storage
 * Returns object with text and wasTruncated flag
 */
export function truncateForStorage(
  text: string,
  maxChars: number = MAX_CHARS_STORAGE_PER_MODEL
): { text: string; wasTruncated: boolean } {
  if (!text || typeof text !== "string") {
    return { text: "", wasTruncated: false };
  }

  if (text.length <= maxChars) {
    return { text, wasTruncated: false };
  }

  console.warn(`[truncateForStorage] Truncating text from ${text.length} to ${maxChars} chars`);
  return {
    text: text.substring(0, maxChars) + "\n\n[Text truncated for storage...]",
    wasTruncated: true,
  };
}

/**
 * Estimate document size in characters (rough approximation)
 */
export function estimateDocumentSize(data: any): number {
  try {
    return JSON.stringify(data).length;
  } catch {
    // Fallback: rough estimate
    return String(data).length;
  }
}

/**
 * Check if document size is safe for Firestore (under 1 MiB)
 * Returns true if safe, false if too large
 */
export function isDocumentSizeSafe(data: any): boolean {
  const size = estimateDocumentSize(data);
  const maxSize = MAX_TOTAL_DOC_SIZE; // 900KB safety margin
  return size < maxSize;
}

