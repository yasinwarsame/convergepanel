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
jest.mock("@/lib/client/sessionSync", () => ({
  establishServerSession: async (user: any) => ({ ok: true, uid: user.uid }),
  clearServerSession: async () => true,
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
    session.setItem("convergePanelVerifyPrefillV1", "SYNTHETIC_CLAIM_A");

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
