/**
 * R5 C (MAJOR-1) — the session mint (`POST /api/auth/session`) is bounded by
 * the SAME 10 s end-to-end verification deadline as resolveRequestIdentity.
 *
 * SESSREV made the mint call `verifyIdToken(idToken, true)`, a live Identity
 * Toolkit read. With no deadline, an upstream that accepts the connection and
 * never answers held a login ~132 s (5 SDK attempts × 25 s). The mint makes a
 * SECOND upstream call, `createSessionCookie` (Identity Toolkit
 * `:createSessionCookie`), so the ONE deadline covers both. Contract:
 *   - still pending at 10 s (either call) → the route's existing 503
 *     `{ error: "Authentication service unavailable", code: "auth_unavailable" }`, no Set-Cookie;
 *   - a verification that answers VALID after the deadline never reaches
 *     createSessionCookie, and a cookie created late is never set;
 *   - no verification cache: a token that verified once is verified again.
 * Fake timers; adminAuth is a controllable fake.
 */

const mockVerifyIdToken = jest.fn();
const mockCreateSessionCookie = jest.fn();

jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return {
      verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
      createSessionCookie: (...args: unknown[]) => mockCreateSessionCookie(...args),
      verifySessionCookie: jest.fn(),
    };
  },
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
  expect(res!.headers.get("set-cookie")).toBeNull();
  expect(res!.headers.get("Cache-Control")).toBe("no-store");
  expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
  expect(mockLogAuthSessionEvent).not.toHaveBeenCalledWith("session_sync_succeeded", expect.anything());
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockVerifyIdToken.mockReset();
  mockCreateSessionCookie.mockReset();
});
afterEach(async () => {
  for (const r of releasers.splice(0)) r();
  await jest.advanceTimersByTimeAsync(60_000);
  jest.useRealTimers();
});

it("verifyIdToken HANGS: still pending 1 ms before the deadline; 503 AT 10 s; createSessionCookie never called", async () => {
  mockVerifyIdToken.mockImplementation(never);
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(t.settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(t.settled).toBe(true);
  await expectUnavailableNoCookie(t.res);
  expect(mockVerifyIdToken).toHaveBeenCalledWith("id-token-T", true);
  expect(mockCreateSessionCookie).not.toHaveBeenCalled();
});

it("verifyIdToken answers VALID 1 ms AFTER the deadline → 503, and the late result NEVER mints a cookie", async () => {
  mockVerifyIdToken.mockImplementation(() => after(DEADLINE + 1, { uid: "late-user" }));
  mockCreateSessionCookie.mockResolvedValue("minted-cookie");
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE);
  await expectUnavailableNoCookie(t.res);
  await jest.advanceTimersByTimeAsync(5_000); // the late VALID verification lands
  expect(mockCreateSessionCookie).not.toHaveBeenCalled();
});

it("ONE end-to-end deadline: verify takes 4 s, then createSessionCookie hangs → 503 at 10 s total (not 14 s), no Set-Cookie", async () => {
  mockVerifyIdToken.mockImplementation(() => after(4_000, { uid: "u1" }));
  mockCreateSessionCookie.mockImplementation(never);
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(mockCreateSessionCookie).toHaveBeenCalledTimes(1);
  expect(t.settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await expectUnavailableNoCookie(t.res);
});

it("createSessionCookie answers a cookie AFTER the deadline → 503; the late cookie is never set", async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
  mockCreateSessionCookie.mockImplementation(() => after(DEADLINE + 1, "late-cookie"));
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE);
  await expectUnavailableNoCookie(t.res);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(t.res!.headers.get("set-cookie")).toBeNull();
});

it("in time, both calls unchanged: 200, cookie set, no timer left behind", async () => {
  mockVerifyIdToken.mockImplementation(() => after(DEADLINE - 500, { uid: "u1" }));
  mockCreateSessionCookie.mockImplementation(() => after(400, "signed-cookie"));
  const t = track(post());
  await jest.advanceTimersByTimeAsync(DEADLINE - 100);
  expect(t.res!.status).toBe(200);
  expect(await t.res!.json()).toEqual({ authenticated: true, uid: "u1" });
  expect(t.res!.cookies.get("__session")?.value).toBe("signed-cookie");
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
  expect(mockCreateSessionCookie).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("no verification cache: token T minted once, then T again whose check hangs → 503, never a second cookie", async () => {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: "u1" });
  mockCreateSessionCookie.mockResolvedValue("signed-cookie");
  expect((await post("same-T")).status).toBe(200);
  mockVerifyIdToken.mockImplementationOnce(never);
  const t = track(post("same-T"));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(t.res!.status).toBe(503);
  expect(t.res!.headers.get("set-cookie")).toBeNull();
  expect(mockVerifyIdToken).toHaveBeenCalledTimes(2);
  expect(mockCreateSessionCookie).toHaveBeenCalledTimes(1);
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
