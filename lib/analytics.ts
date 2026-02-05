/**
 * Analytics Event Tracking
 * 
 * This module provides a lightweight analytics abstraction layer.
 * Currently, it's a stub that logs events to the console for development.
 * 
 * TODO: Integrate a real analytics provider (e.g., Plausible, PostHog, Mixpanel)
 * when ready. This single integration point makes it easy to swap providers
 * without changing code throughout the app.
 * 
 * Usage:
 *   import { trackEvent } from "@/lib/analytics";
 *   trackEvent("panel_run", { models: ["chatgpt", "claude"], plan: "free" });
 */

/**
 * Track an analytics event
 * 
 * Logs the event to the console in development. In production, this will
 * be replaced with calls to a real analytics service.
 * 
 * @param eventName - Name of the event (e.g., "panel_run", "login", "signup")
 * @param props - Optional event properties (e.g., { plan: "free", models: [...] })
 */
export function trackEvent(eventName: string, props?: Record<string, any>): void {
  // TODO: Replace with real analytics provider integration
  // Example providers to consider:
  // - Plausible (privacy-focused, simple)
  // - PostHog (open-source, feature-rich)
  // - Mixpanel (powerful, enterprise-focused)
  
  // For now, log to console so we can see event flow during development
  if (process.env.NODE_ENV === "development") {
    console.log("[analytics]", eventName, props || {});
  }
  
  // In production, you would do something like:
  // if (typeof window !== "undefined" && window.plausible) {
  //   window.plausible(eventName, { props });
  // }
}

