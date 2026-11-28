/**
 * ZCA P3 R2 MB / L-1 / MA — `cancelLogout()` and the absence of any client DELETE, against the REAL AuthProvider,
 * the REAL sessionSync, the REAL state machine and the REAL shared logout sequence (`lib/client/logout.ts`).
 *
 * Firebase 12.7.0 behavioural double (as in AuthProviderCallbackReentry.spec.tsx): a FORCED `getIdToken` that yields a
 * new token notifies `onIdTokenChanged` BEFORE it resolves (the own-refresh echo); tokens carry `iat` in whole seconds;
 * `currentUser` is exposed; `signOut` can be made to THROW (with or without clearing the user first). The session
 * endpoint double implements the handshake contract (200 {authenticated, uid} / 401 / 503 auth_unavailable / a wrong
 * uid / a hang that honours the abort signal) and records every method it receives. Synthetic data only.
 *
 * Contract (design R2):
 *  - MB: cancelLogout = `prevUidRef = null; handleTokenEvent(auth.currentUser)` through the registered SyncEpisode:
 *    EXACTLY ONE handshake per cancelLogout (its forced refresh's echo coalesced); 200 for the same uid →
 *    `authenticated` (the assertion that kills "route cancelLogout through the same-uid refresh path"); 503, 401,
 *    mismatch, abort and the deadline → never `authenticated`; `canMutate` false until that fresh 200.
 *  - L-1: Firebase reports nobody after the throw → `client_signed_out`, React user null, isAdmin false; an
 *    `authedFetch` with the context user then refuses (no stale user object).
 *  - MA: no client DELETE ever; a hung DELETE from an older build cannot delay a later handshake.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

type Listener = (u: unknown) => Promise<void> | void;
const fb = {
  listeners: [] as Listener[],
  current: null as FakeUser | null,
  refreshLatencyMs: 0,
  forcedRefreshes: 0,
  notify() {
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
  async getIdToken(force?: boolean): Promise<string> {
    const expired = Date.now() / 1000 - this.iatSec >= 3600;
    if (!force && !expired) return this.token;
    fb.forcedRefreshes += force ? 1 : 0;
    if (fb.refreshLatencyMs > 0) await delay(fb.refreshLatencyMs);
    const before = this.token;
    this.mint();
    if (this.token !== before && fb.current === this) fb.notify(); // echo BEFORE getIdToken resolves
    return this.token;
  }
}
/** Default sign-out: clears the user and notifies (Firebase's real behaviour). Tests replace it to THROW. */
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
  getIdTokenResult: async (u: { uid: string }) => ({ claims: u.uid === "uid-admin" ? { admin: true } : {} }),
  signOut: (...args: unknown[]) => (mockSignOut as any)(...args),
}));
const mockAuth = {
  get currentUser() {
    return fb.current;
  },
};
jest.mock("@/lib/firebase/client", () => ({ auth: mockAuth }));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
const mockEvents: string[] = [];
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: (op: string) => mockEvents.push(op) }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

import { AuthProvider, useAuth, SESSION_SYNC_DEADLINE_MS } from "@/components/AuthProvider";
import { performLogout } from "@/lib/client/logout";
import { authedFetch, NotSignedInError } from "@/lib/client/authedFetch";
import type { Auth } from "firebase/auth";

// ── session endpoint double ──
type Mode = "ok" | "outage" | "revoked" | "mismatch" | "hang";
const server = {
  mode: "ok" as Mode,
  latencyMs: 0,
  posts: 0,
  postsByUid: {} as Record<string, number>,
  methods: [] as string[],
  aborted: 0,
  hangDeletes: true,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const uidOf = (t: string) => /^synthetic-(.+)-\d+$/.exec(t)?.[1] ?? "";
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
async function sessionFetch(_url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  server.methods.push(init?.method ?? "GET");
  if (init?.method === "DELETE") {
    // An older build's DELETE: it may hang forever (R2 MA).
    if (server.hangDeletes) return new Promise<Response>(() => undefined);
    return json(200, { authenticated: false });
  }
  server.posts += 1;
  const uid = uidOf(JSON.parse(init?.body ?? "{}").idToken ?? "");
  server.postsByUid[uid] = (server.postsByUid[uid] ?? 0) + 1;
  const signal = init?.signal;
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        server.aborted += 1;
        reject(abortError());
      });
    });
  if (server.mode === "hang") await wait(3_600_000);
  else if (server.latencyMs > 0) await wait(server.latencyMs);
  if (server.mode === "outage") return json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
  if (server.mode === "revoked") return json(401, { error: "Invalid or expired token" });
  if (server.mode === "mismatch") return json(200, { authenticated: true, uid: "someone-else" });
  return json(200, { authenticated: true, uid });
}

// ── harness ──
let probe: ReturnType<typeof useAuth>;
const states: string[] = [];
const mutableSeen: Array<string | null> = [];
function Probe() {
  probe = useAuth();
  if (states[states.length - 1] !== probe.syncState) states.push(probe.syncState);
  if (probe.canMutate) mutableSeen.push(probe.user?.uid ?? null);
  return null;
}
const g = globalThis as any;
const SAVED = { window: g.window, fetch: g.fetch };
let renderer: TestRenderer.ReactTestRenderer | null = null;
async function flush(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
async function signIn(u: FakeUser) {
  fb.current = u;
  fb.notify();
  await flush(10_000);
  expect(probe.syncState).toBe("authenticated");
  expect(probe.user).toBe(u);
}
const throwingSignOut = (clearUserFirst = false) => async () => {
  if (clearUserFirst) fb.current = null; // partial failure: the user is gone, but no notification is delivered
  throw new Error("storage unavailable");
};
/** The shared logout sequence with a THROWING local sign-out (TopNav / Profile path). */
async function logoutThatThrows(clearUserFirst = false) {
  let result!: Awaited<ReturnType<typeof performLogout>>;
  await act(async () => {
    result = await performLogout({
      auth: mockAuth as unknown as Auth,
      beginLogout: probe.beginLogout,
      cancelLogout: probe.cancelLogout,
      signOut: throwingSignOut(clearUserFirst),
    });
  });
  return result;
}

afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
});
beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-28T12:00:00.300Z") });
  jest.clearAllMocks();
  mockEvents.length = 0;
  states.length = 0;
  mutableSeen.length = 0;
  Object.assign(fb, { listeners: [], current: null, refreshLatencyMs: 0, forcedRefreshes: 0 });
  Object.assign(server, { mode: "ok", latencyMs: 0, posts: 0, postsByUid: {}, methods: [], aborted: 0, hangDeletes: true });
  g.window = { localStorage: new FakeStorage(), sessionStorage: new FakeStorage() };
  g.fetch = jest.fn(sessionFetch);
  act(() => {
    renderer = TestRenderer.create(createElement(AuthProvider, null, createElement(Probe)));
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  jest.useRealTimers();
  expect(server.methods.filter((m) => m !== "POST")).toEqual([]); // R2 MA: the client sends POSTs only
});

describe("R2 MB — cancelLogout re-verifies the still-present user through the registered episode", () => {
  it("a throwing sign-out: NOT reported as logged out; canMutate false until a fresh 200; EXACTLY ONE handshake (echo coalesced); 200 same uid → authenticated", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    fb.refreshLatencyMs = 1_500; // the forced refresh crosses a second → a new token → an echo during the pending refresh
    server.latencyMs = 2_000;
    const base = server.posts;
    mutableSeen.length = 0;
    const result = await logoutThatThrows();
    expect(result).toEqual({ signedOut: false });
    expect(mockEvents).toContain("logout_cancelled");
    expect(probe.syncState).toBe("syncing_session"); // a NEW identity episode, never a same-uid refresh
    expect(probe.canMutate).toBe(false);
    expect(probe.user).toBe(a);
    await flush(1_000);
    expect(probe.canMutate).toBe(false); // the handshake has not answered yet
    await flush(10_000);
    expect(probe.syncState).toBe("authenticated"); // KILLS the same-uid-path mutant (it ends in session_error)
    expect(probe.canMutate).toBe(true);
    expect(server.posts - base).toBe(1); // exactly one handshake — KILLS an own (unregistered) handshake
    expect(fb.forcedRefreshes).toBeGreaterThanOrEqual(2); // sign-in + the re-entry's forced token
    expect(mockEvents).toContain("own_refresh_echo_coalesced");
    expect(mockSignOut).not.toHaveBeenCalled(); // the provider never signs out on a successful re-verification
    await flush(120_000);
    expect(server.posts - base).toBe(1); // and nothing follows it
  });

  it("the re-verification is not swallowed by an episode already in flight (it supersedes it): one new handshake, authenticated", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.latencyMs = 5_000;
    fb.current = a;
    // A routine same-uid refresh episode is in flight when the user logs out and the sign-out throws.
    jest.setSystemTime(Date.now() + 2_000);
    (a as unknown as { token: string }).token = `synthetic-uid-a-${Math.floor(Date.now() / 1000)}`;
    fb.notify();
    await flush(1_000);
    const base = server.posts;
    await logoutThatThrows();
    await flush(20_000);
    expect(probe.syncState).toBe("authenticated");
    expect(server.posts - base).toBe(1);
    expect(server.aborted).toBeGreaterThanOrEqual(1); // the pre-logout episode's POST was aborted
  });

  it.each([
    ["503 auth_unavailable", "outage"],
    ["401 (credential verdict)", "revoked"],
    ["a uid mismatch", "mismatch"],
  ] as const)("the re-verification answers %s → NEVER authenticated (fail closed)", async (_n, mode) => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.mode = mode;
    mutableSeen.length = 0;
    await logoutThatThrows();
    await flush(60_000);
    expect(probe.syncState).not.toBe("authenticated");
    expect(probe.canMutate).toBe(false);
    expect(mutableSeen).toEqual([]);
    // 503 is NOT kept for this episode: cancelLogout starts a NEW identity episode (keepSessionOnAuthUnavailable false).
    expect(mockEvents).not.toContain("token_refresh_deferred");
  });

  it("the re-verification is superseded by another identity (abort) → never authenticated as the first", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.latencyMs = 5_000;
    mutableSeen.length = 0;
    await logoutThatThrows();
    await flush(1_000);
    const b = new FakeUser("uid-b");
    fb.current = b;
    fb.notify();
    await flush(20_000);
    expect(server.aborted).toBeGreaterThanOrEqual(1);
    expect(probe.user).toBe(b);
    expect(mutableSeen.every((u) => u === "uid-b")).toBe(true);
  });

  it("the re-verification hangs → the episode DEADLINE fails it closed (aborted POST), never authenticated", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.mode = "hang";
    mutableSeen.length = 0;
    await logoutThatThrows();
    await flush(SESSION_SYNC_DEADLINE_MS - 100);
    expect(probe.syncState).toBe("syncing_session");
    await flush(200);
    expect(mockEvents).toContain("sync_episode_deadline_exceeded"); // KILLS an own handshake without the episode deadline
    expect(server.aborted).toBe(1);
    expect(probe.syncState).not.toBe("authenticated");
    expect(mutableSeen).toEqual([]);
  });

  it("cancelLogout without a preceding throw is still bounded: one handshake, and nothing recurs", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    const base = server.posts;
    act(() => probe.cancelLogout());
    await flush(60_000);
    expect(server.posts - base).toBe(1);
    expect(probe.syncState).toBe("authenticated");
  });
});

describe("R2 L-1 — the local sign-out threw but Firebase reports nobody", () => {
  it("→ client_signed_out: user null, isAdmin false, reported as logged out, no handshake; authedFetch refuses the stale user", async () => {
    const admin = new FakeUser("uid-admin");
    await signIn(admin);
    expect(probe.isAdmin).toBe(true);
    const base = server.posts;
    const result = await logoutThatThrows(true);
    await flush(0);
    expect(result).toEqual({ signedOut: true });
    expect(probe.syncState).toBe("signed_out");
    expect(probe.user).toBeNull();
    expect(probe.isAdmin).toBe(false);
    expect(probe.canMutate).toBe(false);
    expect(server.posts).toBe(base);
    await expect(authedFetch("/api/user/usage", { user: probe.user, authReady: probe.authReady })).rejects.toBeInstanceOf(NotSignedInError);
    expect(server.methods.filter((m) => m !== "POST")).toEqual([]);
  });

  it("control: a throwing sign-out with the user STILL present is not reported as logged out and keeps the user", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    const result = await logoutThatThrows(false);
    expect(result).toEqual({ signedOut: false });
    expect(probe.user).toBe(a);
  });
});

describe("R2 MA — no client DELETE; a hung DELETE cannot delay a handshake", () => {
  it("an older build's DELETE hangs forever; a sign-out and a new sign-in still send B's handshake at once", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    // An old tab's DELETE to the session endpoint is in flight and will never answer.
    void g.fetch("/api/auth/session", { method: "DELETE" });
    server.methods.length = 0;
    await act(async () => {
      await mockSignOut();
    });
    await flush(0);
    expect(probe.syncState).toBe("signed_out");
    const b = new FakeUser("uid-b");
    fb.current = b;
    fb.notify();
    await flush(10);
    expect(server.postsByUid["uid-b"]).toBe(1); // sent immediately, not after any DELETE
    await flush(1_000);
    expect(probe.syncState).toBe("authenticated");
    expect(probe.user).toBe(b);
  });

  it("a regular sign-out (null callback) sends nothing at all", async () => {
    const a = new FakeUser("uid-a");
    await signIn(a);
    server.methods.length = 0;
    await act(async () => {
      await mockSignOut();
    });
    await flush(30_000);
    expect(server.methods).toEqual([]);
    expect(probe.syncState).toBe("signed_out");
  });
});
