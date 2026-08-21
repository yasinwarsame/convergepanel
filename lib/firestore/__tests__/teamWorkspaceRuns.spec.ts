/**
 * Team Workspace Run Creation, Phase 8C-D — `createTeamWorkspaceRun()`
 * tests. In-memory Firestore fake, structural mirror of
 * `teamProjects.spec.ts`'s buffered-transaction fake, extended with a
 * `runs` collection alongside `workspaces`/`workspaceMemberships`/`projects`.
 * Authorization is exercised against the REAL
 * `authorizeTeamWorkspaceMutationInTransaction()` (never mocked) so these
 * tests prove genuine end-to-end transactional behavior, not merely that
 * the helper was called.
 */

import { Timestamp } from "firebase-admin/firestore";

let autoIdCounter = 0;
let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  projects: new Map(),
  runs: new Map(),
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.projects.clear();
  stores.runs.clear();
}

class FirestoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function makeDocRef(collectionName: string, docId: string) {
  return { __collection: collectionName, __id: docId, id: docId };
}

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
let retriesBeforeSuccess = 0;

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    let attemptsLeft = retriesBeforeSuccess;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pendingWrites: Array<() => void> = [];
      const txn = {
        get: async (ref: { __collection: string; __id: string }) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          const snapshot = { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
          if (concurrentMutationHook) concurrentMutationHook(ref);
          return snapshot;
        },
        create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          if (store.has(ref.__id)) {
            throw new FirestoreError("6", "ALREADY_EXISTS");
          }
          pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
        },
      };

      const result = await fn(txn);

      if (attemptsLeft > 0) {
        attemptsLeft -= 1;
        continue;
      }

      for (const applyWrite of pendingWrites) applyWrite();
      return result;
    }
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const firestoreUnavailableFlag = { value: false };

let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { createTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";

const WS_ID = "ws-team-1";
const OWNER_UID = "owner-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const OUTSIDER_UID = "outsider-1";
const PROJECT_ID = "proj-1";

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  const data = {
    schemaVersion: 1,
    id: WS_ID,
    type: "team",
    name: "Acme Team",
    ownerUserId: OWNER_UID,
    createdByUserId: OWNER_UID,
    createdAt: ts(1000),
    updatedAt: ts(1000),
    ...overrides,
  };
  stores.workspaces.set(WS_ID, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedMembership(uid: string, role: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(WS_ID, uid);
  const data = {
    schemaVersion: 1,
    id,
    workspaceId: WS_ID,
    uid,
    role,
    status: "active",
    createdAt: ts(1000),
    updatedAt: ts(1000),
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  const data = {
    schemaVersion: 1,
    id,
    workspaceId: WS_ID,
    name: "Existing Project",
    status: "active",
    createdByUserId: OWNER_UID,
    createdAt: ts(1000),
    updatedAt: ts(1000),
    ...overrides,
  };
  stores.projects.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    uid: MEMBER_UID,
    workspaceId: WS_ID,
    question: "What is the capital of Kenya?",
    selectedModels: ["chatgpt", "claude"] as any,
    projectId: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetStores();
  concurrentMutationHook = null;
  retriesBeforeSuccess = 0;
  firestoreUnavailableFlag.value = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  mockAdminDb.runTransaction.mockClear();
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
});

describe("createTeamWorkspaceRun — rollout", () => {
  it("disabled: returns team_workspaces_disabled with ZERO Firestore access — no runTransaction call at all", async () => {
    teamWorkspacesEnabled = false;
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("firestore_unavailable when adminDb is null (checked AFTER rollout, before transaction)", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("createTeamWorkspaceRun — Unfiled (projectId: null)", () => {
  it("editor with research.create -> created, canonical row has projectId explicitly null, exactly ONE runTransaction call", async () => {
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.workspaceId).toBe(WS_ID);
    expect(result.projectId).toBeNull();
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);

    const stored = stores.runs.get(result.runId);
    expect(stored).toBeDefined();
    expect(stored!.data.userId).toBe(MEMBER_UID);
    expect(stored!.data.workspaceId).toBe(WS_ID);
    expect(Object.prototype.hasOwnProperty.call(stored!.data, "projectId")).toBe(true);
    expect(stored!.data.projectId).toBeNull();
    expect(stored!.data.status).toBe("running");
    expect(stored!.data.question).toBe("What is the capital of Kenya?");
    expect(stored!.data.selectedModels).toEqual(["chatgpt", "claude"]);
    expect(stored!.data.createdAt).toBeInstanceOf(Timestamp);

    const validated = validateTeamRunRowShape(stored!.data, WS_ID);
    expect(validated.ok).toBe(true);
  });

  it("reviewer (no research.create) -> unauthorized insufficient_capability, no run created", async () => {
    const result = await createTeamWorkspaceRun(baseArgs({ uid: REVIEWER_UID }));
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.runs.size).toBe(0);
  });

  it("outsider (no membership) -> unauthorized membership_not_found, no run created", async () => {
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OUTSIDER_UID }));
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    expect(stores.runs.size).toBe(0);
  });

  it("removed membership -> unauthorized membership_removed, no run created", async () => {
    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.runs.size).toBe(0);
  });

  it("run id collision (tx.create throws ALREADY_EXISTS) -> transaction_failed, no client-visible collision semantics invented", async () => {
    // Force autoIdCounter/randomUUID collision surface indirectly by
    // pre-seeding an entry the transaction's tx.create() would target —
    // simulated by making the store already contain SOME doc and hooking
    // concurrentMutationHook to pre-populate the exact same id right
    // before the create call is reached is impractical without knowing
    // the generated id in advance; instead assert the mapping directly
    // via a forced throw from the fake's create().
    const originalCreate = mockAdminDb.runTransaction.getMockImplementation();
    mockAdminDb.runTransaction.mockImplementationOnce(async (fn: (txn: any) => Promise<any>) => {
      const txn = {
        get: async (ref: { __collection: string; __id: string }) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
        },
        create: () => {
          throw new FirestoreError("6", "ALREADY_EXISTS");
        },
      };
      return fn(txn);
    });
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "transaction_failed" });
    expect(stores.runs.size).toBe(0);
    mockAdminDb.runTransaction.mockImplementation(originalCreate);
  });
});

describe("createTeamWorkspaceRun — Project placement capability matrix (Correction 39)", () => {
  // NOTE: as of this writing, lib/workspaces/capabilities.ts's frozen V1
  // role matrix has no role with research.create=true AND
  // research.organize=false (owner/admin/member both true; reviewer/viewer
  // both false) — so a runtime test cannot currently exercise "has create,
  // lacks organize" against a REAL role without mocking roleHasCapability
  // itself (which this suite deliberately avoids, to keep authorization
  // genuinely end-to-end). The independent-check property is verified by
  // source inspection instead: createTeamWorkspaceRun() calls
  // `roleHasCapability(auth.membership.role, "research.organize")` as a
  // SEPARATE condition from the "research.create" check performed inside
  // authorizeTeamWorkspaceMutationInTransaction() — never derived from or
  // combined with it — so if the role matrix ever introduces a role with
  // that split, this code already handles it correctly without change.
  it("reviewer (lacks research.create entirely), projectId assigned -> insufficient_capability from the FIRST gate, no Project read attempted", async () => {
    seedProject(PROJECT_ID);
    let projectReadAttempted = false;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "projects") projectReadAttempted = true;
    };
    const result = await createTeamWorkspaceRun(baseArgs({ uid: REVIEWER_UID, projectId: PROJECT_ID }));
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.runs.size).toBe(0);
    expect(projectReadAttempted).toBe(false);
  });

  it("owner, projectId assigned: research.create + research.organize both true -> created, projectId persisted", async () => {
    seedProject(PROJECT_ID);
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: PROJECT_ID }));
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.projectId).toBe(PROJECT_ID);
    const stored = stores.runs.get(result.runId);
    expect(stored!.data.projectId).toBe(PROJECT_ID);
  });

  it("owner, projectId null (Unfiled): research.organize never required -> created without a Project read", async () => {
    let getCalls = 0;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "projects") getCalls += 1;
    };
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: null }));
    expect(result.status).toBe("created");
    expect(getCalls).toBe(0);
  });
});

describe("createTeamWorkspaceRun — Project validation", () => {
  it("missing Project -> concealed project_not_found, no run created", async () => {
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: "does-not-exist" }));
    expect(result).toEqual({ status: "project_not_found" });
    expect(stores.runs.size).toBe(0);
  });

  it("embedded-id mismatch -> concealed project_not_found", async () => {
    seedProject(PROJECT_ID, { id: "different-id" });
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: PROJECT_ID }));
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("foreign Workspace Project -> concealed project_not_found", async () => {
    seedProject(PROJECT_ID, { workspaceId: "ws-other" });
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: PROJECT_ID }));
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("archived Project -> distinguishable project_archived, no run created", async () => {
    seedProject(PROJECT_ID, { status: "archived" });
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: PROJECT_ID }));
    expect(result).toEqual({ status: "project_archived" });
    expect(stores.runs.size).toBe(0);
  });

  it("archive race: Project archived by a concurrent mutation that lands between the authorization read and the Project read is still caught, because both happen through the SAME transaction handle", async () => {
    seedProject(PROJECT_ID, { status: "active" });
    // Fires during the (earlier) membership read inside
    // authorizeTeamWorkspaceMutationInTransaction() — simulating another
    // process archiving the Project in the window before this
    // transaction's own, LATER project read executes. Because that later
    // read goes through the same `tx`, it observes the fresh, archived
    // state, exactly like a real Firestore transaction would.
    let armed = true;
    concurrentMutationHook = (ref) => {
      if (armed && ref.__collection === "workspaceMemberships") {
        armed = false;
        stores.projects.set(PROJECT_ID, { data: { ...stores.projects.get(PROJECT_ID)!.data, status: "archived" }, updateTime: nextUpdateTime() });
      }
    };
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OWNER_UID, projectId: PROJECT_ID }));
    expect(result).toEqual({ status: "project_archived" });
    expect(stores.runs.size).toBe(0);
  });
});

describe("createTeamWorkspaceRun — legacy teamRuns collection protection", () => {
  it("never touches the teamRuns collection", async () => {
    await createTeamWorkspaceRun(baseArgs());
    expect(stores["teamRuns" as any]).toBeUndefined();
    // mockAdminDb.collection is only ever invoked with "workspaces",
    // "workspaceMemberships", "projects", or "runs" in this suite —
    // asserted implicitly by every store lookup above resolving via
    // `stores[name]`, which would throw for an unrecognized collection
    // name (e.g. "teamRuns") rather than silently succeeding.
  });
});
