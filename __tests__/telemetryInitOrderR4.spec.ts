/**
 * PR #329 R4 (review MAJOR-1 + MINOR-1) — initialization ORDER. R3 relied on
 * the layout's ContentHandoffMigrator layout effect running before PostHog's
 * init effect; on a full page load the migrator sits in a Suspense boundary and
 * can hydrate later, so that claim was false. R4 makes each SDK's own init site
 * scrub the URL synchronously first:
 *   - `instrumentation-client.ts` (Sentry; prepended to the `main-app` entry in
 *     production, so it runs before hydration) scrubs before `Sentry.init`;
 *   - `PostHogProvider` scrubs immediately before `posthog.init`.
 * Each test records what `window.location.href` / `document.referrer` were AT
 * THE MOMENT the SDK's init was called. The migrator is not rendered.
 * Synthetic sentinels only.
 */
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

const SENTINEL = "ZQX7ORDERSENTINEL";
const CLAIM = `vaccines contain ${SENTINEL} microchips`;
const UTM = "utm_source=newsletter&utm_campaign=Spring%20Sale";

const atInit: Record<string, { href: string; referrer: string }> = {};
const snapshot = (who: string) => {
  const w = (globalThis as any).window;
  atInit[who] = { href: String(w.location.href), referrer: String(w.document?.referrer ?? "") };
};

jest.mock("@sentry/nextjs", () => ({
  init: () => snapshot("sentry"),
  addEventProcessor: () => undefined,
  replayIntegration: () => ({ name: "Replay" }),
  captureRouterTransitionStart: () => undefined,
}));
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { init: () => snapshot("posthog"), capture: () => undefined },
}));
jest.mock("posthog-js/react", () => ({ PostHogProvider: ({ children }: any) => children }));
jest.mock("next/navigation", () => ({
  usePathname: () => (globalThis as any).window.location.pathname,
  useSearchParams: () => new URLSearchParams((globalThis as any).window.location.search),
}));

const g = globalThis as any;
const SAVED_WINDOW = g.window;
const SAVED_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const SAVED_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

function installWindow(path: string, opts: { storage: "working" | "throws"; referrer?: string }) {
  const u = new URL(path, "https://convergepanel.com");
  const location: any = { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
  Object.defineProperty(location, "href", { get: () => `${u.origin}${location.pathname}${location.search}${location.hash}` });
  const history = {
    state: null as unknown,
    replaceState(data: unknown, _t: string, url: string) {
      history.state = data;
      const n = new URL(url, u.origin);
      location.pathname = n.pathname;
      location.search = n.search;
      location.hash = n.hash;
    },
  };
  const session = new FakeStorage();
  g.window = { location, history, document: { referrer: opts.referrer ?? "" }, localStorage: new FakeStorage() };
  Object.defineProperty(g.window, "sessionStorage", {
    get: () => {
      if (opts.storage === "throws") throw new Error("SecurityError");
      return session;
    },
  });
}

beforeEach(() => {
  jest.resetModules();
  for (const k of Object.keys(atInit)) delete atInit[k];
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic";
  process.env.NEXT_PUBLIC_VERCEL_ENV = "production"; // ZCA R2 Phase B: analytics runs only in Vercel Production
});
afterAll(() => {
  g.window = SAVED_WINDOW;
  if (SAVED_DSN === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = SAVED_DSN;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = SAVED_KEY;
  delete process.env.NEXT_PUBLIC_VERCEL_ENV;
});

/** React + test renderer from the CURRENT module registry (beforeEach resets modules). */
function freshReact() {
  const React = require("react");
  const TR = require("react-test-renderer");
  return { createElement: React.createElement, TestRenderer: TR.default ?? TR, act: TR.act };
}

const CASES: Array<[string, string, string]> = [
  ["extension #text=", `/verify?source=extension&${UTM}#text=${encodeURIComponent(CLAIM)}`, `/verify?source=extension&${UTM}`],
  ["legacy /verify?text=", `/verify?text=${encodeURIComponent(CLAIM)}&${UTM}`, `/verify?${UTM}`],
  ["legacy /?tab=verify&claim=", `/?tab=verify&claim=${encodeURIComponent(CLAIM)}&${UTM}`, `/?tab=verify&${UTM}`],
  ["legacy /?tab=research&q=", `/?tab=research&q=${encodeURIComponent(CLAIM)}&${UTM}`, `/?tab=research&${UTM}`],
];

describe("Sentry: instrumentation-client.ts scrubs before Sentry.init", () => {
  for (const storage of ["working", "throws"] as const) {
    for (const [label, path, clean] of CASES) {
      it(`${label} (sessionStorage ${storage})`, () => {
        installWindow(path, { storage });
        require("../instrumentation-client");
        expect(atInit.sentry).toBeDefined();
        expect(atInit.sentry.href).toBe(`https://convergepanel.com${clean}`);
      });
    }
  }
});

describe("PostHog: PostHogProvider scrubs immediately before posthog.init (no migrator rendered)", () => {
  for (const storage of ["working", "throws"] as const) {
    for (const [label, path, clean] of CASES) {
      it(`${label} (sessionStorage ${storage})`, () => {
        installWindow(path, { storage });
        const { PostHogProvider } = require("@/components/PostHogProvider");
        const { createElement, TestRenderer, act } = freshReact();
        let r: any;
        act(() => {
          r = TestRenderer.create(createElement(PostHogProvider, null, createElement("div")));
        });
        expect(atInit.posthog).toBeDefined();
        expect(atInit.posthog.href).toBe(`https://convergepanel.com${clean}`);
        act(() => r!.unmount());
      });
    }
  }

  it("a same-origin referrer that carried claim text is sanitized before posthog.init ($initial_referrer)", () => {
    installWindow("/verify?source=extension", { storage: "working", referrer: `https://convergepanel.com/?tab=verify&claim=${encodeURIComponent(CLAIM)}` });
    const { PostHogProvider } = require("@/components/PostHogProvider");
    const { createElement, TestRenderer, act } = freshReact();
    act(() => {
      TestRenderer.create(createElement(PostHogProvider, null, createElement("div")));
    });
    expect(atInit.posthog.referrer).not.toContain(SENTINEL);
  });
});
