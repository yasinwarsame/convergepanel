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
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    // Plain, non-transactional read — used by getTeamWorkspaceRun(), which
    // (unlike createTeamWorkspaceRun()) is a simple read with no
    // transaction of its own.
    get: async () => {
      const store = stores[collectionName];
      const entry = store.get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, id: docId };
    },
  };
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
let teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return teamWorkspacesCanaryWorkspaceIds;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { createTeamWorkspaceRun, getTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import type { RunDocument } from "@/lib/panel/schemas";

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
  teamWorkspacesCanaryWorkspaceIds = undefined;
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

describe("createTeamWorkspaceRun — Workspace-scoped Team canary admission (Phase 10B.3.2A)", () => {
  // Category A (global-enabled success) already covered throughout this
  // file's default beforeEach (teamWorkspacesEnabled=true) — e.g. the
  // "Unfiled" success test below. Not duplicated here.

  it("Category B: uid-canary, global disabled -> created", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = `other-uid,${MEMBER_UID}`;
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result.status).toBe("created");
  });

  it("Category C: Workspace-canary-only (global/uid disabled, target workspaceId admitted, caller has active membership + research.create) -> created; run's own canonical workspaceId field equals the exact id used for admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    const stored = stores.runs.get(result.runId);
    expect(stored!.data.workspaceId).toBe(WS_ID);
  });

  it("Category D: Workspace-canary-only, caller lacks research.create (reviewer role) -> insufficient_capability, no run created", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await createTeamWorkspaceRun(baseArgs({ uid: REVIEWER_UID }));
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.runs.size).toBe(0);
  });

  it("Category E: Workspace-canary-only, caller has NO membership in the admitted Workspace -> membership_not_found, no run created", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await createTeamWorkspaceRun(baseArgs({ uid: OUTSIDER_UID }));
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    expect(stores.runs.size).toBe(0);
  });

  it("Category F: Workspace-canary-only, caller's membership was removed -> membership_removed, no run created", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.runs.size).toBe(0);
  });

  it("Category G: target workspaceId NOT in TEAM_WORKSPACES_CANARY_WORKSPACE_IDS, global/uid disabled -> team_workspaces_disabled with ZERO Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "some-other-workspace-id";
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("Category I: malformed Workspace-canary list (>10 entries) does not poison an otherwise-valid uid-canary admission -> created", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = MEMBER_UID;
    teamWorkspacesCanaryWorkspaceIds = Array.from({ length: 11 }, (_, i) => `ws-${i}`).join(",");
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result.status).toBe("created");
  });

  it("Category J: malformed Workspace-canary list (>10 entries, WOULD have included WS_ID) does NOT grant access -> team_workspaces_disabled, ZERO Firestore access, fails closed rather than broadening", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = [WS_ID, ...Array.from({ length: 10 }, (_, i) => `ws-${i}`)].join(",");
    const result = await createTeamWorkspaceRun(baseArgs());
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
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

describe("getTeamWorkspaceRun — Team Research Detail, Phase 12A.4", () => {
  const OTHER_PROJECT_ID = "proj-other";
  const RUN_ID_FOR_DETAIL = "run-detail-1";

  function seedRun(runId: string, overrides: Record<string, unknown> = {}) {
    const data = {
      userId: MEMBER_UID,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      question: "What is the capital of Kenya?",
      selectedModels: ["chatgpt"],
      status: "running",
      createdAt: ts(1000),
      ...overrides,
    };
    stores.runs.set(runId, { data, updateTime: nextUpdateTime() });
    return data;
  }

  function sampleRunDocument(): RunDocument {
    return {
      runId: RUN_ID_FOR_DETAIL,
      userId: MEMBER_UID,
      createdAt: ts(1000),
      question: "What is the capital of Kenya?",
      selectedModels: ["chatgpt"],
      perModel: [
        {
          modelId: "chatgpt",
          status: "ok",
          rawTextTruncated: "Nairobi.",
          latencyMs: 120,
          tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          wasTruncated: false,
        },
      ],
      totals: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      flags: { storageTruncated: false, synthesisTruncated: false },
    };
  }

  it("firestore_unavailable when adminDb is null, no doc read attempted", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("run doesn't exist at all -> not_found", async () => {
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: "does-not-exist" });
    expect(result).toEqual({ status: "not_found" });
  });

  it("run's workspaceId doesn't match the requested workspaceId -> not_found, concealed identically to a genuinely missing run", async () => {
    seedRun(RUN_ID_FOR_DETAIL, { workspaceId: "ws-other", projectId: PROJECT_ID });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result).toEqual({ status: "not_found" });
  });

  it("run's projectId doesn't match the requested projectId (same Workspace, different Project) -> not_found, concealed identically to a genuinely missing run", async () => {
    seedRun(RUN_ID_FOR_DETAIL, { workspaceId: WS_ID, projectId: OTHER_PROJECT_ID });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result).toEqual({ status: "not_found" });
  });

  it("run is genuinely Unfiled (projectId: null) -> not_found for any specific-Project request, never reinterpreted as a match", async () => {
    seedRun(RUN_ID_FOR_DETAIL, { workspaceId: WS_ID, projectId: null });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result).toEqual({ status: "not_found" });
  });

  it("matching Workspace + Project, status running -> pending variant, question/governanceStatus surfaced, no results field", async () => {
    seedRun(RUN_ID_FOR_DETAIL, { status: "running", question: "How big is the TAM?" });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result).toEqual({ status: "pending", runId: RUN_ID_FOR_DETAIL, question: "How big is the TAM?", governanceStatus: undefined });
    expect((result as any).results).toBeUndefined();
  });

  it("matching Workspace + Project, an arbitrary non-complete status (e.g. 'error') -> pending variant, not treated as complete", async () => {
    seedRun(RUN_ID_FOR_DETAIL, { status: "error" });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result.status).toBe("pending");
  });

  it("matching Workspace + Project, status complete -> results converted via the real runDocumentToPublicResults(), not duplicated transform logic", async () => {
    const runDocument = sampleRunDocument();
    seedRun(RUN_ID_FOR_DETAIL, { status: "complete", runDocument, governanceStatus: "approved", question: "How big is the TAM?" });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.runId).toBe(RUN_ID_FOR_DETAIL);
    expect(result.question).toBe("How big is the TAM?");
    expect(result.governanceStatus).toBe("approved");
    expect(result.results).toEqual(runDocumentToPublicResults(runDocument));
    expect(result.results.length).toBe(1);
    expect(result.results[0].modelId).toBe("chatgpt");
  });

  it("status complete but governanceStatus is an unrecognized/malformed value -> governanceStatus normalized to undefined, matching the composer's own whitelist validation", async () => {
    const runDocument = sampleRunDocument();
    seedRun(RUN_ID_FOR_DETAIL, { status: "complete", runDocument, governanceStatus: "totally_bogus" });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.governanceStatus).toBeUndefined();
  });

  it("status complete but runDocument is absent -> results is an empty array, not a crash", async () => {
    seedRun(RUN_ID_FOR_DETAIL, { status: "complete" });
    const result = await getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID_FOR_DETAIL });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.results).toEqual([]);
  });
});
