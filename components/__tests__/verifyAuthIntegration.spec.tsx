/**
 * Privacy remediation round 2 (review B1 + B3) — INTEGRATION: the REAL
 * `PostHogProvider` + `AuthProvider` + `/verify` page rendered together, driven
 * through the extension → signup/login → app flow with a synthetic sentinel
 * claim. This is the gap the round-1 review found: unit tests of the prefill
 * helper passed while AuthProvider's anonymous `null` callback erased it.
 *
 * Proven, for anonymous and signed-in visitors, successful and failed login,
 * reloads, cancellation, retries and expiry:
 *   - the text survives the auth detour and is restored on return;
 *   - it never appears in any PostHog event AFTER the real `before_send`, in
 *     the signup/login hrefs, in `history.replaceState` URLs, in any console
 *     output, or in localStorage after sign-out;
 *   - it is consumed once used / cancelled, removed when another account
 *     appears, and gone after its expiry.
 * R3: the /verify -> app hand-off no longer carries the claim in the URL
 * (owner D5); asserted on the router.push argument.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

// Several full React trees per test; the default 5 s is tight under full-suite load (observed transient timeouts).
jest.setTimeout(30_000);

const CLAIM = "SYNTHETIC_SENTINEL_CLAIM the tides are caused by wind farms";
const SENTINEL = "SYNTHETIC_SENTINEL_CLAIM";

// ── firebase/auth: capture the real AuthProvider's onIdTokenChanged callback ──
let tokenCallback: ((user: any) => Promise<void>) | undefined;
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_a: unknown, cb: any) => {
    tokenCallback = cb;
    return () => undefined;
  },
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: async () => undefined,
}));
jest.mock("@/lib/firebase/client", () => ({ auth: {} }));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/sessionSync", () => ({
  establishServerSession: async (user: any) => ({ ok: true, uid: user.uid }),
  clearServerSession: async () => true,
}));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));

// ── posthog-js: record every capture; the test replays it through the REAL before_send ──
let phConfig: any;
const phCaptured: any[] = [];
const mockReset = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: (_k: string, c: any) => {
      phConfig = c;
    },
    capture: (event: string, properties: any) => phCaptured.push({ event, properties }),
    reset: () => mockReset(),
  },
}));
jest.mock("posthog-js/react", () => ({ PostHogProvider: ({ children }: any) => children }));

// ── next/navigation & next/link backed by the fake window ──
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => (globalThis as any).window.location.pathname,
  useSearchParams: () => new URLSearchParams((globalThis as any).window.location.search),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, onClick, children }: any) => require("react").createElement("a", { href, onClick }, children),
}));

import { PostHogProvider } from "@/components/PostHogProvider";
import { AuthProvider } from "@/components/AuthProvider";
import VerifyPage from "@/app/verify/page";
import { ContentHandoffMigrator } from "@/components/ContentHandoffMigrator";

const g = globalThis as any;
const SAVED_WINDOW = g.window;
const SAVED_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
let local: FakeStorage;
let session: FakeStorage;
let replaceUrls: string[];
let consoleSpies: jest.SpyInstance[];
let renderer: TestRenderer.ReactTestRenderer | undefined;

function setUrl(path: string) {
  const u = new URL(path, "https://convergepanel.com");
  g.window.location.pathname = u.pathname;
  g.window.location.search = u.search;
  g.window.location.hash = u.hash;
}

beforeEach(() => {
  jest.clearAllMocks();
  phCaptured.length = 0;
  replaceUrls = [];
  local = new FakeStorage();
  session = new FakeStorage();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic";
  g.window = {
    location: { origin: "https://convergepanel.com", pathname: "/", search: "", hash: "" },
    history: {
      state: { __NA: true },
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaceUrls.push(url);
        setUrl(url);
      },
    },
    localStorage: local,
    sessionStorage: session,
  };
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  jest.restoreAllMocks();
});
afterAll(() => {
  g.window = SAVED_WINDOW;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = SAVED_KEY;
});

/** Simulates a full page load of `path` (fresh React tree, fresh AuthProvider). */
function load(path: string) {
  if (renderer) act(() => renderer!.unmount());
  tokenCallback = undefined;
  setUrl(path);
  act(() => {
    renderer = TestRenderer.create(
      createElement(PostHogProvider, null, createElement(AuthProvider, null, createElement(ContentHandoffMigrator), createElement(VerifyPage)))
    );
  });
  expect(typeof tokenCallback).toBe("function");
}
async function auth(user: { uid: string } | null) {
  await act(async () => {
    await tokenCallback!(user);
  });
}
function textarea(): string {
  return renderer!.root.findByProps({ id: "verify-text" }).props.value;
}
function button(label: string) {
  return renderer!.root.find((n) => n.type === "button" && JSON.stringify(n.props.children ?? "").includes(label));
}
function links(): string[] {
  return renderer!.root.findAll((n) => n.type === "a").map((n) => String(n.props.href));
}
function telemetryAfterBeforeSend(): string {
  return JSON.stringify(phCaptured.map((e) => phConfig.before_send(JSON.parse(JSON.stringify(e)))));
}
function consoleOutput(): string {
  return JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));
}
function assertNoLeak() {
  expect(telemetryAfterBeforeSend()).not.toContain(SENTINEL);
  expect(JSON.stringify(replaceUrls)).not.toContain(SENTINEL);
  expect(JSON.stringify(links())).not.toContain(SENTINEL);
  expect(consoleOutput()).not.toContain(SENTINEL);
  expect(g.window.location.search + g.window.location.hash).not.toContain(SENTINEL);
  expect(JSON.stringify(local.keys().map((k) => local.getItem(k)))).not.toContain(SENTINEL);
}

const EXT = `/verify?source=extension&text=${encodeURIComponent(CLAIM)}`;

describe("/verify + AuthProvider + PostHog — extension flow", () => {
  it("anonymous: text survives the anonymous null callback, the signup detour and sign-in; Run consumes it; nothing leaks", async () => {
    load(EXT);
    await auth(null); // anonymous cold load (the round-1 B1 bug erased the text here)
    expect(textarea()).toBe(CLAIM);
    expect(g.window.location.search).toBe("?source=extension");
    expect(links()).toEqual(expect.arrayContaining(["/signup?redirect=%2Fverify%3Fsource%3Dextension", "/login?redirect=%2Fverify%3Fsource%3Dextension"]));
    assertNoLeak();

    // signup page (separate load), account created and signed in there
    load("/signup?redirect=%2Fverify%3Fsource%3Dextension");
    await auth(null);
    await auth({ uid: "uid-new" });
    // redirected back to /verify (fresh load)
    load("/verify?source=extension");
    await auth({ uid: "uid-new" });
    expect(textarea()).toBe(CLAIM);
    assertNoLeak();

    act(() => button("Run Claim Verification").props.onClick());
    expect(session.getItem("convergePanelVerifyPendingV2")).toBeNull(); // one-time consumption of the pending input
    expect(session.getItem("convergePanelAppHandoffV1")).toContain(SENTINEL); // handed to the main app, tab-scoped
    // R3 (owner D5): the claim travels in the one-time tab-scoped hand-off, not the URL
    expect(mockPush).toHaveBeenCalledWith("/?tab=verify");
    expect(JSON.stringify(mockPush.mock.calls)).not.toContain(SENTINEL);
    // retry from a reload: nothing left to resurrect
    load("/verify?source=extension");
    await auth({ uid: "uid-new" });
    expect(textarea()).toBe("");
    assertNoLeak();
  });

  it("failed login: still anonymous, the text survives a page reload; sign-out of a later account removes it", async () => {
    load(EXT);
    await auth(null);
    load("/login?redirect=%2Fverify%3Fsource%3Dextension");
    await auth(null); // wrong password: no identity ever appears
    load("/verify?source=extension"); // user gives up and reloads /verify
    await auth(null);
    expect(textarea()).toBe(CLAIM);
    // now signs in successfully, then signs out without running
    await auth({ uid: "uid-a" });
    await auth(null);
    expect(session.length).toBe(0);
    expect(mockReset).toHaveBeenCalledTimes(1);
    load("/verify?source=extension");
    await auth(null);
    expect(textarea()).toBe("");
    assertNoLeak();
  });

  it("a different account appearing removes a pending input bound to another account", async () => {
    load("/verify?source=extension");
    await auth({ uid: "uid-a" });
    setUrl(EXT);
    load(EXT); // extension link while A is signed in -> bound to A once auth resolves
    await auth({ uid: "uid-a" });
    expect(textarea()).toBe(CLAIM);
    await auth({ uid: "uid-b" }); // direct account switch in this tab
    expect(session.length).toBe(0);
    load("/verify?source=extension");
    await auth({ uid: "uid-b" });
    expect(textarea()).toBe("");
    assertNoLeak();
  });

  it("cancellation: 'Discard text' and 'Open Main App' both remove it", async () => {
    load(EXT);
    await auth({ uid: "uid-a" });
    act(() => button("Discard text").props.onClick());
    expect(session.length).toBe(0);
    expect(textarea()).toBe("");

    load(EXT);
    await auth({ uid: "uid-a" });
    const openMain = renderer!.root.find((n) => n.type === "a" && n.props.href === "/");
    act(() => openMain.props.onClick());
    expect(session.length).toBe(0);
    assertNoLeak();
  });

  it("an abandoned pending input is not retained past its expiry", async () => {
    // Pin the clock BEFORE capture: the record's expiry is stamped at capture time, and under
    // full-suite load capture can run milliseconds after an unpinned t0 (observed flake).
    const t0 = 1_800_000_000_000;
    const clock = jest.spyOn(Date, "now").mockReturnValue(t0);
    load(EXT);
    await auth(null);
    expect(session.length).toBe(1);
    clock.mockReturnValue(t0 + 15 * 60 * 1000); // exactly at expiry: no longer live
    load("/verify?source=extension");
    await auth(null);
    expect(textarea()).toBe("");
    expect(session.length).toBe(0);
  });

  it("edits survive the detour (the edited text, not the original, is restored)", async () => {
    load(EXT);
    await auth(null);
    act(() => renderer!.root.findByProps({ id: "verify-text" }).props.onChange({ target: { value: "SYNTHETIC_SENTINEL_CLAIM edited" } }));
    load("/verify?source=extension");
    await auth({ uid: "uid-a" });
    expect(textarea()).toBe("SYNTHETIC_SENTINEL_CLAIM edited");
    assertNoLeak();
  });

  it("control: the pageview for the extension landing IS captured (telemetry still flows), with the text redacted", async () => {
    load(EXT);
    await auth(null);
    const pageviews = phCaptured.filter((e) => e.event === "$pageview");
    expect(pageviews.length).toBeGreaterThan(0);
    const sent = phConfig.before_send(JSON.parse(JSON.stringify(pageviews[0])));
    expect(sent.properties.$current_url).toBe("https://convergepanel.com/verify?source=extension&text=[redacted]");
  });
});
