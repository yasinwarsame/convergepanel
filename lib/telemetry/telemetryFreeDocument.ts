/**
 * Private advisory GHSA-655j-5f43-92pw — documents loaded as the workspace
 * invitation acceptance link never initialize browser telemetry.
 *
 * Removing the credential fragment from the address bar before the SDKs start
 * (scrubUrlBeforeTelemetry) is not sufficient on its own: the browser keeps the
 * ORIGINAL document URL — fragment included — in the navigation timing entry
 * (`performance.getEntriesByType("navigation")[0].name`) for the life of the
 * document, `history.replaceState` cannot change it, and SDKs read it (pageload
 * child spans, Replay navigation spans, web-vitals attribution). So neither
 * Sentry nor PostHog is initialized at all in such a document, for its whole
 * lifetime — including after client-side navigations away from the page.
 * Telemetry resumes on the next full page load, whose navigation entry is clean.
 *
 * Decided once per document from the navigation entry (falls back to the current
 * pathname where the Performance API is unavailable; if both are unreadable,
 * telemetry stays off — fail closed). Dependency-free, never throws, never logs.
 */
import { INVITATION_ACCEPTANCE_ROUTE_PATH } from "@/lib/client/invitationAcceptance";

type DocWindow = {
  location?: { pathname?: string } | null;
  performance?: { getEntriesByType?: (type: string) => ArrayLike<{ name?: string }> } | null;
};

let decision: boolean | null = null;

function pathnameOf(url: string): string | null {
  try {
    return new URL(url, "https://document.invalid").pathname;
  } catch {
    return null;
  }
}

function isAcceptancePath(pathname: string | null | undefined): boolean {
  return pathname === INVITATION_ACCEPTANCE_ROUTE_PATH || pathname === `${INVITATION_ACCEPTANCE_ROUTE_PATH}/`;
}

function decide(win: DocWindow): boolean {
  let navigationName: string | undefined;
  try {
    const entries = win.performance?.getEntriesByType?.("navigation");
    const first = entries && entries.length > 0 ? entries[0] : undefined;
    navigationName = typeof first?.name === "string" && first.name !== "" ? first.name : undefined;
  } catch {
    navigationName = undefined;
  }
  if (navigationName !== undefined) return isAcceptancePath(pathnameOf(navigationName));
  try {
    return isAcceptancePath(String(win.location?.pathname ?? ""));
  } catch {
    return true; // cannot tell which document this is: no telemetry
  }
}

/** True when this document was loaded as the invitation acceptance page: browser telemetry must not initialize. */
export function isTelemetryFreeDocument(win: DocWindow | undefined = typeof window !== "undefined" ? (window as unknown as DocWindow) : undefined): boolean {
  if (!win) return false; // server render: nothing to initialize
  if (decision === null) decision = decide(win);
  return decision;
}
