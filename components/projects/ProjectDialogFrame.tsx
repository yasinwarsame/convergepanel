"use client";

/**
 * Phase 7D — shared dialog chrome for New/Rename/Archive, matching the
 * established `role="dialog"` / `aria-modal` / `bg-black/50` overlay /
 * cp-* token convention already used by `GovernanceDashboard.tsx`'s
 * `ReviewModal` and `app/profile/page.tsx`'s cancel-subscription dialog —
 * no reusable dialog primitive exists elsewhere in this codebase to import
 * instead (confirmed by search).
 *
 * Adds what neither of those two existing dialogs implements: focus moves
 * into the dialog on open (to `initialFocusRef` if given, else the panel
 * itself), and Escape/backdrop-click both close AND restore focus to the
 * exact trigger element that opened the dialog — mirroring the
 * Escape+focus-return idiom already established (and tested) for
 * `TopNav.tsx`'s disclosure menus, applied here to a true modal.
 *
 * Phase 9C.5-R1C — keyboard FOCUS CONTAINMENT added (was previously missing:
 * Tab/Shift+Tab could escape the open dialog to background content,
 * independently reproduced during Phase 9C.5-R1 against the governance
 * confirmation dialogs — resubmit/finalize/cancel/Owner Override — that
 * this same shared primitive backs). While mounted, Tab from the last
 * focusable element wraps to the first, and Shift+Tab from the first wraps
 * to the last, using a live `querySelectorAll` scan of the panel on every
 * keypress (never a hard-coded control list, since consumers' focusable
 * content differs). A dialog with no focusable descendant simply keeps
 * focus on the panel container rather than letting Tab escape. Initial
 * focus, Escape, and return-focus behavior above are UNCHANGED.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

function getFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
}

export function ProjectDialogFrame({
  title,
  triggerRef,
  onClose,
  initialFocusRef,
  children,
}: {
  title: string;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement>;
  children: (args: { titleId: string; requestClose: () => void }) => ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const requestClose = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose, triggerRef]);

  useEffect(() => {
    (initialFocusRef?.current ?? panelRef.current)?.focus();
    // Runs once on mount only — moving focus into the dialog is a
    // one-time open-time effect, not something that should re-fire on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Guarded for this repo's `document`-free `react-test-renderer` test
    // environment (no jsdom) — a real browser always has `document`; this
    // never affects actual runtime behavior.
    if (typeof document === "undefined") return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        // Nothing tabbable inside — keep focus on the panel container rather than letting Tab escape to background content.
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-cp-border bg-cp-surface p-6 shadow-xl outline-none">
        <h2 id={titleId} className="text-lg font-bold text-cp-text">
          {title}
        </h2>
        {children({ titleId, requestClose })}
      </div>
    </div>
  );
}
