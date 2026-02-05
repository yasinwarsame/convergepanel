/**
 * Section Utilities
 * 
 * Shared utilities for parsing, normalizing, and rendering panel response sections.
 * Used by both List View and Compare View to ensure consistency.
 */

import { normalizeList } from "./normalizeList";

/**
 * Sections that should be rendered as bullet lists
 * Only these three sections use bullets; all others are paragraph blocks
 */
export const BULLET_SECTIONS = [
  "Key Metrics and Quantitative Estimates",
  "Key Claims",
  "Suggested Follow-Up Questions",
] as const;

/**
 * Normalize a section title to a canonical key
 * 
 * Handles case-insensitive matching, extra spaces, and variant suffixes like "(IF APPLICABLE)"
 * 
 * @param title - Raw section title
 * @returns Normalized key for comparison
 */
export function normalizeSectionKey(title: string): string {
  let normalized = title
    .trim()
    .toLowerCase()
    .replace(/\s*\(if applicable\)\s*$/i, "") // Remove trailing "(if applicable)" variant
    .replace(/\s*\(if applicable\)\s*/gi, "") // Remove any "(if applicable)" in the title
    .replace(/\s+/g, " ") // Normalize multiple spaces to single space
    .replace(/[-–—]/g, "-"); // Normalize different dash types
  
  return normalized.trim();
}

/**
 * Convert section title to uppercase display format
 * 
 * @param title - Raw section title
 * @returns Uppercase display title
 */
export function toDisplayTitle(title: string): string {
  return title.trim().toUpperCase();
}

/**
 * Check if a section should be rendered as a bullet list
 * 
 * @param sectionName - Section name (case-insensitive)
 * @returns True if this section should use bullets
 */
export function isBulletSection(sectionName: string): boolean {
  const normalized = normalizeSectionKey(sectionName);
  return BULLET_SECTIONS.some((bulletSection) => 
    normalizeSectionKey(bulletSection) === normalized
  );
}

/**
 * Merge duplicate sections
 * 
 * Combines sections with the same normalized key into a single section.
 * For bullet sections: merges list items.
 * For paragraph sections: joins content with blank lines.
 * 
 * @param sections - Array of sections with title and content
 * @returns Map of normalized section keys to merged content
 */
export function mergeDuplicateSections(
  sections: Array<{ title: string; content: string }>
): Map<string, { title: string; content: string; isBullet: boolean }> {
  const merged = new Map<string, { title: string; content: string; isBullet: boolean }>();

  for (const section of sections) {
    const key = normalizeSectionKey(section.title);
    const isBullet = isBulletSection(section.title);
    const displayTitle = toDisplayTitle(section.title);

    if (merged.has(key)) {
      // Merge with existing section
      const existing = merged.get(key)!;
      
      if (isBullet) {
        // For bullet sections: merge list items
        const existingItems = normalizeList(existing.content);
        const newItems = normalizeList(section.content);
        const mergedItems = [...existingItems, ...newItems];
        merged.set(key, {
          title: displayTitle,
          content: mergedItems.join("\n"),
          isBullet: true,
        });
      } else {
        // For paragraph sections: join with blank line
        const existingContent = existing.content.trim();
        const newContent = section.content.trim();
        merged.set(key, {
          title: displayTitle,
          content: existingContent ? `${existingContent}\n\n${newContent}` : newContent,
          isBullet: false,
        });
      }
    } else {
      // First occurrence of this section
      merged.set(key, {
        title: displayTitle,
        content: section.content,
        isBullet,
      });
    }
  }

  return merged;
}

/**
 * Extract all sections from markdown text
 * 
 * Parses markdown to find all section headings and their content.
 * Handles content that appears before the first heading.
 * 
 * @param markdown - Full markdown response text
 * @returns Array of sections with title and content
 */
export function extractAllSections(markdown: string): Array<{ title: string; content: string }> {
  if (!markdown || typeof markdown !== "string") {
    return [];
  }

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ title: string; content: string }> = [];
  let currentSection: { title: string; content: string } | null = null;
  let preHeadingContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if this is a section heading (starts with #)
    if (trimmed.startsWith("#")) {
      // Save any content that appeared before the first heading
      if (preHeadingContent.length > 0 && !currentSection) {
        const preContent = preHeadingContent.join("\n").trim();
        if (preContent) {
          sections.push({
            title: "Summary", // Default title for pre-heading content
            content: preContent,
          });
        }
        preHeadingContent = [];
      }

      // Save previous section if it exists
      if (currentSection) {
        sections.push(currentSection);
      }

      // Extract title from heading (remove # and optional colon)
      const title = trimmed
        .replace(/^#+\s*/, "") // Remove heading markers
        .replace(/:\s*$/, "") // Remove trailing colon
        .trim();

      // Start new section
      currentSection = {
        title,
        content: "",
      };
    } else if (currentSection) {
      // Add line to current section content
      if (currentSection.content) {
        currentSection.content += "\n" + line;
      } else {
        currentSection.content = line;
      }
    } else {
      // Content before first heading - collect it
      preHeadingContent.push(line);
    }
  }

  // Add final section
  if (currentSection) {
    sections.push(currentSection);
  } else if (preHeadingContent.length > 0) {
    // If no headings found, treat entire content as a single section
    const content = preHeadingContent.join("\n").trim();
    if (content) {
      sections.push({
        title: "Summary",
        content,
      });
    }
  }

  return sections;
}

/**
 * Standard section order for consistent display
 * 
 * Sections should appear in this order in both List and Compare views.
 * IMPORTANT: "Suggested Follow-Up Questions" must always be last when present.
 */
export const SECTION_ORDER = [
  "Summary",
  "Key Claims",
  "Evidence and Reasoning",
  "Uncertainties and Disagreements",
  "Potential Biases and Blind Spots",
  "Key Metrics and Quantitative Estimates",
  "Methodology and Assumptions",
  "Alternative Perspectives and Counterarguments",
  "Gaps in Evidence and Open Questions",
  "Practical Implications and Recommendations",
  "Suggested Follow-Up Questions", // MUST be last in this array
] as const;

/**
 * Create a map of normalized section keys to their order index
 * This allows efficient lookup for sorting
 */
const ORDER_MAP = new Map(
  SECTION_ORDER.map((name, idx) => [normalizeSectionKey(name), idx])
);

/**
 * Get the sort order index for a section title
 * 
 * Returns the index in SECTION_ORDER for known sections.
 * Unknown sections get a high index (but less than FOLLOW-UP QUESTIONS)
 * to ensure they appear before "Suggested Follow-Up Questions" but after known sections.
 * 
 * IMPORTANT: "Suggested Follow-Up Questions" must always have the highest index
 * so it appears last when present.
 * 
 * @param title - Section title
 * @returns Sort order index (lower = earlier in display)
 */
export function getSectionOrderIndex(title: string): number {
  const key = normalizeSectionKey(title);
  const value = ORDER_MAP.get(key);
  
  // Known sections return their index
  if (value !== undefined) {
    return value;
  }
  
  // Unknown sections go before FOLLOW-UPS but after known ones
  // Use SECTION_ORDER.length - 2 so they appear just before "Suggested Follow-Up Questions"
  // (which is at index SECTION_ORDER.length - 1)
  const followUpIndex = SECTION_ORDER.length - 1;
  return Math.max(0, followUpIndex - 1);
}

/**
 * Sort sections according to standard order
 * 
 * Ensures "Suggested Follow-Up Questions" always appears last when present.
 * Unknown sections appear just before "Suggested Follow-Up Questions".
 * 
 * @param sections - Map of sections
 * @returns Array of sections in standard order
 */
export function sortSections(
  sections: Map<string, { title: string; content: string; isBullet: boolean }>
): Array<{ title: string; content: string; isBullet: boolean }> {
  // Convert map to array and sort by order index
  const sectionsArray = Array.from(sections.values());
  
  sectionsArray.sort((a, b) => {
    const ai = getSectionOrderIndex(a.title);
    const bi = getSectionOrderIndex(b.title);
    
    // Primary sort: by order index
    if (ai !== bi) {
      return ai - bi;
    }
    
    // Fallback: stable sort by normalized title to avoid jitter
    return normalizeSectionKey(a.title).localeCompare(normalizeSectionKey(b.title));
  });
  
  return sectionsArray;
}

