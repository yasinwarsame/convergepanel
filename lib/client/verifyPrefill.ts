/**
 * Privacy remediation (2026-11-17 audit, finding B.6; round 2 2026-11-18,
 * review B1) — the `/verify` PENDING INPUT: extension-selected (or typed)
 * text that must survive the signup / login detour WITHOUT riding in a URL,
 * analytics, error tracking or logs.
 *
 * Contract (owner requirement B1):
 *   - Storage: this tab's `sessionStorage` only (never localStorage, never a
 *     URL, never logged — no function here logs or throws the value).
 *   - Size: at most MAX_PENDING_CHARS characters (longer input is truncated).
 *   - Expiry: PENDING_TTL_MS (15 min) from the last write. An expired record
 *     is removed the next time anything reads it, and is never returned.
 *   - One-time consumption: `consumePendingVerifyInput` removes it when the
 *     user runs a verification / research from it, cancels, or opens the main
 *     app instead; clearing the textarea removes it too.
 *   - Identity binding ("anonymous, then whichever account signs in in this
 *     tab"): a record created while signed out has `boundUid: null`; the first
 *     identity that signs in in this tab claims it (`boundUid = uid`). A record
 *     already bound to account A is removed the moment any OTHER account B
 *     appears, and removed when A signs out. A signed-out moment with NO
 *     identity before it (an anonymous cold load: Firebase reports `null`
 *     asynchronously) does NOT remove it — that was review B1: the hand-off
 *     must survive being anonymous during the auth flow.
 *
 * Enforcement points: `AuthProvider` (identity transitions) and `/verify`
 * (capture / read / consume). Analytics and error tracking never see the
 * value: it is not in any URL after capture, PostHog does not record storage
 * or input values, Sentry/PostHog replays mask all text, and the boundary
 * sanitizer redacts `?text=` on the initial request URL.
 */

export const VERIFY_PENDING_STORAGE_KEY = "convergePanelVerifyPendingV2";
/** Round-1 key (raw string, no expiry). Removed on sight; never read. */
export const LEGACY_VERIFY_PREFILL_STORAGE_KEY = "convergePanelVerifyPrefillV1";
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const MAX_PENDING_CHARS = 5000;
export const VERIFY_TEXT_PARAM = "text";

type LocationLike = Pick<Location, "pathname" | "search" | "hash">;
type HistoryLike = Pick<History, "replaceState" | "state">;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PendingRecord = { v: 2; text: string; boundUid: string | null; expiresAt: number };

function remove(storage: StorageLike | null | undefined): void {
  try {
    storage?.removeItem(VERIFY_PENDING_STORAGE_KEY);
    storage?.removeItem(LEGACY_VERIFY_PREFILL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function write(storage: StorageLike | null | undefined, text: string, boundUid: string | null, now: number): void {
  if (!storage) return;
  const record: PendingRecord = { v: 2, text: text.slice(0, MAX_PENDING_CHARS), boundUid, expiresAt: now + PENDING_TTL_MS };
  try {
    storage.setItem(VERIFY_PENDING_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* quota / blocked storage: the text still prefills this render via the return value */
  }
}

/** The live record, or null. Expired, malformed or legacy records are removed. Never throws. */
function read(storage: StorageLike | null | undefined, now: number): PendingRecord | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    if (storage.getItem(LEGACY_VERIFY_PREFILL_STORAGE_KEY) !== null) storage.removeItem(LEGACY_VERIFY_PREFILL_STORAGE_KEY);
    raw = storage.getItem(VERIFY_PENDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    remove(storage);
    return null;
  }
  const r = rec as Partial<PendingRecord> | null;
  const valid =
    !!r &&
    r.v === 2 &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    r.text.length <= MAX_PENDING_CHARS &&
    (r.boundUid === null || typeof r.boundUid === "string") &&
    typeof r.expiresAt === "number" &&
    r.expiresAt > now &&
    r.expiresAt <= now + PENDING_TTL_MS;
  if (!valid) {
    remove(storage);
    return null;
  }
  return r as PendingRecord;
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
 * `/verify` on mount / URL change. If `text` arrived in the query (extension)
 * or fragment: store it as the pending input (bound to `currentUid` when a
 * user is signed in, else unbound), strip it from the address bar
 * (`history.replaceState`, keeping Next.js's history state) and return it.
 * Otherwise return the live pending input ("" when none). A record bound to a
 * different signed-in account is removed, never returned. Never throws.
 */
export function capturePendingVerifyInput(env: {
  location: LocationLike;
  history: HistoryLike | null | undefined;
  storage: StorageLike | null | undefined;
  currentUid: string | null;
  now?: number;
}): string {
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

  if (arrived !== null) {
    if (arrived) write(storage, arrived, currentUid, now);
    else remove(storage);
    params.delete(VERIFY_TEXT_PARAM);
    const rest = params.toString();
    try {
      history?.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
    } catch {
      /* ignore */
    }
    return arrived.slice(0, MAX_PENDING_CHARS);
  }

  const rec = read(storage, now);
  if (!rec) return "";
  if (rec.boundUid !== null && currentUid !== null && rec.boundUid !== currentUid) {
    remove(storage);
    return "";
  }
  return rec.text;
}

/** The user edited the textarea: keep the pending input in step (empty removes it). Refreshes the expiry. */
export function updatePendingVerifyInput(
  storage: StorageLike | null | undefined,
  text: string,
  currentUid: string | null,
  now: number = Date.now()
): void {
  if (!text) {
    remove(storage);
    return;
  }
  const rec = read(storage, now);
  write(storage, text, rec ? rec.boundUid ?? currentUid : currentUid, now);
}

/** One-time consumption: the user acted on the text (run / cancel / left for the main app). */
export function consumePendingVerifyInput(storage: StorageLike | null | undefined): void {
  remove(storage);
}

/**
 * AuthProvider, on every NEW signed-in identity in this tab (including the
 * first callback after a reload): an unbound record is claimed by `uid`; a
 * record bound to another account is removed; an expired one is removed.
 */
export function reconcilePendingVerifyInputForIdentity(
  storage: StorageLike | null | undefined,
  uid: string,
  now: number = Date.now()
): void {
  const rec = read(storage, now);
  if (!rec) return;
  if (rec.boundUid === null) write(storage, rec.text, uid, now);
  else if (rec.boundUid !== uid) remove(storage);
}

/**
 * AuthProvider, when a signed-in identity signs out (explicitly, revoked, or
 * fail-closed). NOT called for an anonymous cold load's `null` callback.
 */
export function clearPendingVerifyInputOnSignOut(storage: StorageLike | null | undefined): void {
  remove(storage);
}

/**
 * The `redirect=` target for the signup/login detour: `/verify` plus the
 * non-content `source` marker only. The text itself is never put back into a
 * URL.
 */
export function verifyReturnPath(source: string): string {
  return source ? `/verify?source=${encodeURIComponent(source)}` : "/verify";
}
