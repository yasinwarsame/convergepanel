"use client";

import posthog from "posthog-js";
import type { BeforeSendFn, CaptureResult } from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";

function PageviewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url =
      window.location.origin +
      pathname +
      (searchParams.toString() ? `?${searchParams}` : "");
    posthog.capture("$pageview", { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}

/**
 * Team Workspace Invitations, Phase 8D.3.1 — strips a URL fragment from any
 * string property PostHog is about to transmit. `$current_url` is the known
 * URL-bearing property (manual pageviews already exclude the hash — see
 * `PageviewTracker` below — but autocapture/exception events populate it
 * independently), scrubbed defensively regardless of source.
 */
function stripUrlFragment(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/#.*$/, "") : value;
}

/**
 * `before_send` (not the deprecated `sanitize_properties`) is PostHog's
 * final gate before ANY event — of any type: pageview, autocapture,
 * exception — is enqueued for transmission, per `processBeforeEnqueue`'s
 * own documented role. That unconditional, per-event coverage is why this
 * hook, not a narrower one, is the mitigation point here.
 */
const beforeSend: BeforeSendFn = (event: CaptureResult | null) => {
  if (event && event.properties && "$current_url" in event.properties) {
    event.properties.$current_url = stripUrlFragment(event.properties.$current_url);
  }
  return event;
};

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host =
      process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
    if (!key) return;
    posthog.init(key, {
      api_host: "/ingest",
      ui_host: host,
      capture_pageview: false,
      capture_pageleave: true,
      capture_exceptions: true,
      before_send: beforeSend,
      loaded: (ph) => {
        if (process.env.NODE_ENV === "development") ph.debug();
      },
    });
  }, []);

  return (
    <PHProvider client={posthog}>
      <Suspense>
        <PageviewTracker />
      </Suspense>
      {children}
    </PHProvider>
  );
}
