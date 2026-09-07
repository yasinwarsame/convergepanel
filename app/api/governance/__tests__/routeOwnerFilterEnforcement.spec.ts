/**
 * Phase FIRST-ADMIN-C4 — THE ROUTES MUST ENFORCE THE FINITE OWNER SET.
 *
 * The R3 review's P1: the governance resolver and its own suite were hardened to
 * a high standard, and the tests stopped exactly where enforcement begins.
 * Neutering the gate in the audit route, the review route, or the queue's query
 * scoping passed all 11,126 tests. The `review` case was the sharpest — that
 * gate is the SOLE check on a WRITE path, so removing it would let any
 * full-plan reviewer approve or block any user's run, undetected.
 *
 * These tests drive the real route handlers with a NON-GLOBAL identity whose
 * visibility is a finite set, and assert the full chain:
 *
 *   request identity -> resolver -> finite visibleUserIds -> data selection -> response
 *
 * A finite owner set must never become global at the route layer, and an EMPTY
 * finite set must mean "nothing", never "everything".
 */

const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

/** What the resolver hands the route under test. */
let visibility: Record<string, unknown> = {};
/** Which owner the doc being addressed belongs to. */
let docOwner = OWNER_A;

const auditWrite = jest.fn(async () => undefined);
const reviewUpdate = jest.fn(async () => undefined);
/**
 * Every `where()` the route builds, TAGGED WITH THE COLLECTION it was built on.
 * The collection tag matters: an earlier version of this test only checked that
 * the constraints it saw named the right owner, so dropping the constraint from
 * ONE collection while the others kept theirs slipped through.
 */
const whereCalls: Array<[string, string, string, unknown]> = [];
/** Collections the route actually queried (doc() reads excluded). */
const queriedCollections: string[] = [];

const runDoc = () => ({
  exists: true,
  id: "run-1",
  data: () => ({
    userId: docOwner,
    uid: docOwner,
    userEmail: `${docOwner}@test-invented.example`,
    question: "q",
    governanceStatus: "needs_review",
    createdAt: { toDate: () => new Date("2026-09-01T00:00:00Z") },
  }),
});

/**
 * A fully chainable query builder: every Firestore builder method returns the
 * same object, so the route can compose where/orderBy/limit/select in any order
 * without the double falling over. `where` is RECORDED, which is what lets the
 * queue tests assert the owner constraint the route actually issued rather than
 * inferring scoping from a response body.
 */
const makeQuery = (name = "?"): Record<string, unknown> => {
  const q: Record<string, unknown> = {};
  for (const m of ["orderBy", "limit", "select", "startAfter", "endBefore", "offset"]) q[m] = () => q;
  q.where = (field: string, op: string, value: unknown) => { whereCalls.push([name, field, op, value]); return q; };
  q.get = async () => { if (name !== "?") queriedCollections.push(name); return { docs: [], empty: true, size: 0 }; };
  // Sub-collection writes on the review path (governanceEvents).
  q.add = (...a: unknown[]) => reviewUpdate(...(a as []));
  q.doc = () => q;
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) });
  return q;
};

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { getUser: async () => ({ email: "reviewer@test-invented.example", emailVerified: true, disabled: false }) },
  adminDb: {
    collection: (name: string) => {
      const q = makeQuery(name);
      return Object.assign(q, {
        doc: () => ({
          get: async () => runDoc(),
          update: (...a: unknown[]) => reviewUpdate(...(a as [])),
          set: (...a: unknown[]) => reviewUpdate(...(a as [])),
          collection: (n: string) => makeQuery(n),
        }),
      });
    },
  },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS" } } },
}));

jest.mock("@/lib/governance/governanceVisibleUserIds", () => {
  const actual = jest.requireActual("@/lib/governance/governanceVisibleUserIds");
  return {
    ...actual,
    // Only the resolvers are doubled — `runOwnerVisibleInGovernance`, the
    // predicate under test, stays REAL.
    resolveGovernanceVisibleUserIds: async () => visibility,
    resolveGovernanceVisibleUserIdsCached: async () => visibility,
  };
});
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: "reviewer", email: "reviewer@test-invented.example", emailVerified: true }),
  checkAdminOnly: async () => false,
}));
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: (...a: unknown[]) => auditWrite(...(a as [])) }));

import { NextRequest } from "next/server";

const SCOPED = { ok: true, visibleUserIds: [OWNER_A], isSupportAdmin: false, queueScope: "assigners" };
const EMPTY = { ok: true, visibleUserIds: [] as string[], isSupportAdmin: false, queueScope: "no_assigners" };
const GLOBAL = { ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" };

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = "governance-only@test-invented.example";
  visibility = { ...SCOPED };
  docOwner = OWNER_A;
  auditWrite.mockClear();
  reviewUpdate.mockClear();
  whereCalls.length = 0;
  queriedCollections.length = 0;
});

// ---------------------------------------------------------------- Q. AUDIT --
describe("governance AUDIT route enforces the finite owner set", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/governance/audit/route");
    return GET(new NextRequest("http://localhost/api/governance/audit?runId=run-1&collection=runs", {
      headers: { authorization: "Bearer t" },
    }));
  };

  it("an owner INSIDE the finite set is readable", async () => {
    docOwner = OWNER_A;
    expect((await call()).status).not.toBe(403);
  });

  it("THE CORE PROOF: an owner OUTSIDE the finite set is refused", async () => {
    docOwner = OWNER_B;
    const res = await call();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("an EMPTY finite set exposes nothing — it is not global", async () => {
    visibility = { ...EMPTY };
    docOwner = OWNER_A;
    expect((await call()).status).toBe(403);
  });

  it("only a genuine governance admin (null owner set) reaches any owner", async () => {
    visibility = { ...GLOBAL };
    docOwner = OWNER_B;
    expect((await call()).status).not.toBe(403);
  });
});

// --------------------------------------------------------------- R. REVIEW --
describe("governance REVIEW route (a WRITE path) enforces the finite owner set", () => {
  const call = async () => {
    const { POST } = await import("@/app/api/governance/review/route");
    return POST(new NextRequest("http://localhost/api/governance/review", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-1", collection: "runs", action: "approved", comment: "ok" }),
    }));
  };

  it("an owner INSIDE the finite set can be reviewed", async () => {
    docOwner = OWNER_A;
    expect((await call()).status).not.toBe(403);
  });

  it("THE CORE PROOF: reviewing an owner OUTSIDE the set is refused AND writes nothing", async () => {
    docOwner = OWNER_B;
    const res = await call();
    expect(res.status).toBe(403);
    expect(reviewUpdate).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it("an EMPTY finite set permits no review at all", async () => {
    visibility = { ...EMPTY };
    docOwner = OWNER_A;
    expect((await call()).status).toBe(403);
    expect(reviewUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- S. QUEUE --
describe("governance QUEUE route scopes to the finite owner set", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/governance/queue/route");
    return GET(new NextRequest("http://localhost/api/governance/queue", { headers: { authorization: "Bearer t" } }));
  };
  /** Every owner-identity constraint the route issued, per collection. */
  const ownerConstraints = () => whereCalls.filter(([, f]) => f === "userId" || f === "uid");
  /** The run/verification collections a scoped reviewer must never read unscoped. */
  const SCOPED_COLLECTIONS = ["runs", "verifications", "videoVerifications"];
  const constrainedCollections = () => new Set(ownerConstraints().map(([c]) => c));

  it("THE CORE PROOF: EVERY queried owner-scoped collection carries the owner constraint", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const cs = ownerConstraints();
    expect(cs.length).toBeGreaterThan(0);
    for (const [, , op, value] of cs) {
      const named = Array.isArray(value) ? value : [value];
      expect(named).toEqual([OWNER_A]);
      expect(["==", "in"]).toContain(op);
    }
    // Binding collection -> constraint is what stops a single collection being
    // silently unscoped while its siblings stay correct.
    const constrained = constrainedCollections();
    for (const c of SCOPED_COLLECTIONS) {
      if (queriedCollections.includes(c)) expect(constrained).toContain(c);
    }
    expect(constrained).toContain("runs");
    const body = (await res.json()) as { ok: boolean; queueScope?: string };
    expect(body.queueScope).not.toBe("admin_global");
  });

  it("an owner OUTSIDE the set is never named in any query constraint", async () => {
    await call();
    for (const [, , , value] of ownerConstraints()) {
      const named = Array.isArray(value) ? value : [value];
      expect(named).not.toContain(OWNER_B);
    }
  });

  it("an EMPTY finite set issues NO unscoped owner query and is not global", async () => {
    visibility = { ...EMPTY };
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: unknown[]; queueScope?: string };
    expect(body.queueScope).not.toBe("admin_global");
    expect(body.items ?? []).toEqual([]);
    // The critical property: an empty set must not degrade into "no filter".
    for (const [, , , value] of ownerConstraints()) {
      const named = Array.isArray(value) ? value : [value];
      expect(named.length).toBeGreaterThan(0);
    }
  });

  it("only a genuine governance admin receives admin_global", async () => {
    visibility = { ...GLOBAL };
    const res = await call();
    const body = (await res.json()) as { queueScope?: string };
    expect(body.queueScope).toBe("admin_global");
  });
});
