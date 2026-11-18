/**
 * Test-only browser entry for `__tests__/telemetryRealSdkBrowserR4.spec.ts`.
 *
 * Mirrors the production load order of the Next.js app:
 *   1. `instrumentation-client.ts` — Sentry's webpack plugin PREPENDS it to the
 *      `main-app` entry in production builds, so it runs before React hydrates;
 *   2. the root layout's `PostHogProvider`, whose effect calls `posthog.init`.
 * The content hand-off migrator is deliberately NOT rendered: the URL must
 * already be clean when the SDKs initialize, without relying on any effect order.
 *
 * `window.__cpProbe` exposes the two SDK clients so the spec can send POSITIVE
 * CONTROL events (proving that its request instrumentation and body decoding
 * would see a sentinel if one were sent).
 */
import "@/instrumentation-client";
import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { PostHogProvider } from "@/components/PostHogProvider";

(window as any).__cpProbe = { posthog, Sentry };

const el = document.createElement("div");
document.body.appendChild(el);
createRoot(el).render(createElement(PostHogProvider, null, createElement("main", null, "probe")));
