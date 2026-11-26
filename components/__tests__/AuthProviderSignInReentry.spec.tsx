/**
 * R-S0-4 (owner decision 2026-11-26): Firebase onIdTokenChanged re-entry on sign-in, cold load and account switch.
 *
 * Firebase 12.7.0 behavioural double: the model reviewed for #332 R8 and Stage 0 B1
 * (components/__tests__/AuthProviderCallbackReentry.spec.tsx on #344), read from the installed SDK
 * (node_modules/@firebase/auth/dist/esm/index-36fcbc82.js):
 * - `getIdToken(force)` (:1762-1771): a token different from the current one → `_notifyListenersIfCurrent` →
 *   `idTokenSubscription.next(currentUser)` (:3076-3080), delivered as a promise microtask BEFORE getIdToken resolves.
 * - Tokens carry `iat` in whole seconds: a forced refresh in the same second as the previous mint yields the same token
 *   (no notification); one in a later second yields a new token (notification).
 * - A non-forced getIdToken returns the cached token while unexpired; an expired one is refreshed (and notifies).
 * - `signOut` → listeners notified with null.
 * - Latency: a forced refresh takes `refreshLatencyMs` (securetoken), the session POST `mintLatencyMs` (or per uid).
 *
 * Real AuthProvider, real sessionSync, real state machine and privacy cleanup; only `fetch` (the session endpoint,
 * exact server contract) and the Firebase client SDK are faked. Synthetic data only. This is a deterministic
 * simulation, not a Production measurement.
 *
 * - "measurement": head-agnostic; records mint counts over 10 simulated minutes (REENTRY_REPORT=<file>). Run on the
 *   baseline (main) and on the fix to show the original chain and its removal.
 * - "R-S0-4 contract": the corrected behaviour.
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
  /** A persisted user restored on cold load whose cached token has already expired. */
  expire() {
    this.iatSec -= 3_601;
    this.token = `synthetic-${this.uid}-${this.iatSec}`;
  }
  /** An external token change (another tab's refresh via persistence, the SDK's own refresh) — not this app's. */
  externalChange() {
    this.sdkProactiveRefresh();
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
jest.mock("@/lib/firebase/client", () => ({ auth: {} }));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

import { AuthProvider, useAuth } from "@/components/AuthProvider";

// ── the session endpoint double (exact server contract) ───────────────────────
type Mode = "ok" | "outage" | "revoked" | "401then503";
const server = {
  mode: "ok" as Mode,
  mintLatencyMs: 0,
  mintLatencyByUid: {} as Record<string, number>,
  postsByUid: {} as Record<string, number>,
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
    server.postsByUid[uid] = (server.postsByUid[uid] ?? 0) + 1;
    const ml = server.mintLatencyByUid[uid] ?? server.mintLatencyMs;
    if (ml > 0) await delay(ml); // verification time
    if (server.mode === "401then503") return server.postsByUid[uid] === 1 ? json(401, { error: "Invalid or expired token" }) : json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
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
let probe = { syncState: "", canMutate: true, uid: null as string | null, beginLogout: () => undefined as void };
function Probe() {
  const a = useAuth();
  probe = { syncState: a.syncState, canMutate: a.canMutate, uid: (a.user as { uid?: string } | null)?.uid ?? null, beginLogout: a.beginLogout };
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
  Object.assign(server, { mode: "ok", mintLatencyMs: 0, mintLatencyByUid: {}, postsByUid: {}, posts: 0, deletes: 0, inFlight: 0, maxInFlight: 0, cookieUid: null });
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

const LAT: Array<[number, number]> = [
  [0, 0],
  [300, 200],
  [800, 2_000],
  [999, 10_000],
  [1_000, 200],
  [1_500, 2_000],
  [1_500, 10_000],
  [5_000, 10_000],
];
const rec = (k: string, extra: Record<string, unknown> = {}) => {
  report[k] = { posts: server.posts, maxInFlight: server.maxInFlight, refreshes: fb.refreshes, signOuts: mockSignOut.mock.calls.length, state: probe.syncState, cookie: server.cookieUid, ...extra };
};
/** Sign A in at zero latency (baseline-safe), then apply the latencies. */
async function confirmedA(rl: number, ml: number) {
  const a = new FakeUser("uid-a");
  await signIn(a);
  expect(probe.syncState).toBe("authenticated");
  fb.refreshLatencyMs = rl;
  server.mintLatencyMs = ml;
  server.posts = 0;
  server.postsByUid = {};
  server.maxInFlight = 0;
  fb.refreshes = 0;
  return a;
}
function startSignIn(u: FakeUser) {
  fb.current = u;
  fb.notify();
}

// ── Measurement (head-agnostic) ───────────────────────────────────────────────
describe("measurement — mint requests over 10 simulated minutes", () => {
  it.each(LAT)("sign-in, healthy: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    startSignIn(new FakeUser("uid-a"));
    const perMinute = await run(TEN_MIN);
    rec(`signin-healthy rl=${rl} ml=${ml}`, { perMinute });
  });
  it.each(LAT)("sign-in, outage: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    server.mode = "outage";
    startSignIn(new FakeUser("uid-a"));
    const perMinute = await run(TEN_MIN);
    rec(`signin-outage rl=${rl} ml=${ml}`, { perMinute });
  });
  it.each(LAT)("cold load (persisted, expired token), healthy: refresh %i ms / mint %i ms", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    const a = new FakeUser("uid-a");
    a.expire();
    startSignIn(a);
    const perMinute = await run(TEN_MIN);
    rec(`coldload rl=${rl} ml=${ml}`, { perMinute });
  });
  it.each(LAT)("direct switch A → B, healthy: refresh %i ms / mint %i ms", async (rl, ml) => {
    await confirmedA(rl, ml);
    startSignIn(new FakeUser("uid-b"));
    const perMinute = await run(TEN_MIN);
    rec(`switch rl=${rl} ml=${ml}`, { perMinute, postsByUid: { ...server.postsByUid } });
  });
  it.each(LAT)("confirmed session, one routine refresh, healthy: refresh %i ms / mint %i ms", async (rl, ml) => {
    const a = await confirmedA(rl, ml);
    await flush(10_000);
    a.externalChange();
    const perMinute = await run(TEN_MIN);
    rec(`refresh rl=${rl} ml=${ml}`, { perMinute });
  });
  it.each(LAT)("confirmed session, external token change every 7 s: refresh %i ms / mint %i ms", async (rl, ml) => {
    const a = await confirmedA(rl, ml);
    let events = 0;
    const perMinute = await run(TEN_MIN, (s) => {
      if (s % 7 === 0) {
        events += 1;
        a.externalChange();
      }
    });
    rec(`external7s rl=${rl} ml=${ml}`, { perMinute, events });
  });
});

// ── R-S0-4 contract ───────────────────────────────────────────────────────────
describe("R-S0-4 contract — one identity event never becomes a self-sustaining mint sequence", () => {
  it.each(LAT)("sign-in, healthy, refresh %i ms / mint %i ms: one forced refresh, one mint, authenticated, nothing after", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    startSignIn(new FakeUser("uid-a"));
    const perMinute = await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(fb.refreshes).toBe(1); // the fresh credential is still forced (Step 6.5)
    expect(perMinute.slice(1).every((n) => n === 0)).toBe(true);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(LAT)("sign-in during an outage, refresh %i ms / mint %i ms: one mint, fail closed (signed out), nothing after", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    server.mode = "outage";
    startSignIn(new FakeUser("uid-a"));
    await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
  });

  it.each(LAT)("cold load with an expired persisted token, refresh %i ms / mint %i ms: one mint, authenticated", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    const a = new FakeUser("uid-a");
    a.expire();
    startSignIn(a);
    await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
  });

  it.each(LAT)("direct switch A → B, refresh %i ms / mint %i ms: B gets one forced refresh and one mint; A is never re-minted", async (rl, ml) => {
    await confirmedA(rl, ml);
    startSignIn(new FakeUser("uid-b"));
    await run(TEN_MIN);
    expect(server.postsByUid).toEqual({ "uid-b": 1 });
    expect(fb.refreshes).toBe(1);
    expect(probe.syncState).toBe("authenticated");
    expect(probe.uid).toBe("uid-b");
    expect(server.cookieUid).toBe("uid-b");
  });

  it.each(LAT)("confirmed session, routine refresh, refresh %i ms / mint %i ms: one mint per external event, nothing self-sustains", async (rl, ml) => {
    const a = await confirmedA(rl, ml);
    await flush(10_000);
    a.externalChange();
    await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(probe.syncState).toBe("authenticated");
  });

  it.each(LAT)("external token changes every 7 s, refresh %i ms / mint %i ms: mints bounded by external events (≤ 1 each), stop when they stop", async (rl, ml) => {
    const a = await confirmedA(rl, ml);
    let events = 0;
    await run(TEN_MIN, (s) => {
      if (s % 7 === 0) {
        events += 1;
        a.externalChange();
      }
    });
    expect(server.posts).toBeGreaterThanOrEqual(1);
    expect(server.posts).toBeLessThanOrEqual(events);
    expect(probe.syncState).toBe("authenticated");
    const before = server.posts;
    await run(120_000);
    expect(server.posts).toBe(before);
  });

  it("an external token change DURING the mint request (after the refresh resolved) is reconciled by exactly one follow-up sync (R-S0-6), not a new forced sync", async () => {
    const a = await confirmedA(1_500, 10_000);
    startSignIn(new FakeUser("uid-b")); // B: refresh 1.5 s, then a 10 s mint
    await flush(3_000); // B's refresh resolved; B's mint in flight
    const b = fb.current!;
    b.externalChange();
    await run(60_000);
    expect(server.postsByUid["uid-b"]).toBe(2); // R-S0-6: coalesced into B's episode, then ONE non-forced follow-up; no chain
    expect(fb.refreshes).toBe(1); // only B's Step 6.5 forced refresh
    expect(probe.syncState).toBe("authenticated");
    expect(probe.uid).toBe("uid-b");
    void a;
  });

  it("revoked / invalid credential at sign-in (401 on both tries), refresh 1.5 s: fail closed, bounded (≤ 2 mints), signed out", async () => {
    fb.refreshLatencyMs = 1_500;
    server.mode = "revoked";
    startSignIn(new FakeUser("uid-a"));
    await run(TEN_MIN);
    expect(server.posts).toBe(2); // first + the bounded retry; the retry's own forced refresh echo is coalesced
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
  });

  it("401 then 503 at sign-in, refresh 1.5 s: fail closed, signed out, bounded", async () => {
    fb.refreshLatencyMs = 1_500;
    server.mode = "401then503";
    startSignIn(new FakeUser("uid-a"));
    await run(TEN_MIN);
    expect(server.posts).toBe(2);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
  });

  it("logout during the sign-in sync (refresh 1.5 s, mint 10 s): ends signed_out, the late success never re-authenticates, nothing after", async () => {
    fb.refreshLatencyMs = 1_500;
    server.mintLatencyMs = 10_000;
    const a = new FakeUser("uid-a");
    startSignIn(a);
    seed("uid-a");
    await flush(3_000);
    act(() => probe.beginLogout());
    await act(async () => {
      await mockSignOut();
    });
    await run(60_000);
    expect(probe.syncState).toBe("signed_out");
    expect(intact("uid-a")).toBe(false); // privacy cleanup on genuine logout
    const before = server.posts;
    await run(120_000);
    expect(server.posts).toBe(before);
  });

  it("logout while the sign-in refresh itself is pending (refresh 5 s): the null callback is never coalesced", async () => {
    fb.refreshLatencyMs = 5_000;
    startSignIn(new FakeUser("uid-a"));
    seed("uid-a");
    await flush(1_000); // forced refresh pending
    await act(async () => {
      await mockSignOut();
    });
    await run(60_000);
    expect(probe.syncState).toBe("signed_out");
    expect(probe.uid).toBeNull();
    expect(intact("uid-a")).toBe(false);
  });

  it("logout while A's refresh is pending, then A signs in again while that old refresh is STILL pending: the new sign-in is not coalesced into the stale one", async () => {
    fb.refreshLatencyMs = 20_000;
    const a = new FakeUser("uid-a");
    startSignIn(a);
    await flush(1_000); // A's first forced refresh pending (gen 1)
    await act(async () => {
      await mockSignOut();
    });
    await flush(1_000);
    fb.refreshLatencyMs = 0;
    startSignIn(a); // the same uid again; the stale refresh is still pending for another ~18 s
    await flush(3_000);
    expect(probe.syncState).toBe("authenticated");
    expect(probe.uid).toBe("uid-a");
    await run(60_000);
    expect(probe.syncState).toBe("authenticated");
  });

  it("switch to B while A's sign-in refresh is pending (refresh 5 s): B is not coalesced into A; A's late result never applies", async () => {
    fb.refreshLatencyMs = 5_000;
    startSignIn(new FakeUser("uid-a"));
    await flush(1_000);
    startSignIn(new FakeUser("uid-b"));
    await run(60_000);
    expect(probe.uid).toBe("uid-b");
    expect(probe.syncState).toBe("authenticated");
    expect(server.postsByUid["uid-b"]).toBe(1);
  });

  it("late A response after B becomes current: B's tab is authenticated only by B's own confirmed mint; A's result is discarded", async () => {
    server.mintLatencyByUid = { "uid-a": 20_000, "uid-b": 1_000 };
    startSignIn(new FakeUser("uid-a"));
    await flush(2_000); // A's mint in flight (20 s)
    startSignIn(new FakeUser("uid-b"));
    await flush(5_000);
    expect(probe.uid).toBe("uid-b");
    expect(probe.syncState).toBe("authenticated");
    await flush(30_000); // A's late answer arrives
    expect(probe.uid).toBe("uid-b");
    expect(probe.syncState).toBe("authenticated");
    // Pre-existing (identical on main, not changed by R-S0-4): A's late Set-Cookie lands in the shared jar. The client
    // never treats it as B's session; server-side cookie/bearer mismatch rows refuse such requests.
    report["late-A-after-B cookie"] = server.cookieUid;
  });

  it("unmount during the sign-in sync: no further mints, no state updates after unmount", async () => {
    fb.refreshLatencyMs = 1_500;
    server.mintLatencyMs = 2_000;
    startSignIn(new FakeUser("uid-a"));
    await flush(500);
    act(() => renderer?.unmount());
    renderer = null;
    const before = server.posts;
    await run(60_000);
    expect(server.posts).toBeLessThanOrEqual(before + 1); // the already-started sync may finish its one POST
    expect(fb.listeners.length).toBe(0);
  });
});
