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
 * telemetry stays off — fail closed). Correction round (MINOR-1): a document that
 * starts while the tab holds the invitation continuity envelope (sessionStorage)
 * is telemetry-free as well, whatever its URL. Dependency-free, never throws, never logs.
 */
import { hasInvitationAcceptanceEnvelope, INVITATION_ACCEPTANCE_ROUTE_PATH } from "@/lib/client/invitationAcceptance";

type DocWindow = {
  location?: { pathname?: string } | null;
  performance?: { getEntriesByType?: (type: string) => ArrayLike<{ name?: string }> } | null;
  sessionStorage?: Pick<Storage, "getItem"> | null;
};

let decision: boolean | null = null;

function pathnameOf(url: string): string | null {
  try {
    return new URL(url, "https://document.invalid").pathname;
  } catch {
    return null;
  }
}

/**
 * Correction round (review R2 NIT-1): a navigation entry whose fragment carries an invitation-credential-shaped key
 * (`token` / `invitationId`, any case) makes the document telemetry-free whatever its path — e.g. a non-canonical
 * spelling such as `/workspace-invitations/%61ccept#…` that the router still serves but `isAcceptancePath` does not
 * match. Tolerant parse; an unparseable fragment that mentions either key also counts (fail closed).
 */
function hasCredentialShapedFragment(url: string): boolean {
  const i = url.indexOf("#");
  if (i < 0) return false;
  const fragment = url.slice(i + 1);
  if (fragment === "") return false;
  try {
    for (const key of new URLSearchParams(fragment).keys()) {
      const k = key.toLowerCase();
      if (k === "token" || k === "invitationid") return true;
    }
    return false;
  } catch {
    return /(^|[&;])\s*(token|invitationid)\s*=/i.test(fragment);
  }
}

function isAcceptancePath(pathname: string | null | undefined): boolean {
  return pathname === INVITATION_ACCEPTANCE_ROUTE_PATH || pathname === `${INVITATION_ACCEPTANCE_ROUTE_PATH}/`;
}

function envelopePresent(win: DocWindow): boolean {
  let storage: Pick<Storage, "getItem"> | null = null;
  try {
    storage = win.sessionStorage ?? null; // the getter throws when site data is blocked
  } catch {
    storage = null;
  }
  return hasInvitationAcceptanceEnvelope(storage);
}

function decide(win: DocWindow): boolean {
  // Correction round (MINOR-1): a document that starts while this tab still holds the invitation continuity envelope
  // (a reload of /login mid-flow, a sign-in redirect return, a duplicated tab, any full-page navigation before the
  // invitation is accepted, rejected or the envelope expires) can reach the raw token, so it is telemetry-free too.
  if (envelopePresent(win)) return true;
  return decideFromDocumentUrl(win);
}

function decideFromDocumentUrl(win: DocWindow): boolean {
  let navigationName: string | undefined;
  try {
    const entries = win.performance?.getEntriesByType?.("navigation");
    const first = entries && entries.length > 0 ? entries[0] : undefined;
    navigationName = typeof first?.name === "string" && first.name !== "" ? first.name : undefined;
  } catch {
    navigationName = undefined;
  }
  if (navigationName !== undefined) return isAcceptancePath(pathnameOf(navigationName)) || hasCredentialShapedFragment(navigationName);
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
