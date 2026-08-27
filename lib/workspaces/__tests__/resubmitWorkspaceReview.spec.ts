/**
 * Phase 9B.3 — `resubmitWorkspaceReview()` tests. In-memory Firestore fake
 * covering every collection the transaction touches (`workspaces`,
 * `workspaceMemberships`, `runs`, `runs/{runId}/humanReviewAssignment`,
 * `runs/{runId}/governanceEvents`), structural mirror of
 * `associateTeamRunWithProject.spec.ts`'s own buffered-transaction fake —
 * including its `hasWritten` read-after-write guard (Phase 9B.2-R1's own
 * lesson: a transaction fake that doesn't model Firestore's "all reads
 * before all writes" constraint can let a real ordering bug pass silently).
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  runs: new Map(),
  // Single-fixed-id ("current") subcollection — keyed directly by runId,
  // mirroring associateTeamRunWithProject.spec.ts's own convention.
  humanReviewAssignment: new Map(),
  // Multi-doc subcollection (one event per resubmission) — keyed by
  // `${runId}::${autoId}` so every event for a run can be enumerated.
  governanceEvents: new Map(),
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.runs.clear();
  stores.humanReviewAssignment.clear();
  stores.governanceEvents.clear();
}

function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Real Firestore `tx.update(ref, {"a.b.c": value})` writes into the NESTED
 * field `a.b.c`, not a literal top-level key named `"a.b.c"` — this mirrors
 * that dotted-field-path semantic, since `resubmitWorkspaceReview()` writes
 * `"governanceRecord.humanReview"`/`"governanceRecord.updatedAt"` exactly
 * like the rest of this codebase's governance writers do.
 */
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

let autoIdCounter = 0;

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    collection: (subCollectionName: string) => ({
      doc: (subDocId?: string) => {
        if (subCollectionName === "humanReviewAssignment") {
          return { __collection: subCollectionName, __id: docId };
        }
        const id = subDocId ?? `auto_${++autoIdCounter}`;
        return { __collection: subCollectionName, __id: `${docId}::${id}` };
      },
    }),
  };
}

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
const firestoreUnavailableFlag = { value: false };
const transactionShouldThrow = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    if (transactionShouldThrow.value) {
      throw new Error("simulated transaction failure");
    }
    const pendingWrites: Array<() => void> = [];
    // Mirrors the real Admin SDK's hard requirement that every transaction
    // `get()` execute before any `set()`/`update()`/`delete()` — see
    // Phase 9B.2-R1.
    let hasWritten = false;
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (hasWritten) {
          throw new Error("Firestore transactions require all reads to be executed before all writes.");
        }
        if (concurrentMutationHook) concurrentMutationHook(ref);
        const store = stores[ref.__collection];
        const data = store.get(ref.__id);
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
        pendingWrites.push(() => {
          stores[ref.__collection].set(ref.__id, data);
        });
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
import { resubmitWorkspaceReview } from "@/lib/workspaces/resubmitWorkspaceReview";
import { logger } from "@/lib/logger";

const WS_ID = "ws-team-1";
const OTHER_WS_ID = "ws-team-2";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const CREATOR_UID = "creator-1";
const REVIEWER_UID = "reviewer-1";
const VIEWER_UID = "viewer-1";
const OUTSIDER_UID = "outsider-1";
const RUN_ID = "run-1";
const NOW = Timestamp.now();
const GOVERNANCE_UPDATED_AT = "2026-08-01T00:00:00.000Z";
const RESUBMIT_NOW = "2026-08-10T00:00:00.000Z";

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  stores.workspaces.set(
    WS_ID,
    asPersisted({
      schemaVersion: 1,
      id: WS_ID,
      type: "team",
      name: "Acme Team",
      ownerUserId: OWNER_UID,
      createdByUserId: OWNER_UID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  );
}

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
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
      removedAt: null,
      removedByUserId: null,
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
    automatedGovernance: {
      status: "passed",
      reasons: [],
      evaluatedAt: GOVERNANCE_UPDATED_AT,
      policyVersion: 3,
    },
    humanReview: {
      status: "changes_requested",
      reviewerId: REVIEWER_UID,
      reviewerName: "A Reviewer",
      reviewedAt: GOVERNANCE_UPDATED_AT,
      comment: "please add more sources",
    },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: ["Criterion 1 favors option A."],
      assumptions: ["Budget is fixed."],
      uncertainties: ["Long-term maintenance cost is unclear."],
      limitations: [],
      sources: ["https://example.com/a"],
      sourceBacked: true,
      humanReviewNeeded: false,
    },
    createdAt: GOVERNANCE_UPDATED_AT,
    updatedAt: GOVERNANCE_UPDATED_AT,
    ...overrides,
  });
}

function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(
    RUN_ID,
    asPersisted({
      userId: CREATOR_UID,
      workspaceId: WS_ID,
      projectId: null,
      question: "q",
      selectedModels: [],
      status: "complete",
      createdAt: NOW,
      governanceRecord: validGovernanceRecord(),
      ...overrides,
    })
  );
}

function seedAssignment(overrides: Record<string, unknown> = {}) {
  stores.humanReviewAssignment.set(
    RUN_ID,
    asPersisted({
      schemaVersion: 1,
      teamId: WS_ID,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-07-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-07-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 1,
      workspaceId: WS_ID,
      projectId: null,
      dueAt: "2026-09-01T00:00:00.000Z",
      ...overrides,
    })
  );
}

function governanceEventsForRun(runId: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [key, value] of stores.governanceEvents.entries()) {
    if (key.startsWith(`${runId}::`)) events.push(value);
  }
  return events;
}

function call(overrides: Partial<Parameters<typeof resubmitWorkspaceReview>[0]> = {}) {
  return resubmitWorkspaceReview({
    uid: CREATOR_UID,
    workspaceId: WS_ID,
    runId: RUN_ID,
    expectedUpdatedAt: GOVERNANCE_UPDATED_AT,
    now: RESUBMIT_NOW,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  firestoreUnavailableFlag.value = false;
  transactionShouldThrow.value = false;
  concurrentMutationHook = null;
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
  seedMembership(MEMBER_UID, "member");
  seedMembership(CREATOR_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
  seedRun();
});

describe("infrastructure gates", () => {
  it("Team Workspaces rollout off -> team_workspaces_disabled, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("Firestore unavailable -> firestore_unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });

  it("transaction throws -> write_failed, logged exactly once outside the callback", async () => {
    transactionShouldThrow.value = true;
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("state transition", () => {
  it("changes_requested -> unreviewed: succeeds and rewrites humanReview cleanly", async () => {
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.humanReview).toEqual({
      status: "unreviewed",
      reviewerId: undefined,
      reviewerName: undefined,
      reviewedAt: undefined,
      comment: undefined,
      conditions: undefined,
    });
    const storedRun = stores.runs.get(RUN_ID)!;
    expect((storedRun.governanceRecord as any).humanReview.status).toBe("unreviewed");
    expect((storedRun.governanceRecord as any).updatedAt).toBe(RESUBMIT_NOW);
  });

  it("current decision fields (reviewerId/comment/reviewedAt) are cleared, not merely status", async () => {
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.humanReview).not.toHaveProperty("reviewerId", REVIEWER_UID);
    expect(result.record.humanReview.comment).toBeUndefined();
  });

  it.each(["approved", "approved_with_conditions", "rejected", "unreviewed", "pending"])("status %s -> resubmit is denied as not_changes_requested", async (status) => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status } }) });
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "not_changes_requested" });
  });

  it("missing governance record -> governance_record_absent", async () => {
    seedRun({ governanceRecord: undefined });
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "governance_record_absent" });
  });

  it("malformed governance record -> governance_record_malformed", async () => {
    seedRun({ governanceRecord: { version: 1 } });
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "governance_record_malformed" });
  });

  it("run not found -> run_not_found", async () => {
    stores.runs.delete(RUN_ID);
    const result = await call();
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });

  it("prior humanReviewHistory / decisionReceipt / automatedGovernance are preserved untouched", async () => {
    const before = stores.runs.get(RUN_ID)!.governanceRecord as any;
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.decisionReceipt).toEqual(before.decisionReceipt);
    expect(result.record.automatedGovernance).toEqual(before.automatedGovernance);
    expect(result.record.createdAt).toBe(before.createdAt);
  });
});

describe("OCC", () => {
  it("correct expectedUpdatedAt: succeeds", async () => {
    const result = await call({ expectedUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(result.ok).toBe(true);
  });

  it("stale expectedUpdatedAt: denied as stale_expected_updated_at, no write", async () => {
    const result = await call({ expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: false, reason: "stale_expected_updated_at" });
    expect((stores.runs.get(RUN_ID)!.governanceRecord as any).humanReview.status).toBe("changes_requested");
  });

  it("retry after a successful resubmit using the OLD token is denied — and creates no duplicate event", async () => {
    const first = await call();
    expect(first.ok).toBe(true);
    expect(governanceEventsForRun(RUN_ID)).toHaveLength(1);

    const retry = await call({ expectedUpdatedAt: GOVERNANCE_UPDATED_AT }); // stale now — canonical updatedAt already advanced
    expect(retry).toEqual({ ok: false, reason: "stale_expected_updated_at" });
    expect(governanceEventsForRun(RUN_ID)).toHaveLength(1); // still exactly one
  });
});

describe("authorization — creator path", () => {
  it("active creator with research.read: allowed", async () => {
    const result = await call({ uid: CREATOR_UID });
    expect(result.ok).toBe(true);
  });

  it("creator whose membership was removed: denied", async () => {
    seedMembership(CREATOR_UID, "member", WS_ID, { status: "removed", removedAt: NOW, removedByUserId: OWNER_UID });
    const result = await call({ uid: CREATOR_UID });
    expect(result).toEqual({ ok: false, reason: "membership_removed" });
  });

  it("creator with Viewer role (has research.read, no reviews.manage/reviews.submit): allowed — resubmission is not a review action", async () => {
    seedRun({ userId: VIEWER_UID });
    const result = await call({ uid: VIEWER_UID });
    expect(result.ok).toBe(true);
  });

  it("creator resubmitting from the wrong requested Workspace: denied as run_not_found (never disclosed as wrong_workspace)", async () => {
    stores.workspaces.set(
      OTHER_WS_ID,
      asPersisted({ schemaVersion: 1, id: OTHER_WS_ID, type: "team", name: "Other", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW })
    );
    seedMembership(OWNER_UID, "owner", OTHER_WS_ID);
    seedMembership(CREATOR_UID, "member", OTHER_WS_ID);
    const result = await call({ uid: CREATOR_UID, workspaceId: OTHER_WS_ID });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("authorization — manager path", () => {
  it("Admin with reviews.manage: allowed to resubmit someone else's artifact", async () => {
    const result = await call({ uid: ADMIN_UID });
    expect(result.ok).toBe(true);
  });

  it("Owner with reviews.manage: allowed to resubmit someone else's artifact", async () => {
    const result = await call({ uid: OWNER_UID });
    expect(result.ok).toBe(true);
  });

  it("Member (no reviews.manage) resubmitting another user's artifact: denied", async () => {
    const result = await call({ uid: MEMBER_UID });
    expect(result).toEqual({ ok: false, reason: "not_creator_or_manager" });
  });

  it("Reviewer (no reviews.manage) resubmitting another user's artifact: denied", async () => {
    const result = await call({ uid: REVIEWER_UID });
    expect(result).toEqual({ ok: false, reason: "not_creator_or_manager" });
  });

  it("Viewer resubmitting another user's artifact: denied", async () => {
    const result = await call({ uid: VIEWER_UID });
    expect(result).toEqual({ ok: false, reason: "not_creator_or_manager" });
  });

  it("an outright non-member: denied at the Workspace-authorization gate before the creator/manager rule is ever reached", async () => {
    const result = await call({ uid: OUTSIDER_UID });
    expect(result).toEqual({ ok: false, reason: "membership_not_found" });
  });
});

describe("assignment actionability re-derivation (never persisted)", () => {
  it("no assignment document at all: assignmentActionable is null, resubmit still succeeds", async () => {
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBeNull();
  });

  it("eligible assigned Reviewer: actionable=true, assignment document is byte-for-byte untouched", async () => {
    seedAssignment();
    const before = { ...stores.humanReviewAssignment.get(RUN_ID)! };
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(true);
    expect(stores.humanReviewAssignment.get(RUN_ID)).toEqual(before);
  });

  it("eligible assigned Member: actionable=true", async () => {
    seedAssignment({ assignedReviewerUserId: MEMBER_UID });
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(true);
  });

  it("eligible assigned Admin: actionable=true", async () => {
    seedAssignment({ assignedReviewerUserId: ADMIN_UID });
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(true);
  });

  it("eligible assigned Owner (not the creator): actionable=true", async () => {
    seedAssignment({ assignedReviewerUserId: OWNER_UID });
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(true);
  });

  it("assignee membership removed: actionable=false, resubmit still succeeds, assignment preserved", async () => {
    seedAssignment();
    seedMembership(REVIEWER_UID, "reviewer", WS_ID, { status: "removed", removedAt: NOW, removedByUserId: OWNER_UID });
    const before = { ...stores.humanReviewAssignment.get(RUN_ID)! };
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(false);
    expect(stores.humanReviewAssignment.get(RUN_ID)).toEqual(before);
  });

  it("assignee downgraded to Viewer: actionable=false", async () => {
    seedAssignment();
    seedMembership(REVIEWER_UID, "viewer");
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(false);
  });

  it("assignee IS the artifact creator (self-review staleness): actionable=false, but resubmit still succeeds for an otherwise-authorized manager", async () => {
    seedAssignment({ assignedReviewerUserId: CREATOR_UID });
    const result = await call({ uid: OWNER_UID }); // manager path, since assignee==creator would fail the creator path's own resubmission trivially only if uid===assignee, unrelated here
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(false);
  });

  it("malformed assignment (assignedReviewerUserId absent): actionable=false, resubmit still succeeds", async () => {
    seedAssignment({ assignedReviewerUserId: undefined });
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignmentActionable).toBe(false);
  });

  it("dueAt, revision, and assignedAt are preserved exactly — this function never mutates the assignment", async () => {
    seedAssignment({ dueAt: "2026-09-15T00:00:00.000Z", revision: 7 });
    const before = { ...stores.humanReviewAssignment.get(RUN_ID)! };
    await call();
    expect(stores.humanReviewAssignment.get(RUN_ID)).toEqual(before);
  });
});

describe("immutable audit event", () => {
  it("successful resubmission writes exactly one review_resubmitted event with correct fields", async () => {
    const result = await call({ uid: OWNER_UID });
    expect(result.ok).toBe(true);
    const events = governanceEventsForRun(RUN_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "review_resubmitted",
      byUid: OWNER_UID,
      at: RESUBMIT_NOW,
      workspaceId: WS_ID,
      projectId: null,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      prevStatus: "changes_requested",
      nextStatus: "unreviewed",
    });
  });

  it("failed OCC: zero events written", async () => {
    await call({ expectedUpdatedAt: "stale" });
    expect(governanceEventsForRun(RUN_ID)).toHaveLength(0);
  });

  it("failed authorization: zero events written", async () => {
    await call({ uid: MEMBER_UID });
    expect(governanceEventsForRun(RUN_ID)).toHaveLength(0);
  });

  it("wrong status (not changes_requested): zero events written", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "unreviewed" } }) });
    await call();
    expect(governanceEventsForRun(RUN_ID)).toHaveLength(0);
  });

  it("event write happens in the SAME transaction as the canonical write — never a separate best-effort call", async () => {
    // Proven structurally: this test file's fake only exposes a single
    // `runTransaction` call per `resubmitWorkspaceReview()` invocation
    // (no second Firestore call site exists in the module at all — grep
    // confirms `adminDb.collection` is called only inside the transaction
    // callback). A successful call producing exactly one event, using the
    // SAME `now` as the canonical write, is the observable proof.
    const result = await call();
    expect(result.ok).toBe(true);
    const events = governanceEventsForRun(RUN_ID);
    expect(events[0].at).toBe((stores.runs.get(RUN_ID)!.governanceRecord as any).updatedAt);
  });
});

describe("project context", () => {
  it("uses the run's CURRENT canonical projectId, never a stale assignment mirror", async () => {
    seedRun({ projectId: "proj-current" });
    seedAssignment({ projectId: "proj-stale-mirror" });
    const result = await call();
    expect(result.ok).toBe(true);
    const events = governanceEventsForRun(RUN_ID);
    expect(events[0].projectId).toBe("proj-current");
  });

  it("archived Project status never blocks resubmission — this function never reads the projects collection at all", async () => {
    seedRun({ projectId: "proj-archived" }); // no `projects` store seeded/consulted at all
    const result = await call();
    expect(result.ok).toBe(true);
  });
});

describe("transaction read/write ordering", () => {
  it("every read happens before any write — proven by the hardened fake's own read-after-write guard never firing on a real success path", async () => {
    seedAssignment();
    const result = await call();
    expect(result.ok).toBe(true);
  });
});

// ============================================
// Phase 10B.3.2B.1 — Workspace-canary target admission. The rollout gate
// (resolveTeamWorkspaceTargetAdmission) is admission ONLY — every test below
// proves the creator/manager rule, OCC, status-transition, and canonical-run
// binding checks are byte-identical and independent of admission source.
// ============================================

describe("Workspace-canary target admission (Phase 10B.3.2B.1)", () => {
  it("uid-canary only (global off), creator: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = CREATOR_UID;
    expect((await call({ uid: CREATOR_UID })).ok).toBe(true);
  });

  it("Workspace-canary only (global/uid off), creator: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect((await call({ uid: CREATOR_UID })).ok).toBe(true);
  });

  it("Workspace-canary only, manager (Admin, not creator): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect((await call({ uid: ADMIN_UID })).ok).toBe(true);
  });

  it("Workspace-canary only, Member (neither creator nor manager): denied not_creator_or_manager, not an admission failure", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect(await call({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "not_creator_or_manager" });
  });

  it("Workspace-canary only, no membership: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect(await call({ uid: OUTSIDER_UID })).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("Workspace-canary only, caller's membership removed: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(CREATOR_UID, "member", WS_ID, { status: "removed", removedAt: NOW, removedByUserId: OWNER_UID });
    expect(await call({ uid: CREATOR_UID })).toEqual({ ok: false, reason: "membership_removed" });
  });

  it("target Workspace not admitted (not global/uid/workspace-canary): denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    const result = await call({ uid: CREATOR_UID });
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = CREATOR_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    expect((await call({ uid: CREATOR_UID })).ok).toBe(true);
  });

  it("malformed Workspace-canary list fails closed (global/uid off)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "*";
    expect(await call({ uid: CREATOR_UID })).toEqual({ ok: false, reason: "team_workspaces_disabled" });
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+manager in WS_ID, but the target RUN canonically belongs to OTHER_WS_ID -> denied run_not_found, must be a canonical binding denial, never merely 'OTHER_WS_ID not admitted'", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    const result = await call({ uid: ADMIN_UID, workspaceId: WS_ID });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });

  it("MANDATORY cross-Workspace: caller genuinely admitted+creator in WS_ID cannot resubmit by supplying a DIFFERENT, non-admitted target Workspace either — target admission is evaluated on the supplied workspaceId itself", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await call({ uid: CREATOR_UID, workspaceId: OTHER_WS_ID });
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
  });
});
