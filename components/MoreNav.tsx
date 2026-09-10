"use client";

/**
 * Phase 11B.6 — the secondary-navigation disclosure in the authenticated header.
 *
 * PRESENTATION ONLY, AND DELIBERATELY IGNORANT. It receives already-evaluated
 * destinations and renders them. It does not fetch, inspect auth, read the
 * pathname, or resolve a capability — so eligibility can only be decided in one
 * place (TopNav), and this component cannot become a second, drifting opinion
 * about who may see what.
 *
 * A PLAIN DISCLOSURE, NOT AN ARIA MENU. The panel contains ordinary navigation
 * links, so `role="menu"`/`menuitem` would promise an application-menu keyboard
 * model — Arrow/Home/End, roving tabindex — that these links neither need nor
 * implement. Announcing semantics you have not built is worse than using the
 * simpler correct pattern: a button with `aria-expanded` plus a list of links
 * that Tab reaches in document order.
 *
 * WHICH MAKES NATIVE TAB THE ONLY WAY THROUGH THE LINKS — so closing on a Tab
 * KEYPRESS breaks the pattern it is meant to implement. The first version of this
 * component did exactly that: any Tab inside the panel closed it, so a keyboard
 * user could reach the first destination and then had the rest removed from under
 * them. The disclosure now closes on FOCUS LEAVING its root instead, which the
 * browser reports after traversal has already been decided. That handles
 * Shift+Tab identically and needs no key interception at all.
 *
 * Open state is OWNED BY TopNav (`open`/`onOpenChange`) so one component
 * arbitrates mutual exclusion across all four disclosures, and this one never
 * registers a competing document listener.
 */

import Link from "next/link";

export type MoreNavItem = {
  key: string;
  label: string;
  href: string;
  /** True when the current route is this destination; set by TopNav, not derived here. */
  current: boolean;
};

export default function MoreNav({
  items,
  open,
  onOpenChange,
  triggerRef,
}: {
  items: readonly MoreNavItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
}) {
  // Never render an empty disclosure — a trigger that opens onto nothing is a
  // dead control. TopNav also gates on this, but the component refuses too.
  if (items.length === 0) return null;

  const hasCurrent = items.some((item) => item.current);

  function close(returnFocus: boolean) {
    onOpenChange(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  /**
   * Escape ONLY. Tab is deliberately not handled: the browser owns traversal, and
   * `handleFocusLeave` decides afterwards whether focus actually left. Closing on
   * the Tab keydown itself would remove the panel before the user could reach the
   * links past the first one.
   */
  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      // Handled here and not propagated, so TopNav's own Escape lifecycle cannot
      // also fire and double-close or double-focus.
      event.stopPropagation();
      close(true);
    }
  }

  /**
   * Close only when focus actually EXITS the disclosure. `relatedTarget` is the
   * element receiving focus; a null value (focus leaving the document or moving to
   * a non-focusable area) also counts as leaving. Movement between the trigger and
   * the links stays inside `currentTarget`, so internal traversal keeps it open.
   */
  function handleFocusLeave(event: React.FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      onOpenChange(false);
    }
  }

  return (
    <div className="relative" onBlur={handleFocusLeave}>
      <button
        ref={triggerRef}
        type="button"
        id="more-nav-button"
        aria-expanded={open}
        aria-controls="more-nav"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          // Enter/Space are the button's native activation; only Escape needs handling.
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
        }}
        className={`rounded-md px-3 py-1.5 text-[15px] font-medium transition-colors hover:bg-cp-raised hover:text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${
          hasCurrent ? "text-cp-text" : "text-cp-muted"
        }`}
      >
        More
        {/*
          `aria-current="page"` belongs on the destination inside, never here:
          "More" is not a route. When the active page lives under this
          disclosure, the visual treatment above is paired with this
          screen-reader-only sentence so the state is not colour-only.
        */}
        {hasCurrent && <span className="sr-only"> (contains the current page)</span>}
        <span aria-hidden="true" className="ml-1 text-cp-faint">
          ▾
        </span>
      </button>

      {open && (
        <div
          id="more-nav"
          aria-labelledby="more-nav-button"
          onKeyDown={handlePanelKeyDown}
          className="absolute right-0 z-50 mt-1 w-56 rounded-lg border border-cp-border bg-cp-surface py-1 shadow-lg"
        >
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              {...(item.current ? { "aria-current": "page" as const } : {})}
              onClick={() => close(false)}
              className={`block px-3 py-2 text-sm transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${
                item.current ? "font-semibold text-cp-text" : "text-cp-muted"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
