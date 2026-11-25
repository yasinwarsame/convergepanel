/**
 * #332 identity-isolation gate (owner directive 2026-11-25): a late successful session mint for a PREVIOUS identity
 * must never leave the browser presenting identity B as authenticated while the server cookie authorizes identity A.
 *
 * Real AuthProvider, real sessionSync, real state machine, and the REAL server-side resolvers
 * (`resolveRequestIdentity` for Route Handlers, `resolveServerComponentIdentity` for Server Components). Faked: the
 * Firebase client SDK (the same 12.7.0 behavioural double as AuthProviderRecoveryEpisode.spec.tsx), the network
 * (`fetch`), and the Firebase Admin verification primitives (a synthetic cookie `sess:<uid>` verifies as `<uid>`; a
 * synthetic ID token `synthetic-<uid>-<iat>` verifies as `<uid>`).
 *
 * The cookie model follows the browser: a response's Set-Cookie is applied when the response ARRIVES, before the
 * page's JavaScript sees the response. Responses are delivered in an order the test chooses, so A's response can
 * arrive after B's. A DELETE can be made to fail (the case under test). Synthetic data only.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { NextRequest } from "next/server";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

// ── Firebase 12.7.0 behavioural double (see AuthProviderRecoveryEpisode.spec.tsx for the SDK citations) ─────────
type Listener = (u: unknown) => Promise<void> | void;
const fb = {
  listeners: [] as Listener[],
  current: null as FakeUser | null,
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
  async getIdToken(force?: boolean): Promise<string> {
    if (!force && Date.now() / 1000 - this.iatSec < 3600) return this.token;
    const before = this.token;
    this.mint();
    if (this.token !== before && fb.current === this) fb.notify();
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
jest.mock("@/lib/logger", () => ({ logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } }));

// ── the browser cookie jar + Firebase Admin verification primitives ──────────────────────────────────────────────
const jar = { value: null as string | null }; // the browser's __session cookie
const uidOfCookie = (v: string | null | undefined) => (v && v.startsWith("sess:") ? v.slice(5) : null);
const uidOfToken = (t: string) => /^synthetic-(.+)-\d+$/.exec(t)?.[1] ?? null;
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: async (req: NextRequest) => {
    const v = req.cookies.get("__session")?.value;
    if (!v) return null;
    const uid = uidOfCookie(v);
    if (!uid) throw Object.assign(new Error("bad cookie"), { code: "auth/argument-error" });
    return { uid };
  },
  verifySessionCookieValue: async (v: string | undefined) => {
    if (!v) return null;
    const uid = uidOfCookie(v);
    if (!uid) throw Object.assign(new Error("bad cookie"), { code: "auth/argument-error" });
    return { uid };
  },
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: async (t: string) => {
    const uid = uidOfToken(t);
    if (!uid) throw Object.assign(new Error("bad token"), { code: "auth/argument-error" });
    return { uid };
  },
}));
jest.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name === "__session" && jar.value ? { value: jar.value } : undefined) }),
}));

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";

// ── the session endpoint (exact server contract), with responses delivered in a test-chosen order ──────────────
type Pending = { uid: string; arrive: () => void };
const net = {
  pending: [] as Pending[],
  deleteFails: false,
  postsUnreachable: false,
  posts: [] as string[],
  deletes: 0,
  gets: 0,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function sessionFetch(_url: string, init?: { method?: string; body?: string }): Promise<Response> {
  const method = init?.method ?? "GET";
  if (method === "DELETE") {
    net.deletes += 1;
    if (net.deleteFails) throw new TypeError("Failed to fetch");
    jar.value = null;
    return json(200, { ok: true });
  }
  if (method === "GET") {
    net.gets += 1;
    if (net.deleteFails && net.postsUnreachable) throw new TypeError("Failed to fetch");
    const uid = uidOfCookie(jar.value);
    return uid ? json(200, { authenticated: true, uid }) : json(401, { authenticated: false });
  }
  const uid = uidOfToken(JSON.parse(init?.body ?? "{}").idToken ?? "") ?? "";
  net.posts.push(uid);
  if (net.postsUnreachable) throw new TypeError("Failed to fetch");
  return new Promise<Response>((resolve) => {
    net.pending.push({
      uid,
      arrive: () => {
        jar.value = `sess:${uid}`; // Set-Cookie is applied when the response arrives, before page JS sees it
        resolve(json(200, { authenticated: true, uid }));
      },
    });
  });
}
async function arrive(uid: string) {
  const i = net.pending.findIndex((p) => p.uid === uid);
  if (i < 0) throw new Error(`no pending mint for ${uid}`);
  const [p] = net.pending.splice(i, 1);
  p.arrive();
  await flush();
}
/** Deliver every outstanding mint, oldest first, until none is left (bounded). */
async function settleAll() {
  for (let i = 0; i < 20 && net.pending.length > 0; i++) await arrive(net.pending[0].uid);
  expect(net.pending).toHaveLength(0);
}

// ── harness ────────────────────────────────────────────────────────────────────────────────────────────────────
let probe = { syncState: "", canMutate: false, uid: null as string | null, beginLogout: () => undefined as void };
function Probe() {
  const a = useAuth();
  probe = { syncState: a.syncState, canMutate: a.canMutate, uid: a.user?.uid ?? null, beginLogout: a.beginLogout };
  return null;
}
const g = globalThis as any;
const SAVED = { window: g.window, fetch: g.fetch };
let renderers: TestRenderer.ReactTestRenderer[] = [];
async function flush(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
async function show(u: FakeUser | null) {
  fb.current = u;
  fb.notify();
  await flush();
}

/** What every protected server surface resolves the browser's NEXT request to. */
async function serverView(presentedBearerFor: FakeUser | null) {
  const cookieHeader = jar.value ? `__session=${jar.value}` : undefined;
  const req = (h: Record<string, string>) => new NextRequest("http://localhost/api/example", { headers: h });
  const bearer = presentedBearerFor ? `Bearer ${await presentedBearerFor.getIdToken(false)}` : undefined;
  const as = (r: Awaited<ReturnType<typeof resolveRequestIdentity>>) => (r.status === "authenticated" ? r.uid : `401:${r.reason}`);
  return {
    cookieOnly: as(await resolveRequestIdentity(req(cookieHeader ? { Cookie: cookieHeader } : {}))),
    bearerOnly: bearer ? as(await resolveRequestIdentity(req({ Authorization: bearer }))) : "n/a",
    cookieAndBearer: bearer ? as(await resolveRequestIdentity(req({ ...(cookieHeader ? { Cookie: cookieHeader } : {}), Authorization: bearer }))) : "n/a",
    serverComponent: (await resolveServerComponentIdentity())?.uid ?? "none",
  };
}

/**
 * The identity-isolation invariant, checked at a SETTLED point:
 * - whenever the tab presents an identity as `authenticated`, every cookie-only surface resolves to exactly that
 *   identity (never another account, never "no session" behind an authenticated UI);
 * - whenever the tab presents an identity at all, no cookie-only surface resolves to a DIFFERENT account.
 */
async function expectIsolated(shown: FakeUser | null) {
  const v = await serverView(shown);
  if (probe.syncState === "authenticated") {
    expect(probe.uid).toBe(shown?.uid);
    expect(v.cookieOnly).toBe(shown?.uid);
    expect(v.serverComponent).toBe(shown?.uid);
    expect(v.cookieAndBearer).toBe(shown?.uid);
  }
  if (probe.uid !== null) {
    expect([probe.uid, "401:missing_credentials"]).toContain(v.cookieOnly);
    expect([probe.uid, "none"]).toContain(v.serverComponent);
  }
  return v;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-25T12:00:00Z") });
  jest.clearAllMocks();
  Object.assign(fb, { listeners: [], current: null });
  Object.assign(net, { pending: [], deleteFails: false, postsUnreachable: false, posts: [], deletes: 0, gets: 0 });
  jar.value = null;
  g.window = { localStorage: new FakeStorage(), sessionStorage: new FakeStorage() };
  g.fetch = jest.fn(sessionFetch);
  renderers = [];
  act(() => {
    renderers.push(TestRenderer.create(createElement(AuthProvider, null, createElement(Probe))));
  });
});
afterEach(() => {
  act(() => renderers.forEach((r) => r.unmount()));
  jest.useRealTimers();
});
afterAll(() => {
  g.window = SAVED.window;
  g.fetch = SAVED.fetch;
});

describe("#332 identity isolation — a late mint for A after switching to B", () => {
  it.each([
    ["the stale-cookie DELETE fails", true],
    ["the stale-cookie DELETE succeeds", false],
  ])("A's response arrives AFTER B is authenticated and %s → B never stays authenticated over a non-B cookie", async (_l, deleteFails) => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    await show(a); // 1. A's mint is outstanding
    expect(net.pending.map((p) => p.uid)).toEqual(["uid-a"]);
    await show(b); // 2. switch to B before A's response
    await arrive("uid-b"); // 3. B obtains a verified session
    expect(probe.syncState).toBe("authenticated");
    expect(jar.value).toBe("sess:uid-b");

    net.deleteFails = deleteFails; // 5. the stale-cookie cleanup is unavailable (or not)
    await arrive("uid-a"); // 4. A's late response installs A's cookie after B's session
    // While B's server session is uncertain, B is NOT mutable (the re-established sync is still outstanding).
    // The repair does not DELETE first (a racing DELETE response could clear B's fresh cookie); A's cookie is
    // overwritten by B's re-established mint. Until then (one mint round-trip) the tab is non-mutable.
    expect(jar.value).toBe("sess:uid-a");
    expect(probe.syncState).toBe("syncing_session");
    expect(probe.canMutate).toBe(false);
    expect(net.pending.map((p) => p.uid)).toEqual(["uid-b"]); // the repair is a fresh mint for B, not a DELETE
    await settleAll(); // any re-verification the provider performs completes
    await flush(60_000);

    // 6. the resulting state, 7. every protected-request shape
    const v = await expectIsolated(b);
    expect(probe.uid).toBe("uid-b"); // the late response never restores A in the UI
    expect(v.cookieOnly).not.toBe("uid-a");
    expect(v.serverComponent).not.toBe("uid-a");
    expect(v.cookieAndBearer).not.toBe("uid-a");
    expect(v.bearerOnly).toBe("uid-b");
  });

  it("control: A's response arrives BEFORE B's → B's own Set-Cookie wins; B authenticated over B's cookie", async () => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    await show(a);
    await show(b);
    net.deleteFails = true;
    await arrive("uid-a");
    await arrive("uid-b");
    await settleAll();
    await flush(60_000);
    const v = await expectIsolated(b);
    expect(probe.syncState).toBe("authenticated");
    expect(v.cookieOnly).toBe("uid-b");
  });

  it("A's late response arrives while B's own mint is still outstanding (DELETE fails) → isolated once settled", async () => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    await show(a);
    await show(b);
    net.deleteFails = true;
    await arrive("uid-a"); // A lands first in JS, but B is still in flight
    await arrive("uid-b");
    await settleAll();
    await flush(60_000);
    await expectIsolated(b);
  });

  it("A→B→A→B with every A response late and every cleanup failing → isolated once settled; the UI shows the last identity", async () => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    await show(a);
    await show(b);
    await arrive("uid-b");
    await show(a);
    await show(b);
    await arrive("uid-b");
    net.deleteFails = true;
    await arrive("uid-a");
    await arrive("uid-a");
    await settleAll();
    await flush(60_000);
    await expectIsolated(b);
    expect(probe.uid).toBe("uid-b");
  });

  it("the repair itself cannot reach the server (mint AND delete unreachable) → B is not left authenticated; fail closed", async () => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    await show(a);
    await show(b);
    await arrive("uid-b");
    net.deleteFails = true;
    net.postsUnreachable = true;
    await arrive("uid-a");
    await flush(120_000);
    expect(probe.syncState).not.toBe("authenticated");
    expect(probe.canMutate).toBe(false);
    expect(mockSignOut).toHaveBeenCalled(); // the ordinary fail-closed sign-out of the new-identity path
    expect(probe.uid).toBeNull(); // the tab presents NO identity, so no account is shown over A's cookie
    await expectIsolated(fb.current);
    // RESIDUAL (documented, owner decision): with mint, DELETE and the session read ALL unreachable, A's cookie can
    // outlive the signed-out tab until the next successful DELETE (the next sign-out callback or page load).
    expect(jar.value).toBe("sess:uid-a");
  });

  it("F2: a late A mint after the tab SIGNED OUT (no identity shown) → its cookie is removed", async () => {
    const a = new FakeUser("uid-a");
    await show(a);
    await show(null);
    await arrive("uid-a");
    await flush();
    expect(probe.uid).toBeNull();
    expect(jar.value).toBeNull();
    expect(net.posts).toEqual(["uid-a"]); // no repair mint: nobody is shown
  });

  it("F2: a late A mint after beginLogout → its cookie is removed even before the sign-out callback", async () => {
    const a = new FakeUser("uid-a");
    await show(a);
    act(() => probe.beginLogout());
    await arrive("uid-a");
    await flush();
    expect(jar.value).toBeNull();
    expect(probe.canMutate).toBe(false);
  });

  it("same identity: a late mint for the SHOWN identity triggers no repair (no extra mint)", async () => {
    const a = new FakeUser("uid-a");
    await show(a);
    await show(null);
    await show(a);
    await settleAll();
    await flush(60_000);
    expect(net.posts).toEqual(["uid-a", "uid-a"]);
    await expectIsolated(a);
    expect(probe.syncState).toBe("authenticated");
  });

  it("bounded: one late A response triggers at most one extra B mint (no repair loop)", async () => {
    const a = new FakeUser("uid-a");
    const b = new FakeUser("uid-b");
    await show(a);
    await show(b);
    await arrive("uid-b");
    net.deleteFails = true;
    const before = net.posts.length;
    await arrive("uid-a");
    await settleAll();
    await flush(600_000);
    expect(net.posts.length - before).toBeLessThanOrEqual(1);
    expect(net.pending).toHaveLength(0);
  });

  it("dual-credential control: a stale A cookie WITH B's bearer is refused (credential_mismatch); a cookie-only request is not protected by that rule", async () => {
    jar.value = "sess:uid-a";
    const b = new FakeUser("uid-b");
    const v = await serverView(b);
    expect(v.cookieAndBearer).toBe("401:credential_mismatch");
    expect(v.bearerOnly).toBe("uid-b");
    expect(v.cookieOnly).toBe("uid-a"); // the server cannot know which account the tab shows
    expect(v.serverComponent).toBe("uid-a");
  });
});
