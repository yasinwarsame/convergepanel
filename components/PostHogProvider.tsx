"use client";

import posthog from "posthog-js";
import type { BeforeSendFn, CaptureResult } from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";
import { sanitizeUrl, sanitizeUrlsInText, scrubUrlFields } from "@/lib/privacy/sanitizeUrl";
import { redactExceptionValue } from "@/lib/privacy/exceptionText";
import { scrubUrlBeforeTelemetry } from "@/lib/privacy/preTelemetryUrlScrub";

/**
 * Round 2 (review MINOR-1): query parameters PostHog's own personal-data
 * masking must blank in every URL it stores or sends outside `before_send`
 * (`$initial_person_info`, `$client_session_props`, the `/flags` request's
 * `$initial_current_url` / `$current_url` person properties).
 */
export const POSTHOG_CONTENT_PARAMS = ["text", "claim", "q", "question", "redirect", "next", "selectedText"];

/** `{ u: url, r: referrer }` (PostHog's compact person-info shape) — sanitized in place. */
function scrubCompactPersonInfo(info: unknown): void {
  if (!info || typeof info !== "object") return;
  const rec = info as Record<string, unknown>;
  for (const k of ["u", "r"]) if (typeof rec[k] === "string") rec[k] = sanitizeUrl(rec[k] as string);
}

function scrubExceptionList(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (item && typeof item === "object" && typeof (item as any).value === "string") {
      (item as any).value = redactExceptionValue(String((item as any).type ?? ""), (item as any).value);
    }
  }
}

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
    scrubExceptionList(event.properties.$exception_list);
    if (typeof event.properties.$exception_message === "string") {
      event.properties.$exception_message = redactExceptionValue(
        String(event.properties.$exception_type ?? ""),
        event.properties.$exception_message
      );
    }
    scrubCompactPersonInfo(event.properties.$initial_person_info);
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
  if (event.$set_once) {
    scrubCompactPersonInfo((event.$set_once as Record<string, unknown>).$initial_person_info);
    scrubUrlFields(event.$set_once);
  }
  return event;
};

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host =
      process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
    if (!key) return;
    // PR #329 R4 (review MAJOR-1): posthog.init records location.href and
    // document.referrer into `$initial_person_info` and sends them with the
    // `/flags` request — both bypass `before_send`. The URL is made clean HERE,
    // synchronously, immediately before init; no effect ordering is relied on.
    scrubUrlBeforeTelemetry();
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
      // Round 2 (review MINOR-1): PostHog stores the raw landing URL in
      // `$initial_person_info` / `$client_session_props` and sends
      // `$initial_current_url` with the `/flags` request — paths that bypass
      // `before_send`. Its own personal-data masking blanks these parameters
      // in all of them.
      mask_personal_data_properties: true,
      custom_personal_data_properties: POSTHOG_CONTENT_PARAMS,
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
