/**
 * R-S0-6 (owner decision 2026-11-27): the INITIAL session synchronization is single-flight.
 *
 * Defect (diagnosed in real browsers, evidence 09-s0int-preconfirm-amplification-diagnosis.md): before a tab's server
 * session is confirmed, every callback counted as a new identity. A token minted by another tab arrived through
 * persistence AFTER this tab's own token read had finished (so R-S0-4 did not coalesce it), bumped the generation —
 * discarding the pending mint, valid 200 or 401 alike — and forced another refresh, whose new token restarted the other
 * tab's sync in turn. With a mint slower than that cycle, no answer was ever applied: tabs stuck in syncing_session,
 * mints sustained, and a revocation (401) never signed the tab out.
 *
 * Firebase 12.7.0 behavioural double (same model as AuthProviderSignInReentry.spec.tsx / #332 R8), plus:
 * - OTHER TAB (adversarial reflex): every NEW token this tab's own forced refresh produces is seen by the other tab
 *   after the 800 ms persistence poll; still unconfirmed, it force-refreshes (refreshLatencyMs) and its new token
 *   reaches this tab's SAME User object (`_assign`) → onIdTokenChanged. This is the other half of the real loop; it
 *   reflexes once per new token of ours and never on its own.
 * - The session endpoint double honours AbortSignal like a browser: an aborted request is rejected and its response
 *   (including Set-Cookie) is never processed.
 *
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
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const uidOfToken = (t: string) => /^synthetic-(.+)-\d+$/.exec(t)?.[1] ?? "";
const RUNAWAY_POSTS = 200;
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
async function sessionFetch(_url: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<Response> {
  if (init?.method === "DELETE") {
    server.deletes += 1;
    server.cookieUid = null;
    return json(200, { ok: true });
  }
  const signal = init?.signal;
  if (signal?.aborted) {
    server.aborted += 1;
    throw abortError();
  }
  server.posts += 1;
  // Runaway guard: an unbounded mint chain becomes a failed request (and so a failed assertion), never an OOM crash.
  if (server.posts > RUNAWAY_POSTS) throw new TypeError("runaway mint chain");
  server.inFlight += 1;
  server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
  try {
    const uid = uidOfToken(JSON.parse(init?.body ?? "{}").idToken ?? "");
    const n = (server.postsByUid[uid] = (server.postsByUid[uid] ?? 0) + 1);
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
    if (server.mode === "revoked") return json(401, { error: "Invalid or expired token" });
    if (server.mode === "401thenOk" && n === 1) return json(401, { error: "Invalid or expired token" });
    server.okAnswers += 1;
    server.cookieUid = uid; // Set-Cookie processed
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
  Object.assign(server, { mode: "ok", mintLatencyMs: 0, mintLatencyByUid: {}, postsByUid: {}, posts: 0, deletes: 0, aborted: 0, okAnswers: 0, inFlight: 0, maxInFlight: 0, cookieUid: null });
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
  // ZCA P3 R2 (R2 MA, invariant 5): the client never sends a DELETE to the session endpoint, in any scenario.
  expect(server.deletes).toBe(0);
});

const TEN_MIN = 600_000;
/** Refresh / mint latencies around the reproduced boundary (2 tabs 1.2 s / 2.5 s; 3 tabs 1.2 s / 5 s) and beyond. */
const LOOP: Array<[number, number]> = [
  [1_200, 2_500],
  [1_200, 5_000],
  [1_500, 10_000],
  [2_000, 5_000],
  [600, 5_000],
];

describe("R-S0-6 — the reproduced cross-tab loop terminates (other tab reflexes to every new token)", () => {
  it.each(LOOP)("sign-in, refresh %i ms / mint %i ms: authenticated, one forced refresh, initial mint + at most one follow-up, then silence", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    fb.otherTab = true;
    startSignIn(new FakeUser("uid-a"));
    const perMinute = await run(TEN_MIN);
    expect(probe.syncState).toBe("authenticated");
    expect(probe.uid).toBe("uid-a");
    expect(fb.forcedRefreshes).toBe(1); // Step 6.5's fresh credential; nothing else forces
    expect(server.posts).toBeGreaterThanOrEqual(1);
    expect(server.posts).toBeLessThanOrEqual(2); // initial + the single follow-up
    expect(perMinute.slice(1).every((n) => n === 0)).toBe(true);
    expect(fb.otherTabReflexes).toBeLessThanOrEqual(1);
    expect(server.cookieUid).toBe("uid-a");
    // Coalescing happens exactly when the other tab's token arrived during the episode (a sub-second refresh that stays
    // in the same issue second produces no new token, so nothing to reflex to).
    expect(mockEvents.includes("sync_episode_callback_coalesced")).toBe(fb.otherTabReflexes > 0);
    expect(mockEvents).not.toContain("stale_auth_operation_discarded");
    expect(jest.getTimerCount()).toBe(0); // the episode deadline was cleared
  });

  it.each(LOOP)("cold load with an expired persisted token, refresh %i ms / mint %i ms: authenticated, bounded", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    fb.otherTab = true;
    const a = new FakeUser("uid-a");
    a.expire();
    startSignIn(a);
    const perMinute = await run(TEN_MIN);
    expect(probe.syncState).toBe("authenticated");
    expect(server.posts).toBeLessThanOrEqual(2);
    expect(perMinute.slice(1).every((n) => n === 0)).toBe(true);
  });

  it("repeated token changes in different issue seconds during the pending mint coalesce into exactly ONE follow-up", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 8_000;
    startSignIn(new FakeUser("uid-a"));
    await flush(2_000); // refresh resolved, mint in flight
    const a = fb.current!;
    for (let i = 0; i < 5; i++) {
      a.externalChange(); // each in a later second → a genuinely new token
      await flush(1_100);
    }
    expect(probe.canMutate).toBe(false); // nothing is mutable before the server answers
    await run(60_000);
    expect(server.posts).toBe(2); // initial + exactly one follow-up
    expect(fb.forcedRefreshes).toBe(1); // the follow-up is non-forced (B1)
    expect(mockEvents.filter((e) => e === "sync_episode_follow_up")).toHaveLength(1);
    expect(probe.syncState).toBe("authenticated");
  });

  it("protected operations stay disabled for the whole episode, however many same-identity callbacks arrive; enabled only by the server's 200", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    fb.otherTab = true;
    const t0 = Date.now();
    startSignIn(new FakeUser("uid-a"));
    await run(30_000);
    expect(probe.canMutate).toBe(true);
    const firstMutable = mutableSeen[0];
    // 0 → 1.2 s refresh → 5 s mint: never mutable before the first 200 could have arrived.
    expect(firstMutable.t - t0).toBeGreaterThanOrEqual(1_200 + 5_000);
    expect(mutableSeen.every((m) => m.uid === "uid-a")).toBe(true);
  });
});

describe("R-S0-6 — revocation and failures during the initial episode are applied, never discarded as stale", () => {
  it.each(LOOP)("server starts answering 401 (revoked/disabled/invalid) during the episode, refresh %i ms / mint %i ms: signed out, cookie cleared, bounded, never authenticated", async (rl, ml) => {
    fb.refreshLatencyMs = rl;
    server.mintLatencyMs = ml;
    fb.otherTab = true;
    const a = new FakeUser("uid-a");
    startSignIn(a);
    seed("uid-a");
    await flush(rl + 200); // the mint is in flight
    server.mode = "revoked";
    await run(TEN_MIN);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
    expect(probe.uid).toBeNull();
    expect(server.cookieUid).toBeNull();
    expect(server.posts).toBeLessThanOrEqual(2); // first + the bounded forced retry
    expect(mutableSeen).toHaveLength(0);
    expect(intact("uid-a")).toBe(false); // privacy cleanup on the sign-out
  });

  it("401 then 503 during the episode with interleaved callbacks: fail closed", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    fb.otherTab = true;
    server.mode = "401then503";
    startSignIn(new FakeUser("uid-a"));
    await run(TEN_MIN);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(server.posts).toBe(2);
    expect(mutableSeen).toHaveLength(0);
  });

  it("verification outage for a new identity with interleaved callbacks: one mint, fail closed (no kept session)", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    fb.otherTab = true;
    server.mode = "outage";
    startSignIn(new FakeUser("uid-a"));
    await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
  });

  it("the single follow-up hits a revocation (401 after the initial 200): fail closed, signed out", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    fb.otherTab = true;
    startSignIn(new FakeUser("uid-a"));
    await flush(1_400); // mint in flight; the other tab's token arrives during it (follow-up queued)
    await flush(2_000);
    server.mintLatencyByUid = {};
    const answered = server.okAnswers;
    // Revoke between the initial 200 and the follow-up.
    await run(10_000, () => {
      if (server.okAnswers > answered && server.mode === "ok") server.mode = "revoked";
    });
    await run(60_000);
    expect(mockEvents).toContain("sync_episode_follow_up");
    expect(probe.syncState).toBe("signed_out");
    // ZCA P3 R2: nothing to clear on the server (the afterEach pins that no DELETE was sent).
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("after a fail-closed episode, the same User object never restarts a sync until Firebase reports null", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mode = "outage";
    mockSignOut.mockImplementationOnce(async () => {
      throw new Error("sign-out failed");
    });
    const a = new FakeUser("uid-a");
    startSignIn(a);
    await run(10_000);
    expect(server.posts).toBe(1);
    expect(probe.syncState).toBe("session_error");
    server.mode = "ok";
    a.externalChange(); // the SDK keeps notifying for the failed user object
    await run(60_000);
    expect(server.posts).toBe(1); // dropped — no automatic restart
    expect(probe.canMutate).toBe(false);
    expect(mockEvents).toContain("failed_episode_callback_dropped");
    // An explicit fresh sign-in (Firebase reports null, then a new User object) recovers.
    await act(async () => {
      fb.current = null;
      fb.notify();
    });
    await flush(100);
    startSignIn(new FakeUser("uid-a"));
    await run(30_000);
    expect(probe.syncState).toBe("authenticated");
  });
});

describe("R-S0-6 — the follow-up is bounded", () => {
  it.each([0, 2_000])("a sign-in with no other token change (mint %i ms) gets NO follow-up: exactly one mint over 10 minutes", async (ml) => {
    server.mintLatencyMs = ml;
    startSignIn(new FakeUser("uid-a"));
    await run(TEN_MIN);
    expect(server.posts).toBe(1);
    expect(mockEvents).not.toContain("sync_episode_follow_up");
    expect(probe.syncState).toBe("authenticated");
  });
});

describe("R-S0-6 — the client deadline fails closed", () => {
  it("documents the deadline: 30 s (2 × (refresh + 10 s server deadline + transport))", () => {
    expect(SESSION_SYNC_DEADLINE_MS).toBe(30_000);
  });

  it("a mint that never answers: at the deadline the POST is aborted, the cookie cleared, Firebase signed out; nothing restarts", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 3_600_000; // hung upstream
    fb.otherTab = true;
    const a = new FakeUser("uid-a");
    startSignIn(a);
    seed("uid-a");
    await flush(SESSION_SYNC_DEADLINE_MS - 1_000);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.canMutate).toBe(false);
    await flush(2_000);
    expect(mockEvents).toContain("sync_episode_deadline_exceeded");
    expect(server.aborted).toBeGreaterThanOrEqual(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await run(TEN_MIN);
    expect(probe.syncState).toBe("signed_out");
    expect(server.cookieUid).toBeNull();
    expect(server.posts).toBe(1); // no recursive minting after the deadline
    expect(server.okAnswers).toBe(0);
    expect(mutableSeen).toHaveLength(0);
    expect(intact("uid-a")).toBe(false);
  });

  it("a hung mint with the other tab still reflexing: after the deadline, callbacks for the failed user never restart minting", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 3_600_000;
    fb.otherTab = true;
    mockSignOut.mockImplementationOnce(async () => undefined); // sign-out that does not (yet) notify null
    const a = new FakeUser("uid-a");
    startSignIn(a);
    await flush(SESSION_SYNC_DEADLINE_MS + 1_000);
    const posts = server.posts;
    await run(120_000, (s) => {
      if (s % 3 === 0) a.externalChange();
    });
    expect(server.posts).toBe(posts);
    expect(probe.canMutate).toBe(false);
    expect(mockEvents).toContain("failed_episode_callback_dropped");
  });

  it("a legitimately slow two-attempt success (401 race + retry, 12 s mints) completes inside the deadline", async () => {
    fb.refreshLatencyMs = 1_500;
    server.mintLatencyMs = 12_000;
    server.mode = "401thenOk";
    startSignIn(new FakeUser("uid-a"));
    await run(60_000);
    expect(probe.syncState).toBe("authenticated");
    expect(server.posts).toBe(2);
    expect(mockEvents).not.toContain("sync_episode_deadline_exceeded");
  });
});

describe("R-S0-6 — identity changes are never coalesced and always take precedence", () => {
  it("logout while the initial mint is pending: immediate, privacy cleanup, the pending POST is aborted so its late 200 sets no cookie", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 10_000;
    fb.otherTab = true;
    startSignIn(new FakeUser("uid-a"));
    seed("uid-a");
    await flush(3_000);
    await act(async () => {
      await mockSignOut();
    });
    await flush(100);
    expect(probe.syncState).toBe("signed_out");
    expect(intact("uid-a")).toBe(false);
    await run(60_000);
    expect(server.okAnswers).toBe(0);
    expect(server.aborted).toBeGreaterThanOrEqual(1);
    expect(server.cookieUid).toBeNull(); // no late 200 is applied (ZCA P3 R2: and there is no cleanup DELETE)
    expect(mutableSeen).toHaveLength(0);
  });

  it("A → B while A's initial mint is pending: A's POST aborted, B authenticated by B's own mint, the cookie is B's", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyByUid = { "uid-a": 20_000, "uid-b": 2_000 };
    startSignIn(new FakeUser("uid-a"));
    await flush(2_000);
    startSignIn(new FakeUser("uid-b"));
    await run(60_000);
    expect(probe.uid).toBe("uid-b");
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-b"); // A's late answer was aborted, so it never overwrote B's cookie
    expect(server.aborted).toBeGreaterThanOrEqual(1);
    expect(mutableSeen.every((m) => m.uid === "uid-b")).toBe(true);
  });

  it("A → B → A while A's first mint is pending: final A is authenticated by the new A episode only", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 4_000;
    startSignIn(new FakeUser("uid-a"));
    await flush(2_000);
    startSignIn(new FakeUser("uid-b"));
    await flush(2_000);
    const a2 = new FakeUser("uid-a");
    startSignIn(a2);
    await run(60_000);
    expect(probe.uid).toBe("uid-a");
    expect(probe.user).toBe(a2);
    expect(probe.syncState).toBe("authenticated");
    expect(server.cookieUid).toBe("uid-a");
    expect(mutableSeen.every((m) => m.uid === "uid-a")).toBe(true);
    expect(server.postsByUid["uid-a"]).toBe(2); // the superseded first A and the final A — no extra
  });

  it("a replaced Firebase User object (same uid) during the episode is not coalesced: it gets its own forced sync and becomes the exposed user", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    startSignIn(new FakeUser("uid-a"));
    await flush(2_000);
    const replacement = new FakeUser("uid-a");
    startSignIn(replacement);
    await run(60_000);
    expect(probe.user).toBe(replacement);
    expect(probe.syncState).toBe("authenticated");
    expect(fb.forcedRefreshes).toBe(2);
    expect(server.aborted).toBeGreaterThanOrEqual(1);
  });

  it("a new episode after logout (same uid, same object restored) is not coalesced into the old one", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    const a = new FakeUser("uid-a");
    startSignIn(a);
    await flush(2_000);
    await act(async () => {
      await mockSignOut();
    });
    await flush(100);
    startSignIn(a);
    await run(60_000);
    expect(probe.syncState).toBe("authenticated");
    expect(server.okAnswers).toBe(1); // only the new episode's mint was applied; the old one was aborted
  });

  it("unmount during the episode: its POST is aborted and its deadline cleared", async () => {
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 10_000;
    startSignIn(new FakeUser("uid-a"));
    await flush(2_000);
    act(() => renderer?.unmount());
    renderer = null;
    await run(60_000);
    expect(server.aborted).toBeGreaterThanOrEqual(1);
    expect(server.okAnswers).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("R-S0-6 — confirmed sessions are unchanged", () => {
  it("a same-uid refresh of a confirmed session during an outage keeps the session (Stage 0 F3), no follow-up, no deadline", async () => {
    startSignIn(new FakeUser("uid-a"));
    await run(5_000);
    expect(probe.syncState).toBe("authenticated");
    server.mode = "outage";
    fb.current!.externalChange();
    await run(60_000);
    expect(probe.syncState).toBe("authenticated");
    expect(mockEvents).toContain("token_refresh_deferred");
    expect(mockEvents).not.toContain("sync_episode_follow_up");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("external token changes every 7 s on a confirmed session with the other tab reflexing: ≤ 1 mint per external event, stops when they stop", async () => {
    startSignIn(new FakeUser("uid-a"));
    await run(5_000);
    fb.refreshLatencyMs = 1_200;
    server.mintLatencyMs = 5_000;
    fb.otherTab = true;
    const a = fb.current!;
    const base = server.posts;
    let events = 0;
    await run(TEN_MIN, (s) => {
      if (s % 7 === 0) {
        events += 1;
        a.externalChange();
      }
    });
    expect(server.posts - base).toBeLessThanOrEqual(events);
    const before = server.posts;
    await run(120_000);
    expect(server.posts).toBe(before);
    expect(probe.syncState).toBe("authenticated");
  });
});
