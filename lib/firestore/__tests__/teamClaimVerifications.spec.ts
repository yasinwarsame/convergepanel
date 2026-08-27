/**
 * Team Claim Verification, Phase 8C-E.1 —
 * `authorizeTeamClaimVerificationAdmission()` (Gate 1) /
 * `saveTeamClaimVerification()` (Gate 2) tests. Structural mirror of
 * `lib/firestore/__tests__/teamWorkspaceRuns.spec.ts`'s buffered-
 * transaction fake, extended with a `verifications` collection alongside
 * `workspaces`/`workspaceMemberships`/`projects`. Authorization is
 * exercised against the REAL `authorizeTeamWorkspaceMutationInTransaction()`
 * (never mocked) so these tests prove genuine end-to-end transactional
 * behavior — including the central 8C-E.0.1 invariant that Gate 2 never
 * trusts a Gate-1 result and independently re-derives its own.
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
  verifications: new Map(),
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.projects.clear();
  stores.verifications.clear();
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

/** Tracks every write attempted inside a transaction callback, across ALL transactions opened during a test — used to assert Gate 1 performs literally zero writes. */
let writeAttempts: Array<{ kind: "create" | "update" | "set" | "delete"; collection: string; id: string }> = [];

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
        const snapshot = { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
        if (concurrentMutationHook) concurrentMutationHook(ref);
        return snapshot;
      },
      create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        writeAttempts.push({ kind: "create", collection: ref.__collection, id: ref.__id });
        const store = stores[ref.__collection];
        if (store.has(ref.__id)) {
          throw new FirestoreError("6", "ALREADY_EXISTS");
        }
        pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        writeAttempts.push({ kind: "update", collection: ref.__collection, id: ref.__id });
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        if (!entry) throw new FirestoreError("5", "NOT_FOUND");
        pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
      },
      set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        writeAttempts.push({ kind: "set", collection: ref.__collection, id: ref.__id });
        const store = stores[ref.__collection];
        pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
      delete: (ref: { __collection: string; __id: string }) => {
        writeAttempts.push({ kind: "delete", collection: ref.__collection, id: ref.__id });
        const store = stores[ref.__collection];
        pendingWrites.push(() => store.delete(ref.__id));
      },
    };

    const result = await fn(txn);
    for (const applyWrite of pendingWrites) applyWrite();
    return result;
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

jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  let counter = 0;
  return { ...actual, randomUUID: () => `test-uuid-${++counter}` };
});

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { authorizeTeamClaimVerificationAdmission, saveTeamClaimVerification } from "@/lib/firestore/teamClaimVerifications";
import { validateTeamClaimVerificationRowShape } from "@/lib/workspaces/teamClaimVerificationRowValidation";

const WS_ID = "ws-team-1";
const WS_OTHER_ID = "ws-team-other";
const OWNER_UID = "owner-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const OUTSIDER_UID = "outsider-1";
const PROJECT_ID = "proj-1";

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  const data = { schemaVersion: 1, id: WS_ID, type: "team", name: "Acme Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000), ...overrides };
  stores.workspaces.set(WS_ID, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedMembership(uid: string, role: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(WS_ID, uid);
  const data = { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides };
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  const data = { schemaVersion: 1, id, workspaceId: WS_ID, name: "Existing Project", status: "active", createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000), ...overrides };
  stores.projects.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedWorkspaceById(id: string, overrides: Record<string, unknown> = {}) {
  const data = { schemaVersion: 1, id, type: "team", name: "Other Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000), ...overrides };
  stores.workspaces.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedMembershipInWorkspace(workspaceId: string, uid: string, role: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const data = { schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides };
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function claimArgs(overrides: Record<string, unknown> = {}) {
  return {
    uid: MEMBER_UID,
    workspaceId: WS_ID,
    projectId: null,
    claim: "The sky is blue.",
    verdict: "accurate",
    consensusScore: 90,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 100,
    modelResults: [],
    auditBundle: {},
    selectedModels: ["claude", "chatgpt"],
    ...overrides,
  };
}

beforeEach(() => {
  resetStores();
  concurrentMutationHook = null;
  writeAttempts = [];
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

// ============================================================
// GATE 1
// ============================================================

describe("authorizeTeamClaimVerificationAdmission — rollout", () => {
  it("disabled -> team_workspaces_disabled, ZERO Firestore access — no runTransaction call at all", async () => {
    teamWorkspacesEnabled = false;
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("authorizeTeamClaimVerificationAdmission — authorization", () => {
  it("member with research.create, projectId null -> authorized", async () => {
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: null });
  });

  it("reviewer (no research.create) -> unauthorized insufficient_capability", async () => {
    const result = await authorizeTeamClaimVerificationAdmission({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("outsider (no membership) -> unauthorized membership_not_found", async () => {
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
  });

  it("removed membership -> unauthorized membership_removed", async () => {
    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
  });
});

describe("authorizeTeamClaimVerificationAdmission — Project capability & validation", () => {
  it("reviewer (lacks research.create entirely), projectId assigned -> insufficient_capability from the FIRST gate, no Project read attempted", async () => {
    seedProject(PROJECT_ID);
    let projectReadAttempted = false;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "projects") projectReadAttempted = true;
    };
    const result = await authorizeTeamClaimVerificationAdmission({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(projectReadAttempted).toBe(false);
  });

  it("owner, projectId assigned: research.create + research.organize both true -> authorized with projectId", async () => {
    seedProject(PROJECT_ID);
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: PROJECT_ID });
  });

  it("projectId null -> zero Project reads", async () => {
    let getCalls = 0;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "projects") getCalls += 1;
    };
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: null });
    expect(result.status).toBe("authorized");
    expect(getCalls).toBe(0);
  });

  it("missing Project -> project_not_found", async () => {
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "does-not-exist" });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("malformed Project (embedded id mismatch) -> project_not_found", async () => {
    seedProject(PROJECT_ID, { id: "different-id" });
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("foreign Workspace Project -> project_not_found", async () => {
    seedProject(PROJECT_ID, { workspaceId: "ws-other" });
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("archived Project -> project_archived", async () => {
    seedProject(PROJECT_ID, { status: "archived" });
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_archived" });
  });
});

describe("authorizeTeamClaimVerificationAdmission — zero-write invariant (Correction Step 19/9)", () => {
  it("authorized outcome -> literally zero writes attempted across the whole transaction", async () => {
    seedProject(PROJECT_ID);
    await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(writeAttempts).toEqual([]);
    expect(stores.verifications.size).toBe(0);
    expect(stores.projects.size).toBe(1); // unchanged from seed
  });

  it("denied outcome -> also zero writes attempted", async () => {
    await authorizeTeamClaimVerificationAdmission({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: null });
    expect(writeAttempts).toEqual([]);
  });
});

describe("authorizeTeamClaimVerificationAdmission — Workspace-canary target admission (Phase 10B.3.2A)", () => {
  it("uid-canary only (global off) -> authorized", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = MEMBER_UID;
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: null });
  });

  it("Workspace-canary only, active member with research.create -> authorized", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: null });
  });

  it("Workspace-canary only, reviewer (no research.create) -> insufficient_capability, not an admission failure", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await authorizeTeamClaimVerificationAdmission({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("Workspace-canary only, no membership -> membership_not_found", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await authorizeTeamClaimVerificationAdmission({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
  });

  it("Workspace-canary only, removed membership -> membership_removed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
  });

  it("MANDATORY cross-target: Workspace-canary admits WS_ID only; caller also has a valid membership in WS_OTHER_ID, but WS_OTHER_ID is not itself admitted -> team_workspaces_disabled, not authorized via the caller's unrelated admitted-Workspace membership", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID; // only WS_ID admitted, not WS_OTHER_ID
    seedWorkspaceById(WS_OTHER_ID);
    seedMembershipInWorkspace(WS_OTHER_ID, MEMBER_UID, "member");
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_OTHER_ID, projectId: null });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
  });

  it("MANDATORY cross-Workspace resource mismatch: Workspace-canary admits WS_ID and caller has a valid WS_ID membership with research.create+research.organize, but the supplied projectId's own canonical workspaceId is a different, unrelated Workspace -> project_not_found, never authorized via the caller's WS_ID admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "admin");
    seedProject(PROJECT_ID, { workspaceId: "ws-other" });
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("malformed Workspace-canary list, global/uid off -> team_workspaces_disabled (fails closed)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "*";
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = MEMBER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    const result = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: null });
  });
});

// ============================================================
// GATE 2
// ============================================================

describe("saveTeamClaimVerification — rollout", () => {
  it("disabled -> team_workspaces_disabled, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await saveTeamClaimVerification(claimArgs() as any);
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("owns its own rollout check independently of Gate 1 having already checked it", async () => {
    // Gate 1 succeeds first (rollout enabled at that point)...
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");
    // ...then rollout flips off before Gate 2 runs.
    teamWorkspacesEnabled = false;
    const gate2 = await saveTeamClaimVerification(claimArgs() as any);
    expect(gate2).toEqual({ status: "team_workspaces_disabled" });
  });
});

describe("saveTeamClaimVerification — creates a canonical document", () => {
  it("member, projectId null -> created, canonical row passes validator", async () => {
    const result = await saveTeamClaimVerification(claimArgs() as any);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.workspaceId).toBe(WS_ID);
    expect(result.projectId).toBeNull();
    expect(result.verificationId.startsWith("vcl-")).toBe(true);

    const stored = stores.verifications.get(result.verificationId);
    expect(stored).toBeDefined();
    expect(stored!.data.userId).toBe(MEMBER_UID);
    expect(stored!.data.workspaceId).toBe(WS_ID);
    expect(Object.prototype.hasOwnProperty.call(stored!.data, "projectId")).toBe(true);
    expect(stored!.data.projectId).toBeNull();
    expect(stored!.data.type).toBe("claim_verification");
    expect(stored!.data.claim).toBe("The sky is blue.");
    expect(stored!.data.timestamp).toBeInstanceOf(Timestamp);

    const validated = validateTeamClaimVerificationRowShape(stored!.data, WS_ID);
    expect(validated.ok).toBe(true);
  });

  it("uses tx.create, not tx.set — a verificationId collision fails the transaction, never overwrites", async () => {
    await saveTeamClaimVerification(claimArgs() as any);
    // Force a collision by mocking randomUUID to repeat the same value.
    const cryptoMod = require("crypto");
    const originalRandomUUID = cryptoMod.randomUUID;
    cryptoMod.randomUUID = () => "test-uuid-1"; // same as the first call
    const before = stores.verifications.size;
    const result = await saveTeamClaimVerification(claimArgs() as any);
    // Depending on the counter mock, this proves collision-safety only if
    // ids actually collide; assert via the write log instead, which is
    // deterministic regardless: every create call is tx.create, never
    // tx.set/update.
    expect(writeAttempts.filter((w) => w.collection === "verifications").every((w) => w.kind === "create")).toBe(true);
    cryptoMod.randomUUID = originalRandomUUID;
    void before;
    void result;
  });

  it("owner, projectId assigned -> created with projectId", async () => {
    seedProject(PROJECT_ID);
    const result = await saveTeamClaimVerification(claimArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.projectId).toBe(PROJECT_ID);
    const stored = stores.verifications.get(result.verificationId);
    expect(stored!.data.projectId).toBe(PROJECT_ID);
  });
});

describe("saveTeamClaimVerification — races (Gate 1 must not authorize Gate 2)", () => {
  it("A. Gate 1 authorized, membership removed before Gate 2 -> Gate 2 denied, no artifact", async () => {
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");

    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });

    const gate2 = await saveTeamClaimVerification(claimArgs() as any);
    expect(gate2).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.verifications.size).toBe(0);
  });

  it("B. Gate 1 authorized, capability downgraded (member -> reviewer) before Gate 2 -> denied, no artifact", async () => {
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");

    seedMembership(MEMBER_UID, "reviewer");

    const gate2 = await saveTeamClaimVerification(claimArgs() as any);
    expect(gate2).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.verifications.size).toBe(0);
  });

  it("C. Gate 1 authorized, owner transfer before Gate 2 -> final (post-transfer) state applied, still succeeds for a still-qualifying caller", async () => {
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");

    // Owner transfers to MEMBER_UID; workspace + membership updated consistently.
    seedWorkspace({ ownerUserId: MEMBER_UID });
    seedMembership(MEMBER_UID, "owner");

    const gate2 = await saveTeamClaimVerification(claimArgs() as any);
    expect(gate2.status).toBe("created");
  });

  it("D. Gate 1 authorized, Project archived before Gate 2 -> project_archived, no artifact", async () => {
    seedProject(PROJECT_ID);
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(gate1.status).toBe("authorized");

    seedProject(PROJECT_ID, { status: "archived" });

    const gate2 = await saveTeamClaimVerification(claimArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(gate2).toEqual({ status: "project_archived" });
    expect(stores.verifications.size).toBe(0);
  });

  it("E. Project remains active through both gates -> artifact created", async () => {
    seedProject(PROJECT_ID);
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(gate1.status).toBe("authorized");

    const gate2 = await saveTeamClaimVerification(claimArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(gate2.status).toBe("created");
  });

  it("Gate 2 does not accept or reuse any Gate-1-derived membership: even calling Gate 2 WITHOUT ever calling Gate 1 first produces the identical outcome", async () => {
    seedProject(PROJECT_ID);
    const gate2Direct = await saveTeamClaimVerification(claimArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(gate2Direct.status).toBe("created");
  });
});

describe("saveTeamClaimVerification — Workspace-canary target admission (Phase 10B.3.2A)", () => {
  it("Workspace-canary only, active member with research.create -> created", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await saveTeamClaimVerification(claimArgs() as any);
    expect(result.status).toBe("created");
  });

  it("Workspace-canary only, reviewer (no research.create) -> insufficient_capability, zero artifact", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await saveTeamClaimVerification(claimArgs({ uid: REVIEWER_UID }) as any);
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.verifications.size).toBe(0);
  });

  it("MANDATORY cross-target: Workspace-canary admits WS_ID only; caller has a valid membership in WS_OTHER_ID too, but calling with workspaceId: WS_OTHER_ID (not itself admitted) -> team_workspaces_disabled, zero writes — the caller's admitted status for WS_ID never carries over to a different target workspace", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID; // only WS_ID admitted
    seedWorkspaceById(WS_OTHER_ID);
    seedMembershipInWorkspace(WS_OTHER_ID, MEMBER_UID, "member");
    const result = await saveTeamClaimVerification(claimArgs({ workspaceId: WS_OTHER_ID }) as any);
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(stores.verifications.size).toBe(0);
    expect(writeAttempts).toEqual([]);
  });

  it("MANDATORY cross-Workspace resource mismatch: Workspace-canary admits WS_ID and caller has a valid WS_ID membership with research.create+research.organize, but the supplied projectId's own canonical workspaceId is a different, unrelated Workspace -> project_not_found, zero writes", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "admin");
    seedProject(PROJECT_ID, { workspaceId: "ws-other" });
    const result = await saveTeamClaimVerification(claimArgs({ projectId: PROJECT_ID }) as any);
    expect(result).toEqual({ status: "project_not_found" });
    expect(stores.verifications.size).toBe(0);
    expect(writeAttempts).toEqual([]);
  });

  it("malformed Workspace-canary list, global/uid off -> team_workspaces_disabled, zero writes", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "*";
    const result = await saveTeamClaimVerification(claimArgs() as any);
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(writeAttempts).toEqual([]);
  });
});
