/**
 * Run/Project Association, Phase 6D.4A — `associateRunWithProject()` tests.
 * Generic collection/doc-keyed in-memory Firestore fake (not path-tagged
 * refs) since this function touches three distinct collections
 * (`runs`, `workspaces`, `projects`) inside one transaction.
 */

const stores: Record<string, Map<string, Record<string, unknown>>> = {
  runs: new Map(),
  workspaces: new Map(),
  projects: new Map(),
};

const firestoreUnavailableFlag = { value: false };
const transactionShouldThrow = { value: false };

function makeDocRef(collectionName: string, docId: string) {
  return { __collection: collectionName, __id: docId };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    if (transactionShouldThrow.value) {
      throw new Error("simulated transaction failure");
    }
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        const store = stores[ref.__collection];
        const data = store.get(ref.__id);
        return { exists: data !== undefined, data: () => data, id: ref.__id };
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        const existing = store.get(ref.__id) ?? {};
        store.set(ref.__id, { ...existing, ...data });
      },
    };
    return fn(txn);
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

let workspacesEnabled = true;
jest.mock("@/lib/env", () => ({
  get WORKSPACES_ENABLED() {
    return workspacesEnabled;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Timestamp } from "firebase-admin/firestore";
import { associateRunWithProject } from "@/lib/projects/associateRunWithProject";
import { logger } from "@/lib/logger";

const UID = "user-1";
const WS_ID = "personal-user-1";
const RUN_ID = "run-1";
const PROJECT_ID = "proj-1";
const PROJECT_ID_2 = "proj-2";
const NOW = Timestamp.now();

// Mirrors adminDb's real `ignoreUndefinedProperties: true` behavior — an
// override explicitly set to `undefined` must simulate a field that was
// never persisted at all (key genuinely absent), never a key present with
// an `undefined` value, which real Firestore data reads can never produce.
function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  stores.workspaces.set(
    WS_ID,
    asPersisted({
      schemaVersion: 1,
      id: WS_ID,
      type: "personal",
      name: "Personal",
      ownerUserId: UID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  );
}

function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(
    RUN_ID,
    asPersisted({
      userId: UID,
      workspaceId: WS_ID,
      question: "q",
      selectedModels: [],
      status: "complete",
      createdAt: NOW,
      ...overrides,
    })
  );
}

function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  stores.projects.set(
    id,
    asPersisted({
      schemaVersion: 1,
      id,
      workspaceId: WS_ID,
      name: "My Project",
      status: "active",
      createdByUserId: UID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  stores.runs.clear();
  stores.workspaces.clear();
  stores.projects.clear();
  workspacesEnabled = true;
  firestoreUnavailableFlag.value = false;
  transactionShouldThrow.value = false;
  seedWorkspace();
});

describe("infrastructure gates", () => {
  it("WORKSPACES_ENABLED off -> workspaces_disabled, no Firestore access", async () => {
    workspacesEnabled = false;
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("workspaces_disabled");
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("Firestore unavailable -> firestore_unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("firestore_unavailable");
  });

  it("transaction throws -> transaction_failed", async () => {
    seedRun({ projectId: null });
    transactionShouldThrow.value = true;
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("transaction_failed");
  });
});

describe("caller's own Workspace validity", () => {
  it("missing Workspace doc -> workspace_invalid", async () => {
    stores.workspaces.clear();
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("workspace_invalid");
  });

  it("malformed Workspace doc -> workspace_invalid", async () => {
    stores.workspaces.set(WS_ID, { id: WS_ID } as any);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("workspace_invalid");
  });

  it("wrong owner on own-Workspace doc -> workspace_invalid", async () => {
    seedWorkspace({ ownerUserId: "someone-else" });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("workspace_invalid");
  });

  it("wrong type on own-Workspace doc -> workspace_invalid", async () => {
    seedWorkspace({ type: "team" });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("workspace_invalid");
  });
});

describe("run existence/ownership/binding — concealed 404 for every variant", () => {
  it("run does not exist -> run_not_found", async () => {
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
  });

  it("run owned by a different uid -> run_not_found", async () => {
    seedRun({ userId: "someone-else", projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
  });

  it("legacy run — no workspaceId field -> run_not_found", async () => {
    seedRun({ workspaceId: undefined, projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
  });

  it("run workspaceId explicitly null -> run_not_found", async () => {
    seedRun({ workspaceId: null, projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
  });

  it("run bound to a foreign/team Workspace -> run_not_found", async () => {
    seedRun({ workspaceId: "personal-someone-else", projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
  });

  it("bound-invalid run (workspaceId string points nowhere real — same as foreign) -> run_not_found", async () => {
    seedRun({ workspaceId: "personal-nonexistent-user", projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
  });
});

describe("current projectId classification", () => {
  it("malformed current projectId (number) -> run_state_invalid, never mutated", async () => {
    seedRun({ projectId: 12345 });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_state_invalid");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(12345);
    expect(logger.error).toHaveBeenCalled();
  });

  it("absent projectId field treated as semantic null (assign succeeds with expectedProjectId: null)", async () => {
    seedRun({ projectId: undefined });
    seedProject(PROJECT_ID);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("associated");
    if (result.status === "associated") expect(result.fromProjectId).toBeNull();
  });
});

describe("expected-state contract", () => {
  it("current null + expected null + target P -> assign", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("associated");
    if (result.status === "associated") {
      expect(result.fromProjectId).toBeNull();
      expect(result.toProjectId).toBe(PROJECT_ID);
    }
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });

  it("current P1 + expected P1 + target P2 -> move", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID);
    seedProject(PROJECT_ID_2);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
    if (result.status === "associated") {
      expect(result.fromProjectId).toBe(PROJECT_ID);
      expect(result.toProjectId).toBe(PROJECT_ID_2);
    }
  });

  it("current P1 + expected P1 + target null -> unassign", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: null, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
    if (result.status === "associated") {
      expect(result.fromProjectId).toBe(PROJECT_ID);
      expect(result.toProjectId).toBeNull();
    }
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("current null + expected P1 -> 409 conflict, no write", async () => {
    seedRun({ projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("current P1 + expected null -> 409 conflict, no write", async () => {
    seedRun({ projectId: PROJECT_ID });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: null, expectedProjectId: null });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });

  it("current P1 + expected P2 -> 409 conflict, no write", async () => {
    seedRun({ projectId: PROJECT_ID });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID_2 });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });

  it("no stale conflict mutates the run", async () => {
    seedRun({ projectId: PROJECT_ID });
    await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID_2, expectedProjectId: "wrong-guess" });
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });
});

describe("no-op", () => {
  it("target === current (post expected-state check) -> unchanged, no write", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("unchanged");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });

  it("null -> null no-op -> unchanged", async () => {
    seedRun({ projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: null, expectedProjectId: null });
    expect(result.status).toBe("unchanged");
  });
});

describe("target Project validation", () => {
  it("target does not exist -> target_not_found, no write", async () => {
    seedRun({ projectId: null });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: "nonexistent", expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("target malformed -> target_not_found, concealed", async () => {
    seedRun({ projectId: null });
    stores.projects.set(PROJECT_ID, { id: PROJECT_ID } as any);
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
  });

  it("target embedded id mismatch -> target_not_found, concealed", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { id: "different-id" });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
  });

  it("target belongs to a foreign Workspace -> target_not_found, concealed as 'not found', never a distinguishable status", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { workspaceId: "personal-someone-else" });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
  });

  it("target archived -> target_archived, distinguishable, no write", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { status: "archived" });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_archived");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });
});

describe("archived-source semantics", () => {
  it("moving FROM a current Project that is (independently) archived, TO an active target, succeeds — current Project's own status is never read", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID, { status: "archived" }); // current project archived — never even looked up
    seedProject(PROJECT_ID_2, { status: "active" });
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("unassigning FROM an archived current Project succeeds — no read of the current Project is required", async () => {
    seedRun({ projectId: PROJECT_ID });
    // Deliberately do NOT seed PROJECT_ID at all — proves the current
    // Project is never read for an unassign, archived or otherwise.
    const result = await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: null, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });
});

describe("exact write surface", () => {
  it("touches only projectId — every other field on the run document is untouched", async () => {
    seedRun({ projectId: null, question: "original question", status: "complete", tokensByModel: { gpt4: 10 } });
    seedProject(PROJECT_ID);
    await associateRunWithProject({ uid: UID, runId: RUN_ID, targetProjectId: PROJECT_ID, expectedProjectId: null });
    const finalRun = stores.runs.get(RUN_ID);
    expect(finalRun?.projectId).toBe(PROJECT_ID);
    expect(finalRun?.question).toBe("original question");
    expect(finalRun?.status).toBe("complete");
    expect(finalRun?.tokensByModel).toEqual({ gpt4: 10 });
    expect(finalRun?.updatedAt).toBeUndefined();
  });
});
