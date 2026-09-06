/**
 * Phase FIRST-ADMIN-C2 — the CLIENT half of the administrator tier contract.
 *
 * The C2 mutation set found this hook completely untested: a mutation that
 * derived `isSystemAdmin` from mere portal access survived the entire suite.
 * That is the exact defect the tier split exists to prevent — an
 * ADMIN_EMAILS-only administrator being shown provider-credential, role-minting
 * and bulk-purge controls that the server will then refuse.
 *
 * `isSystemAdmin` must come ONLY from the verified `admin` custom claim or from
 * an explicit server-side `systemAdmin: true`. Portal access (`res.ok`, the
 * ADMIN_EMAILS allowlist, the legacy `role: "admin"` presentation string) must
 * never imply it.
 */

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

type AuthState = {
  user: { uid: string } | null;
  loading: boolean;
  authReady: boolean;
  isAdmin: boolean;
  adminResolved: boolean;
};

let authState: AuthState;
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));

const authedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => authedFetch(...(a as [])) }));

import { useAdminPortalAccess } from "@/hooks/useAdminPortalAccess";

type Observed = ReturnType<typeof useAdminPortalAccess>;

function Probe({ sink }: { sink: { current: Observed | null } }) {
  sink.current = useAdminPortalAccess();
  return null;
}

/** Renders the real hook and lets its effect (and the fetch it awaits) settle. */
async function renderHook(): Promise<Observed> {
  const sink: { current: Observed | null } = { current: null };
  await act(async () => {
    TestRenderer.create(<Probe sink={sink} />);
  });
  // The effect awaits a dynamic import() before the fetch; drain the microtask
  // queue again so the resulting state updates are applied before we assert.
  await act(async () => {
    await Promise.resolve();
  });
  return sink.current as Observed;
}

/** A `Response`-shaped stub: only `ok` and `json()` are read by the hook. */
const response = (ok: boolean, body: unknown) => ({
  ok,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

beforeEach(() => {
  authState = { user: { uid: "u1" }, loading: false, authReady: true, isAdmin: false, adminResolved: true };
  authedFetch.mockReset();
  authedFetch.mockResolvedValue(response(true, { ok: true, adminPortal: true, systemAdmin: false }));
});

describe("useAdminPortalAccess — SYSTEM_ADMIN never follows from portal access", () => {
  it("THE CORE PROOF: portal granted, systemAdmin false -> canAccess true, isSystemAdmin FALSE", async () => {
    const r = await renderHook();
    expect(r.canAccess).toBe(true);
    expect(r.isSystemAdmin).toBe(false);
  });

  it("the verified admin custom claim grants BOTH tiers without any server round trip", async () => {
    authState = { ...authState, isAdmin: true };
    const r = await renderHook();
    expect(r.canAccess).toBe(true);
    expect(r.isSystemAdmin).toBe(true);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("an explicit server systemAdmin:true is honoured", async () => {
    authedFetch.mockResolvedValue(response(true, { ok: true, adminPortal: true, systemAdmin: true }));
    const r = await renderHook();
    expect(r.canAccess).toBe(true);
    expect(r.isSystemAdmin).toBe(true);
  });

  it("systemAdmin:true on a NON-ok response grants nothing", async () => {
    authedFetch.mockResolvedValue(response(false, { ok: false, adminPortal: false, systemAdmin: true }));
    const r = await renderHook();
    expect(r.canAccess).toBe(false);
    expect(r.isSystemAdmin).toBe(false);
  });

  it.each([
    ["the legacy role presentation string", { ok: true, role: "admin" }],
    ["a truthy-but-not-true systemAdmin", { ok: true, systemAdmin: "true" }],
    ["systemAdmin: 1", { ok: true, systemAdmin: 1 }],
    ["an absent systemAdmin field", { ok: true }],
    ["a null body", null],
  ])("%s does not confer SYSTEM_ADMIN", async (_label, body) => {
    authedFetch.mockResolvedValue(response(true, body));
    const r = await renderHook();
    expect(r.canAccess).toBe(true);
    expect(r.isSystemAdmin).toBe(false);
  });

  it("an unparsable body denies SYSTEM_ADMIN without throwing", async () => {
    authedFetch.mockResolvedValue(response(true, new Error("not json")));
    const r = await renderHook();
    expect(r.canAccess).toBe(true);
    expect(r.isSystemAdmin).toBe(false);
  });

  it("a thrown fetch fails closed on both tiers", async () => {
    authedFetch.mockRejectedValue(new Error("network"));
    const r = await renderHook();
    expect(r.canAccess).toBe(false);
    expect(r.isSystemAdmin).toBe(false);
  });

  it("a signed-out visitor holds neither tier", async () => {
    authState = { ...authState, user: null };
    const r = await renderHook();
    expect(r.canAccess).toBe(false);
    expect(r.isSystemAdmin).toBe(false);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("no decision is published before the admin claim has resolved", async () => {
    authState = { ...authState, adminResolved: false };
    const r = await renderHook();
    expect(r.gateReady).toBe(false);
    expect(r.canAccess).toBe(false);
    expect(r.isSystemAdmin).toBe(false);
  });
});
