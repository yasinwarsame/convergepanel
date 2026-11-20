/**
 * Private advisory GHSA-655j-5f43-92pw — correction round.
 *
 * MINOR-1: a document that starts while the tab still holds the invitation continuity envelope (sessionStorage; e.g.
 * a reload of /login mid-flow) never initializes Sentry or PostHog. Stale envelopes are purged first.
 * MINOR-2: a second invitation link arriving by a same-document fragment navigation is never dropped and never
 * processed in that document: it is scrubbed before any later listener, written to the existing envelope, and the
 * tab is moved to a fresh (telemetry-free) acceptance document.
 * Synthetic credentials only.
 */
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

const TOKEN = "ZQX7CORRECTIONTOKEN_abc-123";
const INV_ID = "inv_SYNTHETIC_0002";
const TOKEN2 = "ZQX7SECONDTOKEN_def-456";
const INV_ID2 = "inv_SYNTHETIC_0003";
const KEY = "convergepanel.invitationAcceptance.v1";
const ACCEPT = "/workspace-invitations/accept";

const events: string[] = [];
const atInit: Record<string, { href: string }> = {};
const snapshot = (who: string) => {
  events.push(`init:${who}`);
  atInit[who] = { href: String((globalThis as any).window.location.href) };
};

jest.mock("@sentry/nextjs", () => ({
  init: () => snapshot("sentry"),
  addEventProcessor: () => undefined,
  replayIntegration: () => ({ name: "Replay" }),
  captureRouterTransitionStart: () => undefined,
}));
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { init: () => snapshot("posthog"), capture: () => undefined, __loaded: false },
}));
jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock("next/navigation", () => ({
  usePathname: () => (globalThis as any).window?.location?.pathname ?? "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const g = globalThis as any;
const SAVED_WINDOW = g.window;
const SAVED_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const SAVED_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

type Listener = (e: Event) => void;

function installWindow(path: string, opts: { storage?: "working" | "throws"; envelope?: string | null } = {}) {
  const u = new URL(path, "https://convergepanel.com");
  const loadedUrl = u.href;
  const location: any = { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
  Object.defineProperty(location, "href", { get: () => `${u.origin}${location.pathname}${location.search}${location.hash}` });
  const replaced: string[] = [];
  location.replace = (url: string) => replaced.push(url);
  location.reload = () => replaced.push("<reload>");
  const calls: string[] = [];
  const history = {
    state: { __NA: true } as unknown,
    replaceState(data: unknown, _t: string, url: string) {
      calls.push(url);
      history.state = data;
      const n = new URL(url, u.origin);
      location.pathname = n.pathname;
      location.search = n.search;
      location.hash = n.hash;
    },
  };
  const listeners: Record<string, Listener[]> = {};
  const session = new FakeStorage();
  if (opts.envelope != null) session.setItem(KEY, opts.envelope);
  const local = new FakeStorage();
  g.window = {
    location,
    history,
    document: { referrer: "", cookie: "" },
    localStorage: local,
    performance: { getEntriesByType: (t: string) => (t === "navigation" ? [{ name: loadedUrl }] : []) },
    addEventListener: (type: string, fn: Listener) => {
      events.push(`listen:${type}`);
      (listeners[type] ??= []).push(fn);
    },
  };
  Object.defineProperty(g.window, "sessionStorage", {
    get: () => {
      if (opts.storage === "throws") throw new Error("SecurityError");
      return session;
    },
  });
  /** A same-document fragment navigation, dispatched in registration order like a browser (popstate, then hashchange). */
  const fragmentNavigate = (hash: string) => {
    location.hash = hash;
    const fired: string[] = [];
    for (const type of ["popstate", "hashchange"]) {
      let stopped = false;
      const ev = { type, stopImmediatePropagation: () => (stopped = true) } as unknown as Event;
      for (const fn of listeners[type] ?? []) {
        if (stopped) break;
        fn(ev);
      }
      fired.push(`${type}:${stopped ? "stopped" : "propagated"}`);
    }
    return fired;
  };
  return { session, location, calls, replaced, listeners, fragmentNavigate };
}

const envelope = (storedAt: number, token = TOKEN, invitationId = INV_ID) => JSON.stringify({ version: 1, invitationId, token, storedAt });

function mountPostHogProvider() {
  const React = require("react");
  const TR = require("react-test-renderer");
  const { PostHogProvider } = require("@/components/PostHogProvider");
  let r: any;
  TR.act(() => {
    r = (TR.default ?? TR).create(React.createElement(PostHogProvider, null, React.createElement("div")));
  });
  TR.act(() => r.unmount());
}

function boot() {
  require("../instrumentation-client");
  mountPostHogProvider();
}

beforeEach(() => {
  jest.resetModules();
  events.length = 0;
  for (const k of Object.keys(atInit)) delete atInit[k];
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic";
});
afterAll(() => {
  g.window = SAVED_WINDOW;
  if (SAVED_DSN === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = SAVED_DSN;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = SAVED_KEY;
});

describe("MINOR-1: a document started while the tab holds the envelope never initializes telemetry", () => {
  for (const path of ["/login?redirect=%2Fworkspace-invitations%2Faccept", "/signup?redirect=%2Fworkspace-invitations%2Faccept", "/workspace", "/pricing"]) {
    it(`full load of ${path} with a live envelope: no Sentry.init, no posthog.init; envelope kept for the page`, () => {
      const env = installWindow(path, { envelope: envelope(Date.now() - 60_000) });
      boot();
      expect(atInit.sentry).toBeUndefined();
      expect(atInit.posthog).toBeUndefined();
      expect(env.session.getItem(KEY)).toContain(TOKEN);
    });
  }

  it("a malformed envelope is purged before the telemetry decision (it is never left behind), so that document is an ordinary one", () => {
    const env = installWindow("/login", { envelope: '{"version":1,"invitationId":"x","token":' });
    boot();
    // purged pre-decision: malformed records are cleared, so this document is an ordinary one
    expect(env.session.getItem(KEY)).toBeNull();
    expect(atInit.sentry?.href).toBe("https://convergepanel.com/login");
    expect(atInit.posthog).toBeDefined();
  });

  it("an expired envelope is removed BEFORE the telemetry decision; that document then initializes normally, and the token is gone from storage", () => {
    const env = installWindow("/login", { envelope: envelope(Date.now() - 31 * 60 * 1000) });
    boot();
    expect(env.session.getItem(KEY)).toBeNull();
    expect(atInit.sentry).toBeDefined();
    expect(atInit.posthog).toBeDefined();
  });

  it("with no envelope an ordinary document initializes both SDKs with a clean URL (telemetry restored after the flow)", () => {
    installWindow("/login");
    boot();
    expect(atInit.sentry?.href).toBe("https://convergepanel.com/login");
    expect(atInit.posthog?.href).toBe("https://convergepanel.com/login");
  });

  it("decided once per document: an envelope written LATER (in this document) does not flip an initialized document, and one removed later does not start telemetry in a telemetry-free one", () => {
    const a = installWindow("/login");
    boot();
    a.session.setItem(KEY, envelope(Date.now()));
    expect(require("@/lib/telemetry/telemetryFreeDocument").isTelemetryFreeDocument()).toBe(false);

    jest.resetModules();
    for (const k of Object.keys(atInit)) delete atInit[k];
    const b = installWindow("/login", { envelope: envelope(Date.now()) });
    require("../instrumentation-client");
    b.session.removeItem(KEY);
    mountPostHogProvider();
    expect(atInit.sentry).toBeUndefined();
    expect(atInit.posthog).toBeUndefined();
  });

  it("blocked sessionStorage: no envelope can be read by anyone in this document (SDKs included), so it is an ordinary document", () => {
    installWindow("/login", { storage: "throws" });
    boot();
    expect(atInit.sentry).toBeDefined();
  });
});

describe("MINOR-2: a second invitation link by same-document fragment navigation", () => {
  it("the guard is registered before Sentry.init, so it runs before the SDK's history handlers", () => {
    installWindow(ACCEPT);
    boot();
    expect(events.indexOf("listen:popstate")).toBeGreaterThanOrEqual(0);
    // acceptance-origin document: no init at all; check ordering on an ordinary document too
    jest.resetModules();
    events.length = 0;
    installWindow("/pricing");
    boot();
    expect(events.indexOf("listen:popstate")).toBeLessThan(events.indexOf("init:sentry"));
  });

  for (const origin of [ACCEPT, "/pricing"] as const) {
    it(`document loaded at ${origin}, now on the acceptance path: a valid second link is scrubbed first, stops later listeners, replaces any earlier envelope, and reloads clean`, () => {
      const env = installWindow(origin, { envelope: envelope(Date.now(), TOKEN, INV_ID) });
      boot();
      env.location.pathname = ACCEPT; // (soft navigation in the telemetry-on case)
      const later: string[] = [];
      (env.listeners.popstate ??= []).push(() => later.push(String(g.window.location.href))); // e.g. an SDK handler
      const fired = env.fragmentNavigate(`#invitationId=${INV_ID2}&token=${TOKEN2}`);
      expect(fired).toEqual(["popstate:stopped", "hashchange:propagated"]);
      expect(later).toEqual([]);
      expect(env.location.href).toBe(`https://convergepanel.com${ACCEPT}`);
      expect(env.replaced).toEqual([ACCEPT]);
      const stored = JSON.parse(String(env.session.getItem(KEY)));
      expect(stored).toMatchObject({ version: 1, invitationId: INV_ID2, token: TOKEN2 });
      expect(String(env.session.getItem(KEY))).not.toContain(TOKEN); // never confused with the earlier invitation
    });
  }

  it("an invalid second fragment clears the envelope and reloads (the page then shows 'Invitation unavailable', never a success)", () => {
    const env = installWindow(ACCEPT, { envelope: envelope(Date.now()) });
    boot();
    env.fragmentNavigate(`#invitationId=${INV_ID2}&token=a&token=b`);
    expect(env.session.getItem(KEY)).toBeNull();
    expect(env.replaced).toEqual([ACCEPT]);
    expect(env.location.href).toBe(`https://convergepanel.com${ACCEPT}`);
  });

  it("other paths, a bare '#' and a plain anchor-free reload are untouched", () => {
    const env = installWindow("/pricing");
    boot();
    expect(env.fragmentNavigate(`#invitationId=${INV_ID2}&token=${TOKEN2}`)).toEqual(["popstate:propagated", "hashchange:propagated"]);
    expect(env.replaced).toEqual([]);
    env.location.pathname = ACCEPT;
    expect(env.fragmentNavigate("#")).toEqual(["popstate:propagated", "hashchange:propagated"]);
    expect(env.replaced).toEqual([]);
  });

  it("installed once even though the scrub runs twice (instrumentation-client and PostHogProvider)", () => {
    const env = installWindow("/pricing");
    boot();
    expect(env.listeners.popstate).toHaveLength(1);
    expect(env.listeners.hashchange).toHaveLength(1);
  });
});

describe("review R3 MAJOR-1: a telemetry-enabled document restored from the back/forward cache", () => {
  const pageshow = (env: ReturnType<typeof installWindow>, persisted: boolean) => {
    let stopped = false;
    for (const fn of env.listeners.pageshow ?? []) {
      if (stopped) break;
      fn({ type: "pageshow", persisted, stopImmediatePropagation: () => (stopped = true) } as unknown as Event);
    }
    return stopped;
  };

  it("is reloaded (→ a fresh, telemetry-free document) when the tab now holds the envelope", () => {
    const env = installWindow("/login?redirect=%2Fworkspace-invitations%2Faccept");
    boot();
    expect(atInit.sentry).toBeDefined(); // an ordinary, telemetry-on document
    env.session.setItem(KEY, envelope(Date.now())); // written meanwhile by another document in this tab
    const sdkPageshow = jest.fn();
    env.listeners.pageshow.push(sdkPageshow); // registered later (e.g. by an SDK)
    expect(pageshow(env, true)).toBe(true);
    expect(sdkPageshow).not.toHaveBeenCalled();
    expect(env.replaced).toEqual(["<reload>"]);
  });

  it("is left alone when there is no envelope, on an ordinary (non-cache) pageshow, and in a telemetry-free document", () => {
    const a = installWindow("/login");
    boot();
    pageshow(a, true);
    a.session.setItem(KEY, envelope(Date.now()));
    pageshow(a, false);
    expect(a.replaced).toEqual([]);

    jest.resetModules();
    const b = installWindow(ACCEPT, { envelope: envelope(Date.now()) });
    boot();
    pageshow(b, true);
    expect(b.replaced).toEqual([]);
  });

  it("the pageshow guard is installed once, before Sentry.init", () => {
    const env = installWindow("/pricing");
    boot();
    expect(env.listeners.pageshow).toHaveLength(1);
    expect(events.indexOf("listen:pageshow")).toBeLessThan(events.indexOf("init:sentry"));
  });
});
