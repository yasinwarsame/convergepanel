/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — `listTeamVideoVerifications()`: query shape,
 * ordering, pagination, the hasMore/nextCursor invariant, scope isolation,
 * fail-whole-window integrity (peek row included), batched Project validation,
 * strict summaries and zero writes.
 */

jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamVideoFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamVideoFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamVideoFakeFirestore");
    return mockState.unavailable ? null : makeFakeDb(mockState);
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { listTeamVideoVerifications } from "@/lib/workspaces/listTeamVideoVerifications";
import { encodeTeamVideoVerificationsCursor, decodeTeamVideoVerificationsCursor } from "@/lib/workspaces/teamVideoVerificationsCursor";
import { createFakeState, projectDoc, TEAM_W, teamVideoDoc, teamVideoDocWithout, personalVideoDoc } from "@/lib/workspaces/__tests__/teamVideoFakeFirestore";

const T = 1_700_000_000_000;
const ALL = { kind: "all" as const };
const UNFILED = { kind: "unfiled" as const };
const P1_LABEL = { id: "p1", name: "Project p1", status: "active" };

function videos(...docs: ReturnType<typeof teamVideoDoc>[]) {
  mockState.collections.videoVerifications = docs;
}
function projects(...docs: ReturnType<typeof projectDoc>[]) {
  mockState.collections.projects = docs;
}
async function list(scope: Parameters<typeof listTeamVideoVerifications>[0]["scope"], limit = 20, cursorRaw?: string | null) {
  return listTeamVideoVerifications({ workspaceId: TEAM_W, scope, limit, cursorRaw });
}
const ids = (r: Awaited<ReturnType<typeof list>>) => (r.status === "ok" ? r.items.map((i) => i.verificationId) : r.status);
const projectReads = () => mockState.getAllCalls.flat().filter((p) => p.startsWith("projects/")).length + mockState.docGets.filter((p) => p.startsWith("projects/")).length;

beforeEach(() => {
  mockState = createFakeState();
});

describe("query shape — scope comes only from the addressed URL, never the uploader", () => {
  it("all: workspaceId == W only; timestamp DESC then documentId DESC; limit + 1", async () => {
    videos(teamVideoDoc("vid-1"));
    await list(ALL, 5);
    expect(mockState.queries).toEqual([
      { collection: "videoVerifications", filters: [{ field: "workspaceId", op: "==", value: TEAM_W }], orders: [{ field: "timestamp", dir: "desc" }, { field: "__name__", dir: "desc" }], limit: 6 },
    ]);
  });

  it("unfiled: adds projectId == null", async () => {
    await list(UNFILED);
    expect(mockState.queries[0].filters).toEqual([{ field: "workspaceId", op: "==", value: TEAM_W }, { field: "projectId", op: "==", value: null }]);
  });

  it("project: adds projectId == the validated Project id", async () => {
    await list({ kind: "project", project: P1_LABEL });
    expect(mockState.queries[0].filters).toEqual([{ field: "workspaceId", op: "==", value: TEAM_W }, { field: "projectId", op: "==", value: "p1" }]);
  });

  it("never filters by userId: a Video uploaded by a different member is listed", async () => {
    videos(teamVideoDoc("by-a", { userId: "uploader-a" }, T + 2), teamVideoDoc("by-b", { userId: "uploader-b" }, T + 1));
    expect(ids(await list(ALL))).toEqual(["by-a", "by-b"]);
    expect(JSON.stringify(mockState.queries)).not.toContain("userId");
  });

  it("reads only the videoVerifications collection (never `verifications`)", async () => {
    videos(teamVideoDoc("vid-1"));
    await list(ALL);
    expect(mockState.queries.map((q) => q.collection)).toEqual(["videoVerifications"]);
  });
});

describe("ordering and pagination", () => {
  it("newest first; equal timestamps order by document id DESC", async () => {
    videos(teamVideoDoc("a", {}, T), teamVideoDoc("c", {}, T), teamVideoDoc("b", {}, T), teamVideoDoc("newest", {}, T + 1000));
    expect(ids(await list(ALL))).toEqual(["newest", "c", "b", "a"]);
  });

  it("empty Workspace -> ok, no items, hasMore false, no cursor, no Project read", async () => {
    const r = await list(ALL);
    expect(r).toEqual({ status: "ok", items: [], hasMore: false });
    expect(projectReads()).toBe(0);
  });

  it("one full page with nothing beyond it -> hasMore false and NO cursor", async () => {
    videos(teamVideoDoc("v1", {}, T + 1), teamVideoDoc("v2", {}, T));
    const r = await list(ALL, 2);
    expect(r.status === "ok" && r.hasMore).toBe(false);
    expect(r.status === "ok" && r.nextCursor).toBeUndefined();
  });

  it("limit + 1 peek drives hasMore and the cursor points at the LAST RETURNED row", async () => {
    videos(...Array.from({ length: 3 }, (_, i) => teamVideoDoc(`v${i}`, {}, T + i * 1000)));
    const r = await list(ALL, 2);
    expect(ids(r)).toEqual(["v2", "v1"]);
    expect(r.status === "ok" && r.hasMore).toBe(true);
    expect(decodeTeamVideoVerificationsCursor(r.status === "ok" ? r.nextCursor : undefined)).toEqual({
      ok: true,
      cursor: { timestampSeconds: Math.floor((T + 1000) / 1000), timestampNanoseconds: 0, lastDocId: "v1" },
    });
  });

  it("pages with an opaque position-only cursor until exhausted, no duplicates or gaps", async () => {
    videos(...Array.from({ length: 5 }, (_, i) => teamVideoDoc(`v${i}`, {}, T + i * 1000)));
    const p1 = await list(ALL, 2);
    expect(ids(p1)).toEqual(["v4", "v3"]);
    const p2 = await list(ALL, 2, p1.status === "ok" ? p1.nextCursor : undefined);
    expect(ids(p2)).toEqual(["v2", "v1"]);
    const p3 = await list(ALL, 2, p2.status === "ok" ? p2.nextCursor : undefined);
    expect(ids(p3)).toEqual(["v0"]);
    expect(p3.status === "ok" && p3.hasMore).toBe(false);
  });

  it("startAfter reconstructs the exact Timestamp and document id", async () => {
    videos(teamVideoDoc("v1", {}, T));
    const cursor = encodeTeamVideoVerificationsCursor({ timestampSeconds: 1_699_999_999, timestampNanoseconds: 42, lastDocId: "vid-prev" });
    await list(ALL, 5, cursor);
    const sa = mockState.queries[0].startAfter as Array<{ seconds: number; nanoseconds: number } | string>;
    expect(sa[0]).toMatchObject({ seconds: 1_699_999_999, nanoseconds: 42 });
    expect(sa[1]).toBe("vid-prev");
  });

  it("an invalid cursor is rejected BEFORE any Firestore query is issued", async () => {
    videos(teamVideoDoc("v1"));
    expect(await list(ALL, 20, "not-a-cursor")).toEqual({ status: "invalid_cursor" });
    expect(mockState.queries).toHaveLength(0);
  });

  it("CONTRACT: hasMore true always comes with a non-empty usable cursor", async () => {
    videos(...Array.from({ length: 9 }, (_, i) => teamVideoDoc(`v${i}`, {}, T + i * 1000)));
    for (const limit of [1, 2, 3, 4, 8]) {
      const r = await list(ALL, limit);
      if (r.status === "ok" && r.hasMore) {
        expect(typeof r.nextCursor).toBe("string");
        expect((r.nextCursor as string).length).toBeGreaterThan(0);
        expect(decodeTeamVideoVerificationsCursor(r.nextCursor).ok).toBe(true);
      }
    }
  });

  it("CONTRACT: a page that reports more is never the same page again (no page-1 re-fetch loop)", async () => {
    videos(...Array.from({ length: 4 }, (_, i) => teamVideoDoc(`v${i}`, {}, T + i * 1000)));
    const p1 = await list(ALL, 2);
    const p2 = await list(ALL, 2, p1.status === "ok" ? p1.nextCursor : undefined);
    expect(ids(p2)).not.toEqual(ids(p1));
  });
});

describe("whole-window integrity — one bad row fails the ENTIRE page", () => {
  it.each([
    ["absent projectId field", () => teamVideoDocWithout("bad", ["projectId"])],
    ["malformed projectId", () => teamVideoDoc("bad", { projectId: 7 })],
    ["empty-string projectId", () => teamVideoDoc("bad", { projectId: "" })],
    ["wrong type discriminator", () => teamVideoDoc("bad", { type: "claim_verification" })],
    ["non-Timestamp timestamp", () => teamVideoDoc("bad", { timestamp: "2023-11-14T00:00:00.000Z" })],
    ["empty userId", () => teamVideoDoc("bad", { userId: "" })],
  ])("%s -> integrity_violation, nothing returned", async (_l, make) => {
    videos(teamVideoDoc("good", {}, T + 1000), make());
    expect(await list(ALL)).toEqual({ status: "integrity_violation" });
  });

  // The Workspace binding cases below cannot be reached while the Firestore
  // predicate itself excludes them, which is exactly why the predicate must
  // not be the only thing standing between a foreign row and the response.
  // `ignoreQueryFilters` models a query that returns them anyway (an index or
  // emulator anomaly, or a future edit that drops the `where`), and proves the
  // ROW VALIDATOR independently fails the whole window.
  describe("Workspace binding is enforced by row validation, not only by the query predicate", () => {
    it.each([
      ["foreign Workspace", () => teamVideoDoc("bad", { workspaceId: "ws-other" })],
      ["absent workspaceId (a Personal row)", () => personalVideoDoc("bad")],
      ["empty workspaceId", () => teamVideoDoc("bad", { workspaceId: "" })],
    ])("%s -> integrity_violation even when the query returns it", async (_l, make) => {
      mockState.ignoreQueryFilters = true;
      videos(teamVideoDoc("good", {}, T + 1000), make());
      expect(await list(ALL)).toEqual({ status: "integrity_violation" });
    });

    it("positive control: with the predicate applied, those rows are simply not returned", async () => {
      videos(teamVideoDoc("good", {}, T + 1000), teamVideoDoc("bad", { workspaceId: "ws-other" }), personalVideoDoc("personal"));
      expect(ids(await list(ALL))).toEqual(["good"]);
    });

    it("unfiled scope rejects a non-null projectId row the predicate would have excluded", async () => {
      mockState.ignoreQueryFilters = true;
      videos(teamVideoDoc("filed", { projectId: "p1" }));
      expect(await list(UNFILED)).toEqual({ status: "integrity_violation" });
    });

    it("project scope rejects a row whose projectId does not match the addressed Project", async () => {
      mockState.ignoreQueryFilters = true;
      videos(teamVideoDoc("other", { projectId: "p2" }));
      expect(await listTeamVideoVerifications({ workspaceId: TEAM_W, scope: { kind: "project", project: P1_LABEL }, limit: 20, cursorRaw: null })).toEqual({ status: "integrity_violation" });
    });
  });

  it.each([
    ["unknown verdict", { verdict: "totally_fine" }],
    ["out-of-range consensusScore", { consensusScore: 250 }],
    ["malformed evidenceQuality", { evidenceQuality: "excellent" }],
    ["malformed frameCount", { frameCount: -3 }],
    ["empty fileName", { fileName: "" }],
    ["malformed confidenceLabel", { confidenceLabel: "high" }],
  ])("a summary-field failure (%s) fails the whole page rather than defaulting", async (_l, overrides) => {
    videos(teamVideoDoc("good", {}, T + 1000), teamVideoDoc("bad", overrides));
    expect(await list(ALL)).toEqual({ status: "integrity_violation" });
  });

  it("the PEEK row is validated too: a malformed row beyond the limit still fails the request", async () => {
    videos(teamVideoDoc("v2", {}, T + 2000), teamVideoDoc("v1", {}, T + 1000), teamVideoDocWithout("peek-bad", ["projectId"], {}, T));
    expect(await list(ALL, 2)).toEqual({ status: "integrity_violation" });
  });

  it("positive control: the same window with a WELL-FORMED peek row succeeds", async () => {
    videos(teamVideoDoc("v2", {}, T + 2000), teamVideoDoc("v1", {}, T + 1000), teamVideoDoc("peek-ok", {}, T));
    expect(ids(await list(ALL, 2))).toEqual(["v2", "v1"]);
  });
});

describe("all scope — batched Project validation", () => {
  it("resolves every unique non-null projectId in ONE getAll and labels each item", async () => {
    videos(teamVideoDoc("a", { projectId: "p1" }, T + 3), teamVideoDoc("b", { projectId: "p1" }, T + 2), teamVideoDoc("c", { projectId: "p2" }, T + 1), teamVideoDoc("d", {}, T));
    projects(projectDoc("p1"), projectDoc("p2"));
    const r = await list(ALL);
    expect(r.status).toBe("ok");
    expect(mockState.getAllCalls).toHaveLength(1);
    expect(mockState.getAllCalls[0].sort()).toEqual(["projects/p1", "projects/p2"]);
    expect(r.status === "ok" && r.items.map((i) => i.project?.id ?? null)).toEqual(["p1", "p1", "p2", null]);
  });

  it("zero non-null projectIds -> zero Project reads", async () => {
    videos(teamVideoDoc("a"), teamVideoDoc("b"));
    await list(ALL);
    expect(projectReads()).toBe(0);
  });

  it.each([
    ["missing", () => projects()],
    ["malformed", () => projects(projectDoc("p1", { schemaVersion: 99, name: undefined }))],
    ["id mismatch", () => projects(projectDoc("p1", { id: "other" }))],
    ["cross-Workspace", () => projects(projectDoc("p1", { workspaceId: "ws-other" }))],
  ])("a %s referenced Project fails the WHOLE page", async (_l, seed) => {
    videos(teamVideoDoc("a", { projectId: "p1" }));
    seed();
    expect(await list(ALL)).toEqual({ status: "integrity_violation" });
  });

  it("an ARCHIVED referenced Project is valid and readable", async () => {
    videos(teamVideoDoc("a", { projectId: "p1" }));
    projects(projectDoc("p1", { status: "archived" }));
    const r = await list(ALL);
    expect(r.status === "ok" && r.items[0].project).toEqual({ id: "p1", name: "Project p1", status: "archived" });
  });

  it("the PEEK row's Project is validated too", async () => {
    videos(teamVideoDoc("v2", {}, T + 2000), teamVideoDoc("v1", {}, T + 1000), teamVideoDoc("peek", { projectId: "p-missing" }, T));
    expect(await list(ALL, 2)).toEqual({ status: "integrity_violation" });
  });
});

describe("scope isolation and Project reads", () => {
  it("unfiled scope performs ZERO Project reads", async () => {
    videos(teamVideoDoc("a"), teamVideoDoc("b"));
    await list(UNFILED);
    expect(projectReads()).toBe(0);
  });

  it("project scope performs ZERO Project reads in the helper (the route already validated it)", async () => {
    videos(teamVideoDoc("a", { projectId: "p1" }));
    const r = await list({ kind: "project", project: P1_LABEL });
    expect(projectReads()).toBe(0);
    expect(r.status === "ok" && r.items[0].project).toEqual(P1_LABEL);
  });
});

describe("infrastructure failures", () => {
  it("Firestore unavailable -> query_failed, no query attempted", async () => {
    mockState.unavailable = true;
    expect(await list(ALL)).toEqual({ status: "query_failed" });
    expect(mockState.queries).toHaveLength(0);
  });

  it("a thrown query -> query_failed", async () => {
    mockState.throwOnQuery = true;
    expect(await list(ALL)).toEqual({ status: "query_failed" });
  });
});

describe("zero side effects", () => {
  it("no write of any kind is attempted on any path", async () => {
    videos(teamVideoDoc("a", { projectId: "p1" }, T + 1), teamVideoDoc("b", {}, T));
    projects(projectDoc("p1"));
    await list(ALL);
    await list(UNFILED);
    await list({ kind: "project", project: P1_LABEL });
    expect(mockState.writeAttempts).toEqual([]);
  });
});
