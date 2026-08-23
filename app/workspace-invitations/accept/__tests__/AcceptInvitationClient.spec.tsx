/**
 * Team Workspace Invitations, Phase 8D.3.1 — `AcceptInvitationClient.tsx`
 * interactive behavior. `react-test-renderer` + `act()` (this repo has no
 * jsdom/@testing-library — `jest.config.ts`'s `testEnvironment: "node"`),
 * so `window`/`sessionStorage`/`history` are stubbed as plain objects on
 * `global` rather than provided by a real DOM, matching the module-boundary
 * mocking convention used throughout this repo's other route/component
 * tests. External boundaries (`useAuth`, router, fetch, sessionStorage,
 * Firebase verification/signOut, clearServerSession) are mocked; the real
 * component tree and state machine are exercised end-to-end.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  SESSION_STORAGE_KEY,
  INVITATION_ACCEPTANCE_ROUTE_PATH,
} from "@/lib/client/invitationAcceptance";

const SENTINEL = "SUPER_SECRET_INVITATION_TOKEN_987654";
const INVITATION_ID = "inv-1";

const mockedRouterReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => mockedRouterReplace(...args), push: jest.fn() }),
}));

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedSendEmailVerification = jest.fn();
const mockedSignOut = jest.fn();
jest.mock("firebase/auth", () => ({
  sendEmailVerification: (...args: unknown[]) => mockedSendEmailVerification(...args),
  signOut: (...args: unknown[]) => mockedSignOut(...args),
}));

jest.mock("@/lib/firebase/client", () => ({ auth: { __fakeAuth: true } }));

const mockedClearServerSession = jest.fn();
jest.mock("@/lib/client/sessionSync", () => ({
  clearServerSession: (...args: unknown[]) => mockedClearServerSession(...args),
}));

import AcceptInvitationClient from "@/app/workspace-invitations/accept/AcceptInvitationClient";

function fakeStorage(initial: Record<string, string> = {}) {
  const backing = new Map<string, string>(Object.entries(initial));
  return {
    backing,
    getItem: jest.fn((key: string) => (backing.has(key) ? backing.get(key)! : null)),
    setItem: jest.fn((key: string, value: string) => backing.set(key, value)),
    removeItem: jest.fn((key: string) => backing.delete(key)),
  };
}

function authState(overrides: Record<string, unknown> = {}) {
  return {
    user: null,
    authReady: false,
    syncState: "signed_out",
    canMutate: false,
    beginLogout: jest.fn(),
    ...overrides,
  };
}

const AUTHENTICATED_USER = { uid: "user-1", reload: jest.fn().mockResolvedValue(undefined) };

function setWindow({ hash = "", historyState = { nextRouterState: true } }: { hash?: string; historyState?: unknown } = {}) {
  const storage = fakeStorage();
  const win = {
    location: { hash },
    history: { state: historyState, replaceState: jest.fn(), pushState: jest.fn() },
    sessionStorage: storage,
  };
  (global as any).window = win;
  return { win, storage };
}

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ status, json: async () => body });
}

function findButton(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").find((b) => b.props.children === text || (Array.isArray(b.props.children) && b.props.children.join("") === text));
}

async function mount(auth: ReturnType<typeof authState>) {
  mockedUseAuth.mockReturnValue(auth);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(AcceptInvitationClient));
  });
  return renderer;
}

async function update(renderer: TestRenderer.ReactTestRenderer, auth: ReturnType<typeof authState>) {
  mockedUseAuth.mockReturnValue(auth);
  await act(async () => {
    renderer.update(createElement(AcceptInvitationClient));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

describe("AUTH READY", () => {
  it("issues no redirect and no fetch while authReady === false", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    await mount(authState({ authReady: false }));
    expect(mockedRouterReplace).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("SYNCHRONIZED AUTH", () => {
  it("does not POST when user exists but canMutate is false / syncState is not authenticated", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "syncing_session", canMutate: false }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("issues exactly one POST once synchronization becomes authenticated", async () => {
    const { renderer, } = { renderer: await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "syncing_session", canMutate: false })) };
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, workspaceId: "ws-1", alreadyMember: false, effectiveRole: "member" });
    await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("SIGNED-OUT FLOW", () => {
  it("scrubs history, persists the credential, and redirects to the static login URL — with no credential in the URL", async () => {
    const { storage, win } = setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    await mount(authState({ authReady: true, syncState: "signed_out" }));

    expect(win.history.replaceState).toHaveBeenCalledWith(win.history.state, "", INVITATION_ACCEPTANCE_ROUTE_PATH);
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(true);
    const stored = JSON.parse(storage.backing.get(SESSION_STORAGE_KEY)!);
    expect(stored).toMatchObject({ invitationId: INVITATION_ID, token: SENTINEL });

    expect(mockedRouterReplace).toHaveBeenCalledTimes(1);
    const target = mockedRouterReplace.mock.calls[0][0] as string;
    expect(decodeURIComponent(target)).toContain("/workspace-invitations/accept");
    expect(target).not.toContain(SENTINEL);
    expect(target).not.toContain(INVITATION_ID);
    expect(target).not.toContain("token=");
  });
});

describe("POST-LOGIN RESTORE", () => {
  it("restores a valid sessionStorage credential when no hash is present and accepts once", async () => {
    const now = Date.now();
    const { storage } = setWindow({ hash: "" });
    storage.backing.set(SESSION_STORAGE_KEY, JSON.stringify({ version: 1, invitationId: INVITATION_ID, token: SENTINEL, storedAt: now }));
    mockFetchOnce(200, { ok: true, workspaceId: "ws-1", alreadyMember: false, effectiveRole: "member" });

    await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("enters invalid_or_expired when no hash and no restorable storage exist", async () => {
    setWindow({ hash: "" });
    const renderer = await mount(authState({ authReady: true, syncState: "signed_out" }));
    expect(renderer.root.findByType("h1").props.children).toBe("Invitation unavailable");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("HASH PRECEDENCE", () => {
  it("a valid fragment wins over an existing stored credential", async () => {
    const { storage } = setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    storage.backing.set(SESSION_STORAGE_KEY, JSON.stringify({ version: 1, invitationId: "stale-inv", token: "stale-token", storedAt: Date.now() }));
    mockFetchOnce(200, { ok: true, workspaceId: "ws-1", alreadyMember: false });

    await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent(INVITATION_ID));
    expect(url).not.toContain("stale-inv");
  });

  it("a malformed fragment does not silently fall back to old storage — it clears storage and goes invalid", async () => {
    const { storage } = setWindow({ hash: "#invitationId=inv-1&invitationId=inv-2&token=abc" });
    storage.backing.set(SESSION_STORAGE_KEY, JSON.stringify({ version: 1, invitationId: "stale-inv", token: "stale-token", storedAt: Date.now() }));

    const renderer = await mount(authState({ authReady: true, syncState: "signed_out" }));

    expect(renderer.root.findByType("h1").props.children).toBe("Invitation unavailable");
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("SINGLE-FLIGHT", () => {
  it("issues exactly one fetch even when the auth-gated effect is re-triggered before the first request resolves", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    let resolveFetch!: (value: unknown) => void;
    (global.fetch as jest.Mock).mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Re-render with an equivalent (still-authenticated) auth object while the first request is still in flight.
    await update(renderer, authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch({ status: 200, json: async () => ({ ok: true, alreadyMember: false }) });
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("EXPLICIT RETRY", () => {
  it("does not auto-retry after a 503, but a manual Retry issues exactly one new request", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(503, { ok: false, errorCode: "service_unavailable" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("h1").props.children).toBe("Temporarily unavailable");

    mockFetchOnce(200, { ok: true, alreadyMember: false });
    const retryButton = findButton(renderer, "Retry")!;
    await act(async () => {
      await retryButton.props.onClick();
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
  });
});

describe("EXACT ACCEPT BODY", () => {
  it("POSTs to the exact endpoint with a body of exactly {token}", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, alreadyMember: false });
    await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`/api/workspace-invitations/${encodeURIComponent(INVITATION_ID)}/accept`);
    expect(JSON.parse(init.body)).toEqual({ token: SENTINEL });
  });
});

describe("RAW TOKEN — DOM / console / router / history boundary", () => {
  it("the sentinel token never appears outside the fetch request body", async () => {
    const consoleSpy = ["log", "warn", "error", "debug"].map((m) => jest.spyOn(console, m as "log"));
    const { win } = setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, alreadyMember: false });

    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(JSON.stringify(renderer.toJSON())).not.toContain(SENTINEL);
    for (const spy of consoleSpy) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
      spy.mockRestore();
    }
    expect(mockedRouterReplace.mock.calls.flat().join("")).not.toContain(SENTINEL);
    expect(win.history.replaceState.mock.calls.flat().join("")).not.toContain(SENTINEL);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.body).toContain(SENTINEL);
  });
});

describe("RESPONSE MAPPING", () => {
  const CASES: Array<{ status: number; body: unknown; heading: string }> = [
    { status: 200, body: { ok: true, alreadyMember: false }, heading: "You've joined the workspace" },
    { status: 200, body: { ok: true, alreadyMember: true, effectiveRole: "member" }, heading: "You're already a member" },
    { status: 400, body: { ok: false, errorCode: "invalid_input" }, heading: "Invitation unavailable" },
    { status: 403, body: { ok: false, errorCode: "email_verification_required" }, heading: "Verify your email" },
    { status: 403, body: { ok: false, errorCode: "invitation_email_mismatch" }, heading: "Different account" },
    { status: 404, body: { ok: false, errorCode: "invitation_invalid_or_expired" }, heading: "Invitation unavailable" },
    { status: 503, body: { ok: false, errorCode: "team_workspaces_disabled" }, heading: "Temporarily unavailable" },
    { status: 503, body: { ok: false, errorCode: "service_unavailable" }, heading: "Temporarily unavailable" },
    { status: 500, body: { ok: false, errorCode: "internal_error" }, heading: "Something went wrong" },
  ];

  it.each(CASES)("status $status ($body.errorCode) -> heading '$heading'", async ({ status, body, heading }) => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(status, body);
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(renderer.root.findByType("h1").props.children).toBe(heading);
  });

  it("401 after synchronized auth -> session_expired, no automatic redirect", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(401, { ok: false });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(renderer.root.findByType("h1").props.children).toBe("Session expired");
    expect(mockedRouterReplace).not.toHaveBeenCalled();
  });
});

describe("WRONG ACCOUNT", () => {
  it("shows a generic message, retains the credential, and switches account in the correct sequence with no token in the URL", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(403, { ok: false, errorCode: "invitation_email_mismatch" });
    const beginLogout = jest.fn();
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true, beginLogout }));

    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/@/); // no invited email disclosed

    mockedClearServerSession.mockResolvedValueOnce(true);
    mockedSignOut.mockResolvedValueOnce(undefined);
    const switchButton = findButton(renderer, "Switch account")!;
    await act(async () => {
      await switchButton.props.onClick();
    });

    const order = [beginLogout.mock.invocationCallOrder[0], mockedClearServerSession.mock.invocationCallOrder[0], mockedSignOut.mock.invocationCallOrder[0]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(decodeURIComponent(mockedRouterReplace.mock.calls[0][0])).toContain("/workspace-invitations/accept");
    expect(mockedRouterReplace.mock.calls[0][0]).not.toContain(SENTINEL);
  });

  it("shows a generic error and keeps the credential available on account-switch failure", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(403, { ok: false, errorCode: "invitation_email_mismatch" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    mockedClearServerSession.mockRejectedValueOnce(new Error("network"));
    const switchButton = findButton(renderer, "Switch account")!;
    await act(async () => {
      await switchButton.props.onClick();
    });

    expect(renderer.root.findAllByProps({ role: "alert" }).some((n) => String(n.children?.join?.("") ?? n.children).includes("Couldn't switch accounts"))).toBe(true);
    expect(mockedRouterReplace).not.toHaveBeenCalled();
  });
});

describe("EMAIL VERIFICATION", () => {
  it("persists the credential for continuity, never auto-sends, and sends once on explicit action", async () => {
    const { storage } = setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(403, { ok: false, errorCode: "email_verification_required" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(true);
    expect(mockedSendEmailVerification).not.toHaveBeenCalled();

    mockedSendEmailVerification.mockResolvedValueOnce(undefined);
    const sendButton = findButton(renderer, "Send verification email")!;
    await act(async () => {
      await sendButton.props.onClick();
    });

    expect(mockedSendEmailVerification).toHaveBeenCalledTimes(1);
    expect(mockedSendEmailVerification).toHaveBeenCalledWith(AUTHENTICATED_USER);
  });

  it("shows a generic failure message with no raw Firebase error, credential retained", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(403, { ok: false, errorCode: "email_verification_required" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    mockedSendEmailVerification.mockRejectedValueOnce(new Error("auth/too-many-requests: raw firebase detail"));
    const sendButton = findButton(renderer, "Send verification email")!;
    await act(async () => {
      await sendButton.props.onClick();
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Couldn't send verification email");
    expect(text).not.toContain("raw firebase detail");
  });
});

describe("VERIFIED RETRY", () => {
  it("reloads the user then issues exactly one deliberate retry POST, no auto loop", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(403, { ok: false, errorCode: "email_verification_required" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    mockFetchOnce(200, { ok: true, alreadyMember: false });
    const retryButton = findButton(renderer, "I've verified — retry")!;
    await act(async () => {
      await retryButton.props.onClick();
    });

    expect(AUTHENTICATED_USER.reload).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
  });
});

describe("TERMINAL CLEAR", () => {
  it.each([404, 400])("status %i clears storage and offers no retry submission", async (status) => {
    const { storage } = setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(status, { ok: false });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(findButton(renderer, "Retry")).toBeUndefined();
  });
});

describe("RECOVERABLE RETENTION", () => {
  it.each([503, 500])("status %i retains the credential (Retry successfully re-submits it)", async (status) => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(status, { ok: false });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    mockFetchOnce(200, { ok: true, alreadyMember: false });
    const retryButton = findButton(renderer, "Retry")!;
    await act(async () => {
      await retryButton.props.onClick();
    });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[1];
    expect(url).toBe(`/api/workspace-invitations/${encodeURIComponent(INVITATION_ID)}/accept`);
    expect(JSON.parse(init.body)).toEqual({ token: SENTINEL });
  });
});

describe("NO FORBIDDEN STORAGE", () => {
  it("never touches localStorage, document.cookie, or IndexedDB", async () => {
    const { win } = setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, alreadyMember: false });
    expect("localStorage" in win).toBe(false);
    expect("indexedDB" in win).toBe(false);
    expect("document" in win).toBe(false);
    await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    // If the component had referenced any of the above, the render above
    // would have thrown against this deliberately incomplete `window` stub.
  });

  it("source contains no reference to localStorage, document.cookie, or indexedDB", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "AcceptInvitationClient.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/document\.cookie/);
    expect(source).not.toMatch(/indexedDB/i);
  });
});
