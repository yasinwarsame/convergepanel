"use client";

/**
 * Privacy remediation PR #329 R3 (owner D4 / D5) — rendered once in the root
 * layout, inside AuthProvider. On every navigation it moves user-authored
 * text out of the URL into the tab-scoped hand-offs (lib/client/verifyPrefill.ts)
 * and rewrites the address bar without it:
 *   - `/verify#text=…` (extension, current) and `/verify?text=…` (legacy);
 *   - `/?tab=verify&claim=…` and `/?tab=research&q=…` (legacy links).
 *
 * It runs in a LAYOUT effect: React runs every layout effect of a commit
 * before any passive effect, so this happens before the PostHog pageview,
 * before the main app's reader effect and before any other page effect reads
 * the URL. (Telemetry is additionally protected by the boundary sanitizer; the
 * server never sees a fragment.) Renders nothing; never logs.
 */
import { useEffect, useLayoutEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { capturePendingVerifyInput, migrateLegacyAppHandoffLink, tabStorage } from "@/lib/client/verifyPrefill";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function migrateContentFromCurrentUrl(currentUid: string | null): void {
  if (typeof window === "undefined") return;
  const env = { location: window.location, history: window.history, storage: tabStorage(), currentUid };
  if (window.location.pathname === "/verify") capturePendingVerifyInput(env);
  else migrateLegacyAppHandoffLink(env);
}

export function ContentHandoffMigrator() {
  const { authReady, user } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const uid = authReady ? user?.uid ?? null : null;

  useIsomorphicLayoutEffect(() => {
    migrateContentFromCurrentUrl(uid);
    // `uid` deliberately not a dependency: a capture is bound when it happens; AuthProvider rebinds on sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  useEffect(() => {
    if (typeof window.addEventListener !== "function") return;
    const onHash = () => migrateContentFromCurrentUrl(uid);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [uid]);

  return null;
}
