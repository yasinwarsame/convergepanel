/**
 * Privacy remediation (2026-11-17 audit) — signing out removes the browser's
 * cached copies of the user's claims and model output. Renders the REAL
 * `AuthProvider` and drives its REAL `onIdTokenChanged` callback (captured
 * from a mocked `firebase/auth`) with synthetic users, against in-memory
 * localStorage / sessionStorage doubles. Synthetic data only.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

let tokenCallback: ((user: any) => Promise<void>) | undefined;
let mockSyncOk = true;
const mockSignOut = jest.fn(async () => undefined);
const mockFirebaseAuth = { currentUser: null as unknown };
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_auth: unknown, cb: any) => {
    // Firebase sets currentUser before notifying observers.
    tokenCallback = (u: any) => {
      mockFirebaseAuth.currentUser = u;
      return cb(u);
    };
    return () => undefined;
  },
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: (...args: any[]) => (mockSignOut as any)(...args),
}));
// R-S0-7: AuthProvider signs out only while Firebase still reports the failed User object, so the double exposes currentUser.
jest.mock("@/lib/firebase/client", () => ({
  get auth() {
    return mockFirebaseAuth;
  },
}));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
jest.mock("@/lib/client/sessionSync", () => ({
  establishServerSession: async (user: any) => (mockSyncOk ? { ok: true, uid: user.uid } : { ok: false, reason: "synthetic" }),
}));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
const mockReset = jest.fn();
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => mockReset() } }));

import { AuthProvider } from "@/components/AuthProvider";

const HISTORY = JSON.stringify([{ claim: "SYNTHETIC_CLAIM_A", payload: { summary: "SYNTHETIC_MODEL_OUTPUT_A" } }]);
const g = globalThis as any;
const SAVED_WINDOW = g.window;
let local: FakeStorage;
let session: FakeStorage;

beforeEach(() => {
  jest.clearAllMocks();
  tokenCallback = undefined;
  local = new FakeStorage();
  session = new FakeStorage();
  g.window = { localStorage: local, sessionStorage: session };
  act(() => {
    TestRenderer.create(createElement(AuthProvider, null, createElement("div", null, "app")));
  });
  expect(typeof tokenCallback).toBe("function");
});
afterAll(() => {
  g.window = SAVED_WINDOW;
});

async function emit(user: { uid: string } | null) {
  await act(async () => {
    await tokenCallback!(user);
  });
}

function allStored(): string {
  return JSON.stringify([...local.keys().map((k) => [k, local.getItem(k)]), ...session.keys().map((k) => [k, session.getItem(k)])]);
}

describe("AuthProvider — sign-out clears local private data", () => {
  it("removes every cached history key and the /verify hand-off, and resets PostHog, when a signed-in user signs out", async () => {
    await emit({ uid: "uid-a" });
    local.setItem("convergePanelHistoryV1:uid-a", HISTORY);
    local.setItem("unrelated-pref", "keep");
    session.setItem("convergePanelVerifyPendingV2", JSON.stringify({ v: 2, text: "SYNTHETIC_CLAIM_A", boundUid: "uid-a", expiresAt: Date.now() + 60_000 }));

    await emit(null);

    expect(allStored()).not.toContain("SYNTHETIC_CLAIM_A");
    expect(allStored()).not.toContain("SYNTHETIC_MODEL_OUTPUT_A");
    expect(local.getItem("unrelated-pref")).toBe("keep"); // control
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it("an anonymous first load clears stale history but does NOT reset PostHog (anonymous ids stay stable)", async () => {
    local.setItem("convergePanelHistoryV1:uid-old", HISTORY);
    await emit(null);
    expect(local.getItem("convergePanelHistoryV1:uid-old")).toBeNull();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("round 2 (review B1): an anonymous cold load's null callback KEEPS the /verify pending input; a later sign-in claims it", async () => {
    session.setItem("convergePanelVerifyPendingV2", JSON.stringify({ v: 2, text: "SYNTHETIC_CLAIM_ANON", boundUid: null, expiresAt: Date.now() + 60_000 }));
    await emit(null);
    expect(session.getItem("convergePanelVerifyPendingV2")).toContain("SYNTHETIC_CLAIM_ANON");
    await emit({ uid: "uid-a" });
    expect(JSON.parse(session.getItem("convergePanelVerifyPendingV2")!).boundUid).toBe("uid-a");
  });

  it("round 2: a pending input bound to A is removed when B signs in (direct switch)", async () => {
    await emit({ uid: "uid-a" });
    session.setItem("convergePanelVerifyPendingV2", JSON.stringify({ v: 2, text: "SYNTHETIC_CLAIM_A", boundUid: "uid-a", expiresAt: Date.now() + 60_000 }));
    await emit({ uid: "uid-b" });
    expect(session.getItem("convergePanelVerifyPendingV2")).toBeNull();
  });

  it("round 2: a failed server-session sync still counts as 'was signed in' — the fail-closed sign-out clears the pending input and resets PostHog", async () => {
    mockSyncOk = false;
    session.setItem("convergePanelVerifyPendingV2", JSON.stringify({ v: 2, text: "SYNTHETIC_CLAIM_X", boundUid: null, expiresAt: Date.now() + 60_000 }));
    await emit({ uid: "uid-x" }); // claims it, then sync fails -> AuthProvider signs out
    await emit(null);
    expect(session.getItem("convergePanelVerifyPendingV2")).toBeNull();
    expect(mockReset).toHaveBeenCalledTimes(1);
    mockSyncOk = true;
  });

  it("a direct account switch (A -> B, no logout) removes A's cache and keeps B's", async () => {
    await emit({ uid: "uid-a" });
    local.setItem("convergePanelHistoryV1:uid-a", HISTORY);
    local.setItem("convergePanelHistoryV1:uid-b", "[]");
    await emit({ uid: "uid-b" });
    expect(local.getItem("convergePanelHistoryV1:uid-a")).toBeNull();
    expect(local.getItem("convergePanelHistoryV1:uid-b")).toBe("[]");
  });

  it("control: a same-uid token refresh keeps the user's own cache", async () => {
    await emit({ uid: "uid-a" });
    local.setItem("convergePanelHistoryV1:uid-a", HISTORY);
    await emit({ uid: "uid-a" });
    expect(local.getItem("convergePanelHistoryV1:uid-a")).toBe(HISTORY);
    expect(mockReset).not.toHaveBeenCalled();
  });
});
