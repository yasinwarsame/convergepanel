"use client";

import posthog from "posthog-js";
import type { BeforeSendFn, CaptureResult } from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";
import { sanitizeUrl, sanitizeUrlsInText, scrubUrlFields } from "@/lib/privacy/sanitizeUrl";

function PageviewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Privacy remediation (2026-11-17 audit): the query string can carry claim
    // / question text (`?text=`, `?claim=`, `?q=`, `?redirect=/verify?text=`).
    // Sanitized at the source here AND again in `before_send` below.
    const url = sanitizeUrl(
      window.location.origin +
        pathname +
        (searchParams.toString() ? `?${searchParams}` : "")
    );
    posthog.capture("$pageview", { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}

/**
 * Team Workspace Invitations, Phase 8D.3.1 (fragment redaction), generalized
 * by the 2026-11-17 privacy remediation.
 *
 * `before_send` (not the deprecated `sanitize_properties`) is PostHog's
 * final gate before ANY event — of any type: pageview, pageleave,
 * autocapture, exception, web vitals, heatmaps — is enqueued for
 * transmission, per `processBeforeEnqueue`'s own documented role. That
 * unconditional, per-event coverage is why this hook, not a narrower one, is
 * the mitigation point.
 *
 * Every URL-bearing property (`$current_url`, `$referrer`,
 * `$initial_current_url`, `$session_entry_url`, `attr__href`, ... — anywhere
 * in `properties`, `$set` or `$set_once`) passes through the one shared
 * sanitizer (lib/privacy/sanitizeUrl.ts): fragment dropped, every query value
 * outside the allowlist replaced with `[redacted]`. Heatmap data is keyed by
 * URL, so its keys are sanitized too.
 */
const beforeSend: BeforeSendFn = (event: CaptureResult | null) => {
  if (!event) return event;
  if (event.properties) {
    scrubUrlFields(event.properties);
    if (typeof event.properties.$elements_chain === "string") {
      event.properties.$elements_chain = sanitizeUrlsInText(event.properties.$elements_chain);
    }
    const heatmap = event.properties.$heatmap_data;
    if (heatmap && typeof heatmap === "object" && !Array.isArray(heatmap)) {
      const scrubbed: Record<string, unknown> = {};
      for (const [url, data] of Object.entries(heatmap as Record<string, unknown>)) {
        scrubbed[sanitizeUrl(url)] = data;
      }
      event.properties.$heatmap_data = scrubbed;
    }
  }
  if (event.$set) scrubUrlFields(event.$set);
  if (event.$set_once) scrubUrlFields(event.$set_once);
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
      // Privacy remediation (2026-11-17 audit). Autocapture stays ON (click
      // analytics keep working) but never records element text or attributes:
      // rendered claims / model output must not ride along as `$el_text`, and
      // links such as `/signup?redirect=/verify?text=...` must not ride along
      // as `attr__href`.
      mask_all_text: true,
      mask_all_element_attributes: true,
      // Session recording is OFF in code regardless of the PostHog project
      // setting: the screen is the claim and the model output. Re-enabling is
      // an owner decision; the masking below is pinned so a re-enable is safe
      // by default.
      disable_session_recording: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        recordHeaders: false,
        recordBody: false,
      },
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
