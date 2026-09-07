/**
 * Phase FIRST-ADMIN-C4 — the five SYSTEM_ADMIN mutation surfaces.
 *
 * Four of these moved tier in C4, by the FIRST_ADMIN_ENROLLMENT_BLOCKER_DECISION
 * resolved 2026-09-07: ADMIN_PORTAL is the lower operational/read tier and must
 * not reach destructive, governance-changing or billing-changing actions.
 *
 *   DELETE /api/admin/runs/[runId]   permanent cross-user deletion
 *   PATCH  /api/admin/runs/[runId]   governance-status write on another user's run
 *   POST   /api/admin/sync-subscription   billing-state mutation
 *   POST   /api/admin/test-webhook        billing/webhook mutation
 *
 * The fifth, POST /api/admin/purge-runs, was ALREADY SYSTEM_ADMIN but the R3
 * review found its tier pinned by no server test at all — a silent downgrade to
 * ADMIN_PORTAL passed the entire suite. It is covered here for the same reason.
 *
 * Every denial asserts the ABSENCE OF THE SIDE EFFECT, not merely a 401: the
 * point is that the privileged operation never happened, which a status code
 * alone does not establish.
 */

// Phase FIRST-ADMIN-C6 — the price map is built from env at module load. Without
// this, `getPlanIdFromPriceId` returns null and the sync-subscription positive
// case 400s BEFORE the billing write, leaving its side-effect assertions
// unfalsifiable (nothing called them for any tier).
process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), STRIPE_PRICE_3_MODELS: "price_lite_m" }));

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

const PORTAL_ONLY = "portal-only@test-invented.example";
const GOV_ONLY = "governance-only@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

let decoded: Record<string, unknown> = {};
let authRecord: Record<string, unknown> = {};
let authRecordThrows = false;

/** Every privileged side effect this suite guards. */
const docDelete = jest.fn(async () => undefined);
const docUpdate = jest.fn(async () => undefined);
const docSet = jest.fn(async () => undefined);
const batchDelete = jest.fn();
const batchCommit = jest.fn(async () => undefined);
const writeAuditEvent = jest.fn(async () => undefined);
const handleSubscriptionChange = jest.fn(async () => undefined);
const stripeRetrieve = jest.fn(async () => ({ id: "sub_x", status: "active", customer: "cus_x", items: { data: [{ price: { id: "price_lite_m", recurring: { interval: "month" } } }] }, metadata: {} }));
const resetUsageForNewPlan = jest.fn(async () => undefined);

/** One page of deletable docs, then an empty page so pagination terminates. */
let purgePagesServed = 0;
const purgeDocs = () => (purgePagesServed++ === 0 ? [{ id: "old-1", ref: { id: "old-1" } }, { id: "old-2", ref: { id: "old-2" } }] : []);
const purgeQuery = () => {
  const q: Record<string, unknown> = {};
  for (const m of ["where", "orderBy", "limit", "startAfter", "select"]) q[m] = () => q;
  q.get = async () => { const d = purgeDocs(); return { empty: d.length === 0, docs: d, size: d.length }; };
  return q;
};

const runDoc = {
  exists: true,
  id: "run-1",
  data: () => ({ userId: "victim-uid", userEmail: "victim@test-invented.example", question: "q", governanceStatus: "approved" }),
};
const docHandle = {
  get: async () => runDoc,
  delete: (...a: unknown[]) => docDelete(...(a as [])),
  update: (...a: unknown[]) => docUpdate(...(a as [])),
  set: (...a: unknown[]) => docSet(...(a as [])),
};

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: async () => decoded,
    verifySessionCookie: async () => decoded,
    getUser: async () => {
      if (authRecordThrows) throw new Error("auth unavailable");
      return authRecord;
    },
  },
  adminDb: {
    collection: () => ({
      doc: () => docHandle,
      // A non-empty page, so the purge path actually reaches its batch delete.
      // With an empty page `batchDelete`/`batchCommit` never fired for ANY
      // tier, which made the denial assertions unfalsifiable.
      where: () => purgeQuery(),
      limit: () => purgeQuery(),
      orderBy: () => purgeQuery(),
      get: async () => ({ empty: false, docs: purgeDocs(), size: purgeDocs().length }),
    }),
    batch: () => ({ delete: (...a: unknown[]) => batchDelete(...(a as [])), commit: () => batchCommit() }),
  },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS", delete: () => "DEL" } } },
}));
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: (...a: unknown[]) => writeAuditEvent(...(a as [])) }));
jest.mock("@/lib/stripe/client", () => ({ stripe: { subscriptions: { retrieve: (...a: unknown[]) => stripeRetrieve(...(a as [])), list: async () => ({ data: [] }) } } }));
jest.mock("@/app/api/stripe/webhook/route", () => ({ handleSubscriptionChange: (...a: unknown[]) => handleSubscriptionChange(...(a as [])) }));
jest.mock("@/lib/stripe/usage", () => ({ resetUsageForNewPlan: (...a: unknown[]) => resetUsageForNewPlan(...(a as [])) }));

import { NextRequest } from "next/server";
import { DELETE as RUNS_DELETE, PATCH as RUNS_PATCH } from "@/app/api/admin/runs/[runId]/route";
import { POST as SYNC_POST } from "@/app/api/admin/sync-subscription/route";
import { POST as WEBHOOK_POST } from "@/app/api/admin/test-webhook/route";
import { POST as PURGE_POST } from "@/app/api/admin/purge-runs/route";

/** The four identities under test. */
const AS = {
  portal: () => { decoded = { uid: "p", email: PORTAL_ONLY }; authRecord = { email: PORTAL_ONLY, emailVerified: true, disabled: false }; },
  governance: () => { decoded = { uid: "g", email: GOV_ONLY }; authRecord = { email: GOV_ONLY, emailVerified: true, disabled: false }; },
  ordinary: () => { decoded = { uid: "o", email: OUTSIDER }; authRecord = { email: OUTSIDER, emailVerified: true, disabled: false }; },
  system: () => { decoded = { uid: "s", email: OUTSIDER, admin: true }; authRecord = { email: OUTSIDER, emailVerified: true, disabled: false }; },
};

const bearer = (url: string, body?: unknown, method = "POST") =>
  new NextRequest(url, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ctx = { params: Promise.resolve({ runId: "run-1" }) } as never;

/** Each case: the call, and every side effect that must not fire. */
const ROUTES = [
  {
    name: "DELETE /api/admin/runs/[runId]",
    // `collection` is read from the query string (parseCollection reads
    // request.nextUrl.searchParams). Passing it in the body made the handler
    // 400 before reaching the guard's protected work, which left every
    // side-effect assertion here unfalsifiable.
    call: () => RUNS_DELETE(bearer("http://localhost/api/admin/runs/run-1?collection=runs", { confirm: true }, "DELETE"), ctx),
    effects: () => [docDelete, writeAuditEvent],
  },
  {
    name: "PATCH /api/admin/runs/[runId]",
    call: () => RUNS_PATCH(bearer("http://localhost/api/admin/runs/run-1", { collection: "runs", action: "set_governance_status", status: "blocked" }, "PATCH"), ctx),
    // `docUpdate` was a decoy — this handler writes with `.set()`, never
    // `.update()` — so asserting its absence proved nothing.
    effects: () => [docSet, writeAuditEvent],
  },
  {
    name: "POST /api/admin/sync-subscription",
    call: () => SYNC_POST(bearer("http://localhost/api/admin/sync-subscription", { subscriptionId: "sub_x" })),
    effects: () => [stripeRetrieve, docSet, resetUsageForNewPlan],
  },
  {
    name: "POST /api/admin/test-webhook",
    call: () => WEBHOOK_POST(bearer("http://localhost/api/admin/test-webhook", { subscriptionId: "sub_x" })),
    effects: () => [handleSubscriptionChange, stripeRetrieve],
  },
  {
    name: "POST /api/admin/purge-runs",
    call: () => PURGE_POST(bearer("http://localhost/api/admin/purge-runs", { mode: "olderThan", days: 30, dryRun: false, confirmation: "DELETE" })),
    effects: () => [batchDelete, batchCommit],
  },
];

beforeEach(() => {
  process.env.ADMIN_EMAILS = PORTAL_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  purgePagesServed = 0;
  authRecordThrows = false;
  for (const f of [docDelete, docUpdate, docSet, batchDelete, batchCommit, writeAuditEvent, handleSubscriptionChange, stripeRetrieve, resetUsageForNewPlan]) f.mockClear();
  decoded = {};
  authRecord = {};
});

describe.each(ROUTES)("$name — SYSTEM_ADMIN only", ({ call, effects }) => {
  it("ADMIN_PORTAL-only is DENIED and performs NO privileged side effect", async () => {
    AS.portal();
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("GOVERNANCE_ADMIN-only is DENIED and performs NO privileged side effect", async () => {
    AS.governance();
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("an ordinary verified user is DENIED", async () => {
    AS.ordinary();
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("a SYSTEM_ADMIN claim holder reaches the handler AND the guarded effect fires", async () => {
    AS.system();
    const res = await call();
    expect(res.status).not.toBe(401);
    // Phase FIRST-ADMIN-C6 — EVERY listed effect must fire, not merely one.
    //
    // With `some()`, commenting out the actual `ref.delete()` still passed: the
    // route returned 200 and wrote an audit record claiming a deletion that
    // never happened. Each effect in this route's list is one the successful
    // path is REQUIRED to perform, so each is asserted by name.
    const notCalled = effects().filter((fn) => fn.mock.calls.length === 0);
    expect({ status: res.status, uncalledEffects: notCalled.length }).toEqual({ status: res.status, uncalledEffects: 0 });
    // A 4xx can satisfy `not.toBe(401)`; a successful privileged path must not 4xx.
    expect(res.status).toBeLessThan(400);
  });

  it.each([
    ['string "true"', "true"],
    ["number 1", 1],
    ["empty object", {}],
  ])("a non-boolean admin claim (%s) does NOT satisfy SYSTEM_ADMIN", async (_l, value) => {
    decoded = { uid: "x", email: OUTSIDER, admin: value };
    authRecord = { email: OUTSIDER, emailVerified: true, disabled: false };
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("a DISABLED allowlisted portal account is DENIED", async () => {
    decoded = { uid: "p", email: PORTAL_ONLY };
    authRecord = { email: PORTAL_ONLY, emailVerified: true, disabled: true };
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });
});

describe("audit attribution on the SYSTEM_ADMIN run handlers", () => {
  /**
   * C4-R1: nothing asserted the audit actor at all, so `auditActorEmail()`
   * returning "" unconditionally survived the whole suite. `byUid` is the
   * authoritative identifier and must always be present; the address is a
   * convenience that degrades to empty if the live lookup fails.
   */
  const patch = () =>
    RUNS_PATCH(bearer("http://localhost/api/admin/runs/run-1", { collection: "runs", action: "set_governance_status", status: "blocked" }, "PATCH"), ctx);

  it("records BOTH the acting uid and the actor address from the live record", async () => {
    AS.system();
    await patch();
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ byUid: "s", byEmail: OUTSIDER })
    );
  });

  it("a failed live lookup still records the acting uid — attribution is never lost", async () => {
    AS.system();
    authRecordThrows = true;
    await patch();
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ byUid: "s", byEmail: "" })
    );
  });
});

describe("GET /api/admin/runs/[runId] deliberately REMAINS ADMIN_PORTAL", () => {
  /**
   * Phase FIRST-ADMIN-C6. This block previously had a single positive
   * assertion and NO denial control, so removing the GET guard entirely — any
   * caller reading any user's run — passed the whole suite. The tier is now
   * pinned in BOTH directions: portal and claim succeed, everyone else is
   * refused.
   */
  const get = async () => {
    const { GET } = await import("@/app/api/admin/runs/[runId]/route");
    return GET(bearer("http://localhost/api/admin/runs/run-1?collection=runs", undefined, "GET"), ctx);
  };

  it("ADMIN_PORTAL-only succeeds — the read capability is retained", async () => {
    AS.portal();
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("SYSTEM_ADMIN succeeds through inherited portal authority", async () => {
    AS.system();
    expect((await get()).status).toBe(200);
  });

  it("GOVERNANCE_ADMIN-only is DENIED — governance confers no portal read", async () => {
    AS.governance();
    expect((await get()).status).toBe(401);
  });

  it("an ordinary verified user is DENIED", async () => {
    AS.ordinary();
    expect((await get()).status).toBe(401);
  });

  it("an unauthenticated caller is DENIED", async () => {
    decoded = {};
    authRecord = {};
    expect((await get()).status).toBe(401);
  });

  it("a DISABLED allowlisted portal account is DENIED", async () => {
    decoded = { uid: "p", email: PORTAL_ONLY };
    authRecord = { email: PORTAL_ONLY, emailVerified: true, disabled: true };
    expect((await get()).status).toBe(401);
  });
});
