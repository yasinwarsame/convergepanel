/**
 * Approval Workflow, Phase 9B.5.2 — workspaceReviewPanelMutations.ts tests.
 * In-memory Firestore transaction fake mirroring workspaceReviewMutations.spec.ts's
 * own hardened, read-after-write-guarded, retry-capable fake exactly (Phase
 * 9B.5.1-R1C's concurrency-hook precedent), extended with humanReviewVotes.
 * The panel-specific best-effort post-commit writers (finalization/override
 * history, governance events, admin audit) are MOCKED here — this suite
 * verifies they are CALLED correctly, not that their own internals work.
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  runs: new Map(),
  humanReviewAssignment: new Map(),
  humanReviewPanel: new Map(),
  humanReviewVotes: new Map(), // keyed by `${runId}::${voteId}` since votes are per-run-per-revision-per-reviewer
  // Phase 9C.5 — added ONLY so the durable cross-workflow journey tests
  // below can exercise the real `resubmitWorkspaceReview()` (which writes an
  // auto-ID `governanceEvents` doc INSIDE its transaction, atomically with
  // the canonical update — see that module's own doc comment). Keyed by
  // `${runId}::${autoId}`, same convention as the other per-run subcollections.
  governanceEvents: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
  autoIdCounter = 0;
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

// `humanReviewVotes`/`governanceEvents` are keyed globally by parentDocId (runId) + subdoc id — mirror via composite key.
function subKey(collection: string, parentId: string, subId: string): string {
  return collection === "humanReviewVotes" || collection === "humanReviewAssignment" || collection === "humanReviewPanel" || collection === "governanceEvents" ? `${parentId}::${subId}` : subId;
}

let autoIdCounter = 0;

function makeSubDocRef(subCollectionName: string, parentDocId: string, subDocId: string) {
  const key = subKey(subCollectionName, parentDocId, subDocId);
  return {
    __collection: subCollectionName,
    __id: key,
    get: async () => {
      const data = stores[subCollectionName].get(key);
      return { exists: data !== undefined, data: () => data, id: subDocId };
    },
  };
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    collection: (subCollectionName: string) => ({
      // Phase 9C.5 — `.doc()` with no argument mirrors real Firestore's
      // auto-ID generation, needed by `resubmitWorkspaceReview()`'s
      // `runRef.collection("governanceEvents").doc()` call.
      doc: (subDocId?: string) => makeSubDocRef(subCollectionName, docId, subDocId ?? `auto-${++autoIdCounter}`),
    }),
    get: async () => {
      const data = stores[collectionName].get(docId);
      return { exists: data !== undefined, data: () => data, id: docId };
    },
  };
}

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

const mockedCreateAdaptiveHumanReviewHistory = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedCreateAdaptivePanelFinalizationHistory = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedCreateAdaptivePanelOverrideHistory = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedWriteAdaptivePanelFinalizationGovernanceEvent = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedWriteAdaptivePanelOverrideGovernanceEvent = jest.fn().mockResolvedValue({ status: "recorded" });
// The cross-service mutual-exclusion tests below also call
// `putWorkspaceReviewAssignment` (Phase 9B.5.1) directly, which imports its
// OWN best-effort writers from this same module — mocked here as harmless
// no-ops purely so that import resolves; their own behavior is already
// exhaustively covered by workspaceReviewMutations.spec.ts.
const mockedCreateAdaptiveHumanReviewAssignmentHistory = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedWriteAdaptiveHumanReviewEvent = jest.fn().mockResolvedValue({ written: true });
jest.mock("@/lib/firestore/runs", () => ({
  createAdaptiveHumanReviewHistory: (...args: unknown[]) => mockedCreateAdaptiveHumanReviewHistory(...args),
  createAdaptivePanelFinalizationHistory: (...args: unknown[]) => mockedCreateAdaptivePanelFinalizationHistory(...args),
  createAdaptivePanelOverrideHistory: (...args: unknown[]) => mockedCreateAdaptivePanelOverrideHistory(...args),
  writeAdaptivePanelFinalizationGovernanceEvent: (...args: unknown[]) => mockedWriteAdaptivePanelFinalizationGovernanceEvent(...args),
  writeAdaptivePanelOverrideGovernanceEvent: (...args: unknown[]) => mockedWriteAdaptivePanelOverrideGovernanceEvent(...args),
  createAdaptiveHumanReviewAssignmentHistory: (...args: unknown[]) => mockedCreateAdaptiveHumanReviewAssignmentHistory(...args),
  writeAdaptiveHumanReviewEvent: (...args: unknown[]) => mockedWriteAdaptiveHumanReviewEvent(...args),
}));

const mockedWriteAdaptivePanelFinalizationAdminAuditEvent = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedWriteAdaptivePanelOverrideAdminAuditEvent = jest.fn().mockResolvedValue({ status: "recorded" });
const mockedWriteAdaptiveAdminAuditEvent = jest.fn().mockResolvedValue({ status: "recorded" });
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptivePanelFinalizationAdminAuditEvent: (...args: unknown[]) => mockedWriteAdaptivePanelFinalizationAdminAuditEvent(...args),
  writeAdaptivePanelOverrideAdminAuditEvent: (...args: unknown[]) => mockedWriteAdaptivePanelOverrideAdminAuditEvent(...args),
  writeAdaptiveAdminAuditEvent: (...args: unknown[]) => mockedWriteAdaptiveAdminAuditEvent(...args),
}));

// Phase 9B.5.2 — wraps the REAL capabilities module, letting specific tests
// install a synthetic override (mirrors the 9B.5.1-R1C precedent) so the
// "reviews.manage/reviews.override alone is NOT sufficient — research.read
// is independently required" invariant can be locked in.
const mockedRoleHasCapability = jest.fn();
jest.mock("@/lib/workspaces/capabilities", () => {
  const actual = jest.requireActual("@/lib/workspaces/capabilities");
  return { ...actual, roleHasCapability: (...args: unknown[]) => mockedRoleHasCapability(...args) };
});

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { buildAdaptiveHumanReviewVoteId } from "@/lib/governance/adaptiveHumanReviewVote";
import {
  getWorkspaceReviewPanel,
  putWorkspaceReviewPanel,
  deleteWorkspaceReviewPanel,
  submitWorkspaceReviewPanelVote,
  finalizeWorkspaceReviewPanel,
  overrideWorkspaceReviewPanel,
} from "@/lib/workspaces/workspaceReviewPanelMutations";
import { putWorkspaceReviewAssignment, submitWorkspaceReviewDecision } from "@/lib/workspaces/workspaceReviewMutations";
// Phase 9C.5 — real cross-mutation journey tests below chain this alongside
// the panel/assignment/decision functions above, all against the SAME
// shared in-memory transaction fake (not a new test framework/harness).
import { resubmitWorkspaceReview } from "@/lib/workspaces/resubmitWorkspaceReview";

const actualCapabilities = jest.requireActual("@/lib/workspaces/capabilities");

const WS_ID = "ws-1";
const OTHER_WS_ID = "other-ws";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const REVIEWER2_UID = "reviewer-2";
const REVIEWER3_UID = "reviewer-3";
const VIEWER_UID = "viewer-1";
const CREATOR_UID = "creator-1";
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
    asPersisted({ schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: status === "removed" ? NOW : null, removedByUserId: status === "removed" ? OWNER_UID : null, ...overrides })
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
  const key = `${RUN_ID}::current`;
  stores.humanReviewAssignment.set(
    key,
    asPersisted({ schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-07-01T00:00:00.000Z", assignedByUserId: OWNER_UID, updatedAt: "2026-07-01T00:00:00.000Z", updatedByUserId: OWNER_UID, revision: 1, workspaceId: WS_ID, projectId: null, dueAt: null, ...overrides })
  );
}

/** `requiredReviewerCount`/`quorum` are ALWAYS re-derived from the (possibly overridden) `reviewerUserIds`, never independently hardcoded — a test overriding `reviewerUserIds` without also updating these would otherwise produce an internally-inconsistent, parser-rejected panel document. */
function seedPanel(overrides: Record<string, unknown> = {}) {
  const key = `${RUN_ID}::current`;
  const reviewerUserIds = (overrides.reviewerUserIds as string[] | undefined) ?? [OWNER_UID, ADMIN_UID, REVIEWER_UID].sort();
  const requiredReviewerCount = (overrides.requiredReviewerCount as number | undefined) ?? reviewerUserIds.length;
  const quorum = (overrides.quorum as number | undefined) ?? Math.floor(requiredReviewerCount / 2) + 1;
  const { reviewerUserIds: _r, requiredReviewerCount: _rc, quorum: _q, ...restOverrides } = overrides;
  stores.humanReviewPanel.set(
    key,
    asPersisted({
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: null,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds,
      requiredReviewerCount,
      quorum,
      status: "open",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      workspaceId: WS_ID,
      projectId: null,
      ...restOverrides,
    })
  );
}

/** `commentPresent`/`conditionsCount` are ALWAYS re-derived from the (possibly overridden) `comment`/`conditions`, and a default comment is supplied for `changes_requested`/`rejected` (which the shared validator requires one for) unless explicitly overridden — same "never let a derived field drift from its source field" discipline as `seedPanel` above. */
function seedVote(reviewerUserId: string, revision: number, overrides: Record<string, unknown> = {}) {
  const voteId = buildAdaptiveHumanReviewVoteId(revision, reviewerUserId);
  const key = `${RUN_ID}::${voteId}`;
  const status = (overrides.status as string | undefined) ?? "approved";
  const needsComment = status === "changes_requested" || status === "rejected";
  const comment = Object.prototype.hasOwnProperty.call(overrides, "comment") ? (overrides.comment as string | undefined) : needsComment ? "See notes." : undefined;
  const conditions = overrides.conditions as string[] | undefined;
  const commentPresent = Boolean(comment && comment.trim().length > 0);
  const conditionsCount = conditions?.length ?? 0;
  const { commentPresent: _cp, conditionsCount: _cc, comment: _c, ...restOverrides } = overrides;
  stores.humanReviewVotes.set(
    key,
    asPersisted({ schemaVersion: 1, kind: "adaptive_human_review_vote", teamId: null, runId: RUN_ID, panelRevision: revision, reviewerUserId, status, comment, commentPresent, conditionsCount, submittedAt: "2026-08-02T00:00:00.000Z", ...restOverrides })
  );
}

function seedWorkspaceById(id: string, overrides: Record<string, unknown> = {}) {
  stores.workspaces.set(id, asPersisted({ schemaVersion: 1, id, type: "team", name: "Other Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW, ...overrides }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreateAdaptiveHumanReviewHistory.mockResolvedValue({ status: "recorded" });
  mockedCreateAdaptivePanelFinalizationHistory.mockResolvedValue({ status: "recorded" });
  mockedCreateAdaptivePanelOverrideHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptivePanelFinalizationGovernanceEvent.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptivePanelOverrideGovernanceEvent.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptivePanelFinalizationAdminAuditEvent.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptivePanelOverrideAdminAuditEvent.mockResolvedValue({ status: "recorded" });
  mockedCreateAdaptiveHumanReviewAssignmentHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptiveHumanReviewEvent.mockResolvedValue({ written: true });
  mockedWriteAdaptiveAdminAuditEvent.mockResolvedValue({ status: "recorded" });
  mockedRoleHasCapability.mockImplementation(actualCapabilities.roleHasCapability);
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
  seedMembership(REVIEWER3_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
  seedMembership(CREATOR_UID, "member");
  seedRun();
});

// ============================================
// GET
// ============================================

describe("getWorkspaceReviewPanel", () => {
  it("admitted, no panel: ok, null", async () => {
    const result = await getWorkspaceReviewPanel({ workspaceId: WS_ID, runId: RUN_ID, approvalAdmitted: true });
    expect(result).toEqual({ status: "ok", panel: null });
  });

  it("not admitted, no panel: not_admitted (concealed at route)", async () => {
    const result = await getWorkspaceReviewPanel({ workspaceId: WS_ID, runId: RUN_ID, approvalAdmitted: false });
    expect(result).toEqual({ status: "not_admitted" });
  });

  it("not admitted, existing open panel: drain-read allowed", async () => {
    seedPanel({ status: "open" });
    const result = await getWorkspaceReviewPanel({ workspaceId: WS_ID, runId: RUN_ID, approvalAdmitted: false });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.panel?.status).toBe("open");
  });

  it("not admitted, existing finalized panel: drain-read allowed", async () => {
    seedPanel({ status: "finalized", finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "approved", finalDecisionId: "panel_workspace_dec_abc", aggregationPolicyVersion: 1 });
    const result = await getWorkspaceReviewPanel({ workspaceId: WS_ID, runId: RUN_ID, approvalAdmitted: false });
    expect(result.status).toBe("ok");
  });

  it("open panel: voteSummary reflects submitted votes", async () => {
    seedPanel({ status: "open", revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    const result = await getWorkspaceReviewPanel({ workspaceId: WS_ID, runId: RUN_ID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.panel?.voteSummary).toEqual({ submittedCount: 2, aggregationState: "ready" });
    }
  });

  it("wrong workspace -> run_not_found (concealed)", async () => {
    const result = await getWorkspaceReviewPanel({ workspaceId: "other-ws", runId: RUN_ID, approvalAdmitted: true });
    expect(result).toEqual({ status: "run_not_found" });
  });
});

// ============================================
// PUT (create / reconfigure)
// ============================================

function putCall(overrides: Partial<Parameters<typeof putWorkspaceReviewPanel>[0]> = {}) {
  return putWorkspaceReviewPanel({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, reviewerUserIds: [OWNER_UID, ADMIN_UID], expectedRevision: 0, now: MUTATE_NOW, ...overrides });
}

describe("putWorkspaceReviewPanel — infra/rollout", () => {
  it("Team Workspaces disabled -> denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await putCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });
});

describe("putWorkspaceReviewPanel — authorization", () => {
  it("Owner (reviews.manage + research.read): allowed", async () => {
    const result = await putCall();
    expect(result.ok).toBe(true);
  });

  it("Admin: allowed", async () => {
    const result = await putCall({ uid: ADMIN_UID });
    expect(result.ok).toBe(true);
  });

  it("Member (no reviews.manage): denied", async () => {
    const result = await putCall({ uid: MEMBER_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("reviews.manage true but research.read false (synthetic capability split, Phase 9B.5.1-R1C pattern applied proactively): denied, zero write", async () => {
    mockedRoleHasCapability.mockImplementation((role: string, capability: string) => {
      if (role === "admin" && capability === "research.read") return false;
      return actualCapabilities.roleHasCapability(role, capability);
    });
    const result = await putCall({ uid: ADMIN_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
  });
});

describe("putWorkspaceReviewPanel — reviewer eligibility", () => {
  it("all eligible (Owner/Admin/Member/Reviewer, not creator): PASS", async () => {
    const result = await putCall({ reviewerUserIds: [OWNER_UID, ADMIN_UID, MEMBER_UID, REVIEWER_UID].sort() });
    expect(result.ok).toBe(true);
  });

  it("Viewer target: denied", async () => {
    const result = await putCall({ reviewerUserIds: [OWNER_UID, VIEWER_UID] });
    expect(result).toEqual({ ok: false, reason: { kind: "target_not_eligible", reviewerUserId: VIEWER_UID, reason: "insufficient_capability" } });
  });

  it("removed member target: denied", async () => {
    seedMembership(REVIEWER2_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await putCall({ reviewerUserIds: [OWNER_UID, REVIEWER2_UID] });
    expect(result).toEqual({ ok: false, reason: { kind: "target_not_eligible", reviewerUserId: REVIEWER2_UID, reason: "removed" } });
  });

  it("creator target (self-review): denied", async () => {
    const result = await putCall({ reviewerUserIds: [OWNER_UID, CREATOR_UID] });
    expect(result).toEqual({ ok: false, reason: { kind: "target_not_eligible", reviewerUserId: CREATOR_UID, reason: "self_review" } });
  });

  it("cross-Workspace member target: denied", async () => {
    stores.workspaceMemberships.delete(computeMembershipId(WS_ID, REVIEWER2_UID));
    seedMembership(REVIEWER2_UID, "reviewer", "other-ws");
    const result = await putCall({ reviewerUserIds: [OWNER_UID, REVIEWER2_UID] });
    expect(result).toEqual({ ok: false, reason: { kind: "target_not_eligible", reviewerUserId: REVIEWER2_UID, reason: "not_found" } });
  });
});

describe("putWorkspaceReviewPanel — OCC", () => {
  it("stale revision -> stale_revision, no write", async () => {
    seedPanel({ revision: 3, reviewerUserIds: [OWNER_UID, ADMIN_UID] });
    const result = await putCall({ expectedRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as any).revision).toBe(3);
  });

  it("reconfigure with correct revision: PASS, revision increments", async () => {
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID] });
    const result = await putCall({ expectedRevision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID, REVIEWER_UID].sort() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.panel.revision).toBe(2);
  });
});

describe("putWorkspaceReviewPanel — finalized/cancelled", () => {
  it("finalized panel: DENY, never reopened", async () => {
    seedPanel({ status: "finalized", revision: 2, finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "approved", finalDecisionId: "panel_workspace_dec_x", aggregationPolicyVersion: 1 });
    const result = await putCall({ expectedRevision: 2 });
    expect(result).toEqual({ ok: false, reason: "panel_finalized" });
  });

  it("cancelled panel: DENY, never reopened", async () => {
    seedPanel({ status: "cancelled", revision: 2 });
    const result = await putCall({ expectedRevision: 2 });
    expect(result).toEqual({ ok: false, reason: "panel_finalized" });
  });
});

describe("putWorkspaceReviewPanel — mutual exclusion with single-review assignment", () => {
  it("active assignment exists: DENY panel creation", async () => {
    seedAssignment({ assignedReviewerUserId: REVIEWER_UID });
    const result = await putCall();
    expect(result).toEqual({ ok: false, reason: "single_review_active" });
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
  });

  it("unassigned-but-existing assignment document (assignedReviewerUserId: null): does NOT block", async () => {
    seedAssignment({ assignedReviewerUserId: null });
    const result = await putCall();
    expect(result.ok).toBe(true);
  });

  it("no assignment document at all: does NOT block", async () => {
    const result = await putCall();
    expect(result.ok).toBe(true);
  });
});

describe("putWorkspaceReviewPanel — not_pending", () => {
  it("terminal review status: DENY", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "approved", reviewedAt: GOVERNANCE_UPDATED_AT } }) });
    const result = await putCall();
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });
});

describe("putWorkspaceReviewPanel — concurrency (real retry model, Phase 9B.5.1-R1C pattern)", () => {
  it("an assignment becomes actively assigned after this transaction's own read but before commit: panel creation cannot commit around it", async () => {
    let hookFired = false;
    concurrentMutationHook = (ref) => {
      if (!hookFired && ref.__collection === "humanReviewAssignment" && ref.__id === `${RUN_ID}::current`) {
        hookFired = true;
        seedAssignment({ assignedReviewerUserId: REVIEWER2_UID, revision: 1 });
      }
    };
    const result = await putCall();
    expect(result).toEqual({ ok: false, reason: "single_review_active" });
    expect(transactionAttemptCount.value).toBe(2);
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
  });
});

// ============================================
// DELETE (cancel)
// ============================================

function deleteCall(overrides: Partial<Parameters<typeof deleteWorkspaceReviewPanel>[0]> = {}) {
  return deleteWorkspaceReviewPanel({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, expectedRevision: 1, now: MUTATE_NOW, ...overrides });
}

describe("deleteWorkspaceReviewPanel", () => {
  it("valid manager + correct revision: PASS, status cancelled, reviewer list preserved", async () => {
    seedPanel({ revision: 1 });
    const result = await deleteCall();
    expect(result).toEqual({ ok: true });
    const stored = stores.humanReviewPanel.get(`${RUN_ID}::current`) as any;
    expect(stored.status).toBe("cancelled");
    expect(stored.reviewerUserIds).toEqual([OWNER_UID, ADMIN_UID, REVIEWER_UID].sort());
  });

  it("Member without reviews.manage: DENY", async () => {
    seedPanel({ revision: 1 });
    expect(await deleteCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("panel absent: DENY", async () => {
    expect(await deleteCall()).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("stale revision: DENY", async () => {
    seedPanel({ revision: 5 });
    expect(await deleteCall({ expectedRevision: 1 })).toEqual({ ok: false, reason: "stale_revision" });
  });

  it("finalized panel: DENY (never cancellable post-finalization)", async () => {
    seedPanel({ status: "finalized", revision: 2, finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "approved", finalDecisionId: "panel_workspace_dec_x", aggregationPolicyVersion: 1 });
    expect(await deleteCall({ expectedRevision: 2 })).toEqual({ ok: false, reason: "panel_finalized" });
  });

  it("already cancelled: DENY (panel_already_cancelled, not a silent no-op)", async () => {
    seedPanel({ status: "cancelled", revision: 2 });
    expect(await deleteCall({ expectedRevision: 2 })).toEqual({ ok: false, reason: "panel_already_cancelled" });
  });
});

// ============================================
// POST vote
// ============================================

function voteCall(overrides: Partial<Parameters<typeof submitWorkspaceReviewPanelVote>[0]> = {}) {
  return submitWorkspaceReviewPanelVote({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, panelRevision: 1, status: "approved", now: MUTATE_NOW, ...overrides });
}

describe("submitWorkspaceReviewPanelVote", () => {
  it("current panel reviewer with capabilities: PASS", async () => {
    seedPanel({ revision: 1 });
    const result = await voteCall();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.submissionStatus).toBe("submitted");
  });

  it("idempotent identical retry: already_submitted, no duplicate write attempt semantics change", async () => {
    seedPanel({ revision: 1 });
    const first = await voteCall();
    expect(first.ok).toBe(true);
    const second = await voteCall();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.submissionStatus).toBe("already_submitted");
  });

  it("conflicting retry (different status): vote_conflict, never overwritten", async () => {
    seedPanel({ revision: 1 });
    await voteCall({ status: "approved" });
    const second = await voteCall({ status: "rejected" });
    expect(second).toEqual({ ok: false, reason: "vote_conflict" });
  });

  it("not a panel reviewer: DENY (not_reviewer)", async () => {
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const result = await voteCall({ uid: REVIEWER_UID });
    expect(result).toEqual({ ok: false, reason: "not_reviewer" });
  });

  it("removed panel reviewer: DENY (stored panel list cannot resurrect permission — denied even earlier, by the same-transaction membership authorization itself)", async () => {
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, REVIEWER2_UID].sort() });
    seedMembership(REVIEWER2_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await voteCall({ uid: REVIEWER2_UID });
    expect(result).toEqual({ ok: false, reason: "membership_removed" });
  });

  it("Viewer-downgraded panel reviewer: DENY (no reviews.submit capability — denied by the same-transaction membership authorization itself)", async () => {
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, REVIEWER2_UID].sort() });
    seedMembership(REVIEWER2_UID, "viewer");
    const result = await voteCall({ uid: REVIEWER2_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("creator in corrupted reviewer list: DENY (self_review, independent of stored list)", async () => {
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, CREATOR_UID].sort() });
    const result = await voteCall({ uid: CREATOR_UID });
    expect(result).toEqual({ ok: false, reason: "self_review" });
  });

  it("wrong revision (stale): DENY", async () => {
    seedPanel({ revision: 2 });
    const result = await voteCall({ panelRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("finalized panel: DENY (panel_not_open)", async () => {
    seedPanel({ status: "finalized", revision: 2, finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "approved", finalDecisionId: "panel_workspace_dec_x", aggregationPolicyVersion: 1 });
    const result = await voteCall({ panelRevision: 2 });
    expect(result).toEqual({ ok: false, reason: "panel_not_open" });
  });

  it("cancelled panel: DENY (panel_not_open)", async () => {
    seedPanel({ status: "cancelled", revision: 2 });
    const result = await voteCall({ panelRevision: 2 });
    expect(result).toEqual({ ok: false, reason: "panel_not_open" });
  });

  it("panel absent: DENY", async () => {
    const result = await voteCall();
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("old-revision votes never satisfy a new revision after reconfiguration — distinct vote document identity", async () => {
    seedPanel({ revision: 1 });
    await voteCall({ panelRevision: 1, status: "approved" });
    // Reconfigure to revision 2.
    seedPanel({ revision: 2, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const voteAtOldRevision = stores.humanReviewVotes.get(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`);
    const voteAtNewRevision = stores.humanReviewVotes.get(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(2, OWNER_UID)}`);
    expect(voteAtOldRevision).toBeDefined();
    expect(voteAtNewRevision).toBeUndefined();
  });
});

describe("submitWorkspaceReviewPanelVote — backend receipt-usability invariant (10C.4A-U2B, canonical governance-state integrity, independent of the UI safeguard)", () => {
  it("empty conclusion: DENIED before any vote document is written, even for an otherwise-eligible panel reviewer", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    const result = await voteCall();
    expect(result).toEqual({ ok: false, reason: "review_content_unavailable" });
    expect(stores.humanReviewVotes.get(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`)).toBeUndefined();
  });

  it("whitespace-only conclusion: DENIED, identical to empty", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "   ", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    expect(await voteCall()).toEqual({ ok: false, reason: "review_content_unavailable" });
  });

  it("meaningful conclusion with every supporting array empty: ALLOWED", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "The panel did not converge on enough shared subjects for a comparison.", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
  });

  it("receipt-usability is checked AFTER panel eligibility — a non-reviewer still receives the existing not_reviewer denial, never a receipt-state oracle", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const result = await voteCall({ uid: REVIEWER_UID });
    expect(result).toEqual({ ok: false, reason: "not_reviewer" });
  });
});

// ============================================
// POST finalize
// ============================================

function finalizeCall(overrides: Partial<Parameters<typeof finalizeWorkspaceReviewPanel>[0]> = {}) {
  return finalizeWorkspaceReviewPanel({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT, now: MUTATE_NOW, ...overrides });
}

describe("finalizeWorkspaceReviewPanel", () => {
  it("quorum met, strict majority: PASS, writes history/event/audit", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    const result = await finalizeCall();
    expect(result).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
    expect(mockedCreateAdaptiveHumanReviewHistory).toHaveBeenCalledTimes(1);
    expect(mockedCreateAdaptivePanelFinalizationHistory).toHaveBeenCalledTimes(1);
    expect(mockedWriteAdaptivePanelFinalizationGovernanceEvent).toHaveBeenCalledTimes(1);
    expect(mockedWriteAdaptivePanelFinalizationAdminAuditEvent).toHaveBeenCalledTimes(1);
    const stored = stores.runs.get(RUN_ID) as any;
    expect(stored.governanceRecord.humanReview.status).toBe("approved");
  });

  it("quorum not met: DENY", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    const result = await finalizeCall();
    expect(result).toEqual({ ok: false, reason: "quorum_not_met" });
  });

  it("deadlocked (no strict majority): DENY", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "rejected" });
    const result = await finalizeCall();
    expect(result).toEqual({ ok: false, reason: "panel_deadlocked" });
  });

  it("reviews.manage but no research.read synthetic: DENY", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    mockedRoleHasCapability.mockImplementation((role: string, capability: string) => {
      if (role === "admin" && capability === "research.read") return false;
      return actualCapabilities.roleHasCapability(role, capability);
    });
    const result = await finalizeCall({ uid: ADMIN_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("wrong panel revision: DENY (panel_stale)", async () => {
    seedPanel({ revision: 2 });
    const result = await finalizeCall({ expectedPanelRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("Phase 9C.5 PERMANENT REGRESSION: a rejected (stale-revision) finalize attempt never writes a ghost history/event/audit record", async () => {
    seedPanel({ revision: 2 });
    const result = await finalizeCall({ expectedPanelRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
    expect(mockedCreateAdaptiveHumanReviewHistory).not.toHaveBeenCalled();
    expect(mockedCreateAdaptivePanelFinalizationHistory).not.toHaveBeenCalled();
    expect(mockedWriteAdaptivePanelFinalizationGovernanceEvent).not.toHaveBeenCalled();
    expect(mockedWriteAdaptivePanelFinalizationAdminAuditEvent).not.toHaveBeenCalled();
  });

  it("stale governance updatedAt: DENY (governance_stale)", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    const result = await finalizeCall({ expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: false, reason: "governance_stale" });
  });

  it("cancelled panel: DENY", async () => {
    seedPanel({ status: "cancelled", revision: 2 });
    const result = await finalizeCall({ expectedPanelRevision: 2 });
    expect(result).toEqual({ ok: false, reason: "panel_cancelled" });
  });

  it("panel absent: DENY", async () => {
    const result = await finalizeCall();
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("already finalized (idempotent retry): PASS, no duplicate history/audit writes", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    const first = await finalizeCall();
    expect(first.ok).toBe(true);
    expect(mockedCreateAdaptiveHumanReviewHistory).toHaveBeenCalledTimes(1);

    const retry = await finalizeCall();
    expect(retry).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
    // Post-commit writers ARE attempted again on the idempotent retry
    // (best-effort, create-only, `already_exists` is a safe outcome) — but
    // never produce a SECOND distinct canonical decision.
    expect(mockedCreateAdaptiveHumanReviewHistory).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockedCreateAdaptiveHumanReviewHistory.mock.calls[1];
    const firstCallArgs = mockedCreateAdaptiveHumanReviewHistory.mock.calls[0];
    expect(secondCallArgs[1].decisionId).toBe(firstCallArgs[1].decisionId); // same deterministic decisionId both times
  });

  it("STALE-VOTE POLICY (frozen, §36): a reviewer removed AFTER voting still has their already-cast vote counted at finalization", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    // ADMIN_UID is removed from the Workspace AFTER voting, before finalization.
    seedMembership(ADMIN_UID, "admin", WS_ID, { status: "removed" });
    const result = await finalizeCall();
    expect(result.ok).toBe(true); // quorum (2) still met using the already-cast vote; finalization does not re-check voter membership.
    if (result.ok) expect(result.status).toBe("approved");
  });

  it("changes_requested resubmit changes_requested sequence: each finalization decision gets a distinct, collision-safe decisionId (via distinct panel revisions)", async () => {
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "changes_requested", comment: "needs work" });
    seedVote(ADMIN_UID, 1, { status: "changes_requested", comment: "needs work" });
    const first = await finalizeCall();
    expect(first.ok).toBe(true);
    const firstDecisionId = mockedCreateAdaptiveHumanReviewHistory.mock.calls[0][1].decisionId;

    // A NEW panel round (a fresh call would be blocked by "finalized" in
    // production — this directly seeds revision 3 to model the state after
    // a hypothetical future round, isolating the ID-collision property only).
    seedPanel({ revision: 3, status: "open" });
    seedVote(OWNER_UID, 3, { status: "approved" });
    seedVote(ADMIN_UID, 3, { status: "approved" });
    seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "unreviewed" }, updatedAt: GOVERNANCE_UPDATED_AT }) });
    const second = await finalizeCall({ expectedPanelRevision: 3 });
    expect(second.ok).toBe(true);
    const secondDecisionId = mockedCreateAdaptiveHumanReviewHistory.mock.calls[1][1].decisionId;

    expect(firstDecisionId).not.toBe(secondDecisionId);
  });
});

// ============================================
// POST override
// ============================================

function overrideCall(overrides: Partial<Parameters<typeof overrideWorkspaceReviewPanel>[0]> = {}) {
  return overrideWorkspaceReviewPanel({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT, status: "approved", justification: "Deadline requires resolution.", now: MUTATE_NOW, ...overrides });
}

describe("overrideWorkspaceReviewPanel", () => {
  it("Owner with reviews.override + research.read: PASS", async () => {
    seedPanel({ revision: 1 });
    const result = await overrideCall();
    expect(result).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
    expect(mockedCreateAdaptivePanelOverrideHistory).toHaveBeenCalledTimes(1);
    expect(mockedWriteAdaptivePanelOverrideAdminAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("Admin (no reviews.override capability): DENY", async () => {
    seedPanel({ revision: 1 });
    const result = await overrideCall({ uid: ADMIN_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Member: DENY", async () => {
    seedPanel({ revision: 1 });
    expect(await overrideCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Owner overriding own artifact (self-artifact): ALLOWED only through this explicit path", async () => {
    seedRun({ userId: OWNER_UID, workspaceId: WS_ID, projectId: null, governanceRecord: validGovernanceRecord() });
    seedPanel({ revision: 1 });
    const result = await overrideCall({ uid: OWNER_UID });
    expect(result.ok).toBe(true);
  });

  it("empty justification: rejected upstream by the pure request parser (route-level 400, not reachable here) — service itself still requires a non-empty string", async () => {
    seedPanel({ revision: 1 });
    const result = await overrideCall({ justification: "" });
    // buildAdaptivePanelOverrideDecisionId / buildWorkspacePanelOverrideDecisionId throws on empty justification.
    expect(result.ok).toBe(false);
  });

  it("stale panel revision: DENY (panel_stale)", async () => {
    seedPanel({ revision: 2 });
    const result = await overrideCall({ expectedPanelRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("Phase 9C.5 PERMANENT REGRESSION: a rejected (stale-revision) override attempt never writes a ghost history/event/audit record", async () => {
    seedPanel({ revision: 2 });
    const result = await overrideCall({ expectedPanelRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
    expect(mockedCreateAdaptiveHumanReviewHistory).not.toHaveBeenCalled();
    expect(mockedCreateAdaptivePanelOverrideHistory).not.toHaveBeenCalled();
    expect(mockedWriteAdaptivePanelOverrideGovernanceEvent).not.toHaveBeenCalled();
    expect(mockedWriteAdaptivePanelOverrideAdminAuditEvent).not.toHaveBeenCalled();
  });

  it("Phase 9C.5 PERMANENT REGRESSION: the idempotent identical retry re-invokes the writers with the SAME deterministic finalDecisionId both times — the actual no-duplication guarantee lives one layer down, at the writers' own deterministic-ID + create()-fails-on-conflict contract (see lib/firestore/__tests__/adaptivePanelOverrideSecondaryArtifacts.spec.ts and lib/governance/__tests__/adaptivePanelOverrideAdminAuditEvent.spec.ts, both of which assert `already_exists` on a repeat write — not re-derived here since this file mocks those writers)", async () => {
    seedPanel({ revision: 1 });
    const first = await overrideCall();
    expect(first.ok).toBe(true);
    const firstDecisionId = mockedWriteAdaptivePanelOverrideAdminAuditEvent.mock.calls[0][0].finalDecisionId;
    const retry = await overrideCall();
    expect(retry.ok).toBe(true);
    const retryDecisionId = mockedWriteAdaptivePanelOverrideAdminAuditEvent.mock.calls[1][0].finalDecisionId;
    expect(retryDecisionId).toBe(firstDecisionId);
  });

  it("cancelled panel: DENY", async () => {
    seedPanel({ status: "cancelled", revision: 2 });
    const result = await overrideCall({ expectedPanelRevision: 2 });
    expect(result).toEqual({ ok: false, reason: "panel_cancelled" });
  });

  it("panel absent: DENY (naturally self-limiting — no hidden bypass for an unrelated run)", async () => {
    const result = await overrideCall();
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("does not read or require any votes at all — overrides a panel with zero votes cast", async () => {
    seedPanel({ revision: 1 });
    const result = await overrideCall();
    expect(result.ok).toBe(true);
  });

  it("idempotent identical retry: PASS, no duplicate canonical mutation", async () => {
    seedPanel({ revision: 1 });
    const first = await overrideCall();
    expect(first.ok).toBe(true);
    const retry = await overrideCall();
    expect(retry).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
  });

  it("a DIFFERENT override request against an already-overridden panel: DENY (panel_already_finalized), never silently overwritten", async () => {
    seedPanel({ revision: 1 });
    const first = await overrideCall({ status: "approved" });
    expect(first.ok).toBe(true);
    const second = await overrideCall({ status: "rejected", justification: "different reasoning" });
    expect(second).toEqual({ ok: false, reason: "panel_already_finalized" });
  });
});

describe("overrideWorkspaceReviewPanel — backend receipt-usability invariant (10C.4A-U2B, canonical governance-state integrity, independent of the UI safeguard)", () => {
  it("empty conclusion: DENIED before any override write, even for a canonical Owner with reviews.override", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    const result = await overrideCall();
    expect(result).toEqual({ ok: false, reason: "review_content_unavailable" });
    expect(mockedCreateAdaptivePanelOverrideHistory).not.toHaveBeenCalled();
    expect(mockedWriteAdaptivePanelOverrideGovernanceEvent).not.toHaveBeenCalled();
    expect(mockedWriteAdaptivePanelOverrideAdminAuditEvent).not.toHaveBeenCalled();
    const stored = stores.runs.get(RUN_ID) as any;
    expect(stored.governanceRecord.humanReview.status).toBe("unreviewed");
  });

  it("whitespace-only conclusion: DENIED, identical to empty", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "  \n ", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    expect(await overrideCall()).toEqual({ ok: false, reason: "review_content_unavailable" });
  });

  it("meaningful conclusion with every supporting array empty: ALLOWED", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "The panel did not converge on enough shared subjects for a comparison.", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    expect((await overrideCall()).ok).toBe(true);
  });

  it("receipt-usability is checked AFTER capability authorization — a non-Owner still receives the existing insufficient_capability denial, never a receipt-state oracle", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: true } }) });
    seedPanel({ revision: 1 });
    const result = await overrideCall({ uid: ADMIN_UID });
    expect(result).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("the idempotent-retry branch (re-confirming an ALREADY-overridden panel) never reaches the receipt-usability check at all — it performs no new write and returns before that code path (see overrideWorkspaceReviewPanel's own early-return for panel.status === 'finalized')", async () => {
    seedPanel({ revision: 1 });
    const first = await overrideCall();
    expect(first.ok).toBe(true);
    const retry = await overrideCall();
    expect(retry).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
  });
});

// ============================================
// Mutual exclusion — concurrent single-review assignment vs panel create
// ============================================

describe("cross-service mutual exclusion — assignment vs panel (§50)", () => {
  it("racing putWorkspaceReviewAssignment and putWorkspaceReviewPanel from a clean state: never both commit (panel loses when assignment already committed)", async () => {
    // Sequential simulation of the race's resolution (both functions share
    // the SAME hardened transaction fake and its read-before-write/conflict
    // detection — the real concurrency mechanics are already proven by the
    // dedicated hook-based tests above and in workspaceReviewMutations.spec.ts;
    // this test proves the CROSS-SERVICE invariant holds once one committed first).
    const assignmentResult = await putWorkspaceReviewAssignment({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: null, now: MUTATE_NOW });
    expect(assignmentResult.ok).toBe(true);

    const panelResult = await putCall();
    expect(panelResult).toEqual({ ok: false, reason: "single_review_active" });

    const finalAssignment = stores.humanReviewAssignment.get(`${RUN_ID}::current`);
    const finalPanel = stores.humanReviewPanel.get(`${RUN_ID}::current`);
    expect(finalAssignment).toBeDefined();
    expect(finalPanel).toBeUndefined();
  });

  it("panel created first: a subsequent assignment attempt is blocked by the (already 9B.5.1-proven) open-panel gate", async () => {
    const panelResult = await putCall();
    expect(panelResult.ok).toBe(true);

    const assignmentResult = await putWorkspaceReviewAssignment({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: null, now: MUTATE_NOW });
    expect(assignmentResult).toEqual({ ok: false, reason: "active_panel" });

    const finalAssignment = stores.humanReviewAssignment.get(`${RUN_ID}::current`);
    expect(finalAssignment).toBeUndefined();
  });
});

// ============================================
// Phase 9C.5 — durable cross-workflow governance journeys
// ============================================
//
// Each journey below chains REAL production mutation functions (never
// `seedPanel`/`seedVote`-style direct DTO injection) against the SAME
// shared in-memory transaction fake this whole file already uses — genuine
// end-to-end proof that one mutation's committed output is exactly what
// the next mutation's own authorization/OCC logic independently re-reads
// and accepts, not merely that each function works in isolation. No new
// test framework: this is the existing Jest + hand-written transaction
// fake architecture, extended (see `governanceEvents` store/auto-ID `.doc()`
// above) only as far as `resubmitWorkspaceReview()` required.

describe("Phase 9C.5 — Journey A: ordinary review (assign -> decide -> approved)", () => {
  it("owner assigns a reviewer, the assigned reviewer approves, governance record + assignment both reflect it", async () => {
    const assign = await putWorkspaceReviewAssignment({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: null, now: MUTATE_NOW });
    expect(assign.ok).toBe(true);

    const decision = await submitWorkspaceReviewDecision({ uid: REVIEWER_UID, workspaceId: WS_ID, runId: RUN_ID, update: { status: "approved" }, expectedUpdatedAt: GOVERNANCE_UPDATED_AT, now: MUTATE_NOW });
    expect(decision).toEqual({ ok: true, status: "approved", reviewedAt: MUTATE_NOW });

    const finalRun = stores.runs.get(RUN_ID) as any;
    expect(finalRun.governanceRecord.humanReview.status).toBe("approved");
    expect(finalRun.governanceRecord.updatedAt).toBe(MUTATE_NOW);
    const finalAssignment = stores.humanReviewAssignment.get(`${RUN_ID}::current`) as any;
    expect(finalAssignment.assignedReviewerUserId).toBe(REVIEWER_UID);
    expect(finalAssignment.revision).toBe(1);
  });
});

describe("Phase 9C.5 — Journey B: changes_requested -> resubmit -> ordinary review continues", () => {
  it("reviewer requests changes, creator resubmits, review returns to unreviewed with the assignment preserved, then the SAME reviewer can decide again", async () => {
    const assign = await putWorkspaceReviewAssignment({ uid: OWNER_UID, workspaceId: WS_ID, runId: RUN_ID, assignedReviewerUserId: REVIEWER_UID, expectedRevision: 0, dueAt: "2026-09-01T00:00:00.000Z", now: MUTATE_NOW });
    expect(assign.ok).toBe(true);

    const decision = await submitWorkspaceReviewDecision({ uid: REVIEWER_UID, workspaceId: WS_ID, runId: RUN_ID, update: { status: "changes_requested", comment: "Needs another pass." }, expectedUpdatedAt: GOVERNANCE_UPDATED_AT, now: MUTATE_NOW });
    expect(decision).toEqual({ ok: true, status: "changes_requested", reviewedAt: MUTATE_NOW });

    const resubmit = await resubmitWorkspaceReview({ uid: CREATOR_UID, workspaceId: WS_ID, runId: RUN_ID, expectedUpdatedAt: MUTATE_NOW, now: "2026-08-11T00:00:00.000Z" });
    expect(resubmit.ok).toBe(true);

    const afterResubmit = stores.runs.get(RUN_ID) as any;
    expect(afterResubmit.governanceRecord.humanReview.status).toBe("unreviewed");
    // Assignment and its dueAt survive resubmission untouched — resubmit
    // never touches `humanReviewAssignment`.
    const assignmentAfter = stores.humanReviewAssignment.get(`${RUN_ID}::current`) as any;
    expect(assignmentAfter.assignedReviewerUserId).toBe(REVIEWER_UID);
    expect(assignmentAfter.dueAt).toBe("2026-09-01T00:00:00.000Z");
    // Immutable event written atomically with the resubmit transaction (no panel round 2 concept anywhere in this path).
    const events = [...stores.governanceEvents.entries()].filter(([key]) => key.startsWith(`${RUN_ID}::`));
    expect(events).toHaveLength(1);
    expect((events[0][1] as any).action).toBe("review_resubmitted");

    // The ordinary single-review path is fully usable again with the same reviewer.
    const secondDecision = await submitWorkspaceReviewDecision({ uid: REVIEWER_UID, workspaceId: WS_ID, runId: RUN_ID, update: { status: "approved" }, expectedUpdatedAt: "2026-08-11T00:00:00.000Z", now: "2026-08-12T00:00:00.000Z" });
    expect(secondDecision).toEqual({ ok: true, status: "approved", reviewedAt: "2026-08-12T00:00:00.000Z" });
  });
});

describe("Phase 9C.5 — Journey C: panel happy path (create -> vote -> vote -> finalize)", () => {
  it("two reviewers vote approve, quorum (2 of 2) is met, finalize commits the canonical governance status", async () => {
    const create = await putCall({ reviewerUserIds: [OWNER_UID, ADMIN_UID], expectedRevision: 0 });
    expect(create.ok).toBe(true);

    const vote1 = await voteCall({ uid: OWNER_UID, panelRevision: 1, status: "approved" });
    expect(vote1.ok).toBe(true);
    const vote2 = await voteCall({ uid: ADMIN_UID, panelRevision: 1, status: "approved" });
    expect(vote2.ok).toBe(true);

    const finalize = await finalizeCall({ expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(finalize).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });

    const finalRun = stores.runs.get(RUN_ID) as any;
    expect(finalRun.governanceRecord.humanReview.status).toBe("approved");
    expect(finalRun.governanceRecord.humanReview.decidedVia).toBe("multi_reviewer_panel");
  });
});

describe("Phase 9C.5 — Journey D: panel reconfiguration isolates old-revision votes from the new quorum", () => {
  it("a vote cast at revision 1 does not count toward revision 2's quorum after reconfiguration", async () => {
    const create = await putCall({ reviewerUserIds: [OWNER_UID, ADMIN_UID], expectedRevision: 0 });
    expect(create.ok).toBe(true);

    const voteAtRev1 = await voteCall({ uid: OWNER_UID, panelRevision: 1, status: "approved" });
    expect(voteAtRev1.ok).toBe(true);

    // Reconfigure — same reviewer set is fine; what matters is the revision bump.
    const reconfigure = await putCall({ reviewerUserIds: [OWNER_UID, ADMIN_UID], expectedRevision: 1 });
    expect(reconfigure.ok).toBe(true);
    const panelAfterReconfigure = stores.humanReviewPanel.get(`${RUN_ID}::current`) as any;
    expect(panelAfterReconfigure.revision).toBe(2);

    // The revision-1 vote is still in the store (never deleted — historical
    // fact) but must not be readable toward revision-2 quorum.
    expect(stores.humanReviewVotes.get(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`)).toBeDefined();
    expect(stores.humanReviewVotes.get(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(2, OWNER_UID)}`)).toBeUndefined();

    const finalizeTooEarly = await finalizeCall({ expectedPanelRevision: 2, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(finalizeTooEarly).toEqual({ ok: false, reason: "quorum_not_met" });

    // Only a FRESH revision-2 vote from both reviewers reaches quorum.
    expect((await voteCall({ uid: OWNER_UID, panelRevision: 2, status: "approved" })).ok).toBe(true);
    expect((await voteCall({ uid: ADMIN_UID, panelRevision: 2, status: "approved" })).ok).toBe(true);
    const finalizeNow = await finalizeCall({ expectedPanelRevision: 2, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(finalizeNow).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
  });
});

describe("Phase 9C.5 — Journey G: Owner Override (create panel -> override, no votes required)", () => {
  it("an Owner overrides an open panel with zero votes cast — dual OCC, immutable history, distinct provenance", async () => {
    const create = await putCall({ reviewerUserIds: [OWNER_UID, ADMIN_UID], expectedRevision: 0 });
    expect(create.ok).toBe(true);

    const override = await overrideCall({ expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT, status: "approved", justification: "Deadline requires resolution ahead of the panel's own vote schedule." });
    expect(override).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });

    const finalRun = stores.runs.get(RUN_ID) as any;
    expect(finalRun.governanceRecord.humanReview.status).toBe("approved");
    expect(finalRun.governanceRecord.humanReview.decidedVia).toBe("multi_reviewer_owner_override");
    // Self-review distinction: this is NOT a peer-review decision — the
    // ordinary single-review path was never touched by this journey at all
    // (no `submitWorkspaceReviewDecision` call anywhere in it), and the
    // panel itself required no reviewer votes to reach this outcome.
    expect(stores.humanReviewVotes.size).toBe(0);
  });
});

// ============================================
// Phase 10B.3.2B.2 — Workspace-canary target admission. The rollout gate
// (resolveTeamWorkspaceTargetAdmission) is admission ONLY — every test below
// proves membership/capability/canonical-binding/reviewer-eligibility/
// self-review/Owner-authority checks are byte-identical and independent of
// admission source (global, uid-canary, Workspace-canary).
// ============================================

describe("putWorkspaceReviewPanel — Workspace-canary target admission (Phase 10B.3.2B.2)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    expect((await putCall()).ok).toBe(true);
  });

  it("Workspace-canary only (global/uid off), active manager: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect((await putCall()).ok).toBe(true);
  });

  it("Workspace-canary only, Member (no reviews.manage): denied at the CAPABILITY check, not admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect(await putCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, no membership: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    expect(await putCall({ uid: "outsider-1" })).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("Workspace-canary only, caller's membership removed: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(OWNER_UID, "owner", WS_ID, { status: "removed" });
    expect((await putCall()).ok).toBe(false);
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    const result = await putCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    expect((await putCall()).ok).toBe(true);
  });

  it("malformed Workspace-canary list fails closed (global/uid off)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "*";
    expect(await putCall()).toEqual({ ok: false, reason: "team_workspaces_disabled" });
  });

  it("MANDATORY cross-Workspace reviewer candidate: caller genuinely admitted+manager in WS_ID, but the proposed reviewer is only a member of OTHER_WS_ID -> denied target_not_eligible, never eligible merely because the caller is admitted", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedWorkspaceById(OTHER_WS_ID);
    stores.workspaceMemberships.delete(computeMembershipId(WS_ID, REVIEWER2_UID));
    seedMembership(REVIEWER2_UID, "reviewer", OTHER_WS_ID);
    const result = await putCall({ reviewerUserIds: [OWNER_UID, REVIEWER2_UID].sort() });
    expect(result).toEqual({ ok: false, reason: { kind: "target_not_eligible", reviewerUserId: REVIEWER2_UID, reason: "not_found" } });
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+manager in WS_ID, but the target RUN canonically belongs to OTHER_WS_ID -> denied run_not_found, canonical binding is never bypassable by admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    const result = await putCall({ workspaceId: WS_ID });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("deleteWorkspaceReviewPanel — Workspace-canary target admission (Phase 10B.3.2B.2)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    seedPanel({ revision: 1 });
    expect((await deleteCall()).ok).toBe(true);
  });

  it("Workspace-canary only, active manager: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect((await deleteCall()).ok).toBe(true);
  });

  it("Workspace-canary only, Member (no reviews.manage): denied at capability check", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await deleteCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    seedPanel({ revision: 1 });
    const result = await deleteCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    seedPanel({ revision: 1 });
    expect((await deleteCall()).ok).toBe(true);
  });

  it("non-open panel semantics unchanged under Workspace-canary: already-cancelled panel -> panel_already_cancelled", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ status: "cancelled", revision: 2 });
    expect(await deleteCall({ expectedRevision: 2 })).toEqual({ ok: false, reason: "panel_already_cancelled" });
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+manager in WS_ID, but the target RUN/panel canonically belongs to OTHER_WS_ID -> denied run_not_found", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    seedPanel({ revision: 1, workspaceId: OTHER_WS_ID });
    const result = await deleteCall({ workspaceId: WS_ID, expectedRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("submitWorkspaceReviewPanelVote — Workspace-canary target admission (Phase 10B.3.2B.2)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
  });

  it("Workspace-canary only, current panel reviewer: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    const result = await voteCall();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.submissionStatus).toBe("submitted");
  });

  it("Workspace-canary only, Viewer-downgraded panel reviewer: denied at the CAPABILITY check", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, REVIEWER2_UID].sort() });
    seedMembership(REVIEWER2_UID, "viewer");
    expect(await voteCall({ uid: REVIEWER2_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, no membership at all: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await voteCall({ uid: "outsider-1" })).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    seedPanel({ revision: 1 });
    const result = await voteCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
  });

  it("MANDATORY self-review under Workspace-canary: creator, even Workspace-canary-admitted as Owner, in a (corrupted) reviewer list -> DENIED self_review, independent of admission source", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, CREATOR_UID].sort() });
    const result = await voteCall({ uid: CREATOR_UID });
    expect(result).toEqual({ ok: false, reason: "self_review" });
  });

  it("MANDATORY non-panel-reviewer under Workspace-canary: a Workspace-canary-admitted, active, reviews.submit-capable Member who is NOT a canonical panel reviewer -> DENIED not_reviewer, capability alone is insufficient", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const result = await voteCall({ uid: REVIEWER_UID });
    expect(result).toEqual({ ok: false, reason: "not_reviewer" });
  });

  it("Workspace-canary only, stale panel revision: denied panel_stale", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 2 });
    expect(await voteCall({ panelRevision: 1 })).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("Workspace-canary only, removed panel-reviewer membership before cast: denied membership_removed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1, reviewerUserIds: [OWNER_UID, REVIEWER2_UID].sort() });
    seedMembership(REVIEWER2_UID, "reviewer", WS_ID, { status: "removed" });
    expect(await voteCall({ uid: REVIEWER2_UID })).toEqual({ ok: false, reason: "membership_removed" });
  });

  it("VALID_AT_CAST_TIME preserved under Workspace-canary: a vote cast while eligible, then the voter is removed AFTER casting, still counts at finalization", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect((await voteCall({ uid: OWNER_UID, panelRevision: 1, status: "approved" })).ok).toBe(true);
    expect((await voteCall({ uid: ADMIN_UID, panelRevision: 1, status: "approved" })).ok).toBe(true);
    seedMembership(ADMIN_UID, "admin", WS_ID, { status: "removed" });
    const result = await finalizeCall({ workspaceId: WS_ID, expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("approved");
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+reviewer in WS_ID, but the target RUN/panel canonically belongs to OTHER_WS_ID -> denied run_not_found", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    seedPanel({ revision: 1, workspaceId: OTHER_WS_ID });
    const result = await voteCall({ workspaceId: WS_ID, panelRevision: 1 });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("finalizeWorkspaceReviewPanel — Workspace-canary target admission (Phase 10B.3.2B.2)", () => {
  it("uid-canary only (global off): allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    expect((await finalizeCall()).ok).toBe(true);
  });

  it("Workspace-canary only, quorum met: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    expect((await finalizeCall()).ok).toBe(true);
  });

  it("Workspace-canary only, Member (no reviews.manage): denied at capability check", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    expect(await finalizeCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, quorum not met: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    expect(await finalizeCall()).toEqual({ ok: false, reason: "quorum_not_met" });
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    seedPanel({ revision: 1 });
    const result = await finalizeCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedVote(ADMIN_UID, 1, { status: "approved" });
    expect((await finalizeCall()).ok).toBe(true);
  });

  it("old-revision votes excluded under Workspace-canary: a revision-1 vote does not satisfy revision-2 quorum after reconfiguration", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    seedVote(OWNER_UID, 1, { status: "approved" });
    seedPanel({ revision: 2, reviewerUserIds: [OWNER_UID, ADMIN_UID].sort() });
    const result = await finalizeCall({ workspaceId: WS_ID, expectedPanelRevision: 2, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(result).toEqual({ ok: false, reason: "quorum_not_met" });
  });

  it("MANDATORY cross-Workspace resource binding: caller genuinely admitted+manager in WS_ID, but the target RUN/panel canonically belongs to OTHER_WS_ID -> denied run_not_found", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: OTHER_WS_ID });
    seedPanel({ revision: 1, workspaceId: OTHER_WS_ID });
    const result = await finalizeCall({ workspaceId: WS_ID, expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});

describe("overrideWorkspaceReviewPanel — Workspace-canary target admission (Phase 10B.3.2B.2, HIGHEST-RISK FUNCTION)", () => {
  it("uid-canary only (global off), canonical Owner: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    seedPanel({ revision: 1 });
    expect((await overrideCall()).ok).toBe(true);
  });

  it("Workspace-canary only, canonical Owner with valid justification: allowed", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    const result = await overrideCall();
    expect(result).toEqual({ ok: true, status: "approved", finalizedAt: MUTATE_NOW });
  });

  it("Workspace-canary only, Admin (holds reviews.manage but NOT reviews.override — Owner-only capability): DENIED, even though target admission succeeds", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await overrideCall({ uid: ADMIN_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, Member: DENIED", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await overrideCall({ uid: MEMBER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, Reviewer: DENIED", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await overrideCall({ uid: REVIEWER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, Viewer: DENIED", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await overrideCall({ uid: VIEWER_UID })).toEqual({ ok: false, reason: "insufficient_capability" });
  });

  it("Workspace-canary only, no membership at all: denied", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    expect(await overrideCall({ uid: "outsider-1" })).toEqual({ ok: false, reason: "membership_not_found" });
  });

  it("target Workspace not admitted: denied, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID;
    seedPanel({ revision: 1 });
    const result = await overrideCall();
    expect(result).toEqual({ ok: false, reason: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = OWNER_UID;
    teamWorkspacesCanaryWorkspaceIds = "*";
    seedPanel({ revision: 1 });
    expect((await overrideCall()).ok).toBe(true);
  });

  it("MANDATORY empty justification under Workspace-canary admission: still rejected", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    const result = await overrideCall({ justification: "" });
    expect(result.ok).toBe(false);
  });

  it("MANDATORY whitespace-only justification under Workspace-canary admission: still rejected (the builder throws on justification.trim() === '')", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedPanel({ revision: 1 });
    const result = await overrideCall({ justification: "   " });
    expect(result.ok).toBe(false);
  });

  it("Owner Override remains exceptional self-action even under Workspace-canary admission: the canonical Owner MAY override their own artifact, but ONLY through this explicit route — not an ordinary-review bypass", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ userId: OWNER_UID, workspaceId: WS_ID, projectId: null, governanceRecord: validGovernanceRecord() });
    seedPanel({ revision: 1 });
    const result = await overrideCall({ uid: OWNER_UID });
    expect(result.ok).toBe(true);
  });

  it("MANDATORY cross-Workspace Owner attack: caller is the canonical Owner of WS_ID and genuinely Workspace-canary admitted to WS_ID (even holding elevated, non-owner status in OTHER_WS_ID), but the target run/panel canonically belongs to OTHER_WS_ID -> DENIED run_not_found; no owner authority crosses Workspace boundaries", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedWorkspaceById(OTHER_WS_ID);
    seedMembership(OWNER_UID, "admin", OTHER_WS_ID); // elevated but NOT owner in OTHER_WS_ID — irrelevant to the outcome either way
    seedRun({ workspaceId: OTHER_WS_ID });
    seedPanel({ revision: 1, workspaceId: OTHER_WS_ID });
    const result = await overrideCall({ workspaceId: WS_ID, expectedPanelRevision: 1, expectedGovernanceUpdatedAt: GOVERNANCE_UPDATED_AT });
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });
});
