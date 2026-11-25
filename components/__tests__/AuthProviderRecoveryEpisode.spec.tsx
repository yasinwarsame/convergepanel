/**
 * #332 R8 (owner authorization 2026-11-25): the recovery episode survives Firebase callback re-entry.
 *
 * The double models firebase 12.7.0's observable behaviour, read from the installed SDK
 * (node_modules/@firebase/auth/dist/esm/index-36fcbc82.js):
 * - `User.getIdToken(force)` (:1762-1771): a token different from the current one → `_notifyListenersIfCurrent` →
 *   `notifyAuthListeners` → `idTokenSubscription.next(currentUser)` (:3076-3080). The listener is queued as a
 *   promise microtask (@firebase/util observers run asynchronously) BEFORE getIdToken resolves.
 * - Tokens carry `iat` in whole seconds, so two refreshes in the same second yield the identical token (no
 *   notification); a forced refresh in a later second yields a new token (notification).
 * - A non-forced getIdToken returns the cached token while it is unexpired (no network, no notification).
 * - The securetoken endpoint being down → `auth/network-request-failed` from a refresh.
 * - `signOut` → the listener is notified with null.
 *
 * Real AuthProvider, real sessionSync, real state machine and local-data cleanup. Only `fetch` (the session endpoint)
 * and the Firebase client SDK are faked. Synthetic data only.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

// ── Firebase 12.7.0 behavioural double ────────────────────────────────────────
type Listener = (u: unknown) => Promise<void> | void;
const fb = {
  listeners: [] as Listener[],
  current: null as FakeUser | null,
  securetokenDown: false,
  refreshes: 0,
  notify() {
    // Native promise microtask (not queueMicrotask, which Jest's modern fake timers also fake): delivered
    // asynchronously, before the refresh's own caller resumes, as @firebase/util's promise-based observers do.
    for (const l of fb.listeners) void Promise.resolve().then(() => l(fb.current));
  },
};
class FakeUser {
  token = "";
  private iatSec = -1;
  constructor(readonly uid: string) {
    this.mint();
  }
  private mint() {
    this.iatSec = Math.floor(Date.now() / 1000);
    this.token = `synthetic-${this.uid}-${this.iatSec}`;
  }
  async getIdToken(force?: boolean): Promise<string> {
    const expired = Date.now() / 1000 - this.iatSec >= 3600;
    if (!force && !expired) return this.token;
    fb.refreshes += 1;
    if (fb.securetokenDown) throw Object.assign(new Error("Firebase: Error (auth/network-request-failed)."), { code: "auth/network-request-failed" });
    const before = this.token;
    this.mint();
    if (this.token !== before && fb.current === this) fb.notify(); // _notifyListenersIfCurrent
    return this.token;
  }
}
const mockSignOut = jest.fn(async () => {
  fb.current = null;
  fb.notify();
});
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_a: unknown, cb: Listener) => {
    fb.listeners.push(cb);
    return () => {
      fb.listeners = fb.listeners.filter((l) => l !== cb);
    };
  },
  getIdTokenResult: async () => ({ claims: { admin: true } }),
  signOut: (...args: unknown[]) => (mockSignOut as any)(...args),
}));
jest.mock("@/lib/firebase/client", () => ({ auth: {} }));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

import { AuthProvider, useAuth, SESSION_SYNC_MAX_ATTEMPTS_PER_EPISODE, SESSION_UNAVAILABLE_RETRY_DELAYS_MS } from "@/components/AuthProvider";

// ── the session endpoint double (exact server contract) ───────────────────────
type Mode = "ok" | "outage" | "revoked" | "unreachable";
const server = {
  mode: "ok" as Mode,
  deleteFails: false,
  posts: 0,
  inFlight: 0,
  maxInFlight: 0,
  cookieUid: null as string | null, // what the browser's __session cookie currently authorizes
  deferNextOk: null as null | (() => void),
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const uidOfToken = (t: string) => /^synthetic-(.+)-\d+$/.exec(t)?.[1] ?? "";
async function sessionFetch(_url: string, init?: { method?: string; body?: string }): Promise<Response> {
  if (init?.method === "DELETE") {
    if (server.deleteFails) throw new TypeError("Failed to fetch");
    server.cookieUid = null;
    return json(200, { ok: true });
  }
  server.posts += 1;
  if (server.mode === "unreachable") throw new TypeError("Failed to fetch");
  const uid = uidOfToken(JSON.parse(init?.body ?? "{}").idToken ?? "");
  if (server.mode === "outage") return json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
  if (server.mode === "revoked") return json(401, { error: "Invalid or expired token" });
  server.inFlight += 1;
  server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
  const finish = () => {
    server.inFlight -= 1;
    server.cookieUid = uid; // Set-Cookie applied when the response arrives
    return json(200, { authenticated: true, uid });
  };
  if (server.deferNextOk === null && (sessionFetch as any).deferOnce) {
    (sessionFetch as any).deferOnce = false;
    return new Promise<Response>((resolve) => {
      server.deferNextOk = () => resolve(finish());
    });
  }
  return finish();
}

// ── harness ───────────────────────────────────────────────────────────────────
let probe = { syncState: "", canMutate: true, isAdmin: false, beginLogout: () => undefined as void };
function Probe() {
  const a = useAuth();
  probe = { syncState: a.syncState, canMutate: a.canMutate, isAdmin: a.isAdmin, beginLogout: a.beginLogout };
  return null;
}
const g = globalThis as any;
const SAVED = { window: g.window, fetch: g.fetch };
let local: FakeStorage;
let session: FakeStorage;
let renderers: TestRenderer.ReactTestRenderer[] = [];
function mount() {
  act(() => {
    renderers.push(TestRenderer.create(createElement(AuthProvider, null, createElement(Probe))));
  });
}
async function flush(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
async function signIn(u: FakeUser) {
  fb.current = u;
  fb.notify();
  await flush();
}
const PENDING = "convergePanelVerifyPendingV2";
function seed(uid: string) {
  local.setItem(`convergePanelHistoryV1:${uid}`, JSON.stringify([{ claim: `SYNTHETIC_CLAIM_${uid}` }]));
  session.setItem(PENDING, JSON.stringify({ v: 2, text: `SYNTHETIC_UNSAVED_${uid}`, boundUid: uid, expiresAt: Date.now() + 600_000 }));
}
const intact = (uid: string) =>
  (local.getItem(`convergePanelHistoryV1:${uid}`) ?? "").includes(`SYNTHETIC_CLAIM_${uid}`) && (session.getItem(PENDING) ?? "").includes(`SYNTHETIC_UNSAVED_${uid}`);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-25T12:00:00Z") });
  jest.clearAllMocks();
  Object.assign(fb, { listeners: [], current: null, securetokenDown: false, refreshes: 0 });
  Object.assign(server, { mode: "ok", deleteFails: false, posts: 0, inFlight: 0, maxInFlight: 0, cookieUid: null, deferNextOk: null });
  (sessionFetch as any).deferOnce = false;
  local = new FakeStorage();
  session = new FakeStorage();
  g.window = { localStorage: local, sessionStorage: session };
  g.fetch = jest.fn(sessionFetch);
  renderers = [];
  mount();
});
afterEach(() => {
  act(() => renderers.forEach((r) => r.unmount()));
  jest.useRealTimers();
});
afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
});

// ── 1. ten-minute outage with realistic re-entry ──────────────────────────────
describe("R8 scenario 1 — a ten-minute outage with SDK callback re-entry is bounded per episode", () => {
  it.each(["first sign-in", "routine refresh"] as const)("outage beginning at %s: ≤ 4 mint attempts in 10 minutes, one chain, no sign-out", async (start) => {
    const a = new FakeUser("uid-a");
    if (start === "routine refresh") {
      await signIn(a);
      expect(probe.syncState).toBe("authenticated");
      server.posts = 0;
      server.mode = "outage";
      await flush(10_000); // a later second, so the forced refresh produces a new token
      await a.getIdToken(true); // the SDK's proactive refresh → onIdTokenChanged (new token)
      await flush();
    } else {
      server.mode = "outage";
      await signIn(a);
    }
    for (let s = 0; s < 600; s++) {
      // realistic background activity: the SDK re-fires on every token change it sees
      if (s % 7 === 0) fb.notify();
      await flush(1_000);
      expect(jest.getTimerCount()).toBeLessThanOrEqual(1); // never more than one pending retry: no duplicate chains
    }
    expect(server.posts).toBeLessThanOrEqual(SESSION_SYNC_MAX_ATTEMPTS_PER_EPISODE);
    expect(server.posts).toBe(4);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.syncState).toBe("session_unavailable");
    expect(probe.canMutate).toBe(false);
    expect(server.cookieUid).toBeNull(); // fail closed: no cookie authorizes anything
    expect(jest.getTimerCount()).toBe(0); // exhausted: nothing scheduled
  });
});

// ── 2. outage on a routine refresh, then recovery ─────────────────────────────
describe("R8 scenario 2 — outage on a routine refresh keeps the user's data and recovers", () => {
  it("unavailable → mutations disabled, /verify input intact → service restored → authenticated for the same uid", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    seed("uid-a");
    server.mode = "outage";
    await flush(10_000);
    await a.getIdToken(true);
    await flush();
    expect(probe.syncState).toBe("session_unavailable");
    expect(probe.canMutate).toBe(false);
    expect(probe.isAdmin).toBe(false); // display-only flag drops with the session
    expect(intact("uid-a")).toBe(true);
    server.mode = "ok";
    await flush(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]);
    expect(probe.syncState).toBe("authenticated");
    expect(probe.canMutate).toBe(true);
    expect(server.cookieUid).toBe("uid-a");
    expect(intact("uid-a")).toBe(true);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

// ── 3. client SDK token-refresh failure ───────────────────────────────────────
describe("R8 scenario 3 — the Firebase client cannot refresh its token (auth/network-request-failed)", () => {
  it("routine refresh while securetoken is down: classified temporary — no sign-out, data kept, cookie cleared, not mutable; the retry's cached valid token recovers", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    seed("uid-a");
    expect(server.cookieUid).toBe("uid-a");
    fb.securetokenDown = true;
    await flush(10_000);
    fb.notify(); // a routine SDK callback → the provider's same-uid sync forces a refresh → auth/network-request-failed
    await flush();
    expect(probe.syncState).toBe("session_unavailable");
    expect(probe.canMutate).toBe(false);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(intact("uid-a")).toBe(true);
    expect(server.cookieUid).toBeNull(); // the session is not claimed valid: cookie removed
    const postsBefore = server.posts;
    await flush(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]); // retry does not force → cached unexpired token → server re-verifies it
    expect(server.posts).toBe(postsBefore + 1);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
  });

  it("first sign-in while securetoken is down: unavailable (not signed out), cookie cleared, then the cached token recovers on retry", async () => {
    const a = new FakeUser("uid-a");
    fb.securetokenDown = true;
    server.cookieUid = "uid-stale";
    await flush(2_000);
    await signIn(a); // new identity → forced refresh → auth/network-request-failed
    expect(probe.syncState).toBe("session_unavailable");
    expect(probe.canMutate).toBe(false);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(server.cookieUid).toBeNull(); // the unverified previous cookie did not survive (Correction C)
    expect(server.posts).toBe(0); // nothing was sent without a token
    await flush(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]); // retry: non-forced → cached unexpired token → server verifies it
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
  });

  it("any other SDK refresh error (auth/user-token-expired) is NOT temporary: fail-closed sign-out", async () => {
    const a = new FakeUser("uid-a");
    a.getIdToken = async () => {
      throw Object.assign(new Error("expired"), { code: "auth/user-token-expired" });
    };
    await signIn(a);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await flush();
    expect(probe.syncState).toBe("signed_out");
  });
});

// ── 4. revocation discovered during a retry ───────────────────────────────────
describe("R8 scenario 4 — revocation discovered on a retry", () => {
  it("rejected, no protected access, signed out, private data cleared", async () => {
    const a = new FakeUser("uid-a");
    seed("uid-a");
    server.mode = "outage";
    await signIn(a);
    expect(probe.syncState).toBe("session_unavailable");
    server.mode = "revoked";
    await flush(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.canMutate).toBe(false);
    expect(server.cookieUid).toBeNull();
    await flush();
    expect(probe.syncState).toBe("signed_out");
    expect(intact("uid-a")).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── 5. invalid / disabled credentials ─────────────────────────────────────────
describe("R8 scenario 5 — invalid or disabled credentials keep the fail-closed sign-out", () => {
  it.each(["first sign-in", "routine refresh"] as const)("401 verdict at %s → signed out, no retry scheduled", async (when) => {
    const a = new FakeUser("uid-a");
    if (when === "routine refresh") {
      await signIn(a);
      server.mode = "revoked";
      await flush(10_000);
      await a.getIdToken(true);
    } else {
      server.mode = "revoked";
      await signIn(a);
    }
    await flush();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── 6. logout during a pending timer or request ───────────────────────────────
describe("R8 scenario 6 — logout during recovery", () => {
  it("logout while a retry timer is pending: timer cancelled, no further mint, data cleaned on sign-out", async () => {
    const a = new FakeUser("uid-a");
    seed("uid-a");
    server.mode = "outage";
    await signIn(a);
    expect(jest.getTimerCount()).toBe(1);
    act(() => probe.beginLogout());
    expect(jest.getTimerCount()).toBe(0);
    await act(async () => {
      await mockSignOut();
    });
    await flush(120_000);
    expect(server.posts).toBe(1);
    expect(probe.syncState).toBe("signed_out");
    expect(intact("uid-a")).toBe(false);
  });

  it("logout while a mint request is in flight: its late success is never adopted and its cookie is removed", async () => {
    const a = new FakeUser("uid-a");
    server.mode = "outage";
    await signIn(a);
    server.mode = "ok";
    (sessionFetch as any).deferOnce = true;
    await flush(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]); // the retry is now in flight (deferred)
    expect(server.deferNextOk).not.toBeNull();
    act(() => probe.beginLogout());
    await act(async () => {
      await mockSignOut();
    });
    await flush();
    await act(async () => {
      server.deferNextOk!(); // Set-Cookie for uid-a arrives after the logout
      await jest.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(probe.syncState).toBe("signed_out");
    expect(probe.canMutate).toBe(false);
    expect(server.cookieUid).toBeNull(); // removed again (Correction C)
  });
});

// ── 7. direct account switch ──────────────────────────────────────────────────
describe("R8 scenario 7 — direct account switch", () => {
  it("A in an outage → B signs in: A's episode ends, A's private data is gone, only B can hold the cookie", async () => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    seed("uid-a");
    server.mode = "outage";
    await signIn(a);
    server.mode = "ok";
    await flush(1_000);
    await signIn(b);
    await flush(120_000);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-b");
    expect(local.getItem("convergePanelHistoryV1:uid-a")).toBeNull();
    expect(session.getItem(PENDING)).toBeNull();
  });

  it("switch during an outage when the cookie DELETE also fails: B is NOT kept signed in on top of an unverified cookie", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    expect(server.cookieUid).toBe("uid-a");
    server.mode = "outage";
    server.deleteFails = true;
    const b = new FakeUser("uid-b");
    await flush(1_000);
    await signIn(b);
    await flush();
    expect(mockSignOut).toHaveBeenCalledTimes(1); // fail closed (pre-#332 behaviour for this compound case)
    expect(probe.canMutate).toBe(false);
  });

  it("same-user refresh outage with a failed DELETE: stays unavailable (the remaining cookie is the same uid and is re-verified with checkRevoked on every request)", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.mode = "outage";
    server.deleteFails = true;
    await flush(10_000);
    await a.getIdToken(true);
    await flush();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.syncState).toBe("session_unavailable");
    expect(probe.canMutate).toBe(false);
    expect(server.cookieUid).toBe("uid-a");
  });
});

// ── 8. recovery and exhaustion boundaries ─────────────────────────────────────
describe("R8 scenario 8 — the budget resets only at authorized boundaries", () => {
  it("exhausted: routine callbacks never restart it; an explicit sign-out + sign-in is a new episode", async () => {
    const a = new FakeUser("uid-a");
    server.mode = "outage";
    await signIn(a);
    await flush(10 * 60_000);
    expect(server.posts).toBe(4);
    for (let i = 0; i < 5; i++) {
      await flush(5_000);
      await a.getIdToken(true); // routine token changes
      fb.notify();
      await flush();
    }
    expect(server.posts).toBe(4);
    expect(probe.syncState).toBe("session_unavailable");
    await act(async () => {
      await mockSignOut();
    });
    await flush();
    server.mode = "ok";
    await signIn(a);
    expect(server.posts).toBe(5);
    expect(probe.syncState).toBe("authenticated");
  });

  it("a successful recovery ends the episode: a later outage gets its own budget of 4", async () => {
    const a = new FakeUser("uid-a");
    server.mode = "outage";
    await signIn(a);
    server.mode = "ok";
    await flush(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]);
    expect(probe.syncState).toBe("authenticated");
    expect(server.posts).toBe(2);
    server.mode = "outage";
    await flush(60_000);
    await a.getIdToken(true);
    await flush(10 * 60_000);
    expect(server.posts).toBe(2 + 4);
  });

  it("a same-uid callback during a HEALTHY in-flight sync does not start a second mint", async () => {
    const a = new FakeUser("uid-a");
    (sessionFetch as any).deferOnce = true;
    await flush(1_000);
    await signIn(a);
    expect(server.posts).toBe(1);
    fb.notify();
    fb.notify();
    await flush();
    expect(server.posts).toBe(1);
    await act(async () => {
      server.deferNextOk!();
      await jest.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(probe.syncState).toBe("authenticated");
    expect(server.maxInFlight).toBe(1);
  });
});

// ── 9. cross-tab: the bound is per tab ────────────────────────────────────────
describe("R8 scenario 9 — the bound is per mounted AuthProvider (per tab), not cross-tab", () => {
  it("two tabs in the same outage: each ≤ 4 (8 in total); the server's own deadline and cap bound every call", async () => {
    mount(); // second tab
    const a = new FakeUser("uid-a");
    server.mode = "outage";
    await signIn(a);
    await flush(10 * 60_000);
    expect(server.posts).toBe(2 * SESSION_SYNC_MAX_ATTEMPTS_PER_EPISODE);
  });
});
