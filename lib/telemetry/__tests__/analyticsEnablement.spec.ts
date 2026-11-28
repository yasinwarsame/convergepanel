/**
 * ZCA Round 2, Phase B (owner decision 2): server analytics (posthog-node) and the `/ingest` proxy are active ONLY
 * on Vercel Production. Missing / empty / unknown environment signals fail closed: no client is constructed and no
 * upstream request is made, whatever PostHog key is configured.
 */
const mockPostHogCtor = jest.fn();
jest.mock("posthog-node", () => ({
  PostHog: jest.fn().mockImplementation((...a: unknown[]) => {
    mockPostHogCtor(...a);
    return { capture: jest.fn(), flush: jest.fn() };
  }),
}));

import { serverAnalyticsEnabled } from "@/lib/telemetry/analyticsEnablement";

const KEYS = ["VERCEL_ENV", "NEXT_PUBLIC_POSTHOG_KEY", "CP_ANALYTICS_PROXY_DISABLED"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const NON_PRODUCTION: Array<string | undefined> = [undefined, "", "preview", "development", "Production", "production ", "prod"];

function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = v;
}

describe("serverAnalyticsEnabled", () => {
  it("is true for exactly VERCEL_ENV=production", () => {
    expect(serverAnalyticsEnabled({ VERCEL_ENV: "production" })).toBe(true);
    for (const v of NON_PRODUCTION) expect(serverAnalyticsEnabled({ VERCEL_ENV: v })).toBe(false);
  });
});

describe("getPostHogClient (posthog-node)", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPostHogCtor.mockReset();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic";
  });

  it.each(NON_PRODUCTION.map((v) => [v]))("VERCEL_ENV=%p → throws and never constructs a client", (v) => {
    setEnv(v);
    const { getPostHogClient } = require("@/lib/posthog-server");
    expect(() => getPostHogClient()).toThrow(/disabled outside Vercel Production/);
    expect(mockPostHogCtor).not.toHaveBeenCalled();
  });

  it("control: Production with a key constructs the client once", () => {
    setEnv("production");
    const { getPostHogClient } = require("@/lib/posthog-server");
    getPostHogClient();
    getPostHogClient();
    expect(mockPostHogCtor).toHaveBeenCalledTimes(1);
  });
});

describe("/ingest proxy", () => {
  const realFetch = global.fetch;
  let fetchCalls = 0;
  beforeEach(() => {
    jest.resetModules();
    fetchCalls = 0;
    delete process.env.CP_ANALYTICS_PROXY_DISABLED;
    global.fetch = jest.fn(async () => {
      fetchCalls++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  const handler = () => require("../../../app/ingest/[...path]/route");

  it.each(NON_PRODUCTION.map((v) => [v]))("VERCEL_ENV=%p → 404 for GET and POST, no upstream request", async (v) => {
    setEnv(v);
    const { GET, POST } = handler();
    expect((await GET(new Request("https://x.vercel.app/ingest/static/array.js"))).status).toBe(404);
    expect((await POST(new Request("https://x.vercel.app/ingest/e/", { method: "POST", body: "{}" }))).status).toBe(404);
    expect(fetchCalls).toBe(0);
  });

  it("control: Production forwards a canonical path", async () => {
    setEnv("production");
    const { GET } = handler();
    expect((await GET(new Request("https://convergepanel.com/ingest/static/array.js"))).status).toBe(200);
    expect(fetchCalls).toBe(1);
  });
});
