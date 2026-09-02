/**
 * PHASE 12A.2-I1 — explicit tested invariant: the permanent collaborator-
 * seat limit (Phase 12A.1S.1, `teamWorkspaceSeatAdmission.ts`) and Team
 * Projects (Phase 12A.2) are completely orthogonal entitlements. A
 * Workspace at 5/5 collaborator seats must not block Project creation, and
 * Project creation must never read or write the collaborator-seat
 * admission cache — Projects organize a Workspace's work, they do not
 * consume or affect who may belong to it.
 *
 * The fake Firestore below deliberately does NOT register a
 * `teamWorkspaceSeatAdmission` store. If `createTeamProject()` ever grew a
 * reference to that collection (accidentally or otherwise), any
 * `tx.get()`/`tx.create()`/`tx.update()` against it would throw
 * (`stores[undefined-collection]` has no `.get`/`.set`) — this is a
 * structural tripwire, not merely an assertion after the fact.
 */

import { Timestamp } from "firebase-admin/firestore";

let autoIdCounter = 0;
let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}
function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
// Deliberately NO `teamWorkspaceSeatAdmission` entry here — see module doc comment.
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  projects: new Map(),
};

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
    get: async () => {
      const store = stores[collectionName]; // undefined for any unregistered collection — throws below if ever touched
      const entry = store.get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
    },
  };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const pendingWrites: Array<() => void> = [];
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
      },
      create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        if (store.has(ref.__id)) throw new FirestoreError("6", "ALREADY_EXISTS");
        pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        if (!entry) throw new FirestoreError("5", "NOT_FOUND");
        pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
      },
    };
    const result = await fn(txn);
    for (const applyWrite of pendingWrites) applyWrite();
    return result;
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/env", () => ({
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { createTeamProject } from "@/lib/firestore/teamProjects";

const WS_ID = "ws-orthogonality-1";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";

function seedWorkspace() {
  stores.workspaces.set(WS_ID, {
    data: { schemaVersion: 1, id: WS_ID, type: "team", name: "Orthogonality Test Workspace", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000) },
    updateTime: nextUpdateTime(),
  });
}
function seedMembership(uid: string, role: string) {
  const id = computeMembershipId(WS_ID, uid);
  stores.workspaceMemberships.set(id, {
    data: { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null },
    updateTime: nextUpdateTime(),
  });
}
/** Fills the Workspace to exactly 5 non-owner collaborator seats (the permanent limit), mirroring a real fully-occupied Team Workspace. */
function fillToCollaboratorSeatLimit() {
  seedMembership(ADMIN_UID, "admin");
  for (let i = 0; i < 4; i++) seedMembership(`collaborator-${i}`, "member");
}

beforeEach(() => {
  for (const store of Object.values(stores)) store.clear();
  autoIdCounter = 0;
  updateTimeCounter = 0;
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
});

describe("PHASE 12A.2-I1 — Project creation is independent of collaborator-seat capacity", () => {
  it("Workspace at exactly 5/5 collaborator seats -> Project creation still succeeds (seat limit governs people, not Projects)", async () => {
    fillToCollaboratorSeatLimit(); // owner + admin + 4 collaborators = 5 non-owner seats, at the permanent limit
    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "New Project" });
    expect(result.status).toBe("created");
  });

  it("Workspace over the collaborator-seat limit (legacy 7 non-owner members) -> Project creation still succeeds — the seat limit never blocks Project work, even for an already-over-limit Workspace", async () => {
    for (let i = 0; i < 7; i++) seedMembership(`legacy-collaborator-${i}`, "member");
    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "Another Project" });
    expect(result.status).toBe("created");
  });

  it("creating several Projects never touches the collaborator-seat admission cache (structural tripwire: the fake has no `teamWorkspaceSeatAdmission` store — any access to it would throw)", async () => {
    fillToCollaboratorSeatLimit();
    const first = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "Project One" });
    const second = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "Project Two" });
    const third = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "Project Three" });
    expect([first.status, second.status, third.status]).toEqual(["created", "created", "created"]);
    // If this test file's fake ever needed to register a teamWorkspaceSeatAdmission
    // store to stop throwing, that alone would be evidence of an unwanted coupling.
  });

  it("MUTATION-TARGET DOCUMENTATION: this file's fake Firestore deliberately omits `teamWorkspaceSeatAdmission` from its known collections — an accidental `tx.get()`/`tx.create()` against it inside createTeamProject() would throw \"Cannot read properties of undefined\", failing every test above", () => {
    expect(Object.keys(stores)).not.toContain("teamWorkspaceSeatAdmission");
  });
});

describe("PHASE 12A.2-I1 — source-level structural independence (permanent regression guard)", () => {
  function readSource(relativePath: string): string {
    return require("fs").readFileSync(require("path").join(__dirname, "..", "..", relativePath), "utf8");
  }

  it("teamWorkspaceSeatAdmission.ts never references Projects", () => {
    const source = readSource("workspaces/teamWorkspaceSeatAdmission.ts");
    expect(source).not.toMatch(/project/i);
  });

  it("teamWorkspaceSeatLimit.ts never references Projects", () => {
    const source = readSource("workspaces/teamWorkspaceSeatLimit.ts");
    expect(source).not.toMatch(/project/i);
  });

  it("lib/firestore/teamProjects.ts (createTeamProject) never imports the seat-admission module", () => {
    const source = readSource("firestore/teamProjects.ts");
    expect(source).not.toMatch(/teamWorkspaceSeatAdmission|teamWorkspaceSeatLimit/);
  });

  it("hooks/useTeamProjectLifecycle.ts never imports the seat-admission module", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "hooks", "useTeamProjectLifecycle.ts"), "utf8");
    expect(source).not.toMatch(/teamWorkspaceSeatAdmission|teamWorkspaceSeatLimit|SEAT_LIMIT/);
  });
});
