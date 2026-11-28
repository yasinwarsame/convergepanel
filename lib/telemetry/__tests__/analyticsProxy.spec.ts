/**
 * Containment for the PR #335 Production finding: the PostHog proxy as app code with an explicit header allowlist,
 * and canonical-only paths. Synthetic dummy values only.
 *
 *   A1  path policy: exact canonical spellings pass; every case / encoding / slash / dot variant is a `variant`;
 *   A2  upstream mapping: literal PostHog hosts (no environment override), safe segments only, query passed through;
 *   A3  header isolation: the upstream request carries ONLY allowlisted headers (Cookie / Authorization in any
 *       case, and every other inbound header, are dropped); the response carries only allowlisted headers;
 *   A4  route handler: builds that request (fetch mocked), refuses variants and the disabled switch before fetch;
 *   A5  middleware: refuses variants with 404 before routing (fail-first for the observed Vercel bypass).
 */
import {
  FORWARDED_REQUEST_HEADERS,
  POSTHOG_API_ORIGIN,
  POSTHOG_ASSETS_ORIGIN,
  analyticsProxyDisabled,
  classifyTelemetryProxyPath,
  downstreamResponseHeaders,
  upstreamRequestHeaders,
  upstreamUrlFor,
} from "@/lib/telemetry/analyticsProxy";

const DUMMY_SESSION = "DUMMYSESSIONVALUE0001";
const DUMMY_BEARER = "DUMMYBEARERVALUE0002";
const credentialHeaders = (): Record<string, string> => ({
  cookie: `__session=${DUMMY_SESSION}; ph_x=1`,
  authorization: `Bearer ${DUMMY_BEARER}`,
  "proxy-authorization": `Basic ${DUMMY_BEARER}`,
  "x-firebase-appcheck": DUMMY_BEARER,
  "x-api-key": DUMMY_BEARER,
  "x-forwarded-host": "convergepanel.com",
  referer: "https://convergepanel.com/",
  origin: "https://convergepanel.com",
});

describe("A1 path policy", () => {
  it.each(["/ingest/e/", "/ingest/e", "/ingest/static/array.js", "/ingest/array/phc_x/config.js", "/ingest/i/v0/e/", "/ingest", "/monitoring", "/monitoring/"])(
    "%s is canonical",
    (p) => expect(classifyTelemetryProxyPath(p)).toBe("canonical")
  );

  it.each([
    "/INGEST/e/",
    "/Ingest/static/array.js",
    "/iNgEsT",
    "/ingest./e/",
    "/INGEST./e/",
    "//ingest/e/",
    "//INGEST/e/",
    "/ingest//e/",
    "/ingest/./e/",
    "/ingest/../ingest/e/",
    "/%69ngest/e/",
    "/%49NGEST/e/",
    "/ingest%2Fe",
    "/ingest%2fstatic%2farray.js",
    "/%2569ngest/e/",
    "/ingest/e%2F",
    "/ingest\\e",
    "/ingest;x/e",
    "/Monitoring",
    "/MONITORING/",
    "/%4Donitoring",
    "/monitoring%2F",
    "/%E0%A4%Aingest",
  ])("%s is a variant (refused)", (p) => expect(classifyTelemetryProxyPath(p)).toBe("variant"));

  it.each(["/", "/pricing", "/ingestion", "/monitor", "/api/ingest", "/learn/ingest-data", "/workspace/team/x"])("%s is unrelated", (p) =>
    expect(classifyTelemetryProxyPath(p)).toBe("unrelated")
  );
});

describe("A2 upstream mapping", () => {
  it("maps API and asset paths to the fixed PostHog hosts, passing the query through", () => {
    expect(upstreamUrlFor("/ingest/e/", "?ip=0&_=1&ver=1.2")).toBe(`${POSTHOG_API_ORIGIN}/e/?ip=0&_=1&ver=1.2`);
    expect(upstreamUrlFor("/ingest/i/v0/e/", "")).toBe(`${POSTHOG_API_ORIGIN}/i/v0/e/`);
    // posthog-js's real query shape survives the re-encoding unchanged.
    expect(upstreamUrlFor("/ingest/e/", "?ip=0&_=1795280474271&ver=1.379.1&compression=gzip-js&beacon=1")).toBe(
      `${POSTHOG_API_ORIGIN}/e/?ip=0&_=1795280474271&ver=1.379.1&compression=gzip-js&beacon=1`
    );
    expect(upstreamUrlFor("/ingest/e/", "?")).toBe(`${POSTHOG_API_ORIGIN}/e/`);
    expect(upstreamUrlFor("/ingest/static/array.js", "")).toBe(`${POSTHOG_ASSETS_ORIGIN}/static/array.js`);
    expect(upstreamUrlFor("/ingest/array/phc_x/config.js", "")).toBe(`${POSTHOG_ASSETS_ORIGIN}/array/phc_x/config.js`);
  });

  it("refuses variants, monitoring paths and unsafe segments (no upstream request)", () => {
    for (const p of ["/INGEST/e/", "/%69ngest/e/", "/ingest//e/", "/ingest/a b", "/ingest/@evil.example/x", "/monitoring", "/ingest/e:80"]) {
      expect([p, upstreamUrlFor(p, "")]).toEqual([p, null]);
    }
  });

  it("the upstream host is a literal: no environment variable can redirect it", () => {
    const saved = { ...process.env };
    process.env.CP_TEST_ANALYTICS_PROXY_ORIGIN = "http://127.0.0.1:4100";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://evil.example";
    try {
      expect(upstreamUrlFor("/ingest/e/", "")).toBe(`${POSTHOG_API_ORIGIN}/e/`);
      expect(upstreamUrlFor("/ingest/static/a.js", "")).toBe(`${POSTHOG_ASSETS_ORIGIN}/static/a.js`);
    } finally {
      process.env = saved;
    }
  });

  it("the fail-closed switch", () => {
    expect(analyticsProxyDisabled({ CP_ANALYTICS_PROXY_DISABLED: "1" })).toBe(true);
    expect(analyticsProxyDisabled({})).toBe(false);
  });
});

describe("A3 header isolation", () => {
  it("only allowlisted request headers are forwarded; credentials in any letter case are dropped", () => {
    for (const variant of [
      { Cookie: `__session=${DUMMY_SESSION}`, Authorization: `Bearer ${DUMMY_BEARER}` },
      { COOKIE: `__session=${DUMMY_SESSION}`, AUTHORIZATION: `Bearer ${DUMMY_BEARER}` },
      { cOoKiE: `__session=${DUMMY_SESSION}`, aUtHoRiZaTiOn: `Bearer ${DUMMY_BEARER}` },
      credentialHeaders(),
    ]) {
      const inbound = new Headers({ ...variant, "content-type": "text/plain", "user-agent": "UA", "x-forwarded-for": "203.0.113.7" });
      const out = upstreamRequestHeaders(inbound);
      const names = [...out.keys()];
      expect(names.every((n) => FORWARDED_REQUEST_HEADERS.includes(n))).toBe(true);
      expect(names).toEqual(expect.arrayContaining(["content-type", "user-agent", "x-forwarded-for"]));
      expect(JSON.stringify([...out.entries()])).not.toMatch(new RegExp(`${DUMMY_SESSION}|${DUMMY_BEARER}`));
    }
    expect(FORWARDED_REQUEST_HEADERS).not.toContain("cookie");
    expect(FORWARDED_REQUEST_HEADERS).not.toContain("authorization");
  });

  it("only allowlisted response headers are returned (no Set-Cookie, no stale content-encoding)", () => {
    const out = downstreamResponseHeaders(new Headers({ "content-type": "application/json", "set-cookie": "a=b", "content-encoding": "gzip", "content-length": "9", "cache-control": "max-age=60" }));
    expect([...out.keys()].sort()).toEqual(["cache-control", "content-type"]);
  });
});

describe("A4 route handler", () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => {
    jest.resetModules();
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response('{"status":1}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=y" } });
    }) as any;
    delete process.env.CP_ANALYTICS_PROXY_DISABLED;
    process.env.VERCEL_ENV = "production"; // ZCA R2 Phase B: the proxy runs only in Vercel Production
  });
  afterAll(() => {
    global.fetch = realFetch;
    delete process.env.VERCEL_ENV;
  });
  const handler = () => require("../../../app/ingest/[...path]/route");

  it("POST /ingest/e/: upstream gets the body and only allowlisted headers; no credential reaches fetch", async () => {
    const { POST } = handler();
    const res: Response = await POST(
      new Request("https://convergepanel.com/ingest/e/?ip=0&ver=1", { method: "POST", headers: { ...credentialHeaders(), "content-type": "text/plain" }, body: "payload" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${POSTHOG_API_ORIGIN}/e/?ip=0&ver=1`);
    const sent = calls[0].init.headers as Headers;
    expect([...sent.keys()].every((n) => FORWARDED_REQUEST_HEADERS.includes(n))).toBe(true);
    expect(JSON.stringify([...sent.entries()])).not.toMatch(new RegExp(`${DUMMY_SESSION}|${DUMMY_BEARER}`));
    expect(Buffer.from(calls[0].init.body as Uint8Array).toString()).toBe("payload");
    expect(calls[0].init.redirect).toBe("manual"); // review MINOR-3: upstream redirects are never followed
  });

  it("review MINOR-3: an oversize body is refused with 413 before any upstream request", async () => {
    const { POST } = handler();
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    const declared: Response = await POST(new Request("https://convergepanel.com/ingest/e/", { method: "POST", body: big, headers: { "content-length": String(big.byteLength) } }));
    expect(declared.status).toBe(413);
    const streamed: Response = await POST(
      new Request("https://convergepanel.com/ingest/e/", {
        method: "POST",
        body: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }),
        // @ts-expect-error Node fetch needs duplex for a stream body
        duplex: "half",
      })
    );
    expect(streamed.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it.each(["/INGEST/e/", "/ingest//e/", "/%69ngest/e/", "/ingest/%2e%2e/e"])("%s: 404 before any upstream request", async (p) => {
    const { GET } = handler();
    const res: Response = await GET(new Request(`https://convergepanel.com${p}`, { headers: credentialHeaders() }));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("the disabled switch refuses every request before fetch", async () => {
    process.env.CP_ANALYTICS_PROXY_DISABLED = "1";
    const { GET } = handler();
    const res: Response = await GET(new Request("https://convergepanel.com/ingest/static/array.js"));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    delete process.env.CP_ANALYTICS_PROXY_DISABLED;
  });
});

describe("A5 middleware refuses variants before routing", () => {
  const { middleware } = require("../../../middleware");
  const { NextRequest } = require("next/server");
  it.each(["/INGEST/e/", "/Ingest/static/array.js", "/Monitoring", "/MONITORING/", "/ingest./e/", "/%69ngest/e/", "/ingest%2Fe"])("%s -> 404", (p) => {
    const res = middleware(new NextRequest(`https://convergepanel.com${p}`, { headers: credentialHeaders() }));
    expect(res.status).toBe(404);
  });
  it("canonical paths continue (with credentials stripped); /admin is no longer cookie-gated (ZCA L-8)", () => {
    const res = middleware(new NextRequest("https://convergepanel.com/ingest/e/", { headers: credentialHeaders() }));
    expect(res.status).toBe(200);
    expect(String(res.headers.get("x-middleware-override-headers"))).not.toMatch(/cookie|authorization/);
    const admin = middleware(new NextRequest("https://convergepanel.com/admin"));
    expect(admin.status).toBe(200);
    expect(admin.headers.get("location")).toBeNull();
  });
});

describe("A6 configuration: no external rewrite proxies analytics", () => {
  it("next.config.js has no rewrite to a PostHog host", async () => {
    jest.doMock("@sentry/nextjs", () => ({ withSentryConfig: (c: unknown) => c }));
    let cfg: any;
    jest.isolateModules(() => {
      cfg = require("../../../next.config.js");
    });
    const rewrites = await cfg.rewrites();
    const all = Array.isArray(rewrites) ? rewrites : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? []), ...(rewrites.fallback ?? [])];
    expect(all.filter((r: { destination: string }) => /posthog|sentry/i.test(r.destination))).toEqual([]);
    // withSentryConfig is mocked here, so its rewrites are checked on the real build (harness H6); the source must not
    // configure `tunnelRoute`, which is what registers them.
    const src = require("fs").readFileSync(require("path").join(__dirname, "../../../next.config.js"), "utf8") as string;
    expect(src).not.toMatch(/^\s*tunnelRoute\s*:/m);
  });
});
