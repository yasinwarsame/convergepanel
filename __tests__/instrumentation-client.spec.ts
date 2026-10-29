/**
 * Team Workspace Invitations, Phase 8D.3.1 — `instrumentation-client.ts`
 * URL-fragment redaction. Tests capture the ACTUAL callback registered with
 * `Sentry.addEventProcessor()` at module-init time and invoke it directly —
 * not a standalone, unwired helper — to prove the wiring itself is correct.
 *
 * Per this repo's `jest.config.ts` `testMatch`, a test file must live
 * inside a `__tests__/` directory to be collected at all; this is placed
 * at the repo root (a new root-level `__tests__/`, alongside the existing
 * `components/__tests__/`, `hooks/__tests__/`, `lib/__tests__/`,
 * `app/__tests__/` directories) rather than as a bare `instrumentation-client.spec.ts`,
 * which Jest would silently never run.
 */

const SENTINEL = "SUPER_SECRET_INVITATION_TOKEN_987654";
const FRAGMENT_URL = `https://convergepanel.com/workspace-invitations/accept#invitationId=inv-1&token=${SENTINEL}`;
const SCRUBBED_URL = "https://convergepanel.com/workspace-invitations/accept";

let capturedInitConfig: any;
let capturedProcessor: ((event: any) => any) | undefined;
let capturedBeforeBreadcrumb: ((breadcrumb: any) => any) | undefined;

const mockedInit = jest.fn((config: any) => {
  capturedInitConfig = config;
  capturedBeforeBreadcrumb = config?.beforeBreadcrumb;
});
const mockedAddEventProcessor = jest.fn((processor: (event: any) => any) => {
  capturedProcessor = processor;
});
const mockedReplayIntegration = jest.fn(() => ({ name: "Replay" }));
const mockedCaptureRouterTransitionStart = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  init: (config: any) => mockedInit(config),
  addEventProcessor: (processor: any) => mockedAddEventProcessor(processor),
  replayIntegration: () => mockedReplayIntegration(),
  captureRouterTransitionStart: mockedCaptureRouterTransitionStart,
}));

// Order 6 telemetry isolation: browser Sentry initializes only with an
// explicitly configured NEXT_PUBLIC_SENTRY_DSN. A synthetic DSN (never a real
// project) keeps the redaction suites below exercising an initialized client.
const SYNTHETIC_DSN = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
const ORIGINAL_PUBLIC_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  capturedInitConfig = undefined;
  capturedProcessor = undefined;
  capturedBeforeBreadcrumb = undefined;
  process.env.NEXT_PUBLIC_SENTRY_DSN = SYNTHETIC_DSN;
});

afterAll(() => {
  if (ORIGINAL_PUBLIC_DSN === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = ORIGINAL_PUBLIC_DSN;
});

function load() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("../instrumentation-client");
}

describe("instrumentation-client — init still occurs, event processor registered once", () => {
  it("calls Sentry.init exactly once with Replay enabled", () => {
    load();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(capturedInitConfig.integrations).toEqual([{ name: "Replay" }]);
  });

  it("registers exactly one event processor", () => {
    load();
    expect(mockedAddEventProcessor).toHaveBeenCalledTimes(1);
    expect(typeof capturedProcessor).toBe("function");
  });

  it("exports onRouterTransitionStart wired to Sentry's own implementation", () => {
    const mod = require("../instrumentation-client");
    expect(mod.onRouterTransitionStart).toBe(mockedCaptureRouterTransitionStart);
  });
});

describe("instrumentation-client — Replay direct-load scrub", () => {
  it("strips the fragment from initialUrl and urls[] on a direct-load-shaped replay_event fixture", () => {
    load();
    const fixture = {
      type: "replay_event",
      initialUrl: FRAGMENT_URL,
      urls: [FRAGMENT_URL],
    };
    const result = capturedProcessor!(fixture);
    expect(result.initialUrl).toBe(SCRUBBED_URL);
    expect(result.urls).toEqual([SCRUBBED_URL]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe("instrumentation-client — Replay client-navigation scrub", () => {
  it("strips a fragment-bearing URL appended to urls[] by a later SPA navigation, proving the fix is not init/pathname-dependent", () => {
    load();
    // Simulates Replay already running from an earlier route, with an
    // ordinary prior URL already recorded, then a client-side navigation
    // into the sensitive route pushes a second, fragment-bearing entry.
    const fixture = {
      type: "replay_event",
      initialUrl: "https://convergepanel.com/dashboard",
      urls: ["https://convergepanel.com/dashboard", FRAGMENT_URL],
    };
    const result = capturedProcessor!(fixture);
    expect(result.urls).toEqual(["https://convergepanel.com/dashboard", SCRUBBED_URL]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe("instrumentation-client — ordinary event fields", () => {
  it("strips request.url on an error/transaction-shaped event", () => {
    load();
    const fixture = { type: undefined, request: { url: FRAGMENT_URL } };
    const result = capturedProcessor!(fixture);
    expect(result.request.url).toBe(SCRUBBED_URL);
  });

  it("strips url/to/from on every breadcrumb via the event processor path", () => {
    load();
    const fixture = {
      breadcrumbs: [
        { category: "navigation", data: { url: FRAGMENT_URL, to: FRAGMENT_URL, from: "https://convergepanel.com/login" } },
        { category: "ui.click", data: { unrelated: "kept" } },
      ],
    };
    const result = capturedProcessor!(fixture);
    expect(result.breadcrumbs[0].data.url).toBe(SCRUBBED_URL);
    expect(result.breadcrumbs[0].data.to).toBe(SCRUBBED_URL);
    expect(result.breadcrumbs[0].data.from).toBe("https://convergepanel.com/login");
    expect(result.breadcrumbs[1].data).toEqual({ unrelated: "kept" });
  });

  it("strips url/to/from via the beforeBreadcrumb hook directly (defense-in-depth path)", () => {
    load();
    const breadcrumb = { category: "navigation", data: { url: FRAGMENT_URL, to: FRAGMENT_URL, from: "x" } };
    const result = capturedBeforeBreadcrumb!(breadcrumb);
    expect(result.data.url).toBe(SCRUBBED_URL);
    expect(result.data.to).toBe(SCRUBBED_URL);
  });

  it("leaves non-fragment URLs and unrelated event data untouched", () => {
    load();
    const fixture = {
      request: { url: "https://convergepanel.com/api/thing" },
      urls: ["https://convergepanel.com/dashboard"],
      unrelatedField: "kept-exactly",
    };
    const result = capturedProcessor!(fixture);
    expect(result.request.url).toBe("https://convergepanel.com/api/thing");
    expect(result.urls).toEqual(["https://convergepanel.com/dashboard"]);
    expect(result.unrelatedField).toBe("kept-exactly");
  });

  it("is a no-op on an event with none of the URL-bearing fields", () => {
    load();
    const fixture = { message: "hello" };
    const result = capturedProcessor!(fixture);
    expect(result).toEqual({ message: "hello" });
  });
});

describe("instrumentation-client — telemetry isolation (Order 6)", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("does not initialize Sentry when NEXT_PUBLIC_SENTRY_DSN is missing", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    load();
    expect(mockedInit).not.toHaveBeenCalled();
    expect(mockedReplayIntegration).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "], ["\t\n"]])("does not initialize Sentry when NEXT_PUBLIC_SENTRY_DSN is empty or blank (%j)", (value) => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = value;
    load();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it("initializes with exactly the configured isolated DSN and nothing else", () => {
    const isolated = "https://11111111111111111111111111111111@o1.ingest.example.invalid/1";
    process.env.NEXT_PUBLIC_SENTRY_DSN = `  ${isolated}  `;
    load();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(capturedInitConfig.dsn).toBe(isolated);
  });

  it("initializes enabled with the configured DSN in a production build (explicit Production configuration)", () => {
    const configured = "https://22222222222222222222222222222222@o2.ingest.example.invalid/2";
    process.env.NEXT_PUBLIC_SENTRY_DSN = configured;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    load();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(capturedInitConfig.dsn).toBe(configured);
    expect(capturedInitConfig.enabled).toBe(true);
  });

  it("keeps the fragment-redaction event processor registered even when disabled (no client, so nothing is sent)", () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    load();
    expect(mockedAddEventProcessor).toHaveBeenCalledTimes(1);
  });
});
