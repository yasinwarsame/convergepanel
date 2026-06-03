import "server-only";
import { PostHog } from "posthog-node";

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog {
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
