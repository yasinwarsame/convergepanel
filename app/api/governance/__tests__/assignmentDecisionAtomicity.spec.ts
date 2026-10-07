/**
 * Roadmap 4.2a — governance reviewer assignment and decision atomicity.
 *
 * Stop condition, as fixed by the owner:
 *   1. After reviewer removal, that reviewer has no visibility or decision
 *      authority even if the display-side copy (`governanceReviewerFor`) is stale.  (A1)
 *   2. Concurrent assignment attempts cannot create two effective reviewers or
 *      orphaned access.                                                         (A2)
 *   3. Concurrent decision attempts result in exactly one canonical decision and
 *      exactly one corresponding audit row.                                     (R1)
 *
 * The three failure modes from the scoping pass each have an explicit test:
 * partial mirrored-write failure, simultaneous assignment, simultaneous decision.
 *
 * The fake Firestore below is the load-bearing part, so it is deliberately
 * faithful where these invariants live:
 * - `where(field, "==", v)` filters on the stored field (a filter-ignoring fake
 *   would make every visibility assertion vacuous);
 * - transactions are OPTIMISTIC: reads record a version, writes are buffered,
 *   commit is all-or-nothing and retries the whole function when any document
 *   it read has changed — the contract the Admin SDK gives server code;
 * - `gate` holds the first attempt of N transactions after their reads until
 *   all N have read, so two requests genuinely validate against the same state
 *   before either commits. Without it the "race" would run sequentially and
 *   prove nothing.
 */

jest.mock("firebase-admin/firestore", () => {
  class FieldValue {
    constructor(public op: string, public values: unknown[] = []) {}
    static arrayUnion(...v: unknown[]) { return new FieldValue("arrayUnion", v); }
    static arrayRemove(...v: unknown[]) { return new FieldValue("arrayRemove", v); }
    static delete() { return new FieldValue("delete"); }
    static serverTimestamp() { return new FieldValue("serverTimestamp"); }
  }
  class Timestamp {}
  return { FieldValue, Timestamp };
});

type Doc = { data: Record<string, unknown>; version: number };
const store = new Map<string, Doc>();
let autoId = 0;
/** When set, the commit of any transaction writing this path throws (all-or-nothing). */
let failCommitWritingPath: string | null = null;
/** Concurrency gate for the FIRST attempt of each transaction. */
let gate: { size: number; arrived: number; release: () => void; wait: Promise<void> } | null = null;

function openGate(size: number) {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  gate = { size, arrived: 0, release, wait };
}

function applyWrite(path: string, fields: Record<string, unknown>, merge: boolean) {
  const prev = store.get(path);
  const base: Record<string, unknown> = merge && prev ? { ...prev.data } : {};
  for (const [k, v] of Object.entries(fields)) {
    if (v && typeof v === "object" && "op" in (v as object) && (v as { constructor: { name: string } }).constructor.name === "FieldValue") {
      const fv = v as { op: string; values: unknown[] };
      const cur = Array.isArray(base[k]) ? (base[k] as unknown[]) : [];
      if (fv.op === "delete") delete base[k];
      else if (fv.op === "arrayUnion") base[k] = [...cur, ...fv.values.filter((x) => !cur.includes(x))];
      else if (fv.op === "arrayRemove") base[k] = cur.filter((x) => !fv.values.includes(x));
      else base[k] = "SERVER_TIMESTAMP";
    } else {
      base[k] = v;
    }
  }
  store.set(path, { data: base, version: (prev?.version ?? 0) + 1 });
}

function snapshot(path: string) {
  const d = store.get(path);
  return { exists: !!d, id: path.split("/").pop(), data: () => (d ? { ...d.data } : undefined) };
}

function docRef(path: string): any {
  return {
    __path: path,
    id: path.split("/").pop(),
    get: async () => snapshot(path),
    set: async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => applyWrite(path, fields, opts?.merge === true),
    update: async (fields: Record<string, unknown>) => applyWrite(path, fields, true),
    collection: (sub: string) => collRef(`${path}/${sub}`),
  };
}

function collRef(path: string): any {
  const filters: Array<{ f: string; v: unknown }> = [];
  const q: any = {
    doc: (id: string) => docRef(`${path}/${id}`),
    add: async (fields: Record<string, unknown>) => {
      const ref = docRef(`${path}/auto-${++autoId}`);
      await ref.set(fields);
      return ref;
    },
    where: (f: string, _op: string, v: unknown) => { filters.push({ f, v }); return q; },
    orderBy: () => q,
    limit: () => q,
    select: () => q,
    get: async () => {
      const docs = [...store.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .filter(([, d]) => filters.every(({ f, v }) => d.data[f] === v))
        .map(([p]) => ({ ...snapshot(p), ref: docRef(p) }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
  return q;
}

async function runTransaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reads = new Map<string, number>();
    const writes: Array<{ path: string; fields: Record<string, unknown>; merge: boolean }> = [];
    const txn = {
      get: async (ref: { __path: string }) => {
        reads.set(ref.__path, store.get(ref.__path)?.version ?? 0);
        return snapshot(ref.__path);
      },
      set: (ref: { __path: string }, fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        writes.push({ path: ref.__path, fields, merge: opts?.merge === true });
      },
    };
    const result = await fn(txn);
    if (attempt === 0 && gate) {
      const g = gate;
      g.arrived += 1;
      if (g.arrived >= g.size) g.release();
      await g.wait;
    }
    const stale = [...reads.entries()].some(([p, v]) => (store.get(p)?.version ?? 0) !== v);
    if (stale) continue;
    if (failCommitWritingPath && writes.some((w) => w.path === failCommitWritingPath)) {
      throw new Error("DEADLINE_EXCEEDED: commit failed");
    }
    for (const w of writes) applyWrite(w.path, w.fields, w.merge);
    return result;
  }
  throw new Error("ABORTED: too much contention");
}

const mockAdminDb = { collection: (name: string) => collRef(name), runTransaction };

let authByEmail: Record<string, string> = {};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() { return mockAdminDb; },
  adminAuth: {
    getUserByEmail: async (email: string) => {
      const uid = authByEmail[email];
      if (!uid) throw new Error("auth/user-not-found");
      return { uid, email };
    },
    getUser: async (uid: string) => ({ uid, email: Object.keys(authByEmail).find((e) => authByEmail[e] === uid) ?? "" }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId: "full" }) }));
jest.mock("@/lib/admin/verifiedAdminIdentity", () => ({
  resolveVerifiedAdminScopes: async (uid: string) => ({
    lookupStatus: "resolved",
    adminPortal: false,
    governanceAdmin: false,
    email: `${uid}@test-invented.example`,
    emailVerified: true,
    disabled: false,
  }),
}));
let requestUid = "";
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: async (req: { headers: { get: (k: string) => string | null } }) => ({
    status: "authenticated",
    uid: req.headers.get("x-test-uid") ?? requestUid,
  }),
}));
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async (req: { headers: { get: (k: string) => string | null } }) => {
    const uid = req.headers.get("x-test-uid") ?? requestUid;
    return { ok: true, uid, email: `${uid}@test-invented.example`, emailVerified: true };
  },
}));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: async () => ({ classification: "legacy" }),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST as reviewerPOST } from "@/app/api/governance/reviewer/route";
import { POST as reviewPOST } from "@/app/api/governance/review/route";
import {
  resolveGovernanceVisibleUserIds,
  resolveGovernanceVisibleUserIdsCached,
  runOwnerVisibleInGovernance,
} from "@/lib/governance/governanceVisibleUserIds";

const ASSIGNER = "assigner-uid";
const REVIEWER_1 = "reviewer-one";
const REVIEWER_2 = "reviewer-two";
const RUN = "run-1";

function reviewerReq(uid: string, body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/governance/reviewer", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-uid": uid },
    body: JSON.stringify(body),
  });
}
function reviewReq(uid: string, action: string) {
  return new NextRequest("http://localhost/api/governance/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-uid": uid },
    body: JSON.stringify({ runId: RUN, collection: "runs", action, comment: "decision comment" }),
  });
}
const assign = (reviewerEmail: string) => reviewerPOST(reviewerReq(ASSIGNER, { action: "assign_reviewer", reviewerEmail }));
const remove = () => reviewerPOST(reviewerReq(ASSIGNER, { action: "remove_reviewer" }));

async function canSee(reviewer: string, owner = ASSIGNER) {
  const vis = await resolveGovernanceVisibleUserIds(reviewer);
  return vis.ok && runOwnerVisibleInGovernance(vis.visibleUserIds, owner);
}
const user = (uid: string) => store.get(`users/${uid}`)?.data ?? {};
const auditRows = () => [...store.keys()].filter((p) => p.startsWith("admin_audit_logs/"));
const decisionEvents = () => [...store.keys()].filter((p) => p.startsWith(`runs/${RUN}/governanceEvents/`));

beforeEach(() => {
  store.clear();
  autoId = 0;
  failCommitWritingPath = null;
  gate = null;
  requestUid = "";
  authByEmail = {
    "reviewer.one@test-invented.example": REVIEWER_1,
    "reviewer.two@test-invented.example": REVIEWER_2,
    "assigner@test-invented.example": ASSIGNER,
  };
  store.set(`users/${ASSIGNER}`, { data: { email: "assigner@test-invented.example" }, version: 1 });
  store.set(`users/${REVIEWER_1}`, { data: { governanceReviewerEnabled: true }, version: 1 });
  store.set(`users/${REVIEWER_2}`, { data: { governanceReviewerEnabled: true }, version: 1 });
  store.set(`runs/${RUN}`, {
    data: { userId: ASSIGNER, userEmail: "assigner@test-invented.example", question: "q", governanceStatus: "needs_review" },
    version: 1,
  });
});

describe("A1 — the assigner's own record is the sole grant", () => {
  it("control: an assigned reviewer can see and decide", async () => {
    expect((await assign("reviewer.one@test-invented.example")).status).toBe(200);
    expect(await canSee(REVIEWER_1)).toBe(true);
    expect((await reviewPOST(reviewReq(REVIEWER_1, "approved"))).status).toBe(200);
  });

  it("after removal: no visibility and no decision authority, though the mirror is stale", async () => {
    await assign("reviewer.one@test-invented.example");
    expect((await remove()).status).toBe(200);
    // Force the stale-mirror state the old union honoured.
    applyWrite(`users/${REVIEWER_1}`, { governanceReviewerFor: [ASSIGNER] }, true);
    expect(user(REVIEWER_1).governanceReviewerFor).toEqual([ASSIGNER]);
    expect(user(ASSIGNER).governanceReviewerUid).toBeUndefined();

    expect(await canSee(REVIEWER_1)).toBe(false);
    const res = await reviewPOST(reviewReq(REVIEWER_1, "approved"));
    expect(res.status).toBe(403);
    expect(store.get(`runs/${RUN}`)?.data.governanceStatus).toBe("needs_review");
    expect(auditRows()).toHaveLength(0);
  });

  it("the cached entry point does not keep a removed reviewer's grant", async () => {
    await assign("reviewer.one@test-invented.example");
    const before = await resolveGovernanceVisibleUserIdsCached(REVIEWER_1);
    expect(before.ok && runOwnerVisibleInGovernance(before.visibleUserIds, ASSIGNER)).toBe(true);
    await remove();
    const after = await resolveGovernanceVisibleUserIdsCached(REVIEWER_1);
    expect(after.ok && runOwnerVisibleInGovernance(after.visibleUserIds, ASSIGNER)).toBe(false);
  });
});

describe("failure mode 1 — partial mirrored-write failure", () => {
  it("assignment whose mirror write fails leaves NEITHER write and grants nothing", async () => {
    failCommitWritingPath = `users/${REVIEWER_1}`;
    await expect(assign("reviewer.one@test-invented.example")).rejects.toThrow(/commit failed/);
    expect(user(ASSIGNER).governanceReviewerUid).toBeUndefined();
    expect(user(REVIEWER_1).governanceReviewerFor).toBeUndefined();
    expect(await canSee(REVIEWER_1)).toBe(false);
  });

  it("removal whose mirror write fails leaves the assignment fully intact (no half-removed state)", async () => {
    await assign("reviewer.one@test-invented.example");
    failCommitWritingPath = `users/${REVIEWER_1}`;
    await expect(remove()).rejects.toThrow(/commit failed/);
    expect(user(ASSIGNER).governanceReviewerUid).toBe(REVIEWER_1);
    expect(user(REVIEWER_1).governanceReviewerFor).toEqual([ASSIGNER]);
  });

  it("a mirror that is stale anyway (historical half-write) grants nothing", async () => {
    applyWrite(`users/${REVIEWER_2}`, { governanceReviewerFor: [ASSIGNER] }, true);
    expect(await canSee(REVIEWER_2)).toBe(false);
    expect((await reviewPOST(reviewReq(REVIEWER_2, "approved"))).status).toBe(403);
  });
});

describe("failure mode 2 — simultaneous assignment", () => {
  it("two concurrent assignments: one authoritative reviewer, no orphaned mirror or access", async () => {
    openGate(2);
    const [a, b] = await Promise.all([
      assign("reviewer.one@test-invented.example"),
      assign("reviewer.two@test-invented.example"),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const winner = user(ASSIGNER).governanceReviewerUid as string;
    const loser = winner === REVIEWER_1 ? REVIEWER_2 : REVIEWER_1;
    expect([REVIEWER_1, REVIEWER_2]).toContain(winner);
    expect(user(winner).governanceReviewerFor).toEqual([ASSIGNER]);
    expect(user(loser).governanceReviewerFor).toBeUndefined();

    expect(await canSee(winner)).toBe(true);
    expect(await canSee(loser)).toBe(false);
    expect((await reviewPOST(reviewReq(loser, "approved"))).status).toBe(403);

    // And removing the winner leaves nobody with access.
    await remove();
    expect(await canSee(winner)).toBe(false);
    expect(await canSee(loser)).toBe(false);
  });

  it("the gate genuinely interleaves: both attempts read before either commits", async () => {
    openGate(2);
    await Promise.all([assign("reviewer.one@test-invented.example"), assign("reviewer.two@test-invented.example")]);
    expect(gate?.arrived).toBe(2);
  });
});

describe("failure mode 3 — simultaneous decision (R1)", () => {
  // The assigner has exactly one reviewer, so the race is that reviewer
  // submitting twice at once — the double-click / double-POST case — with the
  // same or conflicting actions.
  beforeEach(async () => {
    await assign("reviewer.one@test-invented.example");
  });

  it.each([
    ["approve + approve", "approved", "approved"],
    ["approve + block", "approved", "blocked"],
    ["block + approve", "blocked", "approved"],
  ])("%s: exactly one canonical decision, one audit row, one event", async (_l, first, second) => {
    openGate(2);
    const [a, b] = await Promise.all([reviewPOST(reviewReq(REVIEWER_1, first)), reviewPOST(reviewReq(REVIEWER_1, second))]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);

    const winner = a.status === 200 ? first : second;
    expect(store.get(`runs/${RUN}`)?.data.governanceStatus).toBe(winner);
    expect(auditRows()).toHaveLength(1);
    expect(store.get(auditRows()[0])?.data.action).toBe(winner);
    expect(decisionEvents()).toHaveLength(1);

    const loserBody = await (a.status === 409 ? a : b).json();
    expect(loserBody.error.code).toBe("conflict");
  });

  it("control: two SEQUENTIAL different decisions are both allowed when the transition is legal", async () => {
    expect((await reviewPOST(reviewReq(REVIEWER_1, "blocked"))).status).toBe(200);
    expect((await reviewPOST(reviewReq(REVIEWER_1, "approved"))).status).toBe(200);
    expect(store.get(`runs/${RUN}`)?.data.governanceStatus).toBe("approved");
    expect(auditRows()).toHaveLength(2);
  });
});
