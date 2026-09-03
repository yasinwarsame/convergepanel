/**
 * Generic, presentation-only breadcrumb for ConvergePanel's authenticated
 * navigation redesign (Phase 11B). Mirrors `components/shared/GovernanceChip.tsx`'s
 * style: a small, pure, named-export function component, no hooks, `cp-*`
 * design tokens, `aria-hidden` on decorative elements.
 *
 * This is a trust boundary: the component renders exactly the segments it is
 * given — nothing more. It never fetches Workspace/Project data, infers
 * ownership, inspects membership/capabilities, derives labels from raw route
 * IDs, reads storage, persists state, or infers hierarchy from history.
 * Authorization stays entirely with the server-rendered caller.
 */

import Link from "next/link";

export type BreadcrumbSegment = {
  label: string;
  href?: string;
};

export type BreadcrumbProps = {
  segments: BreadcrumbSegment[];
  mobileParent?: BreadcrumbSegment;
  className?: string;
};

const LINK_CLASS =
  "truncate max-w-[12rem] text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded";

const CURRENT_CLASS = "truncate max-w-[12rem] font-semibold text-cp-text";

const MOBILE_LINK_CLASS =
  "inline-flex items-center gap-1 text-sm font-medium text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded";

const MOBILE_TEXT_CLASS = "inline-flex items-center gap-1 text-sm font-medium text-cp-muted";

export function Breadcrumb({ segments, mobileParent, className }: BreadcrumbProps) {
  if (!segments || segments.length === 0) return null;

  const lastIndex = segments.length - 1;

  return (
    <nav aria-label="Breadcrumb" className={className}>
      {/* Desktop: full hierarchy, hidden below the sm breakpoint. */}
      <ol className="hidden sm:flex sm:items-center sm:gap-1.5">
        {segments.map((segment, index) => {
          const isCurrent = index === lastIndex;
          return (
            <li key={`${segment.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <span className="text-cp-faint" aria-hidden="true">
                  /
                </span>
              )}
              {isCurrent ? (
                <span className={CURRENT_CLASS} aria-current="page" title={segment.label}>
                  {segment.label}
                </span>
              ) : segment.href ? (
                <Link href={segment.href} className={LINK_CLASS} title={segment.label}>
                  {segment.label}
                </Link>
              ) : (
                <span className={LINK_CLASS} title={segment.label}>
                  {segment.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {/* Mobile: compact "go up one level" affordance, shown only below sm. */}
      {mobileParent && (
        <div className="flex sm:hidden">
          {mobileParent.href ? (
            <Link href={mobileParent.href} className={MOBILE_LINK_CLASS}>
              <span aria-hidden="true">←</span>
              {mobileParent.label}
            </Link>
          ) : (
            <span className={MOBILE_TEXT_CLASS}>
              <span aria-hidden="true">←</span>
              {mobileParent.label}
            </span>
          )}
        </div>
      )}
    </nav>
  );
}
