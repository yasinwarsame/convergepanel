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
import { establishServerSession, clearServerSession } from "@/lib/client/sessionSync";
import { logAuthSessionClientEvent } from "@/lib/client/authSessionTelemetry";

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
}

const noop = () => {};

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authReady: false,
  isAdmin: false,
  adminResolved: false,
  syncState: "signed_out",
  canMutate: false,
  beginLogout: noop,
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
  const [syncState, dispatchSync] = useReducer(nextSessionSyncState, "signed_out");

  useEffect(() => {
    perf.mark('auth_check_start');

    let isMounted = true;
    let resolved = false;
    let authReadySet = false;
    const generationGuard = createGenerationGuard();
    const prevUidRef = { current: null as string | null };

    const timeoutId = setTimeout(() => {
      if (!resolved && isMounted) {
        console.warn("[AuthProvider] Auth check timeout (3s) - unblocking shell, assuming no user");
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
        prevUidRef.current = null;
        dispatchSync({ type: "client_signed_out" });
        setUser(null);
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
      setLoading(false);

      if (isNewIdentity) {
        dispatchSync({ type: "client_signed_in", uid: nextUser.uid });
        dispatchSync({ type: "session_sync_started" });
      } else {
        dispatchSync({ type: "token_refresh_started" });
      }

      const outcome = await establishServerSession(nextUser, { generation: myGeneration });

      if (!generationGuard.isCurrent(myGeneration)) {
        // A newer callback (another refresh, a switch, a logout) has already
        // started since this one began — its own processing owns state now.
        logAuthSessionClientEvent("stale_auth_operation_discarded", { operationGeneration: myGeneration });
        return;
      }

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
      } else {
        // Fail closed: `establishServerSession` already cleared the server
        // cookie. The previous identity must never be retained on the
        // client either, so sign Firebase out too — this itself fires
        // another onIdTokenChanged(null) callback that completes the
        // transition to `signed_out`.
        prevUidRef.current = null;
        dispatchSync({ type: isNewIdentity ? "session_sync_failed" : "token_refresh_failed" });
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
      clearTimeout(timeoutId);
      unsubscribe();
    };
  }, []);

  const beginLogout = () => dispatchSync({ type: "logout_started" });

  return (
    <AuthContext.Provider
      value={{ user, loading, authReady, isAdmin, adminResolved, syncState, canMutate: canPerformProtectedMutation(syncState), beginLogout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
