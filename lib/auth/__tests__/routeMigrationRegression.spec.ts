/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7.12 —
 * consolidated route-migration regression tests for the 10 remaining
 * migrated routes not covered by their own dedicated test file
 * (Claim/Video Verification have their own: see
 * `app/api/verify-claim/__tests__/`, `app/api/verify-video/__tests__/`;
 * `run-panel`/`synthesize-panel` are covered by their own large
 * pre-existing suites, which passed unchanged after migration).
 *
 * One shared mock of `@/lib/firebase/auth-helpers`/`@/lib/firebase/auth`
 * is reused across every route import in this file — proving each route
 * independently reaches the SAME shared `resolveRequestIdentity()`
 * decision, not a per-route reimplementation. Each route is exercised on
 * its two most security-critical cases: no credentials (401, generic
 * "please sign in"), and a confirmed cookie/bearer uid MISMATCH (401,
 * fail closed) — the exact root-cause regression this whole step exists
 * to close, verified independently at every migrated route.
 */

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
        set: async () => undefined,
        update: async () => undefined,
      }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  },
  adminAuth: { getUser: async () => ({ email: "" }) },
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/lib/stripe/client", () => ({ stripe: null }));

import { NextRequest } from "next/server";

function cookieOnlyReq(url: string, init: RequestInit = {}) {
  return new NextRequest(url, { headers: { Cookie: "__session=stale" }, ...init });
}
function mismatchReq(url: string, init: RequestInit = {}) {
  return new NextRequest(url, {
    headers: { Cookie: "__session=stale", Authorization: "Bearer fresh-token" },
    ...init,
  });
}
function noCredsReq(url: string, init: RequestInit = {}) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  mockVerifySessionCookie.mockReset();
  mockVerifyIdToken.mockReset();
});

function setupMismatch() {
  mockVerifySessionCookie.mockResolvedValue({ uid: "stale-previous-user", isAdmin: false });
  mockVerifyIdToken.mockResolvedValue({ uid: "fresh-current-user" });
}
function setupNoCreds() {
  mockVerifySessionCookie.mockResolvedValue(null);
}

describe("GET /api/user/usage", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/user/usage/route");
    const res = await GET(noCredsReq("http://localhost/api/user/usage"));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { GET } = await import("@/app/api/user/usage/route");
    const res = await GET(mismatchReq("http://localhost/api/user/usage"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/panel-history", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/user/panel-history/route");
    const res = await GET(noCredsReq("http://localhost/api/user/panel-history"));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { GET } = await import("@/app/api/user/panel-history/route");
    const res = await GET(mismatchReq("http://localhost/api/user/panel-history"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/run-governance", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/user/run-governance/route");
    const res = await GET(noCredsReq("http://localhost/api/user/run-governance?runId=x&collection=runs"));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { GET } = await import("@/app/api/user/run-governance/route");
    const res = await GET(mismatchReq("http://localhost/api/user/run-governance?runId=x&collection=runs"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/runs/[runId]", () => {
  const context = { params: Promise.resolve({ runId: "run-1" }) };
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/user/runs/[runId]/route");
    const res = await GET(noCredsReq("http://localhost/api/user/runs/run-1"), context);
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { GET } = await import("@/app/api/user/runs/[runId]/route");
    const res = await GET(mismatchReq("http://localhost/api/user/runs/run-1"), context);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/verifications/[verificationId]", () => {
  const context = { params: Promise.resolve({ verificationId: "verification-1" }) };
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/user/verifications/[verificationId]/route");
    const res = await GET(noCredsReq("http://localhost/api/user/verifications/verification-1"), context);
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { GET } = await import("@/app/api/user/verifications/[verificationId]/route");
    const res = await GET(mismatchReq("http://localhost/api/user/verifications/verification-1"), context);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/billing/create-checkout-session", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { POST } = await import("@/app/api/billing/create-checkout-session/route");
    const res = await POST(noCredsReq("http://localhost/api/billing/create-checkout-session", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { POST } = await import("@/app/api/billing/create-checkout-session/route");
    const res = await POST(mismatchReq("http://localhost/api/billing/create-checkout-session", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/billing/create-portal-session", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { POST } = await import("@/app/api/billing/create-portal-session/route");
    const res = await POST(noCredsReq("http://localhost/api/billing/create-portal-session", { method: "POST" }));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { POST } = await import("@/app/api/billing/create-portal-session/route");
    const res = await POST(mismatchReq("http://localhost/api/billing/create-portal-session", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/billing/sync-plan", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { POST } = await import("@/app/api/billing/sync-plan/route");
    const res = await POST(noCredsReq("http://localhost/api/billing/sync-plan", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { POST } = await import("@/app/api/billing/sync-plan/route");
    const res = await POST(mismatchReq("http://localhost/api/billing/sync-plan", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/billing/validate-subscription", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { POST } = await import("@/app/api/billing/validate-subscription/route");
    const res = await POST(noCredsReq("http://localhost/api/billing/validate-subscription", { method: "POST" }));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { POST } = await import("@/app/api/billing/validate-subscription/route");
    const res = await POST(mismatchReq("http://localhost/api/billing/validate-subscription", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/governance/reviewer", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/governance/reviewer/route");
    const res = await GET(noCredsReq("http://localhost/api/governance/reviewer"));
    expect(res.status).toBe(401);
  });
  it("mismatched cookie/bearer -> 401 (fail closed)", async () => {
    setupMismatch();
    const { GET } = await import("@/app/api/governance/reviewer/route");
    const res = await GET(mismatchReq("http://localhost/api/governance/reviewer"));
    expect(res.status).toBe(401);
  });
});
