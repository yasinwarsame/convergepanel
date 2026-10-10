/**
 * Order 3 — the Firestore adapter: ONLY aggregation count() queries plus the
 * Step 6.3 Project preflight count and bounded listing. The fake db exposes
 * exactly `where` + `count` on `runs`: any `.get()`, `limit`, `orderBy`,
 * cursor, write or listener on an artifact query would throw, so their absence
 * is enforced, not assumed.
 */
import { Timestamp } from "firebase-admin/firestore";
import { loadReviewIntegrityMetrics } from "@/lib/governance/reviewIntegrityMetricsFirestore";
import { WORKSPACE_PROJECT_CEILING } from "@/lib/governance/workspaceGovernanceSummaryFirestore";

jest.mock("server-only", () => ({}));

const W = "ws-1";
type Call = { collection: string; wheres: Array<[string, string, unknown]>; attempt: number };

function fakeDb(opts: { countFor?: (c: Call) => number; projects?: Array<{ id: string; data: unknown }>; projectCount?: number; throwOnCount?: Error } = {}) {
  const calls: Call[] = [];
  let listings = 0;
  let preflights = 0;
  const artifactQuery = (call: Omit<Call, "attempt">): Record<string, unknown> => ({
    where: (f: string, op: string, v: unknown) => artifactQuery({ ...call, wheres: [...call.wheres, [f, op, v]] }),
    count: () => ({
      get: async () => {
        if (opts.throwOnCount) throw opts.throwOnCount;
        const c = { ...call, attempt: listings };
        calls.push(c);
        return { data: () => ({ count: opts.countFor ? opts.countFor(c) : 0 }) };
      },
    }),
  });
  const db = {
    collection: (name: string) => {
      if (name === "projects") {
        return {
          where: () => ({
            count: () => ({
              get: async () => {
                preflights += 1;
                return { data: () => ({ count: opts.projectCount ?? (opts.projects ?? []).length }) };
              },
            }),
            limit: (n: number) => ({
              get: async () => {
                listings += 1;
                return { docs: (opts.projects ?? []).slice(0, n).map((p) => ({ id: p.id, data: () => p.data })) };
              },
            }),
          }),
        };
      }
      if (name !== "runs") throw new Error(`unexpected collection ${name}`);
      return artifactQuery({ collection: name, wheres: [] });
    },
  };
  return { db: db as never, calls, listings: () => listings, preflights: () => preflights };
}

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  data: { schemaVersion: 1, id, workspaceId: W, name: "P", status: "active", createdByUserId: "u", createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1), ...over },
});
const projectIn = (c: Call) => c.wheres.find(([f, op]) => f === "projectId" && op === "in")?.[2] as string[] | undefined;
const isPendingState = (c: Call) => c.wheres.some(([f, op, v]) => f === "governanceRecord.humanReview.status" && op === "==" && v === "pending") && !c.wheres.some(([f]) => f === "governanceRecord.humanReview.decidedVia");

it("empty Workspace: 1 preflight, 1 listing, 21 counts on `runs` only, and an all-zero result", async () => {
  const f = fakeDb();
  const r = await loadReviewIntegrityMetrics(f.db, W);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.metrics.totals.completedAdaptiveResearch).toBe(0);
  expect(f.preflights()).toBe(1);
  expect(f.listings()).toBe(1);
  expect(f.calls).toHaveLength(21);
});

it("only canonical Projects are queried: malformed, foreign-Workspace and id-mismatched Project documents are excluded", async () => {
  const f = fakeDb({ projects: [project("P1"), project("P-foreign", { workspaceId: "ws-other" }), project("P-mismatch", { id: "other-id" }), { id: "P-malformed", data: { nonsense: true } }] });
  const r = await loadReviewIntegrityMetrics(f.db, W);
  expect(r.ok).toBe(true);
  const batches = f.calls.map(projectIn).filter((x): x is string[] => !!x);
  expect(batches.length).toBeGreaterThan(0);
  for (const b of batches) expect(b).toEqual(["P1"]);
  const equalityProjects = new Set(f.calls.flatMap((c) => c.wheres.filter(([fld, op, v]) => fld === "projectId" && op === "==" && v !== null).map(([, , v]) => v)));
  expect([...equalityProjects]).toEqual(["P1"]);
});

it(`at the ${WORKSPACE_PROJECT_CEILING}-Project ceiling: 70 counts per computation`, async () => {
  const f = fakeDb({ projects: Array.from({ length: WORKSPACE_PROJECT_CEILING }, (_, i) => project(`P${i + 1}`)) });
  expect((await loadReviewIntegrityMetrics(f.db, W)).ok).toBe(true);
  expect(f.calls).toHaveLength(70);
});

it("above the ceiling (preflight) → workspace_too_large with NO listing and NO count", async () => {
  const f = fakeDb({ projectCount: WORKSPACE_PROJECT_CEILING + 1 });
  expect(await loadReviewIntegrityMetrics(f.db, W)).toEqual({ ok: false, reason: "workspace_too_large", projectCeiling: WORKSPACE_PROJECT_CEILING });
  expect(f.listings()).toBe(0);
  expect(f.calls).toHaveLength(0);
});

it("a Project created between preflight and listing (listing exceeds the ceiling) → workspace_too_large, no count", async () => {
  const f = fakeDb({ projectCount: WORKSPACE_PROJECT_CEILING, projects: Array.from({ length: WORKSPACE_PROJECT_CEILING + 1 }, (_, i) => project(`P${i + 1}`)) });
  expect((await loadReviewIntegrityMetrics(f.db, W)).ok).toBe(false);
  expect(f.calls).toHaveLength(0);
});

it("an inconsistent first computation is retried ONCE in full (Project listing re-read) and the consistent retry is returned", async () => {
  const f = fakeDb({ countFor: (c) => (c.attempt === 1 && isPendingState(c) && !projectIn(c) ? 5 : 0) });
  const r = await loadReviewIntegrityMetrics(f.db, W);
  expect(r.ok).toBe(true);
  expect(f.listings()).toBe(2);
  expect(f.calls).toHaveLength(42);
  if (r.ok) expect(r.metrics.totals.completedAdaptiveResearch).toBe(0);
});

it("MUTATION E (adapter): inconsistent twice → `inconsistent`, never a number; exactly two attempts", async () => {
  const f = fakeDb({ countFor: (c) => (isPendingState(c) && !projectIn(c) ? 5 : 0) });
  expect(await loadReviewIntegrityMetrics(f.db, W)).toEqual({ ok: false, reason: "inconsistent" });
  expect(f.listings()).toBe(2);
  expect(f.calls).toHaveLength(42);
});

it("a Firestore failure that is not an inconsistency propagates (no retry, no partial result)", async () => {
  const f = fakeDb({ throwOnCount: new Error("9 FAILED_PRECONDITION: The query requires an index.") });
  await expect(loadReviewIntegrityMetrics(f.db, W)).rejects.toThrow("FAILED_PRECONDITION");
  expect(f.listings()).toBe(1);
});
