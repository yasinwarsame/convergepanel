/**
 * TEAM-VERIFICATION-PARITY-R3 — `listTeamClaimVerifications()`: query shape,
 * ordering, pagination, scope isolation, fail-whole-window integrity (peek row
 * included), batched Project validation, summary DTO and zero writes.
 */

jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamClaimFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamClaimFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamClaimFakeFirestore");
    return mockState.unavailable ? null : makeFakeDb(mockState);
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { listTeamClaimVerifications } from "@/lib/workspaces/listTeamClaimVerifications";
import { encodeTeamClaimVerificationsCursor, decodeTeamClaimVerificationsCursor } from "@/lib/workspaces/teamClaimVerificationsCursor";
import { createFakeState, FakeTimestamp, projectDoc, TEAM_W, teamClaimDoc } from "@/lib/workspaces/__tests__/teamClaimFakeFirestore";

const T = 1_700_000_000_000;
const ALL = { kind: "all" as const };
const UNFILED = { kind: "unfiled" as const };
const P1_LABEL = { id: "p1", name: "Project p1", status: "active" };

function claims(...docs: ReturnType<typeof teamClaimDoc>[]) {
  mockState.collections.verifications = docs;
}
function projects(...docs: ReturnType<typeof projectDoc>[]) {
  mockState.collections.projects = docs;
}
async function list(scope: Parameters<typeof listTeamClaimVerifications>[0]["scope"], limit = 20, cursorRaw?: string | null) {
  return listTeamClaimVerifications({ workspaceId: TEAM_W, scope, limit, cursorRaw });
}
const ids = (r: Awaited<ReturnType<typeof list>>) => (r.status === "ok" ? r.items.map((i) => i.verificationId) : r.status);
const projectReads = () => mockState.getAllCalls.flat().filter((p) => p.startsWith("projects/")).length + mockState.docGets.filter((p) => p.startsWith("projects/")).length;

beforeEach(() => {
  mockState = createFakeState();
});

describe("query shape — scope comes only from the addressed URL, never the creator", () => {
  it("all: workspaceId == W only; timestamp DESC then documentId DESC; limit + 1", async () => {
    claims(teamClaimDoc("v1"));
    await list(ALL, 5);
    expect(mockState.queries).toEqual([
      { collection: "verifications", filters: [{ field: "workspaceId", op: "==", value: TEAM_W }], orders: [{ field: "timestamp", dir: "desc" }, { field: "__name__", dir: "desc" }], limit: 6 },
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

  it("never filters by userId: a Claim created by a different member is listed", async () => {
    claims(teamClaimDoc("by-a", { userId: "creator-a" }, T + 2), teamClaimDoc("by-b", { userId: "creator-b" }, T + 1));
    expect(ids(await list(ALL))).toEqual(["by-a", "by-b"]);
    expect(JSON.stringify(mockState.queries)).not.toContain("userId");
  });
});

describe("ordering and pagination", () => {
  it("newest first; equal timestamps order by document id DESC", async () => {
    claims(teamClaimDoc("a", {}, T), teamClaimDoc("c", {}, T), teamClaimDoc("b", {}, T), teamClaimDoc("newest", {}, T + 1000));
    expect(ids(await list(ALL))).toEqual(["newest", "c", "b", "a"]);
  });

  it("empty Workspace -> ok, no items, hasMore false, no cursor, no Project read", async () => {
    const r = await list(ALL);
    expect(r).toEqual({ status: "ok", items: [], hasMore: false });
    expect(projectReads()).toBe(0);
  });

  it("pages with an opaque position-only cursor until exhausted, no duplicates or gaps", async () => {
    claims(...Array.from({ length: 5 }, (_, i) => teamClaimDoc(`v${i}`, {}, T + i * 1000)));
    const p1 = await list(ALL, 2);
    expect(ids(p1)).toEqual(["v4", "v3"]);
    expect(p1.status === "ok" && p1.hasMore).toBe(true);
    const c1 = p1.status === "ok" ? p1.nextCursor : undefined;
    expect(decodeTeamClaimVerificationsCursor(c1)).toEqual({ ok: true, cursor: { timestampSeconds: Math.floor((T + 3000) / 1000), timestampNanoseconds: 0, lastDocId: "v3" } });
    const p2 = await list(ALL, 2, c1);
    expect(ids(p2)).toEqual(["v2", "v1"]);
    const p3 = await list(ALL, 2, p2.status === "ok" ? p2.nextCursor : undefined);
    expect(ids(p3)).toEqual(["v0"]);
    expect(p3.status === "ok" && p3.hasMore).toBe(false);
    expect(p3.status === "ok" && p3.nextCursor).toBeUndefined();
  });

  it("the cursor carries no scope: the same cursor under another scope still uses that scope's URL predicates", async () => {
    claims(teamClaimDoc("filed", { projectId: "p1" }, T + 2000), teamClaimDoc("unfiled-1", {}, T + 1000), teamClaimDoc("unfiled-0", {}, T));
    projects(projectDoc("p1"));
    const cursor = encodeTeamClaimVerificationsCursor({ timestampSeconds: Math.floor((T + 2000) / 1000), timestampNanoseconds: 0, lastDocId: "filed" });
    const r = await list(UNFILED, 20, cursor);
    expect(ids(r)).toEqual(["unfiled-1", "unfiled-0"]);
    expect(mockState.queries[0].filters).toContainEqual({ field: "projectId", op: "==", value: null });
    expect(JSON.stringify(decodeTeamClaimVerificationsCursor(cursor))).not.toMatch(/workspace|project|uid|scope/i);
  });

  it.each(["not-base64-!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ v: 1, s: -1, n: 0, i: "x" })).toString("base64url"), Buffer.from(JSON.stringify({ v: 2, s: 1, n: 0, i: "x" })).toString("base64url"), ""])("malformed cursor %j -> invalid_cursor, no query", async (bad) => {
    expect(await list(ALL, 20, bad)).toEqual({ status: "invalid_cursor" });
    expect(mockState.queries).toEqual([]);
  });
});

describe("scope isolation", () => {
  it("Personal Claims (no workspaceId) and foreign-Workspace Claims are never returned", async () => {
    const personal = teamClaimDoc("personal", {});
    delete personal.data.workspaceId;
    delete personal.data.projectId;
    claims(teamClaimDoc("mine"), personal, teamClaimDoc("foreign", { workspaceId: "ws-other" }));
    expect(ids(await list(ALL))).toEqual(["mine"]);
  });

  it("unfiled excludes Project-bound rows; project scope excludes unfiled and other-Project rows", async () => {
    claims(teamClaimDoc("unfiled", {}, T + 3), teamClaimDoc("in-p1", { projectId: "p1" }, T + 2), teamClaimDoc("in-p2", { projectId: "p2" }, T + 1));
    projects(projectDoc("p1"), projectDoc("p2"));
    expect(ids(await list(UNFILED))).toEqual(["unfiled"]);
    expect(ids(await list({ kind: "project", project: P1_LABEL }))).toEqual(["in-p1"]);
  });
});

describe("fail-whole-window integrity (peek row included)", () => {
  const malformations: Array<[string, Record<string, unknown>]> = [
    ["wrong type", { type: "video_verification" }],
    ["empty userId", { userId: "" }],
    ["non-Timestamp timestamp", { timestamp: 1_700_000_000_000 }],
    ["malformed projectId", { projectId: 42 }],
    ["unusable verdict", { verdict: "maybe" }],
    ["missing claim", { claim: undefined }],
    ["non-numeric consensusScore", { consensusScore: "80" }],
  ];

  it.each(malformations)("emitted row with %s -> integrity_violation, no partial page", async (_l, bad) => {
    claims(teamClaimDoc("good", {}, T + 2), teamClaimDoc("bad", bad, T + 1));
    expect(await list(ALL)).toEqual({ status: "integrity_violation" });
  });

  it("absent projectId on a Team row -> integrity_violation (and it can never match the unfiled null query)", async () => {
    const row = teamClaimDoc("no-project-field");
    delete row.data.projectId;
    claims(teamClaimDoc("good", {}, T + 1), row);
    expect(await list(ALL)).toEqual({ status: "integrity_violation" });
  });

  it("a malformed PEEK row (limit=2, third fetched row) fails the whole request, never ok/hasMore", async () => {
    claims(teamClaimDoc("a", {}, T + 3), teamClaimDoc("b", {}, T + 2), teamClaimDoc("peek", { type: "other" }, T + 1));
    expect(await list(ALL, 2)).toEqual({ status: "integrity_violation" });
  });

  it("a VALID peek row paginates normally and is never emitted", async () => {
    claims(teamClaimDoc("a", {}, T + 3), teamClaimDoc("b", {}, T + 2), teamClaimDoc("peek", {}, T + 1));
    const r = await list(ALL, 2);
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.status === "ok" && r.hasMore).toBe(true);
  });
});

describe("batched Project reference validation (scope all)", () => {
  it("zero Project references -> zero Project reads", async () => {
    claims(teamClaimDoc("u1", {}, T + 1), teamClaimDoc("u2", {}, T));
    expect(ids(await list(ALL))).toEqual(["u1", "u2"]);
    expect(projectReads()).toBe(0);
  });

  it("repeated and distinct Project ids -> exactly ONE getAll with unique refs; labels come from it", async () => {
    claims(teamClaimDoc("x1", { projectId: "p1" }, T + 3), teamClaimDoc("x2", { projectId: "p1" }, T + 2), teamClaimDoc("x3", { projectId: "p2" }, T + 1));
    projects(projectDoc("p1", { name: "Alpha" }), projectDoc("p2", { name: "Beta", status: "archived" }));
    const r = await list(ALL);
    expect(mockState.getAllCalls).toEqual([["projects/p1", "projects/p2"]]);
    expect(mockState.docGets).toEqual([]);
    expect(r.status === "ok" && r.items.map((i) => i.project)).toEqual([
      { id: "p1", name: "Alpha", status: "active" },
      { id: "p1", name: "Alpha", status: "active" },
      { id: "p2", name: "Beta", status: "archived" },
    ]);
  });

  it("an archived Project's Claims stay visible", async () => {
    claims(teamClaimDoc("archived-claim", { projectId: "p9" }));
    projects(projectDoc("p9", { status: "archived" }));
    expect(ids(await list(ALL))).toEqual(["archived-claim"]);
  });

  it.each([
    ["missing Project", () => projects()],
    ["malformed Project", () => projects(projectDoc("p1", { schemaVersion: 2 }))],
    ["embedded id mismatch", () => projects({ id: "p1", data: projectDoc("other").data })],
    ["Project in another Workspace", () => projects(projectDoc("p1", { workspaceId: "ws-other" }))],
  ])("%s referenced in the window -> integrity_violation", async (_l, setup) => {
    claims(teamClaimDoc("x", { projectId: "p1" }));
    setup();
    expect(await list(ALL)).toEqual({ status: "integrity_violation" });
  });

  it("the PEEK row's Project reference is validated in the same single getAll", async () => {
    claims(teamClaimDoc("a", {}, T + 2), teamClaimDoc("peek", { projectId: "p-missing" }, T + 1));
    expect(await list(ALL, 1)).toEqual({ status: "integrity_violation" });
    expect(mockState.getAllCalls).toEqual([["projects/p-missing"]]);
  });

  it("unfiled and project scopes perform zero Project reads", async () => {
    claims(teamClaimDoc("u"), teamClaimDoc("f", { projectId: "p1" }));
    await list(UNFILED);
    await list({ kind: "project", project: P1_LABEL });
    expect(projectReads()).toBe(0);
  });
});

describe("summary DTO", () => {
  it("summary fields only: no creator uid, raw timestamp, model evidence, audit bundle, origin or evidence sources", async () => {
    claims(teamClaimDoc("v", { projectId: "p1", governanceStatus: "needs_review", origin: { type: "deep_research_claim", runId: "SECRET-RUN", claimId: "c" }, evidenceSources: [{ url: "https://x", hostname: "x" }] }, T));
    projects(projectDoc("p1"));
    const r = await list(ALL);
    expect(r.status === "ok" && r.items[0]).toEqual({
      verificationId: "v",
      claim: "Claim v",
      verdict: "confirmed",
      consensusScore: 80,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      governanceStatus: "needs_review",
      createdAt: new Date(T).toISOString(),
      workspaceId: TEAM_W,
      projectId: "p1",
      project: { id: "p1", name: "Project p1", status: "active" },
    });
    const json = JSON.stringify(r);
    for (const leaked of ["creator-a", "userId", "SECRET-RUN", "modelResults", "auditBundle", "evidenceSources", "seconds", "nanoseconds", "createdByUserId", "schemaVersion"]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("evidenceQuality falls back to mixed and an unknown governance status is omitted", async () => {
    claims(teamClaimDoc("v", { evidenceQuality: undefined, governanceStatus: "weird" }));
    const r = await list(ALL);
    expect(r.status === "ok" && r.items[0].evidenceQuality).toBe("mixed");
    expect(r.status === "ok" && "governanceStatus" in r.items[0]).toBe(false);
  });
});

describe("infrastructure and zero side effects", () => {
  it("Firestore unavailable -> query_failed; query throws -> query_failed", async () => {
    mockState.unavailable = true;
    expect(await list(ALL)).toEqual({ status: "query_failed" });
    mockState.unavailable = false;
    mockState.throwOnQuery = true;
    expect(await list(ALL)).toEqual({ status: "query_failed" });
  });

  it("a Project read failure in scope all -> query_failed, never a partial page", async () => {
    claims(teamClaimDoc("x", { projectId: "p1" }));
    projects(projectDoc("p1"));
    mockState.throwOnDocGetCollections.add("projects");
    expect(await list(ALL)).toEqual({ status: "query_failed" });
  });

  it("listing never attempts a write", async () => {
    claims(teamClaimDoc("x", { projectId: "p1" }), teamClaimDoc("y"));
    projects(projectDoc("p1"));
    await list(ALL);
    await list(UNFILED);
    await list({ kind: "project", project: P1_LABEL });
    expect(mockState.writeAttempts).toEqual([]);
  });
});

void FakeTimestamp;
