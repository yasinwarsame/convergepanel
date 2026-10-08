/**
 * Step 6.3 — the Firestore adapter does ONLY aggregation count() queries and
 * the Project listing read. The fake db exposes exactly `where` and `count` on
 * artifact queries: any `.get()`, `limit`, `orderBy`, cursor, `offset`, write or
 * listener on an artifact collection would throw, so their absence is enforced,
 * not assumed.
 */
import { Timestamp } from "firebase-admin/firestore";
import { firestoreCountExecutor, loadCanonicalProjectIds, loadWorkspaceGovernanceSummary } from "@/lib/governance/workspaceGovernanceSummaryFirestore";
import type { CountSpec } from "@/lib/governance/workspaceGovernanceSummary";

type Call = { collection: string; wheres: Array<[string, string, unknown]> };

function fakeDb(opts: { countFor?: (c: Call, attempt: number) => number; projects?: Array<{ id: string; data: unknown }> } = {}) {
  const calls: Call[] = [];
  const projectReads: Array<[string, string, unknown]> = [];
  let attempt = 0;
  const artifactQuery = (call: Call): Record<string, unknown> => ({
    where: (f: string, op: string, v: unknown) => artifactQuery({ ...call, wheres: [...call.wheres, [f, op, v]] }),
    count: () => ({
      get: async () => {
        calls.push(call);
        return { data: () => ({ count: opts.countFor ? opts.countFor(call, attempt) : 0 }) };
      },
    }),
  });
  const db = {
    collection: (name: string) => {
      if (name === "projects") {
        return {
          where: (f: string, op: string, v: unknown) => {
            projectReads.push([f, op, v]);
            return { get: async () => ({ docs: (opts.projects ?? []).map((p) => ({ id: p.id, data: () => p.data })) }) };
          },
        };
      }
      return artifactQuery({ collection: name, wheres: [] });
    },
  };
  return { db: db as never, calls, projectReads, nextAttempt: () => (attempt += 1) };
}

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  data: { schemaVersion: 1, id, workspaceId: "ws-1", name: "P", status: "active", createdByUserId: "u", createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1), ...over },
});

describe("firestoreCountExecutor", () => {
  it("translates a spec into where(...) clauses + count().get() — nothing else", async () => {
    const f = fakeDb({ countFor: () => 7 });
    const spec: CountSpec = { collection: "runs", filters: [{ field: "workspaceId", op: "==", value: "ws-1" }, { field: "governanceStatus", op: "not-in", value: ["approved"] }] };
    expect(await firestoreCountExecutor(f.db)(spec)).toBe(7);
    expect(f.calls).toEqual([{ collection: "runs", wheres: [["workspaceId", "==", "ws-1"], ["governanceStatus", "not-in", ["approved"]]] }]);
  });
});

describe("loadCanonicalProjectIds", () => {
  it("reads the Workspace's Project listing and keeps only getProject()-valid Projects (active and archived)", async () => {
    const f = fakeDb({
      projects: [project("a"), project("b", { status: "archived" }), project("c", { schemaVersion: 2 }), project("d", { id: "other-id" }), project("e", { workspaceId: "ws-other" }), project("f", { createdAt: "not-a-timestamp" })],
    });
    expect(await loadCanonicalProjectIds(f.db, "ws-1")).toEqual(["a", "b"]);
    expect(f.projectReads).toEqual([["workspaceId", "==", "ws-1"]]);
  });
});

describe("loadWorkspaceGovernanceSummary", () => {
  it("a consistent snapshot returns the summary; only count() queries touch artifact collections", async () => {
    const f = fakeDb({ projects: [project("a")] });
    const r = await loadWorkspaceGovernanceSummary(f.db, "ws-1");
    expect(r.ok).toBe(true);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(new Set(f.calls.map((c) => c.collection))).toEqual(new Set(["runs", "verifications", "videoVerifications"]));
  });

  it("counts that cannot be reconciled are retried once, then reported unavailable — never returned", async () => {
    let loads = 0;
    const f = fakeDb({
      countFor: (c) => (c.wheres.some(([field, op]) => field === "governanceStatus" && op === "==") ? 1 : 0),
    });
    const original = f.db as unknown as { collection: (n: string) => unknown };
    const counting = { collection: (n: string) => (n === "projects" ? (loads += 1, original.collection(n)) : original.collection(n)) };
    const r = await loadWorkspaceGovernanceSummary(counting as never, "ws-1");
    expect(r).toEqual({ ok: false, reason: "inconsistent" });
    expect(loads).toBe(2);
  });
});
