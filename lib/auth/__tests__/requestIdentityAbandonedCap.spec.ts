/**
 * R5 C (MINOR-1) — `resolveRequestIdentity` under the per-instance cap on
 * ABANDONED verifications. When the instance already holds
 * MAX_ABANDONED_AUTH_VERIFICATIONS verifications that were cut off at the
 * deadline and are still unsettled, a request that PRESENTS a credential
 * fails fast with `auth_unavailable` (the same 503 / 401 path as the deadline)
 * and no new upstream verification is started. A request with no credential
 * is unaffected (no upstream call is possible), and the instance recovers as
 * soon as abandoned calls settle.
 */

import { NextRequest } from "next/server";

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();
const mockWarn = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() } }));

import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import * as deadlineModule from "@/lib/auth/authVerificationDeadline";
import { MAX_ABANDONED_AUTH_VERIFICATIONS, abandonedAuthVerificationsInFlight } from "@/lib/auth/authVerificationDeadline";

const DEADLINE = 10_000;
const UNAVAILABLE = { status: "unauthenticated", reason: "auth_unavailable" };

function req(opts: { cookie?: string; bearer?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `__session=${opts.cookie}`;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest("http://localhost/api/example", { headers });
}

const releasers: Array<(v: unknown) => void> = [];
const hang = () => new Promise((resolve) => releasers.push(resolve));

/** Real requests whose bearer check hangs past the deadline fill the cap (one abandoned verification each). */
async function fillCapWithHungRequests(): Promise<void> {
  mockVerifyIdToken.mockImplementation(hang);
  const n = MAX_ABANDONED_AUTH_VERIFICATIONS - abandonedAuthVerificationsInFlight();
  const pending = Array.from({ length: n }, (_, i) => resolveRequestIdentity(req({ bearer: `hang-${i}` })));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  for (const r of await Promise.all(pending)) expect(r).toEqual(UNAVAILABLE);
  expect(abandonedAuthVerificationsInFlight()).toBe(MAX_ABANDONED_AUTH_VERIFICATIONS);
  mockVerifyIdToken.mockReset();
  mockVerifySessionCookie.mockReset();
  mockWarn.mockReset();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockVerifySessionCookie.mockReset();
  mockVerifyIdToken.mockReset();
  mockWarn.mockReset();
  mockVerifySessionCookie.mockResolvedValue(null);
});
afterEach(async () => {
  for (const r of releasers.splice(0)) r({ uid: "late" });
  await jest.advanceTimersByTimeAsync(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  jest.useRealTimers();
});

it("at the cap, a bearer request fails fast (no deadline wait) and the verifier is NEVER called", async () => {
  await fillCapWithHungRequests();
  mockVerifyIdToken.mockResolvedValue({ uid: "would-be-valid" });
  const r = await resolveRequestIdentity(req({ bearer: "fresh" }));
  expect(r).toEqual(UNAVAILABLE);
  expect(mockVerifyIdToken).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  expect(mockWarn).toHaveBeenCalledWith("[auth-verification] abandoned_cap_refused", {
    site: "request_identity",
    abandonedInFlight: MAX_ABANDONED_AUTH_VERIFICATIONS,
    cap: MAX_ABANDONED_AUTH_VERIFICATIONS,
  });
  expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("fresh");
});

it("at the cap, a cookie request fails fast and the cookie verifier is NEVER called", async () => {
  await fillCapWithHungRequests();
  mockVerifySessionCookie.mockResolvedValue({ uid: "would-be-valid", isAdmin: false });
  expect(await resolveRequestIdentity(req({ cookie: "c" }))).toEqual(UNAVAILABLE);
  expect(mockVerifySessionCookie).not.toHaveBeenCalled();
});

it("at the cap, cookie + bearer fails fast with no verifier call and no fallback to either credential", async () => {
  await fillCapWithHungRequests();
  mockVerifySessionCookie.mockResolvedValue({ uid: "u1", isAdmin: false });
  mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
  expect(await resolveRequestIdentity(req({ cookie: "c", bearer: "t" }))).toEqual(UNAVAILABLE);
  expect(mockVerifySessionCookie).not.toHaveBeenCalled();
  expect(mockVerifyIdToken).not.toHaveBeenCalled();
});

it("at the cap, a request with NO credential still answers missing_credentials (no upstream call is possible)", async () => {
  await fillCapWithHungRequests();
  expect(await resolveRequestIdentity(req())).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
  expect(mockWarn).not.toHaveBeenCalled();
});

it("at the cap, a malformed Authorization header is still a credential failure, not an outage (no upstream call)", async () => {
  await fillCapWithHungRequests();
  const r = await resolveRequestIdentity(new NextRequest("http://localhost/api/x", { headers: { authorization: "Basic abc" } }));
  expect(r).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
});

it("recovers when abandoned verifications settle (no latch)", async () => {
  await fillCapWithHungRequests();
  const settled = releasers.splice(0);
  for (const r of settled) r(undefined);
  await jest.advanceTimersByTimeAsync(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
  expect(await resolveRequestIdentity(req({ bearer: "t" }))).toEqual({ status: "authenticated", uid: "u1", source: "bearer_token" });
});

it("below the cap nothing changes: a hung check still waits the full deadline (the cap is not a timeout)", async () => {
  mockVerifyIdToken.mockImplementation(hang);
  let settled = false;
  void resolveRequestIdentity(req({ bearer: "h" })).then(() => (settled = true));
  await jest.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(abandonedAuthVerificationsInFlight()).toBe(1);
});

it("R5 review: HARD bound — 400 concurrent requests whose bearer check hangs, all INSIDE one window: the verifier starts exactly 256 times; the rest fail at once", async () => {
  const mod = deadlineModule as unknown as Record<string, unknown>;
  const cap = mod.MAX_INFLIGHT_AUTH_VERIFICATIONS as number;
  expect(cap).toBe(256);
  mockVerifyIdToken.mockImplementation(hang);
  const settled: Array<{ done: boolean; v?: unknown }> = [];
  for (let i = 0; i < 400; i++) {
    const t: { done: boolean; v?: unknown } = { done: false };
    void resolveRequestIdentity(req({ bearer: `h${i}` })).then((v) => { t.done = true; t.v = v; });
    settled.push(t);
  }
  await jest.advanceTimersByTimeAsync(0);
  expect(mockVerifyIdToken).toHaveBeenCalledTimes(256);
  expect((mod.authVerificationsInFlight as () => number)()).toBe(256);
  // the 144 refused requests answered immediately (no deadline wait)
  const early = settled.filter((t) => t.done);
  expect(early).toHaveLength(144);
  for (const t of early) expect(t.v).toEqual(UNAVAILABLE);
  await jest.advanceTimersByTimeAsync(DEADLINE);
  for (const t of settled) expect(t.v).toEqual(UNAVAILABLE);
}, 30_000);
