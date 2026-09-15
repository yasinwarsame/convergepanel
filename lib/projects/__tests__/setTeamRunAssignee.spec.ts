/**
 * Project/Research Assignment — `setTeamRunAssignee()` against an in-memory
 * buffered-transaction Firestore fake (reads-before-writes guard, `txSetLog`
 * / `txUpdateLog` for post-commit-vs-in-transaction proofs, a
 * `forceSetFailureForCollection` knob for atomicity). Every "never"
 * assertion sits beside the positive control on the same fixture. The fake
 * registers NO seat / quota collection: any reference would throw
 * (structural tripwire).
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  runs: new Map(),
  projects: new Map(),
  workspaceMembershipEvents: new Map(),
};
function resetStores() {
  for (const s of Object.values(stores)) s.clear();
}
function asPersisted(data: StoredDoc): StoredDoc {
  const r: StoredDoc = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
  return r;
}

let autoId = 0;
let forceSetFailureForCollection: string | null = null;
let txGetLog: { collection: string; id: string }[] = [];
let txSetLog: { collection: string; id: string; data: StoredDoc }[] = [];
let txUpdateLog: { collection: string; id: string; data: StoredDoc }[] = [];
let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;

function makeDocRef(collectionName: string, docId: string) {
  return { __collection: collectionName, __id: docId, id: docId };
}
const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoId}`) }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const pendingWrites: Array<() => void> = [];
    let hasWritten = false;
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (hasWritten) throw new Error("Firestore transactions require all reads to be executed before all writes.");
        if (concurrentMutationHook) concurrentMutationHook(ref);
        const store = stores[ref.__collection];
        if (!store) throw new Error(`unregistered collection ${ref.__collection}`);
        txGetLog.push({ collection: ref.__collection, id: ref.__id });
        const data = store.get(ref.__id);
        return { exists: data !== undefined, data: () => data, id: ref.__id };
      },
      update: (ref: { __collection: string; __id: string }, data: StoredDoc) => {
        hasWritten = true;
        txUpdateLog.push({ collection: ref.__collection, id: ref.__id, data });
        pendingWrites.push(() => {
          const store = stores[ref.__collection];
          const existing = store.get(ref.__id) ?? {};
          store.set(ref.__id, { ...existing, ...data });
        });
      },
      set: (ref: { __collection: string; __id: string }, data: StoredDoc) => {
        hasWritten = true;
        if (forceSetFailureForCollection === ref.__collection) throw new Error("UNAVAILABLE: simulated transient failure");
        txSetLog.push({ collection: ref.__collection, id: ref.__id, data });
        pendingWrites.push(() => stores[ref.__collection].set(ref.__id, data));
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
let assignmentCanary: string | undefined = undefined;
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
    return assignmentCanary;
  },
}));
const mockedLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { setTeamRunAssignee } from "@/lib/projects/setTeamRunAssignee";

const WS_ID = "ws-team-1";
const OTHER_WS = "ws-team-2";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";
const MEMBER2 = "member-2";
const REVIEWER = "reviewer-1";
const VIEWER = "viewer-1";
const OUTSIDER = "outsider-1";
const RUN_ID = "run-1";
const PROJECT_ID = "proj-1";
const NOW = Timestamp.now();

function seedWorkspace(id = WS_ID) {
  stores.workspaces.set(id, asPersisted({ schemaVersion: 1, id, type: "team", name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW }));
}
function seedMembership(uid: string, role: string, workspaceId = WS_ID, overrides: StoredDoc = {}) {
  const id = computeMembershipId(workspaceId, uid);
  stores.workspaceMemberships.set(id, asPersisted({ schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides }));
}
function seedProject(id = PROJECT_ID, overrides: StoredDoc = {}) {
  stores.projects.set(id, asPersisted({ schemaVersion: 1, id, workspaceId: WS_ID, name: "Due Diligence", status: "active", createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW, ...overrides }));
}
function seedRun(overrides: StoredDoc = {}, id = RUN_ID) {
  stores.runs.set(id, asPersisted({ userId: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, question: "What is the TAM?", status: "complete", createdAt: NOW, ...overrides }));
}
function fullTeam() {
  seedWorkspace();
  seedMembership(OWNER, "owner");
  seedMembership(ADMIN, "admin");
  seedMembership(MEMBER, "member");
  seedMembership(MEMBER2, "member");
  seedMembership(REVIEWER, "reviewer");
  seedMembership(VIEWER, "viewer");
  seedProject();
}
const call = (args: Partial<Parameters<typeof setTeamRunAssignee>[0]> = {}) => setTeamRunAssignee({ uid: OWNER, workspaceId: WS_ID, runId: RUN_ID, assigneeUid: MEMBER, expectedAssigneeUid: null, ...args });
const membershipReads = () => txGetLog.filter((g) => g.collection === "workspaceMemberships");
const targetReads = (uid: string) => membershipReads().filter((g) => g.id === computeMembershipId(WS_ID, uid));
const events = () => Array.from(stores.workspaceMembershipEvents.values());

beforeEach(() => {
  resetStores();
  autoId = 0;
  txGetLog = [];
  txSetLog = [];
  txUpdateLog = [];
  forceSetFailureForCollection = null;
  concurrentMutationHook = null;
  firestoreUnavailable.value = false;
  teamEnabled = true;
  assignmentEnabled = true;
  assignmentCanary = undefined;
  mockedLogger.warn.mockClear();
  mockAdminDb.runTransaction.mockClear();
});

describe("admission (D10) — before any Firestore access", () => {
  it("Team disabled ⇒ team_workspaces_disabled, no transaction", async () => {
    teamEnabled = false;
    fullTeam();
    seedRun();
    expect(await call()).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });
  it("Assignment disabled (Team enabled) ⇒ project_assignment_disabled, no transaction; canary uid admits", async () => {
    assignmentEnabled = false;
    fullTeam();
    seedRun();
    expect(await call()).toEqual({ status: "project_assignment_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    assignmentCanary = OWNER;
    expect((await call()).status).toBe("assigned");
  });
  it("Firestore unavailable ⇒ firestore_unavailable", async () => {
    firestoreUnavailable.value = true;
    expect(await call()).toEqual({ status: "firestore_unavailable" });
  });
});

describe("authorization — research.organize inside the transaction, never assignment/creator", () => {
  it.each([
    ["owner", OWNER],
    ["admin", ADMIN],
    ["member", MEMBER2],
  ])("%s may assign", async (_r, uid) => {
    fullTeam();
    seedRun();
    expect((await call({ uid })).status).toBe("assigned");
  });
  it.each([
    ["reviewer", REVIEWER],
    ["viewer", VIEWER],
  ])("%s is denied insufficient_capability and nothing is written", async (_r, uid) => {
    fullTeam();
    seedRun();
    expect(await call({ uid })).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(txUpdateLog).toHaveLength(0);
    expect(txSetLog).toHaveLength(0);
  });
  it("an outsider and a removed member are denied; the run's OWN assignee (a Viewer) gains nothing from being assigned", async () => {
    fullTeam();
    seedRun({ assigneeUid: VIEWER });
    expect((await call({ uid: OUTSIDER })).status).toBe("unauthorized");
    seedMembership(MEMBER2, "member", WS_ID, { status: "removed" });
    expect((await call({ uid: MEMBER2 })).status).toBe("unauthorized");
    expect((await call({ uid: VIEWER, expectedAssigneeUid: VIEWER, assigneeUid: null })).status).toBe("unauthorized");
    expect(txUpdateLog).toHaveLength(0);
  });
  it("the run creator (userId) is NOT consulted: a creator who is only a Viewer is denied; a non-creator Member succeeds", async () => {
    fullTeam();
    seedRun({ userId: VIEWER });
    expect((await call({ uid: VIEWER })).status).toBe("unauthorized");
    expect((await call({ uid: MEMBER2 })).status).toBe("assigned");
  });
});

describe("run binding — concealed run_not_found", () => {
  it.each([
    ["missing run", () => {}],
    ["foreign Workspace run", () => seedRun({ workspaceId: OTHER_WS })],
    ["legacy run (no workspaceId)", () => seedRun({ workspaceId: undefined, projectId: undefined })],
    ["Personal-bound run", () => seedRun({ workspaceId: "personal_owner-1", projectId: undefined })],
  ])("%s ⇒ run_not_found, no writes", async (_l, seed) => {
    fullTeam();
    seed();
    expect(await call()).toEqual({ status: "run_not_found" });
    expect(txUpdateLog).toHaveLength(0);
  });
});

describe("OCC — expected-state against the NORMALIZED current value (§6.4 order: OCC before target validation and before no-op)", () => {
  it("stale expected value ⇒ conflict, with NO target membership read and no write", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER2 });
    expect(await call({ expectedAssigneeUid: null, assigneeUid: MEMBER })).toEqual({ status: "conflict" });
    expect(targetReads(MEMBER)).toHaveLength(0);
    expect(txUpdateLog).toHaveLength(0);
  });
  it("STALE EXPECTED NEVER NO-OPS: a stale expected value with an ALREADY-CURRENT requested value ⇒ conflict, never unchanged", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER });
    expect(await call({ expectedAssigneeUid: MEMBER2, assigneeUid: MEMBER })).toEqual({ status: "conflict" });
    expect(await call({ expectedAssigneeUid: null, assigneeUid: MEMBER })).toEqual({ status: "conflict" });
    expect(txUpdateLog).toHaveLength(0);
  });
  it("positive control — matching expected value proceeds", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER2 });
    expect((await call({ expectedAssigneeUid: MEMBER2, assigneeUid: MEMBER })).status).toBe("assigned");
  });
  it("MALFORMED stored assigneeUid (42) reads as null: expectedAssigneeUid null is accepted, a real write REPAIRS it, and a warning is logged without the raw value", async () => {
    fullTeam();
    seedRun({ assigneeUid: 42 });
    const r = await call({ expectedAssigneeUid: null, assigneeUid: MEMBER });
    expect(r).toEqual({ status: "assigned", runId: RUN_ID, workspaceId: WS_ID, previousAssigneeUid: null, assigneeUid: MEMBER });
    expect(stores.runs.get(RUN_ID)!.assigneeUid).toBe(MEMBER);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Malformed stored assigneeUid"), expect.not.objectContaining({ raw: expect.anything() }));
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain("42");
  });
  it("a malformed stored value with expectedAssigneeUid = '42' (the raw value) is a conflict — the raw value is never the comparison basis", async () => {
    fullTeam();
    seedRun({ assigneeUid: 42 });
    expect(await call({ expectedAssigneeUid: "42", assigneeUid: MEMBER })).toEqual({ status: "conflict" });
  });
});

describe("target validation (D2/D4) — ALWAYS, including same-value repeats", () => {
  it("D2 SAME FIXTURE: a Viewer cannot be a run assignee (assignee_not_eligible); a Member can", async () => {
    fullTeam();
    seedRun();
    expect(await call({ assigneeUid: VIEWER })).toEqual({ status: "assignee_not_eligible" });
    expect(await call({ assigneeUid: REVIEWER })).toEqual({ status: "assignee_not_eligible" });
    expect((await call({ assigneeUid: MEMBER })).status).toBe("assigned");
  });
  it("a removed member, an outsider, a foreign-Workspace member, and a non-uid-shaped value are all ineligible", async () => {
    fullTeam();
    seedRun();
    seedMembership(MEMBER2, "member", WS_ID, { status: "removed" });
    seedWorkspace(OTHER_WS);
    seedMembership("foreign-1", "member", OTHER_WS);
    expect((await call({ assigneeUid: MEMBER2 })).status).toBe("assignee_not_eligible");
    expect((await call({ assigneeUid: OUTSIDER })).status).toBe("assignee_not_eligible");
    expect((await call({ assigneeUid: "foreign-1" })).status).toBe("assignee_not_eligible");
    expect((await call({ assigneeUid: " bad" })).status).toBe("assignee_not_eligible");
    expect(txUpdateLog).toHaveLength(0);
  });
  it("SAME-ASSIGNEE REPEAT STILL VALIDATES (the reviewer defect class): repeating the current assignee whose membership was removed ⇒ assignee_not_eligible, not unchanged", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER });
    seedMembership(MEMBER, "member", WS_ID, { status: "removed" });
    expect(await call({ expectedAssigneeUid: MEMBER, assigneeUid: MEMBER })).toEqual({ status: "assignee_not_eligible" });
    expect(targetReads(MEMBER)).toHaveLength(1);
  });
  it("positive control — repeating a still-eligible current assignee is `unchanged` AFTER exactly one target read", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER });
    expect(await call({ expectedAssigneeUid: MEMBER, assigneeUid: MEMBER })).toEqual({ status: "unchanged", runId: RUN_ID, workspaceId: WS_ID, assigneeUid: MEMBER });
    expect(targetReads(MEMBER)).toHaveLength(1);
  });
  it("target eligibility is re-read INSIDE the transaction (a concurrent removal between reads is honored)", async () => {
    fullTeam();
    seedRun();
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (!fired && ref.__collection === "runs") {
        fired = true;
        seedMembership(MEMBER, "member", WS_ID, { status: "removed" });
      }
    };
    expect(await call({ assigneeUid: MEMBER })).toEqual({ status: "assignee_not_eligible" });
  });
});

describe("no-op (D6) and the real write", () => {
  it("D6 — unchanged: zero updates, zero events, no run field touched (positive control below writes both)", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER });
    const before = { ...stores.runs.get(RUN_ID)! };
    await call({ expectedAssigneeUid: MEMBER, assigneeUid: MEMBER });
    expect(txUpdateLog).toHaveLength(0);
    expect(txSetLog).toHaveLength(0);
    expect(events()).toHaveLength(0);
    expect(stores.runs.get(RUN_ID)).toEqual(before);
    // clear→clear is also a no-op
    seedRun();
    await call({ expectedAssigneeUid: null, assigneeUid: null });
    expect(txUpdateLog).toHaveLength(0);
  });
  it("real change writes EXACTLY {assigneeUid} on the run (no updatedAt, no mirrors) and the event in the SAME transaction", async () => {
    fullTeam();
    seedRun();
    const r = await call({ assigneeUid: MEMBER });
    expect(r).toEqual({ status: "assigned", runId: RUN_ID, workspaceId: WS_ID, previousAssigneeUid: null, assigneeUid: MEMBER });
    expect(txUpdateLog).toEqual([{ collection: "runs", id: RUN_ID, data: { assigneeUid: MEMBER } }]);
    expect(txSetLog).toHaveLength(1);
    expect(txSetLog[0].collection).toBe("workspaceMembershipEvents");
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
    expect(stores.runs.get(RUN_ID)!.userId).toBe(OWNER);
  });
  it("clearing writes assigneeUid: null and records previousAssigneeUid", async () => {
    fullTeam();
    seedRun({ assigneeUid: MEMBER });
    const r = await call({ expectedAssigneeUid: MEMBER, assigneeUid: null });
    expect(r).toEqual({ status: "assigned", runId: RUN_ID, workspaceId: WS_ID, previousAssigneeUid: MEMBER, assigneeUid: null });
    expect(stores.runs.get(RUN_ID)!.assigneeUid).toBeNull();
    expect(events()[0]).toMatchObject({ previousAssigneeUid: MEMBER, assigneeUid: null });
  });
});

describe("audit event (D5) — schema, nullability, Project snapshot, atomicity", () => {
  it("filed run: event carries the TRANSACTION-READ Project name and the run question, uids only, no display names", async () => {
    fullTeam();
    seedRun();
    await call({ assigneeUid: MEMBER });
    const ev = events()[0];
    expect(ev).toEqual({
      eventType: "workspace_research_assignee_changed",
      actorUid: OWNER,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      projectName: "Due Diligence",
      runId: RUN_ID,
      runQuestion: "What is the TAM?",
      previousAssigneeUid: null,
      assigneeUid: MEMBER,
      at: expect.anything(),
    });
    // The Project read happened INSIDE the transaction (before the write), never post-commit.
    expect(txGetLog.some((g) => g.collection === "projects" && g.id === PROJECT_ID)).toBe(true);
  });
  it("Unfiled run: projectId/projectName are null/null — same success response", async () => {
    fullTeam();
    seedRun({ projectId: null });
    const r = await call({ assigneeUid: MEMBER });
    expect(r.status).toBe("assigned");
    expect(events()[0]).toMatchObject({ projectId: null, projectName: null });
    expect(txGetLog.some((g) => g.collection === "projects")).toBe(false);
  });
  it.each([
    ["missing", () => stores.projects.delete(PROJECT_ID)],
    ["malformed", () => stores.projects.set(PROJECT_ID, { id: PROJECT_ID })],
    ["foreign", () => seedProject(PROJECT_ID, { workspaceId: OTHER_WS })],
  ])("filed run whose Project is %s: projectName null (projectId kept), the SAME success response, and a logged warning — never an existence oracle", async (_l, mutate) => {
    fullTeam();
    seedRun();
    mutate();
    const r = await call({ assigneeUid: MEMBER });
    expect(r).toEqual({ status: "assigned", runId: RUN_ID, workspaceId: WS_ID, previousAssigneeUid: null, assigneeUid: MEMBER });
    expect(events()[0]).toMatchObject({ projectId: PROJECT_ID, projectName: null });
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("missing, malformed, or foreign"), expect.anything());
  });
  it("a blank / non-string question falls back to the fixed label, never a request value", async () => {
    fullTeam();
    seedRun({ question: "   " });
    await call({ assigneeUid: MEMBER });
    expect(events()[0]).toMatchObject({ runQuestion: "Untitled research" });
  });
  it("ATOMICITY — if the event write fails, the run field is NOT updated (transaction_failed)", async () => {
    fullTeam();
    seedRun();
    forceSetFailureForCollection = "workspaceMembershipEvents";
    expect(await call({ assigneeUid: MEMBER })).toEqual({ status: "transaction_failed" });
    expect(stores.runs.get(RUN_ID)!.assigneeUid).toBeUndefined();
    expect(events()).toHaveLength(0);
  });
});
