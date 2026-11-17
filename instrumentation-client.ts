// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn } from "./lib/telemetry/sentryDsn";
import { scrubReplayRecordingEvent, scrubSentryBreadcrumb, scrubSentryEvent } from "./lib/privacy/sentryScrub";

// Telemetry isolation: only an explicitly configured DSN is used. Missing or
// empty means browser Sentry is never initialized (see lib/telemetry/sentryDsn.ts).
// The literal `process.env.NEXT_PUBLIC_SENTRY_DSN` reference is required for
// Next.js build-time inlining.
const dsn = resolveSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);

if (dsn !== undefined) {
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
        // No network request/response bodies or headers in replays.
        networkDetailAllowUrls: [],
        // Recording events (rrweb meta `href`, DOM `href` attributes,
        // navigation/fetch performance spans) bypass beforeSend and event
        // processors entirely — scrub their URLs here.
        beforeAddRecordingEvent: scrubReplayRecordingEvent,
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
