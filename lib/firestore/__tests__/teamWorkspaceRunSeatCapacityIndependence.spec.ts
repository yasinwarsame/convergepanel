/**
 * PHASE 12A.3 — explicit tested invariant, extending PHASE 12A.2-I1's own
 * orthogonality proof one layer deeper: the permanent collaborator-seat
 * limit (Phase 12A.1S.1) and Team RESEARCH creation (Phase 12A.3) are
 * completely independent entitlements. A Workspace at 5/5 collaborator
 * seats must not block starting research, an incomplete Invite step must
 * not block it either, and Team research creation must never read or
 * write the collaborator-seat admission cache.
 *
 * Mirrors `lib/firestore/__tests__/teamProjectSeatCapacityIndependence.spec.ts`'s
 * exact fake-Firestore shape and structural-tripwire technique (the fake
 * deliberately omits a `teamWorkspaceSeatAdmission` store — any accidental
 * touch would throw), applied to `createTeamWorkspaceRun()` instead of
 * `createTeamProject()`.
 */

import { Timestamp } from "firebase-admin/firestore";

let autoIdCounter = 0;
function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

type StoredDoc = { data: Record<string, unknown> };
// Deliberately NO `teamWorkspaceSeatAdmission` entry here — see module doc comment.
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  projects: new Map(),
  runs: new Map(),
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
      return { exists: entry !== undefined, data: () => entry?.data };
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
        return { exists: entry !== undefined, data: () => entry?.data };
      },
      create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        if (store.has(ref.__id)) throw new FirestoreError("6", "ALREADY_EXISTS");
        pendingWrites.push(() => store.set(ref.__id, { data }));
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
import { createTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";

const WS_ID = "ws-research-orthogonality-1";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";

function seedWorkspace() {
  stores.workspaces.set(WS_ID, { data: { schemaVersion: 1, id: WS_ID, type: "team", name: "Research Orthogonality Test Workspace", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000) } });
}
function seedMembership(uid: string, role: string) {
  const id = computeMembershipId(WS_ID, uid);
  stores.workspaceMemberships.set(id, {
    data: { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null },
  });
}
/** Fills the Workspace to exactly 5 non-owner collaborator seats (the permanent limit), mirroring a fully-occupied Team Workspace — no pending invitations needed here since this file never touches the invitation collections at all. */
function fillToCollaboratorSeatLimit() {
  seedMembership(ADMIN_UID, "admin");
  for (let i = 0; i < 4; i++) seedMembership(`collaborator-${i}`, "member");
}
function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  stores.projects.set(id, { data: { schemaVersion: 1, id, workspaceId: WS_ID, name: "Test Project", status: "active", createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000), ...overrides } });
}

beforeEach(() => {
  for (const store of Object.values(stores)) store.clear();
  autoIdCounter = 0;
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
});

describe("PHASE 12A.3 — Team research creation is independent of collaborator-seat capacity", () => {
  it("Workspace at exactly 5/5 collaborator seats -> Unfiled research creation still succeeds", async () => {
    fillToCollaboratorSeatLimit();
    const result = await createTeamWorkspaceRun({ uid: OWNER_UID, workspaceId: WS_ID, question: "What is the market size?", selectedModels: ["chatgpt", "claude"] as any, projectId: null });
    expect(result.status).toBe("created");
  });

  it("Workspace at exactly 5/5 collaborator seats -> Project-bound research creation still succeeds (people capacity governs people, not research)", async () => {
    fillToCollaboratorSeatLimit();
    seedProject("proj-1");
    const result = await createTeamWorkspaceRun({ uid: OWNER_UID, workspaceId: WS_ID, question: "What is the market size?", selectedModels: ["chatgpt", "claude"] as any, projectId: "proj-1" });
    expect(result.status).toBe("created");
  });

  it("Workspace over the collaborator-seat limit (legacy 7 non-owner members) -> research creation still succeeds", async () => {
    for (let i = 0; i < 7; i++) seedMembership(`legacy-collaborator-${i}`, "member");
    const result = await createTeamWorkspaceRun({ uid: OWNER_UID, workspaceId: WS_ID, question: "Q", selectedModels: ["chatgpt", "claude"] as any, projectId: null });
    expect(result.status).toBe("created");
  });

  it("starting several research runs never touches the collaborator-seat admission cache (structural tripwire: the fake has no teamWorkspaceSeatAdmission store — any access to it would throw)", async () => {
    fillToCollaboratorSeatLimit();
    seedProject("proj-1");
    const first = await createTeamWorkspaceRun({ uid: OWNER_UID, workspaceId: WS_ID, question: "Q1", selectedModels: ["chatgpt", "claude"] as any, projectId: "proj-1" });
    const second = await createTeamWorkspaceRun({ uid: OWNER_UID, workspaceId: WS_ID, question: "Q2", selectedModels: ["chatgpt", "claude"] as any, projectId: "proj-1" });
    expect([first.status, second.status]).toEqual(["created", "created"]);
  });
});

describe("PHASE 12A.3 — Team research creation is independent of Invite-your-team completion", () => {
  it("Workspace with ONLY the canonical Owner (zero invites, zero other members) -> research creation still succeeds for an authorized researcher", async () => {
    const result = await createTeamWorkspaceRun({ uid: OWNER_UID, workspaceId: WS_ID, question: "Q", selectedModels: ["chatgpt", "claude"] as any, projectId: null });
    expect(result.status).toBe("created");
  });
});

describe("PHASE 12A.3 — source-level structural independence (permanent regression guard)", () => {
  function readSource(relativePath: string): string {
    return require("fs").readFileSync(require("path").join(__dirname, "..", "..", relativePath), "utf8");
  }

  it("lib/firestore/teamWorkspaceRuns.ts (createTeamWorkspaceRun) never imports the seat-admission module", () => {
    const source = readSource("firestore/teamWorkspaceRuns.ts");
    expect(source).not.toMatch(/teamWorkspaceSeatAdmission|teamWorkspaceSeatLimit/);
  });

  it("hooks/useTeamProjectResearch.ts never imports the seat-admission module", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "hooks", "useTeamProjectResearch.ts"), "utf8");
    expect(source).not.toMatch(/teamWorkspaceSeatAdmission|teamWorkspaceSeatLimit|SEAT_LIMIT/);
  });

  it("components/workspace/projects/TeamResearchComposerShell.tsx never imports the seat-admission module", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "components", "workspace", "projects", "TeamResearchComposerShell.tsx"), "utf8");
    expect(source).not.toMatch(/teamWorkspaceSeatAdmission|teamWorkspaceSeatLimit|SEAT_LIMIT/);
  });
});
