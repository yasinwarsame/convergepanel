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
 * Phase 12A.2 — "Projects" is added as a PERMANENT destination, always
 * rendered alongside Overview/Members (never conditional on Workspace
 * activation state, Project count, or research existence — every valid
 * Team role already holds `projects.read` per the capability matrix, so
 * there is no role for which this link would be misleading). This is the
 * standing product invariant: Projects navigation must never disappear
 * once the first Project exists.
 */

import Link from "next/link";

export type WorkspaceNavItem = "overview" | "projects" | "members" | "audit";

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
    { key: "members", label: "Members", href: `${base}/members` },
    ...(showAudit ? [{ key: "audit" as const, label: "Audit Log", href: `${base}/audit` }] : []),
  ];

  return (
    <nav aria-label="Workspace" className="mb-6 flex gap-4 border-b border-cp-border-soft text-sm">
      {items.map((item) =>
        item.key === active ? (
          <span key={item.key} aria-current="page" className="border-b-2 border-cp-accent px-1 pb-2 font-medium text-cp-text">
            {item.label}
          </span>
        ) : (
          <Link key={item.key} href={item.href} className="px-1 pb-2 text-cp-muted hover:text-cp-text">
            {item.label}
          </Link>
        )
      )}
    </nav>
  );
}
