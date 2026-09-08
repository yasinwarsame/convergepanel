/**
 * Phase FIRST-ADMIN-C11 — THE RATE LIMITER, TESTED DIRECTLY FOR THE FIRST TIME.
 *
 * `lib/security/rateLimit.ts` had NO direct tests. Every one of its 15 call
 * sites mocks it, so nothing ever drove the window arithmetic — and the
 * arithmetic was wrong:
 *
 *     windowStart: lastReset - config.windowSeconds * 1000
 *
 * On a fresh window `lastReset === now`, so the stored window start was written
 * already one whole window in the past. The read side then asks
 * `windowStartTime >= now - windowMs`, which holds only when the next request
 * lands in the SAME MILLISECOND. Every request more than 1ms later took the
 * "window expired" branch, reset the count to 0, and was allowed.
 *
 * The counter therefore never exceeded 1 against any limit. `/api/admin/set-admin`
 * — unauthenticated, mints full SYSTEM_ADMIN on any uid, no audit record, no
 * success log — was documented as protected by "3 attempts per 5 minutes per
 * IP". It was not throttled at all.
 */

const docs = new Map<string, Record<string, unknown>>();
let firestoreAvailable = true;
let throwOnTransaction = false;

const makeRef = (id: string) => ({ id });
const transaction = {
  get: async (ref: { id: string }) => ({
    exists: docs.has(ref.id),
    data: () => docs.get(ref.id),
  }),
  set: (ref: { id: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    docs.set(ref.id, opts?.merge ? { ...(docs.get(ref.id) ?? {}), ...data } : data);
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    if (!firestoreAvailable) return null;
    return {
      collection: () => ({ doc: (id: string) => makeRef(id) }),
      runTransaction: async (fn: (t: typeof transaction) => Promise<unknown>) => {
        if (throwOnTransaction) throw new Error("firestore unavailable");
        return fn(transaction);
      },
    };
  },
}));
jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromMillis: (m: number) => ({ m }) },
}));

import { checkRateLimit } from "../rateLimit";

const T0 = 1_700_000_000_000;
let clock = T0;
beforeEach(() => {
  docs.clear();
  firestoreAvailable = true;
  throwOnTransaction = false;
  clock = T0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

/** The bootstrap route's real configuration. */
const CFG = { maxRequests: 3, windowSeconds: 300, identifier: "set-admin:203.0.113.7" };
const at = (ms: number, cfg = CFG) => { clock = T0 + ms; return checkRateLimit(cfg); };

describe("window accounting", () => {
  it("ANCHOR: the fake Firestore really persists what the limiter writes", async () => {
    // Without this, every "count persists" assertion below could pass against a
    // store that silently dropped writes.
    await at(0);
    expect(docs.get(CFG.identifier)).toMatchObject({ count: 1 });
    expect(typeof docs.get(CFG.identifier)!.windowStart).toBe("number");
  });

  it("allows the first attempt", async () => {
    expect(await at(0)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("allows attempts up to the configured limit", async () => {
    expect((await at(0)).allowed).toBe(true);
    expect((await at(1_000)).allowed).toBe(true);
    expect((await at(2_000)).allowed).toBe(true);
  });

  it("DENIES the attempt after the limit, inside the window", async () => {
    /**
     * THE REGRESSION. Against the pre-C11 arithmetic this returned allowed:true
     * with count 1, because each request more than 1ms after the last reset the
     * window.
     */
    await at(0); await at(1_000); await at(2_000);
    const fourth = await at(3_000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfter).toBeGreaterThan(0);
  });

  it("counts persist across requests within the window", async () => {
    await at(0); await at(30_000); await at(60_000);
    expect(docs.get(CFG.identifier)).toMatchObject({ count: 3 });
  });

  it("rapid successive requests do not reset the window", async () => {
    // Spread across the window at wide intervals — the exact shape the old
    // arithmetic mishandled, since only same-millisecond calls accumulated.
    await at(0); await at(100_000); await at(200_000);
    expect((await at(250_000)).allowed).toBe(false);
  });

  it("still denies deep inside the window", async () => {
    await at(0); await at(1); await at(2);
    expect((await at(299_000)).allowed).toBe(false);
  });
});

describe("window boundary", () => {
  it("just BEFORE expiry the window is still in force", async () => {
    await at(0); await at(1); await at(2);
    expect((await at(299_999)).allowed).toBe(false);
  });

  it("AFTER expiry a new window starts with a fresh count", async () => {
    await at(0); await at(1); await at(2);
    expect((await at(300_001)).allowed).toBe(true);
    expect(docs.get(CFG.identifier)).toMatchObject({ count: 1 });
  });

  it("the new window is itself enforced", async () => {
    await at(0); await at(1); await at(2);
    await at(300_001); await at(300_002); await at(300_003);
    expect((await at(300_004)).allowed).toBe(false);
  });
});

describe("key isolation", () => {
  it("a different identifier has an independent budget", async () => {
    await at(0); await at(1); await at(2);
    expect((await at(3)).allowed).toBe(false);
    const other = { ...CFG, identifier: "set-admin:198.51.100.4" };
    expect((await at(4, other)).allowed).toBe(true);
  });

  it("exhausting one key does not affect the other", async () => {
    const other = { ...CFG, identifier: "set-admin:198.51.100.4" };
    for (const ms of [0, 1, 2, 3]) await at(ms);
    expect((await at(5, other)).allowed).toBe(true);
    expect((await at(6, other)).allowed).toBe(true);
  });
});

describe("failure behaviour is FAIL-CLOSED", () => {
  it("denies when Firestore is unavailable", async () => {
    firestoreAvailable = false;
    expect(await at(0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("denies when the transaction throws", async () => {
    throwOnTransaction = true;
    expect(await at(0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("treats corrupted stored state as a fresh window rather than crashing", async () => {
    docs.set(CFG.identifier, { count: "not-a-number", windowStart: "nonsense" });
    const res = await at(0);
    expect(res.allowed).toBe(true);
    expect(docs.get(CFG.identifier)).toMatchObject({ count: 1 });
  });

  it("a stored count at the limit with a live window still denies", async () => {
    docs.set(CFG.identifier, { count: 3, windowStart: T0 });
    expect((await at(1_000)).allowed).toBe(false);
  });
});
