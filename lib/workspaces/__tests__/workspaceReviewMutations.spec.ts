/**
 * Approval Workflow, Phase 9B.5.1 — workspaceReviewMutations.ts tests.
 * In-memory Firestore transaction fake for what the transactions actually
 * touch (workspaces, workspaceMemberships, runs, humanReviewAssignment,
 * humanReviewPanel), mirroring associateTeamRunWithProject.spec.ts /
 * resubmitWorkspaceReview.spec.ts's own hardened, read-after-write-guarded
 * fake exactly (Phase 9B.2-R1's lesson). The four already-independently-
 * tested best-effort post-commit writers (assignment history, review
 * history, governance events, admin audit) are MOCKED here — this suite
 * verifies they are CALLED correctly, not that their own internals work
 * (that's covered by their own dedicated spec files).
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  runs: new Map(),
  humanReviewAssignment: new Map(), // keyed by runId — single "current" doc
  humanReviewPanel: new Map(), // keyed by runId — single "current" doc
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
}

function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function applyDottedFieldUpdate(existing: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  for (const [path, value] of Object.entries(data)) {
    const segments = path.split(".");
    let cursor: Record<string, unknown> = result;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const current = cursor[seg];
      cursor[seg] = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = value;
  }
  return result;
}

function makeSubDocRef(subCollectionName: string, parentDocId: string) {
  return {
    __collection: subCollectionName,
    __id: parentDocId,
    // Plain, non-transactional read — used only by getWorkspaceReviewAssignment.
    get: async () => {
      const data = stores[subCollectionName].get(parentDocId);
      return { exists: data !== undefined, data: () => data, id: parentDocId };
    },
  };
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    collection: (subCollectionName: string) => ({
      doc: (_subDocId: string) => makeSubDocRef(subCollectionName, docId),
    }),
    // Plain, non-transactional read — used only by getWorkspaceReviewAssignment.
    get: async () => {
      const data = stores[collectionName].get(docId);
      return { exists: data !== undefined, data: () => data, id: docId };
    },
  };
}

/**
 * Fires on every `tx.get()`, AFTER this attempt's own read snapshot for that doc has
 * already been captured (see `runTransaction` below) — so a hook that mutates a store
 * models a genuinely concurrent, separate transaction committing a change this
 * attempt's reads cannot observe, exactly like real Firestore. Used (Phase
 * 9B.5.1-R1C) to prove an assignment mutation cannot commit around a panel that
 * opens between this transaction's panel read and its commit: `runTransaction`
 * below detects the resulting conflict and retries the whole callback, so the
 * retried attempt observes the panel as open and the business logic itself denies
 * the mutation — never a race window.
 */
let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
const firestoreUnavailableFlag = { value: false };
const transactionShouldThrow = { value: false };
const transactionAttemptCount = { value: 0 };
const MAX_TRANSACTION_ATTEMPTS = 5;

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    if (transactionShouldThrow.value) throw new Error("simulated transaction failure");
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
      transactionAttemptCount.value++;
      const pendingWrites: Array<() => void> = [];
      const readSnapshots = new Map<string, unknown>();
      let hasWritten = false;
      const txn = {
        get: async (ref: { __collection: string; __id: string }) => {
          if (hasWritten) throw new Error("Firestore transactions require all reads to be executed before all writes.");
          const store = stores[ref.__collection];
          const data = store.get(ref.__id);
          readSnapshots.set(`${ref.__collection}/${ref.__id}`, data);
          if (concurrentMutationHook) concurrentMutationHook(ref);
          return { exists: data !== undefined, data: () => data, id: ref.__id };
        },
        update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          pendingWrites.push(() => {
            const store = stores[ref.__collection];
            const existing = store.get(ref.__id) ?? {};
            store.set(ref.__id, applyDottedFieldUpdate(existing, data));
          });
        },
        set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          pendingWrites.push(() => stores[ref.__collection].set(ref.__id, data));
        },
      };
      const result = await fn(txn);
      // Firestore-style OCC: if any doc this attempt read has since changed (a
      // concurrent transaction committed underneath it), discard this attempt's
      // writes entirely and retry the whole callback from scratch — never apply a
      // write derived from a stale read.
      const conflicted = [...readSnapshots.entries()].some(([key, snapshot]) => {
        const [collection, id] = key.split("/");
        return stores[collection].get(id) !== snapshot;
      });
      if (conflicted) continue;
      for (const applyWrite of pendingWrites) applyWrite();
      return result;
    }
    throw new Error("simulated transaction retry exhaustion");
  }),
  // Only used by getWorkspaceReviewAssignment's plain, non-transactional read.
  get: undefined,
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

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

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedCreateAdaptiveHumanReviewAssignmentHistory = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedCreateAdaptiveHumanReviewHistory = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedWriteAdaptiveHumanReviewEvent = jest.fn().mockResolvedValue({ written: true });
jest.mock("@/lib/firestore/runs", () => ({
  createAdaptiveHumanReviewAssignmentHistory: (...args: unknown[]) => mockedCreateAdaptiveHumanReviewAssignmentHistory(...args),
  createAdaptiveHumanReviewHistory: (...args: unknown[]) => mockedCreateAdaptiveHumanReviewHistory(...args),
  writeAdaptiveHumanReviewEvent: (...args: unknown[]) => mockedWriteAdaptiveHumanReviewEvent(...args),
}));

const mockedWriteAdaptiveAdminAuditEvent = jest.fn().mockResolvedValue({ status: "recorded" });
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveAdminAuditEvent: (...args: unknown[]) => mockedWriteAdaptiveAdminAuditEvent(...args),
}));

// Phase 9B.5.1-R1C — wraps the REAL capabilities module (every test relies on the
// genuine role -> capability matrix by default) but lets specific tests install a
// synthetic override, so the "assignment management requires reviews.manage AND
// research.read, independently" invariant can be locked in even though no current
// role can otherwise represent "has reviews.manage but not research.read."
const mockedRoleHasCapability = jest.fn();
jest.mock("@/lib/workspaces/capabilities", () => {
  const actual = jest.requireActual("@/lib/workspaces/capabilities");
  return { ...actual, roleHasCapability: (...args: unknown[]) => mockedRoleHasCapability(...args) };
});

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { getWorkspaceReviewAssignment, putWorkspaceReviewAssignment, deleteWorkspaceReviewAssignment, submitWorkspaceReviewDecision } from "@/lib/workspaces/workspaceReviewMutations";

const actualCapabilities = jest.requireActual("@/lib/workspaces/capabilities");

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const REVIEWER2_UID = "reviewer-2";
const VIEWER_UID = "viewer-1";
const CREATOR_UID = "creator-1";
const OUTSIDER_UID = "outsider-1";
const RUN_ID = "run-1";
const NOW = Timestamp.now();
const GOVERNANCE_UPDATED_AT = "2026-08-01T00:00:00.000Z";
const MUTATE_NOW = "2026-08-10T00:00:00.000Z";

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  stores.workspaces.set(WS_ID, asPersisted({ schemaVersion: 1, id: WS_ID, type: "team", name: "Acme", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW, ...overrides }));
}

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const status = (overrides.status as string | undefined) ?? "active";
  stores.workspaceMemberships.set(
    id,
    asPersisted({
      schemaVersion: 1,
      id,
      workspaceId,
      uid,
      role,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      invitedByUserId: null,
      removedAt: status === "removed" ? NOW : null,
      removedByUserId: status === "removed" ? OWNER_UID : null,
      ...overrides,
    })
  );
}

function validGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return asPersisted({
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
    createdAt: GOVERNANCE_UPDATED_AT,
    updatedAt: GOVERNANCE_UPDATED_AT,
    ...overrides,
  });
}

function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(RUN_ID, asPersisted({ userId: CREATOR_UID, workspaceId: WS_ID, projectId: null, createdAt: NOW, governanceRecord: validGovernanceRecord(), ...overrides }));
}

function seedAssignment(overrides: Record<string, unknown> = {}) {
  stores.humanReviewAssignment.set(
    RUN_ID,
    asPersisted({
      schemaVersion: 1,
      teamId: null,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-07-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-07-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 1,
      workspaceId: WS_ID,
      projectId: null,
      dueAt: null,
      ...overrides,
    })
  );
}

function seedPanel(overrides: Record<string, unknown> = {}) {
  stores.humanReviewPanel.set(
    RUN_ID,
    asPersisted({
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: WS_ID,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: [OWNER_UID, ADMIN_UID],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      ...overrides,
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreateAdaptiveHumanReviewAssignmentHistory.mockResolvedValue({ status: "recorded" });
  mockedCreateAdaptiveHumanReviewHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptiveHumanReviewEvent.mockResolvedValue({ written: true });
  mockedWriteAdaptiveAdminAuditEvent.mockResolvedValue({ status: "recorded" });
  mockedRoleHasCapability.mockImplementation(actualCapabilities.roleHasCapability); // default: genuine role -> capability matrix; individual tests may override.
  resetStores();
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  firestoreUnavailableFlag.value = false;
  transactionShouldThrow.value = false;
  transactionAttemptCount.value = 0;
  concurrentMutationHook = null;
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(REVIEWER2_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
  seedMembership(CREATOR_UID, "member");
  seedRun();
});

// ============================================
// GET
// ============================================

describe("getWorkspaceReviewAssignment", () => {
  it("no assignment: ok, null, assignmentRevision 0", async () => {
    const result = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result).toEqual({ status: "ok", assignment: null, assignmentRevision: 0 });
  });

  it("existing assignment: ok, safe DTO, assignmentRevision matches", async () => {
    seedAssignment({ dueAt: "2026-09-01T00:00:00.000Z" });
    const result = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result).toEqual({
      status: "ok",
      assignment: { assignedReviewerUserId: REVIEWER_UID, revision: 1, assignedAt: "2026-07-01T00:00:00.000Z", assignedByUserId: OWNER_UID, updatedAt: "2026-07-01T00:00:00.000Z", dueAt: "2026-09-01T00:00:00.000Z" },
      assignmentRevision: 1,
    });
  });

  it("Phase 9B.7 CORE FIX: cleared assignment -> assignment null, but assignmentRevision exposes the persisted document's true nonzero revision", async () => {
    seedAssignment({ assignedReviewerUserId: null, revision: 2 });
    const result = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result).toEqual({ status: "ok", assignment: null, assignmentRevision: 2 });
  });

  it("persisted assignment document with malformed revision -> read_failed, never guesses 0", async () => {
    seedAssignment({ revision: "not-a-number" as unknown as number });
    const result = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result).toEqual({ status: "read_failed" });
  });

  it("run not found -> run_not_found", async () => {
    stores.runs.delete(RUN_ID);
    expect(await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID })).toEqual({ status: "run_not_found" });
  });

  it("wrong workspace -> run_not_found (concealed)", async () => {
    expect(await getWorkspaceReviewAssignment({ workspaceId: OTHER_WS_ID, runId: RUN_ID })).toEqual({ status: "run_not_found" });
  });
});

// ============================================
// PUT
// ============================================

function putCall(overrides: Partial<Parameters<typeof putWorkspaceReviewAssignment>[0]> = {}) {
  return putWorkspaceReviewAssignment({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: undefined, now: MUTATE_NOW, ...overrides });
}

describe("putWorkspaceReviewAssignment — infra/rollout", () => {
  it("Team Workspaces disabled -> denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await putCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("Firestore unavailable -> denied", async () => {
    firestoreUnavailableFlag.value = true;
    expect(await putCall()).toEqual({ ok: false, reason: "firestore_unavailable" });
  });
});

describe("putWorkspaceReviewAssignment — authorization", () => {
  it("Owner (reviews.manage): allowed to create an assignment for a Member", async () => {
    const result = await putCall({ uid: OWNER_UID, assignedReviewerUserId: MEMBER_UID, dueAt: null });
    expect(result.ok).toBe(true);
  });

  it("Admin (reviews.manage): allowed", async () => {
    const result = await putCall({ uid: ADMIN_UID, dueAt: null });
    expect(result.ok).toBe(true);
  });

  it("Member (no reviews.manage): denied", async () => {
    const result = await putCall({ uid: MEMBER_UID, dueAt: null });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("outsider (no membership): denied", async () => {
    const result = await putCall({ uid: OUTSIDER_UID, dueAt: null });
    expect(result).toEqual({ ok: false, reason: "membership_not_found" });
  });
});

describe("putWorkspaceReviewAssignment — explicit dual-capability requirement (Phase 9B.5.1-R1C)", () => {
  it("reviews.manage AND research.read both present (Admin): proceeds to normal mutation logic", async () => {
    const result = await putCall({ uid: ADMIN_UID, dueAt: null });
    expect(result.ok).toBe(true);
  });

  it("reviews.manage true but research.read false — a synthetic capability split the current role table cannot otherwise represent — denies, independent of reviews.manage: zero write, zero history", async () => {
    mockedRoleHasCapability.mockImplementation((role: string, capability: string) => {
      if (role === "admin" && capability === "research.read") return false; // synthetic: locks the invariant against a future role-table change, not today's coincidental overlap.
      return actualCapabilities.roleHasCapability(role, capability);
    });
    const result = await putCall({ uid: ADMIN_UID, dueAt: null });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(mockedCreateAdaptiveHumanReviewAssignmentHistory).not.toHaveBeenCalled();
    expect(stores.humanReviewAssignment.get(RUN_ID)).toBeUndefined();
  });
});

describe("putWorkspaceReviewAssignment — target eligibility", () => {
  it("Viewer target: denied", async () => {
    expect(await putCall({ assignedReviewerUserId: VIEWER_UID, dueAt: null })).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "insufficient_capability" } });
  });

  it("removed member target: denied", async () => {
    seedMembership(REVIEWER2_UID, "reviewer", WS_ID, { status: "removed" });
    expect(await putCall({ assignedReviewerUserId: REVIEWER2_UID, dueAt: null })).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "removed" } });
  });

  it("creator target (self-review): denied", async () => {
    expect(await putCall({ assignedReviewerUserId: CREATOR_UID, dueAt: null })).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } });
  });

  it("cross-Workspace member target: denied", async () => {
    stores.workspaceMemberships.delete(computeMembershipId(WS_ID, REVIEWER2_UID)); // remove the default WS_ID membership seeded in beforeEach
    seedMembership(REVIEWER2_UID, "reviewer", OTHER_WS_ID);
    expect(await putCall({ assignedReviewerUserId: REVIEWER2_UID, dueAt: null })).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "not_found" } });
  });

  it("Owner/Admin/Member/Reviewer target (not creator): all eligible", async () => {
    for (const uid of [OWNER_UID, ADMIN_UID, MEMBER_UID, REVIEWER_UID]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(ADMIN_UID, "admin");
      seedMembership(MEMBER_UID, "member");
      seedMembership(REVIEWER_UID, "reviewer");
      seedRun();
      const result = await putCall({ assignedReviewerUserId: uid, dueAt: null });
      expect(result.ok).toBe(true);
    }
  });
});

describe("putWorkspaceReviewAssignment — dueAt rules", () => {
  it("first assignment, dueAt omitted -> null", async () => {
    const result = await putCall({ dueAt: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBeNull();
  });

  it("first assignment, canonical dueAt -> stored", async () => {
    const result = await putCall({ dueAt: "2026-09-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("first assignment, invalid dueAt -> invalid_due_at", async () => {
    expect(await putCall({ dueAt: "2026-09-01" as any })).toEqual({ ok: false, reason: "invalid_due_at" });
  });

  it("same reviewer, dueAt omitted -> preserved", async () => {
    seedAssignment({ dueAt: "2026-09-15T00:00:00.000Z" });
    const result = await putCall({ expectedRevision: 1, dueAt: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBe("2026-09-15T00:00:00.000Z");
  });

  it("same reviewer, new canonical dueAt -> updated", async () => {
    seedAssignment({ dueAt: "2026-09-15T00:00:00.000Z" });
    const result = await putCall({ expectedRevision: 1, dueAt: "2026-10-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("same reviewer, dueAt null -> cleared", async () => {
    seedAssignment({ dueAt: "2026-09-15T00:00:00.000Z" });
    const result = await putCall({ expectedRevision: 1, dueAt: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBeNull();
  });

  it("same reviewer, revision increments and assignedAt is preserved", async () => {
    seedAssignment({ dueAt: null, assignedAt: "2026-07-01T00:00:00.000Z" });
    const result = await putCall({ expectedRevision: 1, dueAt: "2026-10-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.revision).toBe(2);
      expect(result.assignment.assignedAt).toBe("2026-07-01T00:00:00.000Z");
    }
  });

  it("reassignment (different reviewer), dueAt omitted -> 400-equivalent due_at_required_on_reassignment, old deadline never inherited", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID, dueAt: "2026-09-15T00:00:00.000Z" });
    const result = await putCall({ assignedReviewerUserId: REVIEWER2_UID, expectedRevision: 1, dueAt: undefined });
    expect(result).toEqual({ ok: false, reason: "due_at_required_on_reassignment" });
  });

  it("reassignment, dueAt null -> PASS, old deadline never inherited", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID, dueAt: "2026-09-15T00:00:00.000Z" });
    const result = await putCall({ assignedReviewerUserId: REVIEWER2_UID, expectedRevision: 1, dueAt: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBeNull();
  });

  it("reassignment, explicit canonical dueAt -> PASS", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID, dueAt: "2026-09-15T00:00:00.000Z" });
    const result = await putCall({ assignedReviewerUserId: REVIEWER2_UID, expectedRevision: 1, dueAt: "2026-11-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment.dueAt).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("putWorkspaceReviewAssignment — OCC", () => {
  it("stale revision -> 409-equivalent, no write", async () => {
    seedAssignment({ revision: 3 });
    const result = await putCall({ expectedRevision: 1, dueAt: null });
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
    expect(stores.humanReviewAssignment.get(RUN_ID)?.revision).toBe(3);
  });
});

describe("putWorkspaceReviewAssignment — active panel", () => {
  it("open panel: assignment create blocked", async () => {
    seedPanel({ status: "open" });
    expect(await putCall({ dueAt: null })).toEqual({ ok: false, reason: "active_panel" });
  });

  it("open panel: reassignment blocked", async () => {
    seedAssignment();
    seedPanel({ status: "open" });
    expect(await putCall({ assignedReviewerUserId: REVIEWER2_UID, expectedRevision: 1, dueAt: null })).toEqual({ ok: false, reason: "active_panel" });
  });

  it("open panel: dueAt update blocked", async () => {
    seedAssignment();
    seedPanel({ status: "open" });
    expect(await putCall({ expectedRevision: 1, dueAt: "2026-09-01T00:00:00.000Z" })).toEqual({ ok: false, reason: "active_panel" });
  });

  it("finalized panel: does NOT block (Phase 9B.3 single-reviewer re-entry path)", async () => {
    seedPanel({ status: "finalized", finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "changes_requested", finalDecisionId: "dec_abc", aggregationPolicyVersion: 1 });
    const result = await putCall({ dueAt: null });
    expect(result.ok).toBe(true);
  });

  it("cancelled panel: does NOT block", async () => {
    seedPanel({ status: "cancelled" });
    const result = await putCall({ dueAt: null });
    expect(result.ok).toBe(true);
  });

  it("no panel at all: does NOT block", async () => {
    const result = await putCall({ dueAt: null });
    expect(result.ok).toBe(true);
  });

  it("malformed panel: fails closed, panel_unreadable", async () => {
    stores.humanReviewPanel.set(RUN_ID, { schemaVersion: 1 } as any);
    expect(await putCall({ dueAt: null })).toEqual({ ok: false, reason: "panel_unreadable" });
  });

  it("panel opens concurrently, after this transaction's own panel read but before commit (Phase 9B.5.1-R1C): the mutation cannot commit around it — Firestore-style conflict forces a retry, and the retried attempt observes the panel as open", async () => {
    let hookFired = false;
    concurrentMutationHook = (ref) => {
      if (!hookFired && ref.__collection === "humanReviewPanel" && ref.__id === RUN_ID) {
        hookFired = true; // a separate, concurrent transaction committing exactly once — not this attempt's own re-reads on retry.
        seedPanel({ status: "open" });
      }
    };
    const result = await putCall({ dueAt: null });
    expect(result).toEqual({ ok: false, reason: "active_panel" });
    // Proves this was a genuine retry, not a lucky first read: the callback ran twice.
    expect(transactionAttemptCount.value).toBe(2);
    expect(mockedCreateAdaptiveHumanReviewAssignmentHistory).not.toHaveBeenCalled();
    expect(stores.humanReviewAssignment.get(RUN_ID)).toBeUndefined();
    expect(stores.humanReviewPanel.get(RUN_ID)?.status).toBe("open");
  });
});

describe("putWorkspaceReviewAssignment — history + read/write ordering", () => {
  it("successful creation writes exactly one assignment-history entry, post-commit", async () => {
    const result = await putCall({ dueAt: null });
    expect(result.ok).toBe(true);
    expect(mockedCreateAdaptiveHumanReviewAssignmentHistory).toHaveBeenCalledTimes(1);
    const [runId, entry] = mockedCreateAdaptiveHumanReviewAssignmentHistory.mock.calls[0];
    expect(runId).toBe(RUN_ID);
    expect(entry.eventType).toBe("assigned");
  });

  it("same-reviewer dueAt change writes a metadata_updated history entry, not assigned/reassigned", async () => {
    seedAssignment({ dueAt: null });
    await putCall({ expectedRevision: 1, dueAt: "2026-10-01T00:00:00.000Z" });
    const [, entry] = mockedCreateAdaptiveHumanReviewAssignmentHistory.mock.calls[0];
    expect(entry.eventType).toBe("metadata_updated");
  });

  it("all transaction reads complete before any write — proven by the hardened fake never throwing on a successful call", async () => {
    seedAssignment();
    const result = await putCall({ expectedRevision: 1, dueAt: "2026-09-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
  });
});

// ============================================
// DELETE
// ============================================

function deleteCall(overrides: Partial<Parameters<typeof deleteWorkspaceReviewAssignment>[0]> = {}) {
  return deleteWorkspaceReviewAssignment({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, expectedRevision: 1, now: MUTATE_NOW, ...overrides });
}

describe("deleteWorkspaceReviewAssignment", () => {
  it("valid manager + correct revision: PASS", async () => {
    seedAssignment();
    const result = await deleteCall();
    expect(result).toEqual({ ok: true });
    expect(stores.humanReviewAssignment.get(RUN_ID)?.assignedReviewerUserId).toBeNull();
  });

  it("Member without reviews.manage: DENY", async () => {
    seedAssignment();
    expect(await deleteCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Reviewer without reviews.manage: DENY", async () => {
    seedAssignment();
    expect(await deleteCall({ uid: REVIEWER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Viewer: DENY", async () => {
    seedAssignment();
    expect(await deleteCall({ uid: VIEWER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("reviews.manage true but research.read false — synthetic capability split (Phase 9B.5.1-R1C): denies, assignment and history unchanged", async () => {
    seedAssignment();
    const before = stores.humanReviewAssignment.get(RUN_ID);
    mockedRoleHasCapability.mockImplementation((role: string, capability: string) => {
      if (role === "admin" && capability === "research.read") return false;
      return actualCapabilities.roleHasCapability(role, capability);
    });
    const result = await deleteCall({ uid: ADMIN_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(mockedCreateAdaptiveHumanReviewAssignmentHistory).not.toHaveBeenCalled();
    expect(stores.humanReviewAssignment.get(RUN_ID)).toBe(before);
  });

  it("stale revision: 409-equivalent", async () => {
    seedAssignment({ revision: 5 });
    expect(await deleteCall({ expectedRevision: 1 })).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("history preserved (write attempted), governance review status untouched", async () => {
    seedAssignment();
    await deleteCall();
    expect(mockedCreateAdaptiveHumanReviewAssignmentHistory).toHaveBeenCalledTimes(1);
    expect((stores.runs.get(RUN_ID)!.governanceRecord as any).humanReview.status).toBe("unreviewed");
  });

  it("open panel blocks removal", async () => {
    seedAssignment();
    seedPanel({ status: "open" });
    expect(await deleteCall()).toEqual({ ok: false, reason: "active_panel" });
  });

  it("finalized panel does not block removal", async () => {
    seedAssignment();
    seedPanel({ status: "finalized", finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "changes_requested", finalDecisionId: "dec_abc", aggregationPolicyVersion: 1 });
    expect((await deleteCall()).ok).toBe(true);
  });
});

// ============================================
// Phase 9B.7 — cleared-assignment OCC read-model correction.
// The real domain workflow this phase fixes: assign -> clear -> read ->
// reassign. Before this phase, step 3's read model collapsed the cleared
// assignment to `assignment: null` with no way to recover the document's
// true (now-nonzero) revision, so step 4 could only ever guess
// expectedRevision: 0 and would deterministically fail with
// stale_revision forever. No mocks for the mutation/read chain itself —
// exercises the real in-memory transactional Firestore fake end-to-end.
// ============================================

describe("Phase 9B.7 — clear then reassign (the exact regression this phase fixes)", () => {
  it("assign -> clear -> read -> reassign using the returned assignmentRevision: SUCCESS", async () => {
    // 1. no assignment exists yet.
    expect(await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID })).toEqual({ status: "ok", assignment: null, assignmentRevision: 0 });

    // 2. assign reviewer A with expectedRevision=0.
    const assignResult = await putCall({ uid: OWNER_UID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: null });
    expect(assignResult.ok).toBe(true);
    if (!assignResult.ok) throw new Error("unreachable");
    expect(assignResult.assignment.revision).toBe(1);

    // 3. clear reviewer A using the current revision.
    const clearResult = await deleteCall({ expectedRevision: 1 });
    expect(clearResult).toEqual({ ok: true });
    // persisted assignment document remains, reviewer null, revision advanced.
    const persisted = stores.humanReviewAssignment.get(RUN_ID);
    expect(persisted?.assignedReviewerUserId).toBeNull();
    expect(persisted?.revision).toBe(2);

    // 4. read review model — THE CORE FIX: assignment is null, but
    // assignmentRevision exposes the true persisted revision.
    const readAfterClear = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
    expect(readAfterClear).toEqual({ status: "ok", assignment: null, assignmentRevision: 2 });
    if (readAfterClear.status !== "ok") throw new Error("unreachable");

    // 5. assign reviewer B using exactly the revision the read model returned.
    const reassignResult = await putCall({ uid: OWNER_UID, assignedReviewerUserId: REVIEWER2_UID, expectedRevision: readAfterClear.assignmentRevision, dueAt: null });
    expect(reassignResult.ok).toBe(true);
    if (!reassignResult.ok) throw new Error("unreachable");
    expect(reassignResult.assignment.assignedReviewerUserId).toBe(REVIEWER2_UID);
    expect(reassignResult.assignment.revision).toBe(3);
  });

  it("reassigning after a clear with a guessed expectedRevision: 0 still deterministically fails with stale_revision — proves mutation OCC enforcement is unchanged", async () => {
    await putCall({ uid: OWNER_UID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: null });
    await deleteCall({ expectedRevision: 1 });
    const guessedZero = await putCall({ uid: OWNER_UID, assignedReviewerUserId: REVIEWER2_UID, expectedRevision: 0, dueAt: null });
    expect(guessedZero).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("repeated assign/clear cycles: revision monotonically advances and the read model always exposes the exact current value", async () => {
    async function readRevision(): Promise<number> {
      const result = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
      if (result.status !== "ok") throw new Error("unreachable");
      return result.assignmentRevision;
    }

    // assign A (rev 0 -> 1)
    await putCall({ uid: OWNER_UID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: await readRevision(), dueAt: null });
    expect(await readRevision()).toBe(1);

    // clear (rev 1 -> 2)
    await deleteCall({ expectedRevision: await readRevision() });
    expect(await readRevision()).toBe(2);

    // assign B (rev 2 -> 3)
    await putCall({ uid: OWNER_UID, assignedReviewerUserId: REVIEWER2_UID, expectedRevision: await readRevision(), dueAt: null });
    expect(await readRevision()).toBe(3);

    // clear again (rev 3 -> 4)
    await deleteCall({ expectedRevision: await readRevision() });
    const final = await getWorkspaceReviewAssignment({ workspaceId: WS_ID, runId: RUN_ID });
    expect(final).toEqual({ status: "ok", assignment: null, assignmentRevision: 4 });
  });
});

// ============================================
// POST decision
// ============================================

function decisionCall(overrides: Partial<Parameters<typeof submitWorkspaceReviewDecision>[0]> = {}) {
  return submitWorkspaceReviewDecision({ uid: REVIEWER_UID, workspaceId: WS_ID, runId: RUN_ID, update: { status: "approved" }, expectedUpdatedAt: GOVERNANCE_UPDATED_AT, now: MUTATE_NOW, ...overrides });
}

describe("submitWorkspaceReviewDecision — authorization", () => {
  it("assigned current Reviewer: ALLOW", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall();
    expect(result.ok).toBe(true);
  });

  it("assigned current Owner (not creator): ALLOW", async () => {
    seedAssignment({ assignedReviewerUserId: OWNER_UID });
    const result = await decisionCall({ uid: OWNER_UID });
    expect(result.ok).toBe(true);
  });

  it("assigned current Admin: ALLOW", async () => {
    seedAssignment({ assignedReviewerUserId: ADMIN_UID });
    const result = await decisionCall({ uid: ADMIN_UID });
    expect(result.ok).toBe(true);
  });

  it("assigned current Member: ALLOW", async () => {
    seedAssignment({ assignedReviewerUserId: MEMBER_UID });
    const result = await decisionCall({ uid: MEMBER_UID });
    expect(result.ok).toBe(true);
  });

  it("unassigned run, otherwise reviews.submit-capable caller: DENY (stricter than legacy — canonical assignment required)", async () => {
    const result = await decisionCall({ uid: REVIEWER_UID });
    expect(result).toEqual({ ok: false, reason: { kind: "not_authorized", reason: "not_assigned" } });
  });

  it("removed assigned reviewer: DENY (assignment cannot resurrect capability)", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    seedMembership(REVIEWER_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await decisionCall();
    expect(result.ok).toBe(false);
  });

  it("Viewer-downgraded assigned reviewer: DENY", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    seedMembership(REVIEWER_UID, "viewer");
    const result = await decisionCall();
    expect(result.ok).toBe(false);
  });

  it("creator self-assigned (self-review, even if corrupted assignment names them): DENY", async () => {
    seedAssignment({ assignedReviewerUserId: CREATOR_UID });
    const result = await decisionCall({ uid: CREATOR_UID });
    expect(result).toEqual({ ok: false, reason: { kind: "not_authorized", reason: "self_review" } });
  });

  it("wrong Workspace: concealed denial", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall({ workspaceId: OTHER_WS_ID });
    expect(result.ok).toBe(false);
  });
});

describe("submitWorkspaceReviewDecision — backend receipt-usability invariant (10C.4A-U2B, canonical governance-state integrity, independent of the UI safeguard)", () => {
  it("empty conclusion: DENIED before any canonical decision write, even for an otherwise fully-authorized caller", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall();
    expect(result).toEqual({ ok: false, reason: "review_content_unavailable" });
    // No side effect: canonical humanReview state is untouched.
    const runData = stores.runs.get(RUN_ID) as Record<string, any>;
    expect(runData.governanceRecord.humanReview.status).toBe("unreviewed");
    expect(runData.governanceRecord.updatedAt).toBe(GOVERNANCE_UPDATED_AT);
  });

  it("whitespace-only conclusion: DENIED, identical to empty", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "   \n\t ", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect(await decisionCall()).toEqual({ ok: false, reason: "review_content_unavailable" });
  });

  it("meaningful conclusion with every supporting array empty: ALLOWED — the frozen contract requires only a non-empty conclusion, never supporting content", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "The panel did not converge on enough shared subjects for a comparison.", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("receipt-usability is checked AFTER authorization — an unauthorized (unassigned) caller still receives the existing authorization denial, never a receipt-state oracle", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    // No seedAssignment() — REVIEWER_UID is not assigned to this run.
    const result = await decisionCall({ uid: REVIEWER_UID });
    expect(result).toEqual({ ok: false, reason: { kind: "not_authorized", reason: "not_assigned" } });
  });

  it("receipt-usability is checked AFTER OCC — a stale expectedUpdatedAt still receives the existing OCC denial first", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall({ expectedUpdatedAt: "stale-token" });
    expect(result).toEqual({ ok: false, reason: "stale_expected_updated_at" });
  });
});

describe("submitWorkspaceReviewDecision — status", () => {
  it("unreviewed: ALLOW", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("pending: ALLOW", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "pending" } }) });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"])("terminal status %s: DENY (not_reviewable)", async (status) => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status, reviewedAt: GOVERNANCE_UPDATED_AT } }) });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect(await decisionCall()).toEqual({ ok: false, reason: "not_reviewable" });
  });
});

describe("submitWorkspaceReviewDecision — active panel", () => {
  it("open panel + otherwise-valid assignment: DENY", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    seedPanel({ status: "open" });
    expect(await decisionCall()).toEqual({ ok: false, reason: "active_panel" });
  });

  it("finalized panel + unreviewed state + valid assignment: ALLOW (Phase 9B.3 fallback path)", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    seedPanel({ status: "finalized", finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "changes_requested", finalDecisionId: "dec_abc", aggregationPolicyVersion: 1 });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("cancelled panel + valid assignment: ALLOW", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    seedPanel({ status: "cancelled" });
    expect((await decisionCall()).ok).toBe(true);
  });
});

describe("submitWorkspaceReviewDecision — OCC", () => {
  it("correct expectedUpdatedAt: PASS", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("stale expectedUpdatedAt: 409-equivalent, no write", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall({ expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: false, reason: "stale_expected_updated_at" });
    expect((stores.runs.get(RUN_ID)!.governanceRecord as any).humanReview.status).toBe("unreviewed");
  });

  it("retry after success using the OLD token is denied — no duplicate history/audit writes", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const first = await decisionCall();
    expect(first.ok).toBe(true);
    expect(mockedCreateAdaptiveHumanReviewHistory).toHaveBeenCalledTimes(1);

    const retry = await decisionCall({ expectedUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(retry).toEqual({ ok: false, reason: "stale_expected_updated_at" });
    expect(mockedCreateAdaptiveHumanReviewHistory).toHaveBeenCalledTimes(1); // still exactly one
  });
});

describe("submitWorkspaceReviewDecision — history/audit composition", () => {
  it("terminal decision writes governance event + history + audit, all reused unmodified", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall({ update: { status: "approved" } });
    expect(result.ok).toBe(true);
    expect(mockedWriteAdaptiveHumanReviewEvent).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, teamId: null, prevStatus: "unreviewed", nextStatus: "approved" }));
    expect(mockedCreateAdaptiveHumanReviewHistory).toHaveBeenCalledTimes(1);
    expect(mockedWriteAdaptiveAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ actorUid: REVIEWER_UID, teamId: null, runId: RUN_ID, newStatus: "approved" }));
  });
});

// ============================================
// Phase 10B.3.2B.1 — Workspace-canary target admission.
// The rollout gate (resolveTeamWorkspaceTargetAdmission) is admission ONLY —
// every test below proves membership/capability/canonical-binding/self-review
// checks are byte-identical and independent of which admission source (global,
// uid-canary, Workspace-canary) let the caller through.
// ============================================

describe("putWorkspaceReviewAssignment — Workspace-canary target admission (Phase 10B.3.2B.1)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    expect((await putCall({ dueAt: null })).ok).toBe(true);
  });

  it("Workspace-canary only (global/uid off), active manager: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect((await putCall({ dueAt: null })).ok).toBe(true);
  });

  it("Workspace-canary only, Member (no reviews.manage): denied at the CAPABILITY check, not admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect(await putCall({ uid: MEMBER_UID, dueAt: null })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, no membership: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect(await putCall({ uid: OUTSIDER_UID, dueAt: null })).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("Workspace-canary only, caller's membership removed: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(OWNER_UID, "owner", WS_ID, { status: "removed" });
    expect((await putCall({ dueAt: null })).ok).toBe(false);
  });

  it("target Workspace not admitted (not global/uid/workspace-canary): denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    const result = await putCall({ dueAt: null });
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    expect((await putCall({ dueAt: null })).ok).toBe(true);
  });

  it("malformed Workspace-canary list fails closed (global/uid off)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "*";
    expect(await putCall({ dueAt: null })).toEqual({ ok: false, reason: "team_workspaces_disabled" });
  });

  it("MANDATORY reviewer-membership cross-Workspace: caller genuinely admitted+manager in WS_ID, but the target reviewer is only a member of OTHER_WS_ID -> denied target_not_eligible, never assignable across Workspaces merely because the caller is admitted", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    stores.workspaceMemberships.delete(computeMembershipId(WS_ID, REVIEWER2_UID));
    seedMembership(REVIEWER2_UID, "reviewer", OTHER_WS_ID);
    expect(await putCall({ assignedReviewerUserId: REVIEWER2_UID, dueAt: null })).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "not_found" } });
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+manager in WS_ID, but the target RUN canonically belongs to OTHER_WS_ID -> denied run_not_found, canonical binding is never bypassable by admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    const result = await putCall({ workspaceId: WS_ID, dueAt: null });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("deleteWorkspaceReviewAssignment — Workspace-canary target admission (Phase 10B.3.2B.1)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    seedAssignment();
    expect((await deleteCall()).ok).toBe(true);
  });

  it("Workspace-canary only, active manager: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedAssignment();
    expect((await deleteCall()).ok).toBe(true);
  });

  it("Workspace-canary only, Member (no reviews.manage): denied at capability check, not admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedAssignment();
    expect(await deleteCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, no membership: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedAssignment();
    expect(await deleteCall({ uid: OUTSIDER_UID })).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    seedAssignment();
    const result = await deleteCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    seedAssignment();
    expect((await deleteCall()).ok).toBe(true);
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+manager in WS_ID, but the target RUN canonically belongs to OTHER_WS_ID -> denied run_not_found", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    seedAssignment({ workspaceId: OTHER_WS_ID });
    const result = await deleteCall({ workspaceId: WS_ID });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("submitWorkspaceReviewDecision — Workspace-canary target admission (Phase 10B.3.2B.1)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = REVIEWER_UID;
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("Workspace-canary only, assigned Reviewer: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("Workspace-canary only, Viewer (no reviews.submit): denied at capability check, not admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedAssignment({ assignedReviewerUserId: VIEWER_UID });
    const result = await decisionCall({ uid: VIEWER_UID });
    expect(result.ok).toBe(false);
  });

  it("Workspace-canary only, no membership: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await decisionCall({ uid: OUTSIDER_UID });
    expect(result.ok).toBe(false);
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = REVIEWER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    expect((await decisionCall()).ok).toBe(true);
  });

  it("MANDATORY self-review regression: Workspace-canary-only Owner who is ALSO the artifact's canonical creator -> DENIED as self-review; Workspace admission never turns Owner into an ordinary self-reviewer (Owner Override is a separate Phase 9 panel mechanism, untouched here)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ userId: OWNER_UID });
    seedAssignment({ assignedReviewerUserId: OWNER_UID });
    const result = await decisionCall({ uid: OWNER_UID });
    expect(result).toEqual({ ok: false, reason: { kind: "not_authorized", reason: "self_review" } });
  });

  it("MANDATORY wrong-reviewer regression under Workspace-canary: an active, reviews.submit-capable Workspace-canary-admitted Member who is NOT the canonical assigned reviewer -> DENIED not_assigned, assignment identity is not weakened to capability-only", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await decisionCall({ uid: MEMBER_UID });
    expect(result).toEqual({ ok: false, reason: { kind: "not_authorized", reason: "not_assigned" } });
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+assigned-reviewer in WS_ID, but the target RUN canonically belongs to OTHER_WS_ID -> denied run_not_found, not merely OTHER_WS_ID-non-admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID, workspaceId: OTHER_WS_ID });
    const result = await decisionCall({ workspaceId: WS_ID });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});
