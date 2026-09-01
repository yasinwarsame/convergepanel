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

/**
 * Phase 8D.3.4-R1 — regression coverage for a real Production defect found
 * via live canary testing: a rapid double-activation of Retry could defeat
 * the single-flight guard (`handleRetry` used to unconditionally reset
 * `inFlightRef` before starting another attempt) and let a second, stale
 * `invitation_invalid_or_expired` response overwrite an already-successful
 * acceptance in the UI. The backend itself was never at risk — Firestore
 * correctly rejected the redundant accept — this is purely a frontend
 * concurrency defect.
 */
describe("RAPID DOUBLE RETRY (Phase 8D.3.4-R1 regression)", () => {
  it("a second immediate Retry activation while the first retry request is unresolved issues no second fetch", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(503, { ok: false, errorCode: "service_unavailable" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("h1").props.children).toBe("Temporarily unavailable");

    const retryButton = findButton(renderer, "Retry")!;
    const onRetryClick = retryButton.props.onClick as () => void;

    let resolveRetryFetch!: (value: unknown) => void;
    (global.fetch as jest.Mock).mockReturnValueOnce(new Promise((resolve) => { resolveRetryFetch = resolve; }));

    await act(async () => {
      // Two activations of the SAME captured handler reference, both
      // firing before React has a chance to re-render — reproducing the
      // exact race window a real rapid double-click exploited in
      // Production (the button itself unmounts once accepting begins, so
      // this is the faithful way to model "two clicks landed before the
      // re-render that would have removed the control").
      onRetryClick();
      onRetryClick();
    });

    // One fetch for the initial mount's 503, one for the retry — NOT two
    // retries, despite two activations of the handler.
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRetryFetch({ status: 200, json: async () => ({ ok: true, alreadyMember: false }) });
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
  });
});

describe("RETRY CONTROL NON-ACTIONABLE WHILE IN FLIGHT", () => {
  it("the Retry control is disabled/absent for the duration of an active retry request", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(503, { ok: false, errorCode: "service_unavailable" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    const retryButton = findButton(renderer, "Retry")!;
    expect(retryButton.props.disabled).toBeFalsy();

    let resolveRetryFetch!: (value: unknown) => void;
    (global.fetch as jest.Mock).mockReturnValueOnce(new Promise((resolve) => { resolveRetryFetch = resolve; }));
    await act(async () => {
      retryButton.props.onClick();
    });

    // The correctness guarantee is the synchronous inFlightRef check, not
    // this UI state — but the control itself must also be non-actionable
    // while a request is active. In this component's architecture the
    // whole "temporarily_unavailable" view (including the Retry button)
    // unmounts in favor of the "accepting" view the instant a request
    // starts, which is a stronger form of non-actionable than merely
    // `disabled`.
    expect(findButton(renderer, "Retry")).toBeUndefined();

    await act(async () => {
      resolveRetryFetch({ status: 200, json: async () => ({ ok: true, alreadyMember: false }) });
    });
    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
  });
});

describe("SUCCESS CANNOT BE OVERWRITTEN (Phase 8D.3.4-R1 regression)", () => {
  it("success is a stable terminal state: no retry control exists afterward, no further fetch fires, and success survives further re-renders", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, alreadyMember: false });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Simulate further churn (e.g. auth state re-emitting) after success —
    // this must never regress the UI or issue another request. With the
    // single-flight fix, two truly concurrent acceptance fetches are
    // structurally impossible, so this is the closest meaningful boundary:
    // the credential is cleared on success and no control remains that
    // could re-trigger acceptance.
    await update(renderer, authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(findButton(renderer, "Retry")).toBeUndefined();
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

describe("Phase 12A.1 — post-acceptance redirect uses the response's own workspaceId", () => {
  it("success: clicking 'Go to your Workspace' redirects into the exact joined Workspace, from the response's workspaceId", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, workspaceId: "ws-abc123", alreadyMember: false, effectiveRole: "member" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(renderer.root.findByType("h1").props.children).toBe("You've joined the workspace");
    const button = findButton(renderer, "Go to your Workspace");
    expect(button).toBeDefined();
    await act(async () => {
      button!.props.onClick();
    });
    expect(mockedRouterReplace).toHaveBeenCalledWith("/workspace/team/ws-abc123");
    expect(mockedRouterReplace).not.toHaveBeenCalledWith("/");
  });

  it("already_member_success: clicking 'Go to your Workspace' also redirects into the exact Workspace, not '/'", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, workspaceId: "ws-xyz789", alreadyMember: true, effectiveRole: "admin" });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));

    expect(renderer.root.findByType("h1").props.children).toBe("You're already a member");
    const button = findButton(renderer, "Go to your Workspace");
    expect(button).toBeDefined();
    await act(async () => {
      button!.props.onClick();
    });
    expect(mockedRouterReplace).toHaveBeenCalledWith("/workspace/team/ws-xyz789");
    expect(mockedRouterReplace).not.toHaveBeenCalledWith("/");
  });

  it("workspaceId is URI-encoded in the redirect target", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, workspaceId: "ws with space", alreadyMember: false });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    const button = findButton(renderer, "Go to your Workspace");
    await act(async () => {
      button!.props.onClick();
    });
    const target = mockedRouterReplace.mock.calls[0][0] as string;
    expect(target).toContain(encodeURIComponent("ws with space"));
  });

  it("a malformed 200 response missing workspaceId falls back to '/' rather than crashing or redirecting to an invalid URL", async () => {
    setWindow({ hash: `#invitationId=${INVITATION_ID}&token=${SENTINEL}` });
    mockFetchOnce(200, { ok: true, alreadyMember: false });
    const renderer = await mount(authState({ user: AUTHENTICATED_USER, authReady: true, syncState: "authenticated", canMutate: true }));
    const button = findButton(renderer, "Go to your Workspace");
    expect(button).toBeDefined();
    await act(async () => {
      button!.props.onClick();
    });
    expect(mockedRouterReplace).toHaveBeenCalledWith("/");
  });

  it("no remaining reference to the old hardcoded redirect-to-Personal-home behavior for the success paths", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "AcceptInvitationClient.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/onClick=\{\(\) => router\.replace\("\/"\)\}/);
  });
});
