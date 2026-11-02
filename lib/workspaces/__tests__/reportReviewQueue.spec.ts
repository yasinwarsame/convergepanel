/**
 * Order B, Stage B2 — combined Approval Queue through the REAL route (identity + Approval Workflow admission mocked;
 * Workspace access, capabilities, cursor binding, the merged scan and revalidation all real) on the query-capable
 * transactional fake. The same scenarios run against the real Firestore emulator in reportReviewQueue.emulator.spec.ts.
 */
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const flags = { REPORT_REVIEW_ENABLED: true };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return flags.REPORT_REVIEW_ENABLED;
  },
}));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const identity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => ({ status: "authenticated", uid: identity.uid, source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/workspaces/[workspaceId]/review-queue/route";
import { buildSeed, seedDb, seedDroppedBlock, pageAllWithProgress, expectedStatusView, expectedAssignedToMe, pageAll, type QueueFn, type SeedRun, W, W2, OWNER, REVIEWER, SUBMITTER, CREATOR } from "./helpers/reviewQueueScenario";
import { buildReportReviewRecord } from "@/lib/governance/reportReview";

async function call(view: string, uid: string, limit: number, cursor: string | null, workspaceId = W) {
  identity.uid = uid;
  const qs = new URLSearchParams({ view, limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/review-queue?${qs}`), { params: { workspaceId } });
  return { status: res.status, body: await res.json() };
}
const queue: QueueFn = async ({ view, uid, limit, cursor }) => {
  const r = await call(view, uid, limit, cursor);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

let seed: SeedRun[];
beforeEach(async () => {
  db.docs.clear();
  flags.REPORT_REVIEW_ENABLED = true;
  seed = buildSeed();
  await seedDb(db as never, seed);
});

const VIEWS = ["needs_review", "changes_requested", "recently_approved"] as const;

describe("status views: every eligible item exactly once, deterministic order, at every page size", () => {
  it.each(VIEWS.flatMap((v) => [1, 2, 3, 4, 5, 7, 25].map((l) => [v, l] as const)))("%s, limit %i", async (view, limit) => {
    const { ids, rows } = await pageAll(queue, view, OWNER, "owner", limit);
    expect(ids).toEqual(expectedStatusView(seed, view));
    // recordKind appears only on report-review rows.
    for (const r of rows) expect(r.recordKind === "report_review").toBe(r.runId.startsWith("rr-"));
  });

  it("the seed contains cross-stream ties in every view (so document-id tie-breaking across streams is exercised)", () => {
    for (const view of VIEWS) {
      const rows = seed.filter((r) => r.eligible && r.workspaceId === W && expectedStatusView(seed, view).includes(r.id));
      const key = (r: SeedRun) => (view === "needs_review" ? `${r.createdAt.seconds}` : r.reviewedAt);
      const crossTie = rows.some((a) => rows.some((b) => a.kind !== b.kind && key(a) === key(b)));
      expect(crossTie).toBe(true);
    }
  });

  it("the same page size twice returns byte-identical pages (deterministic)", async () => {
    const a = await pageAll(queue, "needs_review", OWNER, "owner", 3);
    const b = await pageAll(queue, "needs_review", OWNER, "owner", 3);
    expect(a.rows).toEqual(b.rows);
  });

  it("dropped rows (malformed, both records, other Workspace) never appear", async () => {
    for (const view of VIEWS) {
      const { ids } = await pageAll(queue, view, OWNER, "owner", 2);
      for (const bad of ["bad-gov", "bad-both", "bad-rr", ...seed.filter((r) => r.workspaceId === W2).map((r) => r.id)]) expect(ids).not.toContain(bad);
    }
  });

  it("a report review assigned to its own submitter is never actionable (stale) in Needs review", async () => {
    const { rows } = await pageAll(queue, "needs_review", OWNER, "owner", 25);
    const submitterAssigned = seed.filter((r) => r.kind === "rr" && r.assignedTo === SUBMITTER && ["unreviewed", "pending"].includes(r.status)).map((r) => r.id);
    expect(submitterAssigned.length).toBeGreaterThan(0);
    for (const id of submitterAssigned) expect(rows.find((r) => r.runId === id)!.assignment.state).toBe("stale");
  });
});

describe("fetch budget (B2 review MINOR-4): a long block of dropped rows at small page sizes", () => {
  it.each([1, 2])("limit %i: honest empty pages advance the cursor; every eligible item exactly once", async (limit) => {
    await seedDroppedBlock(db as never, 40);
    const { ids, emptyPages } = await pageAllWithProgress(queue, "needs_review", OWNER, "owner", limit);
    expect(ids).toEqual(expectedStatusView(seed, "needs_review"));
    expect(emptyPages).toBeGreaterThan(0); // the budget stop was actually exercised
  });

  it("a non-Timestamp createdAt on a candidate fails the page explicitly (500), never mis-ordered", async () => {
    await db.collection("runs").doc("rr-badts").set({ userId: CREATOR, workspaceId: W, projectId: null, question: "x", status: "complete", createdAt: "2026-10-01", reportReview: seed.length ? (await db.collection("runs").doc("rr-020").get()).data()!.reportReview : null });
    expect((await call("needs_review", OWNER, 50, null)).status).toBe(500);
  });
});

describe("Assigned to me", () => {
  it.each([1, 2, 3, 25])("the reviewer's actionable items (governed + report review), limit %i", async (limit) => {
    const { ids, rows } = await pageAll(queue, "assigned_to_me", REVIEWER, "reviewer", limit);
    expect([...ids].sort()).toEqual(expectedAssignedToMe(seed, REVIEWER));
    expect(rows.every((r) => r.isAssignedToMe)).toBe(true);
    expect(ids.some((id) => id.startsWith("rr-"))).toBe(true);
  });

  it("the submitter never sees their own report reviews as assigned to them", async () => {
    const { ids } = await pageAll(queue, "assigned_to_me", SUBMITTER, "member", 2);
    expect(ids.filter((id) => id.startsWith("rr-"))).toEqual([]);
    expect(expectedAssignedToMe(seed, SUBMITTER)).toEqual([]);
  });
});

describe("concurrent changes between pages", () => {
  it("new submissions and status changes during paging: no duplicate, no stable item missed", async () => {
    const initial = expectedStatusView(seed, "needs_review");
    let flippedReached: string | null = null;
    const inserted: string[] = [];
    const emittedSoFar: string[] = [];
    const between = async (page: number) => {
      if (page === 1) {
        // (a) a submission OLDER than everything (lands after the cursor: must appear)
        const old = buildReportReviewRecord({ cycle: 1, scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 1, requestedModels: 1 }, purpose: { code: "other", note: null }, actorUid: SUBMITTER, now: "2026-11-02T09:00:00.000Z" });
        await db.collection("runs").doc("rr-late-old").set({ userId: CREATOR, workspaceId: W, projectId: null, question: "late", status: "complete", createdAt: Timestamp.fromMillis(Date.UTC(2020, 0, 1)), reportReview: old });
        inserted.push("rr-late-old");
        // (b) a submission NEWER than everything (lands before the cursor: correctly not on later pages)
        await db.collection("runs").doc("rr-late-new").set({ userId: CREATOR, workspaceId: W, projectId: null, question: "late", status: "complete", createdAt: Timestamp.fromMillis(Date.UTC(2030, 0, 1)), reportReview: old });
        // (c) an item not yet reached is decided: it leaves Needs review
        flippedReached = initial[initial.length - 1];
        const isGov = flippedReached.startsWith("gov-");
        await db.collection("runs").doc(flippedReached).update(isGov ? { "governanceRecord.humanReview": { status: "approved", reviewedAt: "2026-11-01T00:00:00.000Z", reviewerId: REVIEWER } } : { "reportReview.humanReview": { status: "approved", reviewedAt: "2026-11-01T00:00:00.000Z", reviewerId: REVIEWER } });
      }
    };
    const { ids } = await pageAll(queue, "needs_review", OWNER, "owner", 3, between);
    emittedSoFar.push(...ids);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of initial) if (id !== flippedReached) expect(ids).toContain(id); // every stable item
    expect(ids).not.toContain(flippedReached);
    for (const id of inserted) expect(ids).toContain(id);
    expect(ids).not.toContain("rr-late-new");
  });
});

describe("binding, mode and errors", () => {
  it("a cursor is bound to its Workspace, view and mode (merged v2 cursors are refused when Report Review is off, and vice versa)", async () => {
    const first = await call("needs_review", OWNER, 2, null);
    const merged = first.body.nextCursor as string;
    expect((await call("changes_requested", OWNER, 2, merged)).status).toBe(400);
    flags.REPORT_REVIEW_ENABLED = false;
    expect((await call("needs_review", OWNER, 2, merged)).status).toBe(400);
    const classic = (await call("needs_review", OWNER, 2, null)).body.nextCursor as string;
    flags.REPORT_REVIEW_ENABLED = true;
    expect((await call("needs_review", OWNER, 2, classic)).status).toBe(400);
  });

  it("another Workspace's caller cannot read this queue", async () => {
    const r = await call("needs_review", "q-stranger", 5, null);
    expect([403, 404]).toContain(r.status);
  });

  it("with Report Review OFF, status views list governed runs only, exactly as before", async () => {
    flags.REPORT_REVIEW_ENABLED = false;
    for (const view of VIEWS) {
      const { ids, rows } = await pageAll(queue, view, OWNER, "owner", 2);
      // Legacy behaviour exactly: only governance records are known. The seeded "both records" run (impossible by the
      // B1 invariant) is listed through its valid governed record, as before B2; the fail-closed exclusion applies only
      // while Report Review is enabled.
      const legacySeed = seed.map((r) => (r.id === "bad-both" ? { ...r, kind: "gov" as const, eligible: true } : r));
      expect(ids).toEqual(expectedStatusView(legacySeed, view).filter((id) => id.startsWith("gov-") || id === "bad-both"));
      expect(rows.every((r) => r.recordKind === undefined)).toBe(true);
    }
    const { ids } = await pageAll(queue, "assigned_to_me", REVIEWER, "reviewer", 3);
    expect([...ids].sort()).toEqual([...expectedAssignedToMe(seed, REVIEWER).filter((id) => id.startsWith("gov-")), "bad-both"].sort());
  });

  it("a query failure is an explicit error, never a silently incomplete page", async () => {
    const original = db.collection.bind(db);
    (db as unknown as { collection: unknown }).collection = (name: string) => {
      const c = original(name);
      if (name === "runs") (c as unknown as { where: unknown }).where = () => {
        throw new Error("UNAVAILABLE");
      };
      return c;
    };
    try {
      expect((await call("needs_review", OWNER, 3, null)).status).toBe(500);
    } finally {
      (db as unknown as { collection: unknown }).collection = original;
    }
  });
});
