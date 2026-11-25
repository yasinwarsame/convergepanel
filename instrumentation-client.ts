// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn } from "./lib/telemetry/sentryDsn";
import {
  REPLAY_MASKED_ATTRIBUTES,
  scrubReplayRecordingEvent,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentryLogOrMetric,
  scrubSentrySpan,
} from "./lib/privacy/sentryScrub";
import { scrubUrlBeforeTelemetry } from "./lib/privacy/preTelemetryUrlScrub";
import { scrubSentryEnvelope } from "./lib/privacy/sentryEnvelopeScrub";
import { isTelemetryFreeDocument } from "./lib/telemetry/telemetryFreeDocument";

type FetchTransport = ReturnType<typeof Sentry.makeFetchTransport>;

// PR #329 R4/R5 (review MAJOR-1): FIRST, before any SDK reads the URL. Moves claim
// text (`#text=`, legacy `?text=` / `?claim=` / `?q=`, and the same nested in
// `?redirect=` / `?next=`) out of the address bar and drops every other
// content-bearing parameter — fail closed when sessionStorage is unusable — and
// sanitizes a content-bearing referrer. Production builds prepend this file to the `main-app` entry, so it
// runs before React hydrates and therefore before PostHog's init effect too.
scrubUrlBeforeTelemetry();

// Private advisory GHSA-655j-5f43-92pw: a document loaded as the workspace invitation
// acceptance link never initializes Sentry, for its whole lifetime. The browser keeps the
// original URL (credential fragment included) in the navigation timing entry, which the
// SDK reads for pageload and Replay spans; scrubbing the address bar cannot change it.
// See lib/telemetry/telemetryFreeDocument.ts.
const telemetryFreeDocument = isTelemetryFreeDocument();

// Telemetry isolation: only an explicitly configured DSN is used. Missing or
// empty means browser Sentry is never initialized (see lib/telemetry/sentryDsn.ts).
// The literal `process.env.NEXT_PUBLIC_SENTRY_DSN` reference is required for
// Next.js build-time inlining.
const dsn = resolveSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);

if (dsn !== undefined && !telemetryFreeDocument) {
  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === "production",
    integrations: [
      Sentry.replayIntegration({
        // Privacy remediation (2026-11-17 audit): masking pinned explicitly
        // instead of relying on SDK defaults — claim text and model output
        // are rendered on screen, so no text, input or media is recorded.
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        // Structural hardening: DOM snapshots bypass every hook, so URL-bearing attributes (link targets with
        // workspace / run ids, image sources, form actions) are masked when recorded.
        maskAttributes: REPLAY_MASKED_ATTRIBUTES,
        // No network request/response bodies or headers in replays.
        networkDetailAllowUrls: [],
        // Applies to Replay CUSTOM events only (breadcrumb / performance-span
        // payloads, e.g. `navigation.push` `data.from|to|previous`). The rrweb
        // meta event `href` and the full/incremental DOM snapshots do NOT pass
        // through this hook (R5 correction): their only protection is that the
        // URL is already clean when Sentry.init starts Replay — see
        // scrubUrlBeforeTelemetry() above.
        beforeAddRecordingEvent: scrubReplayRecordingEvent,
        // Structural hardening: the recording reaches the transport as JSON so the meta event `href` (the raw page
        // URL, which no hook can reach) and DOM URL attributes are sanitized at transmission
        // (lib/privacy/sentryEnvelopeScrub.ts). A compressed recording would be dropped there, not sent.
        useCompression: false,
      }),
    ],
    tracesSampleRate: 0.1,
    enableLogs: true,
    replaysSessionSampleRate: 0.05,
    replaysOnErrorSampleRate: 1.0,
    // Privacy remediation (2026-11-17 audit): was `true`, which attached the
    // visitor IP and user context to every event. No code path depends on it
    // (Sentry.setUser is never called); errors, traces and replays still flow.
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: scrubSentryBreadcrumb,
    // Structural hardening: standalone spans (INP / web vitals), logs and metrics skip the hooks above.
    beforeSendSpan: (span) => scrubSentrySpan(span),
    beforeSendLog: (log) => scrubSentryLogOrMetric(log),
    beforeSendMetric: (metric) => scrubSentryLogOrMetric(metric),
    // Structural hardening: the SDK's own transport sends `Referrer-Policy: strict-origin`; envelopes (events,
    // transactions and Replay segments, through the `/monitoring` tunnel) carry no Referer at all.
    transportOptions: { fetchOptions: { referrerPolicy: "no-referrer" } },
    // Containment (review MINOR-1): the tunnel is set here, not by withSentryConfig's `tunnelRoute` (which also
    // registered external rewrites). app/monitoring/route.ts forwards the envelope body with Content-Type only.
    tunnel: "/monitoring",
    // Structural hardening: the transmission boundary. Every envelope (events, transactions, spans, Replay segments,
    // logs) is URL-sanitized immediately before the fetch transport serializes it (lib/privacy/sentryEnvelopeScrub.ts).
    transport: (transportOptions: Parameters<typeof Sentry.makeFetchTransport>[0]): FetchTransport => {
      const inner = Sentry.makeFetchTransport(transportOptions);
      return {
        send: (envelope) => inner.send(scrubSentryEnvelope(envelope)),
        flush: (timeout) => inner.flush(timeout),
      };
    },
  });
}

/**
 * Team Workspace Invitations, Phase 8D.3.1 — URL-fragment redaction,
 * generalized by the 2026-11-17 privacy remediation: the processor now runs
 * the shared scrubber (lib/privacy/sentryScrub.ts → lib/privacy/sanitizeUrl.ts),
 * which drops the fragment AND redacts every query value outside the
 * allowlist (claim / question text arrives as `?text=`, `?claim=`, `?q=`,
 * and nested in `?redirect=`).
 *
 * A bearer-bearing acceptance link (`/workspace-invitations/accept
 * #invitationId=...&token=...`) never reaches the server, but Session
 * Replay reads `location.hash` directly into its own `replay_event`
 * metadata (`initialUrl`/`urls`) — both at Replay-start (a direct page
 * load) AND on every subsequent History API navigation while Replay is
 * already running (an SPA navigation into the route from elsewhere).
 * `beforeSend`/`beforeSendTransaction` cannot reach this: `replay_event`s
 * are built by `prepareReplayEvent()`, which calls the shared
 * `core.prepareEvent()` utility directly and never routes through
 * `client._captureEvent()`/`_processEvent()`, the only place those hooks
 * fire (and `beforeSend` is additionally gated behind `isErrorEvent()`
 * there, excluding replay/transaction events regardless).
 *
 * `Sentry.addEventProcessor()` is the one hook both the ordinary-event and
 * replay-event pipelines share — `core.prepareEvent()` unconditionally
 * runs `notifyEventProcessors()` for every event type before an envelope
 * is built. It also runs at SEND time (once per Replay segment flush), not
 * capture time, so it correctly scrubs a URL that was captured at any
 * earlier point in the session — closing the SPA-navigation gap that an
 * init-time, route-conditional check alone could not. Deliberately NOT
 * mitigated via `replay.stop()` after arrival: `stop()` is documented to
 * flush pending recording data before ending the session (either via an
 * explicit forceFlush or an independent debounced timer), so it can still
 * transmit the sensitive URL it was meant to suppress.
 */
Sentry.addEventProcessor((event) => scrubSentryEvent(event));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
