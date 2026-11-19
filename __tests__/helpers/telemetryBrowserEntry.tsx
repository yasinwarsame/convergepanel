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

// R5: what posthog-js reads at init (`$initial_person_info`, the `/flags` request) is the address bar and the referrer
// at the moment `posthog.init` runs. Record both at exactly that moment (the provider calls init in its effect).
const realInit = posthog.init.bind(posthog);
(window as any).__cpAtInit = [];
(posthog as any).init = (...args: Parameters<typeof posthog.init>) => {
  (window as any).__cpAtInit.push({ sdk: "posthog", href: window.location.href, referrer: document.referrer });
  return realInit(...args);
};

const el = document.createElement("div");
document.body.appendChild(el);
createRoot(el).render(createElement(PostHogProvider, null, createElement("main", null, "probe")));
