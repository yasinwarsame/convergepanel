/**
 * Team Workspace Invitations, Phase 8D.3.1 — browser credential utility
 * behavior for the invitation-acceptance link
 * (`/workspace-invitations/accept#invitationId=...&token=...`).
 *
 * Scope is deliberately narrow: fragment parsing, malformed-percent
 * validation, input bounds, the transient sessionStorage envelope, and the
 * post-capture history scrub. This module performs NO fetch/API calls, NO
 * Firebase auth, NO navigation (router-level), and NO UI rendering — all of
 * that lives in `AcceptInvitationClient.tsx`, which is the only caller.
 *
 * `URLSearchParams` already percent-decodes `.get()`/`.getAll()` results —
 * running `decodeURIComponent()` on top of that would risk ambiguous or
 * double decoding of a security-relevant credential, so this module decodes
 * exactly once. Malformed percent-encoding is rejected on the RAW fragment
 * substring, before `URLSearchParams` gets a chance to tolerantly normalize
 * it away.
 */

export const SESSION_STORAGE_KEY = "convergepanel.invitationAcceptance.v1";

export const INVITATION_ACCEPTANCE_TTL_MS = 30 * 60 * 1000;

export const INVITATION_ACCEPTANCE_ROUTE_PATH = "/workspace-invitations/accept";

const MAX_INVITATION_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 512;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

export interface InvitationAcceptanceCredential {
  invitationId: string;
  token: string;
}

export type ParsedInvitationFragment = ({ kind: "valid" } & InvitationAcceptanceCredential) | { kind: "invalid" };

function hasMalformedPercentEncoding(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "%") continue;
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return true;
  }
  return false;
}

function isWithinBounds(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && !CONTROL_CHAR_PATTERN.test(value);
}

/**
 * Parses the raw `location.hash` (leading "#" optional) into a credential.
 * Unknown extra fragment fields are ignored. Duplicate `invitationId`/
 * `token` fields are rejected outright rather than resolved via
 * first-wins/last-wins, since either choice would silently accept an
 * ambiguous, attacker-influenceable input.
 */
export function parseInvitationFragment(rawHash: string): ParsedInvitationFragment {
  if (typeof rawHash !== "string") return { kind: "invalid" };

  const withoutLeadingHash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (withoutLeadingHash.length === 0) return { kind: "invalid" };
  if (hasMalformedPercentEncoding(withoutLeadingHash)) return { kind: "invalid" };

  const params = new URLSearchParams(withoutLeadingHash);
  const invitationIds = params.getAll("invitationId");
  const tokens = params.getAll("token");
  if (invitationIds.length !== 1 || tokens.length !== 1) return { kind: "invalid" };

  const invitationId = invitationIds[0];
  const token = tokens[0];
  if (!isWithinBounds(invitationId, MAX_INVITATION_ID_LENGTH)) return { kind: "invalid" };
  if (!isWithinBounds(token, MAX_TOKEN_LENGTH)) return { kind: "invalid" };

  return { kind: "valid", invitationId, token };
}

interface StoredInvitationAcceptanceEnvelope {
  version: 1;
  invitationId: string;
  token: string;
  storedAt: number;
}

function isValidEnvelopeShape(value: unknown): value is StoredInvitationAcceptanceEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.invitationId === "string" &&
    isWithinBounds(v.invitationId, MAX_INVITATION_ID_LENGTH) &&
    typeof v.token === "string" &&
    isWithinBounds(v.token, MAX_TOKEN_LENGTH) &&
    typeof v.storedAt === "number" &&
    Number.isFinite(v.storedAt)
  );
}

/** Best-effort write — a quota/private-mode exception leaves nothing stored, never throws. */
export function storeInvitationAcceptance(storage: Pick<Storage, "setItem">, credential: InvitationAcceptanceCredential, now: number): void {
  const envelope: StoredInvitationAcceptanceEnvelope = { version: 1, invitationId: credential.invitationId, token: credential.token, storedAt: now };
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage unavailable — caller proceeds without persisted continuity.
  }
}

/** Best-effort — never throws. Malformed, wrong-version, or expired records are cleared, not silently extended. */
export function restoreInvitationAcceptance(storage: Pick<Storage, "getItem" | "removeItem">, now: number): InvitationAcceptanceCredential | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearInvitationAcceptance(storage);
    return null;
  }

  if (!isValidEnvelopeShape(parsed)) {
    clearInvitationAcceptance(storage);
    return null;
  }

  const age = now - parsed.storedAt;
  if (!Number.isFinite(age) || age < 0 || age > INVITATION_ACCEPTANCE_TTL_MS) {
    clearInvitationAcceptance(storage);
    return null;
  }

  return { invitationId: parsed.invitationId, token: parsed.token };
}

export function clearInvitationAcceptance(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

export interface ScrubbableHistory {
  readonly state: unknown;
  replaceState(state: unknown, title: string, url?: string | URL | null): void;
}

/**
 * GHSA-655j-5f43-92pw — the one-time, in-memory hand-off of the acceptance
 * credential from the pre-telemetry URL scrub to the acceptance page.
 *
 * `scrubUrlBeforeTelemetry()` (first statement of `instrumentation-client.ts`,
 * prepended to the `main-app` entry in production builds, and again just before
 * `posthog.init`) calls `captureInvitationCredentialFromLocation()` and then
 * drops the fragment from the address bar, so neither SDK observes the
 * credential at initialization. The page takes it with
 * `takeCapturedInvitationCredential()`.
 *
 * Held ONLY in this module's closure: never in sessionStorage / localStorage /
 * cookies / `history.state` / a window global. It does not survive a reload:
 * a reload of the already-scrubbed URL behaves exactly as before (the existing
 * sessionStorage continuity envelope, written only on the signed-out /
 * verification / re-auth paths, or `invalid_or_expired`). Taken at most once.
 * A credential-shaped fragment on any other path is never captured.
 */
let capturedCredential: ParsedInvitationFragment | null = null;

function isAcceptancePath(pathname: string): boolean {
  return pathname === INVITATION_ACCEPTANCE_ROUTE_PATH || pathname === `${INVITATION_ACCEPTANCE_ROUTE_PATH}/`;
}

/** Captures the acceptance page's credential fragment into memory. Never throws, never logs, never stores. */
export function captureInvitationCredentialFromLocation(location: { pathname: string; hash: string } | null | undefined): void {
  try {
    if (!location || !isAcceptancePath(String(location.pathname))) return;
    const rawHash = String(location.hash ?? "");
    if (rawHash.length <= 1) return; // no fragment or a bare "#": nothing to capture, and an earlier capture is kept
    capturedCredential = parseInvitationFragment(rawHash);
  } catch {
    capturedCredential = { kind: "invalid" };
  }
}

/**
 * Correction round (review R2 NIT-1): a navigation entry whose fragment carries an invitation-credential-shaped key
 * (`token` / `invitationId`, any case) makes the document telemetry-free whatever its path — e.g. a non-canonical
 * spelling such as `/workspace-invitations/%61ccept#…` that the router still serves but `isAcceptancePath` does not
 * match. Accepts a URL or a raw `location.hash`. Tolerant parse; an unparseable fragment that mentions either key also
 * counts (fail closed).
 */
export function hasCredentialShapedFragment(url: string): boolean {
  const i = url.indexOf("#");
  if (i < 0) return false; // a raw location.hash always starts with "#"
  let fragment = url.slice(i + 1);
  if (fragment === "") return false;
  // Review R5 MINOR-1: percent-decode (up to 3 layers, tolerant) so an encoded key (`invitationId%3D…%26token%3D…`)
  // or a key with surrounding whitespace is still recognised. Fail closed: any key-like `token=` / `invitationid=`.
  for (let n = 0; n < 3; n++) {
    let next: string;
    try {
      next = decodeURIComponent(fragment.replace(/\+/g, " "));
    } catch {
      break;
    }
    if (next === fragment) break;
    fragment = next;
  }
  return /(^|[&;?#\s])\s*(token|invitationid)\s*=/i.test(fragment);
}

/** A plain in-page anchor (`#main`, `#section-2`): the only fragment shape the same-document guard leaves alone. */
function isPlainAnchor(rawHash: string): boolean {
  return /^#[A-Za-z][\w-]*$/.test(rawHash);
}

/**
 * GHSA-655j-5f43-92pw (correction round, MINOR-1): whether this tab's existing continuity envelope is present. Any
 * value under the key counts (it may hold a still-redeemable token even if malformed or past the client TTL). Read-only.
 * `false` when sessionStorage is unusable: the envelope is written only through this same tab storage, and an SDK in a
 * document where that storage is blocked cannot read it either.
 */
export function hasInvitationAcceptanceEnvelope(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return !!storage && storage.getItem(SESSION_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * GHSA-655j-5f43-92pw (correction round, MINOR-1): removes an expired or malformed envelope before the telemetry
 * decision, so a stale envelope does not keep later documents telemetry-free. A valid, in-TTL envelope is left as is.
 */
export function purgeStaleInvitationAcceptance(storage: Pick<Storage, "getItem" | "removeItem"> | null | undefined, now: number): void {
  if (!storage) return;
  try {
    restoreInvitationAcceptance(storage, now); // clears malformed / wrong-version / expired records; never throws
  } catch {
    /* never throws */
  }
}

type GuardWindow = {
  location: Pick<Location, "pathname" | "search" | "hash" | "replace">;
  history?: Pick<History, "replaceState" | "state"> | null;
  sessionStorage?: Storage | null;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
};

let fragmentGuardInstalled = false;

/**
 * GHSA-655j-5f43-92pw (correction round, MINOR-2): a credential fragment that arrives by a SAME-DOCUMENT navigation
 * (a second invitation link opened in a tab already on the acceptance page) is never processed in that document and
 * never silently dropped. Installed from the pre-telemetry scrub, i.e. before `Sentry.init` registers its history
 * handlers, so this listener runs first on `popstate` / `hashchange`. It:
 *   1. parses the fragment, then removes it from the address bar (replaceState) and stops later listeners;
 *   2. valid → writes it to the EXISTING tab envelope (the fragment is authoritative: it replaces any earlier one);
 *      invalid → clears the envelope;
 *   3. replaces the document with a full load of the clean acceptance URL. That new document starts with the envelope
 *      present, so it never initializes telemetry (isTelemetryFreeDocument), and the page restores the credential.
 * Never logs. Idempotent.
 */
export function installInvitationFragmentNavigationGuard(win: GuardWindow | undefined): void {
  if (fragmentGuardInstalled || !win || typeof win.addEventListener !== "function") return;
  fragmentGuardInstalled = true;
  const onNavigation = (event: Event) => {
    let rawHash = "";
    try {
      if (!isAcceptancePath(String(win.location.pathname))) return;
      rawHash = String(win.location.hash ?? "");
    } catch {
      return;
    }
    if (rawHash.length <= 1) return;
    // Review R4 NIT-4 / R5 MINOR-1: only a strict plain anchor (e.g. "#main") is left alone (with any in-progress
    // verification / re-auth envelope); every other fragment, encoded or not, is handled (invalid ones fail closed).
    if (isPlainAnchor(rawHash) && !hasCredentialShapedFragment(rawHash)) return;
    let parsed: ParsedInvitationFragment;
    try {
      parsed = parseInvitationFragment(rawHash);
    } catch {
      parsed = { kind: "invalid" };
    }
    try {
      win.history?.replaceState(win.history.state, "", `${String(win.location.pathname)}${String(win.location.search ?? "")}`);
    } catch {
      /* the replace below still leaves this document */
    }
    try {
      event.stopImmediatePropagation();
    } catch {
      /* best effort */
    }
    let storage: Storage | null = null;
    try {
      storage = win.sessionStorage ?? null;
    } catch {
      storage = null;
    }
    if (storage) {
      if (parsed.kind === "valid") storeInvitationAcceptance(storage, { invitationId: parsed.invitationId, token: parsed.token }, Date.now());
      else clearInvitationAcceptance(storage);
    }
    try {
      win.location.replace(INVITATION_ACCEPTANCE_ROUTE_PATH);
    } catch {
      /* nothing else to do */
    }
  };
  try {
    win.addEventListener("popstate", onNavigation);
    win.addEventListener("hashchange", onNavigation);
  } catch {
    /* best effort */
  }
}

/** Returns the captured credential (valid or invalid) and forgets it; `null` when nothing was captured. */
export function takeCapturedInvitationCredential(): ParsedInvitationFragment | null {
  const taken = capturedCredential;
  capturedCredential = null;
  return taken;
}

/**
 * Rewrites the current history entry to strip the credential-bearing
 * fragment, preserving whatever `history.state` Next.js's router already
 * placed there. Never `null` (would blow away router state) and never
 * `pushState` (would leave a credential-bearing entry reachable via back
 * navigation).
 */
export function scrubInvitationAcceptanceHistory(history: ScrubbableHistory, pathname: string = INVITATION_ACCEPTANCE_ROUTE_PATH): void {
  history.replaceState(history.state, "", pathname);
}
