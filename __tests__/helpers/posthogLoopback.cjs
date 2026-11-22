/**
 * TEST-ONLY preload (analytics proxy containment). Loaded into the `next start` process the real-build harness
 * spawns, never by application code. Redirects the app's outbound fetch() calls to the two PostHog hosts to a
 * loopback echo server (`CP_TEST_POSTHOG_LOOPBACK_PORT`), so the REAL route handler runs and the headers that would
 * reach PostHog are observed without any network egress. Request headers and body are passed through unchanged.
 */
"use strict";
const port = process.env.CP_TEST_POSTHOG_LOOPBACK_PORT;
if (port && typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  const map = [
    ["https://us.i.posthog.com/", `http://127.0.0.1:${port}/__api/`],
    ["https://us-assets.i.posthog.com/", `http://127.0.0.1:${port}/__assets/`],
  ];
  globalThis.fetch = function loopbackFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    if (typeof url === "string") {
      for (const [from, to] of map) if (url.startsWith(from)) return realFetch(to + url.slice(from.length), init);
    }
    return realFetch(input, init);
  };
}
