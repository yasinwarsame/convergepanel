"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";

/**
 * True when the user has the Firebase `admin` claim or is on the governance admin email allowlist (server-checked).
 */
export function useAdminPortalAccess(): {
  canAccess: boolean;
  gateReady: boolean;
  authReady: boolean;
  user: ReturnType<typeof useAuth>["user"];
} {
  const { user, loading, authReady, isAdmin } = useAuth();
  const [emailAllowlistOk, setEmailAllowlistOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!authReady || !user) {
      setEmailAllowlistOk(null);
      return;
    }
    if (isAdmin) {
      setEmailAllowlistOk(true);
      return;
    }
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
        if (!cancelled) setEmailAllowlistOk(res.ok);
      } catch {
        if (!cancelled) setEmailAllowlistOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authReady, isAdmin]);

  const gateReady = !loading && authReady && (!user || isAdmin || emailAllowlistOk !== null);
  const canAccess = !!user && (isAdmin || emailAllowlistOk === true);

  return { canAccess, gateReady, authReady, user };
}
