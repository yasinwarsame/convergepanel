/**
 * Extract List Sections from Markdown
 * 
 * Parses markdown responses to identify and extract list-type sections
 * that should be rendered as uniform bullet lists.
 * 
 * List-type sections:
 * - Key Claims (bullet list)
 * - Potential Biases and Blind Spots (bullet list)
 * - Suggested Follow-Up Questions (bullet list)
 * - Gaps in Evidence and Open Questions (may contain bullets)
 * - Practical Implications and Recommendations (may contain bullets)
 */

/**
 * Extract a specific section from markdown by heading
 * 
 * @param markdown - Full markdown text
 * @param sectionName - Name of the section to extract (e.g., "Key Claims")
 * @returns The content of the section, or null if not found
 */
export function extractSection(
  markdown: string,
  sectionName: string
): string | null {
  if (!markdown || typeof markdown !== "string") {
    return null;
  }

  // Normalize line endings
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // Create flexible pattern to match section heading
  // Handles: # Key Claims, ## Key Claims, # Key Claims:, etc.
  const headingPattern = new RegExp(
    `^#+\\s*${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s:]*$`,
    "i"
  );

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

/**
 * List-type sections that should always be rendered as bullet lists
 */
export const LIST_SECTIONS = [
  "Key Claims",
  "Potential Biases and Blind Spots",
  "Suggested Follow-Up Questions",
] as const;

/**
 * Sections that may contain lists but are primarily narrative
 * These will be checked for bullet content and normalized if found
 */
export const OPTIONAL_LIST_SECTIONS = [
  "Gaps in Evidence and Open Questions",
  "Practical Implications and Recommendations",
  "Uncertainties and Disagreements",
] as const;

/**
 * Extract all list sections from a markdown response
 * 
 * @param markdown - Full markdown response text
 * @returns Map of section names to their content
 */
export function extractAllListSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();

  // Extract required list sections
  for (const sectionName of LIST_SECTIONS) {
    const content = extractSection(markdown, sectionName);
    if (content) {
      sections.set(sectionName, content);
    }
  }

  // Extract optional list sections (only if they contain bullet-like content)
  for (const sectionName of OPTIONAL_LIST_SECTIONS) {
    const content = extractSection(markdown, sectionName);
    if (content) {
      // Check if content contains bullet-like patterns
      const hasBullets = /^[-*•]\s+/m.test(content) || /^\d+[.)]\s+/m.test(content);
      if (hasBullets) {
        sections.set(sectionName, content);
      }
    }
  }

  return sections;
}

