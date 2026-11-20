/**
 * GHSA-655j-5f43-92pw — envelope ownership in the acceptance page (review R6 MINOR-3), plus the two telemetry-ENABLED
 * document gates (review R3 MAJOR-1, R4 NIT-2).
 *
 * Once a document hands the tab's invitation to a successor document (the same-document fragment guard for a second
 * link B, or the page's telemetry-on gates), nothing this document started for the earlier credential A — a fetch that
 * resolves or rejects later, the auth-gated effect, the account-switch handler — may restore A, clear B, extend B's
 * expiry, navigate, or show an outcome. Ownership is one-way module state of a document, so every test loads a fresh
 * module registry (`loadDocument`): one test = one document. Concurrency is driven by controlled deferred promises.
 */

const SECRET_A = "TOKEN_A_SENTINEL_111111";
const SECRET_B = "TOKEN_B_SENTINEL_222222";
const ID_A = "inv-A";
const ID_B = "inv-B";
const KEY = "convergepanel.invitationAcceptance.v1";
const ACCEPT_PATH = "/workspace-invitations/accept";

const mockedRouterReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => mockedRouterReplace(...args), push: jest.fn() }),
}));
const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));
const mockedSignOut = jest.fn();
jest.mock("firebase/auth", () => ({ sendEmailVerification: jest.fn(), signOut: (...a: unknown[]) => mockedSignOut(...a) }));
jest.mock("@/lib/firebase/client", () => ({ auth: { __fakeAuth: true } }));
const mockTelemetryFree = jest.fn(() => true);
jest.mock("@/lib/telemetry/telemetryFreeDocument", () => ({ isTelemetryFreeDocument: () => mockTelemetryFree() }));
const mockedClearServerSession = jest.fn();
jest.mock("@/lib/client/sessionSync", () => ({ clearServerSession: (...a: unknown[]) => mockedClearServerSession(...a) }));

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadDocument() {
  let mod!: {
    React: typeof import("react");
    TR: typeof import("react-test-renderer");
    Page: React.ComponentType;
    inv: typeof import("@/lib/client/invitationAcceptance");
  };
  jest.isolateModules(() => {
    mod = {
      React: require("react"),
      TR: require("react-test-renderer"),
      Page: require("@/app/workspace-invitations/accept/AcceptInvitationClient").default,
      inv: require("@/lib/client/invitationAcceptance"),
    };
  });
  return mod;
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

function setWindow(hash: string) {
  const storage = fakeStorage();
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const win = {
    location: { pathname: ACCEPT_PATH, search: "", hash, replace: jest.fn() },
    history: { state: { nextRouterState: true }, replaceState: jest.fn((_s: unknown, _t: string, url: string) => { win.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : ""; }), pushState: jest.fn() },
    sessionStorage: storage,
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  (global as any).window = win;
  /** Dispatches like a browser: every listener in order until one calls stopImmediatePropagation. Returns how many ran. */
  const dispatch = (type: string, extra: Record<string, unknown> = {}) => {
    let stopped = false;
    let ran = 0;
    const event = { type, ...extra, stopImmediatePropagation: () => { stopped = true; } };
    for (const fn of listeners[type] ?? []) {
      if (stopped) break;
      ran++;
      fn(event);
    }
    return ran;
  };
  return { win, storage, dispatch, listeners };
}

function auth(overrides: Record<string, unknown> = {}) {
  return { user: { uid: "u1", reload: jest.fn().mockResolvedValue(undefined) }, authReady: true, syncState: "authenticated", canMutate: true, beginLogout: jest.fn(), ...overrides };
}

async function mount(doc: ReturnType<typeof loadDocument>, a: ReturnType<typeof auth>) {
  mockedUseAuth.mockReturnValue(a);
  let r!: import("react-test-renderer").ReactTestRenderer;
  await doc.TR.act(async () => {
    r = doc.TR.create(doc.React.createElement(doc.Page));
  });
  return r;
}

const text = (r: import("react-test-renderer").ReactTestRenderer) => JSON.stringify(r.toJSON());

/** Second link B arrives by same-document fragment navigation and is handled by the real pre-SDK guard. */
function secondLinkArrives(doc: ReturnType<typeof loadDocument>, w: ReturnType<typeof setWindow>) {
  doc.inv.installInvitationFragmentNavigationGuard(w.win as any);
  w.win.location.hash = `#invitationId=${ID_B}&token=${SECRET_B}`;
  w.dispatch("popstate");
}

const envelope = (w: ReturnType<typeof setWindow>) => (w.storage.backing.has(KEY) ? JSON.parse(w.storage.backing.get(KEY)!) : null);

beforeEach(() => {
  jest.clearAllMocks();
  mockTelemetryFree.mockReturnValue(true);
  global.fetch = jest.fn();
});

describe("R6 MINOR-3: invitation B stays authoritative when A's in-flight request completes afterwards", () => {
  const outcomes: Array<[string, (d: Deferred<any>) => void]> = [
    ["200 success", (d) => d.resolve({ status: 200, json: async () => ({ ok: true, workspaceId: "ws-A", alreadyMember: false }) })],
    ["200 already member", (d) => d.resolve({ status: 200, json: async () => ({ ok: true, workspaceId: "ws-A", alreadyMember: true, effectiveRole: "member" }) })],
    ["400 invalid (would clear)", (d) => d.resolve({ status: 400, json: async () => ({ errorCode: "invalid_input" }) })],
    ["404 invalid (would clear)", (d) => d.resolve({ status: 404, json: async () => ({}) })],
    ["401 session expired (would store A)", (d) => d.resolve({ status: 401, json: async () => ({}) })],
    ["403 verification required (would store A)", (d) => d.resolve({ status: 403, json: async () => ({ errorCode: "email_verification_required" }) })],
    ["403 wrong account", (d) => d.resolve({ status: 403, json: async () => ({ errorCode: "invitation_email_mismatch" }) })],
    ["503", (d) => d.resolve({ status: 503, json: async () => ({}) })],
    ["500", (d) => d.resolve({ status: 500, json: async () => ({}) })],
    ["network rejection", (d) => d.reject(new Error("network"))],
    ["unreadable body", (d) => d.resolve({ status: 401, json: async () => { throw new Error("bad json"); } })],
  ];

  it.each(outcomes)("A completes with %s after B took over: B's envelope is unchanged (not restored to A, not cleared, not re-dated), no outcome is shown, no navigation", async (_name, settle) => {
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    const inflight = deferred<any>();
    (global.fetch as jest.Mock).mockReturnValueOnce(inflight.promise);
    const r = await mount(doc, auth());
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(text(r)).toContain("Accepting your invitation");

    secondLinkArrives(doc, w);
    expect(w.win.location.replace).toHaveBeenCalledWith(ACCEPT_PATH);
    const atHandOff = envelope(w);
    expect(atHandOff).toMatchObject({ invitationId: ID_B, token: SECRET_B });
    const setCalls = w.storage.setItem.mock.calls.length;
    const removeCalls = w.storage.removeItem.mock.calls.length;

    await doc.TR.act(async () => {
      settle(inflight);
      await inflight.promise.catch(() => undefined);
    });
    await doc.TR.act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });

    expect(envelope(w)).toEqual(atHandOff); // same credential AND same storedAt: not restored, not cleared, not extended
    expect(w.storage.setItem.mock.calls.length).toBe(setCalls);
    expect(w.storage.removeItem.mock.calls.length).toBe(removeCalls);
    expect(text(r)).toContain("Accepting your invitation"); // never A's success/failure view
    expect(mockedRouterReplace).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("control: without a second link, the same A outcome DOES write the envelope (proves the assertions above can fail)", async () => {
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    const inflight = deferred<any>();
    (global.fetch as jest.Mock).mockReturnValueOnce(inflight.promise);
    const r = await mount(doc, auth());
    await doc.TR.act(async () => {
      inflight.resolve({ status: 403, json: async () => ({ errorCode: "email_verification_required" }) });
      await inflight.promise;
    });
    expect(envelope(w)).toMatchObject({ invitationId: ID_A, token: SECRET_A });
    expect(text(r)).toContain("Verify your email");
  });

  it("the signed-out branch that runs after B took over neither stores A nor redirects to sign-in", async () => {
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    const r = await mount(doc, auth({ user: null, authReady: false, syncState: "authenticating", canMutate: false }));
    secondLinkArrives(doc, w);
    const atHandOff = envelope(w);
    mockedUseAuth.mockReturnValue(auth({ user: null, authReady: true, syncState: "signed_out", canMutate: false }));
    await doc.TR.act(async () => {
      r.update(doc.React.createElement(doc.Page));
    });
    expect(envelope(w)).toEqual(atHandOff);
    expect(mockedRouterReplace).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("an account switch whose sign-out completes after B took over does not redirect and leaves B's envelope alone", async () => {
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ status: 403, json: async () => ({ errorCode: "invitation_email_mismatch" }) });
    const r = await mount(doc, auth());
    expect(text(r)).toContain("Different account");
    const signOutDone = deferred<void>();
    mockedClearServerSession.mockResolvedValueOnce(undefined);
    mockedSignOut.mockReturnValueOnce(signOutDone.promise);
    const button = r.root.findAllByType("button").find((b) => String(b.props.children).includes("Switch"))!;
    let clicked!: Promise<unknown>;
    await doc.TR.act(async () => {
      clicked = button.props.onClick();
    });
    secondLinkArrives(doc, w);
    const atHandOff = envelope(w);
    await doc.TR.act(async () => {
      signOutDone.resolve();
      await clicked;
    });
    expect(envelope(w)).toEqual(atHandOff);
    expect(mockedRouterReplace).not.toHaveBeenCalled();
  });

  it("Switch account pressed after B took over does nothing: no sign-out (shared auth state the successor relies on), no session clear, no redirect", async () => {
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ status: 403, json: async () => ({ errorCode: "invitation_email_mismatch" }) });
    const r = await mount(doc, auth());
    const button = r.root.findAllByType("button").find((b) => String(b.props.children).includes("Switch"))!;
    secondLinkArrives(doc, w);
    const atHandOff = envelope(w);
    await doc.TR.act(async () => {
      await button.props.onClick();
    });
    expect(mockedClearServerSession).not.toHaveBeenCalled();
    expect(mockedSignOut).not.toHaveBeenCalled();
    expect(mockedRouterReplace).not.toHaveBeenCalled();
    expect(envelope(w)).toEqual(atHandOff);
  });

  it("a Retry pressed after B took over issues no request for A", async () => {
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ status: 503, json: async () => ({}) });
    const r = await mount(doc, auth());
    const retry = r.root.findAllByType("button").find((b) => String(b.props.children).includes("Try again") || String(b.props.children).includes("Retry"));
    expect(retry).toBeDefined();
    secondLinkArrives(doc, w);
    await doc.TR.act(async () => {
      retry!.props.onClick();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("a third link C after B: the latest link wins (C), and later events never reach other listeners", async () => {
    const doc = loadDocument();
    const w = setWindow("");
    doc.inv.installInvitationFragmentNavigationGuard(w.win as any);
    const later = jest.fn();
    w.win.addEventListener("hashchange", later);
    w.win.location.hash = `#invitationId=${ID_B}&token=${SECRET_B}`;
    w.dispatch("popstate");
    // review R6 NIT-1: the hashchange that follows the handled popstate (newURL still holds the fragment) is stopped.
    w.dispatch("hashchange", { newURL: `https://x${ACCEPT_PATH}#invitationId=${ID_B}&token=${SECRET_B}` });
    expect(later).not.toHaveBeenCalled();
    w.win.location.hash = "#invitationId=inv-C&token=TOKEN_C";
    w.dispatch("hashchange");
    expect(envelope(w)).toMatchObject({ invitationId: "inv-C", token: "TOKEN_C" });
    expect(later).not.toHaveBeenCalled();
  });

  it("the storage boundary itself refuses writes, clears and restores once superseded", () => {
    const doc = loadDocument();
    const s = fakeStorage();
    doc.inv.handOffInvitationCredential(s, { kind: "valid", invitationId: ID_B, token: SECRET_B });
    const before = s.backing.get(KEY);
    doc.inv.storeInvitationAcceptance(s, { invitationId: ID_A, token: SECRET_A }, Date.now() + 1000);
    doc.inv.clearInvitationAcceptance(s);
    expect(doc.inv.restoreInvitationAcceptance(s, Date.now())).toBeNull();
    expect(s.backing.get(KEY)).toBe(before);
    expect(doc.inv.isInvitationDocumentSuperseded()).toBe(true);
  });

  it("an invalid second link clears the envelope and supersedes the document", () => {
    const doc = loadDocument();
    const s = fakeStorage();
    s.backing.set(KEY, "x");
    doc.inv.handOffInvitationCredential(s, { kind: "invalid" });
    expect(s.backing.has(KEY)).toBe(false);
    doc.inv.storeInvitationAcceptance(s, { invitationId: ID_A, token: SECRET_A }, Date.now());
    expect(s.backing.has(KEY)).toBe(false);
  });

  it("control: a fresh document has write access (ownership is per document, not global)", () => {
    const doc = loadDocument();
    const s = fakeStorage();
    expect(doc.inv.isInvitationDocumentSuperseded()).toBe(false);
    doc.inv.storeInvitationAcceptance(s, { invitationId: ID_A, token: SECRET_A }, Date.now());
    expect(doc.inv.restoreInvitationAcceptance(s, Date.now())).toMatchObject({ invitationId: ID_A });
  });
});

describe("telemetry-ENABLED document gates (moved from AcceptInvitationClient.spec.tsx)", () => {
  it("correction round (review R3 MAJOR-1): the envelope is never read or used: no POST, envelope untouched, tab moved to a fresh acceptance document, and this document loses envelope write access", async () => {
    mockTelemetryFree.mockReturnValue(false);
    const doc = loadDocument();
    const w = setWindow("");
    const raw = JSON.stringify({ version: 1, invitationId: ID_A, token: SECRET_A, storedAt: Date.now() });
    w.storage.backing.set(KEY, raw);
    const r = await mount(doc, auth());
    expect(w.win.location.replace).toHaveBeenCalledWith(ACCEPT_PATH);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(w.storage.backing.get(KEY)).toBe(raw);
    expect(w.storage.getItem.mock.calls.length).toBeLessThanOrEqual(1);
    expect(r.root.findAllByType("h1")).toHaveLength(0);
    expect(r.root.findByType("p").props.children).toBe("Loading your invitation…");
    expect(doc.inv.isInvitationDocumentSuperseded()).toBe(true);
  });

  it("review R4 NIT-2: a credential fragment is never processed there: scrubbed, carried in the envelope, tab moved to a fresh acceptance document; no POST", async () => {
    mockTelemetryFree.mockReturnValue(false);
    const doc = loadDocument();
    const w = setWindow(`#invitationId=${ID_A}&token=${SECRET_A}`);
    await mount(doc, auth());
    expect(w.win.history.replaceState).toHaveBeenCalledWith(w.win.history.state, "", ACCEPT_PATH);
    expect(w.win.location.replace).toHaveBeenCalledWith(ACCEPT_PATH);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(envelope(w)).toMatchObject({ invitationId: ID_A, token: SECRET_A });
    expect(doc.inv.isInvitationDocumentSuperseded()).toBe(true);
  });
});
