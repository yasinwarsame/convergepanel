"use client";

/**
 * Phase 11B.5 — the persistent Personal / Team Workspace context indicator and
 * switcher in the global header.
 *
 * THIS IS NAVIGATION UI, NOT A SECURITY BOUNDARY. It may know a Workspace
 * exists because authenticated membership discovery returned it; it grants
 * nothing. Every destination still runs its own `resolveWorkspaceAccess()` (and
 * Project/run containment) on arrival, so the header never becomes the thing
 * deciding who may read what.
 *
 * THE NAME NEVER COMES FROM THE URL. The pathname contributes only an opaque
 * lookup key; the displayed Workspace name comes exclusively from the
 * server-produced membership list. A Team-shaped path whose id matches no
 * membership therefore renders NO context rather than echoing the segment back
 * — showing an unvalidated tenant name would be the actual defect here.
 *
 * Explicit URL always wins. There is no selected-Workspace state: context is
 * recomputed from `pathname ∩ items` on every render, so there is nothing to go
 * stale, nothing to persist, and no "last used Workspace" to resurrect.
 *
 * Disclosure state is OWNED BY TopNav (`open`/`onOpenChange`) so one component
 * arbitrates mutual exclusion and outside-click for all three disclosures,
 * rather than this one racing TopNav with its own document listener.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceListItem } from "@/lib/client/workspaceListClient";
import type { WorkspaceListStatus } from "@/hooks/useWorkspaceList";

export type WorkspaceNavContext =
  | { kind: "personal"; label: "Personal" }
  | { kind: "team"; workspaceId: string; name: string }
  | null;

const PERSONAL_CONTEXT = { kind: "personal", label: "Personal" } as const;

/**
 * Surfaces that are deliberately NEITHER Personal nor a path-addressed Team
 * Workspace.
 *
 * `/workspace/reviews` is the important one: its data IS Team-scoped, but the
 * Workspace is resolved server-side from `?workspace=` or a cardinality scan,
 * so it is not in the path and a client cannot know it. Labelling it "Personal"
 * would be factually wrong and guessing a Team would be unvalidated — so it
 * gets no context, and is checked BEFORE the generic `/workspace/` rule below
 * precisely so it cannot be swallowed by that prefix.
 */
const NEUTRAL_PREFIXES = [
  "/workspace/reviews",
  "/team/reviews",
  "/governance",
  "/about",
  "/help",
  "/contact",
  "/pricing",
  "/profile",
  "/admin",
] as const;

const TEAM_WORKSPACE_PATH = /^\/workspace\/team\/([^/]+)(?:\/|$)/;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Pure, order-sensitive route classification. Resolution order is load-bearing:
 * neutral exclusions, then the path-addressed Team route, then Personal, then a
 * neutral fallback.
 */
export function resolveWorkspaceNavContext(
  pathname: string | null | undefined,
  items: readonly WorkspaceListItem[]
): WorkspaceNavContext {
  if (!pathname) return null;

  // 1 — explicit neutral exclusions first.
  for (const prefix of NEUTRAL_PREFIXES) {
    if (matchesPrefix(pathname, prefix)) return null;
  }

  // 2 — a path-addressed Team Workspace. Validated against the server list,
  // never trusted from the path itself.
  const teamMatch = TEAM_WORKSPACE_PATH.exec(pathname);
  if (teamMatch) {
    let decodedWorkspaceId: string;
    try {
      decodedWorkspaceId = decodeURIComponent(teamMatch[1]);
    } catch {
      // A malformed percent-encoding is not a Workspace. Never display the raw
      // segment as a fallback.
      return null;
    }
    const membership = items.find((item) => item.workspaceId === decodedWorkspaceId);
    if (!membership) return null;
    return { kind: "team", workspaceId: membership.workspaceId, name: membership.name };
  }

  // 3 — Personal. `/workspace/team` itself is the chooser, not a validated
  // Workspace context, so it belongs here.
  if (
    pathname === "/" ||
    pathname === "/workspace" ||
    pathname.startsWith("/workspace/") ||
    pathname === "/reviews" ||
    matchesPrefix(pathname, "/reviews")
  ) {
    return PERSONAL_CONTEXT;
  }

  // 4 — neutral fallback.
  return null;
}

export function teamWorkspaceHref(workspaceId: string): string {
  // Always the Workspace Overview — never the current subroute, whose
  // Project/run ids belong to a different tenant and cannot be valid here.
  return `/workspace/team/${encodeURIComponent(workspaceId)}`;
}

type MenuDestination =
  | { key: string; kind: "personal"; label: string; href: string; current: boolean }
  | { key: string; kind: "team"; label: string; href: string; current: boolean };

export default function WorkspaceSwitcher({
  pathname,
  items,
  status,
  personalHref,
  open,
  onOpenChange,
  onRetry,
  triggerRef,
}: {
  pathname: string | null;
  items: readonly WorkspaceListItem[];
  status: WorkspaceListStatus;
  /** `/workspace` when the caller is admitted to the Personal Workspace UI, else `/`. */
  personalHref: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
}) {
  const router = useRouter();
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const context = useMemo(() => resolveWorkspaceNavContext(pathname, items), [pathname, items]);

  const destinations = useMemo<MenuDestination[]>(() => {
    const list: MenuDestination[] = [
      { key: "personal", kind: "personal", label: "Personal", href: personalHref, current: context?.kind === "personal" },
    ];
    // Server order preserved: no alphabetical sort, and the current Workspace is
    // not hoisted to the top — a menu whose order moves under the user is worse
    // than one that simply marks the current entry.
    for (const item of items) {
      list.push({
        key: `team:${item.workspaceId}`,
        kind: "team",
        label: item.name,
        href: teamWorkspaceHref(item.workspaceId),
        current: context?.kind === "team" && context.workspaceId === item.workspaceId,
      });
    }
    return list;
  }, [items, personalHref, context]);

  const focusItem = useCallback((index: number) => {
    const count = itemRefs.current.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    itemRefs.current[wrapped]?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // Opening moves focus into the menu, per the menu-button pattern.
    const id = setTimeout(() => focusItem(0), 0);
    return () => clearTimeout(id);
  }, [open, focusItem]);

  const close = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange, triggerRef]
  );

  const activate = useCallback(
    (destination: MenuDestination) => {
      // Close BEFORE navigating: an open popup must not survive a route change.
      close(false);
      // Activating the already-current context is a no-op navigation.
      if (destination.current) return;
      router.push(destination.href);
    },
    [close, router]
  );

  // Nothing to switch between, or nothing trustworthy to display.
  if (items.length === 0) return null;
  if (context === null) return null;

  const currentLabel = context.kind === "personal" ? "Personal" : context.name;
  const incomplete = status === "partial_error";

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) onOpenChange(true);
      else focusItem(0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) onOpenChange(true);
      else focusItem(-1);
    }
    // Enter and Space are left to the button's native activation, which fires onClick.
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLElement>, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusItem(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusItem(0);
        return;
      case "End":
        event.preventDefault();
        focusItem(-1);
        return;
      case "Escape":
        event.preventDefault();
        // Handled here and not propagated, so TopNav's own Escape lifecycle
        // cannot also fire and double-close/double-focus.
        event.stopPropagation();
        close(true);
        return;
      case "Tab":
        // Close but NEVER preventDefault: the browser's own tab order must keep working.
        close(false);
        return;
      default:
        return;
    }
  }

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        id="workspace-switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="workspace-switcher-menu"
        aria-label={`Switch Workspace. Current context: ${currentLabel}`}
        title={currentLabel}
        onClick={() => onOpenChange(!open)}
        onKeyDown={handleTriggerKeyDown}
        className="flex min-w-0 items-center gap-1.5 rounded-lg border border-cp-border bg-cp-raised px-2.5 py-1.5 text-sm font-medium text-cp-text transition-colors hover:border-cp-accent hover:bg-cp-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
      >
        <span className="max-w-[7.5rem] truncate sm:max-w-[9rem]">{currentLabel}</span>
        <span aria-hidden="true" className="text-cp-faint">
          ▾
        </span>
      </button>

      {open && (
        <div
          id="workspace-switcher-menu"
          role="menu"
          aria-labelledby="workspace-switcher-button"
          className="absolute left-0 z-50 mt-1 max-h-[60vh] w-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-cp-border bg-cp-surface py-1 shadow-lg"
        >
          {destinations.map((destination, index) => (
            <button
              key={destination.key}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              // `aria-current`, not `aria-selected`: this is a navigation menu,
              // not a listbox, and mixing those semantics misreports the widget.
              {...(destination.current ? { "aria-current": "true" as const } : {})}
              title={destination.label}
              onClick={() => activate(destination)}
              onKeyDown={(event) => handleMenuKeyDown(event, index)}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${
                destination.current ? "font-semibold text-cp-text" : "text-cp-muted"
              }`}
            >
              <span className="truncate">{destination.label}</span>
              {destination.current && (
                <span aria-hidden="true" className="text-cp-accent">
                  ✓
                </span>
              )}
            </button>
          ))}

          {incomplete && (
            <div className="mt-1 border-t border-cp-border-soft pt-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onRetry();
                  close(true);
                }}
                onKeyDown={(event) => handleMenuKeyDown(event, destinations.length)}
                ref={(node) => {
                  itemRefs.current[destinations.length] = node;
                }}
                className="w-full px-3 py-2 text-left text-sm font-medium text-cp-accent hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
              >
                Retry loading all Workspaces
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
