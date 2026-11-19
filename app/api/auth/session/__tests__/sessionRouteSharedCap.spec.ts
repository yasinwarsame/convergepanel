/**
 * R6 C (owner Order C) — the in-flight verification cap is ONE per-instance
 * bound shared by every auth path, and the session mint's SECOND Firebase call
 * (`createSessionCookie`) is counted toward it.
 *
 *   1. (review X7) `createSessionCookie` holds a slot from start to settle,
 *      like `verifyIdToken(…, true)`: while it is pending the in-flight count
 *      includes it, and if the cap is full when the mint reaches it, the mint
 *      answers 503 WITHOUT calling it and sets no cookie.
 *   2. The cap is shared across the session-cookie path, the bearer path
 *      (both via resolveRequestIdentity) and the session mint: filling it from
 *      any one path refuses the others before any Firebase call starts, and the
 *      refusal is never an allow (auth_unavailable / 503, no cookie).
 *   3. Recovery: slots come back only as the hung calls themselves settle;
 *      admission then resumes on every path.
 */

const mockAdminVerifyIdToken = jest.fn();
const mockCreateSessionCookie = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return {
      verifyIdToken: (...args: unknown[]) => mockAdminVerifyIdToken(...args),
      createSessionCookie: (...args: unknown[]) => mockCreateSessionCookie(...args),
      verifySessionCookie: jest.fn(),
    };
  },
}));
const mockVerifySessionCookie = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
const mockBearerVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockBearerVerifyIdToken(...args),
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
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

type Path = "cookie" | "bearer" | "mint";
const PATHS: Path[] = ["cookie", "bearer", "mint"];

/** Starts `n` requests on `path` whose Firebase verification hangs; returns their (still pending) results. */
function startHung(path: Path, n: number): Array<Promise<unknown>> {
  if (path === "mint") {
    mockAdminVerifyIdToken.mockImplementation(hang);
    return Array.from({ length: n }, () => mint());
  }
  if (path === "bearer") {
    mockBearerVerifyIdToken.mockImplementation(hang);
    return Array.from({ length: n }, (_, i) => resolveRequestIdentity(identityReq({ bearer: `hung-${i}` })));
  }
  mockVerifySessionCookie.mockImplementation((req: NextRequest) => (hasCookie(req) ? hang() : Promise.resolve(null)));
  return Array.from({ length: n }, (_, i) => resolveRequestIdentity(identityReq({ cookie: `hung-${i}` })));
}

/** Every Firebase mock answers VALID from here on, so any call that is not refused would succeed. */
function armValid(): void {
  mockAdminVerifyIdToken.mockReset();
  mockCreateSessionCookie.mockReset();
  mockVerifySessionCookie.mockReset();
  mockBearerVerifyIdToken.mockReset();
  mockAdminVerifyIdToken.mockResolvedValue({ uid: "valid-uid" });
  mockCreateSessionCookie.mockResolvedValue("valid-cookie");
  mockVerifySessionCookie.mockImplementation(async (req: NextRequest) => (hasCookie(req) ? { uid: "valid-uid" } : null));
  mockBearerVerifyIdToken.mockResolvedValue({ uid: "valid-uid" });
}

/** verifySessionCookie answers `null` locally when no cookie is presented; only a presented cookie reaches Firebase. */
function hasCookie(req: unknown): boolean {
  return Boolean((req as NextRequest).cookies.get("__session")?.value);
}

/** Calls that would reach Firebase (a cookie check without a cookie is local and not counted). */
function firebaseCalls(): number {
  return (
    mockAdminVerifyIdToken.mock.calls.length +
    mockCreateSessionCookie.mock.calls.length +
    mockVerifySessionCookie.mock.calls.filter(([req]) => hasCookie(req)).length +
    mockBearerVerifyIdToken.mock.calls.length
  );
}

/** Attempts `path` once with every Firebase mock VALID; returns whether it was refused (and asserts a refusal is never an allow). */
async function attempt(path: Path): Promise<"refused" | "admitted"> {
  const before = firebaseCalls();
  if (path === "mint") {
    const res = await mint();
    if (res.status === 503) {
      expect(await res.json()).toEqual({ error: "Authentication service unavailable" });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(firebaseCalls()).toBe(before);
      return "refused";
    }
    expect(res.status).toBe(200);
    return "admitted";
  }
  const r = await resolveRequestIdentity(identityReq(path === "bearer" ? { bearer: "fresh" } : { cookie: "fresh" }));
  if (r.status === "unauthenticated") {
    expect(r).toEqual(UNAVAILABLE);
    expect(firebaseCalls()).toBe(before);
    return "refused";
  }
  expect(r).toEqual({ status: "authenticated", uid: "valid-uid", source: path === "bearer" ? "bearer_token" : "session_cookie" });
  return "admitted";
}

beforeEach(() => {
  jest.useFakeTimers();
  mockAdminVerifyIdToken.mockReset();
  mockCreateSessionCookie.mockReset();
  mockVerifySessionCookie.mockReset();
  mockBearerVerifyIdToken.mockReset();
  mockVerifySessionCookie.mockResolvedValue(null);
});
afterEach(async () => {
  await releaseAll("late");
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(authVerificationsInFlight()).toBe(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  jest.useRealTimers();
});

describe("X7 — the mint's second Firebase call (createSessionCookie) is counted toward the cap", () => {
  it("while createSessionCookie hangs it holds one in-flight slot — before and after the deadline — until it settles", async () => {
    mockAdminVerifyIdToken.mockResolvedValue({ uid: "u1" });
    mockCreateSessionCookie.mockImplementation(hang);
    const res = mint();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateSessionCookie).toHaveBeenCalledTimes(1);
    expect(authVerificationsInFlight()).toBe(1);

    await jest.advanceTimersByTimeAsync(DEADLINE);
    const r = await res;
    expect(r.status).toBe(503);
    expect(r.headers.get("set-cookie")).toBeNull();
    // Abandoned at the deadline, still unsettled → still counted (never released early).
    expect(authVerificationsInFlight()).toBe(1);
    expect(abandonedAuthVerificationsInFlight()).toBe(1);

    await releaseAll("late-cookie");
    expect(authVerificationsInFlight()).toBe(0);
  });

  it("when the cap fills between the two calls, the mint answers 503 WITHOUT calling createSessionCookie and sets no cookie", async () => {
    // CAP − 1 bearer verifications hang; the mint's verifyIdToken takes the last slot.
    const fillers = startHung("bearer", CAP - 1);
    expect(authVerificationsInFlight()).toBe(CAP - 1);
    let filled = false;
    mockAdminVerifyIdToken.mockImplementation(async () => ({
      // Read by the route AFTER verifyIdToken has settled (its slot released) and
      // BEFORE it starts createSessionCookie: another request takes that slot here.
      get uid() {
        if (!filled) {
          filled = true;
          fillers.push(...startHung("bearer", 1));
          expect(authVerificationsInFlight()).toBe(CAP);
        }
        return "u1";
      },
    }));
    mockCreateSessionCookie.mockResolvedValue("would-be-cookie");

    const res = await mint();
    expect(filled).toBe(true);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Authentication service unavailable" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(mockCreateSessionCookie).not.toHaveBeenCalled();
    expect(authVerificationsInFlight()).toBe(CAP);

    // Recovery: one hung call settles → the next mint is admitted for BOTH calls and mints.
    releasers.shift()!({ uid: "late" });
    await jest.advanceTimersByTimeAsync(0);
    expect(authVerificationsInFlight()).toBe(CAP - 1);
    armValid();
    const ok = await mint();
    expect(ok.status).toBe(200);
    expect(ok.cookies.get("__session")?.value).toBe("valid-cookie");
    expect(mockCreateSessionCookie).toHaveBeenCalledTimes(1);
  });
});

describe("the cap is ONE bound shared by the session-cookie, bearer and session-mint paths", () => {
  for (const filler of PATHS) {
    it(`filling the cap from the ${filler} path refuses all three paths before any Firebase call; recovery resumes them`, async () => {
      const pending = startHung(filler, CAP);
      await jest.advanceTimersByTimeAsync(0);
      expect(authVerificationsInFlight()).toBe(CAP);

      armValid();
      for (const p of PATHS) expect(await attempt(p)).toBe("refused");
      expect(firebaseCalls()).toBe(0);
      expect(authVerificationsInFlight()).toBe(CAP);

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
