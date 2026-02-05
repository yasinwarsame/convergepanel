/**
 * Bullet List Normalization Utility
 * 
 * Normalizes various bullet formats (•, *, -, etc.) into consistent markdown list syntax
 * so that all model responses render with uniform bullet styling.
 * 
 * This ensures that "Suggested Follow-Up Questions" and other bullet lists appear
 * consistently across all models (ChatGPT, Claude, Grok, Perplexity) regardless of
 * how each model formats its bullet points.
 */

/**
 * Normalize bullet characters to markdown list format
 * 
 * Converts:
 * - Literal bullet characters (•) to markdown list items (-)
 * - Various bullet formats (*, -, •) to consistent markdown syntax
 * - Handles lines that start with bullets (with or without leading whitespace)
 * - Preserves indentation for nested lists
 * - Removes stray bullet-only lines
 * 
 * @param text - The text content that may contain various bullet formats
 * @returns Normalized text with consistent markdown list syntax
 */
export function normalizeBullets(text: string): string {
  if (!text || typeof text !== "string") {
    return text;
  }

  // Split into lines, preserving line breaks
  const lines = text.split(/\r?\n/);
  const normalizedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    
    // Skip empty lines
    if (trimmed.length === 0) {
      normalizedLines.push(line);
      continue;
    }
    
    // Check if line is just a bullet character (stray bullet on its own line)
    // Skip these to avoid rendering empty bullet points
    if (/^[•*\-]\s*$/.test(trimmed)) {
      continue;
    }
    
    // Check if line starts with a bullet character (•, *, -) followed by space
    // Match patterns like: "• text", "* text", "- text", "  • text" (with indentation)
    // Also handle cases where bullet is followed by multiple spaces or no space
    const bulletMatch = trimmed.match(/^([•*\-])\s*(.+)$/);
    
    if (bulletMatch) {
      const bulletContent = bulletMatch[2].trim();
      
      // Only convert if there's actual content after the bullet
      if (bulletContent.length > 0) {
        // Convert to markdown list item format (-)
        // Preserve leading whitespace for indentation (nested lists)
        const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
        
        // Use markdown list syntax (-) for consistency
        normalizedLines.push(`${leadingWhitespace}- ${bulletContent}`);
      }
    } else {
      // Keep line as-is if it doesn't start with a bullet
      normalizedLines.push(line);
    }
  }

  return normalizedLines.join("\n");
}

