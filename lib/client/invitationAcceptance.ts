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

/**
 * GHSA-655j-5f43-92pw (review R6 MINOR-3): envelope OWNERSHIP. A document that hands the tab's credential to a fresh
 * document (the same-document fragment guard, or the page's telemetry-on gates, which then `location.replace`) gives up
 * write access to the envelope for the rest of its life: from then on `storeInvitationAcceptance`,
 * `clearInvitationAcceptance` and `restoreInvitationAcceptance` are no-ops in it. So work this document started for an
 * earlier credential A (a fetch that resolves or rejects later, an auth-state effect, a cleanup handler) can never
 * restore A over the successor's credential B, clear B, or extend B's expiry. Enforced HERE, at the storage boundary,
 * so it holds for every caller. One-way; module state of this document only.
 */
let envelopeOwnershipHandedOff = false;

/** Whether this document has handed the invitation credential to a successor document (see above). */
export function isInvitationDocumentSuperseded(): boolean {
  return envelopeOwnershipHandedOff;
}

/**
 * Hands the tab's invitation state to a successor document: valid → the envelope now holds `credential` (it replaces
 * any earlier one); invalid → the envelope is cleared. Then this document loses envelope write access. The caller
 * performs the `location.replace`. Never throws, never logs.
 */
export function handOffInvitationCredential(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, parsed: ParsedInvitationFragment | null): void {
  if (storage) {
    if (parsed && parsed.kind === "valid") writeEnvelope(storage, { invitationId: parsed.invitationId, token: parsed.token }, Date.now());
    else if (parsed) removeEnvelope(storage);
  }
  envelopeOwnershipHandedOff = true;
}

function writeEnvelope(storage: Pick<Storage, "setItem">, credential: InvitationAcceptanceCredential, now: number): void {
  const envelope: StoredInvitationAcceptanceEnvelope = { version: 1, invitationId: credential.invitationId, token: credential.token, storedAt: now };
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage unavailable — caller proceeds without persisted continuity.
  }
}

function removeEnvelope(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

/** Best-effort write — a quota/private-mode exception leaves nothing stored, never throws. No-op once superseded. */
export function storeInvitationAcceptance(storage: Pick<Storage, "setItem">, credential: InvitationAcceptanceCredential, now: number): void {
  if (envelopeOwnershipHandedOff) return;
  writeEnvelope(storage, credential, now);
}

/** Best-effort — never throws. Malformed, wrong-version, or expired records are cleared, not silently extended. `null` once superseded. */
export function restoreInvitationAcceptance(storage: Pick<Storage, "getItem" | "removeItem">, now: number): InvitationAcceptanceCredential | null {
  if (envelopeOwnershipHandedOff) return null;
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

/** No-op once superseded (it would clear the successor's credential). */
export function clearInvitationAcceptance(storage: Pick<Storage, "removeItem">): void {
  if (envelopeOwnershipHandedOff) return;
  removeEnvelope(storage);
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
 * GHSA-655j-5f43-92pw (review R6 MINOR-1 / MINOR-2): bounded, tolerant, FAIL-CLOSED detection of invitation-credential
 * material anywhere in a URL — path, query and fragment — including non-canonical and e-mail-rewritten forms (a `#`
 * rewritten to `%23` puts the fragment in the PATH; extra encoding layers; a stray `%`; mixed-case escapes; encoded key
 * names; HTML-escaped `=`). Detection only: it decides that a document must not initialize telemetry. It never makes a
 * URL acceptable or redeemable — acceptance still requires the exact path and `parseInvitationFragment`.
 *
 * Only well-formed `%XX` escapes are decoded (a stray `%` is left as is and never aborts the scan), repeated until the
 * text stops changing, at most MAX_DECODE_LAYERS times. Anything the classifier cannot settle within its limits —
 * input longer than MAX_CLASSIFIED_URL_LENGTH, escapes still present after the last layer, a URL that cannot be parsed
 * — is classified as credential-bearing (suppress telemetry). Never throws, never logs, never stores.
 */
const MAX_CLASSIFIED_URL_LENGTH = 8192;
const MAX_DECODE_LAYERS = 8;
const WELL_FORMED_ESCAPE = /%([0-9a-fA-F]{2})/g;
const HAS_WELL_FORMED_ESCAPE = /%[0-9a-fA-F]{2}/;
// A credential key (any case) preceded by start-of-text or any non-alphanumeric separator, followed by `=` (also as
// an HTML entity). Matches `token=`, `?Token =`, `/accept#invitationId=`, `x_token=` (over-matching is the safe side).
const CREDENTIAL_KEY = /(^|[^a-z0-9])(token|invitation[\s_-]*id)\s*(=|&#0*61;?|&#x0*3d;?|&equals;?)/i;
const ACCEPTANCE_PATH_PREFIX = INVITATION_ACCEPTANCE_ROUTE_PATH.toLowerCase();

type Decoded = { text: string; settled: boolean };

/** Decodes well-formed escapes (and `+`) layer by layer; `settled` is false when the layer limit was reached first. */
function decodeBounded(input: string): Decoded {
  let text = input;
  for (let n = 0; n < MAX_DECODE_LAYERS; n++) {
    const next = text.replace(/\+/g, " ").replace(WELL_FORMED_ESCAPE, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === text) return { text, settled: true };
    text = next;
  }
  return { text, settled: !HAS_WELL_FORMED_ESCAPE.test(text) };
}

function classifyText(raw: string): boolean {
  if (raw.length > MAX_CLASSIFIED_URL_LENGTH) return true; // too long to classify confidently: fail closed
  const decoded = decodeBounded(raw);
  if (!decoded.settled) return true; // still encoded after the layer limit: ambiguous, fail closed
  return CREDENTIAL_KEY.test(raw) || CREDENTIAL_KEY.test(decoded.text);
}

/** Whether a decoded path is the acceptance route in any spelling (case, repeated slashes, trailing segments). */
function isAcceptancePathPrefix(decodedPath: string): boolean {
  const normalized = decodedPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  return normalized === ACCEPTANCE_PATH_PREFIX || normalized.startsWith(`${ACCEPTANCE_PATH_PREFIX}/`) || normalized.startsWith(ACCEPTANCE_PATH_PREFIX + "#") || normalized.startsWith(ACCEPTANCE_PATH_PREFIX + "?");
}

/**
 * True when a URL (absolute, or a path) may carry an invitation credential, or cannot be classified confidently:
 * the document it names must not initialize browser telemetry.
 */
export function isCredentialBearingUrl(url: string): boolean {
  try {
    if (typeof url !== "string") return true;
    if (url === "") return false;
    if (classifyText(url)) return true;
    let pathname: string;
    try {
      pathname = new URL(url, "https://document.invalid").pathname;
    } catch {
      return true; // unparseable: fail closed
    }
    const decodedPath = decodeBounded(pathname);
    if (!decodedPath.settled) return true;
    return isAcceptancePathPrefix(decodedPath.text);
  } catch {
    return true;
  }
}

/**
 * Correction round (review R2 NIT-1, R5 MINOR-1, R6 MINOR-1): whether the FRAGMENT of a URL (or a raw `location.hash`)
 * carries an invitation-credential-shaped key, using the same bounded fail-closed classifier as
 * `isCredentialBearingUrl`. `false` only when there is no fragment.
 */
export function hasCredentialShapedFragment(url: string): boolean {
  try {
    const i = url.indexOf("#");
    if (i < 0) return false; // a raw location.hash always starts with "#"
    const fragment = url.slice(i + 1);
    if (fragment === "") return false;
    return classifyText(fragment);
  } catch {
    return true;
  }
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
 *      invalid → clears the envelope; either way this document then loses envelope write access (R6 MINOR-3);
 *   3. replaces the document with a full load of the clean acceptance URL. That new document starts with the envelope
 *      present, so it never initializes telemetry (isTelemetryFreeDocument), and the page restores the credential.
 * Never logs. Idempotent.
 */
export function installInvitationFragmentNavigationGuard(win: GuardWindow | undefined): void {
  if (fragmentGuardInstalled || !win || typeof win.addEventListener !== "function") return;
  fragmentGuardInstalled = true;
  const onNavigation = (event: Event) => {
    // Review R6 NIT-1: once this document has handed the credential off it is leaving; no later popstate/hashchange
    // (e.g. the hashchange that follows a handled popstate, whose newURL still holds the fragment) reaches any other
    // listener. A further credential fragment is still handled below (the latest link wins).
    if (envelopeOwnershipHandedOff) {
      try {
        event.stopImmediatePropagation();
      } catch {
        /* best effort */
      }
    }
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
    handOffInvitationCredential(storage, parsed);
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
