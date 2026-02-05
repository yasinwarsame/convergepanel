/**
 * Panel Section Component
 * 
 * Shared component for rendering panel response sections uniformly.
 * Used by both List View and Compare View to ensure consistency.
 * 
 * Handles:
 * - Bullet sections (Key Metrics, Key Claims, Follow-Up Questions)
 * - Paragraph sections (all other sections)
 * - Uppercase headings
 * - Consistent styling
 */

import { normalizeList } from "@/lib/normalizeList";
import { isBulletSection } from "@/lib/sectionUtils";

interface PanelSectionProps {
  title: string;
  content: string;
  className?: string;
}

/**
 * Renders a panel section with appropriate formatting
 * 
 * Bullet sections use <ul><li>, paragraph sections use <p>
 * All headings are uppercase.
 * 
 * @param title - Section title (will be converted to uppercase)
 * @param content - Section content (string)
 * @param className - Optional additional CSS classes
 */
export function PanelSection({ title, content, className = "" }: PanelSectionProps) {
  if (!content || !content.trim()) {
    return null;
  }

  const isBullet = isBulletSection(title);
  const displayTitle = title.toUpperCase();

  return (
    <section className={className}>
      <h3 className="font-semibold text-sm tracking-tight text-slate-900 mb-2 mt-4">
        {displayTitle}
      </h3>
      {isBullet ? (
        <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
          {normalizeList(content).map((item, idx) => (
            <li key={idx} className="leading-relaxed text-slate-800 pl-1">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-line">
          {content.trim()}
        </p>
      )}
    </section>
  );
}

