/**
 * R-16 — CSP disposition for the self-hosted pdf.js worker.
 *
 * Reads the real header produced by next.config.js. The worker is now served
 * from 'self', so no directive may name jsDelivr, and the fix must not have
 * been achieved by widening script-src-elem.
 */
const nextConfig = require("../../next.config.js") as {
  headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
};

async function csp(): Promise<Map<string, string[]>> {
  const rules = await nextConfig.headers();
  const all = rules.find((r) => r.source === "/:path*");
  const value = all?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
  if (!value) throw new Error("no CSP header on /:path*");
  return new Map(
    value.split(";").map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/);
      return [name, sources] as [string, string[]];
    })
  );
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

  it("script-src-elem was not widened", async () => {
    expect((await csp()).get("script-src-elem")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "blob:",
      "https://js.stripe.com",
      "https://*.firebaseio.com",
      "https://*.googleapis.com",
      "https://apis.google.com",
      "https://accounts.google.com",
      "https://*.gstatic.com",
    ]);
  });
});
