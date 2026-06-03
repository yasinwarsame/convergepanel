import posthog from "posthog-js";

/**
 * Track an analytics event via PostHog.
 * Events are buffered automatically if PostHog hasn't initialised yet.
 *
 * @param eventName - e.g. "panel_run", "login", "signup"
 * @param props     - Optional properties e.g. { plan: "free", models: [...] }
 */
export function trackEvent(eventName: string, props?: Record<string, any>): void {
  if (typeof window === "undefined") return;
  posthog.capture(eventName, props);
}

