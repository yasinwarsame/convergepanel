/**
 * Stage 0 F3 — client availability compatibility of the hardened session mint.
 *
 * End to end in one process: the REAL `AuthProvider` (its real `onIdTokenChanged` callback, captured from a mocked
 * `firebase/auth`), the REAL `lib/client/sessionSync.ts`, and the REAL `POST`/`DELETE /api/auth/session` route
 * handlers, connected by a `fetch` double that keeps a single shared cookie jar (what every tab of the origin sees).
 * Only firebase-admin (`verifyIdToken` / `createSessionCookie`) and browser storage are doubles. Synthetic data only.
 *
 * Contract demonstrated:
 *  - routine SAME-uid refresh + mint "could not run" (503 auth_unavailable: outage code, deadline or cap) →
 *    keeps `authenticated` and the existing cookie, no Firebase sign-out (no other tab signed out, no lost
 *    /verify input), exactly one mint request (no retry), and the next token event re-attempts normally;
 *  - every other case stays fail closed exactly as before: initial sign-in, cold load, account switch, a
 *    revoked / disabled / invalid answer (401), a 500, a network error — the cookie is cleared and Firebase is
 *    signed out.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

let tokenCallback: ((user: any) => Promise<void>) | undefined;
const mockSignOut = jest.fn(async () => undefined);
const mockFirebaseAuth = { currentUser: null as unknown };
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_auth: unknown, cb: any) => {
    // Firebase sets currentUser before notifying observers.
    tokenCallback = (u: any) => {
      mockFirebaseAuth.currentUser = u;
      return cb(u);
    };
    return () => undefined;
  },
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: (...args: any[]) => (mockSignOut as any)(...args),
}));
// R-S0-7: AuthProvider signs out only while Firebase still reports the failed User object, so the double exposes currentUser.
jest.mock("@/lib/firebase/client", () => ({
  get auth() {
    return mockFirebaseAuth;
  },
}));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
const mockClientEvents: Array<[string, any]> = [];
jest.mock("@/lib/client/authSessionTelemetry", () => ({
  logAuthSessionClientEvent: (op: string, meta: any) => mockClientEvents.push([op, meta]),
}));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

// firebase-admin doubles behind the REAL session route.
const mockVerifyIdToken = jest.fn();
const mockCreateSessionCookie = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return {
      verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a),
      createSessionCookie: (...a: unknown[]) => mockCreateSessionCookie(...a),
      verifySessionCookie: jest.fn(),
    };
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST, DELETE } from "@/app/api/auth/session/route";
import { AuthProvider, useAuth } from "@/components/AuthProvider";

const g = globalThis as any;
const SAVED = { window: g.window, fetch: g.fetch };

// ── the shared browser cookie jar + fetch double wired to the real route ──
let jar: string | null;
let deleteFails: boolean;
let networkDown: boolean;
const calls: string[] = [];
async function fetchDouble(url: string, init: any = {}) {
  const method = init.method ?? "GET";
  calls.push(method);
  if (networkDown && method === "POST") throw new TypeError("Failed to fetch");
  if (method === "DELETE" && deleteFails) throw new TypeError("Failed to fetch");
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (jar) headers.cookie = `__session=${jar}`;
  const req = new NextRequest(`http://localhost${url}`, { method, headers, body: init.body });
  const res: Response = method === "POST" ? await POST(req) : await DELETE(req);
  const sc = res.headers.get("set-cookie") ?? "";
  const m = /__session=([^;]*)/.exec(sc);
  if (m) jar = m[1] === "" || /Max-Age=0/i.test(sc) ? null : m[1];
  return res;
}

// ── synthetic users (structural subset of firebase User) ──
const user = (uid: string) => ({ uid, getIdToken: jest.fn(async () => `idtok-${uid}`) });

// ── upstream behaviours ──
const fbErr = (code: string) => Object.assign(new Error("upstream"), { code });
function healthy() {
  mockVerifyIdToken.mockImplementation(async (tok: string) => ({ uid: tok.replace("idtok-", "") }));
  mockCreateSessionCookie.mockImplementation(async (tok: string) => `cookie-${tok.replace("idtok-", "")}`);
}
function verifyOutage(code = "auth/internal-error") {
  mockVerifyIdToken.mockRejectedValue(fbErr(code));
}

let latest: ReturnType<typeof useAuth>;
function Probe() {
  latest = useAuth();
  return null;
}
let local: FakeStorage;
let session: FakeStorage;
const PENDING = "convergePanelVerifyPendingV2";

beforeEach(() => {
  jest.clearAllMocks();
  mockClientEvents.length = 0;
  calls.length = 0;
  jar = null;
  deleteFails = false;
  networkDown = false;
  tokenCallback = undefined;
  local = new FakeStorage();
  session = new FakeStorage();
  g.window = { localStorage: local, sessionStorage: session };
  g.fetch = fetchDouble;
  healthy();
  act(() => {
    TestRenderer.create(createElement(AuthProvider, null, createElement(Probe)));
  });
  expect(typeof tokenCallback).toBe("function");
});
afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
});

async function emit(u: any) {
  await act(async () => {
    await tokenCallback!(u);
  });
}
/** Signs A in successfully and confirms the baseline (authenticated, A's cookie). */
async function signInA() {
  const a = user("uid-a");
  await emit(a);
  expect(latest.syncState).toBe("authenticated");
  expect(jar).toBe("cookie-uid-a");
  calls.length = 0;
  mockClientEvents.length = 0;
  return a;
}
function putPendingInput() {
  session.setItem(PENDING, JSON.stringify({ v: 2, text: "SYNTHETIC_UNSAVED_INPUT", boundUid: "uid-a", expiresAt: Date.now() + 60_000 }));
}

describe("Stage 0 F3 — routine same-uid refresh during a verification outage keeps the confirmed session", () => {
  it.each(["auth/internal-error", "auth/quota-exceeded", "app/network-timeout", "app/unable-to-parse-response"])(
    "mint verify outage %s: stays authenticated, keeps A's cookie, no sign-out, unsaved input kept, ONE request (no retry)",
    async (code) => {
      const a = await signInA();
      putPendingInput();
      verifyOutage(code);
      await emit(a); // Firebase's routine token refresh for the SAME uid
      expect(latest.syncState).toBe("authenticated");
      expect(latest.canMutate).toBe(true);
      expect(latest.user?.uid).toBe("uid-a");
      expect(jar).toBe("cookie-uid-a"); // not cleared
      expect(calls).toEqual(["POST"]); // no DELETE, no retry
      expect(mockSignOut).not.toHaveBeenCalled(); // so no other tab is signed out either
      expect(session.getItem(PENDING)).toContain("SYNTHETIC_UNSAVED_INPUT");
      expect(mockClientEvents.map((e) => e[0])).toContain("token_refresh_deferred");
    }
  );

  it("createSessionCookie outage on a same-uid refresh is kept the same way", async () => {
    const a = await signInA();
    mockCreateSessionCookie.mockRejectedValue(fbErr("app/network-error"));
    await emit(a);
    expect(latest.syncState).toBe("authenticated");
    expect(jar).toBe("cookie-uid-a");
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("deadline (10 s cut-off) on a same-uid refresh: kept; the late result never sets a cookie", async () => {
    jest.useFakeTimers({ doNotFake: ["performance", "queueMicrotask", "nextTick", "setImmediate"] });
    try {
      const a = await signInA();
      let release: (v: unknown) => void = () => undefined;
      mockVerifyIdToken.mockImplementation(() => new Promise((r) => (release = r)));
      await act(async () => {
        const done = tokenCallback!(a);
        await jest.advanceTimersByTimeAsync(10_001);
        await done;
      });
      expect(calls).toEqual(["POST"]); // cut off at the deadline; no retry, no DELETE
      expect(latest.syncState).toBe("authenticated");
      expect(jar).toBe("cookie-uid-a");
      expect(mockSignOut).not.toHaveBeenCalled();
      release({ uid: "uid-a" }); // late success
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(mockCreateSessionCookie).toHaveBeenCalledTimes(1); // only the initial sign-in's
      expect(jar).toBe("cookie-uid-a");
    } finally {
      jest.useRealTimers();
    }
  });

  it("no loop: after a kept refresh nothing else is scheduled; the NEXT token event re-mints and refreshes the cookie", async () => {
    const a = await signInA();
    verifyOutage();
    await emit(a);
    expect(calls).toEqual(["POST"]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(calls).toEqual(["POST"]); // still exactly one: no timer, no retry, no callback loop
    healthy();
    mockCreateSessionCookie.mockImplementation(async () => "cookie-uid-a-v2");
    await emit(a);
    expect(latest.syncState).toBe("authenticated");
    expect(jar).toBe("cookie-uid-a-v2");
  });

  it("a revocation found on the NEXT refresh still signs out (keeping is never sticky)", async () => {
    const a = await signInA();
    verifyOutage();
    await emit(a);
    mockVerifyIdToken.mockRejectedValue(fbErr("auth/id-token-revoked"));
    await emit(a);
    expect(latest.canMutate).toBe(false);
    expect(jar).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("Stage 0 F3 — every other case is unchanged and fail closed", () => {
  it.each([
    ["revoked", "auth/id-token-revoked"],
    ["disabled", "auth/user-disabled"],
    ["invalid", "auth/argument-error"],
  ])("same-uid refresh with a confirmed %s credential → 401: cookie cleared, Firebase signed out", async (_l, code) => {
    const a = await signInA();
    putPendingInput();
    mockVerifyIdToken.mockRejectedValue(fbErr(code));
    await emit(a);
    expect(latest.canMutate).toBe(false);
    expect(latest.syncState).not.toBe("authenticated");
    expect(jar).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await emit(null); // the sign-out's own callback
    expect(session.getItem(PENDING)).toBeNull(); // privacy cleanup on a genuine sign-out still runs
  });

  it("same-uid refresh, cookie creation 500 (non-outage) → fail closed", async () => {
    const a = await signInA();
    mockCreateSessionCookie.mockRejectedValue(fbErr("auth/invalid-argument"));
    await emit(a);
    expect(jar).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("same-uid refresh, network error reaching the mint → fail closed (unchanged)", async () => {
    const a = await signInA();
    networkDown = true;
    await emit(a);
    expect(latest.canMutate).toBe(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("initial sign-in / cold load (first callback) during an outage → not authenticated, cookie cleared, signed out", async () => {
    jar = "cookie-left-by-another-tab";
    verifyOutage();
    await emit(user("uid-a"));
    expect(latest.canMutate).toBe(false);
    expect(jar).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("initial sign-in during an outage when the cookie DELETE also fails → still signed out (cleanup not guaranteed ⇒ fail closed)", async () => {
    jar = "cookie-left-by-another-tab";
    deleteFails = true;
    verifyOutage();
    await emit(user("uid-a"));
    expect(latest.canMutate).toBe(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("direct account switch A → B during an outage → A's cookie is never kept for B; B is not authenticated; signed out", async () => {
    await signInA();
    verifyOutage();
    await emit(user("uid-b"));
    expect(latest.canMutate).toBe(false);
    expect(jar).toBeNull(); // A's cookie cleared, not kept
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("A → B switch whose mint failed, then B's own refresh during an outage → still fail closed (B was never confirmed)", async () => {
    await signInA();
    verifyOutage();
    const b = user("uid-b");
    await emit(b);
    expect(mockSignOut).toHaveBeenCalledTimes(1); // B's failed initial sync failed closed
    mockSignOut.mockClear();
    calls.length = 0;
    mockClientEvents.length = 0;
    // R-S0-6: the SAME User object again with no null in between (here the sign-out double does not emit null) is
    // never restarted into the failed episode: no new mint, no state upgrade — still fail closed.
    await emit(b);
    expect(latest.canMutate).toBe(false);
    expect(latest.syncState).not.toBe("authenticated");
    expect(calls.filter((c) => c === "POST")).toHaveLength(0);
    expect(mockClientEvents.map((e) => e[0])).toContain("failed_episode_callback_dropped");
    // Once Firebase reports null, B may sync again — and, the outage persisting, fails closed again.
    await emit(null);
    calls.length = 0;
    await emit(b);
    expect(calls.filter((c) => c === "POST").length).toBeGreaterThanOrEqual(1);
    expect(latest.canMutate).toBe(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("explicit logout started, then a same-uid refresh hits an outage → never authenticated again; logout's own sign-out completes", async () => {
    const a = await signInA();
    act(() => latest.beginLogout());
    expect(latest.canMutate).toBe(false);
    verifyOutage();
    await emit(a);
    expect(latest.syncState).not.toBe("authenticated");
    expect(latest.canMutate).toBe(false);
    await emit(null);
    expect(latest.syncState).toBe("signed_out");
  });
});
