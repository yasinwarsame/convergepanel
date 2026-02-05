/**
 * List Normalization Utility
 * 
 * Converts various list formats (string arrays, text with bullets, etc.)
 * into a clean array of list items for uniform rendering.
 * 
 * This ensures all list-type sections (Key Claims, Biases, Follow-Up Questions, etc.)
 * render consistently across all models (ChatGPT, Claude, Grok, Perplexity).
 */

/**
 * Normalize any list-like data into a clean array of strings
 * 
 * Handles:
 * - Arrays of strings (ideal format)
 * - Single string with line breaks
 * - Strings with bullet markers (•, *, -)
 * - Numbered lists (1., 2., etc.)
 * - Mixed formats
 * 
 * @param raw - Raw list data (string, string[], or null/undefined)
 * @returns Clean array of list item strings
 */
export function normalizeList(
  raw: string | string[] | null | undefined
): string[] {
  if (!raw) return [];

  // If already an array, clean and return
  if (Array.isArray(raw)) {
    return raw.map((item) => item.trim()).filter(Boolean);
  }

  // If it's not a string, return empty array
  if (typeof raw !== "string") {
    return [];
  }

  // Normalize line endings and split into lines
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  const items: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Remove leading bullet markers (•, *, -) or numbered list markers (1., 2., etc.)
    // Also handle cases where there's a space or no space after the marker
    let item = trimmed
      .replace(/^[-*•]\s+/, "") // Remove bullet markers
      .replace(/^\d+[.)]\s+/, "") // Remove numbered list markers (1. or 1))
      .trim();

    // Only add if there's actual content
    if (item.length > 0) {
      items.push(item);
    }
  }

  return items;
}

