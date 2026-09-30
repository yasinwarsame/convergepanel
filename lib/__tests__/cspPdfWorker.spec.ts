/**
 * R-16 — CSP disposition for the self-hosted pdf.js worker.
 *
 * Reads the real header produced by next.config.js. The worker is now served
 * from 'self', so no directive may name jsDelivr. The whole policy is pinned so
 * the fix cannot have been achieved — now or later — by widening any directive.
 */
const nextConfig = require("../../next.config.js") as {
  headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
};

async function csp(): Promise<Map<string, string[]>> {
  const rules = await nextConfig.headers();
  const all = rules.find((r) => r.source === "/:path*");
  const value = all?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
  if (!value) throw new Error("no CSP header on /:path*");
  const entries = value.split(";").map((d) => {
    const [name, ...sources] = d.trim().split(/\s+/);
    return [name, sources] as [string, string[]];
  });
  const map = new Map(entries);
  // A repeated directive would be collapsed by the Map and escape the pin below.
  if (map.size !== entries.length) throw new Error("duplicate CSP directive");
  return map;
}

describe("CSP after R-16", () => {
  it("worker-src allows only our origin and blob:", async () => {
    expect((await csp()).get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("no directive references jsDelivr", async () => {
    for (const [name, sources] of await csp()) {
      expect({ name, jsdelivr: sources.filter((s) => /jsdelivr/i.test(s)) }).toEqual({ name, jsdelivr: [] });
    }
  });

  it("the complete policy is exactly the reviewed one (R-16 removed jsDelivr from worker-src, nothing else changed)", async () => {
    expect(Object.fromEntries(await csp())).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:", "https://js.stripe.com", "https://*.firebaseio.com", "https://*.googleapis.com", "https://apis.google.com", "https://accounts.google.com", "https://*.gstatic.com"],
      "script-src-elem": ["'self'", "'unsafe-inline'", "blob:", "https://js.stripe.com", "https://*.firebaseio.com", "https://*.googleapis.com", "https://apis.google.com", "https://accounts.google.com", "https://*.gstatic.com"],
      "worker-src": ["'self'", "blob:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "https:"],
      "media-src": ["'self'", "blob:"],
      "font-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://*.firebaseio.com", "https://*.googleapis.com", "https://api.openai.com", "https://api.anthropic.com", "https://api.x.ai", "https://api.perplexity.ai", "https://api.stripe.com", "https://generativelanguage.googleapis.com", "https://us.i.posthog.com", "https://eu.i.posthog.com", "https://*.posthog.com", "https://*.sentry.io", "https://*.ingest.sentry.io"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://hooks.stripe.com", "https://accounts.google.com"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'", "https://js.stripe.com"],
      "frame-ancestors": ["'none'"],
    });
  });
});
