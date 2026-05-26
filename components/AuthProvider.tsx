"use client";

/**
 * Authentication Provider Component
 * 
 * This component provides global authentication state to the entire application
 * using React Context. It:
 * - Listens to Firebase auth state changes (login, logout, token refresh)
 * - Extracts admin status from Firebase custom claims
 * - Provides auth state to all child components via useAuth() hook
 * 
 * PERFORMANCE: Optimized to not block initial render. Auth state resolves
 * asynchronously while the UI shell renders immediately.
 * 
 * Usage:
 *   const { user, loading, isAdmin } = useAuth();
 */

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, onAuthStateChanged, getIdTokenResult } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { perf } from "@/lib/utils/performance";

/**
 * Authentication context type definition
 * 
 * - user: Current Firebase user object (null if not logged in)
 * - loading: Whether auth state is still being determined (prevents flash of wrong UI)
 * - authReady: Whether the first onAuthStateChanged callback has executed (regardless of user state)
 *   This is the signal that auth initialization is complete and API calls are safe.
 * - isAdmin: Whether current user has admin custom claim (from Firebase token)
 * - adminResolved: Whether the admin claim check has completed (prevents premature admin gate decisions)
 */
interface AuthContextType {
  user: User | null;
  loading: boolean;
  authReady: boolean;
  isAdmin: boolean;
  adminResolved: boolean;
}

/**
 * Default context value (used before auth state is determined)
 */
const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authReady: false,
  isAdmin: false,
  adminResolved: false,
});

/**
 * Hook to access authentication context
 * 
 * Use this in any component to get current auth state:
 *   const { user, loading, authReady, isAdmin } = useAuth();
 * 
 * IMPORTANT: For protected API calls, wait for authReady && user before making requests.
 */
export function useAuth() {
  return useContext(AuthContext);
}

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * AuthProvider Component
 * 
 * Wraps the app and provides authentication state to all children.
 * Should be placed high in the component tree (typically in root layout).
 */
export function AuthProvider({ children }: AuthProviderProps) {
  // State to track current user, loading status, auth readiness, and admin status
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminResolved, setAdminResolved] = useState(false);

  /**
   * Set up Firebase auth state listener
   * 
   * PERFORMANCE: Optimized for fast initial render:
   * - Sets loading=false after a short timeout (3s) to unblock shell rendering
   * - Auth state resolves asynchronously without blocking UI
   * - Admin check happens after render (non-blocking)
   * 
   * authReady becomes true after the first onAuthStateChanged callback executes,
   * which is the signal that auth initialization is complete and API calls are safe.
   * 
   * onAuthStateChanged fires whenever:
   * - User signs in
   * - User signs out
   * - Token is refreshed
   * - App initializes (to check if user is already logged in)
   */
  useEffect(() => {
    perf.mark('auth_check_start');
    
    let isMounted = true;
    let resolved = false;
    let authReadySet = false;

    // Aggressive timeout: unblock shell after 3 seconds
    // This prevents blocking even if Firebase is slow
    const timeoutId = setTimeout(() => {
      if (!resolved && isMounted) {
        console.warn("[AuthProvider] Auth check timeout (3s) - unblocking shell, assuming no user");
        setUser(null);
        setLoading(false);
        setIsAdmin(false);
        setAdminResolved(true);
        // Mark auth as ready even on timeout so API calls can proceed (with null user)
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

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!isMounted) return;
      
      // Mark auth as ready after first callback (regardless of user state)
      if (!authReadySet) {
        setAuthReady(true);
        authReadySet = true;
        if (process.env.NODE_ENV !== "production") {
          console.debug("[AuthProvider] Auth ready:", { hasUser: !!user });
        }
      }
      
      if (!resolved) {
        // Clear the timeout since auth state change fired
        clearTimeout(timeoutId);
        resolved = true;
        perf.mark('auth_check_resolved');
        perf.measure('auth_check_duration', 'auth_check_start', 'auth_check_resolved');
      }
      
      // Update user state immediately
      setUser(user);
      
      // Set loading to false immediately so UI can render
      // This allows the shell to render while we check admin status
      setLoading(false);
      
      // Check admin status asynchronously (non-blocking)
      // This happens after initial render, so it doesn't delay shell
      if (user) {
        try {
          // Force refresh token first to get latest custom claims
          // This ensures we get the most up-to-date admin claim
          await user.getIdToken(true); // Force refresh
          const tokenResult = await getIdTokenResult(user);
          if (isMounted) {
            setIsAdmin(tokenResult.claims.admin === true);
            setAdminResolved(true);
            if (process.env.NODE_ENV !== "production") {
              console.log("[AuthProvider] Admin status:", tokenResult.claims.admin === true);
            }
          }
        } catch (error) {
          console.error("[AuthProvider] Error getting token result:", error);
          if (isMounted) {
            setIsAdmin(false);
            setAdminResolved(true);
          }
        }
      } else {
        setIsAdmin(false);
        setAdminResolved(true);
      }
    });

    // Cleanup: unsubscribe from auth state changes and clear timeout
    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      unsubscribe();
    };
  }, []); // Empty dependency array - this effect should only run once on mount

  /**
   * Provide auth state to all child components via Context
   */
  return (
    <AuthContext.Provider value={{ user, loading, authReady, isAdmin, adminResolved }}>
      {children}
    </AuthContext.Provider>
  );
}

