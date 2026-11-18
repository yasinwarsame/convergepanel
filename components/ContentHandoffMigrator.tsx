"use client";

/**
 * Privacy remediation PR #329 R3 (owner D4 / D5), R4 — rendered once in the
 * root layout, inside AuthProvider. On every SOFT navigation and hash change it
 * moves user-authored text out of the URL into the tab-scoped hand-offs
 * (lib/client/verifyPrefill.ts) and rewrites the address bar without it:
 *   - `/verify#text=…` (extension, current) and `/verify?text=…` (legacy);
 *   - `/?tab=verify&claim=…` and `/?tab=research&q=…` (legacy links).
 *
 * R4 correction: this component is NOT what protects telemetry on a full page
 * load. It sits in a Suspense boundary that can hydrate after PostHog's init
 * effect, so the R3 claim "runs before PostHog" was false for hard loads. The
 * URL is now made clean synchronously before any SDK initializes
 * (lib/privacy/preTelemetryUrlScrub.ts, called first in instrumentation-client.ts
 * and immediately before posthog.init). This component covers navigations
 * inside an already-running document. Renders nothing; never logs.
 */
import { useEffect, useLayoutEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { migrateContentFromUrl, tabStorage } from "@/lib/client/verifyPrefill";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function migrateContentFromCurrentUrl(currentUid: string | null): void {
  if (typeof window === "undefined") return;
  migrateContentFromUrl({ location: window.location, history: window.history, storage: tabStorage(), currentUid });
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
