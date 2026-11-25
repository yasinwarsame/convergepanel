/**
 * #332 R7 (owner decision 2026-11-25): a temporary Firebase Auth outage must not sign the user out or clear their
 * unsaved input. A confirmed revoked or invalid credential still gets the ordinary fail-closed sign-out.
 *
 * Renders the REAL AuthProvider over the REAL lib/client/sessionSync (so the client/server error CONTRACT, status plus
 * body code, is exercised end to end). Only `fetch` (the session endpoint) and the Firebase client SDK are faked.
 * Synthetic data only.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

let tokenCallback: ((user: any) => Promise<void>) | undefined;
const mockSignOut = jest.fn(async () => undefined);
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_auth: unknown, cb: any) => {
    tokenCallback = cb;
    return () => undefined;
  },
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: (...args: any[]) => (mockSignOut as any)(...args),
}));
jest.mock("@/lib/firebase/client", () => ({ auth: {} }));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
const mockReset = jest.fn();
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => mockReset() } }));

import { AuthProvider, useAuth, SESSION_UNAVAILABLE_RETRY_DELAYS_MS } from "@/components/AuthProvider";

// ── the session endpoint double ───────────────────────────────────────────────
type Answer = "ok" | "unavailable" | "revoked" | "server_500" | "proxy_503" | "unavailable_500_body" | "deferred_ok";
let releaseDeferred: (() => void) | null = null;
let postAnswers: Answer[] = [];
const calls: string[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function answerPost(uid: string): Response | Promise<Response> {
  const a = postAnswers.length ? postAnswers.shift()! : "ok";
  switch (a) {
    case "deferred_ok": // a successful mint whose response arrives only when the test releases it
      return new Promise<Response>((resolve) => {
        releaseDeferred = () => resolve(json(200, { authenticated: true, uid }));
      });
    case "ok":
      return json(200, { authenticated: true, uid });
    case "unavailable": // the exact mint contract (app/api/auth/session/route.ts authUnavailableResponse)
      return json(503, { error: "Authentication service unavailable", code: "auth_unavailable" });
    case "revoked": // the mint's credential verdict (revoked / disabled / invalid are indistinguishable by design)
      return json(401, { error: "Invalid or expired token" });
    case "server_500":
      return json(500, { error: "Failed to create session" });
    case "proxy_503": // a 503 WITHOUT the contract body must still fail closed
      return new Response("<html>Service Unavailable</html>", { status: 503 });
    case "unavailable_500_body": // the code alone, without the 503 status, must not count
      return json(500, { error: "Authentication service unavailable", code: "auth_unavailable" });
  }
}
const g = globalThis as any;
const SAVED = { window: g.window, fetch: g.fetch };

// ── state probe ───────────────────────────────────────────────────────────────
let probe: { syncState: string; canMutate: boolean; user: unknown } = { syncState: "", canMutate: true, user: null };
function Probe() {
  const a = useAuth();
  probe = { syncState: a.syncState, canMutate: a.canMutate, user: a.user };
  return null;
}

let local: FakeStorage;
let session: FakeStorage;
let renderer: TestRenderer.ReactTestRenderer;
const PENDING_KEY = "convergePanelVerifyPendingV2";
const HISTORY_KEY = "convergePanelHistoryV1:uid-a";
const userA = { uid: "uid-a", getIdToken: async () => "synthetic-id-token-a" };

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  calls.length = 0;
  postAnswers = [];
  releaseDeferred = null;
  tokenCallback = undefined;
  local = new FakeStorage();
  session = new FakeStorage();
  g.window = { localStorage: local, sessionStorage: session };
  g.fetch = jest.fn(async (_url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push(method);
    if (method === "POST") return answerPost("uid-a");
    return json(200, { ok: true });
  });
  act(() => {
    renderer = TestRenderer.create(createElement(AuthProvider, null, createElement(Probe)));
  });
  expect(typeof tokenCallback).toBe("function");
});
afterEach(() => {
  act(() => renderer.unmount());
  jest.useRealTimers();
});
afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
});

async function emit(user: unknown) {
  await act(async () => {
    await tokenCallback!(user);
  });
}
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
const posts = () => calls.filter((c) => c === "POST").length;
function seedPrivateData() {
  local.setItem(HISTORY_KEY, JSON.stringify([{ claim: "SYNTHETIC_CLAIM_A" }]));
  session.setItem(PENDING_KEY, JSON.stringify({ v: 2, text: "SYNTHETIC_UNSAVED_VERIFY_INPUT", boundUid: "uid-a", expiresAt: Date.now() + 60_000 }));
}
const privateDataIntact = () =>
  local.getItem(HISTORY_KEY)?.includes("SYNTHETIC_CLAIM_A") === true && session.getItem(PENDING_KEY)?.includes("SYNTHETIC_UNSAVED_VERIFY_INPUT") === true;

describe("#332 R7 — temporary Auth outage: no destructive sign-out, protected operations fail closed", () => {
  it("token refresh during an outage: not signed out, unsaved /verify input and history kept, never mutable, server cookie cleared", async () => {
    await emit(userA);
    expect(probe.syncState).toBe("authenticated");
    seedPrivateData();

    postAnswers = ["unavailable"];
    await emit(userA); // the hourly same-uid refresh lands during the outage

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(probe.syncState).toBe("session_unavailable");
    expect(probe.canMutate).toBe(false); // protected operations are denied until verification succeeds
    expect(probe.user).not.toBeNull(); // still signed in on the client
    expect(privateDataIntact()).toBe(true);
    expect(mockReset).not.toHaveBeenCalled();
    expect(calls.slice(-1)).toEqual(["DELETE"]); // fail closed: no stale cookie keeps authorizing
  });

  it("first sign-in during an outage: same, and the bounded retry recovers once the service returns", async () => {
    seedPrivateData();
    postAnswers = ["unavailable", "unavailable"];
    await emit(userA);
    expect(probe.syncState).toBe("session_unavailable");
    expect(posts()).toBe(1);

    await advance(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]);
    expect(posts()).toBe(2);
    expect(probe.syncState).toBe("session_unavailable");

    await advance(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[1]); // the service is back: answers ok
    expect(posts()).toBe(3);
    expect(probe.syncState).toBe("authenticated");
    expect(probe.canMutate).toBe(true);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(privateDataIntact()).toBe(true);
  });

  it("retries are bounded: 1 + 3 mint calls, then it waits (still signed in, never mutable) — no unbounded loop", async () => {
    postAnswers = Array(10).fill("unavailable");
    await emit(userA);
    for (const d of SESSION_UNAVAILABLE_RETRY_DELAYS_MS) await advance(d);
    await advance(10 * 60_000);
    expect(posts()).toBe(1 + SESSION_UNAVAILABLE_RETRY_DELAYS_MS.length);
    expect(probe.syncState).toBe("session_unavailable");
    expect(mockSignOut).not.toHaveBeenCalled();

    // R8 (owner ruling): a routine same-uid callback after exhaustion does NOT restart the episode.
    postAnswers = [];
    await emit(userA);
    expect(posts()).toBe(1 + SESSION_UNAVAILABLE_RETRY_DELAYS_MS.length);
    expect(probe.syncState).toBe("session_unavailable");
    // An explicit sign-out and a new sign-in is a genuine new episode, and it recovers.
    await emit(null);
    await emit(userA);
    expect(probe.syncState).toBe("authenticated");
  });

  it("a newer identity callback cancels the pending retry (no stale mint call after it, no timer left behind)", async () => {
    postAnswers = ["unavailable"];
    await emit(userA);
    expect(posts()).toBe(1);
    expect(jest.getTimerCount()).toBe(1); // exactly the one scheduled retry
    await emit(null); // explicit sign-out while unavailable
    expect(jest.getTimerCount()).toBe(0); // cancelled, not merely ignored when it fires
    await advance(10 * 60_000);
    expect(posts()).toBe(1);
  });

  it("unmount cancels the pending retry", async () => {
    postAnswers = ["unavailable"];
    await emit(userA);
    expect(jest.getTimerCount()).toBe(1);
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
    act(() => {
      renderer = TestRenderer.create(createElement(AuthProvider, null, createElement(Probe))); // for afterEach
    });
  });

  it("a retry whose answer arrives AFTER a newer callback (sign-out) is discarded: it never authenticates", async () => {
    postAnswers = ["unavailable", "deferred_ok"];
    await emit(userA);
    await advance(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]); // the retry is now in flight
    expect(posts()).toBe(2);
    expect(probe.syncState).toBe("syncing_session");
    await emit(null); // the user signs out while that retry is pending
    expect(probe.syncState).toBe("signed_out");
    await act(async () => {
      releaseDeferred!(); // the late success arrives
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(probe.syncState).toBe("signed_out");
    expect(probe.canMutate).toBe(false);
  });
});

describe("#332 R7 — confirmed revoked / invalid credentials keep the fail-closed sign-out", () => {
  it("revoked credential (401, then the single 401 retry also 401) → signed out", async () => {
    await emit(userA);
    seedPrivateData();
    postAnswers = ["revoked", "revoked"];
    await emit(userA);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("session_error");
    expect(probe.canMutate).toBe(false);
    await emit(null); // Firebase reports the sign-out → the ordinary cleanup runs
    expect(privateDataIntact()).toBe(false);
  });

  it("a revoked credential discovered on a RETRY after an outage is still signed out", async () => {
    postAnswers = ["unavailable", "revoked", "revoked"];
    await emit(userA);
    expect(probe.syncState).toBe("session_unavailable");
    await advance(SESSION_UNAVAILABLE_RETRY_DELAYS_MS[0]);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("session_error");
  });

  it.each(["server_500", "proxy_503", "unavailable_500_body"] as const)(
    "the contract needs BOTH status 503 AND code auth_unavailable — %s still fails closed with a sign-out",
    async (answer) => {
      await emit(userA);
      postAnswers = [answer];
      await emit(userA);
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(probe.syncState).toBe("session_error");
    }
  );
});

describe("#332 R7 — explicit sign-out still clears private data", () => {
  it("while the service is unavailable, an explicit sign-out clears history, the /verify input and resets analytics", async () => {
    await emit(userA);
    seedPrivateData();
    postAnswers = ["unavailable"];
    await emit(userA);
    expect(privateDataIntact()).toBe(true);
    await emit(null); // the user signs out (TopNav/profile → Firebase signOut → null callback)
    expect(privateDataIntact()).toBe(false);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(probe.syncState).toBe("signed_out");
  });
});
