/**
 * Phase FIRST-ADMIN-C11 — the limiter is actually WIRED to the dangerous route.
 *
 * Every other spec for this route mocks `checkRateLimit`, which is why nobody
 * noticed that the real implementation never throttled. This one drives the
 * REAL limiter through the REAL route against a fake Firestore and a fake
 * clock, so "3 attempts per 5 minutes" is a property of the running endpoint
 * rather than of a mock.
 */

const setCustomUserClaims = jest.fn(async () => {});
const firestoreSet = jest.fn(async () => {});
const rateLimitDocs = new Map<string, Record<string, unknown>>();

const transaction = {
  get: async (ref: { id: string }) => ({
    exists: rateLimitDocs.has(ref.id),
    data: () => rateLimitDocs.get(ref.id),
  }),
  set: (ref: { id: string }, data: Record<string, unknown>) => {
    rateLimitDocs.set(ref.id, { ...(rateLimitDocs.get(ref.id) ?? {}), ...data });
  },
};

// NOTE: `@/lib/security/rateLimit` is deliberately NOT mocked.
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...(a as [])) },
  adminDb: {
    collection: (name: string) =>
      name === "rate_limits"
        ? { doc: (id: string) => ({ id }) }
        : { doc: () => ({ set: (...a: unknown[]) => firestoreSet(...(a as [])) }) },
    runTransaction: async (fn: (t: typeof transaction) => Promise<unknown>) => fn(transaction),
  },
}));
jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromMillis: (m: number) => ({ m }) },
}));

import { NextRequest } from "next/server";

const SECRET = "correct-horse-battery-staple-0123456789";
const UID = "a-real-looking-firebase-uid-000000000001";
const T0 = 1_700_000_000_000;
let clock = T0;

const post = async (ip = "203.0.113.7") => {
  const { POST } = await import("@/app/api/admin/set-admin/route");
  return POST(new NextRequest("http://localhost/api/admin/set-admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ uid: UID, secret: SECRET }),
  }));
};

const SNAPSHOT = process.env.ADMIN_SECRET;
afterAll(() => {
  if (SNAPSHOT === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = SNAPSHOT;
});

beforeEach(() => {
  setCustomUserClaims.mockClear();
  firestoreSet.mockClear();
  rateLimitDocs.clear();
  clock = T0;
  process.env.ADMIN_SECRET = SECRET;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

describe("the bootstrap route is genuinely throttled", () => {
  it("ANCHOR: the real limiter is in play, not a mock", async () => {
    // A mocked limiter would leave the rate_limits document untouched.
    await post();
    expect(rateLimitDocs.get("set-admin:203.0.113.7")).toMatchObject({ count: 1 });
  });

  it("allows the configured number of attempts, then DENIES with 429", async () => {
    for (const ms of [0, 1_000, 2_000]) {
      clock = T0 + ms;
      expect((await post()).status).toBe(200);
    }
    clock = T0 + 3_000;
    const fourth = await post();
    expect(fourth.status).toBe(429);
    // and the throttled attempt performed no privileged work
    expect(setCustomUserClaims).toHaveBeenCalledTimes(3);
    expect(firestoreSet).toHaveBeenCalledTimes(3);
  });

  it("a throttled attempt mints nothing even with a CORRECT secret", async () => {
    for (const ms of [0, 1, 2, 3]) { clock = T0 + ms; await post(); }
    setCustomUserClaims.mockClear();
    firestoreSet.mockClear();
    clock = T0 + 4;
    expect((await post()).status).toBe(429);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(firestoreSet).not.toHaveBeenCalled();
  });

  it("after the window expires the route works again", async () => {
    for (const ms of [0, 1, 2, 3]) { clock = T0 + ms; await post(); }
    clock = T0 + 300_001;
    expect((await post()).status).toBe(200);
  });

  it("throttling is per-IP, not global", async () => {
    for (const ms of [0, 1, 2, 3]) { clock = T0 + ms; await post("203.0.113.7"); }
    clock = T0 + 4;
    expect((await post("203.0.113.7")).status).toBe(429);
    expect((await post("198.51.100.4")).status).toBe(200);
  });
});
