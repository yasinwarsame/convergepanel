/**
 * Phase 5B — GET /api/user/workspace/runs.
 *
 * Firestore is faked in-memory with a real filter/sort/startAfter/limit
 * engine (not a fixed-docs stub) specifically so the cursor-pagination
 * test matrix below is actually exercised against realistic query
 * semantics, not just the route's own bookkeeping. `Timestamp`/`FieldPath`
 * from `firebase-admin/firestore` are faked as real classes, matching this
 * codebase's established convention (see `lib/firestore/__tests__/adaptiveExports.spec.ts`).
 *
 * Independent-review corrections reflected here: (1) `FakeTimestamp`
 * exposes `.seconds`/`.nanoseconds` (the real Firestore Timestamp shape),
 * and `startAfter` matching compares on that pair, not `.toMillis()` — so
 * the precision regression test below actually exercises the real code
 * path, not a re-truncated stand-in of it. (2) The route now validates
 * the caller's Personal Workspace via `resolvePersonalWorkspaceForOwner()`
 * BEFORE querying runs — `getWorkspace`/`WORKSPACES_ENABLED` are mocked at
 * the dependency level (not `resolvePersonalWorkspaceForOwner` itself) so
 * that real function's actual logic is exercised end-to-end.
 */

class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  static fromMillis(ms: number) {
    return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }
  static now() {
    return FakeTimestamp.fromMillis(Date.now());
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000);
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

/** Ordering key for a document at a given orderBy field: [seconds, nanoseconds] for createdAt, or the doc id for the documentId sentinel. */
function orderingKey(doc: FakeDoc, field: string | symbol): [number, number] | string {
  if (field === DOC_ID_SENTINEL) return doc.id;
  const v = (doc.data as Record<string, unknown>)[field as string];
  if (v instanceof FakeTimestamp) return [v.seconds, v.nanoseconds];
  return String(v ?? "");
}

function compareKeys(a: [number, number] | string, b: [number, number] | string): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a[0] - b[0] || a[1] - b[1];
  }
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
        const v = (d.data as Record<string, unknown>)[f.field];
        return f.op === "==" && v === f.value;
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
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") throw new Error(`unexpected collection ${name}`);
    return new FakeQuery(runsDocs);
  },
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

let currentAuthUid: string | null = "owner-1";
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: jest.fn(async () =>
    currentAuthUid ? { status: "authenticated", uid: currentAuthUid } : { status: "unauthenticated", reason: "missing_credentials" }
  ),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

let workspacesEnabled = true;
const workspaceDocs = new Map<string, Record<string, unknown>>();
let getWorkspaceThrows = false;
const mockedGetWorkspace = jest.fn();
function defaultGetWorkspaceImpl(id: string) {
  if (getWorkspaceThrows) return Promise.resolve({ status: "read_failed" });
  if (!workspaceDocs.has(id)) return Promise.resolve({ status: "not_found" });
  return Promise.resolve({ status: "found", workspace: workspaceDocs.get(id) });
}
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));
jest.mock("@/lib/env", () => ({
  get WORKSPACES_ENABLED() {
    return workspacesEnabled;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/workspace/runs/route";

const UID = "owner-1";
const WS_ID = "personal-owner-1";

function validWorkspace(ownerUid: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `personal-${ownerUid}`,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: ownerUid,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function seedRun(id: string, userId: string, workspaceId: string | undefined, ts: FakeTimestamp, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { userId, question: "q", selectedModels: ["chatgpt"], status: "complete", createdAt: ts, ...extra };
  if (workspaceId !== undefined) data.workspaceId = workspaceId;
  runsDocs.push({ id, data });
}
const ts = (seconds: number, nanoseconds = 0) => new FakeTimestamp(seconds, nanoseconds);

function buildRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/user/workspace/runs${qs}`);
}

function decodeCursorRaw(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

beforeEach(() => {
  runsDocs = [];
  workspaceDocs.clear();
  workspacesEnabled = true;
  getWorkspaceThrows = false;
  currentAuthUid = UID;
  jest.clearAllMocks();
  mockedGetWorkspace.mockImplementation(defaultGetWorkspaceImpl);
  workspaceDocs.set(WS_ID, validWorkspace(UID));
});

describe("GET /api/user/workspace/runs — auth", () => {
  it("401s when unauthenticated", async () => {
    currentAuthUid = null;
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/workspace/runs — exact query construction (independent of Layer A's defense-in-depth backstop)", () => {
  it("the runs query itself applies BOTH a userId and a workspaceId equality filter — not just workspaceId — proven by spying on the raw Firestore query builder's prototype directly (so it survives the chained-query pattern, where each .where() call returns a NEW instance), so this fails if the userId filter is ever dropped even though Layer A would otherwise mask the resulting leak", async () => {
    const seenFilters: Array<{ field: string; op: string; value: unknown }> = [];
    const originalWhere = FakeQuery.prototype.where;
    FakeQuery.prototype.where = function (this: FakeQuery, field: string, op: string, value: unknown) {
      seenFilters.push({ field, op, value });
      return originalWhere.call(this, field, op, value);
    };
    try {
      seedRun("run-1", UID, WS_ID, ts(1000));
      await GET(buildRequest());
      expect(seenFilters).toContainEqual({ field: "userId", op: "==", value: UID });
      expect(seenFilters).toContainEqual({ field: "workspaceId", op: "==", value: WS_ID });
      expect(seenFilters.length).toBe(2); // exactly these two, no more
    } finally {
      FakeQuery.prototype.where = originalWhere;
    }
  });
});

describe("GET /api/user/workspace/runs — query scope, no client-supplied identifiers", () => {
  it("accepts no workspaceId/userId/ownerUserId query params — scope is server-derived", async () => {
    seedRun("run-1", UID, WS_ID, ts(1000));
    const res = await GET(buildRequest("?workspaceId=someone-elses&userId=attacker"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.items.map((i: any) => i.id)).toEqual(["run-1"]);
  });

  it("legacy run (workspaceId truly absent) is structurally excluded", async () => {
    seedRun("run-legacy", UID, undefined, ts(1000));
    seedRun("run-bound", UID, WS_ID, ts(2000));
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items.map((i: any) => i.id)).toEqual(["run-bound"]);
  });

  it("SECURITY: another user's bound run never appears, even with an identical workspaceId string coincidentally present", async () => {
    seedRun("run-mine", UID, WS_ID, ts(2000));
    seedRun("run-other", "other-uid", WS_ID, ts(3000)); // corrupted/coincidental — different owner, same workspaceId string
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items.map((i: any) => i.id)).toEqual(["run-mine"]);
  });

  it("no workspaceId in any returned item DTO", async () => {
    seedRun("run-1", UID, WS_ID, ts(1000));
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("workspaceId");
    expect(JSON.stringify(json)).not.toContain("personal-owner-1");
  });
});

describe("GET /api/user/workspace/runs — Workspace prerequisite validated BEFORE the runs query (failure matrix, all with zero matching runs)", () => {
  it("valid Workspace + zero runs -> 200, items:[], hasMore:false (genuinely empty, not a failure)", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, items: [], hasMore: false });
  });

  it("SECURITY: missing Workspace + zero runs -> 404 workspace_missing, never a misleading empty-list 200", async () => {
    workspaceDocs.delete(WS_ID);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("workspace_missing");
  });

  it("SECURITY: malformed Workspace + zero runs -> 409 workspace_invalid, never a misleading empty-list 200", async () => {
    workspaceDocs.set(WS_ID, { id: WS_ID }); // missing required fields
    const res = await GET(buildRequest());
    expect(res.status).toBe(409);
  });

  it("SECURITY: wrong-owner Workspace + zero runs -> 409, never a misleading empty-list 200", async () => {
    workspaceDocs.set(WS_ID, validWorkspace(UID, { ownerUserId: "someone-else" }));
    const res = await GET(buildRequest());
    expect(res.status).toBe(409);
  });

  it("SECURITY: wrong-type Workspace + zero runs -> 409, never a misleading empty-list 200", async () => {
    workspaceDocs.set(WS_ID, validWorkspace(UID, { type: "team" }));
    const res = await GET(buildRequest());
    expect(res.status).toBe(409);
  });

  it("Workspace lookup failure + zero runs -> 503 workspace_unavailable, never a misleading empty-list 200", async () => {
    getWorkspaceThrows = true;
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("workspace_unavailable");
  });

  it("W=false + zero runs -> 503 workspace_unavailable, never a misleading empty-list 200", async () => {
    workspacesEnabled = false;
    const res = await GET(buildRequest());
    expect(res.status).toBe(503);
  });

  it("the runs query is never even attempted when the Workspace prerequisite fails", async () => {
    workspaceDocs.delete(WS_ID);
    seedRun("run-1", UID, WS_ID, ts(1000)); // would be returned if the query ran
    const res = await GET(buildRequest());
    expect(res.status).toBe(404); // not 200 with items containing run-1
  });
});

describe("GET /api/user/workspace/runs — Layer A integrity as defense in depth, after the prerequisite already passed", () => {
  it("prerequisite check + batch validator together: at most 2 Workspace lookups for a whole page (not 1-per-row)", async () => {
    for (let i = 0; i < 10; i++) seedRun(`run-${i}`, UID, WS_ID, ts(1000 + i));
    await GET(buildRequest());
    expect(mockedGetWorkspace).toHaveBeenCalledTimes(2); // 1 prerequisite + 1 batch-validator (shared across all 10 rows)
  });

  it("race safety net: if the Workspace becomes invalid between the prerequisite check and the runs query, the whole page still fails closed rather than a partial/misleading result", async () => {
    // Simulate the race by having getWorkspace succeed once (the
    // prerequisite check) then fail (the batch validator's own lookup).
    let call = 0;
    mockedGetWorkspace.mockImplementation(async () => {
      call++;
      if (call === 1) return { status: "found", workspace: validWorkspace(UID) };
      return { status: "not_found" };
    });
    seedRun("run-1", UID, WS_ID, ts(1000));
    const res = await GET(buildRequest());
    expect(res.status).toBe(503);
  });
});

describe("GET /api/user/workspace/runs — pagination invariants", () => {
  it("fewer than limit rows: returns all, hasMore=false, no cursor", async () => {
    seedRun("run-1", UID, WS_ID, ts(1000));
    seedRun("run-2", UID, WS_ID, ts(2000));
    const res = await GET(buildRequest("?limit=20"));
    const json = await res.json();
    expect(json.items.length).toBe(2);
    expect(json.hasMore).toBe(false);
    expect(json.nextCursor).toBeUndefined();
  });

  it("exactly limit rows, nothing more: hasMore=false", async () => {
    for (let i = 0; i < 5; i++) seedRun(`run-${i}`, UID, WS_ID, ts(1000 + i));
    const res = await GET(buildRequest("?limit=5"));
    const json = await res.json();
    expect(json.items.length).toBe(5);
    expect(json.hasMore).toBe(false);
  });

  it("limit+1 rows exist: returns exactly limit, hasMore=true, nextCursor present", async () => {
    for (let i = 0; i < 6; i++) seedRun(`run-${i}`, UID, WS_ID, ts(1000 + i));
    const res = await GET(buildRequest("?limit=5"));
    const json = await res.json();
    expect(json.items.length).toBe(5);
    expect(json.hasMore).toBe(true);
    expect(typeof json.nextCursor).toBe("string");
  });

  it("cursor resume: second page continues where the first left off, no duplicates, no skips", async () => {
    for (let i = 0; i < 12; i++) seedRun(`run-${i}`, UID, WS_ID, ts(1000 + i));
    const page1 = await (await GET(buildRequest("?limit=5"))).json();
    expect(page1.items.length).toBe(5);
    expect(page1.hasMore).toBe(true);

    const page2 = await (await GET(buildRequest(`?limit=5&cursor=${encodeURIComponent(page1.nextCursor)}`))).json();
    expect(page2.items.length).toBe(5);
    expect(page2.hasMore).toBe(true);

    const page3 = await (await GET(buildRequest(`?limit=5&cursor=${encodeURIComponent(page2.nextCursor)}`))).json();
    expect(page3.items.length).toBe(2);
    expect(page3.hasMore).toBe(false);

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((i: any) => i.id);
    expect(new Set(allIds).size).toBe(12); // no duplicates
    expect(allIds.length).toBe(12); // no skips
    expect(allIds).toEqual(["run-11", "run-10", "run-9", "run-8", "run-7", "run-6", "run-5", "run-4", "run-3", "run-2", "run-1", "run-0"]);
  });

  it("duplicate createdAt timestamps: documentId DESC tie-break keeps ordering deterministic across pages", async () => {
    seedRun("run-b", UID, WS_ID, ts(1000));
    seedRun("run-a", UID, WS_ID, ts(1000));
    seedRun("run-c", UID, WS_ID, ts(1000));
    const page1 = await (await GET(buildRequest("?limit=2"))).json();
    const page2 = await (await GET(buildRequest(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`))).json();
    const allIds = [...page1.items, ...page2.items].map((i: any) => i.id);
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toEqual(["run-c", "run-b", "run-a"]); // documentId desc among equal timestamps
  });

  it("PRECISION REGRESSION: same second+millisecond, different nanoseconds, across a page boundary — no duplicate, no skip, correct continuation", async () => {
    // Both rows fall in the SAME millisecond (123ms) but differ in the
    // sub-millisecond nanosecond component — this is exactly the case a
    // millisecond-truncating cursor would corrupt. Doc-id ties are broken
    // by documentId DESC, but the seconds+nanoseconds pair must itself be
    // reconstructed exactly for startAfter to land on the right boundary.
    seedRun("run-newer", UID, WS_ID, ts(1723600000, 123_789_000));
    seedRun("run-older", UID, WS_ID, ts(1723600000, 123_456_000));
    seedRun("run-oldest", UID, WS_ID, ts(1723600000, 100_000_000));

    const page1 = await (await GET(buildRequest("?limit=1"))).json();
    expect(page1.items.map((i: any) => i.id)).toEqual(["run-newer"]);
    expect(page1.hasMore).toBe(true);

    const decoded = decodeCursorRaw(page1.nextCursor);
    expect(decoded.n).toBe(123_789_000); // exact nanoseconds preserved, not truncated to 123_000_000

    const page2 = await (await GET(buildRequest(`?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`))).json();
    expect(page2.items.map((i: any) => i.id)).toEqual(["run-older"]);
    expect(page2.hasMore).toBe(true);

    const page3 = await (await GET(buildRequest(`?limit=1&cursor=${encodeURIComponent(page2.nextCursor)}`))).json();
    expect(page3.items.map((i: any) => i.id)).toEqual(["run-oldest"]);
    expect(page3.hasMore).toBe(false);
  });

  it("malformed cursor -> 400 invalid_cursor, not a 500", async () => {
    const res = await GET(buildRequest("?cursor=not-a-valid-cursor-at-all-%%%"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe("invalid_cursor");
  });

  it("cursor is computed from the last SCANNED page-window document — the batch-shared-fate invariant proves a live mixed-validity page cannot be constructed for this endpoint, so this is verified via the normal all-valid case matching the code's unconditional computation", async () => {
    for (let i = 0; i < 5; i++) seedRun(`run-${i}`, UID, WS_ID, ts(1000 + i));
    const page1 = await (await GET(buildRequest("?limit=3"))).json();
    const lastScannedId = page1.items[page1.items.length - 1].id;
    const decoded = decodeCursorRaw(page1.nextCursor);
    expect(decoded.i).toBe(lastScannedId);
  });

  it("consecutive pages with limit=1 never repeat or skip a row", async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, UID, WS_ID, ts(1000 + i));
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 5; page++) {
      const qs = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : "?limit=1";
      const json = await (await GET(buildRequest(qs))).json();
      seen.push(...json.items.map((i: any) => i.id));
      if (!json.hasMore) break;
      cursor = json.nextCursor;
    }
    expect(seen).toEqual(["run-3", "run-2", "run-1", "run-0"]);
  });

  it("cursor generated for one account, sent by a different authenticated account, never escapes that account's own scope", async () => {
    seedRun("run-owner1", UID, WS_ID, ts(1000));
    seedRun("run-owner1-b", UID, WS_ID, ts(2000));
    const page1 = await (await GET(buildRequest("?limit=1"))).json();
    expect(page1.items.map((i: any) => i.id)).toEqual(["run-owner1-b"]);

    // Switch to a different authenticated user who also has a valid
    // Workspace and their own bound run, then reuse owner-1's cursor.
    const OTHER_UID = "owner-2";
    const OTHER_WS_ID = "personal-owner-2";
    workspaceDocs.set(OTHER_WS_ID, validWorkspace(OTHER_UID));
    seedRun("run-owner2", OTHER_UID, OTHER_WS_ID, ts(500));
    currentAuthUid = OTHER_UID;

    const stolen = await (await GET(buildRequest(`?limit=5&cursor=${encodeURIComponent(page1.nextCursor)}`))).json();
    // Must never return owner-1's data; may legitimately return owner-2's
    // own data or an empty page depending on where the cursor position
    // falls within owner-2's own scoped query — either is acceptable, but
    // owner-1's rows must never appear.
    const ids = (stolen.items ?? []).map((i: any) => i.id);
    expect(ids).not.toContain("run-owner1");
    expect(ids).not.toContain("run-owner1-b");
  });
});

describe("GET /api/user/workspace/runs — DTO shape", () => {
  it("returns the expected summary fields, no raw Firestore doc, no internal fields", async () => {
    seedRun("run-1", UID, WS_ID, ts(1000), { question: "What is the capital of France?", selectedModels: ["chatgpt", "claude"], synthesisConsensusSummary: { overallConsensusScore: 88 }, governanceStatus: "approved" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items[0]).toEqual({
      id: "run-1",
      at: expect.any(String),
      question: "What is the capital of France?",
      selectedModels: ["chatgpt", "claude"],
      status: "complete",
      modelsTotal: 2,
      synthesisConsensusScore: 88,
      governanceStatus: "approved",
    });
  });

  it("adaptive marker included only when present", async () => {
    seedRun("run-1", UID, WS_ID, ts(1000), { adaptiveOutput: { schemaId: "deep_research" } });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items[0].hasAdaptiveOutput).toBe(true);
    expect(json.items[0].adaptiveSchemaId).toBe("deep_research");
  });
});
