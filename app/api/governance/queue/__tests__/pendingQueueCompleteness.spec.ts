/**
 * Roadmap 4.2b — the pending Governance queue is complete (Q1 + Q2 + Q3), and
 * the dashboard uses it as the source of truth.
 *
 * Stop condition (owner, fixed):
 *   For assigners scope and status=needs_review, every evaluated queue-eligible
 *   item across every assigned owner participates regardless of age, newer
 *   decided items, or reviewer owner-count. `total` exactly equals the
 *   post-containment eligible population. The dashboard uses that result — not
 *   the bounded `all` snapshot — for the pending list and count. A bounded
 *   history snapshot can never cause a pending item or count to disappear.
 *
 * The fake Firestore is faithful where the defect lived: equality and `in`
 * filters apply to stored fields, `orderBy` EXCLUDES documents missing the
 * field (as Firestore does), `limit` cuts, `select` projects, and every query
 * is recorded so its shape can be asserted. Queries resolve after a tick and
 * in-flight concurrency is measured.
 *
 * The dashboard half drives the REAL route through `loadQueueSources` (the
 * function the dashboard calls) and `buildQueueView` (the function that
 * produces its rows, note and counts).
 */

const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: REVIEWER, email: "reviewer@test-invented.example" }),
}));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...a: unknown[]) => mockedResolveVisibleUserIds(...a),
  runOwnerVisibleInGovernance: (v: string[] | null, o: string) => v === null || v.includes(o),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/workspaces/runWorkspaceIntegrityBatch", () => ({
  createRunWorkspaceIntegrityBatch: () => async (data: Record<string, unknown>) =>
    data.workspaceId === "ws-corrupt" ? { classification: "invalid", reason: "fixture" } : { classification: "legacy" },
}));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

type Doc = { id: string; data: Record<string, unknown> };
const collections: Record<string, Doc[]> = { runs: [], verifications: [], videoVerifications: [] };
type Filter = { f: string; op: string; v: unknown };
type QueryShape = { collection: string; filters: Filter[]; orderBy: string | null; limit: number | null };
const queries: QueryShape[] = [];
let inFlight = 0;
let maxInFlight = 0;

function makeQuery(collection: string, shape: QueryShape = { collection, filters: [], orderBy: null, limit: null }, fields: string[] | null = null): any {
  return {
    where: (f: string, op: string, v: unknown) => makeQuery(collection, { ...shape, filters: [...shape.filters, { f, op, v }] }, fields),
    orderBy: (f: string) => makeQuery(collection, { ...shape, orderBy: f }, fields),
    limit: (n: number) => makeQuery(collection, { ...shape, limit: n }, fields),
    select: (...fs: string[]) => makeQuery(collection, shape, fs),
    get: async () => {
      queries.push(shape);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      let rows = (collections[collection] ?? []).filter((d) =>
        shape.filters.every(({ f, op, v }) => (op === "in" ? (v as unknown[]).includes(d.data[f]) : d.data[f] === v))
      );
      if (shape.orderBy) {
        const key = shape.orderBy;
        rows = rows.filter((d) => d.data[key] !== undefined);
        rows = [...rows].sort((a, b) => millis(b.data[key]) - millis(a.data[key]));
      }
      if (shape.limit !== null) rows = rows.slice(0, shape.limit);
      const docs = rows.map((d) => ({
        id: d.id,
        data: () => (fields ? Object.fromEntries(Object.entries(d.data).filter(([k]) => fields.includes(k))) : { ...d.data }),
      }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}
function millis(v: unknown): number {
  return v && typeof v === "object" && "toMillis" in (v as object) ? (v as { toMillis: () => number }).toMillis() : 0;
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "users") return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    return makeQuery(name);
  },
  getAll: async (...refs: unknown[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import { buildQueueView, loadQueueSources, type QueueViewRow } from "@/components/governance/queueView";

const REVIEWER = "reviewer-uid";
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => Timestamp.fromMillis(Date.now() - ms);

function research(id: string, owner: string, status: string | undefined, ageMs: number, extra: Record<string, unknown> = {}): Doc {
  return {
    id,
    data: { userId: owner, question: `q ${id}`, createdAt: ago(ageMs), ...(status ? { governanceStatus: status } : {}), consensusScore: 40, ...extra },
  };
}
function claim(id: string, owner: string, status: string | undefined, ageMs: number, extra: Record<string, unknown> = {}): Doc {
  return {
    id,
    data: { userId: owner, type: "claim_verification", claim: `claim ${id}`, verdict: "accurate", timestamp: ago(ageMs), ...(status ? { governanceStatus: status } : {}), ...extra },
  };
}
function video(id: string, owner: string, status: string | undefined, ageMs: number, extra: Record<string, unknown> = {}): Doc {
  return {
    id,
    data: { userId: owner, type: "video_verification", fileName: `${id}.mp4`, verdict: "authentic_captured", metadata: { duration: 3 }, timestamp: ago(ageMs), ...(status ? { governanceStatus: status } : {}), ...extra },
  };
}

function asReviewerOf(owners: string[]) {
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: owners, isSupportAdmin: false, queueScope: "assigners" });
}
async function getQueue(qs: string) {
  const res = await GET(new NextRequest(`http://localhost/api/governance/queue${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { runs: Array<{ runId: string; governanceStatus: string }>; total: number };
}
const pending = (qs = "") => getQueue(`?status=needs_review&runType=all&limit=50&offset=0${qs}`);
const ids = (b: { runs: Array<{ runId: string }> }) => b.runs.map((r) => r.runId).sort();

beforeEach(() => {
  collections.runs = [];
  collections.verifications = [];
  collections.videoVerifications = [];
  queries.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  mockedResolveVisibleUserIds.mockReset();
});

describe("API — Q1: no age cutoff", () => {
  it("an 8+ day-old pending item of every kind is returned and counted", async () => {
    asReviewerOf(["owner-a"]);
    collections.runs = [research("r-old", "owner-a", "needs_review", 9 * DAY)];
    collections.verifications = [claim("c-old", "owner-a", "needs_review", 30 * DAY)];
    collections.videoVerifications = [video("v-old", "owner-a", "needs_review", 400 * DAY)];
    const b = await pending();
    expect(ids(b)).toEqual(["c-old", "r-old", "v-old"]);
    expect(b.total).toBe(3);
  });
});

describe("API — Q2: no fetch-then-filter", () => {
  it("26 newer decided items ahead of an older pending item do not hide it", async () => {
    asReviewerOf(["owner-a"]);
    collections.runs = [
      ...Array.from({ length: 26 }, (_, i) => research(`r-decided-${i}`, "owner-a", i % 2 ? "approved" : "blocked", 60_000 + i)),
      research("r-pending-older", "owner-a", "needs_review", 2 * DAY),
    ];
    collections.verifications = Array.from({ length: 26 }, (_, i) => claim(`c-decided-${i}`, "owner-a", "approved", 60_000 + i));
    collections.verifications.push(claim("c-pending-older", "owner-a", "needs_review", 3 * DAY));
    const b = await pending();
    expect(ids(b)).toEqual(["c-pending-older", "r-pending-older"]);
    expect(b.total).toBe(2);
  });

  it("pending queries carry no limit, no orderBy and no cross-owner `in`", async () => {
    asReviewerOf(["owner-a", "owner-b"]);
    await pending();
    expect(queries.length).toBe(6);
    for (const q of queries) {
      expect(q.limit).toBeNull();
      expect(q.orderBy).toBeNull();
      expect(q.filters).toEqual([
        { f: "userId", op: "==", v: expect.stringMatching(/^owner-[ab]$/) },
        { f: "governanceStatus", op: "==", v: "needs_review" },
      ]);
    }
  });

  it("a pending row missing its timestamp field is still returned (sorted last), never dropped", async () => {
    asReviewerOf(["owner-a"]);
    const noTime = research("r-no-createdAt", "owner-a", "needs_review", 0);
    delete noTime.data.createdAt;
    collections.runs = [noTime, research("r-timed", "owner-a", "needs_review", DAY)];
    const b = await pending();
    expect(b.runs.map((r) => r.runId)).toEqual(["r-timed", "r-no-createdAt"]);
    expect(b.total).toBe(2);
  });
});

describe("API — Q3: no 30-owner ceiling, bounded concurrency", () => {
  it("35 owners: every owner's pending item is returned and counted", async () => {
    const owners = Array.from({ length: 35 }, (_, i) => `owner-${String(i).padStart(2, "0")}`);
    asReviewerOf(owners);
    collections.verifications = owners.map((o, i) => claim(`c-${o}`, o, "needs_review", (i + 1) * 60_000));
    const b = await pending();
    expect(b.total).toBe(35);
    expect(ids(b)).toEqual(owners.map((o) => `c-${o}`).sort());
    expect(ids(b)).toContain("c-owner-34");
  });

  it("per-owner queries run with bounded concurrency", async () => {
    const owners = Array.from({ length: 40 }, (_, i) => `owner-${i}`);
    asReviewerOf(owners);
    await pending();
    expect(queries.length).toBe(120);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });
});

describe("API — containment and contract boundary: excluded from rows AND total", () => {
  beforeEach(() => {
    asReviewerOf(["owner-a"]);
    collections.runs = [
      research("r-ok", "owner-a", "needs_review", DAY),
      research("r-integrity-invalid", "owner-a", "needs_review", DAY, { workspaceId: "ws-corrupt" }),
      research("r-no-status", "owner-a", undefined, DAY),
    ];
    collections.verifications = [
      claim("c-ok", "owner-a", "needs_review", DAY),
      claim("c-workspace", "owner-a", "needs_review", DAY, { workspaceId: "ws-team-1" }),
      claim("c-no-status", "owner-a", undefined, DAY),
    ];
    collections.videoVerifications = [
      video("v-ok", "owner-a", "needs_review", DAY),
      video("v-workspace", "owner-a", "needs_review", DAY, { workspaceId: "ws-team-1" }),
      video("v-no-status", "owner-a", undefined, DAY),
    ];
  });

  it("Workspace Claims/Videos, integrity-invalid Research and missing-status rows are excluded", async () => {
    const b = await pending();
    expect(ids(b)).toEqual(["c-ok", "r-ok", "v-ok"]);
    expect(b.total).toBe(3);
  });

  it("an unassigned owner's pending item never appears", async () => {
    collections.runs.push(research("r-stranger", "stranger", "needs_review", DAY));
    const b = await pending();
    expect(ids(b)).not.toContain("r-stranger");
    expect(b.total).toBe(3);
  });
});

describe("API — pagination never changes the total", () => {
  it("every page reports the same exact total, and the pages partition the set", async () => {
    asReviewerOf(["owner-a", "owner-b"]);
    collections.runs = Array.from({ length: 45 }, (_, i) => research(`r-${String(i).padStart(2, "0")}`, i % 2 ? "owner-a" : "owner-b", "needs_review", (i % 7) * 60_000));
    const pages = await Promise.all([0, 20, 40].map((offset) => getQueue(`?status=needs_review&runType=all&limit=20&offset=${offset}`)));
    expect(pages.map((p) => p.total)).toEqual([45, 45, 45]);
    expect(pages.map((p) => p.runs.length)).toEqual([20, 20, 5]);
    const all = pages.flatMap((p) => p.runs.map((r) => r.runId));
    expect(new Set(all).size).toBe(45);
  });
});

describe("dashboard — the pending response is the source of truth", () => {
  const fetchQueue = (status: "needs_review" | "all") =>
    GET(new NextRequest(`http://localhost/api/governance/queue?status=${status}&runType=all&limit=50&offset=0`)) as unknown as Promise<Response>;
  const readError = async (_r: Response, fallback: string) => fallback;

  function seed51PendingAnd50NewerDecided() {
    asReviewerOf(["owner-a"]);
    collections.runs = [
      ...Array.from({ length: 51 }, (_, i) => research(`p-${String(i).padStart(2, "0")}`, "owner-a", "needs_review", DAY + i * 60_000)),
      ...Array.from({ length: 50 }, (_, i) => research(`d-${String(i).padStart(2, "0")}`, "owner-a", i % 2 ? "approved" : "blocked", 60_000 + i)),
    ];
  }

  it("51 pending: API total 51; the pending view shows the first 50 and 'Showing 50 of 51 pending'", async () => {
    seed51PendingAnd50NewerDecided();
    const loaded = await loadQueueSources<QueueViewRow>(fetchQueue, readError);
    expect(loaded.pending).toMatchObject({ state: "ok", total: 51 });
    const view = buildQueueView({ pending: loaded.pending, history: loaded.history, status: "needs_review", runType: "all" });
    expect(view.rows).toHaveLength(50);
    expect(view.rows.every((r) => r.governanceStatus === "needs_review")).toBe(true);
    expect(view.rows.map((r) => r.runId)).toEqual(Array.from({ length: 50 }, (_, i) => `p-${String(i).padStart(2, "0")}`));
    expect(view.pendingNote).toBe("Showing 50 of 51 pending");
    expect(view.stats.needs).toBe(51);
  });

  it("50 newer decided rows filling the `all` snapshot change neither the pending count nor the pending rows", async () => {
    seed51PendingAnd50NewerDecided();
    const loaded = await loadQueueSources<QueueViewRow>(fetchQueue, readError);
    // The bounded history snapshot is full of newer decided rows and contains no pending row.
    expect(loaded.history.state).toBe("ok");
    const historyRows = loaded.history.state === "ok" ? loaded.history.rows : [];
    expect(historyRows.length).toBeGreaterThan(0);
    expect(historyRows.some((r) => r.governanceStatus === "needs_review")).toBe(false);

    const pendingView = buildQueueView({ pending: loaded.pending, history: loaded.history, status: "needs_review", runType: "all" });
    expect(pendingView.rows).toHaveLength(50);
    expect(pendingView.stats.needs).toBe(51);

    // The `all` view keeps every returned pending row; history only fills what is left.
    const allView = buildQueueView({ pending: loaded.pending, history: loaded.history, status: "all", runType: "all" });
    const pendingIds = pendingView.rows.map((r) => r.runId);
    expect(allView.rows.map((r) => r.runId)).toEqual(expect.arrayContaining(pendingIds));
    expect(allView.rows.filter((r) => r.governanceStatus === "needs_review")).toHaveLength(50);
  });

  it("a failed history load leaves the pending queue intact", async () => {
    seed51PendingAnd50NewerDecided();
    const loaded = await loadQueueSources<QueueViewRow>(
      (status) => (status === "all" ? Promise.resolve(new Response("{}", { status: 500 })) : fetchQueue(status)),
      readError
    );
    expect(loaded.history.state).toBe("error");
    const view = buildQueueView({ pending: loaded.pending, history: loaded.history, status: "needs_review", runType: "all" });
    expect(view.rows).toHaveLength(50);
    expect(view.stats.needs).toBe(51);
    expect(view.errors).toEqual([]);
  });

  it("a failed pending load is an error — never the snapshot's pending rows or count", async () => {
    asReviewerOf(["owner-a"]);
    collections.runs = [research("p-recent", "owner-a", "needs_review", 60_000)];
    const loaded = await loadQueueSources<QueueViewRow>(
      (status) => (status === "needs_review" ? Promise.resolve(new Response("{}", { status: 500 })) : fetchQueue(status)),
      readError
    );
    // The snapshot DOES contain the pending row — it must not be used.
    expect(loaded.history.state === "ok" && loaded.history.rows.some((r) => r.runId === "p-recent")).toBe(true);
    const view = buildQueueView({ pending: loaded.pending, history: loaded.history, status: "needs_review", runType: "all" });
    expect(view.rows).toEqual([]);
    expect(view.stats.needs).toBeNull();
    expect(view.errors).toHaveLength(1);
    expect(view.errors[0]).toMatch(/Pending queue could not be loaded/);
  });
});
