"use client";

/**
 * Authentication Provider Component
 *
 * Auth Lifecycle Hardening, Step 6.3/6.6/6.8 — this is now the single owner
 * of the client/server session-synchronization state machine
 * (`lib/client/authSessionStateMachine.ts`), not just a passthrough for
 * Firebase's client auth state. Root cause this exists to fix: previously,
 * `user` became non-null (and the whole app treated the visitor as signed
 * in) the instant Firebase's client SDK resolved a credential — with no
 * awareness of whether the server's `__session` cookie had been
 * established for that SAME identity yet. Since every protected API route
 * resolves identity via the `__session` cookie FIRST and only falls back to
 * a request's Bearer token if no cookie is present (`getRequestUid()`,
 * `lib/teams/teamApiAuth.ts`), a cookie left over from a PREVIOUS session
 * could silently keep authorizing requests as the wrong user for as long as
 * it remained valid — regardless of what the UI displayed.
 *
 * This component now:
 * - Listens to `onIdTokenChanged` (a superset of `onAuthStateChanged`: also
 *   fires on silent token refresh), not `onAuthStateChanged`.
 * - Treats every callback with a DIFFERENT uid than previously tracked
 *   (including the very first callback after mount) as a new identity that
 *   must be synchronized with the server before `syncState` can become
 *   `"authenticated"` — this is what makes a direct account switch (no
 *   explicit logout in between) safe, per Step 6.6's fallback path.
 * - Treats a callback with the SAME uid as a routine token refresh, which
 *   keeps `syncState` at `"authenticated"` throughout (no UI flicker) but
 *   still re-syncs the cookie's expiry.
 * - Guards every async result with an operation-generation counter
 *   (`lib/client/authGeneration.ts`) so a stale response — an old login
 *   after a newer one, a refresh after logout, a rapid A→B→A — can never
 *   overwrite state a later operation has already established.
 * - On ANY sync failure or uid mismatch, defensively signs the Firebase
 *   client out too (the server session was already cleared by
 *   `establishServerSession` itself) — the previous identity is never
 *   retained in either place.
 *
 * `user`/`loading`/`authReady`/`isAdmin`/`adminResolved` are kept for
 * backward compatibility with existing consumers that only need to know
 * "is someone signed in" for display purposes (nav links, etc). Any
 * consumer gating a PROTECTED MUTATION must check the new `syncState`
 * (`=== "authenticated"`, or the `canPerformProtectedMutation` helper) —
 * `user` alone is no longer sufficient proof the server agrees.
 *
 * Usage:
 *   const { user, loading, authReady, isAdmin, syncState } = useAuth();
 */

import { createContext, useContext, useEffect, useRef, useReducer, useState, ReactNode } from "react";
import { User, onIdTokenChanged, getIdTokenResult, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { perf } from "@/lib/utils/performance";
import { nextSessionSyncState, canPerformProtectedMutation, type SessionSyncState } from "@/lib/client/authSessionStateMachine";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import { establishServerSession, clearServerSession, type SessionSyncOutcome } from "@/lib/client/sessionSync";
import { logAuthSessionClientEvent } from "@/lib/client/authSessionTelemetry";
import { clearLocalPrivateDataOnSignOut, clearOtherAccountsLocalData } from "@/lib/client/localPrivateData";
import posthog from "posthog-js";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  authReady: boolean;
  isAdmin: boolean;
  adminResolved: boolean;
  /** Step 6.3 state machine — `"authenticated"` is the ONLY state in which client uid and server session uid are confirmed to match. */
  syncState: SessionSyncState;
  /** `syncState === "authenticated"` — convenience for gating protected mutations. */
  canMutate: boolean;
  /**
   * Step 6.7 — call at the very start of an explicit logout, BEFORE the
   * async `clearServerSession()`/`signOut()` calls, so protected mutation
   * UI (gated on `canMutate`) disables immediately rather than only after
   * those calls resolve. The reactive `onIdTokenChanged(null)` callback
   * that follows `signOut()` still drives the actual transition to
   * `signed_out` — this just closes the gap before that fires.
   */
  beginLogout: () => void;
  /**
   * R5 (PR #329 R4 review MINOR-1): true while `authReady` comes ONLY from the
   * 3 s cold-load timeout — the shell is unblocked as signed out, but Firebase
   * has not reported an identity yet (a persisted account may still resolve).
   * Identity-scoped UI (IdentityScopedRoute) treats this as "identity unknown",
   * never as an anonymous identity. Becomes false at the first Firebase callback.
   */
  identityProvisional: boolean;
}

const noop = () => {};

/**
 * #332 R7/R8 (owner decisions 2026-11-25): a temporary outage (the mint answered `auth_unavailable`, or the Firebase
 * client could not refresh its token: `auth/network-request-failed`, or the request never reached the server) gets a
 * bounded re-sync instead of a sign-out.
 *
 * R8: the bound belongs to ONE recovery episode per identity, held in `episodeRef`. It is not per callback. A forced
 * token refresh re-fires `onIdTokenChanged` (firebase 12.7.0 `User.getIdToken` → `_notifyListenersIfCurrent` →
 * `idTokenSubscription.next`). R7 restarted its counter on every such callback (241 mint calls in a reproduced
 * 10-minute outage). Now:
 * - a same-uid callback while an episode is active or exhausted starts nothing and resets nothing;
 * - retries do not force a refresh;
 * - the episode ends only on a verified session (success), a credential verdict (fail-closed sign-out), sign-out,
 *   `beginLogout`, an account switch, or unmount.
 *
 * The bound is per mounted AuthProvider, i.e. per tab. It is not a cross-tab or server-wide limit; every attempt is an
 * ordinary mint call under the server's own verification deadline and in-flight cap. After the bound, the client stays
 * in the non-mutable `session_unavailable` state until a reload or a new sign-in.
 */
export const SESSION_SYNC_MAX_ATTEMPTS_PER_EPISODE = 4;
/** Delay before retry n (1-based) of an episode: attempts 2, 3 and 4. */
export const SESSION_UNAVAILABLE_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/** #332 R8: one session-sync episode for one identity (see above). Mutable, owned by AuthProvider. */
interface SyncEpisode {
  readonly uid: string;
  readonly generation: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  exhausted: boolean;
  cancelled: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authReady: false,
  isAdmin: false,
  adminResolved: false,
  syncState: "signed_out",
  canMutate: false,
  beginLogout: noop,
  identityProvisional: false,
});

/**
 * Hook to access authentication context.
 * IMPORTANT: for protected mutations, gate on `canMutate`/`syncState`, not just `user`.
 */
export function useAuth() {
  return useContext(AuthContext);
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminResolved, setAdminResolved] = useState(false);
  const [identityProvisional, setIdentityProvisional] = useState(false);
  const [syncState, dispatchSync] = useReducer(nextSessionSyncState, "signed_out");
  // #332 R8: the single authoritative sync episode (see SyncEpisode). A ref, so `beginLogout` can end it too.
  const episodeRef = useRef<SyncEpisode | null>(null);
  // #332 R8: the identity this tab currently shows, or null after a sign-out OR once an explicit logout has begun. A
  // late successful mint for any other identity (or for anyone after logout began) has its cookie removed
  // (Correction C).
  const currentUidRef = useRef<string | null>(null);
  const endEpisode = () => {
    const e = episodeRef.current;
    if (e) {
      e.cancelled = true;
      if (e.timer !== null) clearTimeout(e.timer);
      e.timer = null;
      episodeRef.current = null;
    }
  };

  useEffect(() => {
    perf.mark('auth_check_start');

    let isMounted = true;
    let resolved = false;
    let authReadySet = false;
    const generationGuard = createGenerationGuard();
    const prevUidRef = { current: null as string | null };
    // Round 2 (review B1): the last identity Firebase reported in this tab,
    // INCLUDING one whose server-session sync then failed (prevUidRef is reset
    // before the fail-closed signOut). "Was someone signed in?" for the
    // sign-out cleanup must not depend on whether their sync succeeded.
    const lastIdentityRef = { current: null as string | null };

    const timeoutId = setTimeout(() => {
      if (!resolved && isMounted) {
        console.warn("[AuthProvider] Auth check timeout (3s) - unblocking shell, assuming no user");
        // R5: an unblocked shell, not an identity — Firebase has not answered yet. Set FIRST: without batching (legacy
        // roots, tests) every setter renders on its own, and no render may see authReady without this flag.
        setIdentityProvisional(true);
        setUser(null);
        setLoading(false);
        setIsAdmin(false);
        setAdminResolved(true);
        if (!authReadySet) {
          setAuthReady(true);
          authReadySet = true;
        }
        resolved = true;
        perf.mark('auth_check_timeout');
        perf.measure('auth_check_timeout_duration', 'auth_check_start', 'auth_check_timeout');
        perf.logMetrics();
      }
    }, 3000);

    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      if (!isMounted) return;

      // #332 R8: same identity while its episode is active or exhausted. This callback is the SDK re-firing after a
      // token change (often caused by our own refresh). It starts no attempt, resets no budget and bumps no
      // generation, so the episode's own in-flight attempt is not discarded.
      const active = episodeRef.current;
      if (nextUser && active && !active.cancelled && active.uid === nextUser.uid) {
        setUser(nextUser);
        setLoading(false);
        logAuthSessionClientEvent("stale_auth_operation_discarded", { failureCategory: "same_identity_reentry", operationGeneration: active.generation });
        return;
      }

      const myGeneration = generationGuard.next();
      endEpisode(); // a sign-out, account switch or ended episode: no older chain may continue

      if (!authReadySet) {
        setAuthReady(true);
        authReadySet = true;
      }
      if (!resolved) {
        clearTimeout(timeoutId);
        resolved = true;
        perf.mark('auth_check_resolved');
        perf.measure('auth_check_duration', 'auth_check_start', 'auth_check_resolved');
      }

      // ── Signed out (explicit logout, revoked session, or the SDK could not refresh) ──
      if (!nextUser) {
        // Privacy remediation (2026-11-17 audit): this branch is reached by
        // EVERY sign-out path (TopNav, profile, revoked/expired session,
        // fail-closed sync failure), so it is the one place that removes
        // browser-side copies of user content — the per-uid history cache
        // (claims + model output) and, for a real sign-out, the /verify
        // pending input — and, when
        // an identity was actually signed in, unlinks the PostHog distinct
        // id so later anonymous events are not attributed to that person.
        // Synchronous and first, before any await, so nothing can re-read
        // the cache in between.
        const hadIdentity = prevUidRef.current !== null || lastIdentityRef.current !== null;
        lastIdentityRef.current = null;
        // Round 2 (review B1): the /verify pending input is cleared only when
        // a signed-in identity signs out — an anonymous cold load also lands
        // here and must keep it (lib/client/verifyPrefill.ts).
        clearLocalPrivateDataOnSignOut({ hadIdentity });
        if (hadIdentity) {
          try {
            posthog.reset();
          } catch {
            /* analytics never blocks sign-out */
          }
        }
        prevUidRef.current = null;
        currentUidRef.current = null;
        dispatchSync({ type: "client_signed_out" });
        setUser(null);
        setIdentityProvisional(false); // R5: Firebase answered — after setUser, so no render pairs the old user with it

        setLoading(false);
        setIsAdmin(false);
        setAdminResolved(true);
        // Defensive cleanup: whatever caused Firebase to report no user, make
        // sure the server cookie doesn't outlive it. Safe to call even if
        // logout already cleared it (idempotent). Guarded so a login that
        // starts WHILE this is in flight can't have its own sync clobbered.
        await clearServerSession();
        if (!generationGuard.isCurrent(myGeneration)) {
          logAuthSessionClientEvent("stale_auth_operation_discarded", { operationGeneration: myGeneration });
        }
        return;
      }

      // ── Signed in: distinguish a new identity from a same-uid token refresh ──
      const isNewIdentity = prevUidRef.current === null || prevUidRef.current !== nextUser.uid;
      setUser(nextUser);
      setIdentityProvisional(false); // R5: Firebase answered — after setUser (see the null branch)
      setLoading(false);

      if (isNewIdentity) {
        // Privacy remediation (2026-11-17): a direct account switch (no
        // logout in between) must not leave the previous account's cached
        // history on this browser.
        clearOtherAccountsLocalData(nextUser.uid);
        lastIdentityRef.current = nextUser.uid;
        dispatchSync({ type: "client_signed_in", uid: nextUser.uid });
        dispatchSync({ type: "session_sync_started" });
      } else {
        dispatchSync({ type: "token_refresh_started" });
      }

      currentUidRef.current = nextUser.uid;
      const signedInUser = nextUser;
      const episode: SyncEpisode = { uid: nextUser.uid, generation: myGeneration, attempts: 1, timer: null, exhausted: false, cancelled: false };
      episodeRef.current = episode;

      const outcome = await establishServerSession(signedInUser, { generation: myGeneration });
      await settleOutcome(outcome, isNewIdentity);

      async function settleOutcome(result: SessionSyncOutcome, newIdentity: boolean): Promise<void> {
        if (!isMounted || episode.cancelled || !generationGuard.isCurrent(myGeneration)) {
          // A newer callback (a switch or a sign-out), beginLogout or unmount ended this episode. Its result is
          // never adopted. R8 (Correction C): if it minted a cookie for an identity this tab no longer shows (signed
          // out, or switched away), remove that cookie so it cannot authorize anything.
          logAuthSessionClientEvent("stale_auth_operation_discarded", { operationGeneration: myGeneration });
          if (result.ok && currentUidRef.current !== result.uid) await clearServerSession();
          return;
        }

        if (result.ok) {
          episodeRef.current = null; // episode boundary: a verified session
          prevUidRef.current = result.uid;
          dispatchSync({ type: newIdentity ? "session_sync_succeeded" : "token_refresh_succeeded" });

          // Admin claim check — only meaningful once the server agrees this is
          // the current identity. Non-blocking for isMounted races: guarded by
          // the SAME generation check above before this point.
          try {
            const tokenResult = await getIdTokenResult(signedInUser);
            if (isMounted && generationGuard.isCurrent(myGeneration)) {
              setIsAdmin(tokenResult.claims.admin === true);
              setAdminResolved(true);
            }
          } catch {
            if (isMounted && generationGuard.isCurrent(myGeneration)) {
              setIsAdmin(false);
              setAdminResolved(true);
            }
          }
          return;
        }

        // #332 R7/R8: a temporary outage, i.e. verification could not run (mint `auth_unavailable`, client token
        // refresh `auth/network-request-failed`, or the mint request never reached the server). It is not a credential
        // verdict, so the client is NOT signed out and the sign-out cleanup (history cache, unsubmitted /verify input,
        // analytics reset) does not run. Fail closed: `establishServerSession` attempted to clear the server cookie;
        // `session_unavailable` is never mutable. R8 (Correction C): for a NEW identity (first sign-in or account
        // switch), if that clear did not succeed, a cookie this sync did not verify (possibly another account's) may
        // remain. So take the ordinary fail-closed sign-out instead (unchanged pre-#332 behaviour).
        // Only the explicit contract counts: sessionSync returns "auth_unavailable" for the mint's 503+code, for the one
        // classified SDK code and for a rejected fetch. "network_error" (an unclassified throw) still fails closed.
        const temporary = result.reason === "auth_unavailable";
        if (temporary && (result.serverSessionCleared || !newIdentity)) {
          prevUidRef.current = null; // unconfirmed until a verified session
          dispatchSync({ type: "session_sync_unavailable" });
          setIsAdmin(false);
          setAdminResolved(true);
          if (episode.attempts >= SESSION_SYNC_MAX_ATTEMPTS_PER_EPISODE) {
            episode.exhausted = true; // stays in episodeRef: same-uid callbacks keep starting nothing
            logAuthSessionClientEvent("session_sync_failed", { failureCategory: "recovery_budget_exhausted", operationGeneration: myGeneration });
            return;
          }
          episode.timer = setTimeout(() => {
            episode.timer = null;
            if (!isMounted || episode.cancelled || !generationGuard.isCurrent(myGeneration)) return;
            episode.attempts += 1;
            dispatchSync({ type: "session_retry_started" });
            // No forced refresh on a retry: a forced refresh re-fires onIdTokenChanged. The server still verifies
            // this valid, unexpired ID token with checkRevoked.
            void establishServerSession(signedInUser, { generation: myGeneration, forceRefresh: false }).then((retried) =>
              settleOutcome(retried, true)
            );
          }, SESSION_UNAVAILABLE_RETRY_DELAYS_MS[episode.attempts - 1]);
          return;
        }

        // Fail closed: `establishServerSession` already cleared the server
        // cookie. The previous identity must never be retained on the
        // client either, so sign Firebase out too — this itself fires
        // another onIdTokenChanged(null) callback that completes the
        // transition to `signed_out`.
        episodeRef.current = null; // episode boundary: a credential verdict (or an unclassified failure)
        prevUidRef.current = null;
        dispatchSync({ type: newIdentity ? "session_sync_failed" : "token_refresh_failed" });
        setIsAdmin(false);
        setAdminResolved(true);
        try {
          await signOut(auth);
        } catch {
          // If sign-out itself fails, the state machine is already in
          // session_error (never authenticated), which is the fail-closed
          // outcome this branch exists to guarantee.
        }
      }
    });

    return () => {
      isMounted = false;
      endEpisode();
      clearTimeout(timeoutId);
      unsubscribe();
    };
  }, []);

  // #332 R8: an explicit logout ends the sync episode at once: its timer is cancelled, and a pending attempt's late
  // result is discarded (its cookie removed) rather than adopted.
  const beginLogout = () => {
    endEpisode();
    currentUidRef.current = null; // from now on no late mint may keep a cookie, even for the same uid
    dispatchSync({ type: "logout_started" });
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, authReady, isAdmin, adminResolved, syncState, canMutate: canPerformProtectedMutation(syncState), beginLogout, identityProvisional }}
    >
      {children}
    </AuthContext.Provider>
  );
}
