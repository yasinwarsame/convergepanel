/**
 * R5 C (MAJOR-1) — the session verification handshake (`POST /api/auth/session`)
 * is bounded by the SAME 10 s end-to-end verification deadline as
 * resolveRequestIdentity.
 *
 * SESSREV made it call `verifyIdToken(idToken, true)`, a live Identity Toolkit
 * read. With no deadline, an upstream that accepts the connection and never
 * answers held a login ~132 s (5 SDK attempts × 25 s). Contract:
 *   - still pending at 10 s → the route's 503
 *     `{ error: "Authentication service unavailable", code: "auth_unavailable" }`, only the expiry Set-Cookie;
 *   - a verification that answers VALID after the deadline is never used;
 *   - no verification cache: a token that verified once is verified again.
 * ZCA P3 R2: the handshake mints nothing, so the two cases about the retired
 * SECOND upstream call (cookie creation hanging / answering late) were DELETED;
 * the strict Admin Auth double records any member other than verifyIdToken.
 * Fake timers; adminAuth is a controllable fake.
 */

const mockVerifyIdToken = jest.fn();

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: require("./handshakeHarness").strictAdminAuth((...args: unknown[]) => mockVerifyIdToken(...args)),
}));
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => mockLoggerError(...a), warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), debug: jest.fn() },
}));
const mockLogAuthSessionEvent = jest.fn();
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: (...a: unknown[]) => mockLogAuthSessionEvent(...a) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import { expectExpiryOnly, forbiddenAdminAccess } from "./handshakeHarness";

const DEADLINE = 10_000;
const UNAVAILABLE_BODY = { error: "Authentication service unavailable", code: "auth_unavailable" };

const post = (idToken = "id-token-T") =>
  POST(
    new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    })
  );

const releasers: Array<() => void> = [];
const never = () => new Promise<never>((_, reject) => releasers.push(() => reject(Object.assign(new Error("released"), { code: "app/network-timeout" }))));
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function track(p: Promise<Response>) {
  const t: { settled: boolean; res?: Response } = { settled: false };
  p.then((r) => {
    t.settled = true;
    t.res = r;
  });
  return t;
}

async function expectUnavailableNoCookie(res: Response | undefined) {
  expect(res).toBeDefined();
  expect(res!.status).toBe(503);
  expect(await res!.json()).toEqual(UNAVAILABLE_BODY);
  expectExpiryOnly(res!);
  expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
  expect(mockLogAuthSessionEvent).not.toHaveBeenCalledWith("session_sync_succeeded", expect.anything());
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockVerifyIdToken.mockReset();
  forbiddenAdminAccess.length = 0;
});
afterEach(async () => {
  expect(forbiddenAdminAccess).toEqual([]); // nothing but verifyIdToken is ever touched (no minting)
  for (const r of releasers.splice(0)) r();
  await jest.advanceTimersByTimeAsync(60_000);
  jest.useRealTimers();
});

it("verifyIdToken HANGS: still pending 1 ms before the deadline; 503 AT 10 s", async () => {
  mockVerifyIdToken.mockImplementation(never);
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(t.settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(t.settled).toBe(true);
  await expectUnavailableNoCookie(t.res);
  expect(mockVerifyIdToken).toHaveBeenCalledWith("id-token-T", true);
});

it("verifyIdToken answers VALID 1 ms AFTER the deadline → 503, and the late result is never used", async () => {
  mockVerifyIdToken.mockImplementation(() => after(DEADLINE + 1, { uid: "late-user" }));
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE);
  await expectUnavailableNoCookie(t.res);
  await jest.advanceTimersByTimeAsync(5_000); // the late VALID verification lands
  expect(mockLogAuthSessionEvent).not.toHaveBeenCalledWith("session_sync_succeeded", expect.anything());
});

// ZCA P3 R2: "ONE end-to-end deadline … the second call hangs" and "the second call answers a cookie AFTER the
// deadline" were DELETED with the second call (nothing is minted).

it("in time: 200 { authenticated, uid }, only the expiry Set-Cookie, no timer left behind", async () => {
  mockVerifyIdToken.mockImplementation(() => after(DEADLINE - 500, { uid: "u1" }));
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE - 400);
  expect(t.res!.status).toBe(200);
  expect(await t.res!.json()).toEqual({ authenticated: true, uid: "u1" });
  expectExpiryOnly(t.res!);
  expect(jest.getTimerCount()).toBe(0);
});

it("in time, a credential failure keeps its 401 and an outage code its 503 (classification unchanged), no timer left", async () => {
  mockVerifyIdToken.mockRejectedValueOnce(Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" }));
  const r1 = await post();
  expect(r1.status).toBe(401);
  expect(await r1.json()).toEqual({ error: "Invalid or expired token" });
  mockVerifyIdToken.mockRejectedValueOnce(Object.assign(new Error("net"), { code: "app/network-error" }));
  const r2 = await post();
  expect(r2.status).toBe(503);
  expect(await r2.json()).toEqual(UNAVAILABLE_BODY);
  expect(jest.getTimerCount()).toBe(0);
});

it("no verification cache: token T verified once, then T again whose check hangs → 503", async () => {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: "u1" });
  expect((await post("same-T")).status).toBe(200);
  mockVerifyIdToken.mockImplementationOnce(never);
  const t = track(post("same-T"));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(t.res!.status).toBe(503);
  expectExpiryOnly(t.res!);
  expect(mockVerifyIdToken).toHaveBeenCalledTimes(2);
});

it("the deadline 503 logs the cut-off distinctly from a fast outage, with no token in any log line", async () => {
  mockVerifyIdToken.mockImplementation(never);
  const t = track(post("secret-id-token"));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(t.res!.status).toBe(503);
  expect(mockLoggerWarn).toHaveBeenCalledWith("[auth-verification] deadline_exceeded", expect.objectContaining({ site: "session_mint", deadlineMs: DEADLINE, abandoned: 1 }));
  const logged = JSON.stringify([mockLoggerWarn.mock.calls, mockLoggerError.mock.calls]);
  expect(logged).not.toContain("secret-id-token");
});
