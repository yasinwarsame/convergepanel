/**
 * GHSA-655j-5f43-92pw — the workspace-invitation acceptance credential
 * (`/workspace-invitations/accept#invitationId=…&token=…`) must be gone from the
 * address bar BEFORE either telemetry SDK initializes, and must reach the
 * acceptance page through a one-time, in-memory, non-persistent hand-off.
 *
 * Records `window.location.href` / `document.referrer` at the moment `Sentry.init`
 * and `posthog.init` are called (the paths `before_send` / `beforeSend` cannot
 * reach: pageload span, Replay meta event, `$initial_person_info`, `/flags`,
 * the persistence cookie). Synthetic credential only.
 */
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

const TOKEN = "ZQX7INVITETOKENSENTINEL_abc-123";
const INV_ID = "inv_SYNTHETIC_0001";
const ACCEPT = "/workspace-invitations/accept";
const ACCEPT_URL = `${ACCEPT}#invitationId=${INV_ID}&token=${TOKEN}`;

const atInit: Record<string, { href: string; referrer: string; hash: string }> = {};
const snapshot = (who: string) => {
  const w = (globalThis as any).window;
  atInit[who] = { href: String(w.location.href), referrer: String(w.document?.referrer ?? ""), hash: String(w.location.hash) };
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
  usePathname: () => "/workspace-invitations/accept",
  useSearchParams: () => new URLSearchParams(""),
}));

const g = globalThis as any;
const SAVED_WINDOW = g.window;
const SAVED_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const SAVED_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

function installWindow(path: string, opts: { storage: "working" | "throws"; referrer?: string } = { storage: "working" }) {
  const u = new URL(path, "https://convergepanel.com");
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
  const session = new FakeStorage();
  const local = new FakeStorage();
  const doc = { referrer: opts.referrer ?? "", cookie: "" };
  g.window = { location, history, document: doc, localStorage: local };
  Object.defineProperty(g.window, "sessionStorage", {
    get: () => {
      if (opts.storage === "throws") throw new Error("SecurityError");
      return session;
    },
  });
  return { session, local, doc, calls };
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

describe("Sentry: the invitation credential is gone before Sentry.init", () => {
  for (const storage of ["working", "throws"] as const) {
    it(`full-page load of the acceptance link (sessionStorage ${storage})`, () => {
      const env = installWindow(ACCEPT_URL, { storage });
      require("../instrumentation-client");
      expect(atInit.sentry).toBeDefined();
      expect(atInit.sentry.href).toBe(`https://convergepanel.com${ACCEPT}`);
      expect(atInit.sentry.href).not.toContain(TOKEN);
      expect(atInit.sentry.hash).toBe("");
      // replaceState (never pushState): no credential-bearing history entry remains for back/forward.
      expect(env.calls).toEqual([ACCEPT]);
    });
  }

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

  it("a malformed credential fragment is still removed and handed off as invalid (fail closed, never a stored fallback)", () => {
    installWindow(`${ACCEPT}#invitationId=${INV_ID}&token=${TOKEN}&token=second`);
    require("../instrumentation-client");
    expect(atInit.sentry.href).toBe(`https://convergepanel.com${ACCEPT}`);
    const { takeCapturedInvitationCredential } = require("@/lib/client/invitationAcceptance");
    expect(takeCapturedInvitationCredential()).toEqual({ kind: "invalid" });
  });

  it("a credential-shaped fragment on any OTHER path is dropped and never handed off", () => {
    installWindow(`/workspace#invitationId=${INV_ID}&token=${TOKEN}`);
    require("../instrumentation-client");
    expect(atInit.sentry.href).toBe("https://convergepanel.com/workspace");
    const { takeCapturedInvitationCredential } = require("@/lib/client/invitationAcceptance");
    expect(takeCapturedInvitationCredential()).toBeNull();
  });
});

describe("PostHog: the invitation credential is gone before posthog.init (no app effect relied on)", () => {
  for (const storage of ["working", "throws"] as const) {
    it(`PostHogProvider alone, full-page load of the acceptance link (sessionStorage ${storage})`, () => {
      installWindow(ACCEPT_URL, { storage });
      const React = require("react");
      const TR = require("react-test-renderer");
      const { PostHogProvider } = require("@/components/PostHogProvider");
      let r: any;
      TR.act(() => {
        r = (TR.default ?? TR).create(React.createElement(PostHogProvider, null, React.createElement("div")));
      });
      expect(atInit.posthog).toBeDefined();
      expect(atInit.posthog.href).toBe(`https://convergepanel.com${ACCEPT}`);
      expect(atInit.posthog.href).not.toContain(TOKEN);
      TR.act(() => r.unmount());
    });
  }
});
