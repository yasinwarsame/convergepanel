/**
 * Privacy remediation (2026-11-17 audit, finding "localStorage history never
 * cleared") — the browser-side copies of user content and their cleanup.
 *
 * `app/page.tsx` caches the signed-in user's last ≤50 history items (full
 * claim + every model's parsed output) under `convergePanelHistoryV1:<uid>`.
 * Before this change no code ever removed that key: it survived sign-out,
 * account deletion and a different person signing in on the same browser.
 * The cache is only an offline accelerator — the authoritative history is
 * re-read from `/api/user/panel-history` — so clearing it loses nothing.
 *
 * `/verify` hands extension-selected text across the signup/login detour as
 * a bounded, expiring, identity-bound pending input in sessionStorage
 * (`lib/client/verifyPrefill.ts`, contract there). Round 2 (review B1): it is
 * cleared when a SIGNED-IN identity signs out or a different account appears
 * — NOT on an anonymous cold load's `null` auth callback, which previously
 * erased the extension text before the user could sign in.
 *
 * The helpers take the Storage object as a parameter so they are pure and
 * unit-testable; callers pass `window.localStorage` / `window.sessionStorage`.
 */

import { clearPendingVerifyInputOnSignOut, reconcilePendingVerifyInputForIdentity, sweepTabHandoffs } from "@/lib/client/verifyPrefill";

// Must equal `HISTORY_STORAGE_KEY` in app/page.tsx (a hash-frozen file, so it keeps
// its own literal); lib/client/__tests__/localPrivateData.spec.ts pins the match.
export const PANEL_HISTORY_STORAGE_PREFIX = "convergePanelHistoryV1";

export function panelHistoryStorageKey(uid: string): string {
  return `${PANEL_HISTORY_STORAGE_PREFIX}:${uid}`;
}

type KeyedStorage = Pick<Storage, "length" | "key" | "removeItem">;

/**
 * Removes every `convergePanelHistoryV1:*` key (and the legacy un-suffixed
 * key, if any), optionally keeping the one belonging to `exceptUid` (the
 * identity that is signing in right now). Never throws: storage can be
 * unavailable (private mode, blocked site data).
 */
export function clearPanelHistoryCache(storage: KeyedStorage | null | undefined, options: { exceptUid?: string } = {}): number {
  if (!storage) return 0;
  const keep = options.exceptUid ? panelHistoryStorageKey(options.exceptUid) : null;
  let removed = 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || key === keep) continue;
      if (key === PANEL_HISTORY_STORAGE_PREFIX || key.startsWith(`${PANEL_HISTORY_STORAGE_PREFIX}:`)) doomed.push(key);
    }
    for (const key of doomed) {
      storage.removeItem(key);
      removed++;
    }
  } catch {
    /* storage unavailable — nothing we can clear */
  }
  return removed;
}

function browserStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return typeof window !== "undefined" ? window[kind] : null;
  } catch {
    return null;
  }
}

/**
 * Called by `AuthProvider` whenever Firebase reports NO user (explicit
 * logout from any page, revoked/expired session, fail-closed sync failure,
 * or an anonymous cold load). Always clears every cached history copy (a
 * signed-out browser keeps no history). The /verify pending input is cleared
 * only when `hadIdentity` — a signed-in identity actually signed out; an
 * anonymous visitor's pending input must survive until they sign in, cancel
 * or it expires. Never throws.
 */
export function clearLocalPrivateDataOnSignOut(options: { hadIdentity: boolean }): void {
  clearPanelHistoryCache(browserStorage("localStorage"));
  if (options.hadIdentity) clearPendingVerifyInputOnSignOut(browserStorage("sessionStorage"));
  else sweepTabHandoffs(browserStorage("sessionStorage")); // anonymous: keep live input, drop expired
}

/**
 * Called by `AuthProvider` when a NEW identity signs in (including a direct
 * account switch with no logout in between, and the first callback after a
 * reload): removes every OTHER account's cached history from this browser,
 * and binds an anonymous /verify pending input to this account — or removes
 * one bound to a different account.
 */
export function clearOtherAccountsLocalData(currentUid: string): void {
  clearPanelHistoryCache(browserStorage("localStorage"), { exceptUid: currentUid });
  reconcilePendingVerifyInputForIdentity(browserStorage("sessionStorage"), currentUid);
}
