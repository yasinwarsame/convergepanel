/**
 * Privacy remediation (2026-11-17 audit) — every Sentry init (browser,
 * server, edge) sends no claim / question text. Each test loads the REAL
 * config module against a mocked `@sentry/nextjs`, captures the options it
 * actually passed to `Sentry.init` / `replayIntegration`, and invokes those
 * registered hooks with representative synthetic events. Synthetic data only.
 */

const CLAIM = "SYNTHETIC_CLAIM_vaccines contain microchips";
const enc = encodeURIComponent(CLAIM);
const SESSION_COOKIE = "__session=SYNTHETIC_SESSION_COOKIE_VALUE";

let initConfig: any;
let replayOptions: any;
let eventProcessor: ((e: any) => any) | undefined;

jest.mock("@sentry/nextjs", () => ({
  init: (config: any) => {
    initConfig = config;
  },
  addEventProcessor: (p: any) => {
    eventProcessor = p;
  },
  replayIntegration: (options: any) => {
    replayOptions = options;
    return { name: "Replay" };
  },
  captureRouterTransitionStart: jest.fn(),
  captureRequestError: jest.fn(),
}));

const DSN = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
const SAVED = { pub: process.env.NEXT_PUBLIC_SENTRY_DSN, srv: process.env.SENTRY_DSN };

beforeEach(() => {
  jest.resetModules();
  initConfig = undefined;
  replayOptions = undefined;
  eventProcessor = undefined;
  process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
  process.env.SENTRY_DSN = DSN;
});
afterAll(() => {
  if (SAVED.pub === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = SAVED.pub;
  if (SAVED.srv === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = SAVED.srv;
});

function errorEvent(): any {
  return {
    message: `Failed on https://convergepanel.com/?tab=verify&claim=${enc}`,
    request: {
      url: `https://convergepanel.com/verify?source=extension&text=${enc}`,
      query_string: `source=extension&text=${enc}`,
      method: "POST",
      data: { claim: CLAIM },
      cookies: { __session: "SYNTHETIC_SESSION_COOKIE_VALUE" },
      headers: {
        Cookie: SESSION_COOKIE,
        Authorization: "Bearer SYNTHETIC_ID_TOKEN",
        Referer: `https://convergepanel.com/signup?redirect=${encodeURIComponent(`/verify?text=${enc}`)}`,
        "User-Agent": "jest",
      },
    },
    user: { id: "uid-synthetic", ip_address: "203.0.113.7", email: "person@example.test" },
    breadcrumbs: [
      { category: "navigation", data: { from: "/verify", to: `/?tab=verify&claim=${enc}` } },
      { category: "fetch", data: { url: `/api/thing?q=${enc}`, method: "GET", status_code: 200 } },
    ],
    exception: { values: [{ type: "TypeError", value: "x is not a function" }] },
    tags: { runtime: "test" },
  };
}

function transactionEvent(): any {
  return {
    type: "transaction",
    transaction: "/verify",
    request: { url: `https://convergepanel.com/verify?text=${enc}` },
    contexts: { trace: { op: "pageload", data: { "url.full": `https://convergepanel.com/verify?text=${enc}`, "http.query": `?text=${enc}` } } },
    spans: [
      { op: "http.client", description: `GET https://convergepanel.com/api/x?q=${enc}`, data: { url: `/api/x?q=${enc}`, "http.method": "GET" } },
      { op: "navigation", description: `/?tab=research&q=${enc}`, data: { "http.target": `/?tab=research&q=${enc}` } },
    ],
  };
}

function assertClean(out: any) {
  const json = JSON.stringify(out);
  expect(json).not.toContain("SYNTHETIC_CLAIM");
  expect(json).not.toContain("microchips");
  expect(json).not.toContain("SYNTHETIC_SESSION_COOKIE_VALUE");
  expect(json).not.toContain("SYNTHETIC_ID_TOKEN");
  expect(json).not.toContain("203.0.113.7");
  expect(json).not.toContain("person@example.test");
}

function assertOperationalSignalKept(out: any) {
  // Controls: the event still carries what makes it useful.
  expect(out.request.url).toBe("https://convergepanel.com/verify?source=extension&text=[redacted]");
  expect(out.request.method).toBe("POST");
  expect(out.request.headers["User-Agent"]).toBe("jest");
  expect(out.exception.values[0].value).toBe("x is not a function");
  expect(out.user.id).toBe("uid-synthetic");
  expect(out.tags).toEqual({ runtime: "test" });
  expect(out.breadcrumbs[1].data.status_code).toBe(200);
}

describe.each([
  ["browser", "../instrumentation-client"],
  ["server", "../sentry.server.config"],
  ["edge", "../sentry.edge.config"],
])("%s Sentry init", (_label, modulePath) => {
  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(modulePath);
    expect(initConfig).toBeDefined();
  }

  it("pins sendDefaultPii: false", () => {
    load();
    expect(initConfig.sendDefaultPii).toBe(false);
  });

  it("registers beforeSend, beforeSendTransaction and beforeBreadcrumb", () => {
    load();
    expect(typeof initConfig.beforeSend).toBe("function");
    expect(typeof initConfig.beforeSendTransaction).toBe("function");
    expect(typeof initConfig.beforeBreadcrumb).toBe("function");
  });

  it("beforeSend: an error event carries no claim, cookie, auth header, IP or email — and keeps its operational fields", () => {
    load();
    const out = initConfig.beforeSend(errorEvent(), {});
    assertClean(out);
    assertOperationalSignalKept(out);
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.query_string).toBe("source=extension&text=[redacted]");
    expect(out.request.headers.Referer).toBe("https://convergepanel.com/signup?redirect=[redacted]");
    expect(out.message).toBe("Failed on https://convergepanel.com/?tab=verify&claim=[redacted]");
  });

  it("beforeSendTransaction: request, trace data, span descriptions and span data carry no claim; route names survive", () => {
    load();
    const out = initConfig.beforeSendTransaction(transactionEvent(), {});
    assertClean(out);
    expect(out.transaction).toBe("/verify");
    expect(out.spans[0].description).toBe("GET https://convergepanel.com/api/x?q=[redacted]");
    expect(out.spans[0].data["http.method"]).toBe("GET");
    expect(out.spans[1].data["http.target"]).toBe("/?tab=research&q=[redacted]");
    expect(out.contexts.trace.op).toBe("pageload");
  });

  it("beforeBreadcrumb: navigation and fetch breadcrumbs carry no claim", () => {
    load();
    const nav = initConfig.beforeBreadcrumb({ category: "navigation", data: { from: `/verify?text=${enc}`, to: `/?tab=verify&claim=${enc}` } }, {});
    const xhr = initConfig.beforeBreadcrumb({ category: "xhr", data: { url: `/api/x?question=${enc}`, method: "POST", status_code: 500 } }, {});
    assertClean([nav, xhr]);
    expect(nav.data.to).toBe("/?tab=verify&claim=[redacted]");
    expect(xhr.data.status_code).toBe(500);
  });

  it("a breadcrumb/event with no URLs passes through unchanged (control)", () => {
    load();
    const crumb = { category: "ui.click", message: "button#run" };
    expect(initConfig.beforeBreadcrumb({ ...crumb }, {})).toEqual(crumb);
    const ev = { message: "plain", exception: { values: [{ type: "Error", value: "boom" }] } };
    expect(initConfig.beforeSend(JSON.parse(JSON.stringify(ev)), {})).toEqual(ev);
  });
});

describe("browser Sentry — Replay and the shared event processor", () => {
  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../instrumentation-client");
  }

  it("pins Replay masking explicitly (maskAllText / maskAllInputs / blockAllMedia, no network detail)", () => {
    load();
    expect(replayOptions).toMatchObject({ maskAllText: true, maskAllInputs: true, blockAllMedia: true, networkDetailAllowUrls: [] });
    expect(typeof replayOptions.beforeAddRecordingEvent).toBe("function");
  });

  it("keeps the session / on-error sample rates (replays still flow)", () => {
    load();
    expect(initConfig.replaysSessionSampleRate).toBe(0.05);
    expect(initConfig.replaysOnErrorSampleRate).toBe(1.0);
  });

  it("beforeAddRecordingEvent scrubs rrweb meta href, DOM href attributes, and performance-span / breadcrumb URLs", () => {
    load();
    const meta = { type: 4, timestamp: 1, data: { href: `https://convergepanel.com/verify?text=${enc}`, width: 1, height: 1 } };
    const snapshot = {
      type: 2,
      data: { node: { type: 0, childNodes: [{ type: 2, tagName: "body", childNodes: [{ type: 2, tagName: "a", attributes: { href: `/signup?redirect=${enc}`, class: "cta" }, childNodes: [] }] }] } },
    };
    const perf = { type: 5, data: { tag: "performanceSpan", payload: { op: "navigation.push", description: `https://convergepanel.com/?tab=verify&claim=${enc}` } } };
    const crumb = { type: 5, data: { tag: "breadcrumb", payload: { category: "navigation", data: { to: `/?q=${enc}` } } } };
    const outs = [meta, snapshot, perf, crumb].map((e) => replayOptions.beforeAddRecordingEvent(e));
    assertClean(outs);
    expect(outs[0].data.width).toBe(1);
    expect((outs[1] as any).data.node.childNodes[0].childNodes[0].attributes.class).toBe("cta");
    expect(outs[2].data.payload.op).toBe("navigation.push");
  });

  it("the event processor (replay_event / any event) scrubs urls, initialUrl, request and breadcrumbs", () => {
    load();
    const out = eventProcessor!({
      type: "replay_event",
      initialUrl: `https://convergepanel.com/verify?text=${enc}`,
      urls: [`https://convergepanel.com/?tab=verify&claim=${enc}`, "https://convergepanel.com/dashboard"],
      ...errorEvent(),
    });
    assertClean(out);
    expect(out.urls[1]).toBe("https://convergepanel.com/dashboard");
  });
});
