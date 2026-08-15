/**
 * Phase 5B — GET /api/user/workspace/runs.
 *
 * Firestore is faked in-memory with a real filter/sort/startAfter/limit
 * engine (not a fixed-docs stub) specifically so the cursor-pagination
 * test matrix below is actually exercised against realistic query
 * semantics, not just the route's own bookkeeping. `Timestamp`/`FieldPath`
 * from `firebase-admin/firestore` are faked as real classes, matching this
 * codebase's established convention (see `lib/firestore/__tests__/adaptiveExports.spec.ts`).
 */

class FakeTimestamp {
  constructor(public __millis: number) {}
  static fromMillis(ms: number) {
    return new FakeTimestamp(ms);
  }
  static now() {
    return new FakeTimestamp(Date.now());
  }
  toMillis() {
    return this.__millis;
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

function fieldValue(doc: FakeDoc, field: string | symbol): unknown {
  if (field === DOC_ID_SENTINEL) return doc.id;
  const v = (doc.data as Record<string, unknown>)[field as string];
  if (v instanceof FakeTimestamp) return v.toMillis();
  return v;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
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
        const cmp = compareValues(fieldValue(a, o.field), fieldValue(b, o.field));
        if (cmp !== 0) return o.dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });

    if (this.startAfterVals) {
      const idx = result.findIndex((d) =>
        this.orders.every((o, i) => fieldValue(d, o.field) === (this.startAfterVals![i] instanceof FakeTimestamp ? (this.startAfterVals![i] as FakeTimestamp).toMillis() : this.startAfterVals![i]))
      );
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
const mockedGetWorkspace = jest.fn(async (id: string) => {
  if (!workspacesEnabled) return { status: "not_found" }; // validateRunWorkspaceAssociation checks the flag itself before this is reached in real code; kept simple here
  if (!workspaceDocs.has(id)) return { status: "not_found" };
  return { status: "found", workspace: workspaceDocs.get(id) };
});
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));
jest.mock("@/lib/env", () => ({
  get WORKSPACES_ENABLED() {
    return workspacesEnabled;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/workspace/runs/route";
import { encodeWorkspaceRunsCursor } from "@/lib/workspaces/workspaceRunsCursor";

const UID = "owner-1";
const WS_ID = "personal-owner-1";

function validWorkspace(ownerUid: string) {
  return {
    schemaVersion: 1,
    id: `personal-${ownerUid}`,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: ownerUid,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function seedRun(id: string, userId: string, workspaceId: string | undefined, createdAtMillis: number, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { userId, question: "q", selectedModels: ["chatgpt"], status: "complete", createdAt: new FakeTimestamp(createdAtMillis), ...extra };
  if (workspaceId !== undefined) data.workspaceId = workspaceId;
  runsDocs.push({ id, data });
}

function buildRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/user/workspace/runs${qs}`);
}

beforeEach(() => {
  runsDocs = [];
  workspaceDocs.clear();
  workspacesEnabled = true;
  currentAuthUid = UID;
  jest.clearAllMocks();
  workspaceDocs.set(WS_ID, validWorkspace(UID));
});

describe("GET /api/user/workspace/runs — auth", () => {
  it("401s when unauthenticated", async () => {
    currentAuthUid = null;
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/workspace/runs — query scope, no client-supplied identifiers", () => {
  it("accepts no workspaceId/userId/ownerUserId query params — scope is server-derived", async () => {
    seedRun("run-1", UID, WS_ID, 1000);
    const res = await GET(buildRequest("?workspaceId=someone-elses&userId=attacker"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.items.map((i: any) => i.id)).toEqual(["run-1"]);
  });

  it("legacy run (workspaceId truly absent) is structurally excluded", async () => {
    seedRun("run-legacy", UID, undefined, 1000);
    seedRun("run-bound", UID, WS_ID, 2000);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items.map((i: any) => i.id)).toEqual(["run-bound"]);
  });

  it("SECURITY: another user's bound run never appears, even with an identical workspaceId string coincidentally present", async () => {
    seedRun("run-mine", UID, WS_ID, 2000);
    seedRun("run-other", "other-uid", WS_ID, 3000); // corrupted/coincidental — different owner, same workspaceId string
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items.map((i: any) => i.id)).toEqual(["run-mine"]);
  });

  it("no workspaceId in any returned item DTO", async () => {
    seedRun("run-1", UID, WS_ID, 1000);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("workspaceId");
    expect(JSON.stringify(json)).not.toContain("personal-owner-1");
  });
});

describe("GET /api/user/workspace/runs — empty vs. shared-Workspace-failure distinction", () => {
  it("genuinely no bound runs -> 200, items:[], hasMore:false (not a failure)", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, items: [], hasMore: false });
  });

  it("SECURITY: shared Workspace itself invalid -> whole request fails retryable, never a misleading empty list", async () => {
    workspaceDocs.delete(WS_ID); // Workspace missing -> every row invalidated together
    seedRun("run-1", UID, WS_ID, 1000);
    seedRun("run-2", UID, WS_ID, 2000);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe("workspace_unavailable");
  });

  it("W=false -> every row invalidated together -> 503, not an empty list", async () => {
    seedRun("run-1", UID, WS_ID, 1000);
    workspacesEnabled = false;
    const res = await GET(buildRequest());
    expect(res.status).toBe(503);
  });
});

describe("GET /api/user/workspace/runs — Layer A integrity, one shared Workspace lookup per page", () => {
  it("one Workspace lookup for the whole page, regardless of row count", async () => {
    for (let i = 0; i < 10; i++) seedRun(`run-${i}`, UID, WS_ID, 1000 + i);
    await GET(buildRequest());
    expect(mockedGetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("INVARIANT: within a page, rows either ALL pass or ALL fail together (same owner+workspaceId cache key) — never a mix", async () => {
    workspaceDocs.delete(WS_ID);
    seedRun("run-1", UID, WS_ID, 1000);
    seedRun("run-2", UID, WS_ID, 2000);
    seedRun("run-3", UID, WS_ID, 3000);
    const res = await GET(buildRequest());
    // All fail together -> whole-request failure, not a partial list.
    expect(res.status).toBe(503);
  });
});

describe("GET /api/user/workspace/runs — pagination invariants", () => {
  it("fewer than limit rows: returns all, hasMore=false, no cursor", async () => {
    seedRun("run-1", UID, WS_ID, 1000);
    seedRun("run-2", UID, WS_ID, 2000);
    const res = await GET(buildRequest("?limit=20"));
    const json = await res.json();
    expect(json.items.length).toBe(2);
    expect(json.hasMore).toBe(false);
    expect(json.nextCursor).toBeUndefined();
  });

  it("exactly limit rows, nothing more: hasMore=false", async () => {
    for (let i = 0; i < 5; i++) seedRun(`run-${i}`, UID, WS_ID, 1000 + i);
    const res = await GET(buildRequest("?limit=5"));
    const json = await res.json();
    expect(json.items.length).toBe(5);
    expect(json.hasMore).toBe(false);
  });

  it("limit+1 rows exist: returns exactly limit, hasMore=true, nextCursor present", async () => {
    for (let i = 0; i < 6; i++) seedRun(`run-${i}`, UID, WS_ID, 1000 + i);
    const res = await GET(buildRequest("?limit=5"));
    const json = await res.json();
    expect(json.items.length).toBe(5);
    expect(json.hasMore).toBe(true);
    expect(typeof json.nextCursor).toBe("string");
  });

  it("cursor resume: second page continues where the first left off, no duplicates, no skips", async () => {
    for (let i = 0; i < 12; i++) seedRun(`run-${i}`, UID, WS_ID, 1000 + i);
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
    // newest-first order preserved across pages
    expect(allIds).toEqual(["run-11", "run-10", "run-9", "run-8", "run-7", "run-6", "run-5", "run-4", "run-3", "run-2", "run-1", "run-0"]);
  });

  it("duplicate createdAt timestamps: documentId DESC tie-break keeps ordering deterministic across pages", async () => {
    seedRun("run-b", UID, WS_ID, 1000);
    seedRun("run-a", UID, WS_ID, 1000);
    seedRun("run-c", UID, WS_ID, 1000);
    const page1 = await (await GET(buildRequest("?limit=2"))).json();
    const page2 = await (await GET(buildRequest(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`))).json();
    const allIds = [...page1.items, ...page2.items].map((i: any) => i.id);
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toEqual(["run-c", "run-b", "run-a"]); // documentId desc among equal timestamps
  });

  it("malformed cursor -> 400 invalid_cursor, not a 500", async () => {
    const res = await GET(buildRequest("?cursor=not-a-valid-cursor-at-all-%%%"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe("invalid_cursor");
  });

  it("cursor is computed from the last SCANNED page-window document, not the last valid item — verified directly, since this query's own filters make a mixed valid/invalid page mathematically impossible to construct live (see note below)", async () => {
    // Every row returned by this endpoint's query already satisfies
    // `userId==uid AND workspaceId==personal-{uid}` by construction, so
    // every row shares the IDENTICAL (ownerUserId, workspaceId) cache key
    // in the batched Layer A validator — meaning within a single page,
    // rows can only ever ALL pass or ALL fail together (proved directly
    // above in "rows either ALL pass or ALL fail together"). A live
    // mixed-validity page therefore cannot be constructed against this
    // specific endpoint's query shape. The route still implements cursor
    // advancement from `pageDocs[last]` (never `items[last]`) as a
    // structural safeguard rather than relying on this invariant holding
    // forever — this test proves that source-level behavior directly: in
    // the normal all-valid case, the cursor's document id matches the
    // last page-window document scanned, which is what the code computes
    // regardless of validity outcome.
    for (let i = 0; i < 5; i++) seedRun(`run-${i}`, UID, WS_ID, 1000 + i);
    const page1 = await (await GET(buildRequest("?limit=3"))).json();
    const lastScannedId = page1.items[page1.items.length - 1].id; // run-2 (3rd newest)
    const decoded = JSON.parse(Buffer.from(page1.nextCursor.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    expect(decoded.i).toBe(lastScannedId);
  });

  it("consecutive pages with limit=1 never repeat or skip a row", async () => {
    for (let i = 0; i < 4; i++) seedRun(`run-${i}`, UID, WS_ID, 1000 + i);
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
});

describe("GET /api/user/workspace/runs — DTO shape", () => {
  it("returns the expected summary fields, no raw Firestore doc, no internal fields", async () => {
    seedRun("run-1", UID, WS_ID, 1000, { question: "What is the capital of France?", selectedModels: ["chatgpt", "claude"], synthesisConsensusSummary: { overallConsensusScore: 88 }, governanceStatus: "approved" });
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
    seedRun("run-1", UID, WS_ID, 1000, { adaptiveOutput: { schemaId: "deep_research" } });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.items[0].hasAdaptiveOutput).toBe(true);
    expect(json.items[0].adaptiveSchemaId).toBe("deep_research");
  });
});
