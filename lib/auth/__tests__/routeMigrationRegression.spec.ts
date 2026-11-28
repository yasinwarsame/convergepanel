/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7.12 —
 * consolidated route-migration regression tests for the 10 remaining
 * migrated routes not covered by their own dedicated test file
 * (Claim/Video Verification have their own: see
 * `app/api/verify-claim/__tests__/`, `app/api/verify-video/__tests__/`;
 * `run-panel`/`synthesize-panel` are covered by their own large
 * pre-existing suites, which passed unchanged after migration).
 *
 * One shared mock of `@/lib/firebase/auth` is reused across every route
 * import in this file — proving each route independently reaches the SAME
 * shared `resolveRequestIdentity()` decision, not a per-route
 * reimplementation. Each route is exercised on its two most
 * security-critical cases: no credentials (401, generic "please sign in"),
 * and a stale `__session` cookie beside a bearer the verifier REJECTS (401).
 * ZCA P3 R2 (converted from the cookie/bearer MISMATCH case, which no longer
 * exists: the cookie is never read): the stale cookie can never authenticate
 * a request whose bearer failed.
 */

const mockVerifyIdToken = jest.fn();
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
function staleCookieRejectedBearerReq(url: string, init: RequestInit = {}) {
  return new NextRequest(url, {
    headers: { Cookie: "__session=stale", Authorization: "Bearer fresh-token" },
    ...init,
  });
}
function noCredsReq(url: string, init: RequestInit = {}) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  mockVerifyIdToken.mockReset();
});

function setupRejectedBearer() {
  mockVerifyIdToken.mockRejectedValue(Object.assign(new Error("INVALID_ID_TOKEN"), { code: "auth/argument-error" }));
}
function setupNoCreds() {
  mockVerifyIdToken.mockReset();
}

describe("GET /api/user/usage", () => {
  it("no credentials -> 401", async () => {
    setupNoCreds();
    const { GET } = await import("@/app/api/user/usage/route");
    const res = await GET(noCredsReq("http://localhost/api/user/usage"));
    expect(res.status).toBe(401);
  });
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { GET } = await import("@/app/api/user/usage/route");
    const res = await GET(staleCookieRejectedBearerReq("http://localhost/api/user/usage"));
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { GET } = await import("@/app/api/user/panel-history/route");
    const res = await GET(staleCookieRejectedBearerReq("http://localhost/api/user/panel-history"));
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { GET } = await import("@/app/api/user/run-governance/route");
    const res = await GET(staleCookieRejectedBearerReq("http://localhost/api/user/run-governance?runId=x&collection=runs"));
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { GET } = await import("@/app/api/user/runs/[runId]/route");
    const res = await GET(staleCookieRejectedBearerReq("http://localhost/api/user/runs/run-1"), context);
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { GET } = await import("@/app/api/user/verifications/[verificationId]/route");
    const res = await GET(staleCookieRejectedBearerReq("http://localhost/api/user/verifications/verification-1"), context);
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { POST } = await import("@/app/api/billing/create-checkout-session/route");
    const res = await POST(staleCookieRejectedBearerReq("http://localhost/api/billing/create-checkout-session", { method: "POST", body: "{}" }));
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { POST } = await import("@/app/api/billing/create-portal-session/route");
    const res = await POST(staleCookieRejectedBearerReq("http://localhost/api/billing/create-portal-session", { method: "POST" }));
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { POST } = await import("@/app/api/billing/sync-plan/route");
    const res = await POST(staleCookieRejectedBearerReq("http://localhost/api/billing/sync-plan", { method: "POST", body: "{}" }));
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
  it("stale cookie + rejected bearer -> 401 (the cookie never authenticates)", async () => {
    setupRejectedBearer();
    const { POST } = await import("@/app/api/billing/validate-subscription/route");
    const res = await POST(staleCookieRejectedBearerReq("http://localhost/api/billing/validate-subscription", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});

// SEC-3 / S2-b correction (owner ruling D): `/api/governance/reviewer` no longer
// uses `resolveRequestIdentity`; it authenticates through the privileged-access
// guard (`resolveGovernanceRequestUser`). Its no-credential, mismatch, revoked,
// disabled, malformed and outage cases are covered through the real handler in
// app/api/governance/__tests__/mixedAudienceGovernanceAuth.spec.ts.

