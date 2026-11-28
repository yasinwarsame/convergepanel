import "server-only";
import { PostHog } from "posthog-node";
import { serverAnalyticsEnabled } from "@/lib/telemetry/analyticsEnablement";

let posthogClient: PostHog | null = null;

/**
 * Throws outside Vercel Production (ZCA R2 Phase B; lib/telemetry/analyticsEnablement.ts). Every caller wraps the
 * call in try/catch and treats analytics as non-critical, so outside Production nothing is sent.
 */
export function getPostHogClient(): PostHog {
  if (!serverAnalyticsEnabled()) {
    throw new Error("product analytics is disabled outside Vercel Production");
  }
  if (!posthogClient) {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    if (!key) {
      throw new Error("NEXT_PUBLIC_POSTHOG_KEY is not set");
    }
    posthogClient = new PostHog(key, {
      host,
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}
