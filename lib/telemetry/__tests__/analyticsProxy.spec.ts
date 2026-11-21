/**
 * Containment for the PR #335 Production finding: the PostHog proxy as app code with an explicit header allowlist,
 * and canonical-only paths. Synthetic dummy values only.
 *
 *   A1  path policy: exact canonical spellings pass; every case / encoding / slash / dot variant is a `variant`;
 *   A2  upstream mapping: fixed PostHog hosts, safe segments only, query passed through; test override only
 *       off Vercel and only for loopback;
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
  const env = {};
  it("maps API and asset paths to the fixed PostHog hosts, passing the query through", () => {
    expect(upstreamUrlFor("/ingest/e/", "?ip=0&_=1&ver=1.2", env)).toBe(`${POSTHOG_API_ORIGIN}/e/?ip=0&_=1&ver=1.2`);
    expect(upstreamUrlFor("/ingest/i/v0/e/", "", env)).toBe(`${POSTHOG_API_ORIGIN}/i/v0/e/`);
    expect(upstreamUrlFor("/ingest/static/array.js", "", env)).toBe(`${POSTHOG_ASSETS_ORIGIN}/static/array.js`);
    expect(upstreamUrlFor("/ingest/array/phc_x/config.js", "", env)).toBe(`${POSTHOG_ASSETS_ORIGIN}/array/phc_x/config.js`);
  });

  it("refuses variants, monitoring paths and unsafe segments (no upstream request)", () => {
    for (const p of ["/INGEST/e/", "/%69ngest/e/", "/ingest//e/", "/ingest/a b", "/ingest/@evil.example/x", "/monitoring", "/ingest/e:80"]) {
      expect([p, upstreamUrlFor(p, "", env)]).toEqual([p, null]);
    }
  });

  it("the test override applies only off Vercel and only to a loopback http origin", () => {
    expect(upstreamUrlFor("/ingest/e/", "", { CP_TEST_ANALYTICS_PROXY_ORIGIN: "http://127.0.0.1:4100" })).toBe("http://127.0.0.1:4100/__api/e/");
    expect(upstreamUrlFor("/ingest/static/a.js", "", { CP_TEST_ANALYTICS_PROXY_ORIGIN: "http://127.0.0.1:4100" })).toBe("http://127.0.0.1:4100/__assets/static/a.js");
    expect(upstreamUrlFor("/ingest/e/", "", { CP_TEST_ANALYTICS_PROXY_ORIGIN: "http://127.0.0.1:4100", VERCEL: "1" })).toBe(`${POSTHOG_API_ORIGIN}/e/`);
    expect(upstreamUrlFor("/ingest/e/", "", { CP_TEST_ANALYTICS_PROXY_ORIGIN: "https://evil.example" })).toBe(`${POSTHOG_API_ORIGIN}/e/`);
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
  });
  afterAll(() => {
    global.fetch = realFetch;
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
    expect(Buffer.from(calls[0].init.body as ArrayBuffer).toString()).toBe("payload");
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
  it("canonical paths continue (with credentials stripped) and /admin gating is unchanged", () => {
    const res = middleware(new NextRequest("https://convergepanel.com/ingest/e/", { headers: credentialHeaders() }));
    expect(res.status).toBe(200);
    expect(String(res.headers.get("x-middleware-override-headers"))).not.toMatch(/cookie|authorization/);
    expect(middleware(new NextRequest("https://convergepanel.com/admin")).status).toBe(307);
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
    expect(all.filter((r: { destination: string }) => /posthog/i.test(r.destination))).toEqual([]);
  });
});
