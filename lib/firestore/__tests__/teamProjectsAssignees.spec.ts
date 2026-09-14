/**
 * Project/Research Assignment — `updateTeamProjectFields({kind: "set_assignees"})`.
 * Buffered-transaction fake with a native `lastUpdateTime` precondition on
 * `tx.update`, `txGetLog` (bounded-read proofs), `txSetLog`/`txUpdateLog`
 * (atomicity), and NO seat/quota collection (structural tripwire). Frozen
 * orderings under test (§6.4): canonicalize (no I/O) → admission → auth →
 * project read → archived → TOKEN COMPARE → target validation (≤ 20 reads)
 * → no-op → write + event.
 */

import { Timestamp } from "firebase-admin/firestore";

let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}
type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredDoc>> = { workspaces: new Map(), workspaceMemberships: new Map(), projects: new Map(), workspaceMembershipEvents: new Map() };
function resetStores() {
  for (const s of Object.values(stores)) s.clear();
}
class FirestoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
let autoId = 0;
let forceSetFailureForCollection: string | null = null;
let txGetLog: { collection: string; id: string }[] = [];
let txSetLog: { collection: string; id: string; data: Record<string, unknown> }[] = [];
let txUpdateLog: { collection: string; id: string; data: Record<string, unknown> }[] = [];

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    get: async () => {
      const entry = stores[collectionName].get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
    },
  };
}
const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoId}`) }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const pendingWrites: Array<() => void> = [];
    let hasWritten = false;
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (hasWritten) throw new Error("Firestore transactions require all reads to be executed before all writes.");
        const store = stores[ref.__collection];
        if (!store) throw new Error(`unregistered collection ${ref.__collection}`);
        txGetLog.push({ collection: ref.__collection, id: ref.__id });
        const entry = store.get(ref.__id);
        return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>, precondition?: { lastUpdateTime?: Timestamp }) => {
        hasWritten = true;
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        if (!entry) throw new FirestoreError("5", "NOT_FOUND");
        if (precondition?.lastUpdateTime) {
          const e = precondition.lastUpdateTime;
          if (entry.updateTime.seconds !== e.seconds || entry.updateTime.nanoseconds !== e.nanoseconds) throw new FirestoreError("9", "FAILED_PRECONDITION");
        }
        txUpdateLog.push({ collection: ref.__collection, id: ref.__id, data });
        pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
      },
      set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        hasWritten = true;
        if (forceSetFailureForCollection === ref.__collection) throw new FirestoreError("14", "UNAVAILABLE");
        txSetLog.push({ collection: ref.__collection, id: ref.__id, data });
        pendingWrites.push(() => stores[ref.__collection].set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
    };
    const result = await fn(txn);
    for (const w of pendingWrites) w();
    return result;
  }),
};
const firestoreUnavailable = { value: false };
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable.value ? null : mockAdminDb;
  },
}));
let teamEnabled = true;
let assignmentEnabled = true;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return undefined;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return undefined;
  },
  get PROJECT_ASSIGNMENT_ENABLED() {
    return assignmentEnabled;
  },
  get PROJECT_ASSIGNMENT_CANARY_UIDS() {
    return undefined;
  },
}));
const mockedLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";

const WS_ID = "ws-team-1";
const OTHER_WS = "ws-team-2";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";
const REVIEWER = "reviewer-1";
const VIEWER = "viewer-1";
const OUTSIDER = "outsider-1";
const PROJECT_ID = "proj-1";
const ts = (s: number) => new Timestamp(s, 0);

function seedWorkspace(id = WS_ID) {
  stores.workspaces.set(id, { data: { schemaVersion: 1, id, type: "team", name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: ts(1), updatedAt: ts(1) }, updateTime: nextUpdateTime() });
}
function seedMembership(uid: string, role: string, workspaceId = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  stores.workspaceMemberships.set(id, { data: { schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: ts(1), updatedAt: ts(1), invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides }, updateTime: nextUpdateTime() });
}
function seedProject(overrides: Record<string, unknown> = {}): Timestamp {
  const data = { schemaVersion: 1, id: PROJECT_ID, workspaceId: WS_ID, name: "Due Diligence", status: "active", createdByUserId: OWNER, createdAt: ts(1), updatedAt: ts(1), ...overrides };
  const updateTime = nextUpdateTime();
  stores.projects.set(PROJECT_ID, { data, updateTime });
  return updateTime;
}
function fullTeam() {
  seedWorkspace();
  seedMembership(OWNER, "owner");
  seedMembership(ADMIN, "admin");
  seedMembership(MEMBER, "member");
  seedMembership(REVIEWER, "reviewer");
  seedMembership(VIEWER, "viewer");
}
const call = (assigneeUids: unknown, expectedUpdateTime: Timestamp, uid = OWNER) => updateTeamProjectFields({ uid, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "set_assignees", assigneeUids }, expectedUpdateTime });
const membershipReads = () => txGetLog.filter((g) => g.collection === "workspaceMemberships" && g.id !== computeMembershipId(WS_ID, OWNER) && g.id !== computeMembershipId(WS_ID, ADMIN));
const events = () => Array.from(stores.workspaceMembershipEvents.values()).map((e) => e.data);
const uid = (n: number) => `user-${String(n).padStart(3, "0")}`;

beforeEach(() => {
  resetStores();
  autoId = 0;
  txGetLog = [];
  txSetLog = [];
  txUpdateLog = [];
  forceSetFailureForCollection = null;
  firestoreUnavailable.value = false;
  teamEnabled = true;
  assignmentEnabled = true;
  mockedLogger.warn.mockClear();
  mockAdminDb.runTransaction.mockClear();
});

describe("canonicalization runs BEFORE any I/O (bounded reads)", () => {
  it("1,000 entries with > 20 unique ⇒ too_many_assignees with ZERO transactions and ZERO membership reads", async () => {
    fullTeam();
    const t = seedProject();
    const raw = Array.from({ length: 1000 }, (_, i) => uid(i % 21));
    expect(await call(raw, t)).toEqual({ status: "too_many_assignees" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    expect(txGetLog).toHaveLength(0);
  });
  it("1,000 entries collapsing to 3 unique ⇒ exactly 3 target reads (positive control: one read per unique target)", async () => {
    fullTeam();
    const t = seedProject();
    const raw = Array.from({ length: 1000 }, (_, i) => [OWNER, MEMBER, VIEWER][i % 3]);
    const r = await call(raw, t);
    expect(r.status).toBe("updated");
    expect(membershipReads()).toHaveLength(2); // MEMBER + VIEWER targets (OWNER's target read is excluded by the helper; see next line)
    // auth read (OWNER) + 3 target reads (OWNER, MEMBER, VIEWER) = 4 — never 1,000.
    expect(txGetLog.filter((g) => g.collection === "workspaceMemberships")).toHaveLength(4);
  });
  it("malformed entries ⇒ invalid_assignees before any I/O; a rollout-disabled caller cannot distinguish (admission comes AFTER canonicalization)", async () => {
    fullTeam();
    const t = seedProject();
    expect(await call([42], t)).toEqual({ status: "invalid_assignees" });
    expect(await call("x", t)).toEqual({ status: "invalid_assignees" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });
  it("D10 — assignment admission is required in addition to Team admission; lifecycle ops are NOT gated by it", async () => {
    fullTeam();
    const t = seedProject();
    assignmentEnabled = false;
    expect(await call([MEMBER], t)).toEqual({ status: "project_assignment_disabled" });
    const archive = await updateTeamProjectFields({ uid: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "archive" }, expectedUpdateTime: t });
    expect(archive.status).toBe("updated");
  });
});

describe("authorization — projects.manage in-transaction", () => {
  it.each([
    ["reviewer", REVIEWER],
    ["viewer", VIEWER],
    ["outsider", OUTSIDER],
  ])("%s is denied and nothing is written", async (_r, who) => {
    fullTeam();
    const t = seedProject();
    const r = await call([MEMBER], t, who);
    expect(r.status).toBe("unauthorized");
    expect(txUpdateLog).toHaveLength(0);
  });
  it("owner, admin and member (the roles holding projects.manage) may set assignees", async () => {
    fullTeam();
    const t = seedProject();
    expect((await call([MEMBER], t, ADMIN)).status).toBe("updated");
    const t2 = stores.projects.get(PROJECT_ID)!.updateTime;
    expect((await call([VIEWER], t2, MEMBER)).status).toBe("updated");
  });
});

describe("order: archived → token → targets → no-op", () => {
  it("archived Project ⇒ project_archived, even with a stale token (archived check precedes the token compare)", async () => {
    fullTeam();
    seedProject({ status: "archived" });
    expect(await call([MEMBER], ts(5))).toEqual({ status: "project_archived" });
  });
  it("STALE TOKEN NEVER NO-OPS: a stale expectedUpdateTime with an ALREADY-CURRENT list ⇒ precondition_failed, and ZERO target reads", async () => {
    fullTeam();
    seedProject({ assigneeUids: [MEMBER] });
    expect(await call([MEMBER], ts(5))).toEqual({ status: "precondition_failed" });
    expect(membershipReads()).toHaveLength(0);
  });
  it("positive control — a current token with the same list ⇒ unchanged (after validation)", async () => {
    fullTeam();
    const t = seedProject({ assigneeUids: [MEMBER] });
    const r = await call([MEMBER], t);
    expect(r.status).toBe("unchanged");
    expect(membershipReads()).toHaveLength(1);
  });
  it("D2 SAME FIXTURE: a Viewer IS a valid Project assignee (contrast: never a run assignee)", async () => {
    fullTeam();
    const t = seedProject();
    expect((await call([VIEWER, REVIEWER], t)).status).toBe("updated");
    expect(stores.projects.get(PROJECT_ID)!.data.assigneeUids).toEqual([REVIEWER, VIEWER]);
  });
  it("a removed member / outsider / foreign member ⇒ assignee_not_eligible, no write", async () => {
    fullTeam();
    seedWorkspace(OTHER_WS);
    seedMembership("foreign-1", "member", OTHER_WS);
    seedMembership(MEMBER, "member", WS_ID, { status: "removed" });
    const t = seedProject();
    expect(await call([MEMBER], t)).toEqual({ status: "assignee_not_eligible" });
    expect(await call([OUTSIDER], t)).toEqual({ status: "assignee_not_eligible" });
    expect(await call(["foreign-1"], t)).toEqual({ status: "assignee_not_eligible" });
    expect(txUpdateLog).toHaveLength(0);
  });
  it("SAME-LIST REPEAT STILL VALIDATES: repeating the current list after one member was removed ⇒ assignee_not_eligible, not unchanged", async () => {
    fullTeam();
    const t = seedProject({ assigneeUids: [MEMBER, VIEWER] });
    seedMembership(MEMBER, "member", WS_ID, { status: "removed" });
    expect(await call([MEMBER, VIEWER], t)).toEqual({ status: "assignee_not_eligible" });
  });
});

describe("D6 no-op vs real change; D5 audit event; atomicity", () => {
  it("D6 — unchanged: updateTime unchanged, no update, no event (positive control: a real change does both)", async () => {
    fullTeam();
    const t = seedProject({ assigneeUids: [VIEWER, MEMBER] });
    const r = await call([MEMBER, VIEWER, MEMBER], t); // unsorted + duplicate ⇒ canonical equal
    expect(r).toMatchObject({ status: "unchanged", documentUpdateTime: t });
    expect(stores.projects.get(PROJECT_ID)!.updateTime).toEqual(t);
    expect(txUpdateLog).toHaveLength(0);
    expect(events()).toHaveLength(0);

    const r2 = await call([MEMBER], t);
    expect(r2.status).toBe("updated");
    expect(stores.projects.get(PROJECT_ID)!.updateTime).not.toEqual(t);
    expect(txUpdateLog).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });
  it("real change writes the CANONICAL list + updatedAt only, and the event (uids only, diff) via tx.set in the SAME transaction", async () => {
    fullTeam();
    const t = seedProject({ assigneeUids: [VIEWER] });
    const r = await call([MEMBER, REVIEWER, MEMBER], t);
    expect(r.status).toBe("updated");
    expect(txUpdateLog[0].data).toEqual({ assigneeUids: [MEMBER, REVIEWER], updatedAt: expect.anything() });
    expect(Object.keys(txUpdateLog[0].data).sort()).toEqual(["assigneeUids", "updatedAt"]);
    expect(txSetLog).toHaveLength(1);
    expect(events()[0]).toEqual({
      eventType: "workspace_project_assignees_changed",
      actorUid: OWNER,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      projectName: "Due Diligence",
      addedUids: [MEMBER, REVIEWER],
      removedUids: [VIEWER],
      at: expect.anything(),
    });
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });
  it("clearing to [] is a real change recording removals only", async () => {
    fullTeam();
    const t = seedProject({ assigneeUids: [VIEWER, MEMBER] });
    expect((await call([], t)).status).toBe("updated");
    expect(events()[0]).toMatchObject({ addedUids: [], removedUids: [MEMBER, VIEWER] });
  });
  it("MALFORMED stored assigneeUids ('x') normalizes to []: a repeat of [] is NOT a no-op (repair write), a warning is logged, and the raw value never appears in the log", async () => {
    fullTeam();
    const t = seedProject({ assigneeUids: "x" });
    const r = await call([], t);
    expect(r.status).toBe("updated");
    expect(stores.projects.get(PROJECT_ID)!.data.assigneeUids).toEqual([]);
    expect(events()[0]).toMatchObject({ addedUids: [], removedUids: [] });
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Malformed stored assigneeUids"), expect.anything());
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain('"x"');
  });
  it("ATOMICITY — event write failure rolls back the assignee write", async () => {
    fullTeam();
    const t = seedProject();
    forceSetFailureForCollection = "workspaceMembershipEvents";
    const r = await call([MEMBER], t);
    expect(r.status).toBe("update_failed");
    expect(stores.projects.get(PROJECT_ID)!.data.assigneeUids).toBeUndefined();
    expect(stores.projects.get(PROJECT_ID)!.updateTime).toEqual(t);
    expect(events()).toHaveLength(0);
  });
  it("the returned project reflects the committed list and a fresh documentUpdateTime", async () => {
    fullTeam();
    const t = seedProject();
    const r = await call([MEMBER], t);
    expect(r.status).toBe("updated");
    if (r.status === "updated") {
      expect(r.project.assigneeUids).toEqual([MEMBER]);
      expect(r.documentUpdateTime).not.toEqual(t);
    }
  });
});
