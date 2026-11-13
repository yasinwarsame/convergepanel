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

// SEC-3 / S2-b: identities are real structurally-valid credentials verified by
// the REAL privileged-access guard; only the Firebase Admin SDK is doubled
// (privilegedRouteHarness supplies adminAuth; this file keeps its own adminDb).
// Denials now carry the guard's codes: authenticated non-holder 403, bad /
// missing / revoked credential or disabled account 401, Auth outage 503.
let currentBearer = "";

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
/**
 * Research deletion integrity (2026-11-03): PATCH on a research run writes the override in a transaction guarded by the
 * deletion barrier, then the admin_audit_logs row in its own guarded transaction (best-effort, like writeAuditEvent). The
 * barrier reads `runDeletionJobs/{runId}` (the tombstone) and the run. So the double routes by collection (tombstone /
 * audit row / run) and runs each callback as a transaction that applies its buffered writes only when the callback
 * succeeds. `auditRowCreate` is the guarded audit-row write that
 * replaces `writeAuditEvent` for research runs.
 */
const auditRowCreate = jest.fn(async () => undefined);
let tombstoneExists = false;
const tombstoneHandle = { get: async () => ({ exists: tombstoneExists, data: () => (tombstoneExists ? { state: "complete" } : undefined) }) };
const auditRowHandle = { create: (...a: unknown[]) => auditRowCreate(...(a as [])) };
const docHandle = {
  ref: undefined as unknown,
  get: async () => ({ ...runDoc, ref: docHandle }),
  delete: (...a: unknown[]) => docDelete(...(a as [])),
  update: (...a: unknown[]) => docUpdate(...(a as [])),
  set: (...a: unknown[]) => docSet(...(a as [])),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble().adminAuth;
  },
  getInitializedFirebaseProjectId: () => require("@/lib/admin/__tests__/privilegedRouteHarness").PROJECT_ID,
  adminDb: {
    collection: (name: string) => ({
      doc: () => (name === "runDeletionJobs" ? tombstoneHandle : name === "admin_audit_logs" ? auditRowHandle : docHandle),
      // A non-empty page, so the purge path actually reaches its batch delete.
      // With an empty page `batchDelete`/`batchCommit` never fired for ANY
      // tier, which made the denial assertions unfalsifiable.
      where: () => purgeQuery(),
      limit: () => purgeQuery(),
      orderBy: () => purgeQuery(),
      get: async () => ({ empty: false, docs: purgeDocs(), size: purgeDocs().length }),
    }),
    batch: () => ({ delete: (...a: unknown[]) => batchDelete(...(a as [])), commit: () => batchCommit() }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const buffered: Array<() => unknown> = [];
      const tx = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (...a: unknown[]) => unknown }, ...a: unknown[]) => void buffered.push(() => ref.set(...a)),
        create: (ref: { create: (...a: unknown[]) => unknown }, ...a: unknown[]) => void buffered.push(() => ref.create(...a)),
      };
      const result = await fn(tx);
      for (const w of buffered) await w();
      return result;
    },
  },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS", delete: () => "DEL" } } },
}));
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: (...a: unknown[]) => writeAuditEvent(...(a as [])) }));
// Order A / S1: research deletion (single DELETE of collection=runs, and purge) now goes through the durable workflow —
// THAT is the guarded destructive effect for these two routes.
const deleteResearchRun = jest.fn(async (a: { runId: string }) => ({ status: "deleted", runId: a.runId, attempts: 1 }));
jest.mock("@/lib/firestore/researchDeletion", () => ({
  deleteResearchRun: (...a: unknown[]) => deleteResearchRun(...(a as [never])),
  listUnfinishedResearchDeletions: async () => [],
  getUnfinishedResearchDeletion: async () => false,
  REDACTED_ADMIN_AUDIT_QUESTION: jest.requireActual("@/lib/firestore/researchDeletion").REDACTED_ADMIN_AUDIT_QUESTION,
}));
jest.mock("@/lib/stripe/client", () => ({ stripe: { subscriptions: { retrieve: (...a: unknown[]) => stripeRetrieve(...(a as [])), list: async () => ({ data: [] }) } } }));
jest.mock("@/app/api/stripe/webhook/route", () => ({ handleSubscriptionChange: (...a: unknown[]) => handleSubscriptionChange(...(a as [])) }));
jest.mock("@/lib/stripe/usage", () => ({ resetUsageForNewPlan: (...a: unknown[]) => resetUsageForNewPlan(...(a as [])) }));

import { NextRequest } from "next/server";
import { DELETE as RUNS_DELETE, PATCH as RUNS_PATCH } from "@/app/api/admin/runs/[runId]/route";
import { POST as SYNC_POST } from "@/app/api/admin/sync-subscription/route";
import { POST as WEBHOOK_POST } from "@/app/api/admin/test-webhook/route";
import { POST as PURGE_POST } from "@/app/api/admin/purge-runs/route";

import { authState, installPrivilegedHarness, signInAs, type Persona } from "@/lib/admin/__tests__/privilegedRouteHarness";

installPrivilegedHarness();
const OUTSIDER = "system-admin@test-invented.example";

/** The four identities under test (live records; the guard reads nothing else). */
const as = (p: Persona, opts?: Parameters<typeof signInAs>[1]) => {
  currentBearer = signInAs(p, opts).bearer;
};
const AS = {
  portal: () => as("portal"),
  governance: () => as("governance"),
  ordinary: () => as("ordinary"),
  system: () => as("system"),
};

const bearer = (url: string, body?: unknown, method = "POST") =>
  new NextRequest(url, {
    method,
    headers: { ...(currentBearer ? { authorization: `Bearer ${currentBearer}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// Next 14 passes route params as a plain object, and these handlers destructure `params` directly. A Promise here left
// `runId` undefined in every handler call. The old Firestore double ignored document ids, which masked that. The
// deletion barrier refuses an undefined run id, which exposed it.
const ctx = { params: { runId: "run-1" } } as never;

/** Each case: the call, and every side effect that must not fire. */
const ROUTES = [
  {
    name: "DELETE /api/admin/runs/[runId]",
    // `collection` is read from the query string (parseCollection reads
    // request.nextUrl.searchParams). Passing it in the body made the handler
    // 400 before reaching the guard's protected work, which left every
    // side-effect assertion here unfalsifiable.
    call: () => RUNS_DELETE(bearer("http://localhost/api/admin/runs/run-1?collection=runs", { confirm: true }, "DELETE"), ctx),
    effects: () => [deleteResearchRun, writeAuditEvent],
  },
  {
    name: "PATCH /api/admin/runs/[runId]",
    call: () => RUNS_PATCH(bearer("http://localhost/api/admin/runs/run-1", { collection: "runs", action: "set_governance_status", status: "blocked" }, "PATCH"), ctx),
    // `docUpdate` was a decoy — this handler writes with `.set()`, never
    // `.update()` — so asserting its absence proved nothing.
    // Research deletion integrity: for a research run the audit row is created in the guarded transaction
    // (`auditRowCreate`), not through `writeAuditEvent`.
    effects: () => [docSet, auditRowCreate],
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
    effects: () => [deleteResearchRun],
  },
];

beforeEach(() => {
  purgePagesServed = 0;
  currentBearer = "";
  for (const f of [docDelete, docUpdate, docSet, batchDelete, batchCommit, writeAuditEvent, handleSubscriptionChange, stripeRetrieve, resetUsageForNewPlan, deleteResearchRun, auditRowCreate]) f.mockClear();
  tombstoneExists = false;
});

describe.each(ROUTES)("$name — SYSTEM_ADMIN only", ({ call, effects }) => {
  it("ADMIN_PORTAL-only is DENIED and performs NO privileged side effect", async () => {
    AS.portal();
    const res = await call();
    expect(res.status).toBe(403);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("GOVERNANCE_ADMIN-only is DENIED and performs NO privileged side effect", async () => {
    AS.governance();
    const res = await call();
    expect(res.status).toBe(403);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("an ordinary verified user is DENIED", async () => {
    AS.ordinary();
    const res = await call();
    expect(res.status).toBe(403);
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
  ])("a non-boolean LIVE admin claim (%s) does NOT satisfy SYSTEM_ADMIN", async (_l, value) => {
    as("ordinary", { record: { customClaims: { admin: value } } });
    const res = await call();
    expect(res.status).toBe(403);
    for (const fn of effects()) expect(fn).not.toHaveBeenCalled();
  });

  it("a DISABLED allowlisted portal account is DENIED", async () => {
    as("portal", { record: { disabled: true } });
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
   * convenience from the SAME live snapshot that proved the tier (S2-b).
   */
  const patch = () =>
    RUNS_PATCH(bearer("http://localhost/api/admin/runs/run-1", { collection: "runs", action: "set_governance_status", status: "blocked" }, "PATCH"), ctx);

  it("records BOTH the acting uid and the actor address from the live record", async () => {
    AS.system();
    await patch();
    // Research run: the audit row is created in the guarded transaction (auditRowCreate), with the same attribution.
    expect(auditRowCreate).toHaveBeenCalledWith(
      expect.objectContaining({ byUid: "uid-system-admin", byEmail: OUTSIDER, runId: "run-1", action: "admin_override" })
    );
  });

  it("S2-b (replaces the C5 degraded-attribution case): a failed live lookup is 503 and NOTHING is written", async () => {
    AS.system();
    authState.records.set("uid-system-admin", Object.assign(new Error("auth unavailable"), { code: "app/network-error" }));
    const res = await patch();
    expect(res.status).toBe(503);
    expect(docSet).not.toHaveBeenCalled();
    expect(auditRowCreate).not.toHaveBeenCalled();
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
    expect((await get()).status).toBe(403);
  });

  it("an ordinary verified user is DENIED", async () => {
    AS.ordinary();
    expect((await get()).status).toBe(403);
  });

  it("an unauthenticated caller is DENIED", async () => {
    expect((await get()).status).toBe(401);
  });

  it("a DISABLED allowlisted portal account is DENIED", async () => {
    as("portal", { record: { disabled: true } });
    expect((await get()).status).toBe(401);
  });
});

describe("Order A / S1: an incomplete research deletion is never reported as deleted", () => {
  const asSystem = () => AS.system();
  it("DELETE: workflow incomplete → 500 deletion_incomplete (retryable), never ok", async () => {
    asSystem();
    deleteResearchRun.mockResolvedValueOnce({ status: "incomplete", runId: "run-1", step: "subtree", error: "x" } as never);
    const res = await RUNS_DELETE(bearer("http://localhost/api/admin/runs/run-1?collection=runs", { confirm: true }, "DELETE"), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "deletion_incomplete" });
  });
  it("purge: an incomplete run is counted as an error and listed, never in deletedCount", async () => {
    asSystem();
    deleteResearchRun.mockImplementation(async (a: { runId: string }) => ({ status: "incomplete", runId: a.runId, step: "verify", error: "x" }) as never);
    const res = await PURGE_POST(bearer("http://localhost/api/admin/purge-runs", { mode: "olderThan", days: 30, dryRun: false, confirmation: "DELETE" }));
    const body = await res.json();
    expect(body.deletedCount).toBe(0);
    expect(body.errorsCount).toBeGreaterThan(0);
    expect(body.incompleteRunIds.length).toBe(body.errorsCount);
    deleteResearchRun.mockImplementation(async (a: { runId: string }) => ({ status: "deleted", runId: a.runId, attempts: 1 }) as never);
  });
});

describe("research deletion integrity — PATCH on a research run", () => {
  const patch = () =>
    RUNS_PATCH(bearer("http://localhost/api/admin/runs/run-1", { collection: "runs", action: "set_governance_status", status: "blocked" }, "PATCH"), ctx);

  it("a run with a deletion tombstone is Not found: no override, no audit row", async () => {
    AS.system();
    tombstoneExists = true;
    const res = await patch();
    expect(res.status).toBe(404);
    expect(docSet).not.toHaveBeenCalled();
    expect(auditRowCreate).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it("an ordinary run: the override and its audit row are written together, and writeAuditEvent is not used for runs", async () => {
    AS.system();
    const res = await patch();
    expect(res.status).toBe(200);
    expect(docSet).toHaveBeenCalledTimes(1);
    expect(auditRowCreate).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe("research deletion integrity — the admin DELETE evidence row (review m-1)", () => {
  it("for a research run it carries no research text: question redacted at source, contentRedacted:true", async () => {
    AS.system();
    const res = await RUNS_DELETE(bearer("http://localhost/api/admin/runs/run-1?collection=runs", { confirm: true }, "DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "admin_deleted", runId: "run-1", question: "[deleted research]", contentRedacted: true }));
    expect(JSON.stringify((writeAuditEvent as jest.Mock).mock.calls)).not.toContain('"question":"q"'); // the run's question
  });
});
