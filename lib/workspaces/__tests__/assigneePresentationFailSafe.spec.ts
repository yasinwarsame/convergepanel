/**
 * PR #164 review C1 — presentation over an already-committed canonical
 * state must NEVER throw. Injects (1) a membership batch-read failure,
 * (2) a rejecting `resolveWorkspaceReviewerDisplayNames()`, (3) both, and
 * proves the map still covers EVERY requested uid with the fallback label
 * + `stale` (never "active", never a raw uid), that both enrichment
 * helpers degrade the same way, and that the failure is logged without
 * any uid. Positive control: with nothing failing, names resolve and an
 * active member reads `active`.
 */

let getAllShouldThrow = false;
const memberships = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({ doc: (id: string) => ({ __collection: name, __id: id }) }),
      getAll: (...refs: { __id: string }[]) => {
        if (getAllShouldThrow) return Promise.reject(new Error("UNAVAILABLE: simulated membership batch failure"));
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
const UIDS = ["member-alpha", "member-beta", "member-gamma"];
function seed(uid: string) {
  const id = computeMembershipId(WS, uid);
  memberships.set(id, { schemaVersion: 1, id, workspaceId: WS, uid, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null });
}
const project = (id: string, assigneeUids: string[]) => ({ project: { schemaVersion: 1, id, workspaceId: WS, name: "P", status: "active", createdByUserId: "o", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), assigneeUids } as never, documentUpdateTime: null as never });

beforeEach(() => {
  memberships.clear();
  getAllShouldThrow = false;
  mockedLogger.warn.mockClear();
  mockNames.mockReset();
  mockNames.mockImplementation(async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])));
  for (const u of UIDS) seed(u);
});

it("POSITIVE CONTROL — nothing failing: names resolve and active members read active", async () => {
  const r = await resolveAssigneePresentations(WS, "project", UIDS);
  expect(r.get("member-alpha")).toEqual({ uid: "member-alpha", displayName: "Name(member-alpha)", state: "active" });
});

it("(1) membership batch-read failure ⇒ every uid still present, names still resolve, state stale (never fabricated active)", async () => {
  getAllShouldThrow = true;
  const r = await resolveAssigneePresentations(WS, "project", UIDS);
  expect(r.size).toBe(3);
  for (const u of UIDS) expect(r.get(u)).toEqual({ uid: u, displayName: `Name(${u})`, state: "stale" });
});

it("(2) name-resolver REJECTION ⇒ never throws; every uid present with the fallback label; no raw uid as a name; logged without uids", async () => {
  mockNames.mockRejectedValue(new Error("UNAVAILABLE: simulated resolver failure"));
  const r = await resolveAssigneePresentations(WS, "run", UIDS);
  expect(r.size).toBe(3);
  for (const u of UIDS) {
    // The membership read succeeded, so state is genuinely active; only the NAME degraded.
    expect(r.get(u)).toEqual({ uid: u, displayName: "Unavailable reviewer", state: "active" });
    expect(r.get(u)!.displayName).not.toBe(u);
  }
  expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Display-name resolution failed"), expect.anything());
  expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toMatch(/member-(alpha|beta|gamma)/);
});

it("(3) BOTH failing ⇒ fallback label + stale for every uid", async () => {
  getAllShouldThrow = true;
  mockNames.mockRejectedValue(new Error("boom"));
  const r = await resolveAssigneePresentations(WS, "project", UIDS);
  for (const u of UIDS) expect(r.get(u)).toEqual({ uid: u, displayName: "Unavailable reviewer", state: "stale" });
});

it("enrichTeamProjectDtos and resolveRunAssigneesForPage degrade identically instead of rejecting (a committed mutation's response never fails)", async () => {
  mockNames.mockRejectedValue(new Error("boom"));
  getAllShouldThrow = true;
  const dtos = await enrichTeamProjectDtos(WS, [project("p1", ["member-alpha", "member-beta"])]);
  expect(dtos[0].assignees).toEqual([
    { uid: "member-alpha", displayName: "Unavailable reviewer", state: "stale" },
    { uid: "member-beta", displayName: "Unavailable reviewer", state: "stale" },
  ]);
  const runs = await resolveRunAssigneesForPage(WS, [{ docId: "r1", data: { assigneeUid: "member-gamma" } }, { docId: "r2", data: {} }]);
  expect(runs).toEqual([{ uid: "member-gamma", displayName: "Unavailable reviewer", state: "stale" }, null]);
});

it("a synchronously THROWING resolver is contained the same way (never a rejected enrichment)", async () => {
  mockNames.mockImplementation(() => {
    throw new Error("sync boom");
  });
  await expect(enrichTeamProjectDtos(WS, [project("p1", ["member-alpha"])])).resolves.toHaveLength(1);
  await expect(resolveRunAssigneesForPage(WS, [{ docId: "r1", data: { assigneeUid: "member-alpha" } }])).resolves.toEqual([{ uid: "member-alpha", displayName: "Unavailable reviewer", state: "active" }]);
});
