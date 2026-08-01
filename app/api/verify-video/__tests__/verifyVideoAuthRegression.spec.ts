/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7.7/7.12 —
 * auth-only regression tests for the protected Video Verification route.
 * No pre-existing test suite covered this route before this step (a
 * pre-existing gap disclosed in the Step 7 inventory, not created by this
 * migration). Scoped to the AUTH BOUNDARY only, mirroring
 * `app/api/verify-claim/__tests__/verifyClaimAuthRegression.spec.ts` —
 * `checkRateLimit` (receiving `verify-video:${uid}`) is the observable
 * seam proving the gate was passed with the correct uid, without mocking
 * the video upload/vision-model pipeline itself, which remains completely
 * untouched by this migration (confirmed separately via `git diff`).
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
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }) },
  adminAuth: {},
}));

const mockCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/verify-video/route";

function buildRequest(opts: { cookie?: string; authHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
  if (opts.authHeader !== undefined) headers.Authorization = opts.authHeader;
  return new NextRequest("http://localhost/api/verify-video", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

beforeEach(() => {
  mockVerifySessionCookie.mockReset();
  mockVerifyIdToken.mockReset();
  mockCheckRateLimit.mockReset();
  mockLoggerWarn.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfter: 60 });
});

describe("POST /api/verify-video — auth boundary", () => {
  it("no credentials -> 401, business logic never reached", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const res = await POST(buildRequest());
    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("valid cookie only -> passes auth gate, business logic reached with correct uid", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    const res = await POST(buildRequest({ cookie: "__session=valid" }));
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: "verify-video:user-a" }));
  });

  it("valid bearer only -> passes auth gate, business logic reached with correct uid", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const res = await POST(buildRequest({ authHeader: "Bearer valid-token" }));
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: "verify-video:user-b" }));
  });

  it("matching valid cookie + bearer -> passes auth gate", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    const res = await POST(buildRequest({ cookie: "__session=valid", authHeader: "Bearer valid-token" }));
    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: "verify-video:user-a" }));
  });

  it("REGRESSION (root cause): mismatched valid cookie + bearer -> 401, business logic never reached", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "stale-previous-user", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "fresh-current-user" });
    const res = await POST(buildRequest({ cookie: "__session=stale", authHeader: "Bearer fresh-token" }));
    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("invalid cookie only -> 401, business logic never reached", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("malformed cookie"));
    const res = await POST(buildRequest({ cookie: "__session=garbage" }));
    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("invalid bearer only -> 401, business logic never reached", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockRejectedValue(new Error("malformed token"));
    const res = await POST(buildRequest({ authHeader: "Bearer garbage" }));
    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("auth failure response never leaks a raw verification error", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("internal Firebase Admin SDK detail that must never reach the client"));
    const res = await POST(buildRequest({ cookie: "__session=garbage" }));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/internal Firebase Admin SDK detail/);
    expect(body).toEqual({ ok: false, error: { code: "unauthorized", message: "Please sign in to verify a video." } });
  });
});
