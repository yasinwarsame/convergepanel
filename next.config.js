/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },

  experimental: {
    serverComponentsExternalPackages: [
      "firebase-admin",
      "google-auth-library",
      "gtoken",
      "gaxios",
      "jws",
      "jsonwebtoken"
    ],
  },

  async headers() {
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://accounts.google.com https://*.gstatic.com",
      "script-src-elem 'self' 'unsafe-inline' https://js.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://accounts.google.com https://*.gstatic.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://api.openai.com https://api.anthropic.com https://api.x.ai https://api.perplexity.ai https://api.stripe.com https://generativelanguage.googleapis.com",
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://accounts.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://js.stripe.com",
      "frame-ancestors 'none'",
    ];

    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: cspDirectives.join("; ") }],
      },
    ];
  },
};

module.exports = nextConfig;
