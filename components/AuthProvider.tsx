"use client";

/**
 * Authentication Provider Component
 *
 * Auth Lifecycle Hardening, Step 6.3/6.6/6.8 — the single owner of the
 * client/server session-verification state machine
 * (`lib/client/authSessionStateMachine.ts`), not just a passthrough for
 * Firebase's client auth state. `syncState === "authenticated"` means: the
 * server verified, revocation-checked, a bearer for EXACTLY this uid, in this
 * episode (the handshake, `POST /api/auth/session`, ZCA P3 R2 "verify, don't
 * mint"). There is no server session cookie: every API request authenticates
 * with its own bearer, so nothing here writes or clears server state.
 *
 * This component:
 * - Listens to `onIdTokenChanged` (a superset of `onAuthStateChanged`: also
 *   fires on silent token refresh), not `onAuthStateChanged`.
 * - Treats every callback with a DIFFERENT uid than previously tracked
 *   (including the very first callback after mount) as a new identity that
 *   must be verified by the server before `syncState` can become
 *   `"authenticated"` — this is what makes a direct account switch (no
 *   explicit logout in between) safe, per Step 6.6's fallback path.
 * - Treats a callback with the SAME uid as a routine token refresh, which
 *   keeps `syncState` at `"authenticated"` throughout (no UI flicker) and
 *   re-verifies the new token.
 * - Guards every async result with an operation-generation counter
 *   (`lib/client/authGeneration.ts`) so a stale response — an old login
 *   after a newer one, a refresh after logout, a rapid A→B→A — can never
 *   overwrite state a later operation has already established.
 * - On a verification failure or uid mismatch, defensively signs the Firebase
 *   client out — the previous identity is never retained. (A 403
 *   `cross_origin` answer is the exception, R2 L-2: not a credential verdict,
 *   so it degrades to `session_error` without signing out.)
 * - `cancelLogout()` (ZCA P3 R2 MB) re-enters verification through the same
 *   episode machinery when a local `signOut` threw.
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
import { establishServerSession } from "@/lib/client/sessionSync";
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
   * async `signOut()` call, so protected mutation UI (gated on `canMutate`)
   * disables immediately rather than only after it resolves. The reactive
   * `onIdTokenChanged(null)` callback that follows `signOut()` still drives
   * the actual transition to `signed_out` — this just closes the gap before
   * that fires.
   */
  beginLogout: () => void;
  /**
   * ZCA P3 R2 MB / L-1 — call when the local `signOut()` that followed
   * `beginLogout()` THREW. It never reports the logout as completed:
   *   - Firebase reports nobody → the signed-out transition (`client_signed_out`,
   *     React `user` null, `isAdmin` false);
   *   - Firebase still reports a user → that user is re-verified as a NEW
   *     identity episode through the ordinary `handleTokenEvent` machinery
   *     (deadline, abort, own-refresh echo coalescing, generation guard):
   *     `canMutate` comes back only after a fresh 200 for that uid.
   * It never runs a handshake of its own.
   */
  cancelLogout: () => void;
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
 * R-S0-6: hard client deadline for one session-synchronization episode (token read → server answer → handling), the
 * initial sync of an identity and a confirmed session's refresh alike.
 * Worst legitimate case: two attempts (the first plus the bounded 401 retry), each = one forced securetoken refresh
 * (normally < 2 s) + one mint bounded server-side by AUTH_VERIFICATION_DEADLINE_MS (10 s, one end-to-end deadline per
 * mint) + transport / cold start (~2–3 s) ≈ 2 × 15 s = 30 s. Past it the attempt cannot be a legitimate slow success
 * of the reviewed server contract, so it FAILS CLOSED: the POST is aborted, late results are invalidated and Firebase
 * is signed out (the same fail-closed transition as a failed sync, which for a routine refresh's
 * network error is already sign-out); the user signs in again explicitly. It never falls back to the pre-R-S0-6
 * callback handling.
 */
export const SESSION_SYNC_DEADLINE_MS = 30_000;

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authReady: false,
  isAdmin: false,
  adminResolved: false,
  syncState: "signed_out",
  canMutate: false,
  beginLogout: noop,
  cancelLogout: noop,
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
  // ZCA P3 R2 MB: bound by the effect below to its own episode machinery; a no-op before mount and after unmount.
  const cancelLogoutRef = useRef<() => void>(noop);

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
    // R-S0-4: the ID-token refreshes THIS provider's own session sync currently has pending, as generation → User object.
    // firebase 12.7.0 notifies onIdTokenChanged from inside `getIdToken` when the refreshed token differs (before
    // the call resolves), so a callback that arrives for the SAME User object while that sync's own refresh is pending is
    // the echo of (or concurrent with) the refresh the sync is already doing, and the sync will use that token.
    // Starting another sync for it would force yet another refresh, which notifies again: with a securetoken round
    // trip of about 1 s or more (tokens carry `iat` in whole seconds) that repeats indefinitely. Such a callback is
    // coalesced: no new sync, no generation bump, so the in-flight sync stays current and decides the outcome.
    // Never coalesced: a null user (logout / invalidation), a different uid (account switch), a replaced User object
    // with the same uid (R-S0-7), a callback after the
    // refresh resolved (an external event during the mint request), or one whose sync is no longer current.
    // R-S0-7 (owner decision 2026-11-27, review MINOR-2): an echo is identified by the Firebase User OBJECT, not the uid.
    // The SDK delivers its own refresh notification (and a cross-tab `_assign`) for the same object; a different object
    // with the same uid is a replacement (a new sign-in of that account) and must reach the episode logic below, which
    // supersedes the old episode. Comparing uids alone silently swallowed such a replacement while a refresh was pending.
    const ownPendingRefresh = new Map<number, User>();
    const isOwnRefreshEcho = (user: User): boolean => {
      for (const [gen, pendingUser] of ownPendingRefresh) {
        if (pendingUser === user && generationGuard.isCurrent(gen)) return true;
      }
      return false;
    };

    // R-S0-6 (owner decision 2026-11-27): every session synchronization is single-flight. Root cause (real browsers,
    // diagnosis 09): until a tab's server session was confirmed, every callback counted as a new identity, bumped the
    // generation (which discarded the pending mint, valid 200 or 401 alike) and forced another refresh; with ≥ 2 tabs
    // and a mint slower than the cross-tab token cycle, each tab's new token restarted the other tabs' syncs
    // indefinitely and no answer was ever applied. The same supersession also starved a CONFIRMED session's bounded
    // 401 retry: its forced refresh's new token came back from another tab and superseded the retry before its 401
    // could fail closed, so the tab stayed `authenticated` while the server kept refusing. Now one episode owns each
    // sync from token read through the server answer and its result handling, for exactly one uid AND one Firebase
    // User object, under its own generation.
    // - A callback for that same uid and same object (a token change arriving through persistence or the SDK) is
    //   coalesced into the episode: no generation bump, no new forced refresh; it queues at most ONE follow-up, an
    //   ordinary non-forced same-uid refresh that runs only after a successful answer.
    // - Anything else (null, another uid, a replaced User object) supersedes the episode immediately, as before, and
    //   aborts its pending POST, so a superseded answer is never applied.
    // - The episode has a hard client deadline that FAILS CLOSED (see SESSION_SYNC_DEADLINE_MS).
    // - Own refresh echoes (same User object, R-S0-7) are still coalesced first by R-S0-4 (no follow-up: the sync uses
    //   that token).
    // - After a fail-closed outcome, callbacks for that same User object are dropped until Firebase reports null or a
    //   different user (no automatic restart into the failed episode; a fresh sign-in creates a new User object).
    type SyncEpisode = {
      readonly generation: number;
      readonly uid: string;
      readonly user: User;
      readonly isNewIdentity: boolean;
      readonly controller: AbortController;
      readonly timer: ReturnType<typeof setTimeout>;
      followUp: boolean;
    };
    let syncEpisode: SyncEpisode | null = null;
    let failedEpisodeUser: User | null = null;
    const endSyncEpisode = (): SyncEpisode | null => {
      const ep = syncEpisode;
      if (ep) {
        clearTimeout(ep.timer);
        syncEpisode = null;
      }
      return ep;
    };
    /** Supersede: a newer identity event owns state now. The episode's in-flight POST is aborted (its answer is stale). */
    const supersedeSyncEpisode = () => {
      endSyncEpisode()?.controller.abort();
    };
    /**
     * R-S0-7: `signOut(auth)` signs out whoever Firebase reports NOW, not the identity a stale operation was about. So a
     * fail-closed sign-out is issued only while Firebase still reports exactly the failed User object (object identity:
     * a replacement object with the same uid is a different sign-in and is never signed out by the old episode). If
     * Firebase already reports another user or nobody, that newer state owns the tab: its own callback runs its own
     * episode (or the null branch's cleanup), and this operation does nothing destructive. Checked synchronously
     * immediately before the call, so no await separates the check from the sign-out it guards.
     */
    const signOutIfStillCurrent = async (failedUser: User): Promise<void> => {
      if (auth.currentUser !== failedUser) {
        logAuthSessionClientEvent("stale_cleanup_skipped", {});
        return;
      }
      try {
        await signOut(auth);
      } catch {
        // If sign-out itself fails, the state machine is already in session_error (never authenticated) and later
        // callbacks for this User object are dropped — the fail-closed outcome this exists to guarantee.
      }
    };
    const failClosed = async (failedUser: User) => {
      failedEpisodeUser = failedUser;
      prevUidRef.current = null;
      setIsAdmin(false);
      setAdminResolved(true);
      await signOutIfStillCurrent(failedUser);
    };
    const expireSyncEpisode = (ep: SyncEpisode) => {
      if (!isMounted || syncEpisode !== ep) return;
      endSyncEpisode();
      ep.controller.abort(); // the expired episode's POST: its answer is never processed
      const expiryGeneration = generationGuard.next(); // every late result of the expired episode is now stale
      failedEpisodeUser = ep.user; // synchronously: no later callback for this User object may restart this episode
      prevUidRef.current = null;
      logAuthSessionClientEvent("sync_episode_deadline_exceeded", { operationGeneration: ep.generation });
      dispatchSync({ type: ep.isNewIdentity ? "session_sync_failed" : "token_refresh_failed" });
      setIsAdmin(false);
      setAdminResolved(true);
      // R-S0-7: every state change above is synchronous, so protected operations are disabled now. The sign-out
      // acts ONLY while the expired identity still owns the tab: no newer identity event has bumped the generation
      // since the expiry, and Firebase still reports the expired User object (object identity, never the uid). A newer
      // user (A→B), a new sign-in of the same account (a new User object) or a logout that happened meanwhile owns
      // state now; the expired episode's cleanup never signs it out. (ZCA P3 R2: there is no server DELETE any more.)
      if (!(generationGuard.isCurrent(expiryGeneration) && auth.currentUser === ep.user)) {
        logAuthSessionClientEvent("stale_cleanup_skipped", { operationGeneration: ep.generation });
        return;
      }
      void signOutIfStillCurrent(ep.user);
    };

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

    const handleTokenEvent = async (nextUser: User | null): Promise<void> => {
      if (!isMounted) return;

      if (nextUser && isOwnRefreshEcho(nextUser)) {
        logAuthSessionClientEvent("own_refresh_echo_coalesced", {});
        return;
      }

      // R-S0-6: same uid AND same User object while its sync is still current → part of that episode.
      if (
        nextUser &&
        syncEpisode !== null &&
        nextUser === syncEpisode.user &&
        nextUser.uid === syncEpisode.uid &&
        generationGuard.isCurrent(syncEpisode.generation)
      ) {
        syncEpisode.followUp = true;
        logAuthSessionClientEvent("sync_episode_callback_coalesced", { operationGeneration: syncEpisode.generation });
        return;
      }

      // R-S0-6: no automatic restart into an episode that already failed closed (same User object, no null between).
      if (nextUser && failedEpisodeUser !== null && nextUser === failedEpisodeUser) {
        logAuthSessionClientEvent("failed_episode_callback_dropped", {});
        return;
      }
      failedEpisodeUser = null;

      supersedeSyncEpisode();
      const myGeneration = generationGuard.next();

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
        dispatchSync({ type: "client_signed_out" });
        setUser(null);
        setIdentityProvisional(false); // R5: Firebase answered — after setUser, so no render pairs the old user with it

        setLoading(false);
        setIsAdmin(false);
        setAdminResolved(true);
        // ZCA P3 R2: no server cleanup — there is no server session to clear (no client DELETE anywhere).
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

      // R-S0-4: the sync reads its token through this wrapper, so whatever refresh it performs is marked pending for
      // exactly as long as `getIdToken` runs, and a same-uid callback that refresh causes is coalesced into this sync.
      // The token itself still comes from the SDK unchanged, and the wrapper forwards `forceRefresh` exactly as given.
      const syncUser = {
        uid: nextUser.uid,
        getIdToken: async (forceRefresh?: boolean): Promise<string> => {
          ownPendingRefresh.set(myGeneration, nextUser);
          try {
            return await nextUser.getIdToken(forceRefresh);
          } finally {
            ownPendingRefresh.delete(myGeneration);
          }
        },
      };
      // R-S0-6: this sync is an episode (see above): single-flight until its answer is handled.
      const episode: SyncEpisode = {
        generation: myGeneration,
        uid: nextUser.uid,
        user: nextUser,
        isNewIdentity,
        controller: new AbortController(),
        timer: setTimeout(() => expireSyncEpisode(episode), SESSION_SYNC_DEADLINE_MS),
        followUp: false,
      };
      syncEpisode = episode;

      // Stage 0 F3: only a same-uid refresh of an identity THIS tab already confirmed may keep its
      // confirmed state when the handshake says "verification could not run" (503 auth_unavailable).
      // Stage 0 B1 (also closes R-S0-5): the same-uid refresh uses the token this callback was delivered for (no forced
      // refresh), so neither this tab's own sync nor another tab's persisted token can make it mint a new token that
      // re-notifies every tab. New identities still force (Step 6.5); the bounded 401 retry always forces.
      const outcome = await establishServerSession(syncUser, {
        generation: myGeneration,
        keepSessionOnAuthUnavailable: !isNewIdentity,
        forceRefresh: isNewIdentity,
        signal: episode.controller.signal,
      });

      if (!generationGuard.isCurrent(myGeneration)) {
        // A newer callback (a switch, a logout, a replaced User object) or the episode deadline has already
        // taken over since this one began — its own processing owns state now.
        logAuthSessionClientEvent("stale_auth_operation_discarded", { operationGeneration: myGeneration });
        return;
      }
      // Still current, so the episode is still this one: it ends here, with this answer.
      const followUp = syncEpisode === episode && episode.followUp;
      if (syncEpisode === episode) endSyncEpisode();

      if (outcome.ok) {
        prevUidRef.current = outcome.uid;
        dispatchSync({ type: isNewIdentity ? "session_sync_succeeded" : "token_refresh_succeeded" });

        // Admin claim check — only meaningful once the server agrees this is
        // the current identity. Non-blocking for isMounted races: guarded by
        // the SAME generation check above before this point.
        try {
          const tokenResult = await getIdTokenResult(nextUser);
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
        // R-S0-6: token changes coalesced during the episode get exactly ONE reconciliation — an ordinary same-uid
        // refresh of the now-confirmed session (non-forced, Stage 0 B1; its own episode and fail-closed rules). Only if
        // nothing newer has happened meanwhile; never repeated for this episode. A failed or deferred episode drops it.
        if (followUp && isMounted && generationGuard.isCurrent(myGeneration)) {
          logAuthSessionClientEvent("sync_episode_follow_up", { operationGeneration: myGeneration });
          await handleTokenEvent(nextUser);
        }
      } else if (!isNewIdentity && outcome.reason === "auth_unavailable") {
        // Stage 0 F3: a routine same-uid refresh hit a verification OUTAGE, not a
        // credential verdict. Keep the confirmed state (no sign-out — so no lost
        // /verify input and no sign-out of every other tab).
        // No retry: the next Firebase token event re-attempts. A revoked/disabled/
        // invalid answer (401), any other failure, and every new identity still
        // take the fail-closed branch below.
        dispatchSync({ type: "token_refresh_deferred" });
        logAuthSessionClientEvent("token_refresh_deferred", { operationGeneration: myGeneration });
      } else if (outcome.reason === "cross_origin") {
        // R2 L-2: the server refused this page's ORIGIN (a host mismatch), which is not a verdict on the
        // credential. Degrade to "cannot mutate" WITHOUT signing Firebase out (no sign-out storm across
        // tabs). This User object cannot restart a handshake until Firebase reports null or another user,
        // so a refused origin can never drive a refresh loop.
        prevUidRef.current = null;
        dispatchSync({ type: isNewIdentity ? "session_sync_failed" : "token_refresh_failed" });
        failedEpisodeUser = nextUser;
        setIsAdmin(false);
        setAdminResolved(true);
      } else {
        // Fail closed. The previous identity must never be retained on the
        // client, so sign Firebase out — this itself fires
        // another onIdTokenChanged(null) callback that completes the
        // transition to `signed_out`. Queued follow-up work is dropped, and this
        // User object cannot restart a sync until Firebase reports null or another user.
        prevUidRef.current = null;
        dispatchSync({ type: isNewIdentity ? "session_sync_failed" : "token_refresh_failed" });
        await failClosed(nextUser);
      }
    };

    /**
     * ZCA P3 R2 MB / L-1: the local `signOut` after `beginLogout()` threw. Re-enter through `handleTokenEvent` —
     * never a handshake of its own — so the re-verification is an ordinary registered episode (deadline, abort
     * controller, `ownPendingRefresh` echo coalescing, generation guard):
     *   - whatever was in flight is about the pre-logout tab: it is superseded and its generation retired FIRST, so
     *     neither the R-S0-4 echo check nor the R-S0-6 episode coalescing can swallow this re-entry;
     *   - `failedEpisodeUser` is reset: the explicit user action may re-verify a User object an earlier episode failed;
     *   - `prevUidRef = null` makes it a NEW identity episode (`client_signed_in` → `syncing_session`, forced token,
     *     `keepSessionOnAuthUnavailable` false), so only `session_sync_succeeded` for this uid reaches `authenticated`;
     *   - Firebase reports nobody (L-1) → the ordinary signed-out branch (`client_signed_out`, user null, not admin).
     */
    cancelLogoutRef.current = () => {
      if (!isMounted) return;
      const current = auth.currentUser;
      supersedeSyncEpisode();
      generationGuard.next();
      failedEpisodeUser = null;
      prevUidRef.current = null;
      logAuthSessionClientEvent("logout_cancelled", {});
      void handleTokenEvent(current);
    };

    const unsubscribe = onIdTokenChanged(auth, handleTokenEvent);

    return () => {
      isMounted = false;
      cancelLogoutRef.current = noop;
      clearTimeout(timeoutId);
      supersedeSyncEpisode();
      unsubscribe();
    };
  }, []);

  const beginLogout = () => dispatchSync({ type: "logout_started" });
  const cancelLogout = () => cancelLogoutRef.current();

  return (
    <AuthContext.Provider
      value={{ user, loading, authReady, isAdmin, adminResolved, syncState, canMutate: canPerformProtectedMutation(syncState), beginLogout, cancelLogout, identityProvisional }}
    >
      {children}
    </AuthContext.Provider>
  );
}
