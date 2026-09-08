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

/**
 * Phase FIRST-ADMIN-C13 (R9 P1). The previous double was `doc: (id) => ({id})`
 * — it could not throw, so the block titled "never a throw" never exercised a
 * throw, and moving `.doc()` back outside the try left the suite green.
 *
 * This identifier PASSES `isValidRateLimitIdentifier` (no slash, non-empty,
 * short) and still makes reference construction fail. That separates two
 * different properties which must not substitute for each other:
 *   1. the validator rejects known-unsafe identifiers;
 *   2. the error boundary catches datastore failures for a LOCALLY VALID one.
 */
const DOC_REF_CANARY = "set-admin:203.0.113.99";
const makeRef = (id: string) => {
  if (id === DOC_REF_CANARY) throw new Error("DOC_REF_CONSTRUCTION_FAILURE");
  return { id };
};
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

import { checkRateLimit, isValidRateLimitIdentifier } from "../rateLimit";

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

describe("failure behaviour", () => {
  /**
   * Phase FIRST-ADMIN-C12 (R8 P2-1). This block was titled "FAIL-CLOSED" and
   * contained a case that grants a FRESH BUDGET. Storage failure is genuinely
   * fail-closed; malformed server-owned state is a reset, which is a different
   * thing, and filing it under a fail-closed heading would let a future reader
   * stop thinking. The behaviour is unchanged; only the claim is corrected.
   */
  it("denies when Firestore is unavailable", async () => {
    firestoreAvailable = false;
    expect(await at(0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("denies when the transaction throws", async () => {
    throwOnTransaction = true;
    expect(await at(0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("MALFORMED SERVER-OWNED STATE RESETS TO A FRESH WINDOW (this is NOT fail-closed)", async () => {
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

describe("MALFORMED IDENTIFIER — fail-closed, and never a throw", () => {
  /**
   * Phase FIRST-ADMIN-C12 (R8). `.doc()` used to be called outside the try, so
   * an identifier containing `/` threw past this module's never-throws
   * contract. Two call sites derive the identifier from a request header and
   * six have no try/catch of their own, so that throw would have surfaced as an
   * unhandled rejection on a protected route.
   */
  it.each([
    ["a slash-containing identifier", "set-admin:a/b"],
    ["a nested path", "set-admin:a/b/c"],
    ["an empty identifier", ""],
    ["a dot", "."],
    ["a double dot", ".."],
    ["a reserved __name__ form", "__id__"],
    ["an over-long identifier", "x".repeat(1501)],
  ])("%s is denied without throwing", async (_label, identifier) => {
    const res = await checkRateLimit({ ...CFG, identifier });
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    // and nothing was written under an attacker-chosen path
    expect(docs.size).toBe(0);
  });

  it("ANCHOR: ordinary namespaced identifiers still work unchanged", async () => {
    // Without this, "everything is denied" would satisfy the rows above.
    for (const identifier of ["set-admin:203.0.113.7", "run-panel:abc123", "team-run-create:XYZ-987"]) {
      docs.clear();
      const res = await checkRateLimit({ ...CFG, identifier });
      expect(res.allowed).toBe(true);
      expect(docs.get(identifier)).toMatchObject({ count: 1 });
    }
  });

  it("the validator itself accepts real keys and rejects path-bearing ones", () => {
    expect(isValidRateLimitIdentifier("set-admin:203.0.113.7")).toBe(true);
    expect(isValidRateLimitIdentifier("a/b")).toBe(false);
    expect(isValidRateLimitIdentifier("")).toBe(false);
    expect(isValidRateLimitIdentifier(undefined)).toBe(false);
  });
});

describe("retryAfter and resetAt reach real response headers, so they are pinned", () => {
  /**
   * Phase FIRST-ADMIN-C12 (R8 P2-2/P2-3). Both survived mutation: seconds→ms
   * and a request-relative resetAt. run-panel, synthesize-panel and the team
   * run route emit these as `Retry-After` (HTTP seconds) and
   * `X-RateLimit-Reset` (epoch seconds).
   */
  const exhaust = async () => { for (const ms of [0, 1, 2]) await at(ms); };

  it("retryAfter is SECONDS remaining in the window, not milliseconds", async () => {
    await exhaust();
    const denied = await at(100_000);
    expect(denied.allowed).toBe(false);
    // 300s window, 100s elapsed -> 200s left. In ms this would be 200000.
    expect(denied.retryAfter).toBe(200);
  });

  it("retryAfter is never zero or negative", async () => {
    await exhaust();
    expect((await at(299_999)).retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("resetAt is the real window end and does NOT slide per denied request", async () => {
    await exhaust();
    const a = await at(10_000);
    const b = await at(200_000);
    expect(a.resetAt.getTime()).toBe(T0 + 300_000);
    expect(b.resetAt.getTime()).toBe(T0 + 300_000);   // identical, not request-relative
  });

  it("an allowed request also reports the true window end", async () => {
    await at(0);
    const second = await at(50_000);
    expect(second.allowed).toBe(true);
    expect(second.resetAt.getTime()).toBe(T0 + 300_000);
    expect(second.retryAfter).toBeUndefined();
  });
});

describe("DOCUMENT-REFERENCE BOUNDARY — construction failure is caught, never thrown", () => {
  /**
   * `.doc()` must be constructed INSIDE the protected try. Firestore rejects an
   * even-component path, so a `/`-bearing identifier used to throw straight
   * past this module's documented never-throws contract — and six of the
   * fifteen call sites have no try/catch of their own, including on the
   * unauthenticated route that mints SYSTEM_ADMIN.
   *
   * The validator alone cannot prove this: it rejects the slash case before
   * `.doc()` is reached. This exercises the boundary with an identifier the
   * validator ACCEPTS.
   */
  it("SELF-VALIDATION: the canary identifier passes the validator", () => {
    // If it did not, the boundary would never be reached and the test below
    // would pass for the wrong reason.
    expect(isValidRateLimitIdentifier(DOC_REF_CANARY)).toBe(true);
  });

  it("SELF-VALIDATION: the double really throws for that identifier", () => {
    expect(() => makeRef(DOC_REF_CANARY)).toThrow("DOC_REF_CONSTRUCTION_FAILURE");
    expect(() => makeRef("set-admin:203.0.113.7")).not.toThrow();
  });

  it("checkRateLimit returns a fail-closed denial rather than throwing", async () => {
    // If `.doc()` moves outside the try, this rejects and the test fails.
    const res = await checkRateLimit({ ...CFG, identifier: DOC_REF_CANARY });
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.retryAfter).toBeGreaterThan(0);
  });

  it("no partial state is written when reference construction fails", async () => {
    await checkRateLimit({ ...CFG, identifier: DOC_REF_CANARY });
    expect(docs.size).toBe(0);
  });

  it("ANCHOR: an ordinary identifier still works, so this is not blanket denial", async () => {
    const res = await checkRateLimit({ ...CFG, identifier: "set-admin:203.0.113.7" });
    expect(res.allowed).toBe(true);
    expect(docs.get("set-admin:203.0.113.7")).toMatchObject({ count: 1 });
  });
});
