/**
 * Private advisory GHSA-655j-5f43-92pw — the workspace-invitation acceptance
 * credential (`/workspace-invitations/accept#invitationId=…&token=…`).
 *
 * 1. A document loaded as the acceptance link never initializes Sentry or
 *    PostHog, for its whole lifetime: the browser keeps the original URL
 *    (fragment included) in the navigation timing entry, which no URL scrub can
 *    change and which the SDKs read. The decision follows that entry, so a later
 *    client-side navigation in the same document cannot start telemetry.
 * 2. The fragment is still removed from the address bar before anything else
 *    runs, and the credential reaches the page through a one-time, in-memory,
 *    non-persistent hand-off.
 * 3. Every other document still initializes both SDKs, with a clean URL.
 * Synthetic credential only.
 */
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

const TOKEN = "ZQX7INVITETOKENSENTINEL_abc-123";
const INV_ID = "inv_SYNTHETIC_0001";
const ACCEPT = "/workspace-invitations/accept";
const ACCEPT_URL = `${ACCEPT}#invitationId=${INV_ID}&token=${TOKEN}`;

const atInit: Record<string, { href: string }> = {};
const snapshot = (who: string) => {
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

type Nav = "same" | "none" | "throws" | string;

/** `navigation`: the navigation timing entry name ("same" = the loaded URL, as a real browser records it). */
function installWindow(path: string, opts: { storage?: "working" | "throws"; navigation?: Nav } = {}) {
  const u = new URL(path, "https://convergepanel.com");
  const loadedUrl = u.href;
  const location: any = { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
  Object.defineProperty(location, "href", { get: () => `${u.origin}${location.pathname}${location.search}${location.hash}` });
  const calls: string[] = [];
  const history = {
    state: { __NA: true, tree: "next-router" } as unknown,
    replaceState(data: unknown, _t: string, url: string) {
      calls.push(url);
      history.state = data;
      const n = new URL(url, u.origin);
      location.pathname = n.pathname;
      location.search = n.search;
      location.hash = n.hash;
    },
    pushState() {
      throw new Error("pushState must never be used for the credential scrub");
    },
  };
  const nav = opts.navigation ?? "same";
  const performance = {
    getEntriesByType: (type: string) => {
      if (nav === "throws") throw new Error("blocked");
      if (type !== "navigation" || nav === "none") return [];
      return [{ name: nav === "same" ? loadedUrl : new URL(nav, u.origin).href }];
    },
  };
  const session = new FakeStorage();
  const local = new FakeStorage();
  const doc = { referrer: "", cookie: "" };
  g.window = { location, history, document: doc, localStorage: local, performance };
  Object.defineProperty(g.window, "sessionStorage", {
    get: () => {
      if (opts.storage === "throws") throw new Error("SecurityError");
      return session;
    },
  });
  return { session, local, doc, calls, location };
}

beforeEach(() => {
  jest.resetModules();
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

function dump(store: FakeStorage): string {
  let out = "";
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)!;
    out += `${k}=${store.getItem(k)};`;
  }
  return out;
}

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

describe("acceptance-link documents: neither SDK ever initializes", () => {
  for (const storage of ["working", "throws"] as const) {
    it(`full-page load of the acceptance link (sessionStorage ${storage}): no Sentry.init, no posthog.init; address bar clean`, () => {
      const env = installWindow(ACCEPT_URL, { storage });
      require("../instrumentation-client");
      mountPostHogProvider();
      expect(atInit.sentry).toBeUndefined();
      expect(atInit.posthog).toBeUndefined();
      expect(env.location.href).toBe(`https://convergepanel.com${ACCEPT}`);
      expect(env.calls).toEqual([ACCEPT]); // replaceState, never pushState
    });
  }

  it("the decision follows the navigation entry: after a client-side navigation away, telemetry still never starts in that document", () => {
    const env = installWindow(ACCEPT_URL);
    require("../instrumentation-client");
    env.location.pathname = "/workspace/team/ws-1"; // router.replace after a successful acceptance
    env.location.hash = "";
    mountPostHogProvider();
    expect(atInit.sentry).toBeUndefined();
    expect(atInit.posthog).toBeUndefined();
  });

  it("the post-login return to the acceptance page (no fragment, full load) is also telemetry-free", () => {
    installWindow(ACCEPT);
    require("../instrumentation-client");
    mountPostHogProvider();
    expect(atInit.sentry).toBeUndefined();
    expect(atInit.posthog).toBeUndefined();
  });

  it("without a navigation entry (no Performance API) the loaded pathname decides", () => {
    installWindow(ACCEPT_URL, { navigation: "none" });
    require("../instrumentation-client");
    mountPostHogProvider();
    expect(atInit.sentry).toBeUndefined();
    expect(atInit.posthog).toBeUndefined();
  });

  it("an unreadable Performance API falls back to the pathname; a trailing-slash acceptance URL is covered", () => {
    installWindow(`${ACCEPT}/#invitationId=${INV_ID}&token=${TOKEN}`, { navigation: "throws" });
    require("../instrumentation-client");
    mountPostHogProvider();
    expect(atInit.sentry).toBeUndefined();
    expect(atInit.posthog).toBeUndefined();
  });

  it("the credential is not moved into any persistent or semi-persistent browser store by the scrub", () => {
    const env = installWindow(ACCEPT_URL);
    require("../instrumentation-client");
    expect(dump(env.session)).not.toContain(TOKEN);
    expect(dump(env.local)).not.toContain(TOKEN);
    expect(env.doc.cookie).not.toContain(TOKEN);
    expect(JSON.stringify((g.window.history as any).state ?? null)).not.toContain(TOKEN);
  });

  it("the acceptance page receives the credential from the one-time in-memory hand-off, exactly once", () => {
    installWindow(ACCEPT_URL);
    require("../instrumentation-client");
    const { takeCapturedInvitationCredential } = require("@/lib/client/invitationAcceptance");
    expect(takeCapturedInvitationCredential()).toEqual({ kind: "valid", invitationId: INV_ID, token: TOKEN });
    expect(takeCapturedInvitationCredential()).toBeNull();
  });

  it("a malformed credential fragment is removed and handed off as invalid (fail closed, never a stored fallback)", () => {
    const env = installWindow(`${ACCEPT}#invitationId=${INV_ID}&token=${TOKEN}&token=second`);
    require("../instrumentation-client");
    expect(env.location.href).toBe(`https://convergepanel.com${ACCEPT}`);
    const { takeCapturedInvitationCredential } = require("@/lib/client/invitationAcceptance");
    expect(takeCapturedInvitationCredential()).toEqual({ kind: "invalid" });
  });
});

describe("every other document: both SDKs initialize, with a clean URL", () => {
  it("a credential-shaped fragment on another path is dropped and never handed off; correction round (NIT-1): its navigation entry keeps it, so that document is telemetry-free too", () => {
    const env = installWindow(`/workspace#invitationId=${INV_ID}&token=${TOKEN}`);
    require("../instrumentation-client");
    mountPostHogProvider();
    expect(env.location.href).toBe("https://convergepanel.com/workspace");
    expect(atInit.sentry).toBeUndefined();
    expect(atInit.posthog).toBeUndefined();
    const { takeCapturedInvitationCredential } = require("@/lib/client/invitationAcceptance");
    expect(takeCapturedInvitationCredential()).toBeNull();
  });

  it("a document loaded elsewhere that later soft-navigates to the acceptance page keeps its telemetry (decided once, from its own navigation entry)", () => {
    const env = installWindow("/workspace");
    require("../instrumentation-client");
    env.location.pathname = ACCEPT;
    mountPostHogProvider();
    expect(atInit.sentry?.href).toBe("https://convergepanel.com/workspace");
    expect(atInit.posthog).toBeDefined();
  });
});
