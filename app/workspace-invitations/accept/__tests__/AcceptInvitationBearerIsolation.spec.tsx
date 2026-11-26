/**
 * Identity-isolation C1 (owner D-3, 2026-11-25) — the invitation-acceptance
 * browser request carries the shown Firebase user's ID token, and a stale shared
 * `__session` cookie for a different account can never accept an invitation
 * as that account.
 *
 * End to end below the Firebase verifiers: the real `AcceptInvitationClient`,
 * the real `authedFetch`, the real accept Route Handler and the real
 * `resolveRequestIdentity`. Mocked: `useAuth` (the shown user), the two Firebase
 * Admin verifiers (cookie `sess:<uid>` / token `id:<uid>`), and the Firestore
 * acceptance core (records the uid it was called with). `fetch` is an adapter
 * that turns the client's request into a `NextRequest` carrying the cookie jar
 * only when the client asked for same-origin credentials, and calls the route.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";

const SENTINEL = "C1_INVITATION_TOKEN_SENTINEL_4711";
const INVITATION_ID = "inv-c1";

const mockedRouterReplace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: (...a: unknown[]) => mockedRouterReplace(...a), push: jest.fn() }) }));

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

const mockedSignOut = jest.fn();
jest.mock("firebase/auth", () => ({ sendEmailVerification: jest.fn(), signOut: (...a: unknown[]) => mockedSignOut(...a) }));
jest.mock("@/lib/firebase/client", () => ({ auth: { __fakeAuth: true } }));
jest.mock("@/lib/telemetry/telemetryFreeDocument", () => ({ isTelemetryFreeDocument: () => true }));

const mockedClearServerSession = jest.fn();
jest.mock("@/lib/client/sessionSync", () => ({ clearServerSession: (...a: unknown[]) => mockedClearServerSession(...a) }));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockedIdentityFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: (...a: unknown[]) => mockedIdentityFailure(...a) }));

function firebaseError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

// Cookie verifier double: `sess:<uid>` verifies as <uid>; `revoked:<uid>` is a revoked session; anything else is invalid.
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: async (req: { cookies: { get: (n: string) => { value: string } | undefined } }) => {
    const v = req.cookies.get("__session")?.value;
    if (!v) return null;
    if (v.startsWith("sess:")) return { uid: v.slice(5), isAdmin: false };
    if (v.startsWith("revoked:")) throw firebaseError("auth/session-cookie-revoked");
    throw firebaseError("auth/argument-error");
  },
}));
// Bearer verifier double: `id:<uid>` verifies as <uid>; `revoked:<uid>` is a revoked token; anything else is invalid.
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: async (token: string) => {
    if (token.startsWith("id:")) return { uid: token.slice(3) };
    if (token.startsWith("revoked:")) throw firebaseError("auth/id-token-revoked");
    throw firebaseError("auth/argument-error");
  },
}));

const mockedAccept = jest.fn();
jest.mock("@/lib/firestore/workspaceInvitations", () => ({ acceptWorkspaceInvitation: (...a: unknown[]) => mockedAccept(...a) }));

import AcceptInvitationClient from "@/app/workspace-invitations/accept/AcceptInvitationClient";
import { POST } from "@/app/api/workspace-invitations/[invitationId]/accept/route";

const jar: { value: string | null } = { value: null };
const routeCalls: { url: string; authorization: string | null; cookie: string | null; status: number }[] = [];
// Recorded when a request is SENT (before the route runs), so in-flight requests are visible too.
const sent: (string | null)[] = [];
// When set, the route's response is held until the test releases it (models a slow server).
let holdResponse: Promise<void> | null = null;

function installRouteFetch() {
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (init?.credentials === "same-origin" && jar.value) headers.set("cookie", `__session=${jar.value}`);
    sent.push(headers.get("authorization"));
    const req = new NextRequest(`http://localhost${url}`, { method: init?.method, headers, body: init?.body as string });
    const m = /^\/api\/workspace-invitations\/([^/]+)\/accept$/.exec(url);
    if (!m) throw new Error(`unexpected request ${url}`);
    const res = await POST(req, { params: { invitationId: decodeURIComponent(m[1]) } });
    if (holdResponse) await holdResponse;
    routeCalls.push({ url, authorization: headers.get("authorization"), cookie: headers.get("cookie"), status: res.status });
    return res;
  }) as unknown as typeof fetch;
}

function fakeStorage() {
  const backing = new Map<string, string>();
  return {
    backing,
    getItem: jest.fn((k: string) => (backing.has(k) ? backing.get(k)! : null)),
    setItem: jest.fn((k: string, v: string) => backing.set(k, v)),
    removeItem: jest.fn((k: string) => backing.delete(k)),
  };
}

function setWindow() {
  const storage = fakeStorage();
  (global as any).window = {
    location: { hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` },
    history: { state: { nextRouterState: true }, replaceState: jest.fn(), pushState: jest.fn() },
    sessionStorage: storage,
  };
  return storage;
}

function shownUser(uid: string, token: string | (() => Promise<string>) = `id:${uid}`) {
  const getIdToken = typeof token === "function" ? jest.fn(token) : jest.fn().mockResolvedValue(token);
  return { uid, reload: jest.fn().mockResolvedValue(undefined), getIdToken };
}

function authenticatedAs(user: unknown, extra: Record<string, unknown> = {}) {
  return { user, authReady: true, syncState: "authenticated", canMutate: true, beginLogout: jest.fn(), ...extra };
}

async function mount(auth: Record<string, unknown>) {
  mockedUseAuth.mockReturnValue(auth);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(AcceptInvitationClient));
  });
  // Let the token fetch, the route and the response body settle.
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  return r;
}

const heading = (r: TestRenderer.ReactTestRenderer) => r.root.findByType("h1").props.children;
const findButton = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((b) => (Array.isArray(b.props.children) ? b.props.children.join("") : b.props.children) === label);
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
async function rerender(r: TestRenderer.ReactTestRenderer, auth: Record<string, unknown>) {
  mockedUseAuth.mockReturnValue(auth);
  await act(async () => { r.update(createElement(AcceptInvitationClient)); });
}

function acceptedAs(uid: string) {
  return { status: "accepted", invitationId: INVITATION_ID, workspaceId: `ws-of-${uid}`, role: "member", membershipId: "m-1", alreadyMember: false, effectiveRole: "member" };
}

beforeEach(() => {
  jest.clearAllMocks();
  jar.value = null;
  routeCalls.length = 0;
  sent.length = 0;
  holdResponse = null;
  installRouteFetch();
  setWindow();
  mockedAccept.mockImplementation(async ({ uid }: { uid: string }) => acceptedAs(uid));
});

describe("C1 — the request carries the shown user's bearer credential", () => {
  it("sends Authorization: Bearer <shown user's ID token> with the cookie, the exact body, and no secret in the URL", async () => {
    jar.value = "sess:uid-b";
    const user = shownUser("uid-b");
    const r = await mount(authenticatedAs(user));
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0].authorization).toBe("Bearer id:uid-b");
    expect(routeCalls[0].cookie).toBe("__session=sess:uid-b");
    expect(routeCalls[0].url).toBe(`/api/workspace-invitations/${INVITATION_ID}/accept`);
    expect(routeCalls[0].url).not.toContain(SENTINEL);
    expect(routeCalls[0].url).not.toContain("id:uid-b");
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ token: SENTINEL });
    expect(init.cache).toBe("no-store");
    expect(mockedAccept).toHaveBeenCalledTimes(1);
    expect(mockedAccept).toHaveBeenCalledWith({ uid: "uid-b", invitationId: INVITATION_ID, rawToken: SENTINEL });
    expect(heading(r)).toBe("You've joined the workspace");
  });

  it("the bearer token never reaches storage or the rendered page", async () => {
    jar.value = "sess:uid-b";
    const storage = setWindow();
    const r = await mount(authenticatedAs(shownUser("uid-b")));
    expect(JSON.stringify(r.toJSON())).not.toContain("id:uid-b");
    for (const v of storage.backing.values()) expect(v).not.toContain("id:uid-b");
  });
});

describe("C1 — stale shared cookie for a different account", () => {
  it("shown B, cookie A (a late session mint): the route refuses (401 credential_mismatch); the invitation is NOT accepted as A or B", async () => {
    jar.value = "sess:uid-a";
    const r = await mount(authenticatedAs(shownUser("uid-b")));
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0].status).toBe(401);
    expect(mockedAccept).not.toHaveBeenCalled();
    expect(mockedIdentityFailure).toHaveBeenCalledWith(expect.objectContaining({ failureCategory: "credential_mismatch" }));
    expect(heading(r)).toBe("Session expired");
    expect(mockedRouterReplace).not.toHaveBeenCalled(); // no automatic loop
  });

  it("'Sign in again' clears the server session and signs out before returning to login; no second POST is issued", async () => {
    jar.value = "sess:uid-a";
    const beginLogout = jest.fn();
    const r = await mount(authenticatedAs(shownUser("uid-b"), { beginLogout }));
    mockedClearServerSession.mockResolvedValueOnce(true);
    mockedSignOut.mockResolvedValueOnce(undefined);
    const button = r.root.findAllByType("button").find((b) => b.props.children === "Sign in again")!;
    await act(async () => { await button.props.onClick(); });
    const order = [beginLogout.mock.invocationCallOrder[0], mockedClearServerSession.mock.invocationCallOrder[0], mockedSignOut.mock.invocationCallOrder[0]];
    expect(order.every((n) => typeof n === "number")).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(String(mockedRouterReplace.mock.calls[0][0])).not.toContain(SENTINEL);
    expect(routeCalls).toHaveLength(1);
    expect(mockedAccept).not.toHaveBeenCalled();
  });

  it("control: shown B with B's own cookie is accepted as B", async () => {
    jar.value = "sess:uid-b";
    await mount(authenticatedAs(shownUser("uid-b")));
    expect(mockedAccept).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-b" }));
  });

  it("no cookie at all (cleared): accepted on the bearer alone, as the shown user", async () => {
    jar.value = null;
    await mount(authenticatedAs(shownUser("uid-b")));
    expect(routeCalls[0].cookie).toBeNull();
    expect(mockedAccept).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-b" }));
  });
});

describe("C1 — missing, revoked and invalid credentials", () => {
  it("revoked session cookie + valid bearer: 401, not accepted", async () => {
    jar.value = "revoked:uid-b";
    const r = await mount(authenticatedAs(shownUser("uid-b")));
    expect(routeCalls[0].status).toBe(401);
    expect(mockedAccept).not.toHaveBeenCalled();
    expect(heading(r)).toBe("Session expired");
  });

  it("revoked bearer + valid cookie: 401, not accepted (verifier-reported revocation)", async () => {
    jar.value = "sess:uid-b";
    const r = await mount(authenticatedAs(shownUser("uid-b", "revoked:uid-b")));
    expect(routeCalls[0].status).toBe(401);
    expect(mockedAccept).not.toHaveBeenCalled();
    expect(heading(r)).toBe("Session expired");
  });

  it("invalid bearer + valid cookie: 401, no cookie fallback", async () => {
    jar.value = "sess:uid-b";
    await mount(authenticatedAs(shownUser("uid-b", "garbage")));
    expect(routeCalls[0].status).toBe(401);
    expect(mockedAccept).not.toHaveBeenCalled();
  });

  it("the ID token cannot be obtained: no request is sent at all (never a cookie-only fallback); Retry recovers", async () => {
    jar.value = "sess:uid-b";
    let fail = true;
    const user = shownUser("uid-b", async () => {
      if (fail) throw new Error("network");
      return "id:uid-b";
    });
    const r = await mount(authenticatedAs(user));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(heading(r)).toBe("Temporarily unavailable");
    fail = false;
    const retry = r.root.findAllByType("button").find((b) => b.props.children === "Retry")!;
    await act(async () => { retry.props.onClick(); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0].authorization).toBe("Bearer id:uid-b");
    expect(mockedAccept).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-b" }));
  });

  it("authenticated state with no Firebase user (defensive): no request; credential kept for re-authentication", async () => {
    jar.value = "sess:uid-a";
    const storage = setWindow();
    const r = await mount(authenticatedAs(null));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(heading(r)).toBe("Session expired");
    expect([...storage.backing.values()].join("")).toContain(INVITATION_ID);
  });

  it("single flight: two Retry activations while the token is still being fetched issue one token fetch and one POST", async () => {
    jar.value = "sess:uid-b";
    let mode: "fail" | "pending" = "fail";
    let release!: (v: string) => void;
    const user = shownUser("uid-b", () => (mode === "fail" ? Promise.reject(new Error("network")) : new Promise<string>((res) => { release = res; })));
    const r = await mount(authenticatedAs(user));
    expect(heading(r)).toBe("Temporarily unavailable");
    const before = user.getIdToken.mock.calls.length;
    mode = "pending";
    const retry = findButton(r, "Retry")!;
    // Both activations reach the component's handler before any await resolves (same props, same tick).
    await act(async () => {
      retry.props.onClick();
      retry.props.onClick();
    });
    await act(async () => { release("id:uid-b"); });
    await settle();
    expect(user.getIdToken.mock.calls.length - before).toBe(1);
    expect(sent).toEqual(["Bearer id:uid-b"]);
    expect(mockedAccept).toHaveBeenCalledTimes(1);
  });
});

describe("C1 — existing invitation checks are preserved under the bearer", () => {
  it.each([
    [{ status: "invitation_email_mismatch" }, 403, "Different account"],
    [{ status: "invitation_invalid_or_expired" }, 404, "Invitation unavailable"],
    [{ status: "email_verification_required" }, 403, "Verify your email"],
  ])("core result %j -> HTTP %i -> '%s'", async (result, status, expected) => {
    jar.value = "sess:uid-b";
    mockedAccept.mockResolvedValueOnce(result);
    const r = await mount(authenticatedAs(shownUser("uid-b")));
    expect(routeCalls[0].status).toBe(status);
    expect(mockedAccept).toHaveBeenCalledWith({ uid: "uid-b", invitationId: INVITATION_ID, rawToken: SENTINEL });
    expect(heading(r)).toBe(expected);
  });
});

describe("C1 scope pins", () => {
  it("characterization (NOT changed by C1): the server route still accepts a cookie-only request — refusing it is Option B Stage 3", async () => {
    jar.value = "sess:uid-a";
    const req = new NextRequest(`http://localhost/api/workspace-invitations/${INVITATION_ID}/accept`, {
      method: "POST",
      headers: { cookie: "__session=sess:uid-a", "content-type": "application/json" },
      body: JSON.stringify({ token: SENTINEL }),
    });
    const res = await POST(req, { params: { invitationId: INVITATION_ID } });
    expect(res.status).toBe(200);
    expect(mockedAccept).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-a" }));
  });

  it("the acceptance client sends exactly one request, whose headers come only from prepareAuthedHeaders", () => {
    const src = readFileSync(join(process.cwd(), "app/workspace-invitations/accept/AcceptInvitationClient.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/(^|[^A-Za-z.])fetch\s*\(/g)).toHaveLength(1);
    expect(code.match(/prepareAuthedHeaders\s*\(/g)).toHaveLength(1);
    expect(code).toMatch(/headers = await prepareAuthedHeaders\(acceptingUser,/);
    const call = code.slice(code.search(/(^|[^A-Za-z.])fetch\s*\(/));
    expect(call.slice(0, call.indexOf("});"))).toMatch(/^\s*\S?fetch\([^]*\n\s*headers,\n/);
  });
});

describe("C1 correction — the account changes while the page is mounted", () => {
  it("'I've verified' retry: A switches to B while user.reload() is pending → no request with A's bearer; B is evaluated afresh", async () => {
    jar.value = "sess:uid-a";
    let finishReload!: () => void;
    const a = shownUser("uid-a");
    a.reload.mockImplementation(() => new Promise<void>((res) => { finishReload = res; }));
    mockedAccept.mockResolvedValueOnce({ status: "email_verification_required" });
    const r = await mount(authenticatedAs(a));
    expect(heading(r)).toBe("Verify your email");
    expect(sent).toEqual(["Bearer id:uid-a"]);
    const verifiedRetry = findButton(r, "I've verified — retry")!;
    await act(async () => { void verifiedRetry.props.onClick(); });
    // The account switches to B (B's own session cookie is minted) before the reload resolves.
    jar.value = "sess:uid-b";
    const b = shownUser("uid-b");
    await rerender(r, authenticatedAs(b));
    await act(async () => { finishReload(); });
    await settle();
    expect(sent.slice(1)).not.toContain("Bearer id:uid-a");
    expect(mockedAccept.mock.calls.map((c) => c[0].uid)).toEqual(["uid-a", "uid-b"]);
    expect(heading(r)).toBe("You've joined the workspace");
  });

  it("'I've verified' retry with the switch to B still syncing → nothing is sent until B is mutation-ready", async () => {
    jar.value = "sess:uid-a";
    let finishReload!: () => void;
    const a = shownUser("uid-a");
    a.reload.mockImplementation(() => new Promise<void>((res) => { finishReload = res; }));
    mockedAccept.mockResolvedValueOnce({ status: "email_verification_required" });
    const r = await mount(authenticatedAs(a));
    await act(async () => { void findButton(r, "I've verified — retry")!.props.onClick(); });
    const b = shownUser("uid-b");
    await rerender(r, { ...authenticatedAs(b), syncState: "syncing_session", canMutate: false });
    await act(async () => { finishReload(); });
    await settle();
    expect(sent).toEqual(["Bearer id:uid-a"]);
    expect(JSON.stringify(r.toJSON())).toContain("Loading your invitation");
  });

  it("Retry while the account is not mutation-ready (re-syncing) obtains no token and sends nothing", async () => {
    jar.value = "sess:uid-a";
    mockedAccept.mockResolvedValueOnce({ status: "auth_lookup_failed" }); // 503 → Retry offered
    const a = shownUser("uid-a");
    const r = await mount(authenticatedAs(a));
    expect(heading(r)).toBe("Temporarily unavailable");
    const tokenCalls = a.getIdToken.mock.calls.length;
    const retry = findButton(r, "Retry")!;
    await rerender(r, { ...authenticatedAs(a), syncState: "syncing_session", canMutate: false });
    await act(async () => { retry.props.onClick(); });
    await settle();
    expect(a.getIdToken.mock.calls.length).toBe(tokenCalls);
    expect(sent).toEqual(["Bearer id:uid-a"]);
    expect(JSON.stringify(r.toJSON())).toContain("Loading your invitation");
  });

  it("Retry after switching A → B while mounted sends B's bearer only", async () => {
    jar.value = "sess:uid-a";
    mockedAccept.mockResolvedValueOnce({ status: "auth_lookup_failed" }); // 503 → Retry offered
    const r = await mount(authenticatedAs(shownUser("uid-a")));
    expect(heading(r)).toBe("Temporarily unavailable");
    jar.value = "sess:uid-b";
    await rerender(r, authenticatedAs(shownUser("uid-b")));
    await act(async () => { findButton(r, "Retry")!.props.onClick(); });
    await settle();
    expect(sent).toEqual(["Bearer id:uid-a", "Bearer id:uid-b"]);
    expect(mockedAccept.mock.calls.map((c) => c[0].uid)).toEqual(["uid-a", "uid-b"]);
  });

  it("identity changes during token retrieval → A's request is never sent; the current account B is evaluated", async () => {
    jar.value = "sess:uid-a";
    let releaseA!: (v: string) => void;
    const a = shownUser("uid-a", () => new Promise<string>((res) => { releaseA = res; }));
    const r = await mount(authenticatedAs(a));
    expect(sent).toEqual([]);
    jar.value = "sess:uid-b";
    await rerender(r, authenticatedAs(shownUser("uid-b")));
    await act(async () => { releaseA("id:uid-a"); });
    await settle();
    expect(sent).toEqual(["Bearer id:uid-b"]);
    expect(mockedAccept.mock.calls.map((c) => c[0].uid)).toEqual(["uid-b"]);
  });

  it("the user becomes null (signed out) during the retry's token retrieval → no request; sign-in redirect with the credential kept", async () => {
    jar.value = "sess:uid-a";
    const storage = setWindow();
    let mode: "fail" | "pending" = "fail";
    let release!: (v: string) => void;
    const a = shownUser("uid-a", () => (mode === "fail" ? Promise.reject(new Error("network")) : new Promise<string>((res) => { release = res; })));
    const r = await mount(authenticatedAs(a));
    expect(heading(r)).toBe("Temporarily unavailable");
    mode = "pending";
    await act(async () => { findButton(r, "Retry")!.props.onClick(); });
    await rerender(r, { user: null, authReady: true, syncState: "signed_out", canMutate: false, beginLogout: jest.fn() });
    await act(async () => { release("id:uid-a"); });
    await settle();
    expect(sent).toEqual([]);
    expect(String(mockedRouterReplace.mock.calls.at(-1)?.[0])).toContain("/login");
    expect([...storage.backing.values()].join("")).toContain(INVITATION_ID);
  });

  it("A's response arrives after the switch to B → A's outcome is not shown; the page shows B's own result", async () => {
    jar.value = "sess:uid-a";
    let releaseResponse!: () => void;
    holdResponse = new Promise<void>((res) => { releaseResponse = res; });
    const r = await mount(authenticatedAs(shownUser("uid-a")));
    expect(sent).toEqual(["Bearer id:uid-a"]); // already sent: it cannot be recalled
    jar.value = "sess:uid-b";
    await rerender(r, authenticatedAs(shownUser("uid-b")));
    holdResponse = null;
    await act(async () => { releaseResponse(); });
    await settle();
    expect(sent).toEqual(["Bearer id:uid-a", "Bearer id:uid-b"]);
    const goButton = findButton(r, "Go to your Workspace")!;
    await act(async () => { goButton.props.onClick(); });
    expect(mockedRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockedRouterReplace).toHaveBeenCalledWith("/workspace/team/ws-of-uid-b");
  });
});
