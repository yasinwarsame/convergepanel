// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn } from "./lib/telemetry/sentryDsn";
import { scrubSentryBreadcrumb, scrubSentryEvent, scrubSentryLogOrMetric, scrubSentrySpan } from "./lib/privacy/sentryScrub";

// Telemetry isolation: only an explicitly configured SENTRY_DSN is used. Missing
// or empty means Sentry is never initialized; there is no hard-coded fallback
// (see lib/telemetry/sentryDsn.ts).
const dsn = resolveSentryDsn(process.env.SENTRY_DSN);

if (dsn !== undefined) {
  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === "production",
    tracesSampleRate: 0.1,
    enableLogs: true,
    // Privacy remediation (2026-11-17 audit): pinned explicitly rather than
    // relying on the SDK default. No IP, cookies or request bodies.
    sendDefaultPii: false,
    // Every outgoing error / transaction / breadcrumb passes through the one
    // shared URL sanitizer (lib/privacy/sanitizeUrl.ts): query values outside
    // the allowlist are redacted, fragments dropped, request bodies, cookies
    // and auth headers removed (lib/privacy/sentryScrub.ts).
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
    // Structural hardening: spans, logs and metrics skip the hooks above; they are URL-sanitized the same way.
    beforeSendSpan: (span) => scrubSentrySpan(span),
    beforeSendLog: (log) => scrubSentryLogOrMetric(log),
    beforeSendMetric: (metric) => scrubSentryLogOrMetric(metric),
  });
}
