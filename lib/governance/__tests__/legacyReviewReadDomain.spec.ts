/**
 * PHASE 1 REVIEW STACK CROSS-AUTHORITY READ GUARD — the shared list/export
 * boundary itself.
 *
 * The route specs prove the boundary is APPLIED. This one proves it is CORRECT
 * in isolation: which bindings are admitted for each of the TWO linkage shapes
 * a `teamRuns` row can carry (run-backed and verification-backed), that every
 * ambiguity resolves toward exclusion, and that the canonical lookups are
 * batched and associated by document identity rather than array position.
 */

const docs = new Map<string, Record<string, any>>();
const getAllCalls: string[][] = [];
let getAllShouldThrow = false;
/** Set to reverse each response array, proving association is by id and not by position. */
let getAllReverseResults = false;

const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => ({ __path: `${name}/${id}`, __id: id }) }),
  getAll: async (...refs: Array<{ __path: string; __id: string }>) => {
    getAllCalls.push(refs.map((r) => r.__path));
    if (getAllShouldThrow) throw new Error("batch read boom");
    const out = refs.map((ref) => ({ id: ref.__id, exists: docs.has(ref.__path), data: () => docs.get(ref.__path) }));
    return getAllReverseResults ? out.reverse() : out;
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

import {
  resolveLegacyReadDomain,
  teamRunRowCanonicalRunId,
  teamRunRowVerificationId,
  teamRunRowIsInLegacyReadDomain,
} from "@/lib/governance/legacyReviewReadDomain";

const OWNER = "owner-uid";
const runRow = (runId: unknown) => ({ runId });
const verRow = (verificationId: unknown) => ({ runId: null, verificationId });

beforeEach(() => {
  docs.clear();
  getAllCalls.length = 0;
  getAllShouldThrow = false;
  getAllReverseResults = false;
});

describe("linkage extraction", () => {
  it("reads the explicit runId field, never the projection's own document id", () => {
    expect(teamRunRowCanonicalRunId({ runId: "run-1" })).toBe("run-1");
    expect(teamRunRowVerificationId({ verificationId: "ver-1" })).toBe("ver-1");
  });

  it.each([
    ["a row with no linkage", { type: "research" }],
    ["a blank id", { runId: "   ", verificationId: "   " }],
    ["a non-string id", { runId: 7, verificationId: 7 }],
    ["a non-object row", "nope"],
    ["null", null],
  ])("returns null for %s", (_label, raw) => {
    expect(teamRunRowCanonicalRunId(raw)).toBeNull();
    expect(teamRunRowVerificationId(raw)).toBeNull();
  });
});

describe("run-backed rows — which bindings are admitted", () => {
  it("admits a run whose canonical document carries no workspaceId at all", async () => {
    docs.set("runs/run-1", { userId: OWNER });
    const d = await resolveLegacyReadDomain([runRow("run-1")]);
    expect([...d.legacyOnlyRunIds]).toEqual(["run-1"]);
  });

  it.each([
    ["a Team Workspace binding", { userId: OWNER, workspaceId: "ws-team-1" }],
    ["its owner's Personal Workspace binding", { userId: OWNER, workspaceId: `personal-${OWNER}` }],
    ["a non-string workspaceId", { userId: OWNER, workspaceId: 12345 }],
    ["an empty workspaceId", { userId: OWNER, workspaceId: "" }],
    ["an explicitly undefined workspaceId key", { userId: OWNER, workspaceId: undefined }],
    ["a workspaceId with an unusable owner", { workspaceId: "ws-team-1" }],
  ])("excludes a run carrying %s", async (_label, doc) => {
    docs.set("runs/run-1", doc as Record<string, any>);
    const d = await resolveLegacyReadDomain([runRow("run-1")]);
    expect([...d.legacyOnlyRunIds]).toEqual([]);
  });

  it("excludes a run whose canonical document does not exist", async () => {
    const d = await resolveLegacyReadDomain([runRow("run-missing")]);
    expect([...d.legacyOnlyRunIds]).toEqual([]);
  });

  it("excludes every id in a chunk whose read failed, rather than throwing", async () => {
    docs.set("runs/run-1", { userId: OWNER });
    getAllShouldThrow = true;
    const d = await resolveLegacyReadDomain([runRow("run-1")]);
    expect([...d.legacyOnlyRunIds]).toEqual([]);
  });
});

describe("verification-backed rows — which artifacts are admitted", () => {
  it("admits an artifact with NO workspaceId field (Personal/legacy writer)", async () => {
    docs.set("verifications/ver-1", { claimText: "c" });
    const d = await resolveLegacyReadDomain([verRow("ver-1")]);
    expect([...d.legacyOnlyVerificationIds]).toEqual(["ver-1"]);
  });

  it.each([
    ["a Workspace id", { workspaceId: "ws-team-1" }],
    ["a null workspaceId (field presence is the rule, not truthiness)", { workspaceId: null }],
    ["an empty workspaceId", { workspaceId: "" }],
    ["an undefined workspaceId key", { workspaceId: undefined }],
  ])("excludes an artifact carrying %s", async (_label, doc) => {
    docs.set("verifications/ver-1", doc as Record<string, any>);
    const d = await resolveLegacyReadDomain([verRow("ver-1")]);
    expect([...d.legacyOnlyVerificationIds]).toEqual([]);
  });

  it("excludes an artifact that does not exist", async () => {
    const d = await resolveLegacyReadDomain([verRow("ver-missing")]);
    expect([...d.legacyOnlyVerificationIds]).toEqual([]);
  });

  it("excludes an artifact whose read failed", async () => {
    docs.set("verifications/ver-1", { claimText: "c" });
    getAllShouldThrow = true;
    const d = await resolveLegacyReadDomain([verRow("ver-1")]);
    expect([...d.legacyOnlyVerificationIds]).toEqual([]);
  });

  it("classifies runs and verifications independently in one pass", async () => {
    docs.set("runs/run-legacy", { userId: OWNER });
    docs.set("runs/run-ws", { userId: OWNER, workspaceId: "ws-1" });
    docs.set("verifications/ver-legacy", { claimText: "c" });
    docs.set("verifications/ver-ws", { workspaceId: "ws-1" });
    const d = await resolveLegacyReadDomain([runRow("run-legacy"), runRow("run-ws"), verRow("ver-legacy"), verRow("ver-ws")]);
    expect([...d.legacyOnlyRunIds]).toEqual(["run-legacy"]);
    expect([...d.legacyOnlyVerificationIds]).toEqual(["ver-legacy"]);
  });

  it("never looks up a verification for a row that already names a run", async () => {
    docs.set("runs/run-1", { userId: OWNER });
    await resolveLegacyReadDomain([{ runId: "run-1", verificationId: "ver-1" }]);
    expect(getAllCalls.flat()).toEqual(["runs/run-1"]);
  });
});

describe("read shape", () => {
  it("batches at ten per call instead of one read per row", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `run-${i}`);
    ids.forEach((id) => docs.set(`runs/${id}`, { userId: OWNER }));
    await resolveLegacyReadDomain(ids.map(runRow));
    expect(getAllCalls.map((c) => c.length).sort((a, b) => b - a)).toEqual([10, 10, 5]);
  });

  it("de-duplicates repeated ids", async () => {
    docs.set("runs/run-1", { userId: OWNER });
    await resolveLegacyReadDomain([runRow("run-1"), runRow("run-1"), runRow("run-1")]);
    expect(getAllCalls).toEqual([["runs/run-1"]]);
  });

  it("issues no read at all when nothing is linked", async () => {
    await resolveLegacyReadDomain([{ type: "research" }, {}]);
    expect(getAllCalls).toEqual([]);
  });

  it("associates results by document id, not array position", async () => {
    // The response comes back REVERSED. A positional mapping would credit the
    // Workspace-bound run's binding to the legacy id and admit the wrong row.
    docs.set("runs/run-legacy", { userId: OWNER });
    docs.set("runs/run-ws", { userId: OWNER, workspaceId: "ws-team-1" });
    getAllReverseResults = true;
    const d = await resolveLegacyReadDomain([runRow("run-legacy"), runRow("run-ws")]);
    expect([...d.legacyOnlyRunIds]).toEqual(["run-legacy"]);
  });
});

describe("teamRunRowIsInLegacyReadDomain", () => {
  it("keeps a row that names neither a run nor a verification", async () => {
    const d = await resolveLegacyReadDomain([]);
    expect(teamRunRowIsInLegacyReadDomain({ type: "research", runId: null }, d)).toBe(true);
  });

  it("keeps a run-backed row proven legacy-only, drops one that was not", async () => {
    docs.set("runs/run-ok", { userId: OWNER });
    docs.set("runs/run-ws", { userId: OWNER, workspaceId: "ws-1" });
    const d = await resolveLegacyReadDomain([runRow("run-ok"), runRow("run-ws")]);
    expect(teamRunRowIsInLegacyReadDomain(runRow("run-ok"), d)).toBe(true);
    expect(teamRunRowIsInLegacyReadDomain(runRow("run-ws"), d)).toBe(false);
  });

  it("keeps a verification-backed row proven non-Workspace, drops one that was not", async () => {
    docs.set("verifications/ver-ok", { claimText: "c" });
    docs.set("verifications/ver-ws", { workspaceId: "ws-1" });
    const d = await resolveLegacyReadDomain([verRow("ver-ok"), verRow("ver-ws")]);
    expect(teamRunRowIsInLegacyReadDomain(verRow("ver-ok"), d)).toBe(true);
    expect(teamRunRowIsInLegacyReadDomain(verRow("ver-ws"), d)).toBe(false);
  });

  it("drops a row whose linkage was never classified at all", async () => {
    // A caller that forgets to pass a row must not thereby publish it:
    // absence from the set is exclusion, never a default-allow.
    const d = await resolveLegacyReadDomain([]);
    expect(teamRunRowIsInLegacyReadDomain(runRow("run-unclassified"), d)).toBe(false);
    expect(teamRunRowIsInLegacyReadDomain(verRow("ver-unclassified"), d)).toBe(false);
  });
});
