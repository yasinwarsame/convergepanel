"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";

/**
 * ADMINISTRATOR TIERS, server-derived.
 *
 *   canAccess / adminPortal  ADMIN_PORTAL — the `admin` custom claim, or a
 *                            verified `ADMIN_EMAILS` member. (The old doc here
 *                            said "governance admin email allowlist", which was
 *                            wrong even before the split.)
 *   isSystemAdmin            SYSTEM_ADMIN — the `admin` custom claim ONLY.
 *                            Gates provider credentials, admin-claim minting,
 *                            bulk purge, and destructive account/billing
 *                            mutation.
 *
 * `isSystemAdmin` exists so the portal shows only capabilities the caller
 * actually holds: an ADMIN_EMAILS-only administrator previously saw every
 * control and got a 401 from each one. It is a UI affordance — the server
 * guards remain authoritative and are unchanged by it.
 *
 * Both come from the server (`GET /api/admin/access`) or from the verified
 * claim; never from an email, a Firestore role, or the legacy `role: "admin"`
 * presentation string.
 *
 * Waits for `adminResolved` from AuthProvider before making any access decision,
 * preventing a race where the admin claim hasn't loaded yet.
 */
export function useAdminPortalAccess(): {
  canAccess: boolean;
  isSystemAdmin: boolean;
  gateReady: boolean;
  authReady: boolean;
  user: ReturnType<typeof useAuth>["user"];
} {
  const { user, loading, authReady, isAdmin, adminResolved } = useAuth();
  const [emailAllowlistOk, setEmailAllowlistOk] = useState<boolean | null>(null);
  const [serverSystemAdmin, setServerSystemAdmin] = useState(false);

  useEffect(() => {
    /**
     * Phase FIRST-ADMIN-C3 — FAIL CLOSED DURING UNCERTAINTY.
     *
     * R2 proved that server-derived SYSTEM_ADMIN state survived an identity
     * change: this effect reset `emailAllowlistOk` but never
     * `serverSystemAdmin`, and reset neither before awaiting the replacement
     * `/api/admin/access` response. So after a claim revocation or a switch to
     * a different user, the hook reported `gateReady === true` AND
     * `isSystemAdmin === true` for a caller who no longer held the claim, until
     * the fetch settled — showing credential, role-minting and purge controls
     * in that window.
     *
     * Both are now cleared on every dependency change, before any await. The
     * updater form returns the identical value when nothing changed, so React
     * bails out of the re-render and an unstable `user` identity cannot loop.
     */
    const clearDerivedAuthority = () => {
      setEmailAllowlistOk((prev) => (prev === null ? prev : null));
      setServerSystemAdmin((prev) => (prev === false ? prev : false));
    };

    if (!authReady || !adminResolved || !user) {
      clearDerivedAuthority();
      return;
    }
    if (isAdmin) {
      // The custom claim IS SYSTEM_ADMIN, and therefore also ADMIN_PORTAL.
      setEmailAllowlistOk(true);
      setServerSystemAdmin(true);
      return;
    }
    // The identity changed and is not claim-backed: drop any privilege derived
    // from the PREVIOUS identity before asking the server about this one.
    clearDerivedAuthority();

    let cancelled = false;
    (async () => {
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch("/api/admin/access", {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        let systemAdmin = false;
        try {
          const body = (await res.json()) as { systemAdmin?: unknown };
          systemAdmin = body?.systemAdmin === true;
        } catch {
          /* absent or unparsable body -> not system admin */
        }
        if (!cancelled) {
          setEmailAllowlistOk(res.ok);
          setServerSystemAdmin(res.ok && systemAdmin);
        }
      } catch {
        if (!cancelled) {
          setEmailAllowlistOk(false);
          setServerSystemAdmin(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authReady, adminResolved, isAdmin]);

  /**
   * Phase FIRST-ADMIN-C3: no capability is published before the identity and
   * the custom claim have resolved. Clearing `serverSystemAdmin` alone was not
   * enough — `isAdmin` is a separate live signal from AuthProvider, so while
   * `adminResolved` was false the hook still reported SYSTEM_ADMIN from a claim
   * value that was itself not yet trustworthy. Both tiers now require
   * resolution, which is the fail-closed direction for any consumer that reads
   * a capability without also honouring `gateReady`.
   */
  const identityResolved = !loading && authReady && adminResolved;

  const gateReady = identityResolved && (!user || isAdmin || emailAllowlistOk !== null);
  const canAccess = !!user && identityResolved && (isAdmin || emailAllowlistOk === true);

  // Fails closed: SYSTEM_ADMIN requires the claim or an explicit server-side
  // `systemAdmin: true`, never mere portal access.
  const isSystemAdmin = !!user && identityResolved && (isAdmin || serverSystemAdmin);

  return { canAccess, isSystemAdmin, gateReady, authReady, user };
}
