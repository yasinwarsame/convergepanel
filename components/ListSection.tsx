/**
 * Shared List Section Component
 * 
 * Renders a uniform bullet list for any list-type section in panel responses.
 * This ensures consistent styling across all models (ChatGPT, Claude, Grok, Perplexity)
 * and all views (List & Compare).
 * 
 * Used for:
 * - Key Claims
 * - Potential Biases and Blind Spots
 * - Suggested Follow-Up Questions
 * - Gaps in Evidence
 * - Practical Implications
 * - Any other list-type sections
 */

interface ListSectionProps {
  title: string;
  items: string[];
  className?: string;
}

/**
 * Renders a list section with consistent bullet styling
 * 
 * @param title - Section heading text
 * @param items - Array of list items to render
 * @param className - Optional additional CSS classes
 */
export function ListSection({ title, items, className = "" }: ListSectionProps) {
  if (!items || items.length === 0) {
    return null;
  }

  return (
    <section className={className}>
      <h3 className="font-semibold text-sm tracking-tight text-slate-900 mb-2 mt-4">
        {title}
      </h3>
      <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
        {items.map((item, idx) => (
          <li key={idx} className="leading-relaxed text-slate-800 pl-1">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

