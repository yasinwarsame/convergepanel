/**
 * R-S0-7 (owner decision 2026-11-27): final auth-lifecycle correction of Stage 0 (#344), review findings MINOR-1,
 * MINOR-2 and MINOR-5.
 *
 * MINOR-1 — stale destructive cleanup. At the R-S0-6 head (b906e2ef) an expired episode ran
 * `clearServerSession()` then `failClosed(ep.user)` → `signOut(auth)` with no ownership re-check: a user who signed in
 * while that DELETE was pending was signed out by it, and the DELETE itself could land after the newer mint and delete
 * the newer cookie. Now the expired identity's DELETE and sign-out run only while it still owns the tab (generation AND
 * Firebase's current User object), every mint waits for DELETEs already in flight, and every fail-closed sign-out
 * requires Firebase to still report the failed User object.
 * MINOR-2 — R-S0-4 echo by uid. A replacement User object with the same uid arriving during this tab's own token refresh
 * was swallowed as an echo; it now supersedes the episode.
 * MINOR-5 — two contract points had no killing test: failedEpisodeUser set synchronously at expiry, and the queued
 * follow-up dropped after an F3 deferral.
 *
 * Same Firebase 12.7.0 behavioural double as AuthProviderInitialEpisode.spec.tsx, plus: Firebase's `currentUser`, a
 * DELETE with latency whose clearing Set-Cookie is applied when its response is processed (like a browser), per-uid
 * revocation, and an ordered request/cookie log. "Firebase reports B before its callback ran" is modelled by setting
 * `fb.current` without notifying (the real SDK delivers observer callbacks asynchronously after updating currentUser).
 * Real AuthProvider, real sessionSync, real state machine and privacy cleanup. Synthetic data only. Deterministic
 * simulation — not a Production measurement.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

type Listener = (u: unknown) => Promise<void> | void;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fb = {
  listeners: [] as Listener[],
  current: null as FakeUser | null,
  refreshLatencyMs: 0,
  pollMs: 800,
  refreshes: 0,
  forcedRefreshes: 0,
  otherTab: false,
  otherTabReflexes: 0,
  notify() {
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
  expire() {
    this.iatSec -= 3_601;
    this.token = `synthetic-${this.uid}-${this.iatSec}`;
  }
  /** A token change from outside this tab (another tab via persistence `_assign`, or the SDK's own refresh). */
  externalChange() {
    const before = this.token;
    this.mint();
    if (this.token !== before && fb.current === this) fb.notify();
  }
  async getIdToken(force?: boolean): Promise<string> {
    const expired = Date.now() / 1000 - this.iatSec >= 3600;
    if (!force && !expired) return this.token;
    fb.refreshes += 1;
    if (force) fb.forcedRefreshes += 1;
    if (fb.refreshLatencyMs > 0) await delay(fb.refreshLatencyMs);
    const before = this.token;
    this.mint();
    const changed = this.token !== before;
    if (changed && fb.current === this) fb.notify();
    if (changed && fb.otherTab) {
      // The other (unconfirmed) tab sees this token after its poll, force-refreshes, and its newer token comes back.
      const me = this;
      void (async () => {
        await delay(fb.pollMs + fb.refreshLatencyMs);
        if (fb.otherTab && fb.current === me) {
          fb.otherTabReflexes += 1;
          me.externalChange();
        }
      })();
    }
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
const mockEvents: string[] = [];
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: (op: string) => mockEvents.push(op) }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

import { AuthProvider, useAuth, SESSION_SYNC_DEADLINE_MS } from "@/components/AuthProvider";

// ── session endpoint double (exact server contract; browser abort semantics) ──
type Mode = "ok" | "outage" | "revoked" | "401then503" | "401thenOk";
const server = {
  mode: "ok" as Mode,
  mintLatencyMs: 0,
  mintLatencyByUid: {} as Record<string, number>,
  postsByUid: {} as Record<string, number>,
  posts: 0,
  deletes: 0,
  aborted: 0,
  okAnswers: 0,
  inFlight: 0,
  maxInFlight: 0,
  cookieUid: null as string | null,
  deleteLatencyMs: 0,
  deletesInFlight: 0,
  postsDuringDelete: 0,
  revokedUids: new Set<string>(),
  log: [] as string[],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const uidOfToken = (t: string) => /^synthetic-(.+)-\d+$/.exec(t)?.[1] ?? "";
const RUNAWAY_POSTS = 200;
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
async function sessionFetch(_url: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<Response> {
  if (init?.method === "DELETE") {
    server.deletes += 1;
    server.log.push("DELETE_sent");
    server.deletesInFlight += 1;
    if (server.deleteLatencyMs > 0) await delay(server.deleteLatencyMs);
    server.deletesInFlight -= 1;
    server.cookieUid = null; // the clearing Set-Cookie is applied when the response is processed
    server.log.push("DELETE_done");
    return json(200, { ok: true });
  }
  const signal = init?.signal;
  if (signal?.aborted) {
    server.aborted += 1;
    throw abortError();
  }
  server.posts += 1;
  if (server.deletesInFlight > 0) server.postsDuringDelete += 1;
  // Runaway guard: an unbounded mint chain becomes a failed request (and so a failed assertion), never an OOM crash.
  if (server.posts > RUNAWAY_POSTS) throw new TypeError("runaway mint chain");
  server.inFlight += 1;
  server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
  try {
    const uid = uidOfToken(JSON.parse(init?.body ?? "{}").idToken ?? "");
    const n = (server.postsByUid[uid] = (server.postsByUid[uid] ?? 0) + 1);
    server.log.push(`POST_sent:${uid}`);
    const ml = server.mintLatencyByUid[uid] ?? server.mintLatencyMs;
    if (ml > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ml);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(abortError());
        });
      });
    }
    // An aborted request's response is never processed by the browser — no Set-Cookie either.
    if (signal?.aborted) throw abortError();
    if (server.mode === "401then503") return n === 1 ? json(401, { error: "Invalid or expired token" }) : json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
    if (server.mode === "outage") return json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
    if (server.mode === "revoked" || server.revokedUids.has(uid)) return json(401, { error: "Invalid or expired token" });
    if (server.mode === "401thenOk" && n === 1) return json(401, { error: "Invalid or expired token" });
    server.okAnswers += 1;
    server.cookieUid = uid; // Set-Cookie processed
    server.log.push(`COOKIE:${uid}`);
    return json(200, { authenticated: true, uid });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") server.aborted += 1;
    throw e;
  } finally {
    server.inFlight -= 1;
  }
}

// ── harness ──
let probe = { syncState: "", canMutate: false, uid: null as string | null, user: null as unknown };
const mutableSeen: Array<{ t: number; uid: string | null }> = [];
function Probe() {
  const a = useAuth();
  probe = { syncState: a.syncState, canMutate: a.canMutate, uid: (a.user as { uid?: string } | null)?.uid ?? null, user: a.user };
  if (a.canMutate) mutableSeen.push({ t: Date.now(), uid: probe.uid });
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
/** Advances `totalMs` in 1 s steps; returns the POST count of each 60 s window. */
async function run(totalMs: number, each?: (s: number) => void) {
  const perMinute: number[] = [];
  let last = server.posts;
  for (let s = 0; s < totalMs / 1000; s++) {
    each?.(s);
    await flush(1_000);
    if ((s + 1) % 60 === 0) {
      perMinute.push(server.posts - last);
      last = server.posts;
    }
  }
  return perMinute;
}
function startSignIn(u: FakeUser) {
  fb.current = u;
  fb.notify();
}
const PENDING = "convergePanelVerifyPendingV2";
function seed(uid: string) {
  local.setItem(`convergePanelHistoryV1:${uid}`, JSON.stringify([{ claim: `SYNTHETIC_CLAIM_${uid}` }]));
  session.setItem(PENDING, JSON.stringify({ v: 2, text: `SYNTHETIC_UNSAVED_${uid}`, boundUid: uid, expiresAt: Date.now() + 3_600_000 }));
}
const intact = (uid: string) => (local.getItem(`convergePanelHistoryV1:${uid}`) ?? "").includes(`SYNTHETIC_CLAIM_${uid}`);

afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
});
beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-27T12:00:00.300Z") });
  jest.clearAllMocks();
  mockEvents.length = 0;
  mutableSeen.length = 0;
  Object.assign(fb, { listeners: [], current: null, refreshLatencyMs: 0, pollMs: 800, refreshes: 0, forcedRefreshes: 0, otherTab: false, otherTabReflexes: 0 });
  Object.assign(server, { mode: "ok", mintLatencyMs: 0, mintLatencyByUid: {}, postsByUid: {}, posts: 0, deletes: 0, aborted: 0, okAnswers: 0, inFlight: 0, maxInFlight: 0, cookieUid: null, deleteLatencyMs: 0, deletesInFlight: 0, postsDuringDelete: 0, revokedUids: new Set<string>(), log: [] });
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

const DEADLINE = SESSION_SYNC_DEADLINE_MS;
const idx = (e: string) => server.log.indexOf(e);
const lastIdx = (e: string) => server.log.lastIndexOf(e);
/** A sign-in whose mint never answers, run to just past its deadline with the cleanup DELETE still pending. */
async function expireWithPendingCleanup(deleteLatencyMs: number) {
  server.mintLatencyByUid = { "uid-a": 3_600_000 };
  server.deleteLatencyMs = deleteLatencyMs;
  const a = new FakeUser("uid-a");
  startSignIn(a);
  await flush(DEADLINE + 100);
  expect(mockEvents).toContain("sync_episode_deadline_exceeded");
  expect(server.deletesInFlight).toBe(1); // the expired episode's cleanup DELETE is pending
  expect(probe.canMutate).toBe(false);
  return a;
}

describe("R-S0-7 MINOR-5 — the two contract points now have killing tests", () => {
  it("expiry sets failedEpisodeUser synchronously: a same-object callback while the expiry's DELETE is pending is dropped, never a new episode", async () => {
    const a = await expireWithPendingCleanup(5_000);
    a.externalChange(); // the failed User object's token changes while its cleanup is still pending
    await flush(100);
    expect(mockEvents).toContain("failed_episode_callback_dropped");
    await run(60_000);
    expect(server.posts).toBe(1); // no restart into the failed episode
    expect(mockSignOut).toHaveBeenCalledTimes(1); // the expired identity is still signed out after its DELETE
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(mutableSeen).toHaveLength(0);
  });

  it("a follow-up queued during a confirmed refresh is dropped when that refresh is deferred by F3 (503 auth_unavailable)", async () => {
    startSignIn(new FakeUser("uid-a"));
    await run(5_000);
    expect(probe.syncState).toBe("authenticated");
    const a = fb.current!;
    server.mode = "outage";
    server.mintLatencyMs = 5_000;
    const base = server.posts;
    a.externalChange(); // a routine same-uid refresh episode starts (non-forced, B1)
    await flush(1_500); // its POST is in flight
    a.externalChange(); // a later issue second → a new token → coalesced, one follow-up queued
    await flush(100);
    expect(mockEvents).toContain("sync_episode_callback_coalesced");
    await run(60_000);
    expect(mockEvents).toContain("token_refresh_deferred");
    expect(mockEvents).not.toContain("sync_episode_follow_up");
    expect(server.posts - base).toBe(1);
    expect(probe.syncState).toBe("authenticated"); // F3 kept the confirmed session
  });
});

describe("R-S0-7 MINOR-1 — an expired episode's cleanup never signs out or clobbers a newer identity", () => {
  it("before cleanup begins: Firebase already reports B when A's deadline fires → no DELETE, no sign-out; B is authenticated by its own mint", async () => {
    server.mintLatencyByUid = { "uid-a": 3_600_000 };
    startSignIn(new FakeUser("uid-a"));
    await flush(DEADLINE - 50);
    const b = new FakeUser("uid-b");
    fb.current = b; // Firebase reports B; its observer notification has not been delivered yet
    await flush(100); // A's deadline fires
    expect(mockEvents).toContain("sync_episode_deadline_exceeded");
    expect(mockEvents).toContain("stale_cleanup_skipped");
    expect(server.deletes).toBe(0);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.canMutate).toBe(false);
    fb.notify();
    await run(30_000);
    expect(probe.user).toBe(b);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-b");
    expect(server.deletes).toBe(0);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mutableSeen.every((m) => m.uid === "uid-b")).toBe(true);
  });

  it("A → B while A's cleanup DELETE is pending: B is never signed out, B's mint is sent only after the DELETE settled, the cookie is B's", async () => {
    await expireWithPendingCleanup(5_000);
    const b = new FakeUser("uid-b");
    startSignIn(b);
    await flush(100);
    seed("uid-b");
    expect(server.postsByUid["uid-b"] ?? 0).toBe(0); // B's mint waits for the in-flight DELETE
    expect(probe.canMutate).toBe(false);
    await run(60_000);
    expect(probe.user).toBe(b);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-b");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(server.postsDuringDelete).toBe(0);
    expect(idx("DELETE_done")).toBeLessThan(idx("POST_sent:uid-b"));
    expect(lastIdx("COOKIE:uid-b")).toBeGreaterThan(lastIdx("DELETE_done"));
    expect(mockEvents).toContain("stale_cleanup_skipped");
    expect(intact("uid-b")).toBe(true); // no privacy cleanup against B
    expect(mutableSeen.every((m) => m.uid === "uid-b")).toBe(true);
  });

  it("same uid, new User object while the cleanup is pending, and its mint still pending when the DELETE completes: not signed out, authenticated by its own mint", async () => {
    await expireWithPendingCleanup(3_000);
    server.mintLatencyByUid = { "uid-a": 8_000 };
    const a2 = new FakeUser("uid-a"); // a fresh sign-in of the same account (a new User object)
    startSignIn(a2);
    await flush(4_000); // the DELETE completed at +3 s; a2's mint (sent after it) is pending
    expect(server.deletesInFlight).toBe(0);
    expect(server.postsByUid["uid-a"]).toBe(2);
    expect(server.inFlight).toBe(1);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.user).toBe(a2);
    expect(probe.canMutate).toBe(false); // no protected authorization before a2's own 200
    await run(30_000);
    expect(probe.user).toBe(a2);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
    expect(server.okAnswers).toBe(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("logout → login (B) while the cleanup is pending: only the explicit logout signs out; B's mint follows both DELETEs; the cookie is B's", async () => {
    await expireWithPendingCleanup(5_000);
    await act(async () => {
      await mockSignOut(); // explicit logout → null callback → privacy cleanup + its defensive DELETE
    });
    await flush(100);
    expect(probe.syncState).toBe("signed_out");
    const b = new FakeUser("uid-b");
    startSignIn(b);
    await run(60_000);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.user).toBe(b);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-b");
    expect(server.postsDuringDelete).toBe(0);
    expect(lastIdx("DELETE_done")).toBeLessThan(idx("POST_sent:uid-b"));
    expect(mutableSeen.every((m) => m.uid === "uid-b")).toBe(true);
  });

  it("logout → the same User object restored while the cleanup is pending: the stale cleanup is not authoritative because the object matches — the generation moved on", async () => {
    const a = await expireWithPendingCleanup(5_000);
    await act(async () => {
      await mockSignOut();
    });
    await flush(100);
    server.mintLatencyByUid = {};
    startSignIn(a);
    await run(60_000);
    expect(mockSignOut).toHaveBeenCalledTimes(1); // the explicit logout only
    expect(probe.user).toBe(a);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
  });

  it("A → B → A (new A object) while the cleanup is pending: final A authenticated by its own mint, B never mutable, no sign-out", async () => {
    await expireWithPendingCleanup(5_000);
    server.mintLatencyByUid = { "uid-b": 2_000 };
    startSignIn(new FakeUser("uid-b"));
    await flush(1_000);
    const a2 = new FakeUser("uid-a");
    startSignIn(a2);
    await run(60_000);
    expect(probe.user).toBe(a2);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(server.postsDuringDelete).toBe(0);
    expect(mutableSeen.every((m) => m.uid === "uid-a")).toBe(true);
  });

  it("control: with no newer identity, the expired identity is still fully cleaned up — DELETE, then sign-out, privacy cleanup, nothing restarts", async () => {
    await expireWithPendingCleanup(5_000);
    seed("uid-a");
    await run(60_000);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(server.posts).toBe(1);
    expect(intact("uid-a")).toBe(false);
  });
});

describe("R-S0-7 — a token rejection signs out only the identity it was about", () => {
  it("revoked at sign-in: fail closed — cookie cleared, signed out, privacy cleanup, never authenticated", async () => {
    server.mode = "revoked";
    startSignIn(new FakeUser("uid-a"));
    seed("uid-a");
    await run(30_000);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(server.posts).toBeLessThanOrEqual(2);
    expect(mutableSeen).toHaveLength(0);
    expect(intact("uid-a")).toBe(false);
  });

  it("A's rejection is handled after Firebase already reports B: A's failure does not sign B out; B is authenticated by its own mint", async () => {
    server.revokedUids.add("uid-a");
    server.mintLatencyByUid = { "uid-a": 3_000 };
    startSignIn(new FakeUser("uid-a"));
    await flush(5_500); // first 401 at 3 s, the forced retry's POST is pending
    const b = new FakeUser("uid-b");
    fb.current = b; // Firebase reports B; its callback has not run yet
    await flush(1_000); // A's retry answers 401 → A's sync fails closed
    expect(mockEvents).toContain("stale_cleanup_skipped");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.canMutate).toBe(false);
    fb.notify();
    await run(30_000);
    expect(probe.user).toBe(b);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-b");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mutableSeen.every((m) => m.uid === "uid-b")).toBe(true);
  });
});

describe("R-S0-7 MINOR-2 — an echo is the same User object; a same-uid replacement supersedes", () => {
  it("a replaced User object (same uid) during this tab's own token refresh supersedes the episode: it is synced and exposed, the old object never mints", async () => {
    fb.refreshLatencyMs = 2_000;
    const a = new FakeUser("uid-a");
    startSignIn(a);
    await flush(500); // a's forced refresh is pending (own-refresh window)
    const a2 = new FakeUser("uid-a");
    startSignIn(a2);
    await flush(100);
    expect(mockEvents).not.toContain("own_refresh_echo_coalesced");
    expect(probe.user).toBe(a2);
    await run(60_000);
    expect(probe.user).toBe(a2);
    expect(probe.syncState).toBe("authenticated");
    expect(fb.forcedRefreshes).toBe(2); // a2 got its own forced sync
    expect(server.postsByUid["uid-a"]).toBe(1); // a was superseded during its token read: its POST was never sent
    expect(server.okAnswers).toBe(1);
  });

  it("control: the same object's own refresh echo is still coalesced (R-S0-4) — one forced refresh, one mint", async () => {
    fb.refreshLatencyMs = 1_500;
    startSignIn(new FakeUser("uid-a"));
    await run(60_000);
    expect(mockEvents).toContain("own_refresh_echo_coalesced");
    expect(fb.forcedRefreshes).toBe(1);
    expect(server.posts).toBe(1);
    expect(probe.syncState).toBe("authenticated");
  });

  it("the other tab reflexing to every new token (same object) after the replacement stays bounded: one follow-up at most, then silence", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    fb.otherTab = true;
    startSignIn(new FakeUser("uid-a"));
    await flush(500);
    const a2 = new FakeUser("uid-a");
    startSignIn(a2);
    const perMinute = await run(TEN_MIN);
    expect(probe.user).toBe(a2);
    expect(probe.syncState).toBe("authenticated");
    expect(server.posts).toBeLessThanOrEqual(3); // a2's mint + at most one follow-up (+ a's, if it was sent before the switch)
    expect(perMinute.slice(1).every((n) => n === 0)).toBe(true);
  });
});
