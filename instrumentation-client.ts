// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://0d1785e8cafc519f0e99ecc4501ffc06@o4511503698624512.ingest.us.sentry.io/4511503843065856",
  enabled: process.env.NODE_ENV === "production",
  integrations: [Sentry.replayIntegration()],
  tracesSampleRate: 0.1,
  enableLogs: true,
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,
  sendDefaultPii: true,
  beforeBreadcrumb: stripFragmentFromBreadcrumb,
});

/**
 * Team Workspace Invitations, Phase 8D.3.1 — URL-fragment redaction.
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
function stripUrlFragment(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/#.*$/, "") : value;
}

function stripFragmentFromBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  if (!breadcrumb.data) return breadcrumb;
  const data = { ...breadcrumb.data };
  for (const key of ["url", "to", "from"]) {
    if (key in data) data[key] = stripUrlFragment(data[key]);
  }
  return { ...breadcrumb, data };
}

Sentry.addEventProcessor((event) => {
  const withReplayFields = event as typeof event & { urls?: unknown; initialUrl?: unknown };

  if (Array.isArray(withReplayFields.urls)) {
    withReplayFields.urls = withReplayFields.urls.map(stripUrlFragment);
  }
  if (typeof withReplayFields.initialUrl === "string") {
    withReplayFields.initialUrl = stripUrlFragment(withReplayFields.initialUrl);
  }
  if (event.request?.url) {
    event.request.url = stripUrlFragment(event.request.url) as string;
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(stripFragmentFromBreadcrumb);
  }

  return event;
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
