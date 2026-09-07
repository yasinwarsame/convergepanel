/**
 * Phase FIRST-ADMIN-C7 — THE ONE GOVERNANCE ROUTE THAT WRITES, PROVEN.
 *
 * The C6-R3 review found that `/api/governance/review` — the only governance
 * route performing a cross-tenant WRITE — had no positive write anchor. Three
 * independent mutations survived the whole suite:
 *
 *   - deleting the primary `ref.set(patch)` entirely (80/80 green);
 *   - unwiring the test double's `set`/`update` from the spy;
 *   - both together WITH a real authorization-after-write defect, so an
 *     unauthorized cross-tenant write landed and went undetected.
 *
 * Root cause: the authorized case asserted only `status !== 403`, so every
 * `not.toHaveBeenCalled()` denial rested on wiring nothing tested.
 *
 * It also found the disabled-account gate unproven HERE: the only tests driving
 * this route mocked `@/lib/governance/authCheck` wholesale, so the live-record
 * check was never executed on the write path.
 *
 * This suite therefore mocks ONLY `firebase-admin` and two data helpers. The
 * REAL chain runs end to end: credential → resolveRequestIdentity →
 * resolveGovernanceRequestUser (including the live `disabled` read) →
 * resolveGovernanceVisibleUserIds → the review handler → the writes.
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

/** Supported collections are derived from the route's own validator, not hand-listed. */
import { readFileSync } from "node:fs";
const ROUTE_SRC = readFileSync("app/api/governance/review/route.ts", "utf8");
const COLLECTIONS = ["runs", "verifications", "videoVerifications"] as const;
type Coll = (typeof COLLECTIONS)[number];

const REVIEWER = "reviewer-uid";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const NOW = Date.now();

let tokenClaims: Record<string, unknown> = {};
let liveRecord: Record<string, unknown> = {};
let planId = "full";
let reviewerFor: string[] = [];
/** Which documents exist, keyed `collection/id`. Missing => the route 404s. */
let existingDocs: Record<string, { userId: string }> = {};

/** Every write the handler performed, with full collection+id identity. */
type Write = { kind: "set" | "update" | "add"; collection: string; id: string; patch?: Record<string, unknown> };
let writes: Write[] = [];
const auditWrites: Array<Record<string, unknown>> = [];
jest.mock("@/lib/governance/auditLog", () => ({
  writeAuditEvent: async (e: Record<string, unknown>) => { auditWrites.push(e); },
}));

function docHandle(collection: string, id: string) {
  const key = `${collection}/${id}`;
  return {
    id,
    get: async () => {
      const rec = existingDocs[key];
      return {
        exists: Boolean(rec),
        id,
        data: () => (rec ? {
          userId: rec.userId, uid: rec.userId,
          userEmail: `${rec.userId}@test-invented.example`,
          question: `question-${rec.userId}`,
          governanceStatus: "needs_review",
          createdAt: { toMillis: () => NOW },
        } : undefined),
      };
    },
    set: async (patch: Record<string, unknown>) => { writes.push({ kind: "set", collection, id, patch }); },
    update: async (patch: Record<string, unknown>) => { writes.push({ kind: "update", collection, id, patch }); },
    collection: (sub: string) => ({
      add: async (patch: Record<string, unknown>) => { writes.push({ kind: "add", collection: `${collection}/${id}/${sub}`, id: "auto", patch }); },
      orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
      get: async () => ({ docs: [] }),
    }),
  };
}
function collectionHandle(name: string) {
  const q: Record<string, unknown> = { };
  for (const m of ["where", "orderBy", "limit", "select"]) q[m] = () => q;
  q.get = async () => ({ docs: [], empty: true, size: 0 });
  return Object.assign(q, { doc: (id: string) => docHandle(name, id) });
}

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: async () => tokenClaims,
    verifySessionCookie: async () => tokenClaims,
    getUser: async () => liveRecord,
  },
  adminDb: { collection: (n: string) => collectionHandle(n) },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS" } } },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId }) }));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => reviewerFor }));

import { NextRequest } from "next/server";

const post = async (collection: Coll, runId: string) => {
  const { POST } = await import("@/app/api/governance/review/route");
  return POST(new NextRequest("http://localhost/api/governance/review", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ runId, collection, action: "approved", comment: "reviewed" }),
  }));
};

const primaryWrites = (c: Coll, id: string) => writes.filter((w) => w.kind !== "add" && w.collection === c && w.id === id);
const eventWrites = () => writes.filter((w) => w.kind === "add");

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = "";
  planId = "full";
  reviewerFor = [OWNER_A];
  tokenClaims = { uid: REVIEWER, email: "reviewer@test-invented.example", email_verified: true };
  liveRecord = { email: "reviewer@test-invented.example", emailVerified: true, disabled: false };
  writes = [];
  auditWrites.length = 0;
  existingDocs = {};
  for (const c of COLLECTIONS) {
    existingDocs[`${c}/run-a`] = { userId: OWNER_A };
    existingDocs[`${c}/run-b`] = { userId: OWNER_B };
  }
});

describe("the route's supported collections are derived from source, not hand-listed", () => {
  it("every collection this suite exercises appears in the route's own validator", () => {
    for (const c of COLLECTIONS) expect(ROUTE_SRC).toContain(`"${c}"`);
    // And the validator names no collection this suite omits.
    const named = [...ROUTE_SRC.matchAll(/coll !== "([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(COLLECTIONS));
  });
});

describe("DOUBLE FIDELITY — the recorder cannot alias document identity", () => {
  /**
   * The security assertions below read the recorded `{collection, id}` of every
   * write. If the double mislabelled a write — recording an OWNER_B mutation as
   * OWNER_A, or one collection as another — a mis-targeted write would look
   * correct. The denial cases assert ZERO writes and so are immune, but the
   * POSITIVE case reads identity, so the recorder itself is pinned here.
   */
  it.each(COLLECTIONS)("%s: a write records the exact id it was addressed to", async (collection) => {
    writes = [];
    await collectionHandle(collection).doc("run-b").set({ marker: "b" });
    await collectionHandle(collection).doc("run-a").set({ marker: "a" });
    expect(writes.map((w) => `${w.collection}/${w.id}`)).toEqual([`${collection}/run-b`, `${collection}/run-a`]);
    expect(writes.map((w) => (w.patch as { marker?: string } | undefined)?.marker)).toEqual(["b", "a"]);
  });

  it("separate collections do not alias one another", async () => {
    writes = [];
    for (const c of COLLECTIONS) await collectionHandle(c).doc("run-a").set({ c });
    expect(writes.map((w) => w.collection)).toEqual([...COLLECTIONS]);
  });

  it("a sub-collection write records its full path", async () => {
    writes = [];
    await collectionHandle("runs").doc("run-a").collection("governanceEvents").add({ x: 1 });
    expect(writes[0].collection).toBe("runs/run-a/governanceEvents");
  });
});

describe.each(COLLECTIONS)("REVIEW WRITE — collection=%s", (collection) => {
  it("FIXTURE SELF-VALIDATION: both tenants' target documents genuinely exist", async () => {
    // Derived from the double's own state, not a hand-written anchor list.
    expect(existingDocs[`${collection}/run-a`]).toEqual({ userId: OWNER_A });
    expect(existingDocs[`${collection}/run-b`]).toEqual({ userId: OWNER_B });
    const a = await collectionHandle(collection).doc("run-a").get();
    const b = await collectionHandle(collection).doc("run-b").get();
    expect([a.exists, b.exists]).toEqual([true, true]);
  });

  it("THE POSITIVE ANCHOR: an authorized review performs EVERY required write", async () => {
    const res = await post(collection, "run-a");
    // Exact success status — not merely "not 403".
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, runId: "run-a", newStatus: "approved" });

    // 1. the primary status mutation, on the EXACT collection and document
    const primary = primaryWrites(collection, "run-a");
    expect(primary).toHaveLength(1);
    expect(primary[0].patch).toMatchObject({ governanceStatus: "approved", governanceReviewedBy: REVIEWER });

    // 2. the audit event
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({ byUid: REVIEWER });

    // 3. the governanceEvents sub-collection write
    expect(eventWrites().map((w) => w.collection)).toEqual([`${collection}/run-a/governanceEvents`]);

    // Nothing touched the other tenant's document.
    expect(primaryWrites(collection, "run-b")).toEqual([]);
  });

  it("CROSS-TENANT DENIAL: reviewing OWNER_B is refused and writes NOTHING", async () => {
    const res = await post(collection, "run-b");
    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
    expect(auditWrites).toEqual([]);
  });

  it("a DISABLED reviewer is refused on the real write route, through the real live-record check", async () => {
    liveRecord = { email: "reviewer@test-invented.example", emailVerified: true, disabled: true };
    const res = await post(collection, "run-a");
    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
    expect(auditWrites).toEqual([]);
  });

  it("the same reviewer ENABLED succeeds — so the disabled denial is not blanket", async () => {
    liveRecord = { email: "reviewer@test-invented.example", emailVerified: true, disabled: false };
    expect((await post(collection, "run-a")).status).toBe(200);
    expect(primaryWrites(collection, "run-a")).toHaveLength(1);
  });

  it("an empty reviewer scope permits no review", async () => {
    reviewerFor = [];
    const res = await post(collection, "run-a");
    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("a MISSING target 404s and cannot serve as a positive control", async () => {
    delete existingDocs[`${collection}/run-a`];
    const res = await post(collection, "run-a");
    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });
});
