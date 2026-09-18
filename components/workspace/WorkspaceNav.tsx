"use client";

/**
 * Team Workspace Activation Flow, Phase 12A.1 — the ONE shared
 * cross-section navigation strip for a specific Team Workspace, replacing
 * the two independently-duplicated "Members ↔ Audit Log" tab bars that
 * previously lived inline in `WorkspaceMembersShell.tsx` and
 * `WorkspaceAuditLogShell.tsx`. Always renders Overview + Members;
 * "Audit Log" is included only when `showAudit` is true (the caller
 * passes the same `audit.read` capability check the page's own server
 * gate already performed — this is a UX hint only, never an
 * authorization decision).
 *
 * TEAM-VERIFICATION-PARITY-R4-I2 — "Claims" is added as a PERMANENT
 * destination on exactly the same reasoning as Projects: every one of the five
 * valid Team roles (owner, admin, member, reviewer, viewer) carries
 * `research.read`, which is the capability the R3 Claim list endpoints and the
 * Claims page gate both require — so there is no role for which this link
 * would lead to a concealed page. It is never conditioned on Claim count,
 * Project count, activation state or the creator, and it carries no badge.
 *
 * Phase 12A.2 — "Projects" is added as a PERMANENT destination, always
 * rendered alongside Overview/Members (never conditional on Workspace
 * activation state, Project count, or research existence — every valid
 * Team role already holds `projects.read` per the capability matrix, so
 * there is no role for which this link would be misleading). This is the
 * standing product invariant: Projects navigation must never disappear
 * once the first Project exists.
 *
 * TEAM-VERIFICATION-PARITY-R5-I2 — "Videos" is added as a PERMANENT
 * destination on exactly the same reasoning as Projects and Claims: every one
 * of the five valid Team roles carries `research.read`, which is the capability
 * the R5-I1 Team Video read endpoints and the Videos page gate both require —
 * so there is no role for which this link would lead to a concealed page. It is
 * never conditioned on Video count, Project count, activation state,
 * `research.create`, `research.organize` or the uploader, and it carries no
 * badge. It sits between Claims and Members, keeping the artifact destinations
 * adjacent.
 *
 * This is the sixth item WORKSPACE-NAV-H1 was hardened for, and that hardening
 * is load-bearing here rather than incidental: with six labels the strip
 * overflows a 375px document without the containment below.
 *
 * WORKSPACE-NAV-H1 — narrow-viewport containment. With five permanent
 * destinations this strip already overflowed the DOCUMENT at ~375px, because a
 * plain `flex` row widens its parent rather than clipping. That is the wrong
 * failure: it makes the whole page scroll sideways, shifting unrelated content.
 *
 * The fix is an internal horizontal overflow boundary — the nav scrolls, the
 * page does not:
 *
 *   - `max-w-full overflow-x-auto` makes the nav its OWN scroll container, so
 *     its content can exceed its width without widening the document.
 *   - `shrink-0 whitespace-nowrap` on every item stops flex from compressing
 *     "Audit Log" into a wrapped or squashed label to force a fit.
 *   - `relative` makes the nav the offset parent of its items, so the active
 *     item's `offsetLeft` is measured in the nav's own scroll coordinates.
 *
 * A horizontally scrollable nav is incomplete if the CURRENT destination can
 * start off-screen, so a layout effect nudges `scrollLeft` — and only
 * `scrollLeft` — until the active item is inside the visible range. It never
 * touches page/window scroll, and does nothing when the item is already fully
 * visible.
 *
 * Because `overflow-x` is not `visible`, `overflow-y` computes to `auto`, which
 * would clip (or spawn a scrollbar for) a focus ring drawn OUTSIDE a link. The
 * links therefore carry an explicit INSET focus-visible ring: focus stays
 * clearly visible and is structurally unclippable, with no padding change and
 * so no shift to the active item's underline or the divider.
 *
 * (The "Videos" item that comment once deferred arrived in R5-I2, above.)
 */

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef } from "react";

export type WorkspaceNavItem = "overview" | "projects" | "claims" | "videos" | "members" | "audit";

/**
 * `useLayoutEffect` runs before paint, so the scroll correction is never a
 * visible jump — but it warns when React renders this client component on the
 * server. There is nothing to measure there, so fall back to `useEffect`
 * outside the browser.
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function WorkspaceNav({
  workspaceId,
  active,
  showAudit,
}: {
  workspaceId: string;
  active: WorkspaceNavItem;
  /** Whether to include the Audit Log link — pass the caller's own `audit.read` capability. */
  showAudit: boolean;
}) {
  const base = `/workspace/team/${encodeURIComponent(workspaceId)}`;
  const items: { key: WorkspaceNavItem; label: string; href: string }[] = [
    { key: "overview", label: "Overview", href: base },
    { key: "projects", label: "Projects", href: `${base}/projects` },
    { key: "claims", label: "Claims", href: `${base}/claims` },
    { key: "videos", label: "Videos", href: `${base}/videos` },
    { key: "members", label: "Members", href: `${base}/members` },
    ...(showAudit ? [{ key: "audit" as const, label: "Audit Log", href: `${base}/audit` }] : []),
  ];

  const navRef = useRef<HTMLElement | null>(null);
  const activeItemRef = useRef<HTMLSpanElement | null>(null);

  // Bring the ACTIVE item into the nav's visible horizontal range. Adjusts
  // `nav.scrollLeft` ONLY: never `scrollIntoView` (which can also scroll the
  // page vertically), never window scroll, never a viewport-width check.
  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const item = activeItemRef.current;
    if (!nav || !item) return;

    const visibleLeft = nav.scrollLeft;
    const visibleRight = visibleLeft + nav.clientWidth;
    const itemLeft = item.offsetLeft;
    const itemRight = itemLeft + item.offsetWidth;

    if (itemLeft < visibleLeft) {
      // Starts before the visible range — align its left edge.
      nav.scrollLeft = itemLeft;
    } else if (itemRight > visibleRight) {
      // Ends after the visible range — align its right edge.
      nav.scrollLeft = itemRight - nav.clientWidth;
    }
    // Already fully visible: leave the user's scroll position alone.
  }, [active]);

  return (
    <nav
      ref={navRef}
      aria-label="Workspace"
      className="relative mb-6 flex max-w-full gap-4 overflow-x-auto border-b border-cp-border-soft text-sm"
    >
      {items.map((item) =>
        item.key === active ? (
          <span
            key={item.key}
            ref={activeItemRef}
            aria-current="page"
            className="shrink-0 whitespace-nowrap border-b-2 border-cp-accent px-1 pb-2 font-medium text-cp-text"
          >
            {item.label}
          </span>
        ) : (
          <Link
            key={item.key}
            href={item.href}
            className="shrink-0 whitespace-nowrap px-1 pb-2 text-cp-muted hover:text-cp-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cp-accent"
          >
            {item.label}
          </Link>
        )
      )}
    </nav>
  );
}
