/**
 * PHASE 1 REVIEW STACK CROSS-AUTHORITY READ GUARD — the shared list/export
 * boundary itself.
 *
 * The route specs prove the boundary is APPLIED. This one proves the boundary
 * is CORRECT in isolation: which bindings are admitted, that every ambiguity
 * resolves toward exclusion, and that the canonical lookup is batched rather
 * than issued per row.
 */

const runDocs = new Map<string, Record<string, any>>();
const getAllCalls: string[][] = [];
let getAllShouldThrow = false;

const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => ({ __path: `${name}/${id}` }) }),
  getAll: async (...refs: Array<{ __path: string }>) => {
    getAllCalls.push(refs.map((r) => r.__path));
    if (getAllShouldThrow) throw new Error("batch read boom");
    return refs.map((ref) => ({ exists: runDocs.has(ref.__path), data: () => runDocs.get(ref.__path) }));
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { legacyOnlyRunIds, teamRunRowCanonicalRunId, teamRunRowIsInLegacyReadDomain } from "@/lib/governance/legacyReviewReadDomain";

const OWNER = "owner-uid";

beforeEach(() => {
  runDocs.clear();
  getAllCalls.length = 0;
  getAllShouldThrow = false;
});

describe("teamRunRowCanonicalRunId", () => {
  it("reads the explicit runId field, never the projection's own document id", () => {
    expect(teamRunRowCanonicalRunId({ runId: "run-1" })).toBe("run-1");
  });

  it.each([
    ["a classic verification row", { type: "verification", runId: null, verificationId: "v1" }],
    ["a row with no runId at all", { type: "research" }],
    ["a blank runId", { runId: "   " }],
    ["a non-string runId", { runId: 7 }],
    ["a non-object row", "nope"],
    ["null", null],
  ])("returns null for %s", (_label, raw) => {
    expect(teamRunRowCanonicalRunId(raw)).toBeNull();
  });
});

describe("legacyOnlyRunIds — which bindings are admitted", () => {
  it("admits a run whose canonical document carries no workspaceId at all", async () => {
    runDocs.set("runs/run-1", { userId: OWNER });
    const { legacyOnly } = await legacyOnlyRunIds(["run-1"]);
    expect([...legacyOnly]).toEqual(["run-1"]);
  });

  it.each([
    ["a Team Workspace binding", { userId: OWNER, workspaceId: "ws-team-1" }],
    ["its owner's Personal Workspace binding", { userId: OWNER, workspaceId: `personal-${OWNER}` }],
    ["a non-string workspaceId", { userId: OWNER, workspaceId: 12345 }],
    ["an empty workspaceId", { userId: OWNER, workspaceId: "" }],
    ["an explicitly undefined workspaceId key", { userId: OWNER, workspaceId: undefined }],
    ["a workspaceId with an unusable owner", { workspaceId: "ws-team-1" }],
  ])("excludes a run carrying %s", async (_label, doc) => {
    runDocs.set("runs/run-1", doc as Record<string, any>);
    const { legacyOnly } = await legacyOnlyRunIds(["run-1"]);
    expect([...legacyOnly]).toEqual([]);
  });

  it("excludes a run whose canonical document does not exist", async () => {
    const { legacyOnly } = await legacyOnlyRunIds(["run-missing"]);
    expect([...legacyOnly]).toEqual([]);
  });

  it("excludes every id in a chunk whose read failed, rather than throwing", async () => {
    runDocs.set("runs/run-1", { userId: OWNER });
    getAllShouldThrow = true;
    await expect(legacyOnlyRunIds(["run-1"])).resolves.toEqual({ legacyOnly: new Set() });
  });

  it("classifies a mixed set independently", async () => {
    runDocs.set("runs/legacy-1", { userId: OWNER });
    runDocs.set("runs/legacy-2", { userId: OWNER });
    runDocs.set("runs/ws-1", { userId: OWNER, workspaceId: "ws-team-1" });
    const { legacyOnly } = await legacyOnlyRunIds(["legacy-1", "ws-1", "legacy-2", "missing-1"]);
    expect([...legacyOnly].sort()).toEqual(["legacy-1", "legacy-2"]);
  });
});

describe("legacyOnlyRunIds — read shape", () => {
  it("batches at ten per call instead of one read per row", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `run-${i}`);
    ids.forEach((id) => runDocs.set(`runs/${id}`, { userId: OWNER }));
    await legacyOnlyRunIds(ids);
    // 25 ids => 3 batched calls (10/10/5), never 25.
    expect(getAllCalls.map((c) => c.length)).toEqual([10, 10, 5]);
  });

  it("de-duplicates repeated run ids", async () => {
    runDocs.set("runs/run-1", { userId: OWNER });
    await legacyOnlyRunIds(["run-1", "run-1", "run-1"]);
    expect(getAllCalls).toEqual([["runs/run-1"]]);
  });

  it("issues no read at all for an empty input", async () => {
    await legacyOnlyRunIds([]);
    expect(getAllCalls).toEqual([]);
  });
});

describe("teamRunRowIsInLegacyReadDomain", () => {
  it("keeps a row that names no canonical run", async () => {
    const result = await legacyOnlyRunIds([]);
    expect(teamRunRowIsInLegacyReadDomain({ type: "verification", runId: null }, result)).toBe(true);
  });

  it("keeps a row whose run was proven legacy-only", async () => {
    runDocs.set("runs/run-1", { userId: OWNER });
    const result = await legacyOnlyRunIds(["run-1"]);
    expect(teamRunRowIsInLegacyReadDomain({ runId: "run-1" }, result)).toBe(true);
  });

  it("drops a row whose run was not proven legacy-only", async () => {
    runDocs.set("runs/run-1", { userId: OWNER, workspaceId: "ws-team-1" });
    const result = await legacyOnlyRunIds(["run-1"]);
    expect(teamRunRowIsInLegacyReadDomain({ runId: "run-1" }, result)).toBe(false);
  });

  it("drops a row naming a run that was never classified at all", async () => {
    // A caller that forgets to include a row's run id in the lookup must not
    // thereby publish it: absence from the set is exclusion, never a default-allow.
    const result = await legacyOnlyRunIds([]);
    expect(teamRunRowIsInLegacyReadDomain({ runId: "run-unclassified" }, result)).toBe(false);
  });
});
