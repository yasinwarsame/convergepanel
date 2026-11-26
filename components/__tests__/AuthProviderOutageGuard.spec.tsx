/**
 * Stage 0 F3 — defense in depth in `AuthProvider` itself: even if `establishServerSession` ever returned
 * `auth_unavailable` for a NEW identity (first callback, cold load, account switch), AuthProvider must not keep it —
 * it must take the fail-closed branch (sign Firebase out, never authenticated). sessionSync is mocked here precisely
 * to feed that outcome, which the real module only returns when AuthProvider asked for it (same-uid refresh).
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

let tokenCallback: ((user: any) => Promise<void>) | undefined;
const mockSignOut = jest.fn(async () => undefined);
jest.mock("firebase/auth", () => ({
  onIdTokenChanged: (_a: unknown, cb: any) => {
    tokenCallback = cb;
    return () => undefined;
  },
  getIdTokenResult: async () => ({ claims: {} }),
  signOut: (...args: any[]) => (mockSignOut as any)(...args),
}));
jest.mock("@/lib/firebase/client", () => ({ auth: {} }));
jest.mock("@/lib/utils/performance", () => ({ perf: { mark: () => undefined, measure: () => undefined, logMetrics: () => undefined } }));
let mockOutcome: any = { ok: true };
const mockEstablish = jest.fn(async (user: any) => (mockOutcome.ok ? { ok: true, uid: user.uid } : mockOutcome));
jest.mock("@/lib/client/sessionSync", () => ({
  establishServerSession: (...a: any[]) => (mockEstablish as any)(...a),
  clearServerSession: async () => true,
}));
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: () => undefined }));
jest.mock("posthog-js", () => ({ __esModule: true, default: { reset: () => undefined } }));

import { AuthProvider, useAuth } from "@/components/AuthProvider";

const g = globalThis as any;
const SAVED = g.window;
let latest: ReturnType<typeof useAuth>;
function Probe() {
  latest = useAuth();
  return null;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockOutcome = { ok: true };
  g.window = { localStorage: new FakeStorage(), sessionStorage: new FakeStorage() };
  act(() => {
    TestRenderer.create(createElement(AuthProvider, null, createElement(Probe)));
  });
});
afterAll(() => {
  g.window = SAVED;
});
const emit = async (u: any) => act(async () => { await tokenCallback!(u); });

describe("AuthProvider never keeps a NEW identity on auth_unavailable", () => {
  it("passes the keep flag ONLY for a same-uid refresh", async () => {
    await emit({ uid: "uid-a" });
    await emit({ uid: "uid-a" });
    await emit({ uid: "uid-b" });
    expect(mockEstablish.mock.calls.map((c: any[]) => c[1].keepSessionOnAuthUnavailable)).toEqual([false, true, false]);
  });

  it("first callback (sign-in / cold load) + auth_unavailable → signed out, never authenticated", async () => {
    mockOutcome = { ok: false, reason: "auth_unavailable" };
    await emit({ uid: "uid-a" });
    expect(latest.canMutate).toBe(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("account switch A → B + auth_unavailable → signed out, B never authenticated", async () => {
    await emit({ uid: "uid-a" });
    mockOutcome = { ok: false, reason: "auth_unavailable" };
    await emit({ uid: "uid-b" });
    expect(latest.canMutate).toBe(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("control: same-uid refresh + auth_unavailable → kept", async () => {
    await emit({ uid: "uid-a" });
    mockOutcome = { ok: false, reason: "auth_unavailable" };
    await emit({ uid: "uid-a" });
    expect(latest.syncState).toBe("authenticated");
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
