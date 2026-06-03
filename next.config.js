/** @type {import('next').NextConfig} */
const { withSentryConfig } = require("@sentry/nextjs");

const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  experimental: {
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
      "worker-src 'self' blob: https://cdn.jsdelivr.net",
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
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
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
  tunnelRoute: "/monitoring",
  automaticVercelMonitors: true,
  treeshake: {
    removeDebugLogging: true,
  },
});
