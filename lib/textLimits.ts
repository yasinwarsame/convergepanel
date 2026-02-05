/**
 * Text Limits and Validation Utilities
 * 
 * This module provides utilities for validating and limiting text responses.
 * 
 * IMPORTANT: We do NOT truncate model responses before section parsing.
 * Truncation should only happen after we've extracted all sections, and only
 * if absolutely necessary for display purposes (e.g., extremely long responses).
 * 
 * The primary purpose of this module is to:
 * 1. Validate response length (detect suspiciously short responses)
 * 2. Provide a safe truncation utility if needed for display (not for parsing)
 */

/**
 * Maximum character limit for panel text (safety limit for extremely long responses)
 * 
 * This is a very high limit (25,000 characters ≈ 6,000 words) that should rarely be hit.
 * It's only used as a safety net for display purposes, not for parsing or analysis.
 */
export const PANEL_TEXT_MAX_CHARS = 25000;

/**
 * Minimum word count threshold for detecting suspiciously short responses
 * 
 * A deep research response should have at least 250 words to meaningfully fill
 * all sections (Summary, Key Claims, Evidence, Uncertainties, Biases, etc.).
 * 
 * Responses below this threshold are likely:
 * - Refusals or errors
 * - Incomplete responses
 * - Superficial answers that don't meet the depth requirement
 */
const SUSPICIOUSLY_SHORT_WORD_THRESHOLD = 250;

/**
 * Check if a response is suspiciously short
 * 
 * This function detects responses that are too short to be meaningful deep research answers.
 * A suspiciously short response likely indicates:
 * - The model refused to answer
 * - The model returned an error message
 * - The model returned a superficial answer that doesn't meet depth requirements
 * 
 * @param text - The response text to check
 * @returns True if the response is suspiciously short, false otherwise
 */
export function isSuspiciouslyShort(text: string | null | undefined): boolean {
  if (!text || text.trim().length === 0) {
    return true;
  }
  
  // Count words (split on whitespace and filter empty strings)
  const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;
  
  return wordCount < SUSPICIOUSLY_SHORT_WORD_THRESHOLD;
}

/**
 * Limit panel text to a maximum character count, trimming at sentence boundary
 * 
 * This function should ONLY be used for display purposes, never before section parsing.
 * It preserves complete sentences by trimming at the last sentence boundary before
 * the character limit.
 * 
 * IMPORTANT: This is a safety net that should almost never trigger for normal deep research answers.
 * The limit (25,000 characters ≈ 6,000 words) is very generous and only exists to prevent
 * extremely long responses from breaking the UI.
 * 
 * @param text - The text to limit
 * @param maxChars - Maximum character count (default: PANEL_TEXT_MAX_CHARS)
 * @returns The text, truncated at sentence boundary if it exceeds maxChars, with truncation marker
 */
export function limitPanelText(text: string, maxChars: number = PANEL_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  
  // Trim at last sentence boundary to avoid mid-sentence cut
  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastExclamation = truncated.lastIndexOf("!");
  const lastQuestion = truncated.lastIndexOf("?");
  
  // Find the last sentence-ending punctuation
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  
  // If we found a sentence boundary, trim there; otherwise use the hard limit
  const trimmed = lastSentenceEnd > 0 ? truncated.slice(0, lastSentenceEnd + 1) : truncated;
  
  // Add truncation marker so UI can detect and display a warning
  return trimmed + "\n\n…[truncated for length]";
}

