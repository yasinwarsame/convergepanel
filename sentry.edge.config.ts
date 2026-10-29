// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn } from "./lib/telemetry/sentryDsn";

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
  });
}
