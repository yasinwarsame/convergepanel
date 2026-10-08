/**
 * Step 6.0b — governance policy READ authority.
 *
 * GET returns the full policy only to a verified Governance Admin or a caller
 * whose CURRENT effective plan is `full`. Both are derived server-side from the
 * caller's uid. Free and Lite callers get 403 and never reach
 * `loadGovernancePolicy()`. POST stays Governance Admin only.
 *
 * The REAL `authCheck` and `verifiedAdminIdentity` modules run: only the request
 * identity, the live Auth record, the entitlement lookup and the policy store
 * are faked.
 */

const GOV_ADMIN_EMAIL = "gov-admin@test-invented.example";
const __ENV = process.env.GOVERNANCE_ADMIN_EMAILS;
process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ADMIN_EMAIL;
afterAll(() => {
  if (__ENV === undefined) delete process.env.GOVERNANCE_ADMIN_EMAILS;
  else process.env.GOVERNANCE_ADMIN_EMAILS = __ENV;
});

const CALLER = "caller-uid";
let identity: { status: "authenticated"; uid: string } | { status: "unauthenticated"; reason: string } = { status: "authenticated", uid: CALLER };
let authRecord: { email: string; emailVerified: boolean; disabled: boolean } = { email: "user@test-invented.example", emailVerified: true, disabled: false };
let planId: "free" | "lite" | "full" | "THROW" = "free";

const entitlementCalls: string[] = [];
const loadPolicy = jest.fn(async () => ({ policyVersion: 7, minConsensusToApprove: 80 }));
const savePolicy = jest.fn(async () => ({ policyVersion: 8, minConsensusToApprove: 85 }));

jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => identity }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: () => undefined }));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {},
  adminAuth: { getUser: async () => authRecord },
}));
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async (uid: string) => {
    entitlementCalls.push(uid);
    if (planId === "THROW") throw new Error("firestore down");
    return { planId };
  },
}));
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: () => loadPolicy(),
  saveGovernancePolicyMerge: (...a: unknown[]) => savePolicy(...(a as [])),
}));
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: async () => undefined }));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/governance/policy/route";

const URL_ = "https://app.test/api/governance/policy";
const get = (init: { headers?: Record<string, string>; query?: string } = {}) =>
  GET(new NextRequest(`${URL_}${init.query ?? ""}`, { method: "GET", headers: init.headers }));
const post = (body: unknown) =>
  POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  identity = { status: "authenticated", uid: CALLER };
  authRecord = { email: "user@test-invented.example", emailVerified: true, disabled: false };
  planId = "free";
  entitlementCalls.length = 0;
  loadPolicy.mockClear();
  savePolicy.mockClear();
});

describe("GET — denied callers never reach loadGovernancePolicy()", () => {
  it.each(["free", "lite"] as const)("authenticated %s caller -> 403, policy not loaded", async (plan) => {
    planId = plan;
    const res = await get();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.policy).toBeUndefined();
    expect(loadPolicy).not.toHaveBeenCalled();
    // The plan was actually consulted for THIS caller, so the 403 is the plan rule.
    expect(entitlementCalls).toEqual([CALLER]);
  });

  it("request-supplied eligibility, plan or identity hints change nothing for a Free caller", async () => {
    const res = await get({
      headers: { "x-governance-dashboard-eligible": "true", "x-plan-id": "full", "x-uid": "someone-else", "x-role": "admin" },
      query: "?governanceDashboardEligible=true&planId=full&uid=someone-else&role=admin",
    });
    expect(res.status).toBe(403);
    expect(loadPolicy).not.toHaveBeenCalled();
    expect(entitlementCalls).toEqual([CALLER]);
  });

  it("an allowlisted but UNVERIFIED email on a Free plan is not a Governance Admin -> 403", async () => {
    authRecord = { email: GOV_ADMIN_EMAIL, emailVerified: false, disabled: false };
    const res = await get();
    expect(res.status).toBe(403);
    expect(loadPolicy).not.toHaveBeenCalled();
  });

  it("an entitlement lookup failure fails closed with 503", async () => {
    planId = "THROW";
    const res = await get();
    expect(res.status).toBe(503);
    expect(loadPolicy).not.toHaveBeenCalled();
  });

  it("unauthenticated -> 401, no plan lookup, policy not loaded", async () => {
    identity = { status: "unauthenticated", reason: "missing_credentials" };
    const res = await get();
    expect(res.status).toBe(401);
    expect(entitlementCalls).toEqual([]);
    expect(loadPolicy).not.toHaveBeenCalled();
  });
});

describe("GET — permitted callers receive the full policy", () => {
  it("a Full-plan caller -> 200 with the loaded policy", async () => {
    planId = "full";
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, policy: { policyVersion: 7, minConsensusToApprove: 80 } });
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(entitlementCalls).toEqual([CALLER]);
  });

  it("a verified Governance Admin on a Free plan -> 200 without needing the plan", async () => {
    authRecord = { email: GOV_ADMIN_EMAIL, emailVerified: true, disabled: false };
    const res = await get();
    expect(res.status).toBe(200);
    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(entitlementCalls).toEqual([]);
  });
});

describe("POST — Governance Admin only (unchanged)", () => {
  it("a Full-plan non-admin is refused 403 and nothing is saved", async () => {
    planId = "full";
    const res = await post({ minConsensusToApprove: 85 });
    expect(res.status).toBe(403);
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("a verified Governance Admin can save", async () => {
    authRecord = { email: GOV_ADMIN_EMAIL, emailVerified: true, disabled: false };
    const res = await post({ minConsensusToApprove: 85 });
    expect(res.status).toBe(200);
    expect(savePolicy).toHaveBeenCalledTimes(1);
  });
});
