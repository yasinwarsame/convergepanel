/**
 * TEST-ONLY default-deny routing for the production-build harness
 * (`__tests__/telemetryNextAppR4.spec.ts`; PR #329 R5, R4 review MINOR-2).
 *
 *   "app"            the local app under test (same loopback origin): continued to it.
 *   "sentry-tunnel"  `/monitoring` — the app server would FORWARD it to real Sentry ingest, so it is answered by the
 *                    harness and counted as a Sentry request for leak checks; never continued.
 *   "posthog"        `/ingest/*` — the app's rewrite would forward to PostHog; answered by the harness.
 *   "posthog-static" `/ingest/static|array/*` — served from node_modules/posthog-js by the harness.
 *   "deny"           everything else (any other host, port or scheme): aborted.
 */
export type RouteDecision = "app" | "sentry-tunnel" | "posthog" | "posthog-static" | "deny";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True only for an http(s) URL whose host is loopback. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname);
}

export function decideRoute(raw: string, baseOrigin: string): RouteDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "deny";
  }
  if (!isLoopbackUrl(raw) || url.origin !== new URL(baseOrigin).origin) return "deny";
  const p = url.pathname;
  if (p === "/monitoring" || p.startsWith("/monitoring/")) return "sentry-tunnel";
  if (p.startsWith("/ingest/static/") || p.startsWith("/ingest/array/")) return "posthog-static";
  if (p === "/ingest" || p.startsWith("/ingest/")) return "posthog";
  return "app";
}
