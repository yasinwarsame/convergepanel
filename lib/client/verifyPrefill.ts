/**
 * Privacy remediation PR #329 — tab-scoped hand-offs for user-authored text
 * that must move between pages WITHOUT riding in a URL, analytics, error
 * tracking or logs. Two records, both in this tab's `sessionStorage`:
 *
 * 1. The `/verify` PENDING INPUT (R2, review B1; R3, review MAJOR-2):
 *    extension-selected or typed text that survives the signup / login
 *    detour.
 * 2. The APP HAND-OFF (R3, owner D5): the text `/verify` (or a saved
 *    report's "Run follow-up") hands to the main app, replacing the old
 *    `/?tab=verify&claim=…` / `/?tab=research&q=…` URLs. The main app reads it
 *    once (`consumeAppHandoff`), after its legacy `?claim=` / `?q=` reader.
 *
 * STATE-LIFECYCLE CONTRACT (owner A2)
 *   - Storage: sessionStorage only (never localStorage, never a URL, never
 *     logged — nothing here logs or throws the value). If sessionStorage is
 *     unavailable the pending input falls back to an in-memory copy for this
 *     page only; the capture then does NOT strip the URL (no silent loss).
 *   - Size: ≤ MAX_PENDING_CHARS. Expiry: PENDING_TTL_MS (pending input, from
 *     the last write) / APP_HANDOFF_TTL_MS (hand-off). Expired, forged-expiry,
 *     malformed, oversized and legacy records are never returned and are
 *     removed by the mutating operations.
 *   - Ownership: a record is bound to the uid that was signed in when it was
 *     written, or unbound (`null`) when written by an anonymous / not-yet-known
 *     visitor. An unbound record belongs to anonymous viewers and to the FIRST
 *     account that signs in in this tab (AuthProvider claims it); a bound
 *     record belongs to that uid only.
 *   - RENDERING (R3): what /verify displays is DERIVED from storage and the
 *     viewer on every render (`readVisiblePendingVerifyInput`, pure) — there
 *     is no React copy that could outlive a storage cleanup. The viewer is
 *     `undefined` until auth is ready, and an unknown viewer sees nothing.
 *     The page is additionally keyed by identity, so no state survives an
 *     identity change.
 *   - One-time: Run / Deep Research consume the pending input (and write a
 *     one-time hand-off); Discard / Open Main App / clearing the textarea
 *     remove it. The hand-off is removed when read, whoever reads it.
 *   - AuthProvider: a SIGNED-IN identity signing out (explicit, revoked,
 *     fail-closed) removes both; a different account appearing removes
 *     records bound to another account and claims unbound ones; an anonymous
 *     cold load's `null` callback removes neither (review B1).
 */

export const VERIFY_PENDING_STORAGE_KEY = "convergePanelVerifyPendingV2";
export const APP_HANDOFF_STORAGE_KEY = "convergePanelAppHandoffV1";
/** Round-1 key (raw string, no expiry). Removed on sight; never read. */
export const LEGACY_VERIFY_PREFILL_STORAGE_KEY = "convergePanelVerifyPrefillV1";
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const APP_HANDOFF_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_CHARS = 5000;
export const VERIFY_TEXT_PARAM = "text";

export type AppHandoffKind = "verify" | "research";
type LocationLike = Pick<Location, "pathname" | "search" | "hash">;
type HistoryLike = Pick<History, "replaceState" | "state">;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PendingRecord = { v: 2; text: string; boundUid: string | null; expiresAt: number };
type HandoffRecord = { v: 1; kind: AppHandoffKind; text: string; boundUid: string | null; expiresAt: number };

// ── change notification (the /verify page re-derives its display from storage) ──
const listeners = new Set<() => void>();
export function subscribeTabHandoffs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify(): void {
  for (const l of Array.from(listeners)) l();
}

// ── in-memory fallback for the pending input when sessionStorage is unusable ──
let memoryPending: string | null = null;

/** This tab's sessionStorage, or null when unavailable. */
export function tabStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function safeGet(storage: StorageLike | null | undefined, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}
function safeRemove(storage: StorageLike | null | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}
/** true when the durable write succeeded. */
function safeSet(storage: StorageLike | null | undefined, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parsePending(raw: string | null, now: number): PendingRecord | null {
  if (raw === null) return null;
  let r: Partial<PendingRecord> | null;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  const ok =
    !!r &&
    r.v === 2 &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    r.text.length <= MAX_PENDING_CHARS &&
    (r.boundUid === null || typeof r.boundUid === "string") &&
    typeof r.expiresAt === "number" &&
    r.expiresAt > now &&
    r.expiresAt <= now + PENDING_TTL_MS;
  return ok ? (r as PendingRecord) : null;
}

function parseHandoff(raw: string | null, now: number): HandoffRecord | null {
  if (raw === null) return null;
  let r: Partial<HandoffRecord> | null;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  const ok =
    !!r &&
    r.v === 1 &&
    (r.kind === "verify" || r.kind === "research") &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    r.text.length <= MAX_PENDING_CHARS &&
    (r.boundUid === null || typeof r.boundUid === "string") &&
    typeof r.expiresAt === "number" &&
    r.expiresAt > now &&
    r.expiresAt <= now + APP_HANDOFF_TTL_MS;
  return ok ? (r as HandoffRecord) : null;
}

/** Pending record from storage, else from the in-memory fallback. Pure (no writes). */
function peekPending(storage: StorageLike | null | undefined, now: number): PendingRecord | null {
  const raw = safeGet(storage, VERIFY_PENDING_STORAGE_KEY);
  return parsePending(raw !== null ? raw : memoryPending, now);
}

function removePending(storage: StorageLike | null | undefined): void {
  safeRemove(storage, VERIFY_PENDING_STORAGE_KEY);
  safeRemove(storage, LEGACY_VERIFY_PREFILL_STORAGE_KEY);
  memoryPending = null;
}

/** Writes the pending input. Returns true when it reached sessionStorage (false: memory fallback only). */
function writePending(storage: StorageLike | null | undefined, text: string, boundUid: string | null, now: number): boolean {
  const record: PendingRecord = { v: 2, text: text.slice(0, MAX_PENDING_CHARS), boundUid, expiresAt: now + PENDING_TTL_MS };
  const json = JSON.stringify(record);
  const durable = safeSet(storage, VERIFY_PENDING_STORAGE_KEY, json);
  memoryPending = durable ? null : json;
  return durable;
}

/** Garbage-collects an unreadable / expired / legacy pending record (mutating; never called during render). */
function sweepPending(storage: StorageLike | null | undefined, now: number): PendingRecord | null {
  if (safeGet(storage, LEGACY_VERIFY_PREFILL_STORAGE_KEY) !== null) safeRemove(storage, LEGACY_VERIFY_PREFILL_STORAGE_KEY);
  const raw = safeGet(storage, VERIFY_PENDING_STORAGE_KEY);
  const rec = peekPending(storage, now);
  if (!rec && (raw !== null || memoryPending !== null)) removePending(storage);
  return rec;
}

function readHashText(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  try {
    return new URLSearchParams(hash.slice(1)).get(VERIFY_TEXT_PARAM);
  } catch {
    return null;
  }
}

/**
 * What /verify may DISPLAY for `viewer` — pure, safe to call during render.
 * `viewer`: `undefined` = identity not yet known (shows nothing); `null` =
 * anonymous (sees unbound records only); a uid (sees unbound records and
 * records bound to that uid).
 */
export function readVisiblePendingVerifyInput(
  storage: StorageLike | null | undefined,
  viewer: string | null | undefined,
  now: number = Date.now()
): string {
  if (viewer === undefined) return "";
  const rec = peekPending(storage, now);
  if (!rec) return "";
  if (rec.boundUid === null) return rec.text;
  return viewer !== null && rec.boundUid === viewer ? rec.text : "";
}

/** The pending record's expiry (for a re-render timer), or null. */
export function pendingVerifyInputExpiresAt(storage: StorageLike | null | undefined, now: number = Date.now()): number | null {
  return peekPending(storage, now)?.expiresAt ?? null;
}

/**
 * Captures `text` that arrived on /verify in the query (legacy extension
 * links) or the fragment (current extension). Stores it as the pending input
 * (bound to `currentUid`, or unbound when not yet known) and strips it from
 * the address bar — unless it could not be stored durably, in which case the
 * URL is left as is so the text is not lost on reload. Returns the text, or
 * null when nothing arrived. Never throws, never logs.
 */
export function capturePendingVerifyInput(env: {
  location: LocationLike;
  history: HistoryLike | null | undefined;
  storage: StorageLike | null | undefined;
  currentUid: string | null;
  now?: number;
}): string | null {
  const now = env.now ?? Date.now();
  const { location, history, storage, currentUid } = env;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    params = new URLSearchParams();
  }
  const fromQuery = params.get(VERIFY_TEXT_PARAM);
  const fromHash = readHashText(location.hash);
  const arrived = fromQuery ?? fromHash;
  if (arrived === null) return null;
  let durable = true;
  if (arrived) durable = writePending(storage, arrived, currentUid, now);
  else removePending(storage);
  if (durable) {
    params.delete(VERIFY_TEXT_PARAM);
    const rest = params.toString();
    try {
      history?.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
    } catch {
      /* ignore */
    }
  }
  notify();
  return arrived.slice(0, MAX_PENDING_CHARS);
}

/** The user edited the textarea (viewer known): keep the pending input in step; empty removes it. */
export function updatePendingVerifyInput(
  storage: StorageLike | null | undefined,
  text: string,
  currentUid: string | null,
  now: number = Date.now()
): void {
  if (!text) removePending(storage);
  else {
    const rec = peekPending(storage, now);
    writePending(storage, text, rec && rec.boundUid !== null ? rec.boundUid : currentUid, now);
  }
  notify();
}

/** One-time consumption: the user acted on the text (run / cancel / left for the main app). */
export function consumePendingVerifyInput(storage: StorageLike | null | undefined): void {
  removePending(storage);
  notify();
}

/**
 * AuthProvider, on every NEW signed-in identity in this tab (including the
 * first callback after a reload): unbound records are claimed by `uid`;
 * records bound to another account are removed; expired ones are removed.
 * Applies to the pending input AND the app hand-off.
 */
export function reconcilePendingVerifyInputForIdentity(
  storage: StorageLike | null | undefined,
  uid: string,
  now: number = Date.now()
): void {
  const rec = sweepPending(storage, now);
  if (rec) {
    if (rec.boundUid === null) writePending(storage, rec.text, uid, now);
    else if (rec.boundUid !== uid) removePending(storage);
  }
  const raw = safeGet(storage, APP_HANDOFF_STORAGE_KEY);
  const h = parseHandoff(raw, now);
  if (raw !== null && !h) safeRemove(storage, APP_HANDOFF_STORAGE_KEY);
  else if (h && h.boundUid === null) safeSet(storage, APP_HANDOFF_STORAGE_KEY, JSON.stringify({ ...h, boundUid: uid }));
  else if (h && h.boundUid !== uid) safeRemove(storage, APP_HANDOFF_STORAGE_KEY);
  notify();
}

/**
 * Removes expired / malformed / legacy records (pending input and hand-off) without touching live ones, so an
 * abandoned text is not retained past its expiry. Called on /verify mount and on every signed-out auth callback.
 */
export function sweepTabHandoffs(storage: StorageLike | null | undefined, now: number = Date.now()): void {
  sweepPending(storage, now);
  const raw = safeGet(storage, APP_HANDOFF_STORAGE_KEY);
  if (raw !== null && !parseHandoff(raw, now)) safeRemove(storage, APP_HANDOFF_STORAGE_KEY);
}

/** AuthProvider, when a SIGNED-IN identity signs out. NOT called for an anonymous cold load's `null` callback. */
export function clearPendingVerifyInputOnSignOut(storage: StorageLike | null | undefined): void {
  removePending(storage);
  safeRemove(storage, APP_HANDOFF_STORAGE_KEY);
  notify();
}

/**
 * Writes the one-time app hand-off (replaces `?claim=` / `?q=` in new links).
 * Returns false when sessionStorage is unavailable — the caller then decides
 * (see `appHandoffHref`).
 */
export function writeAppHandoff(
  storage: StorageLike | null | undefined,
  kind: AppHandoffKind,
  text: string,
  boundUid: string | null,
  now: number = Date.now()
): boolean {
  const record: HandoffRecord = { v: 1, kind, text: text.slice(0, MAX_PENDING_CHARS), boundUid, expiresAt: now + APP_HANDOFF_TTL_MS };
  return safeSet(storage, APP_HANDOFF_STORAGE_KEY, JSON.stringify(record));
}

/**
 * The main app, ONCE, when it lands on `/?tab=<kind>`: returns the hand-off
 * text when it is live, of this kind, and unbound or bound to `uid`; the
 * record is removed whatever the outcome (one-time). Returns null otherwise.
 */
export function consumeAppHandoff(kind: AppHandoffKind, uid: string | null, storage: StorageLike | null | undefined = tabStorage(), now: number = Date.now()): string | null {
  const raw = safeGet(storage, APP_HANDOFF_STORAGE_KEY);
  if (raw === null) return null;
  safeRemove(storage, APP_HANDOFF_STORAGE_KEY);
  const h = parseHandoff(raw, now);
  if (!h || h.kind !== kind) return null;
  if (h.boundUid !== null && h.boundUid !== uid) return null;
  return h.text;
}

/**
 * The navigation target for a hand-off of `text` into the main app:
 * `/?tab=<kind>` with the text in the one-time hand-off — or, ONLY when
 * sessionStorage is unavailable (blocked by the browser), the legacy URL so
 * the flow still works (documented residual: such a request carries the text;
 * telemetry is still sanitized).
 */
export function appHandoffHref(kind: AppHandoffKind, text: string, uid: string | null, storage: StorageLike | null | undefined = tabStorage()): string {
  if (writeAppHandoff(storage, kind, text, uid)) return `/?tab=${kind}`;
  return kind === "verify" ? `/?tab=verify&claim=${encodeURIComponent(text)}` : `/?tab=research&q=${encodeURIComponent(text)}`;
}

/**
 * Legacy `/?tab=verify&claim=…` and `/?tab=research&q=…` links (bookmarks,
 * history, old builds): moved into the one-time hand-off and removed from the
 * address bar at once (tab and every other parameter kept). If the hand-off
 * cannot be stored durably the URL is left untouched — the main app's legacy
 * reader still finds the parameter, so no text is silently lost.
 */
export function migrateLegacyAppHandoffLink(env: {
  location: LocationLike;
  history: HistoryLike | null | undefined;
  storage: StorageLike | null | undefined;
  currentUid: string | null;
  now?: number;
}): boolean {
  const { location, history, storage, currentUid } = env;
  if (location.pathname !== "/") return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  const tab = params.get("tab");
  const param = tab === "verify" ? "claim" : tab === "research" ? "q" : null;
  if (!param || !params.has(param)) return false;
  const text = params.get(param) ?? "";
  if (text && !writeAppHandoff(storage, tab as AppHandoffKind, text, currentUid, env.now ?? Date.now())) return false;
  params.delete(param);
  const rest = params.toString();
  try {
    history?.replaceState(history.state, "", `/${rest ? `?${rest}` : ""}${location.hash || ""}`);
  } catch {
    return false;
  }
  return true;
}

/**
 * The `redirect=` target for the signup/login detour: `/verify` plus the
 * non-content `source` marker only. The text itself is never put back into a
 * URL.
 */
export function verifyReturnPath(source: string): string {
  return source ? `/verify?source=${encodeURIComponent(source)}` : "/verify";
}
