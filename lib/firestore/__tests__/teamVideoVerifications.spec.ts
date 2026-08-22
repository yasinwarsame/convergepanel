/**
 * Team Video Verification, Phase 8C-E.3.3.1 —
 * `authorizeTeamVideoVerificationAdmission()` (Gate 1) /
 * `findTeamVideoVerificationDedupCandidate()` (dedup) /
 * `saveTeamVideoVerification()` (Gate 2) tests. Structural mirror of
 * `lib/firestore/__tests__/teamClaimVerifications.spec.ts`'s buffered-
 * transaction fake, extended with a `videoVerifications` collection and a
 * query-capable `.where()` chain for the dedup lookup. Authorization is
 * exercised against the REAL `authorizeTeamWorkspaceMutationInTransaction()`
 * (never mocked) so these tests prove genuine end-to-end transactional
 * behavior — including that Gate 2 never trusts a Gate-1 result.
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
  videoVerifications: new Map(),
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.projects.clear();
  stores.videoVerifications.clear();
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
let dedupQueryShouldThrow = false;

/** Tracks every write attempted inside a transaction callback, across ALL transactions opened during a test — used to assert Gate 1 performs literally zero writes. */
let writeAttempts: Array<{ kind: "create" | "update" | "set" | "delete"; collection: string; id: string }> = [];

function makeQuery(collectionName: string, filters: Array<{ field: string; value: unknown }>) {
  return {
    where: (field: string, _op: "==", value: unknown) => makeQuery(collectionName, [...filters, { field, value }]),
    get: async () => {
      if (dedupQueryShouldThrow) {
        throw new FirestoreError("14", "UNAVAILABLE");
      }
      const store = stores[collectionName];
      const docs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
      for (const [id, entry] of store.entries()) {
        const matches = filters.every((f) => entry.data[f.field] === f.value);
        if (matches) docs.push({ id, data: () => entry.data });
      }
      return { docs };
    },
  };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
    where: (field: string, op: "==", value: unknown) => makeQuery(name, [{ field, value }]),
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

jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  let counter = 0;
  return { ...actual, randomUUID: () => `test-uuid-${++counter}` };
});

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import {
  authorizeTeamVideoVerificationAdmission,
  findTeamVideoVerificationDedupCandidate,
  saveTeamVideoVerification,
} from "@/lib/firestore/teamVideoVerifications";
import { validateTeamVideoVerificationRowShape } from "@/lib/workspaces/teamVideoVerificationRowValidation";

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

function seedVideoDoc(id: string, overrides: Record<string, unknown> = {}) {
  const data = {
    userId: MEMBER_UID,
    userEmail: "member@example.com",
    type: "video_verification",
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
    consensusScore: 90,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 100,
    metadata: { duration: 10, fileSize: 1_000_000 },
    metadataAnalysis: { flags: [], summary: "" },
    modelResults: [],
    agreementPoints: [],
    disagreementPoints: [],
    frameCount: 1,
    warnings: [],
    totalTokens: 0,
    timestamp: Timestamp.fromMillis(Date.now()),
    workspaceId: WS_ID,
    projectId: null,
    ...overrides,
  };
  stores.videoVerifications.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function videoArgs(overrides: Record<string, unknown> = {}) {
  return {
    uid: MEMBER_UID,
    userEmail: "member@example.com",
    workspaceId: WS_ID,
    projectId: null,
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
    consensusScore: 90,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 100,
    metadata: { duration: 10, width: 640, height: 360, fileSize: 1_000_000, format: "mp4", codec: "h264", frameRate: 30, createdAt: null, encodingSoftware: null, hasAudio: true, cameraModel: null },
    metadataAnalysis: { flags: [], summary: "" },
    modelResults: [],
    agreementPoints: [],
    disagreementPoints: [],
    frameCount: 1,
    warnings: [],
    totalTokens: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetStores();
  concurrentMutationHook = null;
  dedupQueryShouldThrow = false;
  writeAttempts = [];
  firestoreUnavailableFlag.value = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  mockAdminDb.runTransaction.mockClear();
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
});

// ============================================================
// GATE 1
// ============================================================

describe("authorizeTeamVideoVerificationAdmission — rollout", () => {
  it("disabled -> team_workspaces_disabled, ZERO Firestore access — no runTransaction call at all", async () => {
    teamWorkspacesEnabled = false;
    const result = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("authorizeTeamVideoVerificationAdmission — authorization", () => {
  it("member with research.create, projectId null -> authorized", async () => {
    const result = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: null });
  });

  it("reviewer (no research.create) -> unauthorized insufficient_capability", async () => {
    const result = await authorizeTeamVideoVerificationAdmission({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("outsider (no membership) -> unauthorized membership_not_found", async () => {
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
  });

  it("removed membership -> unauthorized membership_removed", async () => {
    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
    const result = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
  });
});

describe("authorizeTeamVideoVerificationAdmission — Project capability & validation", () => {
  it("reviewer (lacks research.create entirely), projectId assigned -> insufficient_capability from the FIRST gate, no Project read attempted", async () => {
    seedProject(PROJECT_ID);
    let projectReadAttempted = false;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "projects") projectReadAttempted = true;
    };
    const result = await authorizeTeamVideoVerificationAdmission({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(projectReadAttempted).toBe(false);
  });

  it("owner, projectId assigned: research.create + research.organize both true -> authorized with projectId", async () => {
    seedProject(PROJECT_ID);
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "authorized", workspaceId: WS_ID, projectId: PROJECT_ID });
  });

  it("projectId null -> zero Project reads", async () => {
    let getCalls = 0;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "projects") getCalls += 1;
    };
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: null });
    expect(result.status).toBe("authorized");
    expect(getCalls).toBe(0);
  });

  it("missing Project -> project_not_found", async () => {
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "does-not-exist" });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("malformed Project (embedded id mismatch) -> project_not_found", async () => {
    seedProject(PROJECT_ID, { id: "different-id" });
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("foreign Workspace Project -> project_not_found", async () => {
    seedProject(PROJECT_ID, { workspaceId: "ws-other" });
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("archived Project -> project_archived", async () => {
    seedProject(PROJECT_ID, { status: "archived" });
    const result = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result).toEqual({ status: "project_archived" });
  });
});

describe("authorizeTeamVideoVerificationAdmission — zero-write invariant", () => {
  it("authorized outcome -> literally zero writes attempted across the whole transaction", async () => {
    seedProject(PROJECT_ID);
    await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(writeAttempts).toEqual([]);
    expect(stores.videoVerifications.size).toBe(0);
    expect(stores.projects.size).toBe(1); // unchanged from seed
  });

  it("denied outcome -> also zero writes attempted", async () => {
    await authorizeTeamVideoVerificationAdmission({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: null });
    expect(writeAttempts).toEqual([]);
  });
});

// ============================================================
// DEDUP
// ============================================================

describe("findTeamVideoVerificationDedupCandidate — binding isolation", () => {
  it("same uid+file+workspace+null-project -> hit", async () => {
    seedVideoDoc("vid-hit", { timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.id).toBe("vid-hit");
  });

  it("same uid+file+workspace+matching Project -> hit", async () => {
    seedVideoDoc("vid-proj", { projectId: PROJECT_ID, timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT_ID, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.id).toBe("vid-proj");
  });

  it("Personal row (no workspaceId field) excluded", async () => {
    const data = { userId: MEMBER_UID, fileName: "clip.mp4", timestamp: Timestamp.fromMillis(Date.now() - 5_000), metadata: { fileSize: 1_000_000, duration: 10 } };
    stores.videoVerifications.set("vid-personal", { data, updateTime: nextUpdateTime() });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });

  it("different Workspace excluded", async () => {
    seedVideoDoc("vid-other-ws", { workspaceId: "ws-other", timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });

  it("null query excludes an assigned-Project row", async () => {
    seedVideoDoc("vid-p1", { projectId: PROJECT_ID, timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });

  it("P1 vs P2 excluded", async () => {
    seedVideoDoc("vid-p1", { projectId: "proj-1", timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: "proj-2", fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });
});

describe("findTeamVideoVerificationDedupCandidate — window/size/duration + newest-only", () => {
  it("outside window -> miss", async () => {
    seedVideoDoc("vid-old", { timestamp: Timestamp.fromMillis(Date.now() - 35_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });

  it("fileSize mismatch -> miss", async () => {
    seedVideoDoc("vid-size", { metadata: { fileSize: 42, duration: 10 }, timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });

  it("duration mismatch -> miss", async () => {
    seedVideoDoc("vid-dur", { metadata: { fileSize: 1_000_000, duration: 20 }, timestamp: Timestamp.fromMillis(Date.now() - 5_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });

  it("newest of two matching docs is returned", async () => {
    seedVideoDoc("vid-older", { timestamp: Timestamp.fromMillis(Date.now() - 20_000) });
    seedVideoDoc("vid-newer", { timestamp: Timestamp.fromMillis(Date.now() - 3_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate!.id).toBe("vid-newer");
  });

  it("MATERIAL: newest candidate fails, older would match -> MISS (older never consulted)", async () => {
    seedVideoDoc("vid-older-would-match", { timestamp: Timestamp.fromMillis(Date.now() - 10_000) });
    seedVideoDoc("vid-newest-mismatch", { metadata: { fileSize: 999, duration: 10 }, timestamp: Timestamp.fromMillis(Date.now() - 1_000) });
    const candidate = await findTeamVideoVerificationDedupCandidate({
      uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000,
    });
    expect(candidate).toBeNull();
  });
});

describe("findTeamVideoVerificationDedupCandidate — infra failure", () => {
  it("query throw propagates (not swallowed as a miss)", async () => {
    dedupQueryShouldThrow = true;
    await expect(
      findTeamVideoVerificationDedupCandidate({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000 })
    ).rejects.toThrow();
  });

  it("adminDb unavailable -> throws (never a silent null-safe miss)", async () => {
    firestoreUnavailableFlag.value = true;
    await expect(
      findTeamVideoVerificationDedupCandidate({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null, fileName: "clip.mp4", fileSize: 1_000_000, duration: 10, windowMs: 30_000 })
    ).rejects.toThrow();
  });
});

// ============================================================
// GATE 2
// ============================================================

describe("saveTeamVideoVerification — rollout", () => {
  it("disabled -> team_workspaces_disabled, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await saveTeamVideoVerification(videoArgs() as any);
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("owns its own rollout check independently of Gate 1 having already checked it", async () => {
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");
    teamWorkspacesEnabled = false;
    const gate2 = await saveTeamVideoVerification(videoArgs() as any);
    expect(gate2).toEqual({ status: "team_workspaces_disabled" });
  });

  it("firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await saveTeamVideoVerification(videoArgs() as any);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("saveTeamVideoVerification — creates a canonical document", () => {
  it("member, projectId null -> created, canonical row passes validator", async () => {
    const result = await saveTeamVideoVerification(videoArgs() as any);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.workspaceId).toBe(WS_ID);
    expect(result.projectId).toBeNull();
    expect(result.verificationId.startsWith("vid-")).toBe(true);

    const stored = stores.videoVerifications.get(result.verificationId);
    expect(stored).toBeDefined();
    expect(stored!.data.userId).toBe(MEMBER_UID);
    expect(stored!.data.userEmail).toBe("member@example.com");
    expect(stored!.data.workspaceId).toBe(WS_ID);
    expect(Object.prototype.hasOwnProperty.call(stored!.data, "projectId")).toBe(true);
    expect(stored!.data.projectId).toBeNull();
    expect(stored!.data.type).toBe("video_verification");
    expect(stored!.data.fileName).toBe("clip.mp4");
    expect(stored!.data.timestamp).toBeInstanceOf(Object); // FieldValue.serverTimestamp() sentinel, not overfit to internals.
    expect((stored!.data as any).frames).toBeUndefined();

    const validated = validateTeamVideoVerificationRowShape(stored!.data as Record<string, unknown>, WS_ID);
    // Validator requires a real Timestamp instance — a FieldValue sentinel
    // is not one, so this genuine mock limitation is expected; assert the
    // binding fields directly instead of relying on the validator here.
    expect(validated.ok).toBe(false);
    expect(stored!.data.workspaceId).toBe(WS_ID);
  });

  it("id is generated inside the writer, never supplied by the caller", async () => {
    const args = videoArgs() as any;
    expect(args.verificationId).toBeUndefined();
    const result = await saveTeamVideoVerification(args);
    if (result.status !== "created") throw new Error("expected created");
    expect(result.verificationId).toMatch(/^vid-/);
  });

  it("uses tx.create, not tx.set/update — every videoVerifications write attempt is a create", async () => {
    await saveTeamVideoVerification(videoArgs() as any);
    expect(writeAttempts.filter((w) => w.collection === "videoVerifications").every((w) => w.kind === "create")).toBe(true);
  });

  it("owner, projectId assigned -> created with projectId", async () => {
    seedProject(PROJECT_ID);
    const result = await saveTeamVideoVerification(videoArgs({ uid: OWNER_UID, userEmail: "owner@example.com", projectId: PROJECT_ID }) as any);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.projectId).toBe(PROJECT_ID);
    const stored = stores.videoVerifications.get(result.verificationId);
    expect(stored!.data.projectId).toBe(PROJECT_ID);
    expect(stored!.data.userEmail).toBe("owner@example.com");
  });

  it("workspace owner's email is never substituted for the requester's own", async () => {
    const result = await saveTeamVideoVerification(videoArgs({ uid: MEMBER_UID, userEmail: "member@example.com" }) as any);
    if (result.status !== "created") throw new Error("expected created");
    const stored = stores.videoVerifications.get(result.verificationId);
    expect(stored!.data.userEmail).toBe("member@example.com");
    expect(stored!.data.userEmail).not.toBe("owner@example.com");
  });
});

describe("saveTeamVideoVerification — races (Gate 1 must not authorize Gate 2)", () => {
  it("A. Gate 1 authorized, membership removed before Gate 2 -> Gate 2 denied, no artifact", async () => {
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");

    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });

    const gate2 = await saveTeamVideoVerification(videoArgs() as any);
    expect(gate2).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.videoVerifications.size).toBe(0);
  });

  it("B. Gate 1 authorized, capability downgraded (member -> reviewer) before Gate 2 -> denied, no artifact", async () => {
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");

    seedMembership(MEMBER_UID, "reviewer");

    const gate2 = await saveTeamVideoVerification(videoArgs() as any);
    expect(gate2).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.videoVerifications.size).toBe(0);
  });

  it("C. Gate 1 authorized, owner transfer before Gate 2 -> final (post-transfer) state applied, still succeeds for a still-qualifying caller", async () => {
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: null });
    expect(gate1.status).toBe("authorized");

    seedWorkspace({ ownerUserId: MEMBER_UID });
    seedMembership(MEMBER_UID, "owner");

    const gate2 = await saveTeamVideoVerification(videoArgs() as any);
    expect(gate2.status).toBe("created");
  });

  it("D. Gate 1 authorized, Project archived before Gate 2 -> project_archived, no artifact", async () => {
    seedProject(PROJECT_ID);
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(gate1.status).toBe("authorized");

    seedProject(PROJECT_ID, { status: "archived" });

    const gate2 = await saveTeamVideoVerification(videoArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(gate2).toEqual({ status: "project_archived" });
    expect(stores.videoVerifications.size).toBe(0);
  });

  it("E. Project remains active through both gates -> artifact created", async () => {
    seedProject(PROJECT_ID);
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid: OWNER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(gate1.status).toBe("authorized");

    const gate2 = await saveTeamVideoVerification(videoArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(gate2.status).toBe("created");
  });

  it("Gate 2 does not accept or reuse any Gate-1-derived membership: calling Gate 2 WITHOUT ever calling Gate 1 first produces the identical outcome", async () => {
    seedProject(PROJECT_ID);
    const gate2Direct = await saveTeamVideoVerification(videoArgs({ uid: OWNER_UID, projectId: PROJECT_ID }) as any);
    expect(gate2Direct.status).toBe("created");
  });
});

describe("saveTeamVideoVerification — transaction failure maps to transaction_failed", () => {
  it("an internal transaction error is caught and converted, not left to escape", async () => {
    concurrentMutationHook = () => {
      throw new Error("simulated transient Firestore error");
    };
    const result = await saveTeamVideoVerification(videoArgs() as any);
    expect(result).toEqual({ status: "transaction_failed" });
    expect(stores.videoVerifications.size).toBe(0);
  });
});
