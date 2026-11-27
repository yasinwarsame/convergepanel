/**
 * Stage 0 B1 (owner decision 2026-11-26): Firebase callback re-entry against the REAL AuthProvider + sessionSync.
 *
 * The double is the firebase 12.7.0 behavioural model established in the #332 R8 review (read from the installed SDK,
 * node_modules/@firebase/auth/dist/esm/index-36fcbc82.js), extended with refresh LATENCY:
 * - `User.getIdToken(force)` (:1762-1771): a token different from the current one → `_notifyListenersIfCurrent` →
 *   `idTokenSubscription.next(currentUser)` (:3076-3080), delivered as a promise microtask BEFORE getIdToken resolves.
 * - Tokens carry `iat` in whole seconds: a forced refresh landing in the same second as the previous mint yields the
 *   identical token (no notification); one landing in a later second yields a new token (notification).
 * - A non-forced getIdToken returns the cached token while unexpired (no network, no notification).
 * - `signOut` → the listener is notified with null.
 * - NEW here: a forced refresh takes `refreshLatencyMs` (securetoken round trip) and the session POST takes
 *   `mintLatencyMs` (the server's verification, up to its 10 s deadline).
 *
 * Only `fetch` (the session endpoint, exact server contract) and the Firebase client SDK are faked. Synthetic data only.
 *
 * Two parts:
 *  - "measurement": head-agnostic. Records mint-request counts over a simulated 10-minute window and asserts only
 *    what must hold on ANY head (finite, no growth without events). Run on main and on this head to separate
 *    pre-existing behaviour from regression. Set REENTRY_REPORT=<file> to write the numbers.
 *  - "Stage 0 contract": this head's kept-session behaviour under re-entry.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { writeFileSync } from "fs";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

// ── Firebase 12.7.0 behavioural double (+ latency) ────────────────────────────
type Listener = (u: unknown) => Promise<void> | void;
const fb = {
  listeners: [] as Listener[],
  current: null as FakeUser | null,
  refreshLatencyMs: 0,
  refreshes: 0,
  notify() {
    // Native promise microtask (not queueMicrotask, which modern fake timers also fake).
    for (const l of fb.listeners) void Promise.resolve().then(() => l(fb.current));
  },
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  /** The SDK's own proactive refresh (≈5 min before expiry): new token → listeners notified. */
  sdkProactiveRefresh() {
    const before = this.token;
    this.mint();
    if (this.token !== before && fb.current === this) fb.notify();
  }
  async getIdToken(force?: boolean): Promise<string> {
    const expired = Date.now() / 1000 - this.iatSec >= 3600;
    if (!force && !expired) return this.token;
    fb.refreshes += 1;
    if (fb.refreshLatencyMs > 0) await delay(fb.refreshLatencyMs);
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
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: (...args: unknown[]) => (mockSignOut as any)(...args),
}));
// R-S0-7: AuthProvider signs out only while Firebase still reports the failed User object, so the double exposes currentUser.
jest.mock("@/lib/firebase/client", () => ({
  auth: {
    get currentUser() {
      return fb.current;
    },
  },
}));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

import { AuthProvider, useAuth } from "@/components/AuthProvider";

// ── the session endpoint double (exact server contract) ───────────────────────
type Mode = "ok" | "outage" | "revoked";
const server = {
  mode: "ok" as Mode,
  mintLatencyMs: 0,
  posts: 0,
  deletes: 0,
  inFlight: 0,
  maxInFlight: 0,
  cookieUid: null as string | null,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const uidOfToken = (t: string) => /^synthetic-(.+)-\d+$/.exec(t)?.[1] ?? "";
async function sessionFetch(_url: string, init?: { method?: string; body?: string }): Promise<Response> {
  if (init?.method === "DELETE") {
    server.deletes += 1;
    server.cookieUid = null;
    return json(200, { ok: true });
  }
  server.posts += 1;
  server.inFlight += 1;
  server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
  try {
    const uid = uidOfToken(JSON.parse(init?.body ?? "{}").idToken ?? "");
    if (server.mintLatencyMs > 0) await delay(server.mintLatencyMs); // verification time, ≤ the 10 s deadline
    // The mode is read when the server answers (an outage that starts mid-request is seen by that request).
    if (server.mode === "outage") return json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
    if (server.mode === "revoked") return json(401, { error: "Invalid or expired token" });
    server.cookieUid = uid;
    return json(200, { authenticated: true, uid });
  } finally {
    server.inFlight -= 1;
  }
}

// ── harness ───────────────────────────────────────────────────────────────────
let probe = { syncState: "", canMutate: true, beginLogout: () => undefined as void };
function Probe() {
  const a = useAuth();
  probe = { syncState: a.syncState, canMutate: a.canMutate, beginLogout: a.beginLogout };
  return null;
}
const g = globalThis as any;
const SAVED = { window: g.window, fetch: g.fetch };
let local: FakeStorage;
let session: FakeStorage;
let renderer: TestRenderer.ReactTestRenderer | null = null;
async function flush(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
/** Advances `totalMs` in 1 s steps, calling `each(second)` first; returns per-minute POST counts. */
async function run(totalMs: number, each?: (s: number) => void) {
  const perMinute: number[] = [];
  let lastPosts = server.posts;
  for (let s = 0; s < totalMs / 1000; s++) {
    each?.(s);
    await flush(1_000);
    if ((s + 1) % 60 === 0) {
      perMinute.push(server.posts - lastPosts);
      lastPosts = server.posts;
    }
  }
  return perMinute;
}
async function signIn(u: FakeUser) {
  fb.current = u;
  fb.notify();
  // Let the sign-in (and any re-entry it causes) settle at the configured latencies.
  await flush(Math.max(1, 3 * (fb.refreshLatencyMs + server.mintLatencyMs)));
}
const PENDING = "convergePanelVerifyPendingV2";
function seed(uid: string) {
  local.setItem(`convergePanelHistoryV1:${uid}`, JSON.stringify([{ claim: `SYNTHETIC_CLAIM_${uid}` }]));
  session.setItem(PENDING, JSON.stringify({ v: 2, text: `SYNTHETIC_UNSAVED_${uid}`, boundUid: uid, expiresAt: Date.now() + 3_600_000 }));
}
const intact = (uid: string) =>
  (local.getItem(`convergePanelHistoryV1:${uid}`) ?? "").includes(`SYNTHETIC_CLAIM_${uid}`) && (session.getItem(PENDING) ?? "").includes(`SYNTHETIC_UNSAVED_${uid}`);

const report: Record<string, unknown> = {};
afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
  if (process.env.REENTRY_REPORT) writeFileSync(process.env.REENTRY_REPORT, JSON.stringify(report, null, 2));
});
beforeEach(() => {
  // Start 300 ms into a second, so a sub-second refresh can land in the same or the next second deterministically.
  jest.useFakeTimers({ now: new Date("2026-11-26T12:00:00.300Z") });
  jest.clearAllMocks();
  Object.assign(fb, { listeners: [], current: null, refreshLatencyMs: 0, refreshes: 0 });
  Object.assign(server, { mode: "ok", mintLatencyMs: 0, posts: 0, deletes: 0, inFlight: 0, maxInFlight: 0, cookieUid: null });
  local = new FakeStorage();
  session = new FakeStorage();
  g.window = { localStorage: local, sessionStorage: session };
  g.fetch = jest.fn(sessionFetch);
  act(() => {
    renderer = TestRenderer.create(createElement(AuthProvider, null, createElement(Probe)));
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  jest.useRealTimers();
});

const TEN_MIN = 600_000;

// ── Measurement (head-agnostic) ───────────────────────────────────────────────
describe("measurement — mint requests over a simulated 10-minute window", () => {
  // Securetoken latencies below, at and above the 1 s token-iat granularity; mint latency up to the deadline.
  const LAT: Array<[number, number]> = [
    [0, 0],
    [300, 200],
    [800, 2_000],
    [999, 10_000],
    [1_000, 200],
    [1_500, 10_000],
  ];

  it.each(LAT)("healthy, one routine refresh: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    const a = new FakeUser("uid-a");
    await signIn(a);
    const atSignIn = server.posts;
    server.posts = 0;
    await flush(10_000);
    a.sdkProactiveRefresh();
    const perMinute = await run(TEN_MIN);
    report[`healthy rl=${rl} ml=${ml}`] = { signInPosts: atSignIn, posts: server.posts, perMinute, maxInFlight: server.maxInFlight, signOuts: mockSignOut.mock.calls.length, state: probe.syncState };
    expect(Number.isFinite(server.posts)).toBe(true);
  });

  it.each(LAT)("10-minute outage after one routine refresh: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.posts = 0;
    server.maxInFlight = 0;
    server.mode = "outage";
    await flush(10_000);
    a.sdkProactiveRefresh();
    const perMinute = await run(TEN_MIN);
    report[`outage rl=${rl} ml=${ml}`] = { posts: server.posts, perMinute, maxInFlight: server.maxInFlight, signOuts: mockSignOut.mock.calls.length, state: probe.syncState, cookie: server.cookieUid };
  });

  it.each(LAT)("10-minute outage + an SDK notification every 7 s: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.posts = 0;
    server.maxInFlight = 0;
    server.mode = "outage";
    const perMinute = await run(TEN_MIN, (s) => {
      if (s % 7 === 0) fb.notify();
    });
    report[`outage+notify7s rl=${rl} ml=${ml}`] = { posts: server.posts, perMinute, maxInFlight: server.maxInFlight, signOuts: mockSignOut.mock.calls.length, state: probe.syncState };
  });

  it.each(LAT)("10-minute outage starting AT sign-in: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    server.mode = "outage";
    const a = new FakeUser("uid-a");
    fb.current = a;
    fb.notify();
    const perMinute = await run(TEN_MIN);
    report[`outage-at-signin rl=${rl} ml=${ml}`] = { posts: server.posts, perMinute, maxInFlight: server.maxInFlight, signOuts: mockSignOut.mock.calls.length, state: probe.syncState };
  });
});

// ── Stage 0 contract under re-entry ───────────────────────────────────────────
describe("Stage 0 contract — kept session under realistic callback re-entry", () => {
  // Sign-in completes at low latency; the latencies then apply to the refresh (incl. ≥ 1 s, the chain-forming case).
  const LAT: Array<[number, number]> = [
    [0, 0],
    [300, 200],
    [800, 2_000],
    [999, 10_000],
    [1_000, 200],
    [1_500, 10_000],
    [5_000, 10_000],
  ];
  async function signInThen(rl: number, ml: number) {
    const a = new FakeUser("uid-a");
    await signIn(a);
    expect(probe.syncState).toBe("authenticated");
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    server.posts = 0;
    server.maxInFlight = 0;
    fb.refreshes = 0;
    return a;
  }

  it.each(LAT)(
    "prolonged outage, refresh %i ms / mint %i ms: one routine event → exactly ONE mint, no forced refresh, then zero for the rest of 10 min; kept, no sign-out",
    async (rl, ml) => {
      const a = await signInThen(rl, ml);
      seed("uid-a");
      server.mode = "outage";
      await flush(10_000);
      a.sdkProactiveRefresh();
      const perMinute = await run(TEN_MIN);
      expect(server.posts).toBe(1);
      expect(fb.refreshes).toBe(0); // the refresh callback used the delivered token: nothing re-notifies
      expect(perMinute.slice(1).every((n) => n === 0)).toBe(true);
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(probe.syncState).toBe("authenticated");
      expect(server.cookieUid).toBe("uid-a");
      expect(server.deletes).toBe(0);
      expect(intact("uid-a")).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(LAT)("healthy routine refresh, refresh %i ms / mint %i ms: exactly one mint, no chain", async (rl, ml) => {
    const a = await signInThen(rl, ml);
    await flush(10_000);
    a.sdkProactiveRefresh();
    await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(fb.refreshes).toBe(0);
    expect(probe.syncState).toBe("authenticated");
  });

  it.each(LAT)("repeated SDK notifications (every 7 s) during the outage: at most one mint per notification, nothing after they stop — refresh %i / mint %i", async (rl, ml) => {
    await signInThen(rl, ml);
    server.mode = "outage";
    let notifications = 0;
    await run(TEN_MIN, (s) => {
      if (s % 7 === 0) {
        notifications += 1;
        fb.notify();
      }
    });
    // R-S0-6: a notification arriving while a refresh is in flight is coalesced into it (single-flight); a deferred
    // (auth_unavailable) answer drops the queued follow-up and the next notification re-attempts. So when the mint is
    // slower than the notification interval there are FEWER mints than notifications — never more, never concurrent.
    if (ml < 7_000) expect(server.posts).toBe(notifications); // a routine refresh is non-forced (B1): the mint alone sets the pace
    else {
      expect(server.posts).toBeLessThanOrEqual(notifications);
      expect(server.posts).toBeGreaterThanOrEqual(Math.floor(notifications / Math.ceil((ml + 1) / 7_000)) - 1);
    }
    expect(server.maxInFlight).toBe(1);
    expect(mockSignOut).not.toHaveBeenCalled();
    const before = server.posts;
    await run(120_000);
    expect(server.posts).toBe(before);
  });

  it("a 401 on the refresh, then a 503 on the forced retry (B2): fails closed — cookie cleared, signed out, chain ends", async () => {
    const a = await signInThen(0, 0);
    seed("uid-a");
    // First answer 401, every later answer 503.
    let n = 0;
    (g.fetch as jest.Mock).mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method !== "DELETE") {
        n += 1;
        server.posts += 1;
        return n === 1 ? json(401, { error: "Invalid or expired token" }) : json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
      }
      return sessionFetch(url, init);
    });
    await flush(10_000);
    a.sdkProactiveRefresh();
    await run(TEN_MIN);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(intact("uid-a")).toBe(false);
    expect(server.posts).toBeLessThanOrEqual(3); // first + retry (+ at most one echo of the retry's forced refresh)
  });

  it("overlapping callbacks with delayed results: an older deferred answer arriving after a newer success never downgrades or clears", async () => {
    server.mintLatencyMs = 0;
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.posts = 0;
    server.mode = "outage";
    server.mintLatencyMs = 8_000;
    await flush(5_000);
    a.sdkProactiveRefresh(); // callback 1: outage answer due in 8 s
    await flush(2_000);
    server.mode = "ok";
    server.mintLatencyMs = 1_000;
    await flush(1_000);
    a.sdkProactiveRefresh(); // callback 2 (newer): succeeds in 1 s; callback 1's late 503 must be discarded as stale
    await flush(20_000);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(server.posts).toBeLessThanOrEqual(4);
  });

  it("recovery: outage, then service restored — the next token event re-establishes normally and mints stop", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.mode = "outage";
    await flush(10_000);
    a.sdkProactiveRefresh();
    await run(300_000);
    expect(probe.syncState).toBe("authenticated");
    server.mode = "ok";
    server.cookieUid = null; // even if the cookie expired meanwhile, a success re-sets it
    server.posts = 0;
    a.sdkProactiveRefresh();
    await run(300_000);
    expect(server.posts).toBeGreaterThanOrEqual(1);
    expect(server.posts).toBeLessThanOrEqual(3);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
  });

  it("logout while a deferred refresh is in flight: ends signed_out, cookie cleared, the late 503 never resurrects the session", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    seed("uid-a");
    server.mode = "outage";
    server.mintLatencyMs = 9_000;
    await flush(5_000);
    a.sdkProactiveRefresh();
    await flush(2_000); // mint in flight
    act(() => probe.beginLogout());
    await act(async () => {
      await mockSignOut();
    });
    await flush(30_000);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(intact("uid-a")).toBe(false); // real sign-out still runs the privacy cleanup
    const before = server.posts;
    await run(120_000);
    expect(server.posts).toBe(before);
  });

  it("account switch A → B while A's deferred refresh is in flight: A's cookie is cleared, B is never kept on an outage", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.mode = "outage";
    server.mintLatencyMs = 9_000;
    await flush(5_000);
    a.sdkProactiveRefresh();
    await flush(2_000);
    const b = new FakeUser("uid-b");
    fb.current = b;
    fb.notify(); // direct switch, no logout
    await flush(60_000);
    expect(server.cookieUid).not.toBe("uid-a");
    expect(probe.syncState).not.toBe("authenticated");
    expect(mockSignOut).toHaveBeenCalled(); // B's failed first mint fails closed
    const before = server.posts;
    await run(120_000);
    expect(server.posts).toBe(before);
  });
});
