/**
 * Project/Research Assignment (D4, §6.6) — read-side presentation: ONE
 * batched membership `getAll` per call, membership-evidenced names, `state`
 * derived per target kind, removed members still named, fail-closed to
 * `stale`. Includes the enrichment helpers (malformed stored values ⇒
 * `[]`/`null`, logged, never surfaced) and the D4 "stale but still rendered
 * by name" proof.
 */

const getAllSpy = jest.fn();
let adminDbAvailable = true;
const memberships = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    if (!adminDbAvailable) return null;
    return {
      collection: (name: string) => ({ doc: (id: string) => ({ __collection: name, __id: id }) }),
      getAll: (...refs: { __id: string }[]) => {
        getAllSpy(...refs);
        return Promise.resolve(refs.map((r) => ({ exists: memberships.has(r.__id), data: () => memberships.get(r.__id) })));
      },
    };
  },
}));
const mockNames = jest.fn();
jest.mock("../workspaceReviewerIdentity", () => ({
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable reviewer",
  resolveWorkspaceReviewerDisplayNames: (...a: unknown[]) => mockNames(...a),
}));
const mockedLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));
import { Timestamp } from "firebase-admin/firestore";
import { computeMembershipId } from "../membershipId";
import { resolveAssigneePresentations } from "../assigneePresentation";
import { enrichTeamProjectDtos } from "../teamProjectAssigneeEnrichment";
import { resolveRunAssigneesForPage } from "../teamRunAssigneeEnrichment";

const WS = "ws-1";
function seed(uid: string, role: string, status = "active", workspaceId = WS) {
  const id = computeMembershipId(workspaceId, uid);
  memberships.set(id, { schemaVersion: 1, id, workspaceId, uid, role, status, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null });
}

beforeEach(() => {
  memberships.clear();
  getAllSpy.mockClear();
  adminDbAvailable = true;
  mockedLogger.warn.mockClear();
  mockNames.mockImplementation(async (_ws: string, uids: string[], fallback: string) => new Map(uids.map((u) => [u, u === "ghost" ? fallback : `Name(${u})`])));
});

describe("resolveAssigneePresentations", () => {
  it("ONE getAll for the whole uid set (deduped); names from the membership-evidenced resolver; state per kind", async () => {
    seed("m1", "member");
    seed("v1", "viewer");
    const r = await resolveAssigneePresentations(WS, "run", ["m1", "v1", "m1"]);
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(getAllSpy.mock.calls[0]).toHaveLength(2);
    expect(r.get("m1")).toEqual({ uid: "m1", displayName: "Name(m1)", state: "active" });
    expect(r.get("v1")).toEqual({ uid: "v1", displayName: "Name(v1)", state: "stale" }); // D2 run rule
    const p = await resolveAssigneePresentations(WS, "project", ["v1"]);
    expect(p.get("v1")!.state).toBe("active"); // D2 Project rule
  });

  it("D4 — a REMOVED member is still rendered BY NAME with state stale (history preserved, nothing granted)", async () => {
    seed("gone", "member", "removed");
    const r = await resolveAssigneePresentations(WS, "project", ["gone"]);
    expect(r.get("gone")).toEqual({ uid: "gone", displayName: "Name(gone)", state: "stale" });
  });

  it("a uid with no membership at all, or a foreign-Workspace membership, is stale; a non-evidenced uid gets the fallback label, never the raw uid", async () => {
    seed("foreign", "member", "active", "ws-other");
    const r = await resolveAssigneePresentations(WS, "project", ["ghost", "foreign"]);
    expect(r.get("ghost")).toEqual({ uid: "ghost", displayName: "Unavailable reviewer", state: "stale" });
    expect(r.get("foreign")!.state).toBe("stale");
  });

  it("empty input ⇒ no reads at all; Firestore unavailable ⇒ every entry stale (never fabricated active)", async () => {
    expect((await resolveAssigneePresentations(WS, "run", [])).size).toBe(0);
    expect(getAllSpy).not.toHaveBeenCalled();
    adminDbAvailable = false;
    seed("m1", "member");
    const r = await resolveAssigneePresentations(WS, "run", ["m1"]);
    expect(r.get("m1")!.state).toBe("stale");
  });
});

describe("enrichTeamProjectDtos", () => {
  const project = (id: string, assigneeUids: unknown) => ({ project: { schemaVersion: 1, id, workspaceId: WS, name: "P", status: "active", createdByUserId: "o", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...(assigneeUids === undefined ? {} : { assigneeUids }) } as never, documentUpdateTime: null as unknown as Timestamp });

  it("one batched resolve per PAGE; each DTO gets its ordered presentations; unassigned ⇒ []", async () => {
    seed("a", "member");
    seed("b", "viewer");
    const dtos = await enrichTeamProjectDtos(WS, [project("p1", ["b", "a"]), project("p2", ["a"]), project("p3", undefined)]);
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(dtos[0].assignees.map((x) => x.uid)).toEqual(["a", "b"]);
    expect(dtos[1].assignees.map((x) => x.uid)).toEqual(["a"]);
    expect(dtos[2].assignees).toEqual([]);
  });

  it("MALFORMED stored assigneeUids ('x') lists as [] WITHOUT failing the page, logs once, and never leaks the raw value (positive control: the valid sibling row is enriched)", async () => {
    seed("a", "member");
    const dtos = await enrichTeamProjectDtos(WS, [project("bad", "x"), project("ok", ["a"])]);
    expect(dtos).toHaveLength(2);
    expect(dtos[0].assignees).toEqual([]);
    expect(dtos[1].assignees).toHaveLength(1);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(dtos)).not.toContain('"x"');
  });
});

describe("resolveRunAssigneesForPage", () => {
  it("normalizes each row, resolves once per page under the RUN rule, returns null for unassigned", async () => {
    seed("m1", "member");
    seed("v1", "viewer");
    const r = await resolveRunAssigneesForPage(WS, [
      { docId: "r1", data: { assigneeUid: "m1" } },
      { docId: "r2", data: {} },
      { docId: "r3", data: { assigneeUid: "v1" } },
    ]);
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(r).toEqual([
      { uid: "m1", displayName: "Name(m1)", state: "active" },
      null,
      { uid: "v1", displayName: "Name(v1)", state: "stale" },
    ]);
  });

  it("MALFORMED stored assigneeUid (42) reads as null, logs once, raw value never surfaced (positive control: valid sibling)", async () => {
    seed("m1", "member");
    const r = await resolveRunAssigneesForPage(WS, [
      { docId: "bad", data: { assigneeUid: 42 } },
      { docId: "ok", data: { assigneeUid: "m1" } },
    ]);
    expect(r[0]).toBeNull();
    expect(r[1]!.uid).toBe("m1");
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain("42");
  });
});
