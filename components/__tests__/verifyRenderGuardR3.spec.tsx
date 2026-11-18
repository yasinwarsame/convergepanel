/**
 * Privacy remediation R3 (review MAJOR-2, owner A2/A4) — the /verify input at
 * the RENDERING boundary. Round 2 tested storage; the reviewer showed the
 * textarea could still display account A's claim after account B (or an
 * anonymous / not-yet-known identity) became active, because React kept the
 * old in-memory value.
 *
 * A `<Profiler>` records the textarea value and the auth state on EVERY
 * committed render, so a single transient frame showing the wrong content
 * fails the test. Rendered: the REAL AuthProvider, the layout's content
 * hand-off migrator, and the REAL /verify page. Synthetic sentinels only.
 */

import { Profiler, createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

jest.setTimeout(30_000);

const A_CLAIM = "SENTINEL_ACCOUNT_A_CLAIM tides are caused by wind farms";
const ANON_CLAIM = "SENTINEL_ANON_CLAIM the moon is hollow";

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
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined, capture: () => undefined, init: () => undefined } }));

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

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import VerifyPage from "@/app/verify/page";

// The layout's hand-off migrator (R3). Absent before the fix: render nothing in its place.
let Migrator: () => ReactNode = () => null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Migrator = require("@/components/ContentHandoffMigrator").ContentHandoffMigrator;
} catch {
  /* pre-fix tree */
}

const g = globalThis as any;
const SAVED_WINDOW = g.window;
let session: FakeStorage;
let local: FakeStorage;
let replaceUrls: string[];
let renderer: TestRenderer.ReactTestRenderer | undefined;

type Frame = { authReady: boolean; uid: string | null; value: string | null };
let frames: Frame[];
let lastAuth: { authReady: boolean; uid: string | null } = { authReady: false, uid: null };

function AuthProbe() {
  const { authReady, user } = useAuth();
  lastAuth = { authReady, uid: user?.uid ?? null };
  return null;
}

function textareaValue(): string | null {
  const json = renderer?.toJSON();
  let found: string | null = null;
  const walk = (n: any) => {
    if (!n || found !== null) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "textarea") {
      found = String(n.props.value ?? "");
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(json);
  return found;
}

function setUrl(path: string) {
  const u = new URL(path, "https://convergepanel.com");
  g.window.location.pathname = u.pathname;
  g.window.location.search = u.search;
  g.window.location.hash = u.hash;
}

beforeEach(() => {
  jest.clearAllMocks();
  session = new FakeStorage();
  local = new FakeStorage();
  replaceUrls = [];
  frames = [];
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
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  jest.restoreAllMocks();
});
afterAll(() => {
  g.window = SAVED_WINDOW;
});

/** A full page load of `path`: fresh tree, fresh AuthProvider, every commit recorded. */
function load(path: string) {
  if (renderer) act(() => renderer!.unmount());
  tokenCallback = undefined;
  setUrl(path);
  act(() => {
    renderer = TestRenderer.create(createElement("div"));
  });
  act(() => {
    renderer!.update(
      createElement(
        Profiler,
        { id: "verify", onRender: () => frames.push({ ...lastAuth, value: textareaValue() }) },
        createElement(AuthProvider, null, createElement(AuthProbe), createElement(Migrator), createElement(VerifyPage))
      )
    );
  });
}
async function auth(user: { uid: string } | null) {
  await act(async () => {
    await tokenCallback!(user);
  });
}
function seedPending(text: string, boundUid: string | null) {
  session.setItem("convergePanelVerifyPendingV2", JSON.stringify({ v: 2, text, boundUid, expiresAt: Date.now() + 10 * 60 * 1000 }));
}
/** No committed frame may show `needle` unless `allowed(frame)` holds. */
function assertFrames(needle: string, allowed: (f: Frame) => boolean) {
  expect(frames.length).toBeGreaterThan(0);
  const bad = frames.filter((f) => (f.value ?? "").includes(needle) && !allowed(f));
  expect(bad).toEqual([]);
}
const ext = (text: string) => `/verify?source=extension#text=${encodeURIComponent(text)}`;
const legacyExt = (text: string) => `/verify?source=extension&text=${encodeURIComponent(text)}`;

describe("A2 — identity-bound rendering of the /verify input (every committed frame)", () => {
  it("(1)/P1 account switch while mounted: A's claim never appears in a frame where B is active", async () => {
    load(ext(A_CLAIM));
    await auth({ uid: "uid-a" });
    expect(textareaValue()).toBe(A_CLAIM); // control: A sees their own text
    await auth({ uid: "uid-b" });
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_ACCOUNT_A", (f) => f.authReady && f.uid === "uid-a");
  });

  it("(4)/P2 A's session ends while mounted: the anonymous view never shows A's claim", async () => {
    load(ext(A_CLAIM));
    await auth({ uid: "uid-a" });
    await auth(null);
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_ACCOUNT_A", (f) => f.authReady && f.uid === "uid-a");
  });

  it("(5)/P3 reopened tab with A's bound record: nothing before auth resolves, nothing after B resolves", async () => {
    seedPending(A_CLAIM, "uid-a");
    load("/verify?source=extension");
    expect(textareaValue()).toBe(""); // identity unknown
    await auth({ uid: "uid-b" });
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_ACCOUNT_A", () => false);
  });

  it("(5)/P4 reopened tab with A's bound record, anonymous cold load: never shown", async () => {
    seedPending(A_CLAIM, "uid-a");
    load("/verify?source=extension");
    await auth(null);
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_ACCOUNT_A", () => false);
  });

  it("(2) identity unknown / not yet resolved: freshly arrived text is not rendered until auth is ready", async () => {
    load(ext(ANON_CLAIM));
    assertFrames("SENTINEL_ANON", (f) => f.authReady);
    await auth(null);
    expect(textareaValue()).toBe(ANON_CLAIM); // control: anonymous owner sees it once known
    assertFrames("SENTINEL_ANON", (f) => f.authReady);
  });

  it("(6)/(7) anonymous -> authenticated hand-off keeps working; the first claiming account sees it, a second does not", async () => {
    load(ext(ANON_CLAIM));
    await auth(null);
    load("/verify?source=extension"); // back from signup in the same tab
    await auth({ uid: "uid-first" });
    expect(textareaValue()).toBe(ANON_CLAIM);
    await auth({ uid: "uid-second" });
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_ANON", (f) => f.authReady && (f.uid === null || f.uid === "uid-first"));
  });

  it("(3) a stale React value cannot bypass storage cleanup: after B appears, storage is empty AND the DOM is empty", async () => {
    load(ext(A_CLAIM));
    await auth({ uid: "uid-a" });
    act(() => renderer!.root.findByProps({ id: "verify-text" }).props.onChange({ target: { value: `${A_CLAIM} edited` } }));
    await auth({ uid: "uid-b" });
    expect(JSON.stringify(session.keys().map((k) => session.getItem(k)))).not.toContain("SENTINEL_ACCOUNT_A");
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_ACCOUNT_A", (f) => f.authReady && f.uid === "uid-a");
  });

  it("(7) pending anonymous input is consumed once by Run and does not reappear on reload", async () => {
    load(ext(ANON_CLAIM));
    await auth({ uid: "uid-a" });
    act(() => renderer!.root.find((n) => n.type === "button" && JSON.stringify(n.props.children ?? "").includes("Run Claim Verification")).props.onClick());
    load("/verify?source=extension");
    await auth({ uid: "uid-a" });
    expect(textareaValue()).toBe("");
  });
});

describe("expiry sweep on mount (no auth callback needed)", () => {
  it("an expired record is removed from storage as soon as /verify mounts, even before auth resolves", () => {
    session.setItem("convergePanelVerifyPendingV2", JSON.stringify({ v: 2, text: A_CLAIM, boundUid: null, expiresAt: Date.now() - 1 }));
    load("/verify?source=extension");
    expect(session.getItem("convergePanelVerifyPendingV2")).toBeNull();
    assertFrames("SENTINEL_ACCOUNT_A", () => false);
  });
});

describe("A3 — fragment hand-off, legacy links, and the /verify -> app hand-off", () => {
  it("extension fragment: the text never reaches a URL after capture; the fragment is removed", async () => {
    load(ext(ANON_CLAIM));
    await auth(null);
    expect(g.window.location.hash).toBe("");
    expect(g.window.location.search).toBe("?source=extension");
    expect(JSON.stringify(replaceUrls)).not.toContain("SENTINEL_ANON");
  });

  it("legacy ?text= link: still accepted, stripped from the address bar, not lost", async () => {
    load(legacyExt(ANON_CLAIM));
    await auth(null);
    expect(g.window.location.search).toBe("?source=extension");
    expect(textareaValue()).toBe(ANON_CLAIM);
  });

  it("Run: navigates to /?tab=verify WITHOUT the claim in the URL; the claim travels in the tab-scoped hand-off", async () => {
    load(ext(ANON_CLAIM));
    await auth({ uid: "uid-a" });
    act(() => renderer!.root.find((n) => n.type === "button" && JSON.stringify(n.props.children ?? "").includes("Run Claim Verification")).props.onClick());
    expect(mockPush).toHaveBeenCalledWith("/?tab=verify");
    expect(JSON.stringify(mockPush.mock.calls)).not.toContain("SENTINEL_ANON");
    expect(JSON.stringify(session.keys().map((k) => session.getItem(k)))).toContain("SENTINEL_ANON");
  });

  it("Deep Research: navigates to /?tab=research WITHOUT the question in the URL", async () => {
    load(ext(ANON_CLAIM));
    await auth({ uid: "uid-a" });
    act(() => renderer!.root.find((n) => n.type === "button" && JSON.stringify(n.props.children ?? "").includes("Run Deep Research")).props.onClick());
    expect(mockPush).toHaveBeenCalledWith("/?tab=research");
  });

  it("legacy /?tab=verify&claim= link on the main app: moved to the hand-off and stripped at once, tab kept", () => {
    load(`/?tab=verify&claim=${encodeURIComponent(ANON_CLAIM)}`);
    expect(g.window.location.search).toBe("?tab=verify");
    expect(JSON.stringify(session.keys().map((k) => session.getItem(k)))).toContain("SENTINEL_ANON");
  });

  it("legacy /?tab=research&q= link: moved and stripped, tab kept", () => {
    load(`/?tab=research&q=${encodeURIComponent(ANON_CLAIM)}`);
    expect(g.window.location.search).toBe("?tab=research");
    expect(JSON.stringify(session.keys().map((k) => session.getItem(k)))).toContain("SENTINEL_ANON");
  });

  it("/verify with blocked sessionStorage: the URL keeps the text (survives reload) and the page still shows it", async () => {
    g.window.sessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    load(legacyExt(ANON_CLAIM));
    await auth(null);
    expect(g.window.location.search).toContain("text=");
    expect(textareaValue()).toBe(ANON_CLAIM); // in-memory fallback for this page
  });

  it("legacy links are NOT stripped when the hand-off cannot be stored (no silent loss)", () => {
    g.window.sessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    };
    load(`/?tab=verify&claim=${encodeURIComponent(ANON_CLAIM)}`);
    expect(g.window.location.search).toContain("claim=");
  });
});
