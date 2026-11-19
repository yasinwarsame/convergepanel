/**
 * R5 C (MINOR-1) — the session mint shares the per-instance cap on ABANDONED
 * verifications with resolveRequestIdentity (the same SDK, the same sockets).
 * At the cap a login fails fast with the route's existing 503 and NO upstream
 * call (neither verifyIdToken nor createSessionCookie) is started; a
 * verification abandoned by the mint counts toward the cap and is released
 * when it settles.
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
const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import * as deadlineModule from "@/lib/auth/authVerificationDeadline";
import { MAX_INFLIGHT_AUTH_VERIFICATIONS, abandonedAuthVerificationsInFlight, authVerificationRefusalsTotal } from "@/lib/auth/authVerificationDeadline";

const DEADLINE = 10_000;
const post = () =>
  POST(new NextRequest("http://localhost/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "t" }) }));

const releasers: Array<(v: unknown) => void> = [];
const hang = () => new Promise((resolve) => releasers.push(resolve));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockVerifyIdToken.mockReset();
  mockCreateSessionCookie.mockReset();
});
afterEach(async () => {
  for (const r of releasers.splice(0)) r({ uid: "late" });
  await jest.advanceTimersByTimeAsync(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  jest.useRealTimers();
});

it("logins whose verification hangs are abandoned (counted); at the cap the next login is 503 at once with no upstream call", async () => {
  mockVerifyIdToken.mockImplementation(hang);
  const pending = Array.from({ length: MAX_INFLIGHT_AUTH_VERIFICATIONS }, () => post());
  await jest.advanceTimersByTimeAsync(DEADLINE);
  for (const r of await Promise.all(pending)) expect(r.status).toBe(503);
  expect(abandonedAuthVerificationsInFlight()).toBe(MAX_INFLIGHT_AUTH_VERIFICATIONS);

  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
  mockCreateSessionCookie.mockResolvedValue("cookie");
  mockLoggerWarn.mockReset();
  const refusedBefore = authVerificationRefusalsTotal();
  const res = await post();
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "Authentication service unavailable" });
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(mockVerifyIdToken).not.toHaveBeenCalled();
  expect(mockCreateSessionCookie).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  // R6: counted (metric) and reported by the rate-limited `saturated` signal — no per-refusal warn.
  expect(authVerificationRefusalsTotal()).toBe(refusedBefore + 1);
  expect(mockLoggerWarn).not.toHaveBeenCalled();

  // The abandoned verifications settle (late VALID) → the count drains and the next login mints normally.
  for (const r of releasers.splice(0)) r({ uid: "late" });
  await jest.advanceTimersByTimeAsync(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  expect(mockCreateSessionCookie).not.toHaveBeenCalled(); // no late result ever minted
  const ok = await post();
  expect(ok.status).toBe(200);
  expect(ok.cookies.get("__session")?.value).toBe("cookie");
}, 30_000);

it("R5 review: HARD bound — 300 concurrent logins whose verification hangs INSIDE one window: verifyIdToken starts exactly 256 times; 44 answer 503 at once", async () => {
  const mod = deadlineModule as unknown as Record<string, unknown>;
  expect(mod.MAX_INFLIGHT_AUTH_VERIFICATIONS).toBe(256);
  mockVerifyIdToken.mockImplementation(hang);
  const done: Response[] = [];
  const all = Array.from({ length: 300 }, () => post().then((r) => (done.push(r), r)));
  await jest.advanceTimersByTimeAsync(0);
  expect(mockVerifyIdToken).toHaveBeenCalledTimes(256);
  expect(done).toHaveLength(44);
  for (const r of done) expect(r.status).toBe(503);
  await jest.advanceTimersByTimeAsync(DEADLINE);
  for (const r of await Promise.all(all)) expect(r.status).toBe(503);
  expect(mockCreateSessionCookie).not.toHaveBeenCalled();
}, 30_000);
