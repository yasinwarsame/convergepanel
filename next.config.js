/** @type {import('next').NextConfig} */
const { withSentryConfig } = require("@sentry/nextjs");

// I-1 M-2: a Production build with missing/invalid browser Firebase configuration or deployment identity fails HERE,
// before any page is built (no-op for Preview, development, local and CI builds).
require("./lib/firebase/productionBuildConfigGuard").assertProductionBuildConfig(process.env);

// PR #295 build boundary: the SYSTEM_ADMIN claim tool must never be resolved, bundled or traced by deployed code.
// Enforced inside webpack's own resolver on every compiler (lib/security/buildBoundary.js); the post-build
// checker scripts/security/check-build-boundary.js independently verifies the manifests, traces and chunks.
const { withBuildBoundary } = require("./lib/security/buildBoundary");

const nextConfig = {
  reactStrictMode: true,
  webpack: (config, ctx) => withBuildBoundary(config, ctx),
  skipTrailingSlashRedirect: true,
  // Containment (PR #335 Production finding): the PostHog proxy is NOT a rewrite any more. An external rewrite
  // forwards the browser's request headers (cookies included), and Vercel matched case variants the build marked
  // case-sensitive. `/ingest/*` is served by app/ingest/[...path]/route.ts, which builds the upstream request from
  // an explicit header allowlist (lib/telemetry/analyticsProxy.ts).
  async rewrites() {
    return [];
  },
  experimental: {
    // Structural hardening (GHSA-655j-5f43-92pw follow-up): rewrites match case-insensitively by default, so
    // `/INGEST/...` and `/Monitoring?o=&p=` reached the PostHog proxy and the SDK's Sentry tunnel rewrite (which
    // forwards request headers, cookies included) past the case-sensitive middleware and the `/monitoring` route.
    // Rewrites, redirects and header rules now match the exact case the app uses. NOTE: Vercel's routing was
    // observed NOT to honour this for rewrites in Production; it is kept as defence in depth only. The enforced
    // controls are the canonical-path check in middleware.ts and in the proxy route handler.
    caseSensitiveRoutes: true,
    serverActions: {
      bodySizeLimit: "12mb",
    },
    serverComponentsExternalPackages: [
      "firebase-admin",
      "google-auth-library",
      "gtoken",
      "gaxios",
      "jws",
      "jsonwebtoken",
      "sharp",
    ],
    instrumentationHook: true,
  },

  async headers() {
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://js.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://accounts.google.com https://*.gstatic.com",
      "script-src-elem 'self' 'unsafe-inline' blob: https://js.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://accounts.google.com https://*.gstatic.com",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://api.openai.com https://api.anthropic.com https://api.x.ai https://api.perplexity.ai https://api.stripe.com https://generativelanguage.googleapis.com https://us.i.posthog.com https://eu.i.posthog.com https://*.posthog.com https://*.sentry.io https://*.ingest.sentry.io",
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://accounts.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://js.stripe.com",
      "frame-ancestors 'none'",
    ];

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: cspDirectives.join("; ") },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Structural hardening (GHSA-655j-5f43-92pw follow-up): `strict-origin` sends only the origin on
          // same-origin requests too. `strict-origin-when-cross-origin` sent the full URL (path, query) to our own
          // endpoints, including `/ingest` and `/monitoring`, which forward request headers to PostHog / Sentry.
          // Cross-origin behaviour is unchanged (origin only; nothing on HTTPS -> HTTP). No server code reads Referer.
          { key: "Referrer-Policy", value: "strict-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

module.exports = withSentryConfig(nextConfig, {
  org: "convergepanelcom",
  project: "javascript-nextjs",
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // Containment (review MINOR-1): no `tunnelRoute`. It registered EXTERNAL rewrites from `/monitoring?o=&p=` to a
  // Sentry ingest host chosen by the query (any org id), which forward request headers (cookies included) if
  // ever matched. The client sets `tunnel: "/monitoring"` itself (instrumentation-client.ts) and
  // app/monitoring/route.ts is the only tunnel: it forwards the envelope body with Content-Type only.
  treeshake: {
    removeDebugLogging: true,
  },
  webpack: {
    automaticVercelMonitors: true,
  },
});
