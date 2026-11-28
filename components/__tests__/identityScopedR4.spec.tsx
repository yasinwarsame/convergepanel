/**
 * PR #329 R4 (owner A2) — account switching on /verify and on the frozen home
 * page. Every committed frame is recorded (`<Profiler>`), so one transient frame
 * showing another account's text fails the test. Rendered: the REAL
 * AuthProvider, the REAL /verify page, the REAL IdentityScopedRoute. Synthetic
 * sentinels only.
 *
 *  - Signed-out typing is never saved under a previous account's identity
 *    (R3 MINOR-3: `updatePendingVerifyInput` kept the old record's binding).
 *  - Blocked / throwing sessionStorage: /verify shows an ordinary
 *    "paste the claim manually" notice; the in-memory hold is identity-bound.
 *  - The frozen `app/page.tsx` keeps React state (claimInput / question) across
 *    an identity change (pre-existing). The root layout now scopes the "/" page
 *    subtree to the identity: a different identity mounts a fresh page; the same
 *    identity (token refresh) and the first identity of a cold load keep it.
 */
import { Profiler, createElement, useState, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "fs";
import { join } from "path";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

jest.setTimeout(30_000);

const A_CLAIM = "SENTINEL_R4_ACCOUNT_A tides follow wind farms";
const ANON_TYPED = "SENTINEL_R4_ANON_TYPED the moon is hollow";
const A_DRAFT = "SENTINEL_R4_A_DRAFT question from account A";

let tokenCallback: ((user: any) => Promise<void>) | undefined;
const mockFirebaseAuth = { currentUser: null as unknown };
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_a: unknown, cb: any) => {
    // Firebase sets currentUser before notifying observers.
    tokenCallback = (u: any) => {
      mockFirebaseAuth.currentUser = u;
      return cb(u);
    };
    return () => undefined;
  },
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: async () => undefined,
}));
// R-S0-7: AuthProvider signs out only while Firebase still reports the failed User object, so the double exposes currentUser.
jest.mock("@/lib/firebase/client", () => ({
  get auth() {
    return mockFirebaseAuth;
  },
}));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/sessionSync", () => ({
  establishServerSession: async (user: any) => ({ ok: true, uid: user.uid }),
}));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined, capture: () => undefined, init: () => undefined } }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => (globalThis as any).window.location.pathname,
  useSearchParams: () => new URLSearchParams((globalThis as any).window.location.search),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, onClick, children }: any) => require("react").createElement("a", { href, onClick }, children),
}));

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import VerifyPage from "@/app/verify/page";
import { VERIFY_PENDING_STORAGE_KEY } from "@/lib/client/verifyPrefill";

let IdentityScopedRoute: (p: { children: ReactNode }) => any = ({ children }) => children; // pre-fix tree: no scoping
try {
  IdentityScopedRoute = require("@/components/IdentityScopedRoute").IdentityScopedRoute;
} catch {
  /* pre-fix tree */
}

const g = globalThis as any;
const SAVED_WINDOW = g.window;
let session: FakeStorage;
let sessionMode: "working" | "throws";
let renderer: TestRenderer.ReactTestRenderer | undefined;
type Frame = { authReady: boolean; uid: string | null; text: string };
let frames: Frame[];
let lastAuth = { authReady: false, uid: null as string | null };

function AuthProbe() {
  const { authReady, user } = useAuth();
  lastAuth = { authReady, uid: user?.uid ?? null };
  return null;
}
function allText(): string {
  return JSON.stringify(renderer?.toJSON() ?? null);
}
function textareaValue(): string {
  try {
    return String(renderer!.root.findByProps({ id: "verify-text" }).props.value ?? "");
  } catch {
    return "";
  }
}
function setUrl(path: string) {
  const u = new URL(path, "https://convergepanel.com");
  g.window.location.pathname = u.pathname;
  g.window.location.search = u.search;
  g.window.location.hash = u.hash;
}

beforeEach(() => {
  require("@/lib/client/verifyPrefill").__resetTabHandoffMemoryForTests?.();
  session = new FakeStorage();
  sessionMode = "working";
  frames = [];
  g.window = {
    location: { origin: "https://convergepanel.com", pathname: "/", search: "", hash: "" },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => setUrl(url) },
    localStorage: new FakeStorage(),
    document: { referrer: "" },
  };
  Object.defineProperty(g.window, "sessionStorage", {
    configurable: true,
    get: () => {
      if (sessionMode === "throws") throw new Error("SecurityError");
      return session;
    },
  });
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

function mount(path: string, tree: () => ReactNode) {
  if (renderer) act(() => renderer!.unmount());
  tokenCallback = undefined;
  setUrl(path);
  // Full page load: the pre-telemetry scrub runs first (instrumentation-client.ts).
  try {
    require("@/lib/privacy/preTelemetryUrlScrub").scrubUrlBeforeTelemetry(g.window);
  } catch {
    /* pre-fix tree */
  }
  act(() => {
    renderer = TestRenderer.create(
      createElement(Profiler, { id: "r4", onRender: () => frames.push({ ...lastAuth, text: allText() }) }, createElement(AuthProvider, null, createElement(AuthProbe), tree()))
    );
  });
}
async function auth(user: { uid: string } | null) {
  await act(async () => {
    await tokenCallback!(user);
  });
}
function type(value: string) {
  act(() => renderer!.root.findByProps({ id: "verify-text" }).props.onChange({ target: { value } }));
}
function assertFrames(needle: string, allowed: (f: Frame) => boolean) {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter((f) => f.text.includes(needle) && !allowed(f)).map((f) => ({ ...f, text: "<redacted>" }))).toEqual([]);
}

describe("A2 /verify — signed-out typing is never saved under a previous account", () => {
  it("reopened tab holding A's bound record, anonymous visitor types: the record is no longer A's", async () => {
    session.setItem(VERIFY_PENDING_STORAGE_KEY, JSON.stringify({ v: 2, text: A_CLAIM, boundUid: "uid-a", expiresAt: Date.now() + 60_000 }));
    mount("/verify", () => createElement(VerifyPage));
    await auth(null);
    expect(textareaValue()).toBe(""); // A's text is not shown to the anonymous visitor (R3 guard)
    type(ANON_TYPED);
    const rec = JSON.parse(session.getItem(VERIFY_PENDING_STORAGE_KEY)!);
    expect(rec.text).toBe(ANON_TYPED);
    expect(rec.boundUid).toBeNull(); // R3 wrote it bound to "uid-a"
    assertFrames("SENTINEL_R4_ACCOUNT_A", () => false);
  });

  it("A signed in, then signs out (expired / revoked session): anonymous typing is unbound and A's text is gone", async () => {
    mount(`/verify?source=extension#text=${encodeURIComponent(A_CLAIM)}`, () => createElement(VerifyPage));
    await auth({ uid: "uid-a" });
    expect(textareaValue()).toBe(A_CLAIM);
    await auth(null);
    expect(textareaValue()).toBe("");
    type(ANON_TYPED);
    expect(JSON.parse(session.getItem(VERIFY_PENDING_STORAGE_KEY)!).boundUid).toBeNull();
    assertFrames("SENTINEL_R4_ACCOUNT_A", (f) => f.authReady && f.uid === "uid-a");
  });

  it("anonymous typing, then account B signs in: B (the first account) gets it; a later account C does not", async () => {
    mount("/verify", () => createElement(VerifyPage));
    await auth(null);
    type(ANON_TYPED);
    await auth({ uid: "uid-b" });
    expect(textareaValue()).toBe(ANON_TYPED);
    await auth({ uid: "uid-c" });
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_R4_ANON_TYPED", (f) => f.authReady && (f.uid === null || f.uid === "uid-b"));
  });

  it("signed-in A edits, then a direct switch to B: B never sees A's edit", async () => {
    mount("/verify", () => createElement(VerifyPage));
    await auth({ uid: "uid-a" });
    type(A_CLAIM);
    await auth({ uid: "uid-b" });
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_R4_ACCOUNT_A", (f) => f.authReady && f.uid === "uid-a");
  });
});

describe("A1/A2 /verify — blocked sessionStorage: fail closed with an ordinary paste-manually notice", () => {
  const NOTICE = "paste the claim";

  it("extension hand-off with storage that throws: text shown for this page only, notice shown, URL clean", async () => {
    sessionMode = "throws";
    mount(`/verify?source=extension#text=${encodeURIComponent(A_CLAIM)}`, () => createElement(VerifyPage));
    expect(g.window.location.hash).toBe("");
    await auth(null);
    expect(textareaValue()).toBe(A_CLAIM);
    expect(allText().toLowerCase()).toContain(NOTICE);
  });

  it("after a reload with storage blocked the text is gone and the notice asks for a manual paste", async () => {
    sessionMode = "throws";
    mount(`/verify?source=extension#text=${encodeURIComponent(A_CLAIM)}`, () => createElement(VerifyPage));
    await auth(null);
    require("@/lib/client/verifyPrefill").__resetTabHandoffMemoryForTests?.(); // a reload starts a new document
    mount("/verify?source=extension", () => createElement(VerifyPage));
    await auth(null);
    expect(textareaValue()).toBe("");
    expect(allText().toLowerCase()).toContain(NOTICE);
  });

  it("blocked storage, the memory hold is identity-bound: A -> B never shows A's text", async () => {
    sessionMode = "throws";
    mount(`/verify?source=extension#text=${encodeURIComponent(A_CLAIM)}`, () => createElement(VerifyPage));
    await auth({ uid: "uid-a" });
    expect(textareaValue()).toBe(A_CLAIM);
    await auth({ uid: "uid-b" });
    expect(textareaValue()).toBe("");
    assertFrames("SENTINEL_R4_ACCOUNT_A", (f) => f.authReady && f.uid === "uid-a");
  });

  it("control: with working storage there is no notice", async () => {
    mount(`/verify?source=extension#text=${encodeURIComponent(A_CLAIM)}`, () => createElement(VerifyPage));
    await auth(null);
    expect(allText().toLowerCase()).not.toContain(NOTICE);
  });
});

/** Stands in for the frozen home page's `claimInput` / `question` React state. */
function Draft() {
  const [draft, setDraft] = useState("");
  return createElement("textarea", { id: "draft", value: draft, onChange: (e: any) => setDraft(e.target.value) });
}
function draftValue(): string {
  return String(renderer!.root.findByProps({ id: "draft" }).props.value ?? "");
}
function typeDraft(v: string) {
  act(() => renderer!.root.findByProps({ id: "draft" }).props.onChange({ target: { value: v } }));
}
const home = () => createElement(IdentityScopedRoute, null, createElement(Draft));

describe("A2 frozen home page — React state is scoped to the identity on '/'", () => {
  it("A -> B direct switch: A's draft is in no frame where B is active", async () => {
    mount("/", home);
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth({ uid: "uid-b" });
    expect(draftValue()).toBe("");
    assertFrames("SENTINEL_R4_A_DRAFT", (f) => f.authReady && f.uid === "uid-a");
  });

  it("A signs out (or the session expires): the anonymous view does not keep A's draft", async () => {
    mount("/", home);
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth(null);
    expect(draftValue()).toBe("");
    assertFrames("SENTINEL_R4_A_DRAFT", (f) => f.authReady && f.uid === "uid-a");
  });

  it("A signs out, B signs in: B never sees A's draft", async () => {
    mount("/", home);
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth(null);
    await auth({ uid: "uid-b" });
    expect(draftValue()).toBe("");
    assertFrames("SENTINEL_R4_A_DRAFT", (f) => f.authReady && f.uid === "uid-a");
  });

  it("draft preservation: a same-account token refresh keeps the draft", async () => {
    mount("/", home);
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth({ uid: "uid-a" });
    expect(draftValue()).toBe(A_DRAFT);
  });

  it("draft preservation: a cold load's first identity does not remount the page", async () => {
    mount("/", home);
    typeDraft(A_DRAFT); // typed while auth is still resolving
    await auth({ uid: "uid-a" });
    expect(draftValue()).toBe(A_DRAFT);
  });

  // R5 (R4 review MINOR-1): the AuthProvider's 3 s cold-load timeout reports "no user" without Firebase having said so.
  // That anonymous state is PROVISIONAL (identity unknown): the persisted account resolving afterwards is the first
  // real identity of the page load and must not remount (it would erase the person's own draft).
  const coldTimeout = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3_100));
    });
  };
  it("R5 cold-load auth timeout, then the persisted account A resolves: A's draft is kept", async () => {
    mount("/", home);
    await coldTimeout();
    expect(lastAuth.authReady).toBe(true); // the timeout unblocked the shell
    typeDraft(A_DRAFT);
    await auth({ uid: "uid-a" });
    expect(draftValue()).toBe(A_DRAFT);
  });
  it("R5 cold-load auth timeout, then Firebase confirms 'signed out': the anonymous draft is kept", async () => {
    mount("/", home);
    await coldTimeout();
    typeDraft(A_DRAFT);
    await auth(null);
    expect(draftValue()).toBe(A_DRAFT);
  });
  it("R5 after a cold-load timeout, A -> B still remounts (no frame of A's draft under B)", async () => {
    mount("/", home);
    await coldTimeout();
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth({ uid: "uid-b" });
    expect(draftValue()).toBe("");
    assertFrames("SENTINEL_R4_A_DRAFT", (f) => f.authReady && f.uid === "uid-a");
  });
  it("R5 after a cold-load timeout, A -> signed out -> B still remounts at each step", async () => {
    mount("/", home);
    await coldTimeout();
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth(null);
    expect(draftValue()).toBe("");
    await auth({ uid: "uid-b" });
    expect(draftValue()).toBe("");
    assertFrames("SENTINEL_R4_A_DRAFT", (f) => f.authReady && f.uid === "uid-a");
  });

  it("other routes are not re-scoped (no unrelated behaviour change)", async () => {
    mount("/workspace", home);
    await auth({ uid: "uid-a" });
    typeDraft(A_DRAFT);
    await auth({ uid: "uid-a" });
    expect(draftValue()).toBe(A_DRAFT);
  });

  it("the root layout wraps the page children in IdentityScopedRoute; app/page.tsx itself is not edited for this", () => {
    const layout = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<IdentityScopedRoute>\s*\{children\}\s*<\/IdentityScopedRoute>/);
    expect(layout).toContain('import { IdentityScopedRoute } from "@/components/IdentityScopedRoute";');
    const page = readFileSync(join(__dirname, "../../app/page.tsx"), "utf8");
    expect(page).not.toContain("IdentityScopedRoute");
  });
});
