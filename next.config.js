/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  
  /**
   * Content Security Policy (CSP) Headers
   * 
   * Configure CSP to be secure while allowing Next.js and third-party services to function properly.
   * 
   * IMPORTANT: 'unsafe-eval' is ONLY enabled in development mode for Next.js hot reload.
   * In production, CSP is strict without unsafe-eval to prevent XSS attacks.
   * 
   * Why 'unsafe-eval' in dev:
   * - Next.js development mode uses webpack's hot module replacement (HMR)
   * - HMR requires eval() to dynamically update modules
   * - This is safe in dev because code is only running locally
   * 
   * Third-party services allowed:
   * - Stripe: js.stripe.com (for Stripe.js payment forms)
   * - Firebase: *.firebaseio.com, *.googleapis.com (for Firebase SDK)
   * - AI APIs: api.openai.com, api.anthropic.com, api.x.ai, api.perplexity.ai
   * 
   * To remove 'unsafe-eval' completely:
   * 1. Ensure no client-side code uses eval(), new Function(), or string-based setTimeout/setInterval
   * 2. Test that Next.js production build works without it
   * 3. Remove 'unsafe-eval' from dev CSP (may break hot reload)
   */
  async headers() {
    const isDev = process.env.NODE_ENV === 'development';
    
    // Build CSP directives
    // In development: allow unsafe-eval for Next.js HMR
    // In production: strict CSP without unsafe-eval
    const scriptSrcParts = [
      "'self'",
      // Stripe.js for payment forms
      "https://js.stripe.com",
      // Firebase SDK
      "https://*.firebaseio.com",
      "https://*.googleapis.com",
    ];
    
    if (isDev) {
      // Development: allow unsafe-eval for Next.js hot reload
      // WARNING: This is only safe in development. Never enable in production.
      scriptSrcParts.push("'unsafe-eval'");
      scriptSrcParts.push("'unsafe-inline'"); // Next.js dev mode inline scripts
    }
    
    const scriptSrc = scriptSrcParts.join(' ');
    
    // Style sources
    const styleSrcParts = ["'self'"];
    if (isDev) {
      // Development: allow inline styles for Next.js dev mode
      styleSrcParts.push("'unsafe-inline'");
    }
    const styleSrc = styleSrcParts.join(' ');
    
    // Build complete CSP string
    const cspDirectives = [
      `default-src 'self'`,
      `script-src ${scriptSrc}`,
      `style-src ${styleSrc}`,
      `img-src 'self' data: https:`,
      `font-src 'self' data:`,
      // API connections
      `connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://api.openai.com https://api.anthropic.com https://api.x.ai https://api.perplexity.ai https://api.stripe.com`,
      // Stripe iframes for payment forms
      `frame-src 'self' https://js.stripe.com https://hooks.stripe.com`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `form-action 'self' https://js.stripe.com`,
      `frame-ancestors 'none'`,
      // Upgrade insecure requests in production
      ...(isDev ? [] : [`upgrade-insecure-requests`]),
    ];
    
    return [
      {
        // Apply to all routes
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspDirectives.join('; '),
          },
        ],
      },
    ];
  },
}

module.exports = nextConfig


