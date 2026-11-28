/**
 * R6 C (owner Order C) — the in-flight verification cap is ONE per-instance
 * bound shared by every auth path.
 *
 *   1. (review X7) DELETED by ZCA P3 R2: the handshake no longer makes a second
 *      (cookie-minting) Firebase call, so there is no second slot to count.
 *   2. The cap is shared across the bearer path (resolveRequestIdentity, with or
 *      without a cookie beside the bearer — the cookie is never verified, so the
 *      two are the SAME path) and the session handshake: filling it from either
 *      path refuses both before any Firebase call starts, and the refusal is
 *      never an allow (auth_unavailable / 503, only the expiry Set-Cookie).
 *   3. Recovery: slots come back only as the hung calls themselves settle;
 *      admission then resumes on every path.
 */

const mockAdminVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: require("./handshakeHarness").strictAdminAuth((...args: unknown[]) => mockAdminVerifyIdToken(...args)),
}));
const mockBearerVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockBearerVerifyIdToken(...args),
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import { expectExpiryOnly, forbiddenAdminAccess } from "./handshakeHarness";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { MAX_INFLIGHT_AUTH_VERIFICATIONS as CAP, authVerificationsInFlight, abandonedAuthVerificationsInFlight } from "@/lib/auth/authVerificationDeadline";

const DEADLINE = 10_000;
const UNAVAILABLE = { status: "unauthenticated", reason: "auth_unavailable" };

const mint = () =>
  POST(new NextRequest("http://localhost/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "t" }) }));

function identityReq(opts: { cookie?: string; bearer?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `__session=${opts.cookie}`;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest("http://localhost/api/example", { headers });
}

const releasers: Array<(v: unknown) => void> = [];
const hang = () => new Promise((resolve) => releasers.push(resolve));

async function releaseAll(value: unknown): Promise<void> {
  for (const r of releasers.splice(0)) r(value);
  await jest.advanceTimersByTimeAsync(0);
}

/**
 * ZCA L-8: a cookie ALONE is the anonymous answer, never sent upstream, so it can neither fill the cap nor be
 * refused by it. ZCA P3 R2: a cookie beside a bearer is not verified either — `cookie+bearer` is attempted to prove
 * it behaves EXACTLY as `bearer`. Filling is done from the bearer and mint paths.
 */
type Path = "cookie+bearer" | "bearer" | "mint";
const PATHS: Path[] = ["cookie+bearer", "bearer", "mint"];
const FILL_PATHS: Array<Exclude<Path, "cookie+bearer">> = ["bearer", "mint"];

/** Starts `n` requests on `path` whose Firebase verification hangs; returns their (still pending) results. */
function startHung(path: Exclude<Path, "cookie+bearer">, n: number): Array<Promise<unknown>> {
  if (path === "mint") {
    mockAdminVerifyIdToken.mockImplementation(hang);
    return Array.from({ length: n }, () => mint());
  }
  if (path === "bearer") {
    mockBearerVerifyIdToken.mockImplementation(hang);
    return Array.from({ length: n }, (_, i) => resolveRequestIdentity(identityReq({ bearer: `hung-${i}` })));
  }
  throw new Error(`unexpected fill path ${path as string}`);
}

/** Every Firebase mock answers VALID from here on, so any call that is not refused would succeed. */
function armValid(): void {
  mockAdminVerifyIdToken.mockReset();
  mockBearerVerifyIdToken.mockReset();
  mockAdminVerifyIdToken.mockResolvedValue({ uid: "valid-uid" });
  mockBearerVerifyIdToken.mockResolvedValue({ uid: "valid-uid" });
}

/** Calls that would reach Firebase (the strict Admin Auth double records any member besides verifyIdToken). */
function firebaseCalls(): number {
  return mockAdminVerifyIdToken.mock.calls.length + mockBearerVerifyIdToken.mock.calls.length + forbiddenAdminAccess.length;
}

/** Attempts `path` once with every Firebase mock VALID; returns whether it was refused (and asserts a refusal is never an allow). */
async function attempt(path: Path): Promise<"refused" | "admitted"> {
  const before = firebaseCalls();
  if (path === "mint") {
    const res = await mint();
    if (res.status === 503) {
      expect(await res.json()).toEqual({ error: "Authentication service unavailable", code: "auth_unavailable" });
      expectExpiryOnly(res);
      expect(firebaseCalls()).toBe(before);
      return "refused";
    }
    expect(res.status).toBe(200);
    expectExpiryOnly(res);
    return "admitted";
  }
  const r = await resolveRequestIdentity(identityReq(path === "bearer" ? { bearer: "fresh" } : { cookie: "fresh", bearer: "fresh" }));
  if (r.status === "unauthenticated") {
    expect(r).toEqual(UNAVAILABLE);
    expect(firebaseCalls()).toBe(before);
    return "refused";
  }
  expect(r).toEqual({ status: "authenticated", uid: "valid-uid", source: "bearer_token" });
  return "admitted";
}

beforeEach(() => {
  jest.useFakeTimers();
  mockAdminVerifyIdToken.mockReset();
  mockBearerVerifyIdToken.mockReset();
  forbiddenAdminAccess.length = 0;
});
afterEach(async () => {
  expect(forbiddenAdminAccess).toEqual([]);
  await releaseAll("late");
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(authVerificationsInFlight()).toBe(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  jest.useRealTimers();
});

// ZCA P3 R2: the X7 describe (the retired second, cookie-minting call holding a slot) was DELETED with that call.

describe("the cap is ONE bound shared by the bearer path (with or without a cookie beside it) and the session handshake", () => {
  for (const filler of FILL_PATHS) {
    it(`filling the cap from the ${filler} path refuses all three paths before any Firebase call; recovery resumes them`, async () => {
      const pending = startHung(filler, CAP);
      await jest.advanceTimersByTimeAsync(0);
      expect(authVerificationsInFlight()).toBe(CAP);

      armValid();
      for (const p of PATHS) expect(await attempt(p)).toBe("refused");
      expect(firebaseCalls()).toBe(0);
      expect(authVerificationsInFlight()).toBe(CAP);
      // ZCA L-8: a cookie-only request is the anonymous answer even at the cap — no slot, no Firebase call.
      expect(await resolveRequestIdentity(identityReq({ cookie: "fresh" }))).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
      expect(firebaseCalls()).toBe(0);

      // Still saturated after the deadline: abandoned calls are NOT released by it.
      await jest.advanceTimersByTimeAsync(DEADLINE);
      expect(authVerificationsInFlight()).toBe(CAP);
      for (const p of PATHS) expect(await attempt(p)).toBe("refused");
      expect(firebaseCalls()).toBe(0);

      // The hung calls finally settle (late VALID) → nothing they answered was used,
      // the slots return, and every path is admitted again.
      await releaseAll({ uid: "late" });
      for (const r of await Promise.all(pending)) {
        if (r instanceof Response) expect(r.status).toBe(503);
        else expect(r).toEqual(UNAVAILABLE);
      }
      expect(authVerificationsInFlight()).toBe(0);
      for (const p of PATHS) expect(await attempt(p)).toBe("admitted");
    }, 30_000);
  }
});
