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
 */

import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

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
