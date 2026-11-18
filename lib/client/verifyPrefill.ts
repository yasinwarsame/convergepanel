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
 *     logged — nothing here logs or throws the value).
 *   - R4 (owner ruling, review MAJOR-1): claim text is ALWAYS removed from the
 *     address bar, whatever sessionStorage does. If sessionStorage is
 *     unavailable or refuses the write, the record is held in THIS DOCUMENT'S
 *     memory only (same bounds, expiry and identity binding; gone on reload or
 *     in a new tab) — never put back into a URL. /verify then shows an ordinary
 *     "paste the claim manually" notice (`isTabStorageUsable`). The in-memory
 *     hold is safe because the JS heap is per document: it survives only the
 *     app's soft navigations (router.push to /signup, /login, /verify, /),
 *     and AuthProvider clears or re-binds it exactly like the stored record.
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

import { scrubUrlParts, type ContentCapture } from "@/lib/privacy/urlContentScrub";

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

// ── in-memory fallback (this document only) when sessionStorage is unusable ──
let memoryPending: string | null = null;
let memoryHandoff: string | null = null;

/** Tests only: a reload starts a new document with empty memory. */
export function __resetTabHandoffMemoryForTests(): void {
  memoryPending = null;
  memoryHandoff = null;
}

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
/** R5 (R4 review NIT): one probe per storage object — the result is the /verify `useSyncExternalStore` snapshot. */
const usableCache = new WeakMap<object, boolean>();
/**
 * True when this tab's sessionStorage can actually hold a hand-off (a probe
 * write succeeds). False when it is unavailable, throws, or refuses writes —
 * /verify then shows the paste-manually notice. Probed once per storage object
 * (R5: it is called on every render). Never throws.
 */
export function isTabStorageUsable(storage: StorageLike | null | undefined = tabStorage()): boolean {
  if (!storage) return false;
  const cached = usableCache.get(storage);
  if (cached !== undefined) return cached;
  const probe = "convergePanelStorageProbe";
  let usable: boolean;
  try {
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    usable = true;
  } catch {
    usable = false;
  }
  usableCache.set(storage, usable);
  return usable;
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

/** The app hand-off record from storage, else from the in-memory fallback. Pure. */
function peekHandoffRaw(storage: StorageLike | null | undefined): string | null {
  const raw = safeGet(storage, APP_HANDOFF_STORAGE_KEY);
  return raw !== null ? raw : memoryHandoff;
}
function removeHandoff(storage: StorageLike | null | undefined): void {
  safeRemove(storage, APP_HANDOFF_STORAGE_KEY);
  memoryHandoff = null;
}
/** Writes the hand-off record. Returns true when it reached sessionStorage (false: memory fallback only). */
function writeHandoffRecord(storage: StorageLike | null | undefined, record: HandoffRecord): boolean {
  const json = JSON.stringify(record);
  const durable = safeSet(storage, APP_HANDOFF_STORAGE_KEY, json);
  memoryHandoff = durable ? null : json;
  return durable;
}

/**
 * R4 (review MINOR-2): the state to hand to `history.replaceState` when this
 * module rewrites the address bar. Next 14's app router patches
 * `history.replaceState` and SKIPS its own router sync when the state carries
 * `__NA` — R3 passed `history.state` (which carries it), so the router kept the
 * claim-bearing URL as its canonicalUrl and could write it back on a later
 * update. Without `__NA` the patched method copies Next's `__NA` + tree back in
 * and adopts the clean URL. Before hydration (no patch yet) the router later
 * initializes from the already clean `window.location`.
 */
function stateForUrlRewrite(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  const { __NA: _na, __N: _n, _N: _n2, __PRIVATE_NEXTJS_INTERNALS_TREE: _tree, ...rest } = state as Record<string, unknown>;
  return rest;
}

/** Rewrites the address bar to `url`. Never throws. */
function rewriteUrl(history: HistoryLike | null | undefined, url: string): void {
  try {
    history?.replaceState(stateForUrlRewrite(history.state), "", url);
  } catch {
    /* ignore */
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
 * links) or the fragment (current extension), through the shared R5 scrub
 * contract ({@link migrateContentFromUrl}). Returns the text, or null when
 * nothing arrived. Never throws, never logs.
 */
export function capturePendingVerifyInput(env: MigrationEnv): string | null {
  const pending = migrateUrlContent(env).find((c) => c.kind === "pending");
  return pending ? pending.text.slice(0, MAX_PENDING_CHARS) : null;
}

/** The user edited the textarea (viewer known): keep the pending input in step; empty removes it. */
export function updatePendingVerifyInput(
  storage: StorageLike | null | undefined,
  text: string,
  currentUid: string | null,
  now: number = Date.now()
): void {
  // R4 (review MINOR-3): the edit belongs to the CURRENT viewer. R3 kept the old
  // record's binding, so an anonymous visitor typing over a record bound to A (a
  // reopened tab) saved their text under A's identity.
  if (!text) removePending(storage);
  else writePending(storage, text, currentUid, now);
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
  const raw = peekHandoffRaw(storage);
  const h = parseHandoff(raw, now);
  if (raw !== null && !h) removeHandoff(storage);
  else if (h && h.boundUid === null) writeHandoffRecord(storage, { ...h, boundUid: uid });
  else if (h && h.boundUid !== uid) removeHandoff(storage);
  notify();
}

/**
 * Removes expired / malformed / legacy records (pending input and hand-off) without touching live ones, so an
 * abandoned text is not retained past its expiry. Called on /verify mount and on every signed-out auth callback.
 */
export function sweepTabHandoffs(storage: StorageLike | null | undefined, now: number = Date.now()): void {
  sweepPending(storage, now);
  const raw = peekHandoffRaw(storage);
  if (raw !== null && !parseHandoff(raw, now)) removeHandoff(storage);
}

/** AuthProvider, when a SIGNED-IN identity signs out. NOT called for an anonymous cold load's `null` callback. */
export function clearPendingVerifyInputOnSignOut(storage: StorageLike | null | undefined): void {
  removePending(storage);
  removeHandoff(storage);
  notify();
}

/**
 * Writes the one-time app hand-off (replaces `?claim=` / `?q=` in new links).
 * Returns true when it reached sessionStorage; false when sessionStorage is
 * unusable, in which case it is held in this document's memory instead (R4).
 */
export function writeAppHandoff(
  storage: StorageLike | null | undefined,
  kind: AppHandoffKind,
  text: string,
  boundUid: string | null,
  now: number = Date.now()
): boolean {
  return writeHandoffRecord(storage, { v: 1, kind, text: text.slice(0, MAX_PENDING_CHARS), boundUid, expiresAt: now + APP_HANDOFF_TTL_MS });
}

/**
 * The main app, ONCE, when it lands on `/?tab=<kind>`: returns the hand-off
 * text when it is live, of this kind, and unbound or bound to `uid`; the
 * record is removed whatever the outcome (one-time). Returns null otherwise.
 */
export function consumeAppHandoff(kind: AppHandoffKind, uid: string | null, storage: StorageLike | null | undefined = tabStorage(), now: number = Date.now()): string | null {
  const raw = peekHandoffRaw(storage);
  if (raw === null) return null;
  removeHandoff(storage);
  const h = parseHandoff(raw, now);
  if (!h || h.kind !== kind) return null;
  if (h.boundUid !== null && h.boundUid !== uid) return null;
  return h.text;
}

/**
 * The navigation target for a hand-off of `text` into the main app:
 * `/?tab=<kind>` with the text in the one-time hand-off. Never a
 * claim-bearing URL (R4, owner ruling): when sessionStorage is unusable the
 * hand-off is held in this document's memory, which the caller's
 * `router.push` (a soft navigation in the same document) preserves.
 */
export function appHandoffHref(kind: AppHandoffKind, text: string, uid: string | null, storage: StorageLike | null | undefined = tabStorage()): string {
  writeAppHandoff(storage, kind, text, uid);
  return `/?tab=${kind}`;
}

/**
 * Legacy `/?tab=verify&claim=…` and `/?tab=research&q=…` links (bookmarks,
 * history, old builds), through the shared R5 scrub contract
 * ({@link migrateContentFromUrl}). True when such a parameter was present.
 */
export function migrateLegacyAppHandoffLink(env: MigrationEnv): boolean {
  if (env.location.pathname !== "/") return false;
  return migrateUrlContent(env).some((c) => c.kind === "verify" || c.kind === "research");
}

type MigrationEnv = {
  location: LocationLike;
  history: HistoryLike | null | undefined;
  storage: StorageLike | null | undefined;
  currentUid: string | null;
  now?: number;
};

/**
 * Applies the scrub contract to the CURRENT URL: rewrites the address bar
 * first (nothing below may leave content in it), then moves the content into
 * the tab hand-offs — the first pending input and the first hand-off of each
 * kind — bound to `currentUid` (unbound when not yet known), in
 * sessionStorage or this document's memory (R4). Returns the captures.
 */
function migrateUrlContent(env: MigrationEnv): ContentCapture[] {
  const { location, history, storage, currentUid } = env;
  const result = scrubUrlParts(location);
  if (!result.changed) return [];
  rewriteUrl(history, `${location.pathname}${result.search}${result.hash}`);
  const now = env.now ?? Date.now();
  const done = new Set<string>();
  for (const capture of result.captures) {
    if (done.has(capture.kind)) continue;
    done.add(capture.kind);
    if (capture.kind === "pending") {
      if (capture.text) writePending(storage, capture.text, currentUid, now);
      else removePending(storage);
    } else if (capture.text) {
      writeAppHandoff(storage, capture.kind, capture.text, currentUid, now);
    }
  }
  if (result.captures.length > 0) notify();
  return result.captures;
}

/**
 * R4/R5: makes the CURRENT URL (whatever page) satisfy the pre-telemetry scrub
 * contract (lib/privacy/urlContentScrub.ts — rules shared with the telemetry
 * sanitizer in lib/privacy/urlParamRules.ts): user-authored text, including
 * text nested in `redirect=` / `next=` targets, is moved into the tab
 * hand-offs; every other content-bearing parameter / fragment is dropped;
 * allowlisted and routing parameters are kept byte-for-byte. Called
 * synchronously before any telemetry SDK initializes
 * (lib/privacy/preTelemetryUrlScrub.ts) and again by the layout's
 * ContentHandoffMigrator on soft navigations. Idempotent; never throws, never logs.
 */
export function migrateContentFromUrl(env: MigrationEnv): void {
  try {
    migrateUrlContent(env);
  } catch {
    /* never throws */
  }
}

/**
 * The `redirect=` target for the signup/login detour: `/verify` plus the
 * non-content `source` marker only. The text itself is never put back into a
 * URL.
 */
export function verifyReturnPath(source: string): string {
  return source ? `/verify?source=${encodeURIComponent(source)}` : "/verify";
}
