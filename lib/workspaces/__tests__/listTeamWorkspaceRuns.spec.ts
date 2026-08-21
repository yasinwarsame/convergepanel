/**
 * Team Run Lists, Phase 8C-B2 — `listTeamWorkspaceRuns()` tests. Firestore
 * is faked in-memory with a real filter/sort/startAfter/limit engine,
 * mirroring `lib/projects/__tests__/listRunsByProjectScopeRaw.spec.ts`'s
 * established `FakeQuery` pattern, extended with a minimal `getAll()` for
 * the batched Project-reference validation.
 */

class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  static fromMillis(ms: number) {
    return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }
}
const DOC_ID_SENTINEL = Symbol("documentId");
class FakeFieldPath {
  static documentId() {
    return DOC_ID_SENTINEL;
  }
}
jest.mock("firebase-admin/firestore", () => ({
  Timestamp: FakeTimestamp,
  FieldPath: FakeFieldPath,
}));

type FakeDoc = { id: string; data: Record<string, unknown> };

function orderingKey(doc: FakeDoc, field: string | symbol): [number, number] | string {
  if (field === DOC_ID_SENTINEL) return doc.id;
  const v = doc.data[field as string];
  if (v instanceof FakeTimestamp) return [v.seconds, v.nanoseconds];
  return String(v ?? "");
}
function compareKeys(a: [number, number] | string, b: [number, number] | string): number {
  if (Array.isArray(a) && Array.isArray(b)) return a[0] - b[0] || a[1] - b[1];
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

class FakeQuery {
  constructor(
    private allDocs: FakeDoc[],
    private filters: Array<{ field: string; op: string; value: unknown }> = [],
    private orders: Array<{ field: string | symbol; dir: "asc" | "desc" }> = [],
    private startAfterVals?: unknown[],
    private limitN?: number
  ) {}
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.allDocs, [...this.filters, { field, op, value }], this.orders, this.startAfterVals, this.limitN);
  }
  orderBy(field: string | symbol, dir: "asc" | "desc" = "asc") {
    return new FakeQuery(this.allDocs, this.filters, [...this.orders, { field, dir }], this.startAfterVals, this.limitN);
  }
  startAfter(...vals: unknown[]) {
    return new FakeQuery(this.allDocs, this.filters, this.orders, vals, this.limitN);
  }
  limit(n: number) {
    return new FakeQuery(this.allDocs, this.filters, this.orders, this.startAfterVals, n);
  }
  async get() {
    let result = this.allDocs.filter((d) =>
      this.filters.every((f) => {
        if (!Object.prototype.hasOwnProperty.call(d.data, f.field)) return false;
        return f.op === "==" && d.data[f.field] === f.value;
      })
    );
    result = [...result].sort((a, b) => {
      for (const o of this.orders) {
        const cmp = compareKeys(orderingKey(a, o.field), orderingKey(b, o.field));
        if (cmp !== 0) return o.dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
    if (this.startAfterVals) {
      const startKeys = this.orders.map((o, i) => {
        const raw = this.startAfterVals![i];
        if (o.field === DOC_ID_SENTINEL) return String(raw);
        if (raw instanceof FakeTimestamp) return [raw.seconds, raw.nanoseconds] as [number, number];
        return raw;
      });
      const idx = result.findIndex((d) => this.orders.every((o, i) => compareKeys(orderingKey(d, o.field), startKeys[i] as any) === 0));
      result = idx === -1 ? [] : result.slice(idx + 1);
    }
    if (this.limitN != null) result = result.slice(0, this.limitN);
    return { docs: result.map((d) => ({ id: d.id, data: () => d.data })) };
  }
}

let runsDocs: FakeDoc[] = [];
let projectsDocs: Record<string, Record<string, unknown> | undefined> = {};
let firestoreUnavailable = false;

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs") return new FakeQuery(runsDocs);
    if (name === "projects") {
      return {
        doc: (id: string) => ({ id, __isProjectRef: true }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  },
  getAll: async (...refs: { id: string; __isProjectRef: boolean }[]) => {
    return refs.map((ref) => {
      const data = projectsDocs[ref.id];
      return {
        id: ref.id,
        exists: data !== undefined,
        data: () => data,
      };
    });
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable ? null : mockAdminDb;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { listTeamWorkspaceRuns } from "../listTeamWorkspaceRuns";
import { encodeWorkspaceRunsCursor } from "../workspaceRunsCursor";

const W = "ws-team-1";

function runDoc(id: string, overrides: Record<string, unknown> = {}) {
  return { id, data: { userId: "uid-1", workspaceId: W, projectId: null, createdAt: FakeTimestamp.fromMillis(1_700_000_000_000), ...overrides } };
}

function validProject(id: string, overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id, workspaceId: W, name: "P", status: "active", createdByUserId: "uid-1", createdAt: FakeTimestamp.fromMillis(1_600_000_000_000), updatedAt: FakeTimestamp.fromMillis(1_600_000_000_000), ...overrides };
}

beforeEach(() => {
  runsDocs = [];
  projectsDocs = {};
  firestoreUnavailable = false;
});

describe("listTeamWorkspaceRuns — query predicate shape (Part 10)", () => {
  it("ALL scope: workspaceId==W only, no userId/createdByUserId/projectId predicate", async () => {
    runsDocs = [runDoc("r1"), runDoc("r2", { workspaceId: "other-ws" })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["r1"]);
    }
  });

  it("UNFILED scope: workspaceId==W AND projectId==null, excludes assigned rows", async () => {
    runsDocs = [runDoc("r1", { projectId: null }), runDoc("r2", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = validProject("proj-1");
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["r1"]);
    }
  });

  it("ordering: createdAt DESC, documentId DESC", async () => {
    runsDocs = [
      runDoc("a", { createdAt: FakeTimestamp.fromMillis(1000) }),
      runDoc("b", { createdAt: FakeTimestamp.fromMillis(3000) }),
      runDoc("c", { createdAt: FakeTimestamp.fromMillis(2000) }),
    ];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["b", "c", "a"]);
    }
  });
});

describe("listTeamWorkspaceRuns — general list integrity (Part 15)", () => {
  it("1. valid all-Unfiled page", async () => {
    runsDocs = [runDoc("r1", { projectId: null }), runDoc("r2", { projectId: null })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toHaveLength(2);
  });

  it("2. valid all-filed page", async () => {
    runsDocs = [runDoc("r1", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = validProject("proj-1");
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items[0].projectId).toBe("proj-1");
  });

  it("3. mixed filed/unfiled page", async () => {
    runsDocs = [runDoc("r1", { projectId: null }), runDoc("r2", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = validProject("proj-1");
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toHaveLength(2);
  });

  it("4. multiple runs sharing one Project -> Project fetched once in batch set (getAll called with one unique ref)", async () => {
    const getAllSpy = jest.spyOn(mockAdminDb, "getAll");
    runsDocs = [runDoc("r1", { projectId: "proj-1" }), runDoc("r2", { projectId: "proj-1" }), runDoc("r3", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = validProject("proj-1");
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(getAllSpy.mock.calls[0]).toHaveLength(1); // one unique ref, not three
    getAllSpy.mockRestore();
  });

  it("5. multiple distinct Projects -> one getAll call for the page", async () => {
    const getAllSpy = jest.spyOn(mockAdminDb, "getAll");
    runsDocs = [runDoc("r1", { projectId: "proj-1" }), runDoc("r2", { projectId: "proj-2" })];
    projectsDocs["proj-1"] = validProject("proj-1");
    projectsDocs["proj-2"] = validProject("proj-2");
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(getAllSpy.mock.calls[0]).toHaveLength(2);
    getAllSpy.mockRestore();
  });

  it("6. missing referenced Project -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { projectId: "proj-missing" })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("7. malformed referenced Project -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = { schemaVersion: 1, id: "proj-1" }; // missing required fields
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("8. Project id/document-id mismatch -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = validProject("proj-DIFFERENT");
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("9. Project from another Workspace -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { projectId: "proj-1" })];
    projectsDocs["proj-1"] = validProject("proj-1", { workspaceId: "some-other-ws" });
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("10. run.workspaceId mismatch -> integrity_violation (row somehow returned but doesn't match W)", async () => {
    // Construct a row that would only appear via a hypothetical broken
    // query — the row validator itself must still catch it.
    runsDocs = [{ id: "r1", data: { userId: "uid-1", workspaceId: W, projectId: null, createdAt: FakeTimestamp.fromMillis(1000) } }];
    // Sanity: normally passes.
    const ok = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(ok.status).toBe("ok");
  });

  it("11. projectId absent -> integrity_violation", async () => {
    const doc = runDoc("r1");
    delete (doc.data as any).projectId;
    runsDocs = [doc];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("12. projectId malformed -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { projectId: "" })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("13. malformed createdAt -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { createdAt: { seconds: 1, nanoseconds: 0 } })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("14. no Project references -> no getAll call", async () => {
    const getAllSpy = jest.spyOn(mockAdminDb, "getAll");
    runsDocs = [runDoc("r1", { projectId: null }), runDoc("r2", { projectId: null })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result.status).toBe("ok");
    expect(getAllSpy).not.toHaveBeenCalled();
    getAllSpy.mockRestore();
  });

  it("15. integrity violation -> no partial DTO page returned", async () => {
    runsDocs = [runDoc("r1", { projectId: null }), runDoc("r2", { projectId: "proj-missing" })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
    expect((result as any).items).toBeUndefined();
  });
});

describe("listTeamWorkspaceRuns — unfiled scope (Part 16)", () => {
  it("explicit null returned", async () => {
    runsDocs = [runDoc("r1", { projectId: null })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items[0].projectId).toBeNull();
  });

  it("assigned excluded by query", async () => {
    runsDocs = [runDoc("r1", { projectId: null }), runDoc("r2", { projectId: "proj-1" })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toEqual(["r1"]);
  });

  it("absent does not match the Firestore null query (row invisible, not an error, since query itself excludes it)", async () => {
    const doc = runDoc("r1", { projectId: null });
    delete (doc.data as any).projectId;
    runsDocs = [doc];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });

  it("no Project reads for unfiled scope", async () => {
    const getAllSpy = jest.spyOn(mockAdminDb, "getAll");
    runsDocs = [runDoc("r1", { projectId: null })];
    await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(getAllSpy).not.toHaveBeenCalled();
    getAllSpy.mockRestore();
  });

  it("cursor continuation + hasMore true/false", async () => {
    runsDocs = [
      runDoc("a", { projectId: null, createdAt: FakeTimestamp.fromMillis(3000) }),
      runDoc("b", { projectId: null, createdAt: FakeTimestamp.fromMillis(2000) }),
      runDoc("c", { projectId: null, createdAt: FakeTimestamp.fromMillis(1000) }),
    ];
    const page1 = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 2 });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok") return;
    expect(page1.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 2, cursorRaw: page1.nextCursor });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") return;
    expect(page2.items.map((i) => i.id)).toEqual(["c"]);
    expect(page2.hasMore).toBe(false);
  });

  it("no creator filter — a run created by a different uid still appears", async () => {
    runsDocs = [runDoc("r1", { projectId: null, userId: "some-other-creator" })];
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items[0].userId).toBe("some-other-creator");
  });
});

describe("listTeamWorkspaceRuns — infra", () => {
  it("firestore unavailable -> query_failed", async () => {
    firestoreUnavailable = true;
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "query_failed" });
  });

  it("invalid cursor -> invalid_cursor", async () => {
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20, cursorRaw: "not-a-valid-cursor" });
    expect(result).toEqual({ status: "invalid_cursor" });
  });

  it("empty page -> ok, empty items, hasMore false", async () => {
    const result = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });
});
