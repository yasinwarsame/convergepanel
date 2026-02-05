/**
 * Parse Suggested Follow-Up Questions Utility
 * 
 * Extracts and normalizes follow-up questions from model responses.
 * Handles various formats:
 * - Bullet lists (•, *, -)
 * - Plain text with line breaks
 * - Numbered lists
 * - Arrays of questions
 * 
 * Returns a clean array of question strings that can be rendered as a uniform bullet list.
 */

/**
 * Parse suggested follow-up questions from raw text
 * 
 * Extracts questions from the "Suggested Follow-Up Questions" section,
 * handling various formats that different models might use.
 * 
 * @param raw - Raw text content (string, array, or null/undefined)
 * @returns Array of question strings, cleaned and normalized
 */
export function parseSuggestedFollowUps(
  raw: string | string[] | null | undefined
): string[] {
  if (!raw) return [];

  // If already an array, clean and return
  if (Array.isArray(raw)) {
    return raw.map((q) => q.trim()).filter(Boolean);
  }

  // If it's a string, parse it
  if (typeof raw !== "string") {
    return [];
  }

  // Normalize line endings and split into lines
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  const questions: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Remove leading bullet markers (•, *, -) or numbered list markers (1., 2., etc.)
    // Also handle cases where there's a space or no space after the marker
    let question = trimmed
      .replace(/^[-*•]\s+/, "") // Remove bullet markers
      .replace(/^\d+[.)]\s+/, "") // Remove numbered list markers (1. or 1))
      .trim();

    // Only add if there's actual content
    if (question.length > 0) {
      questions.push(question);
    }
  }

  // Fallback: If no questions found by line splitting (e.g., single paragraph),
  // try splitting on question marks as a last resort
  if (questions.length === 0 && raw.includes("?")) {
    // Split on question marks, preserving them
    const parts = raw.split(/(\?)/);
    let currentQuestion = "";
    for (let i = 0; i < parts.length; i++) {
      currentQuestion += parts[i];
      if (parts[i] === "?") {
        const q = currentQuestion.trim();
        if (q.length > 10) {
          questions.push(q);
        }
        currentQuestion = "";
      }
    }
    // Add any remaining text as a question if it's substantial
    if (currentQuestion.trim().length > 10) {
      questions.push(currentQuestion.trim());
    }
  }

  return questions;
}

/**
 * Extract the "Suggested Follow-Up Questions" section from markdown text
 * 
 * Finds the section heading and extracts all content until the next section
 * or end of text.
 * 
 * @param markdown - Full markdown response text
 * @returns The content of the "Suggested Follow-Up Questions" section, or null if not found
 */
export function extractFollowUpQuestionsSection(markdown: string): string | null {
  if (!markdown || typeof markdown !== "string") {
    return null;
  }

  // Normalize line endings
  const normalized = markdown.replace(/\r\n/g, "\n");

  // Find the "Suggested Follow-Up Questions" heading
  // Match various formats: # Suggested Follow-Up Questions, ## Suggested Follow-Up Questions, etc.
  const headingPattern = /^#+\s*Suggested\s+Follow[- ]?Up\s+Questions?/im;
  const lines = normalized.split("\n");

  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      startIndex = i + 1;
      break;
    }
  }

  // If section not found, return null
  if (startIndex === -1) {
    return null;
  }

  // Extract content until the next section heading or end of text
  const contentLines: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();

    // Stop at the next section heading (starts with #)
    if (line.startsWith("#") && i > startIndex) {
      break;
    }

    contentLines.push(lines[i]);
  }

  return contentLines.join("\n").trim() || null;
}

