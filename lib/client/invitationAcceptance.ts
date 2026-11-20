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

const supersededListeners = new Set<() => void>();

/**
 * Review R7 F3/F4: lets the page re-render deterministically at the moment of hand-off (`useSyncExternalStore`), so a
 * superseded document shows only the loading view — never an earlier invitation's outcome or error. In-memory only.
 */
export function subscribeInvitationDocumentSuperseded(listener: () => void): () => void {
  supersededListeners.add(listener);
  return () => {
    supersededListeners.delete(listener);
  };
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
  const first = !envelopeOwnershipHandedOff;
  envelopeOwnershipHandedOff = true;
  if (first) {
    for (const listener of Array.from(supersededListeners)) {
      try {
        listener();
      } catch {
        /* a listener never blocks the hand-off */
      }
    }
  }
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
const MAX_ENTITY_PASSES = 3;
const MAX_NORMALIZED_LENGTH = 4 * MAX_CLASSIFIED_URL_LENGTH;
const ESCAPE_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const HAS_WELL_FORMED_ESCAPE = /%[0-9a-fA-F]{2}/;
// Review R7 F2: a credential key (any case, any prefix — `x_token`, `amptoken` from a mangled `&amp;`), optionally
// plural or with an array suffix (`tokens`, `token[]`), up to three filler characters, then `=`, `:` or U+FFFD (an
// invalid/overlong encoded separator such as `%C0%BD`). Matched on raw, decoded and normalized text.
const CREDENTIAL_KEY = /(token|invitation[\s_.-]*id)s?(?:\[[^\]]{0,8}\])?[\s_.-]{0,3}(=|:|\uFFFD)/i;
// Review R7 F1: URL component boundaries — path segments, query / fragment parts, keys and values. NOT `:`, `.`, `-`
// or other characters that join parts of one identifier (e.g. a claim id `v1:findings:4:<43-char SHA-256 base64url>`).
const URL_COMPONENT_SEPARATORS = /[/\?#&;=\s]+/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// Review R7 F1: the invitation token is 32 random bytes as base64url — exactly 43 characters (see
// lib/workspaces/invitationToken.ts). A STANDALONE URL component of exactly that shape with both letter cases (a
// random token lacks one with probability ~1e-10; lower-case slugs are left alone) is treated as a token.
const TOKEN_LENGTH = 43;
const ACCEPTANCE_PATH_PREFIX = INVITATION_ACCEPTANCE_ROUTE_PATH.toLowerCase();

/**
 * Review R7 F2: an explicit, deliberately incomplete list of known lookalikes for the letters of the credential keys
 * and the acceptance path (Cyrillic / Greek / small-capital letters, Unicode dashes). NFKC (below) handles fullwidth
 * and compatibility forms; neither is a complete confusables solution, which is why invalid or ambiguous key-like
 * material also fails closed (see `classifyText`).
 */
const KNOWN_ALIASES: Record<string, string> = {
  "\u0430": "a", "\u0410": "A", "\u03B1": "a", "\u0391": "A", "\u1D00": "a",
  "\u0501": "d", "\u1D05": "d",
  "\u0435": "e", "\u0415": "E", "\u03B5": "e", "\u0395": "E", "\u1D07": "e",
  "\u0456": "i", "\u0406": "I", "\u03B9": "i", "\u0399": "I", "\u0131": "i", "\u026A": "i", "\u04CF": "i",
  "\u043A": "k", "\u041A": "K", "\u03BA": "k", "\u039A": "K", "\u1D0B": "k",
  "\u0578": "n", "\u039D": "N", "\u0274": "n",
  "\u043E": "o", "\u041E": "O", "\u03BF": "o", "\u039F": "O", "\u1D0F": "o", "\u0585": "o",
  "\u0442": "t", "\u0422": "T", "\u03C4": "t", "\u03A4": "T", "\u1D1B": "t",
  "\u03BD": "v", "\u0475": "v", "\u1D20": "v",
  "\u0440": "p", "\u0420": "P", "\u0441": "c", "\u0421": "C", "\u0445": "x", "\u0425": "X", "\u0455": "s", "\u0405": "S",
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-", "\uFE63": "-", "\uFF0D": "-",
};
const ALIAS_PATTERN = new RegExp(`[${Object.keys(KNOWN_ALIASES).join("")}]`, "g");
// C0/C1 controls, soft hyphen, zero-width and bidi controls: invisible characters that can split a key.
const INVISIBLES = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", equals: "=", lowbar: "_", colon: ":", num: "#", quest: "?", sol: "/", period: ".", hyphen: "-", dash: "-" };

type Decoded = { text: string; settled: boolean };

function decodeEscapeRun(run: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < run.length; i += 3) bytes.push(parseInt(run.slice(i + 1, i + 3), 16));
  try {
    if (typeof TextDecoder === "function") return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes)); // invalid/overlong \u2192 U+FFFD
  } catch {
    /* fall through */
  }
  return String.fromCharCode(...bytes);
}

/**
 * Decodes well-formed escapes (as UTF-8; invalid or overlong sequences become U+FFFD) and `+`, layer by layer.
 * A stray `%` is left as is. `settled` is false when the layer limit was reached first.
 */
function decodeBounded(input: string): Decoded {
  let text = input;
  for (let n = 0; n < MAX_DECODE_LAYERS; n++) {
    const next = text.replace(/\+/g, " ").replace(ESCAPE_RUN, decodeEscapeRun);
    if (next === text) return { text, settled: true };
    text = next;
  }
  return { text, settled: !HAS_WELL_FORMED_ESCAPE.test(text) };
}

function codePointText(cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
}

/**
 * Review R7 F2: bounded normalization for MATCHING only (never used to accept anything): HTML entities (at most
 * MAX_ENTITY_PASSES passes, e.g. `&amp;#61;`), NFKC, invisible characters removed, known aliases mapped. `null` when
 * the result would exceed MAX_NORMALIZED_LENGTH (the caller fails closed).
 */
function normalizeForMatching(text: string): string | null {
  let t = text;
  for (let n = 0; n < MAX_ENTITY_PASSES; n++) {
    const next = t
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex: string) => codePointText(parseInt(hex, 16)))
      .replace(/&#([0-9]{1,7});?/g, (_m, dec: string) => codePointText(parseInt(dec, 10)))
      .replace(/&([a-z]{2,8});/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    if (next === t) break;
    t = next;
  }
  try {
    t = t.normalize("NFKC");
  } catch {
    /* keep the un-normalized text; the other checks still apply */
  }
  if (t.length > MAX_NORMALIZED_LENGTH) return null;
  return t.replace(INVISIBLES, "").replace(ALIAS_PATTERN, (ch) => KNOWN_ALIASES[ch] ?? ch);
}

const mixedCase = (v: string) => /[A-Z]/.test(v) && /[a-z]/.test(v);

/**
 * Review R7 F1 (+ F2 missing separator): a URL component that is exactly token-shaped, or a credential key glued
 * directly to a token-like value (`token<value>`). Linear: one split, one anchored test per component.
 */
function hasTokenShapedComponent(text: string): boolean {
  for (const component of text.split(URL_COMPONENT_SEPARATORS)) {
    if (component.length === TOKEN_LENGTH && TOKEN_SHAPE.test(component) && mixedCase(component)) return true;
    const glued = /^(token|invitationid)([A-Za-z0-9_-]{32,})$/i.exec(component);
    if (glued && mixedCase(glued[2])) return true;
  }
  return false;
}

function classifyText(raw: string): boolean {
  if (raw.length > MAX_CLASSIFIED_URL_LENGTH) return true; // too long to classify confidently: fail closed
  const decoded = decodeBounded(raw);
  if (!decoded.settled) return true; // still encoded after the layer limit: ambiguous, fail closed
  const normalized = normalizeForMatching(decoded.text);
  if (normalized === null) return true;
  for (const t of [raw, decoded.text, normalized]) {
    if (CREDENTIAL_KEY.test(t) || hasTokenShapedComponent(t)) return true;
  }
  // Uncertain: invalid UTF-8 (U+FFFD) or invisible characters next to key-like material cannot be classified
  // confidently — fail closed.
  if ((decoded.text.includes("\uFFFD") || INVISIBLES_TEST.test(decoded.text)) && /tok|invit/i.test(normalized)) return true;
  return false;
}
const INVISIBLES_TEST = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

/**
 * Whether a decoded path is the acceptance route in any spelling: case, repeated slashes, backslashes, known aliases,
 * and any non-alphanumeric continuation (`accept/…`, `accept;x`, `accept.`, `accept#…`, `accept ` …).
 */
function isAcceptancePathPrefix(decodedPath: string): boolean {
  const normalized = (normalizeForMatching(decodedPath) ?? decodedPath).replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  if (!normalized.startsWith(ACCEPTANCE_PATH_PREFIX)) return false;
  const next = normalized.charAt(ACCEPTANCE_PATH_PREFIX.length);
  return next === "" || !/[a-z0-9]/.test(next);
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
