/**
 * R4o C1 — END-TO-END deadline on credential verification in
 * `resolveRequestIdentity()` (owner ruling: a ~132 s Firebase Auth wait —
 * 5 attempts × 25 s when Identity Toolkit accepts the connection and never
 * answers — is excessive).
 *
 * Contract pinned here (fake timers; the two verifiers are controllable
 * promises):
 *   - one deadline of AUTH_VERIFICATION_DEADLINE_MS (10 s) per request,
 *     covering BOTH presented credentials (they are verified concurrently);
 *   - a slot still pending at the deadline is `auth_unavailable` (503 at the
 *     wrappers that already answer 503, 401 elsewhere) — never an allow;
 *   - the decision is FINAL at the deadline: a verifier that resolves "valid"
 *     afterwards changes nothing;
 *   - a verifier that answers before the deadline is unaffected (strict
 *     dual-credential truth table unchanged);
 *   - no timer survives a request, and concurrent requests do not share a
 *     deadline.
 */

import { NextRequest } from "next/server";

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));
const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() } }));

import * as identityModule from "@/lib/auth/resolveRequestIdentity";
import { resolveRequestIdentity, type RequestIdentityResult } from "@/lib/auth/resolveRequestIdentity";

const DEADLINE = 10_000;
const UNAVAILABLE = { status: "unauthenticated", reason: "auth_unavailable" };

function req(opts: { cookie?: string; bearer?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `__session=${opts.cookie}`;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest("http://localhost/api/example", { headers });
}

/**
 * A verifier call that never answers on its own. R5: each one is RELEASED
 * (rejected) after its test, so abandoned verifications drain and the
 * per-instance in-flight verification cap never carries over between tests.
 */
const hungRejecters: Array<(e: unknown) => void> = [];
const never = () => new Promise<never>((_, reject) => hungRejecters.push(reject));
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
function rejectAfter(ms: number, code: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(code), { code })), ms));
}
function fbError(code: string) {
  return Object.assign(new Error(`Firebase: ${code}`), { code });
}

/** Starts a resolution and tracks whether / how it settled, without awaiting it. */
function track(p: Promise<RequestIdentityResult>) {
  const t: { settled: boolean; value?: RequestIdentityResult } = { settled: false };
  p.then((v) => {
    t.settled = true;
    t.value = v;
  });
  return t;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockVerifySessionCookie.mockReset();
  mockVerifyIdToken.mockReset();
  mockWarn.mockReset();
  // Default: no cookie presented.
  mockVerifySessionCookie.mockResolvedValue(null);
});
afterEach(async () => {
  for (const r of hungRejecters.splice(0)) r(Object.assign(new Error("released"), { code: "app/network-timeout" }));
  await jest.advanceTimersByTimeAsync(0);
  jest.useRealTimers();
});

describe("the deadline value", () => {
  it("is exported and is 10 s — well inside the 300 s Fluid function default and the 15 s non-Fluid Pro default", () => {
    expect((identityModule as Record<string, unknown>).AUTH_VERIFICATION_DEADLINE_MS).toBe(DEADLINE);
  });
});

describe("a hanging verifier is cut off at the deadline → auth_unavailable", () => {
  it("bearer hangs: still pending 1 ms before the deadline, auth_unavailable AT the deadline", async () => {
    mockVerifyIdToken.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(t.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual(UNAVAILABLE);
  });

  it("cookie hangs (cookie verification shares the path and the deadline)", async () => {
    mockVerifySessionCookie.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ cookie: "c" })));
    await jest.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(t.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual(UNAVAILABLE);
  });

  it("both hang: ONE end-to-end deadline (10 s), not one per credential (20 s)", async () => {
    mockVerifySessionCookie.mockImplementation(never);
    mockVerifyIdToken.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ cookie: "c", bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
  });

  it("a slow SDK retry sequence (e.g. 503 + Retry-After) that would answer at 60 s is bounded at 10 s", async () => {
    mockVerifyIdToken.mockImplementation(() => rejectAfter(60_000, "auth/internal-error"));
    const t = track(resolveRequestIdentity(req({ bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
    await jest.advanceTimersByTimeAsync(60_000); // the late rejection is absorbed, not unhandled
  });
});

describe("the decision is FINAL at the deadline: a late 'valid' never authorizes", () => {
  it("bearer resolves VALID 1 ms after the deadline → the request stays auth_unavailable", async () => {
    mockVerifyIdToken.mockImplementation(() => after(DEADLINE + 1, { uid: "attacker-wins-late" }));
    const p = resolveRequestIdentity(req({ bearer: "tok" }));
    const t = track(p);
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
    const decided = t.value;
    await jest.advanceTimersByTimeAsync(5_000); // the late valid result arrives
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toEqual(UNAVAILABLE);
    expect(t.value).toBe(decided); // same object: nothing re-decided
  });

  it("cookie resolves VALID after the deadline while the bearer was valid in time → still auth_unavailable (no partial allow)", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
    mockVerifySessionCookie.mockImplementation(() => after(DEADLINE + 50, { uid: "u1", isAdmin: false }));
    const t = track(resolveRequestIdentity(req({ cookie: "c", bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.value).toEqual(UNAVAILABLE);
  });

  it("valid cookie in time + hanging bearer → auth_unavailable (no fallback to the cookie)", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "u1", isAdmin: false });
    mockVerifyIdToken.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ cookie: "c", bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
  });

  it("valid bearer in time + hanging cookie → auth_unavailable (no fallback to the bearer)", async () => {
    mockVerifySessionCookie.mockImplementation(never);
    mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
    const t = track(resolveRequestIdentity(req({ cookie: "c", bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
  });

  it("a REVOKED cookie decided in time + hanging bearer → the cookie's own credential verdict (401), not an allow", async () => {
    mockVerifySessionCookie.mockRejectedValue(fbError("auth/session-cookie-revoked"));
    mockVerifyIdToken.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ cookie: "c", bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });
});

describe("verifications that answer before the deadline are unaffected", () => {
  it("a valid bearer at 9.999 s authenticates", async () => {
    mockVerifyIdToken.mockImplementation(() => after(DEADLINE - 1, { uid: "u1" }));
    const t = track(resolveRequestIdentity(req({ bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(t.value).toEqual({ status: "authenticated", uid: "u1", source: "bearer_token" });
  });

  it("a fast valid cookie + bearer (same uid) authenticates immediately and leaves NO timer behind", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "u1", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "u1" });
    const r = await resolveRequestIdentity(req({ cookie: "c", bearer: "tok" }));
    expect(r).toEqual({ status: "authenticated", uid: "u1", source: "matching_cookie_and_bearer" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("missing credentials still answer immediately with no timer left", async () => {
    const r = await resolveRequestIdentity(req());
    expect(r).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("an SDK outage code in time is still auth_unavailable; a credential failure in time is still 401-class", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(fbError("auth/quota-exceeded"));
    expect(await resolveRequestIdentity(req({ bearer: "tok" }))).toEqual(UNAVAILABLE);
    mockVerifyIdToken.mockRejectedValueOnce(fbError("auth/user-disabled"));
    expect(await resolveRequestIdentity(req({ bearer: "tok" }))).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("the deadline timer is cleared when a hanging request is cut off (no timer outlives the request)", async () => {
    mockVerifyIdToken.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("concurrent requests: each bounded by its OWN deadline, no shared state", () => {
  it("40 parallel requests — fast ones authenticate as their own uid at once; hanging ones fail at exactly 10 s", async () => {
    mockVerifyIdToken.mockImplementation((tok: string) => (tok.startsWith("hang-") ? never() : Promise.resolve({ uid: `uid-${tok}` })));
    const ts = Array.from({ length: 40 }, (_, i) => ({ i, t: track(resolveRequestIdentity(req({ bearer: i % 2 ? `hang-${i}` : `ok${i}` }))) }));
    await jest.advanceTimersByTimeAsync(0);
    for (const { i, t } of ts) {
      if (i % 2) expect(t.settled).toBe(false);
      else expect(t.value).toEqual({ status: "authenticated", uid: `uid-ok${i}`, source: "bearer_token" });
    }
    await jest.advanceTimersByTimeAsync(DEADLINE);
    for (const { i, t } of ts) if (i % 2) expect(t.value).toEqual(UNAVAILABLE);
    expect(jest.getTimerCount()).toBe(0);
  }, 30_000); // fake time is exact; the wall-clock allowance only absorbs a CPU-starved worker

  it("a request started 5 s later gets its own deadline (15 s), not the earlier request's (10 s)", async () => {
    mockVerifyIdToken.mockImplementation(never);
    const first = track(resolveRequestIdentity(req({ bearer: "hang-a" })));
    await jest.advanceTimersByTimeAsync(5_000);
    const second = track(resolveRequestIdentity(req({ bearer: "hang-b" })));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(first.value).toEqual(UNAVAILABLE);
    expect(second.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(second.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(second.value).toEqual(UNAVAILABLE);
  });

  it("a hanging request does not delay or poison a concurrent fast request for another user", async () => {
    mockVerifyIdToken.mockImplementation((tok: string) => (tok === "hang" ? never() : Promise.resolve({ uid: "fast-user" })));
    const slow = track(resolveRequestIdentity(req({ bearer: "hang" })));
    const fast = await resolveRequestIdentity(req({ bearer: "fast" }));
    expect(fast).toEqual({ status: "authenticated", uid: "fast-user", source: "bearer_token" });
    expect(slow.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(slow.value).toEqual(UNAVAILABLE);
  });
});

describe("R5 NITs: no result caching, a frozen deadline verdict, a distinct deadline log line", () => {
  it("a VALID result for token T is never reused: a later request with the SAME T whose check hangs is auth_unavailable", async () => {
    // There is no verification cache anywhere in this path (resolveRequestIdentity,
    // lib/firebase/auth.verifyIdToken, firebase-admin verifyIdToken caches only
    // Google's public keys). Pinned so one cannot be added silently.
    mockVerifyIdToken.mockResolvedValueOnce({ uid: "u1" });
    expect(await resolveRequestIdentity(req({ bearer: "same-T" }))).toEqual({ status: "authenticated", uid: "u1", source: "bearer_token" });
    mockVerifyIdToken.mockImplementationOnce(never);
    const t = track(resolveRequestIdentity(req({ bearer: "same-T" })));
    await jest.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(t.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual(UNAVAILABLE);
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(2);
    expect(mockVerifyIdToken).toHaveBeenNthCalledWith(2, "same-T");
  });

  it("the same for a session cookie value", async () => {
    mockVerifySessionCookie.mockResolvedValueOnce({ uid: "u1", isAdmin: false });
    expect(await resolveRequestIdentity(req({ cookie: "same-C" }))).toEqual({ status: "authenticated", uid: "u1", source: "session_cookie" });
    mockVerifySessionCookie.mockImplementationOnce(never);
    const t = track(resolveRequestIdentity(req({ cookie: "same-C" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
    expect(mockVerifySessionCookie).toHaveBeenCalledTimes(2);
  });

  it("DEADLINE_EXCEEDED (the verdict a slot becomes at the deadline) is exported frozen", () => {
    const v = (identityModule as Record<string, unknown>).DEADLINE_EXCEEDED;
    expect(v).toEqual({ present: true, ok: false, reason: "auth_unavailable" });
    expect(Object.isFrozen(v)).toBe(true);
  });

  it("a deadline cut-off logs `deadline_exceeded` (site request_identity); a FAST outage does not", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(fbError("auth/internal-error"));
    expect(await resolveRequestIdentity(req({ bearer: "tok" }))).toEqual(UNAVAILABLE);
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(mockWarn).not.toHaveBeenCalled();

    mockVerifySessionCookie.mockImplementation(never);
    mockVerifyIdToken.mockImplementation(never);
    const t = track(resolveRequestIdentity(req({ cookie: "c", bearer: "tok" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(t.value).toEqual(UNAVAILABLE);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith("[auth-verification] deadline_exceeded", expect.objectContaining({ site: "request_identity", deadlineMs: DEADLINE, abandoned: 2 }));
    // no credential material in the log line
    expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/tok|"c"|__session/);
  });
});
