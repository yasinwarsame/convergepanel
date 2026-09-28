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
import { readFileSync } from "fs";
import { join as joinPath } from "path";
import * as tsApi from "typescript";
import { violatesAssignmentSelfReviewGuard, violatesDecisionSelfReviewGuard } from "@/lib/workspaces/workspaceReviewEligibility";

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
/** R3: when set to a collection name, the fake transaction's `set` throws for that collection. */
const throwOnSetCollection: { value: string | null } = { value: null };
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
          // R3 §35/§36 — injectable write failure so the atomicity guarantees are COMMITTED
          // regressions instead of review-time probes. Throwing here aborts the callback before
          // any `pendingWrites` are applied, which is exactly how a real write rejection behaves.
          if (throwOnSetCollection.value !== null && ref.__collection === throwOnSetCollection.value) {
            throw new Error(`simulated write failure for ${ref.__collection}`);
          }
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
/**
 * R3 §18 — a NON-NULL Project, deliberately distinct from the Workspace id, the run id and every
 * reviewer id. R2 proved every fixture seeded `projectId: null`, so the four events' Project
 * binding was pinned only against `null` and hardcoding `null` survived.
 */
const PROJECT_ID = "projPanelAuditBinding01";
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
  throwOnSetCollection.value = null;
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

/**
 * TECH_DEBT_WORKSPACE_PANEL_MUTATION_AUDIT_COVERAGE — the audit proof.
 *
 * Phase 9D confirmed in Production that panel create/reconfigure/cancel/vote wrote NO immutable
 * secondary record, while finalize wrote 3 and Owner Override 4.
 *
 * Two review rounds found this proof layer non-discriminating, and both sets of defects are the
 * reason for the shape below:
 *   R1 — the create event's actor could come from client-supplied reviewer input and survive;
 *        reconfigure/cancel omitted `workspaceId`/`projectId`; 5 of the rejection paths were
 *        pinned; `reviewerCount` echoed the raw request.
 *   R2 — FOUR rejection branches still accepted a forged success event, most seriously an
 *        unauthorized caller's rejected vote minting `vote_cast`; the coverage "guarantee" was
 *        referenced by nothing, so deleting a case stayed green; `projectId` was pinned only
 *        against `null` because no fixture used a Project; and the governance context was
 *        compared to hardcoded literals, so its provenance was unproven.
 */
const panelEvents = () => [...stores.governanceEvents.entries()].filter(([k]) => k.startsWith(`${RUN_ID}::`)).map(([, v]) => v as Record<string, unknown>);

/**
 * R3 §23–§26 — the governance context a panel event must carry, READ BACK from the canonical
 * seeded record rather than hardcoded. R2's `GOV_CONTEXT` was a literal pair matching the default
 * fixture, so replacing the production source with those same literals survived: the values were
 * pinned, their PROVENANCE was not.
 */
const canonicalGovContext = () => {
  const run = stores.runs.get(RUN_ID) as { governanceRecord: { schemaId: string; answerShape: string } };
  return { schemaId: run.governanceRecord.schemaId, answerShape: run.governanceRecord.answerShape };
};
/** A second, deliberately NON-DEFAULT governance context, so one historical literal cannot masquerade as canonical provenance. */
const ALT_GOV = { schemaId: "evidence_review", answerShape: "evidence_review_view" } as const;

describe("panel mutation audit coverage — successful mutations", () => {
  it("panel CREATE writes exactly one created event, with its COMPLETE shape", async () => {
    const before = panelEvents().length;
    expect((await putCall()).ok).toBe(true);
    expect(panelEvents()).toHaveLength(before + 1);
    expect(panelEvents()[0]).toEqual({
      action: "adaptive_review_panel_created",
      byUid: OWNER_UID,
      at: MUTATE_NOW,
      workspaceId: WS_ID,
      projectId: null,
      panelRevision: 1,
      priorPanelRevision: null,
      reviewerCount: 2,
      ...canonicalGovContext(),
    });
  });

  it("panel RECONFIGURE writes exactly one reconfigured event, with its COMPLETE shape", async () => {
    seedPanel({ revision: 1 });
    expect((await putCall({ expectedRevision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID, REVIEWER_UID] })).ok).toBe(true);
    expect(panelEvents()).toHaveLength(1);
    expect(panelEvents()[0]).toEqual({
      action: "adaptive_review_panel_reconfigured",
      byUid: OWNER_UID,
      at: MUTATE_NOW,
      workspaceId: WS_ID,
      projectId: null,
      panelRevision: 2,
      priorPanelRevision: 1,
      reviewerCount: 3,
      ...canonicalGovContext(),
    });
  });

  it("panel CANCEL writes exactly one cancelled event, with its COMPLETE shape", async () => {
    seedPanel({ revision: 1 });
    expect((await deleteCall()).ok).toBe(true);
    expect(panelEvents()).toHaveLength(1);
    expect(panelEvents()[0]).toEqual({
      action: "adaptive_review_panel_cancelled",
      byUid: OWNER_UID,
      at: MUTATE_NOW,
      workspaceId: WS_ID,
      projectId: null,
      panelRevision: 1,
      reviewerCount: 3,
      ...canonicalGovContext(),
    });
  });

  it("VOTE writes exactly one vote_cast event, with its COMPLETE shape", async () => {
    seedPanel({ revision: 1 });
    expect((await voteCall({ status: "changes_requested", comment: "needs work", conditions: ["c1", "c2"] })).ok).toBe(true);
    expect(panelEvents()).toHaveLength(1);
    expect(panelEvents()[0]).toEqual({
      action: "adaptive_review_panel_vote_cast",
      byUid: OWNER_UID,
      at: MUTATE_NOW,
      workspaceId: WS_ID,
      projectId: null,
      panelRevision: 1,
      voteStatus: "changes_requested",
      commentPresent: true,
      conditionsCount: 2,
      ...canonicalGovContext(),
    });
  });

  // ── actor authority (R1) ──
  it("the created event's actor is the AUTHENTICATED caller, not any client-supplied reviewer", async () => {
    const reviewers = [ADMIN_UID, REVIEWER_UID];
    expect(`callerIsNotAnyReviewer:${!reviewers.includes(OWNER_UID)}`).toBe("callerIsNotAnyReviewer:true");
    expect((await putCall({ uid: OWNER_UID, reviewerUserIds: reviewers })).ok).toBe(true);
    expect(panelEvents()[0].byUid).toBe(OWNER_UID);
    expect(`actorIsNotTheFirstReviewer:${panelEvents()[0].byUid !== reviewers[0]}`).toBe("actorIsNotTheFirstReviewer:true");
  });

  it("the reconfigured event's actor is the AUTHENTICATED caller, not any client-supplied reviewer", async () => {
    seedPanel({ revision: 1 });
    const reviewers = [OWNER_UID, REVIEWER_UID];
    expect(`callerIsNotTheFirstReviewer:${reviewers[0] !== ADMIN_UID}`).toBe("callerIsNotTheFirstReviewer:true");
    expect((await putCall({ uid: ADMIN_UID, expectedRevision: 1, reviewerUserIds: reviewers })).ok).toBe(true);
    expect(panelEvents()[0].byUid).toBe(ADMIN_UID);
  });

  // ── reviewerCount provenance (R1) ──
  it("reviewerCount comes from the COMMITTED panel, not the raw request array", async () => {
    const raw = [OWNER_UID, OWNER_UID, ADMIN_UID];
    expect((await putCall({ reviewerUserIds: raw })).ok).toBe(true);
    const panel = stores.humanReviewPanel.get(`${RUN_ID}::current`) as { reviewerUserIds: string[] };
    expect(`canonicalDiffersFromRaw:${panel.reviewerUserIds.length !== raw.length}`).toBe("canonicalDiffersFromRaw:true");
    expect(panelEvents()[0].reviewerCount).toBe(panel.reviewerUserIds.length);
    expect(`eventDoesNotEchoRawLength:${panelEvents()[0].reviewerCount !== raw.length}`).toBe("eventDoesNotEchoRawLength:true");
  });

  it("an IDEMPOTENT vote replay writes NO second event — one vote, one record", async () => {
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
    expect(panelEvents()).toHaveLength(1);
    expect(await voteCall()).toMatchObject({ ok: true, submissionStatus: "already_submitted" });
    expect(panelEvents()).toHaveLength(1);
  });
});

/**
 * R3 §18–§22 — PROJECT BINDING, with a non-null Project. R2 proved every fixture used
 * `projectId: null`, so the four `toEqual`s pinned that field vacuously and hardcoding `null`
 * survived. The expected value here comes from the canonical run document read back from the
 * store, never from the request.
 */
describe("panel mutation audit coverage — canonical Project binding", () => {
  const projectBackedRun = () => seedRun({ projectId: PROJECT_ID });
  const canonicalProjectId = () => (stores.runs.get(RUN_ID) as { projectId: string | null }).projectId;

  it("the fixture really is Project-backed, and distinct from every other identifier", () => {
    projectBackedRun();
    expect(canonicalProjectId()).toBe(PROJECT_ID);
    expect([WS_ID, RUN_ID, OWNER_UID, ADMIN_UID, REVIEWER_UID]).not.toContain(PROJECT_ID);
  });

  it("CREATE binds the event to the canonical Project", async () => {
    projectBackedRun();
    expect((await putCall()).ok).toBe(true);
    expect(panelEvents()[0].projectId).toBe(canonicalProjectId());
    expect(panelEvents()[0].workspaceId).toBe(WS_ID);
  });

  it("RECONFIGURE binds the event to the canonical Project", async () => {
    projectBackedRun();
    seedPanel({ revision: 1 });
    expect((await putCall({ expectedRevision: 1 })).ok).toBe(true);
    expect(panelEvents()[0].projectId).toBe(canonicalProjectId());
  });

  it("CANCEL binds the event to the canonical Project", async () => {
    projectBackedRun();
    seedPanel({ revision: 1 });
    expect((await deleteCall()).ok).toBe(true);
    expect(panelEvents()[0].projectId).toBe(canonicalProjectId());
  });

  it("VOTE binds the event to the canonical Project", async () => {
    projectBackedRun();
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
    expect(panelEvents()[0].projectId).toBe(canonicalProjectId());
  });
});

/**
 * R3 §23–§27 — GOVERNANCE CONTEXT PROVENANCE. A second canonical context proves the event
 * projects the record rather than echoing a historical literal.
 */
describe("panel mutation audit coverage — governance context provenance", () => {
  it("a NON-DEFAULT canonical governance context appears in the event", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
    // the fixture is only discriminating if it differs from the default the other tests use
    expect(`contextIsNonDefault:${canonicalGovContext().schemaId !== "decision_support"}`).toBe("contextIsNonDefault:true");
    expect((await putCall()).ok).toBe(true);
    expect(panelEvents()[0].schemaId).toBe(ALT_GOV.schemaId);
    expect(panelEvents()[0].answerShape).toBe(ALT_GOV.answerShape);
  });

  it("the vote event carries the same non-default canonical context", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
    expect(panelEvents()[0]).toMatchObject({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape });
  });
});

/**
 * ─── R4 §5–§9, §43 — REJECTION COVERAGE KEYED TO AST DECISION-POINT IDENTITY ──────────────────
 *
 * WHY BOTH EARLIER MODELS WERE INVALID.
 *   R2 derived the inventory by scanning inline `reason: "..."` literals. That is structurally
 *   blind to a PASSTHROUGH branch — `if (!auth.ok) return { ok: false, reason: auth.reason }` —
 *   so the seven authorization reasons that reach each operation through that one line never
 *   appeared, and a forged `vote_cast` minted on the vote's authorization denial survived.
 *   R3 replaced it with a hand-written "branch" contract keyed by semantic names. That contract
 *   was SELF-REFUTING: it asserted `branches:52 uniqueOperationReasonPairs:52`, and equality of
 *   those two numbers is arithmetic proof that no reason repeated — i.e. proof the contract had
 *   collapsed every duplicate-reason return site into one entry. Seven real decision points were
 *   missing, five of them production-reachable, and a ghost event inserted before any of the seven
 *   survived the whole suite.
 *
 * THE UNIT IS NOW THE RETURN SITE, DISCOVERED FROM THE AST, not a name and not a line number.
 * `discoverRejectionSites()` parses the production module with the TypeScript compiler API and
 * emits one site per `return { ok: false, ... }` inside each in-scope function, identified by
 * `<operation>#reject-<AST ordinal within that function>`, carrying its enclosing guard
 * expression and its reason expression for review. Two returns of the SAME reason are therefore
 * two sites with two identities — which is the whole point, because a ghost write can be inserted
 * before either one independently and coverage of one is not coverage of the other. Line numbers
 * are never used, so ordinary edits above a site do not rot its identity.
 *
 * TWO LAYERS, deliberately distinct, because they count different things:
 *   • SYNTACTIC INVENTORY — 44 return sites / 39 unique (operation, reason) pairs / therefore
 *     5 duplicate-reason sites. Derived, never asserted by hand.
 *   • EXPANDED RUNTIME OBLIGATIONS — 59. The 3 `write_failed` catch returns are excluded (not
 *     decision points; the atomicity regressions below own them), leaving 41 decision sites; the
 *     3 authorization passthrough sites each expand to all 7 reachable runtime auth reasons,
 *     so 38 + 21 = 59. Of those, 3 are classified STRUCTURALLY UNREACHABLE under the shipped role
 *     matrix — with the invariant that forces it asserted, not assumed — leaving 56 executable.
 *
 * The structural invariant that matters is NOT the number 59. It is that the inventory preserves
 * every return site independently, including duplicate reasons, and that the propagated union is
 * expanded in a separate layer on top of it.
 *
 * THE RECONCILIATION never derives its expected side from the case table: it derives it from the
 * AST. Deleting a case, skipping one, duplicating one, or collapsing two duplicate-reason sites
 * back into a single `(operation, reason)` entry each leave an unmet obligation and fail.
 *
 * WHAT THIS DOES NOT CLAIM (§10, §44): the reconciliation cannot defend against a coordinated edit
 * that removes a production decision point and its case together — but it now DISCOVERS a newly
 * added one automatically and fails until a case exists, which the hand-written contract could
 * not. Running a subset of this file with `--testNamePattern` also leaves the ledger short and
 * fails the reconciliation; that is deliberate, and the full file is what CI runs.
 */
type DiscoveredRejectionSite = {
  operation: "create" | "cancel" | "vote";
  functionName: string;
  siteId: string;
  ordinal: number;
  /** Source text of the whole `reason:` initializer, normalized for whitespace. Review anchor. */
  reasonExpr: string;
  /** The statically resolved reason, or `null` when the expression is a propagated value. */
  reasonLiteral: string | null;
  isPassthrough: boolean;
  /** Source text of the enclosing guard. Review anchor; pinned exactly for the sites that matter. */
  guardExpr: string;
  guardKind: "if" | "catch" | "case" | "none";
};

const PANEL_OPERATION_FUNCTIONS: Readonly<Record<string, "create" | "cancel" | "vote">> = Object.freeze({
  putWorkspaceReviewPanel: "create",
  deleteWorkspaceReviewPanel: "cancel",
  submitWorkspaceReviewPanelVote: "vote",
});

/**
 * Pure over source text — which is what makes it falsifiable by the synthetic self-tests below
 * rather than only by its agreement with one file it was written against.
 *
 * Descends into arrow/function EXPRESSIONS (every real decision point lives inside the
 * `adminDb.runTransaction(async (tx) => { ... })` callback) but never into a nested function
 * DECLARATION, which would belong to its own enclosing name.
 */
function discoverRejectionSites(
  sourceText: string,
  functionToOperation: Readonly<Record<string, "create" | "cancel" | "vote">>
): DiscoveredRejectionSite[] {
  const sourceFile = tsApi.createSourceFile("subject.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const discovered: DiscoveredRejectionSite[] = [];
  const textOf = (node: tsApi.Node) => node.getText(sourceFile).replace(/\s+/g, " ").trim();

  /** Strips `as const` / `as T` / `satisfies T` / parentheses so a literal is still seen as one. */
  const unwrap = (node: tsApi.Expression): tsApi.Expression => {
    let current: tsApi.Expression = node;
    for (;;) {
      if (tsApi.isAsExpression(current) || tsApi.isSatisfiesExpression(current) || tsApi.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }
      return current;
    }
  };
  const propertyNamed = (object: tsApi.ObjectLiteralExpression, name: string) =>
    object.properties.find((property): property is tsApi.PropertyAssignment => tsApi.isPropertyAssignment(property) && property.name.getText(sourceFile) === name);

  const collectFrom = (functionNode: tsApi.Node, operation: "create" | "cancel" | "vote", functionName: string) => {
    let ordinal = 0;
    const visit = (node: tsApi.Node) => {
      if (node !== functionNode && (tsApi.isFunctionDeclaration(node) || tsApi.isMethodDeclaration(node))) return;
      if (tsApi.isReturnStatement(node) && node.expression && tsApi.isObjectLiteralExpression(node.expression)) {
        const okProperty = propertyNamed(node.expression, "ok");
        if (okProperty && unwrap(okProperty.initializer).kind === tsApi.SyntaxKind.FalseKeyword) {
          ordinal += 1;
          const reasonProperty = propertyNamed(node.expression, "reason");
          const reasonExpr = reasonProperty ? textOf(reasonProperty.initializer) : "<absent>";
          let reasonLiteral: string | null = null;
          if (reasonProperty) {
            const reasonValue = unwrap(reasonProperty.initializer);
            if (tsApi.isStringLiteralLike(reasonValue)) {
              reasonLiteral = reasonValue.text;
            } else if (tsApi.isObjectLiteralExpression(reasonValue)) {
              // A STRUCTURED reason (`{ kind: "target_not_eligible", ... }`) is still statically
              // known: its discriminant is what the runtime result is compared on.
              const kindProperty = propertyNamed(reasonValue, "kind");
              const kindValue = kindProperty ? unwrap(kindProperty.initializer) : undefined;
              if (kindValue && tsApi.isStringLiteralLike(kindValue)) reasonLiteral = kindValue.text;
            }
          }
          let guardExpr = "<no-guard>";
          let guardKind: DiscoveredRejectionSite["guardKind"] = "none";
          for (let ancestor: tsApi.Node | undefined = node.parent; ancestor && ancestor !== functionNode.parent; ancestor = ancestor.parent) {
            if (tsApi.isIfStatement(ancestor)) { guardExpr = textOf(ancestor.expression); guardKind = "if"; break; }
            if (tsApi.isCatchClause(ancestor)) { guardExpr = `catch(${ancestor.variableDeclaration ? textOf(ancestor.variableDeclaration) : ""})`; guardKind = "catch"; break; }
            if (tsApi.isCaseClause(ancestor)) { guardExpr = `case ${textOf(ancestor.expression)}`; guardKind = "case"; break; }
          }
          discovered.push({
            operation,
            functionName,
            siteId: `${operation}#reject-${String(ordinal).padStart(2, "0")}`,
            ordinal,
            reasonExpr,
            reasonLiteral,
            isPassthrough: reasonLiteral === null,
            guardExpr,
            guardKind,
          });
        }
      }
      tsApi.forEachChild(node, visit);
    };
    tsApi.forEachChild(functionNode, visit);
  };

  const walkTopLevel = (node: tsApi.Node) => {
    let name: string | null = null;
    let body: tsApi.Node | null = null;
    if (tsApi.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      body = node;
    } else if (tsApi.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (tsApi.isIdentifier(declaration.name) && declaration.initializer && (tsApi.isArrowFunction(declaration.initializer) || tsApi.isFunctionExpression(declaration.initializer))) {
          name = declaration.name.text;
          body = declaration.initializer;
        }
      }
    }
    if (name && body && Object.prototype.hasOwnProperty.call(functionToOperation, name)) {
      collectFrom(body, functionToOperation[name], name);
    }
    tsApi.forEachChild(node, walkTopLevel);
  };
  tsApi.forEachChild(sourceFile, walkTopLevel);
  return discovered;
}

/**
 * §43 — THE DISCOVERER'S OWN FALSIFIERS. Without these, the entire proof rests on a parser whose
 * only evidence of correctness is that it agrees with the one file it was written against — and a
 * discoverer that silently returned `[]`, or that collapsed two identical reasons into one site,
 * would make every downstream reconciliation vacuously satisfiable.
 */
const SYNTHETIC = Object.freeze({
  twoIdenticalReasons: `
    export async function synthOp(args: { x: number }) {
      return await run(async () => {
        if (args.x === 1) return { ok: false, reason: "same_reason" as const };
        if (args.x === 2) return { ok: false, reason: "same_reason" as const };
        return { ok: true };
      });
    }`,
  oneInlineLiteral: `export async function synthOp(a: number) { if (a < 0) return { ok: false, reason: "only_one" }; return { ok: true }; }`,
  passthrough: `export async function synthOp() { const auth = await check(); if (!auth.ok) return { ok: false, reason: auth.reason }; return { ok: true }; }`,
  noRejection: `export async function synthOp() { return { ok: true, value: 1 }; }`,
  structuredReason: `export async function synthOp(a: number) { if (a < 0) return { ok: false, reason: { kind: "structured_denial" as const, detail: a } }; return { ok: true }; }`,
  catchSite: `export async function synthOp() { try { return await go(); } catch (err) { return { ok: false, reason: "write_failed" }; } }`,
  unmappedNeighbour: `
    export async function synthOp(a: number) { if (a < 0) return { ok: false, reason: "mine" }; return { ok: true }; }
    export async function someOtherFunction(a: number) { if (a < 0) return { ok: false, reason: "not_mine" }; return { ok: true }; }`,
  /**
   * The scope rule, made testable in both directions: a NESTED function DECLARATION owns its own
   * rejection returns and must be excluded, while an arrow/function EXPRESSION must be descended
   * into — the real module's every decision point lives inside
   * `adminDb.runTransaction(async (tx) => { ... })`. The first draft asserted this with two
   * TOP-LEVEL siblings, which only exercised the name map: removing the nested-declaration guard
   * entirely left that test green.
   */
  nestedDeclarationAndArrow: `
    export async function synthOp(a: number) {
      function nestedHelper(b: number) { if (b < 0) return { ok: false, reason: "belongs_to_helper" }; return { ok: true }; }
      return await wrap(async () => {
        if (a < 0) return { ok: false, reason: "belongs_to_operation" };
        return nestedHelper(a);
      });
    }`,
});
const SYNTH_MAP = Object.freeze({ synthOp: "create" as const });

describe("AST rejection-site discoverer — self-falsification", () => {
  it("two IDENTICAL reasons at two return sites are TWO sites with TWO identities, not one", () => {
    const sites = discoverRejectionSites(SYNTHETIC.twoIdenticalReasons, SYNTH_MAP);
    expect(`sites:${sites.length} uniqueReasons:${new Set(sites.map((s) => s.reasonLiteral)).size} uniqueSiteIds:${new Set(sites.map((s) => s.siteId)).size}`).toBe("sites:2 uniqueReasons:1 uniqueSiteIds:2");
    expect(sites.map((s) => s.siteId)).toEqual(["create#reject-01", "create#reject-02"]);
    expect(sites.map((s) => s.guardExpr)).toEqual(["args.x === 1", "args.x === 2"]);
  });

  it("resolves an inline literal reason, through `as const`, and reports it as non-passthrough", () => {
    const [site] = discoverRejectionSites(SYNTHETIC.oneInlineLiteral, SYNTH_MAP);
    expect(`id:${site.siteId} reason:${site.reasonLiteral} passthrough:${site.isPassthrough} guard:${site.guardExpr}`).toBe("id:create#reject-01 reason:only_one passthrough:false guard:a < 0");
  });

  it("reports a PROPAGATED reason as passthrough, with its expression preserved for review", () => {
    const [site] = discoverRejectionSites(SYNTHETIC.passthrough, SYNTH_MAP);
    expect(`reason:${site.reasonLiteral} passthrough:${site.isPassthrough} expr:${site.reasonExpr} guard:${site.guardExpr}`).toBe("reason:null passthrough:true expr:auth.reason guard:!auth.ok");
  });

  it("a function with no rejection yields no sites — and a success return is never a site", () => {
    expect(discoverRejectionSites(SYNTHETIC.noRejection, SYNTH_MAP)).toEqual([]);
    expect(discoverRejectionSites(SYNTHETIC.twoIdenticalReasons, SYNTH_MAP).every((s) => s.reasonLiteral === "same_reason")).toBe(true);
  });

  it("resolves a STRUCTURED reason by its discriminant, which is what the runtime is compared on", () => {
    const [site] = discoverRejectionSites(SYNTHETIC.structuredReason, SYNTH_MAP);
    expect(`reason:${site.reasonLiteral} passthrough:${site.isPassthrough}`).toBe("reason:structured_denial passthrough:false");
    expect(site.reasonExpr).toContain("kind: \"structured_denial\"");
  });

  it("classifies a catch-clause return by its guard kind, so it can be excluded as a non-decision", () => {
    const [site] = discoverRejectionSites(SYNTHETIC.catchSite, SYNTH_MAP);
    expect(`kind:${site.guardKind} reason:${site.reasonLiteral}`).toBe("kind:catch reason:write_failed");
  });

  it("ignores a return site in a function that is not in the operation map", () => {
    const sites = discoverRejectionSites(SYNTHETIC.unmappedNeighbour, SYNTH_MAP);
    expect(sites.map((s) => s.reasonLiteral)).toEqual(["mine"]);
  });

  it("excludes a NESTED function declaration's returns but descends into an arrow expression's", () => {
    const sites = discoverRejectionSites(SYNTHETIC.nestedDeclarationAndArrow, SYNTH_MAP);
    expect(sites.map((s) => `${s.siteId}=${s.reasonLiteral}`)).toEqual(["create#reject-01=belongs_to_operation"]);
  });

  it("site identity keyed by (operation, reason) is STRICTLY WEAKER than site identity — on a two-line synthetic proof", () => {
    const sites = discoverRejectionSites(SYNTHETIC.twoIdenticalReasons, SYNTH_MAP);
    const bySite = new Set(sites.map((s) => `${s.siteId}::${s.reasonLiteral}`));
    const byOperationReason = new Set(sites.map((s) => `${s.operation}::${s.reasonLiteral}`));
    expect(`bySite:${bySite.size} byOperationReason:${byOperationReason.size}`).toBe("bySite:2 byOperationReason:1");
  });
});

/**
 * The real inventory. Read from disk at module load: if the production file moves or is renamed,
 * this throws rather than silently discovering nothing.
 */
const PANEL_MUTATIONS_SOURCE_PATH = joinPath(__dirname, "..", "workspaceReviewPanelMutations.ts");
const PANEL_MUTATIONS_SOURCE = readFileSync(PANEL_MUTATIONS_SOURCE_PATH, "utf8");
const DISCOVERED_REJECTION_SITES: readonly DiscoveredRejectionSite[] = Object.freeze(
  discoverRejectionSites(PANEL_MUTATIONS_SOURCE, PANEL_OPERATION_FUNCTIONS).map((site) => Object.freeze(site))
);

/** `write_failed` is the transaction-failure catch, not a decision. The atomicity suite owns it. */
const WRITE_FAILED_SITES: readonly DiscoveredRejectionSite[] = DISCOVERED_REJECTION_SITES.filter((s) => s.guardKind === "catch");
const DECISION_SITES: readonly DiscoveredRejectionSite[] = DISCOVERED_REJECTION_SITES.filter((s) => s.guardKind !== "catch");

const AUTH_DENIAL_REASONS = ["workspace_not_found", "workspace_malformed", "membership_not_found", "membership_malformed", "membership_removed", "owner_integrity_violation", "insufficient_capability"] as const;

/**
 * §8 — STRUCTURALLY PRESENT, UNREACHABLE UNDER THE SHIPPED ROLE MATRIX. Classified, never
 * dropped: each entry names the invariant that makes it unreachable, and that invariant is
 * ASSERTED below against the real capability matrix and the real predicates. If a future role or
 * predicate change breaks one, the invariant test fails and demands a real executable case — the
 * classification fails closed rather than quietly excusing a now-reachable branch.
 *
 * The guard expression is pinned for each, because site ids are AST ORDINALS: inserting a new
 * decision point above one of these would otherwise silently re-point the exclusion at a
 * different, reachable branch.
 */
const STRUCTURALLY_UNREACHABLE_SITES: Readonly<Record<string, { guardExpr: string; reason: string; invariant: string }>> = Object.freeze({
  "create#reject-04": Object.freeze({
    guardExpr: '!roleHasCapability(auth.membership.role, "research.read")',
    reason: "insufficient_capability",
    invariant: "the authorization above already required reviews.manage, and every shipped role holding reviews.manage also holds research.read",
  }),
  "cancel#reject-04": Object.freeze({
    guardExpr: '!roleHasCapability(auth.membership.role, "research.read")',
    reason: "insufficient_capability",
    invariant: "the authorization above already required reviews.manage, and every shipped role holding reviews.manage also holds research.read",
  }),
  "vote#reject-13": Object.freeze({
    guardExpr: "!eligibility.eligible",
    reason: "not_reviewer",
    invariant:
      "isValidAssignmentTarget can only deny for four reasons here, and each is already excluded: `removed` by authorization's own membership_removed denial (vote#reject-03::membership_removed); `cross_workspace` because candidate.workspaceId and runWorkspaceId are BOTH args.workspaceId; `self_review` because vote#reject-11 already returned on the identical UID-equality predicate; `insufficient_capability` because authorization required reviews.submit and every shipped role holding reviews.submit also holds research.read",
  }),
});

/**
 * §7 — the expanded runtime obligation layer, derived from the AST inventory. A passthrough site
 * carries the whole propagated union; every other site carries exactly its own reason.
 */
const obligationKey = (siteId: string, reason: string) => `${siteId}::${reason}`;
const EXPANDED_OBLIGATIONS: readonly string[] = Object.freeze(
  DECISION_SITES.flatMap((site) => (site.isPassthrough ? AUTH_DENIAL_REASONS.map((reason) => obligationKey(site.siteId, reason)) : [obligationKey(site.siteId, site.reasonLiteral as string)]))
);
const EXECUTABLE_OBLIGATIONS: readonly string[] = Object.freeze(
  EXPANDED_OBLIGATIONS.filter((obligation) => !Object.prototype.hasOwnProperty.call(STRUCTURALLY_UNREACHABLE_SITES, obligation.slice(0, obligation.indexOf("::"))))
);

describe("AST rejection-site inventory — the production module's real decision points", () => {
  it("the inventory reconciles: 44 return sites, 39 unique (operation, reason) pairs, 5 duplicate-reason sites", () => {
    const uniquePairs = new Set(DISCOVERED_REJECTION_SITES.map((s) => `${s.operation}:${s.reasonExpr}`)).size;
    expect(`sites:${DISCOVERED_REJECTION_SITES.length} uniquePairs:${uniquePairs} duplicateReasonSites:${DISCOVERED_REJECTION_SITES.length - uniquePairs}`).toBe("sites:44 uniquePairs:39 duplicateReasonSites:5");
  });

  it("SANITY: strictly more return sites than unique (operation, reason) pairs — so the two keyings cannot be interchangeable", () => {
    const uniquePairs = new Set(DISCOVERED_REJECTION_SITES.map((s) => `${s.operation}:${s.reasonExpr}`)).size;
    expect(`sitesExceedPairs:${DISCOVERED_REJECTION_SITES.length > uniquePairs}`).toBe("sitesExceedPairs:true");
  });

  it("all three operations were really parsed — a discoverer that found nothing cannot pass", () => {
    const perOperation = (["create", "cancel", "vote"] as const).map((op) => `${op}:${DISCOVERED_REJECTION_SITES.filter((s) => s.operation === op).length}`);
    expect(perOperation.join(" ")).toBe("create:14 cancel:13 vote:17");
    expect(new Set(DISCOVERED_REJECTION_SITES.map((s) => s.functionName))).toEqual(new Set(Object.keys(PANEL_OPERATION_FUNCTIONS)));
  });

  it("every site id is unique, ordinals are dense and 1-based within each operation", () => {
    expect(new Set(DISCOVERED_REJECTION_SITES.map((s) => s.siteId)).size).toBe(DISCOVERED_REJECTION_SITES.length);
    for (const operation of ["create", "cancel", "vote"] as const) {
      const ordinals = DISCOVERED_REJECTION_SITES.filter((s) => s.operation === operation).map((s) => s.ordinal);
      expect(`${operation}:${ordinals.join(",")}`).toBe(`${operation}:${ordinals.map((_, i) => i + 1).join(",")}`);
    }
  });

  it("the FIVE duplicate-reason sites are exactly the expected pairs, with their distinguishing guards pinned", () => {
    const byPair = new Map<string, DiscoveredRejectionSite[]>();
    for (const site of DISCOVERED_REJECTION_SITES) {
      const key = `${site.operation}:${site.reasonExpr}`;
      byPair.set(key, [...(byPair.get(key) ?? []), site]);
    }
    const duplicates = [...byPair.values()].filter((sites) => sites.length > 1);
    expect(duplicates.map((sites) => `${sites[0].operation}:${sites[0].reasonLiteral}=${sites.map((s) => s.siteId).join("+")}`).sort()).toEqual([
      "cancel:run_not_found=cancel#reject-05+cancel#reject-06",
      "create:panel_finalized=create#reject-10+create#reject-11",
      "create:run_not_found=create#reject-05+create#reject-06",
      "vote:not_reviewer=vote#reject-12+vote#reject-13",
      "vote:run_not_found=vote#reject-04+vote#reject-05",
    ]);
    // The guards are what make them genuinely different decisions rather than a stylistic repeat.
    const guardOf = (siteId: string) => DISCOVERED_REJECTION_SITES.find((s) => s.siteId === siteId)?.guardExpr;
    expect(guardOf("create#reject-05")).toBe("!runSnap.exists");
    expect(guardOf("create#reject-06")).toBe('target.kind !== "valid_workspace_review_target"');
    expect(guardOf("create#reject-10")).toBe('current.status === "finalized"');
    expect(guardOf("create#reject-11")).toBe('current.status !== "open"');
    expect(guardOf("cancel#reject-05")).toBe("!runSnap.exists");
    expect(guardOf("cancel#reject-06")).toBe('target.kind !== "valid_workspace_review_target"');
    expect(guardOf("vote#reject-04")).toBe("!runSnap.exists");
    expect(guardOf("vote#reject-05")).toBe('target.kind !== "valid_workspace_review_target"');
    expect(guardOf("vote#reject-12")).toBe("!panel.reviewerUserIds.includes(args.uid)");
    expect(guardOf("vote#reject-13")).toBe("!eligibility.eligible");
  });

  it("the ONLY passthrough sites are the three authorization denials — nothing else is silently expanded to the auth union", () => {
    const passthrough = DECISION_SITES.filter((s) => s.isPassthrough);
    expect(passthrough.map((s) => `${s.siteId}=${s.reasonExpr}|${s.guardExpr}`)).toEqual([
      "create#reject-03=auth.reason|!auth.ok",
      "cancel#reject-03=auth.reason|!auth.ok",
      "vote#reject-03=auth.reason|!auth.ok",
    ]);
  });

  it("the three excluded catch returns are exactly the write_failed sites", () => {
    expect(WRITE_FAILED_SITES.map((s) => `${s.siteId}=${s.reasonLiteral}`)).toEqual(["create#reject-14=write_failed", "cancel#reject-13=write_failed", "vote#reject-17=write_failed"]);
    expect(`decisionSites:${DECISION_SITES.length}`).toBe("decisionSites:41");
  });

  it("the obligation layers reconcile: 41 decision sites -> 59 expanded -> 3 unreachable -> 56 executable", () => {
    expect(`expanded:${EXPANDED_OBLIGATIONS.length} unreachableSites:${Object.keys(STRUCTURALLY_UNREACHABLE_SITES).length} executable:${EXECUTABLE_OBLIGATIONS.length}`).toBe("expanded:59 unreachableSites:3 executable:56");
    expect(new Set(EXPANDED_OBLIGATIONS).size).toBe(EXPANDED_OBLIGATIONS.length);
  });

  it("every STRUCTURALLY UNREACHABLE site really exists, at the guard the classification names", () => {
    for (const [siteId, classification] of Object.entries(STRUCTURALLY_UNREACHABLE_SITES)) {
      const site = DISCOVERED_REJECTION_SITES.find((s) => s.siteId === siteId);
      expect(`${siteId}:found:${Boolean(site)}`).toBe(`${siteId}:found:true`);
      expect(`${siteId}:guard:${site?.guardExpr}`).toBe(`${siteId}:guard:${classification.guardExpr}`);
      expect(`${siteId}:reason:${site?.reasonLiteral}`).toBe(`${siteId}:reason:${classification.reason}`);
      expect(`${siteId}:invariantDocumented:${classification.invariant.length > 40}`).toBe(`${siteId}:invariantDocumented:true`);
    }
  });

  it("INVARIANT behind create#reject-04 / cancel#reject-04: every shipped role with reviews.manage also has research.read", () => {
    const roles = Object.keys(actualCapabilities.ROLE_CAPABILITIES) as (keyof typeof actualCapabilities.ROLE_CAPABILITIES)[];
    expect(roles.length).toBeGreaterThan(0);
    const managers = roles.filter((role) => actualCapabilities.roleHasCapability(role, "reviews.manage"));
    expect(`rolesWithReviewsManage:${managers.join(",")}`).toBe("rolesWithReviewsManage:owner,admin");
    const violating = managers.filter((role) => !actualCapabilities.roleHasCapability(role, "research.read"));
    expect(`managersLackingResearchRead:${violating.join(",")}`).toBe("managersLackingResearchRead:");
  });

  it("INVARIANT behind vote#reject-13: every shipped role with reviews.submit also has research.read, and the two self-review predicates are the same predicate", () => {
    const roles = Object.keys(actualCapabilities.ROLE_CAPABILITIES) as (keyof typeof actualCapabilities.ROLE_CAPABILITIES)[];
    const submitters = roles.filter((role) => actualCapabilities.roleHasCapability(role, "reviews.submit"));
    expect(`rolesWithReviewsSubmit:${submitters.join(",")}`).toBe("rolesWithReviewsSubmit:owner,admin,member,reviewer");
    expect(`submittersLackingResearchRead:${submitters.filter((role) => !actualCapabilities.roleHasCapability(role, "research.read")).join(",")}`).toBe("submittersLackingResearchRead:");
    const uids = [OWNER_UID, ADMIN_UID, CREATOR_UID, REVIEWER_UID, UNSEEDED_UID];
    const disagreements = uids.flatMap((a) => uids.filter((b) => violatesDecisionSelfReviewGuard(a, b) !== violatesAssignmentSelfReviewGuard(a, b)).map((b) => `${a}/${b}`));
    expect(`selfReviewPredicateDisagreements:${disagreements.join(",")}`).toBe("selfReviewPredicateDisagreements:");
  });
});

const UNSEEDED_UID = "nobody-1";
const FINALIZED = { status: "finalized", finalizedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", finalizedByUserId: OWNER_UID, finalStatus: "approved", finalDecisionId: "panel_workspace_dec_x", aggregationPolicyVersion: 1 };
const notPendingRun = () => seedRun({ governanceRecord: validGovernanceRecord({ humanReview: { status: "approved", reviewedAt: GOVERNANCE_UPDATED_AT } }) });
/** A run bound to a DIFFERENT Workspace than the caller's — `resolveWorkspaceReviewTarget` -> `wrong_workspace`. */
const foreignWorkspaceRun = () => seedRun({ workspaceId: OTHER_WS_ID });

/** Puts the caller into the named authorization-denial state. Shared by all three operations. */
function seedAuthDenial(reason: (typeof AUTH_DENIAL_REASONS)[number], callerUid: string, capabilityRole: string) {
  if (reason === "workspace_not_found") { stores.workspaces.delete(WS_ID); return callerUid; }
  if (reason === "workspace_malformed") { seedWorkspace({ type: "personal" }); return callerUid; }
  if (reason === "membership_not_found") return UNSEEDED_UID;
  if (reason === "membership_malformed") { seedMembership(callerUid, capabilityRole, WS_ID, { uid: "someone-else" }); return callerUid; }
  if (reason === "membership_removed") { seedMembership(callerUid, capabilityRole, WS_ID, { status: "removed" }); return callerUid; }
  if (reason === "owner_integrity_violation") { seedMembership(ADMIN_UID, "owner"); return ADMIN_UID; }
  // insufficient_capability must use a NON-OWNER caller. Downgrading the workspace owner's own
  // membership instead trips the owner-integrity check FIRST (the caller is still
  // `workspace.ownerUserId`), which is how the first draft of this helper asserted
  // `insufficient_capability` while actually exercising `owner_integrity_violation`.
  return VIEWER_UID; // seeded "viewer": holds neither reviews.manage nor reviews.submit

}

/**
 * `setup` runs BEFORE the event-count snapshot, for sites whose prerequisites include a genuinely
 * successful prior mutation. `vote_conflict` needs an accepted first vote, which legitimately
 * writes its own event — measuring the delta across both would have counted that event against the
 * rejection, so the first draft reported `eventDelta:1` and failed honestly.
 *
 * Every case declares the DISCOVERED site id it exercises. It is not a label: the reconciliation
 * below matches these against the AST inventory, so a case aimed at a site that does not exist, or
 * a site with no case, fails.
 */
type RejectionCase = { siteId: string; reason: string; setup?: () => Promise<void> | void; run: () => Promise<{ ok: boolean; reason?: unknown }> };
const REJECTION_CASES: readonly RejectionCase[] = [
  // ── create ──
  { siteId: "create#reject-01", reason: "team_workspaces_disabled", run: () => { teamWorkspacesEnabled = false; return putCall(); } },
  { siteId: "create#reject-02", reason: "firestore_unavailable", run: () => { firestoreUnavailableFlag.value = true; return putCall(); } },
  ...AUTH_DENIAL_REASONS.map((reason) => ({ siteId: "create#reject-03", reason, run: () => { const uid = seedAuthDenial(reason, OWNER_UID, "owner"); return putCall({ uid }); } })),
  { siteId: "create#reject-05", reason: "run_not_found", run: () => { stores.runs.delete(RUN_ID); return putCall(); } },
  { siteId: "create#reject-06", reason: "run_not_found", run: () => { foreignWorkspaceRun(); return putCall(); } },
  { siteId: "create#reject-07", reason: "not_pending", run: () => { notPendingRun(); return putCall(); } },
  { siteId: "create#reject-08", reason: "single_review_active", run: () => { seedAssignment({ assignedReviewerUserId: REVIEWER_UID }); return putCall(); } },
  { siteId: "create#reject-09", reason: "panel_unreadable", run: () => { stores.humanReviewPanel.set(`${RUN_ID}::current`, { kind: "not-a-panel" }); return putCall(); } },
  { siteId: "create#reject-10", reason: "panel_finalized", run: () => { seedPanel({ revision: 1, ...FINALIZED }); return putCall({ expectedRevision: 1 }); } },
  { siteId: "create#reject-11", reason: "panel_finalized", run: () => { seedPanel({ revision: 1, status: "cancelled" }); return putCall({ expectedRevision: 1 }); } },
  { siteId: "create#reject-12", reason: "stale_revision", run: () => { seedPanel({ revision: 3 }); return putCall({ expectedRevision: 0 }); } },
  { siteId: "create#reject-13", reason: "target_not_eligible", run: () => putCall({ reviewerUserIds: [OWNER_UID, VIEWER_UID] }) },
  // ── cancel ──
  { siteId: "cancel#reject-01", reason: "team_workspaces_disabled", run: () => { teamWorkspacesEnabled = false; return deleteCall(); } },
  { siteId: "cancel#reject-02", reason: "firestore_unavailable", run: () => { firestoreUnavailableFlag.value = true; return deleteCall(); } },
  ...AUTH_DENIAL_REASONS.map((reason) => ({ siteId: "cancel#reject-03", reason, run: () => { seedPanel({ revision: 1 }); const uid = seedAuthDenial(reason, OWNER_UID, "owner"); return deleteCall({ uid }); } })),
  { siteId: "cancel#reject-05", reason: "run_not_found", run: () => { seedPanel({ revision: 1 }); stores.runs.delete(RUN_ID); return deleteCall(); } },
  { siteId: "cancel#reject-06", reason: "run_not_found", run: () => { seedPanel({ revision: 1 }); foreignWorkspaceRun(); return deleteCall(); } },
  { siteId: "cancel#reject-07", reason: "not_pending", run: () => { seedPanel({ revision: 1 }); notPendingRun(); return deleteCall(); } },
  { siteId: "cancel#reject-08", reason: "panel_absent", run: () => deleteCall() },
  { siteId: "cancel#reject-09", reason: "panel_unreadable", run: () => { stores.humanReviewPanel.set(`${RUN_ID}::current`, { kind: "not-a-panel" }); return deleteCall(); } },
  { siteId: "cancel#reject-10", reason: "panel_finalized", run: () => { seedPanel({ revision: 1, ...FINALIZED }); return deleteCall(); } },
  { siteId: "cancel#reject-11", reason: "panel_already_cancelled", run: () => { seedPanel({ revision: 1, status: "cancelled" }); return deleteCall(); } },
  { siteId: "cancel#reject-12", reason: "stale_revision", run: () => { seedPanel({ revision: 3 }); return deleteCall({ expectedRevision: 1 }); } },
  // ── vote ──
  { siteId: "vote#reject-01", reason: "team_workspaces_disabled", run: () => { teamWorkspacesEnabled = false; return voteCall(); } },
  { siteId: "vote#reject-02", reason: "firestore_unavailable", run: () => { firestoreUnavailableFlag.value = true; return voteCall(); } },
  ...AUTH_DENIAL_REASONS.map((reason) => ({ siteId: "vote#reject-03", reason, run: () => { seedPanel({ revision: 1 }); const uid = seedAuthDenial(reason, OWNER_UID, "owner"); return voteCall({ uid }); } })),
  { siteId: "vote#reject-04", reason: "run_not_found", run: () => { seedPanel({ revision: 1 }); stores.runs.delete(RUN_ID); return voteCall(); } },
  // The worst ghost-event case in the whole module: a REJECTED cross-Workspace vote must not mint
  // `vote_cast` on a foreign Workspace's run document.
  { siteId: "vote#reject-05", reason: "run_not_found", run: () => { seedPanel({ revision: 1 }); foreignWorkspaceRun(); return voteCall(); } },
  { siteId: "vote#reject-06", reason: "not_pending", run: () => { seedPanel({ revision: 1 }); notPendingRun(); return voteCall(); } },
  { siteId: "vote#reject-07", reason: "panel_absent", run: () => voteCall() },
  { siteId: "vote#reject-08", reason: "panel_unreadable", run: () => { stores.humanReviewPanel.set(`${RUN_ID}::current`, { kind: "not-a-panel" }); return voteCall(); } },
  { siteId: "vote#reject-09", reason: "panel_not_open", run: () => { seedPanel({ revision: 1, status: "cancelled" }); return voteCall(); } },
  { siteId: "vote#reject-10", reason: "panel_stale", run: () => { seedPanel({ revision: 2 }); return voteCall({ panelRevision: 1 }); } },
  { siteId: "vote#reject-11", reason: "self_review", run: () => { seedPanel({ revision: 1, reviewerUserIds: [CREATOR_UID, OWNER_UID] }); return voteCall({ uid: CREATOR_UID }); } },
  { siteId: "vote#reject-12", reason: "not_reviewer", run: () => { seedPanel({ revision: 1 }); return voteCall({ uid: REVIEWER2_UID }); } },
  { siteId: "vote#reject-14", reason: "review_content_unavailable", run: () => { seedPanel({ revision: 1 }); seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false } }) }); return voteCall(); } },
  { siteId: "vote#reject-15", reason: "vote_malformed", run: () => { seedPanel({ revision: 1 }); stores.humanReviewVotes.set(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`, { kind: "not-a-vote" }); return voteCall(); } },
  { siteId: "vote#reject-16", reason: "vote_conflict", setup: async () => { seedPanel({ revision: 1 }); expect((await voteCall({ status: "approved" })).ok).toBe(true); }, run: () => voteCall({ status: "changes_requested" }) },
];

/** The per-run execution ledger. Asserted against the AST INVENTORY, never against the case table. */
const executedObligations: string[] = [];
const reasonOf = (r: { reason?: unknown }) => (typeof r.reason === "string" ? r.reason : (r.reason as { kind?: string } | undefined)?.kind);

describe("panel mutation audit coverage — zero ghost events at every discovered decision site", () => {
  it.each(REJECTION_CASES.map((c) => [`${c.siteId} -> ${c.reason}`, c] as const))("%s rejects with its own reason and writes no event", async (label, testCase) => {
    if (testCase.setup) await testCase.setup();
    const before = panelEvents().length;
    const result = await testCase.run();
    expect(`${label}:rejected:${result.ok}`).toBe(`${label}:rejected:false`);
    expect(`${label}:reason:${reasonOf(result)}`).toBe(`${label}:reason:${testCase.reason}`);
    expect(`${label}:eventDelta:${panelEvents().length - before}`).toBe(`${label}:eventDelta:0`);
    executedObligations.push(obligationKey(testCase.siteId, testCase.reason));
  });

  /**
   * §43 — THE RECONCILIATION. The expected side is the AST inventory, maintained by the compiler
   * rather than by hand, so this fails on a deleted case, a skipped case, a duplicated case, a
   * case aimed at a non-existent site, a NEW production decision point with no case, and — the
   * property R3's contract could not express — two duplicate-reason sites collapsed into one.
   */
  it("every executable obligation discovered in the source was executed exactly once", () => {
    expect([...executedObligations].sort()).toEqual([...EXECUTABLE_OBLIGATIONS].sort());
    expect(`executed:${executedObligations.length} executable:${EXECUTABLE_OBLIGATIONS.length} duplicates:${executedObligations.length - new Set(executedObligations).size}`).toBe(`executed:56 executable:56 duplicates:0`);
  });

  it("no case is aimed at a site that does not exist, or at a site classified unreachable", () => {
    const knownSiteIds = new Set(DECISION_SITES.map((s) => s.siteId));
    const unknown = REJECTION_CASES.filter((c) => !knownSiteIds.has(c.siteId)).map((c) => c.siteId);
    expect(`casesAtUnknownSites:${[...new Set(unknown)].join(",")}`).toBe("casesAtUnknownSites:");
    const excused = REJECTION_CASES.filter((c) => Object.prototype.hasOwnProperty.call(STRUCTURALLY_UNREACHABLE_SITES, c.siteId)).map((c) => c.siteId);
    expect(`casesAtSitesClaimedUnreachable:${[...new Set(excused)].join(",")}`).toBe("casesAtSitesClaimedUnreachable:");
  });

  it("every case's declared reason is one the AST says that site can actually return", () => {
    const siteById = new Map(DECISION_SITES.map((s) => [s.siteId, s]));
    const inconsistent = REJECTION_CASES.filter((c) => {
      const site = siteById.get(c.siteId);
      if (!site) return true;
      return site.isPassthrough ? !(AUTH_DENIAL_REASONS as readonly string[]).includes(c.reason) : site.reasonLiteral !== c.reason;
    }).map((c) => `${c.siteId}/${c.reason}`);
    expect(`casesDisagreeingWithTheSource:${inconsistent.join(",")}`).toBe("casesDisagreeingWithTheSource:");
  });

  /**
   * §43, the acceptance test — COLLAPSE AND DELETION FALSIFIERS, executable rather than asserted.
   *
   * (1) Re-keying reconciliation by `(operation, reason)` is STRICTLY WEAKER: it has fewer
   *     obligations than there are sites, so the two keyings are not interchangeable and the
   *     collapsed one cannot be substituted without losing coverage.
   * (2) Deleting `create#reject-06`'s coverage FAILS under site identity and PASSES under
   *     `(operation, reason)`, because `create#reject-05` returns the same `run_not_found`. That
   *     masking is exactly what R3's contract did, and it is why site identity is load-bearing.
   */
  it("keying by (operation, reason) is strictly weaker than keying by discovered site", () => {
    const collapse = (obligation: string) => `${obligation.slice(0, obligation.indexOf("#"))}::${obligation.slice(obligation.indexOf("::") + 2)}`;
    expect(`bySite:${new Set(EXECUTABLE_OBLIGATIONS).size} byOperationReason:${new Set(EXECUTABLE_OBLIGATIONS.map(collapse)).size}`).toBe("bySite:56 byOperationReason:52");
    // 59 -> 52 is SEVEN masked sites, not five: collapsing additionally merges each inline
    // `insufficient_capability` twin (create#reject-04, cancel#reject-04) onto the authorization
    // passthrough's own `insufficient_capability`, and vote#reject-13 onto vote#reject-12. A
    // reason-keyed proof cannot even express those three sites separately.
    expect(`allExpandedBySite:${new Set(EXPANDED_OBLIGATIONS).size} allExpandedCollapsed:${new Set(EXPANDED_OBLIGATIONS.map(collapse)).size}`).toBe("allExpandedBySite:59 allExpandedCollapsed:52");
  });

  it.each([
    ["create#reject-06", "create#reject-05", "run_not_found"],
    ["create#reject-05", "create#reject-06", "run_not_found"],
    ["vote#reject-05", "vote#reject-04", "run_not_found"],
    ["create#reject-11", "create#reject-10", "panel_finalized"],
  ])("deleting %s's coverage is caught by site identity and MASKED by its %s twin (both return %s)", (deleted, twin, reason) => {
    const collapse = (obligation: string) => `${obligation.slice(0, obligation.indexOf("#"))}::${obligation.slice(obligation.indexOf("::") + 2)}`;
    const ledgerWithDeletion = executedObligations.filter((o) => !o.startsWith(`${deleted}::`));
    // the twin really does still cover the same (operation, reason) pair — that is the masking
    expect(ledgerWithDeletion.some((o) => o === obligationKey(twin, reason))).toBe(true);
    // site identity: the obligation is now unmet
    const missingBySite = EXECUTABLE_OBLIGATIONS.filter((o) => !new Set(ledgerWithDeletion).has(o));
    expect(missingBySite).toEqual([obligationKey(deleted, reason)]);
    // (operation, reason) identity: nothing appears missing at all
    const collapsedLedger = new Set(ledgerWithDeletion.map(collapse));
    const missingCollapsed = [...new Set(EXECUTABLE_OBLIGATIONS.map(collapse))].filter((o) => !collapsedLedger.has(o));
    expect(missingCollapsed).toEqual([]);
  });
});

/**
 * ─── R4 §14–§22 — CANCEL EVENT PROVENANCE MATRIX ──────────────────────────────────────────────
 *
 * R3 found that 5 of the cancel event's 9 fields survived being re-sourced from a DIFFERENT value
 * reachable at the same point in the transaction — most seriously `byUid`, where replacing the
 * authenticated caller with the panel's `createdByUserId` left the whole suite green. R3 reported
 * that as a production attribution defect. It is not: `byUid: args.uid` traces to
 * `getUid()` -> `resolveRequestIdentity(req).uid`, so the shipped source is the authenticated
 * caller and is correct. The defect was entirely in the PROOF — every cancel fixture happened to
 * make the caller, the panel creator, the run creator, the Workspace owner and the first reviewer
 * the same identity, so no assertion could tell a correct source from a hostile one. The
 * production source is therefore deliberately unchanged; this suite is what changes.
 *
 * The fixture below makes every authority-bearing field's correct source differ in VALUE from
 * every other value reachable at the event site, and asserts that discrimination BEFORE the
 * production call, so a future fixture regression that re-collapses two identities fails here
 * rather than silently making the field assertions vacuous again.
 *
 * Two fields cannot be discriminated, and are classified EQUIVALENT with the invariant that forces
 * the equality on every path that reaches the event — never with "no test could tell":
 *   • `workspaceId` <- `args.workspaceId` instead of `target.workspaceId`:
 *     `resolveWorkspaceReviewTarget` returns `wrong_workspace` unless the run's stored
 *     `workspaceId` equals the requested one, and `cancel#reject-06` returns on anything that is
 *     not a valid target — so the two are provably equal here.
 *   • `reviewerCount` <- `current.requiredReviewerCount` instead of `reviewerUserIds.length`:
 *     `parseAdaptiveHumanReviewPanel` returns `malformed` unless
 *     `requiredReviewerCount === reviewerUserIds.length`, and `cancel#reject-09` returns
 *     `panel_unreadable` on a malformed panel — so the two are provably equal here.
 * `panelRevision` <- `args.expectedRevision` is equivalent for the same class of reason
 * (`cancel#reject-12`) and is recorded in the production source's own comment on the vote path.
 */
const CANCEL_PROVENANCE_CALLER = ADMIN_UID;
const CANCEL_PROVENANCE_REVIEWERS = [OWNER_UID, REVIEWER_UID, REVIEWER2_UID];
const CANCEL_PROVENANCE_REVISION = 5;
const CANCEL_PROVENANCE_PANEL_CREATED_AT = "2026-07-02T00:00:00.000Z";
const CANCEL_PROVENANCE_PANEL_UPDATED_AT = "2026-07-03T00:00:00.000Z";
/** The panel's Workspace/Project mirror is DISCOVERY metadata, never authority — so it is seeded STALE on purpose. */
const STALE_PANEL_WORKSPACE_MIRROR = "wsPanelMirrorStale01";
const STALE_PANEL_PROJECT_MIRROR = "projPanelMirrorStale01";

describe("panel mutation audit coverage — cancel event provenance", () => {
  const storedRun = () => stores.runs.get(RUN_ID) as { userId: string; workspaceId: string; projectId: string | null; governanceRecord: { schemaId: string; answerShape: string } };
  const storedPanel = () => stores.humanReviewPanel.get(`${RUN_ID}::current`) as { revision: number; reviewerUserIds: string[]; requiredReviewerCount: number; quorum: number; createdByUserId: string; updatedByUserId: string; createdAt: string; updatedAt: string; workspaceId: string; projectId: string | null };
  const storedWorkspace = () => stores.workspaces.get(WS_ID) as { ownerUserId: string };

  function seedProvenanceFixture() {
    seedRun({ projectId: PROJECT_ID, governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
    seedPanel({
      revision: CANCEL_PROVENANCE_REVISION,
      reviewerUserIds: CANCEL_PROVENANCE_REVIEWERS,
      createdByUserId: REVIEWER_UID,
      updatedByUserId: REVIEWER2_UID,
      createdAt: CANCEL_PROVENANCE_PANEL_CREATED_AT,
      updatedAt: CANCEL_PROVENANCE_PANEL_UPDATED_AT,
      workspaceId: STALE_PANEL_WORKSPACE_MIRROR,
      projectId: STALE_PANEL_PROJECT_MIRROR,
    });
  }
  const provenanceCancel = () => deleteCall({ uid: CANCEL_PROVENANCE_CALLER, expectedRevision: CANCEL_PROVENANCE_REVISION });

  /**
   * One row per authority-bearing field. `discriminated` lists every OTHER value reachable at the
   * event site that the field could plausibly have been sourced from; `equivalent` lists the
   * sources a preceding guard proves equal, each with that guard named.
   */
  type ProvenanceRow = {
    field: string;
    correctSource: string;
    correct: () => unknown;
    discriminated: readonly (readonly [string, () => unknown])[];
    equivalent: readonly (readonly [string, () => unknown, string])[];
  };
  const PROVENANCE_MATRIX: readonly ProvenanceRow[] = [
    {
      field: "byUid",
      correctSource: "args.uid (the authenticated caller)",
      correct: () => CANCEL_PROVENANCE_CALLER,
      discriminated: [
        ["current.createdByUserId", () => storedPanel().createdByUserId],
        ["current.updatedByUserId", () => storedPanel().updatedByUserId],
        ["target.creatorUid", () => storedRun().userId],
        ["current.reviewerUserIds[0]", () => storedPanel().reviewerUserIds[0]],
        ["workspace.ownerUserId", () => storedWorkspace().ownerUserId],
      ],
      equivalent: [],
    },
    {
      field: "at",
      correctSource: "now (the request's own clock)",
      correct: () => MUTATE_NOW,
      discriminated: [
        ["current.createdAt", () => storedPanel().createdAt],
        ["current.updatedAt", () => storedPanel().updatedAt],
        ["govParse.record.updatedAt", () => GOVERNANCE_UPDATED_AT],
      ],
      equivalent: [],
    },
    {
      field: "workspaceId",
      correctSource: "target.workspaceId (the run's stored, authoritative binding)",
      correct: () => storedRun().workspaceId,
      discriminated: [["current.workspaceId (stale discovery mirror)", () => storedPanel().workspaceId]],
      equivalent: [["args.workspaceId", () => WS_ID, "resolveWorkspaceReviewTarget yields wrong_workspace unless run.workspaceId === args.workspaceId, and cancel#reject-06 returns on any non-valid target"]],
    },
    {
      field: "projectId",
      correctSource: "target.projectId (the run's stored Project)",
      correct: () => storedRun().projectId,
      discriminated: [
        ["current.projectId (stale discovery mirror)", () => storedPanel().projectId],
        ["hardcoded null", () => null],
        ["target.workspaceId", () => storedRun().workspaceId],
      ],
      equivalent: [],
    },
    {
      field: "panelRevision",
      correctSource: "current.revision (the canonical panel being cancelled)",
      correct: () => storedPanel().revision,
      discriminated: [
        ["current.quorum", () => storedPanel().quorum],
        ["current.reviewerUserIds.length", () => storedPanel().reviewerUserIds.length],
        ["current.requiredReviewerCount", () => storedPanel().requiredReviewerCount],
        ["hardcoded 0", () => 0],
      ],
      equivalent: [["args.expectedRevision", () => CANCEL_PROVENANCE_REVISION, "cancel#reject-12 returns stale_revision unless current.revision === args.expectedRevision"]],
    },
    {
      field: "reviewerCount",
      correctSource: "current.reviewerUserIds.length (the canonical roster)",
      correct: () => storedPanel().reviewerUserIds.length,
      discriminated: [
        ["current.quorum", () => storedPanel().quorum],
        ["current.revision", () => storedPanel().revision],
        ["hardcoded 0", () => 0],
      ],
      equivalent: [["current.requiredReviewerCount", () => storedPanel().requiredReviewerCount, "parseAdaptiveHumanReviewPanel yields malformed unless requiredReviewerCount === reviewerUserIds.length, and cancel#reject-09 returns panel_unreadable on a malformed panel"]],
    },
    {
      field: "schemaId",
      correctSource: "govParse.record.schemaId",
      correct: () => storedRun().governanceRecord.schemaId,
      discriminated: [
        ["the default fixture literal", () => "decision_support"],
        ["govParse.record.answerShape", () => storedRun().governanceRecord.answerShape],
      ],
      equivalent: [],
    },
    {
      field: "answerShape",
      correctSource: "govParse.record.answerShape",
      correct: () => storedRun().governanceRecord.answerShape,
      discriminated: [
        ["the default fixture literal", () => "decision_support_view"],
        ["govParse.record.schemaId", () => storedRun().governanceRecord.schemaId],
      ],
      equivalent: [],
    },
  ];

  it("the fixture DISCRIMINATES: every field's correct source differs in value from every plausible wrong source — asserted before the production call", () => {
    seedProvenanceFixture();
    const collisions = PROVENANCE_MATRIX.flatMap((row) => row.discriminated.filter(([, read]) => read() === row.correct()).map(([name]) => `${row.field}<-${name}`));
    expect(`indistinguishableSources:${collisions.join(",")}`).toBe("indistinguishableSources:");
    // and the values really are the distinct ones this fixture intends
    expect({
      caller: CANCEL_PROVENANCE_CALLER,
      panelCreatedBy: storedPanel().createdByUserId,
      panelUpdatedBy: storedPanel().updatedByUserId,
      runCreator: storedRun().userId,
      firstReviewer: storedPanel().reviewerUserIds[0],
      workspaceOwner: storedWorkspace().ownerUserId,
      revision: storedPanel().revision,
      reviewerCount: storedPanel().reviewerUserIds.length,
      quorum: storedPanel().quorum,
      runWorkspaceId: storedRun().workspaceId,
      panelWorkspaceMirror: storedPanel().workspaceId,
      runProjectId: storedRun().projectId,
      panelProjectMirror: storedPanel().projectId,
    }).toEqual({
      caller: ADMIN_UID,
      panelCreatedBy: REVIEWER_UID,
      panelUpdatedBy: REVIEWER2_UID,
      runCreator: CREATOR_UID,
      firstReviewer: OWNER_UID,
      workspaceOwner: OWNER_UID,
      revision: 5,
      reviewerCount: 3,
      quorum: 2,
      runWorkspaceId: WS_ID,
      panelWorkspaceMirror: STALE_PANEL_WORKSPACE_MIRROR,
      runProjectId: PROJECT_ID,
      panelProjectMirror: STALE_PANEL_PROJECT_MIRROR,
    });
  });

  it("every source classified EQUIVALENT really is equal in this fixture, and names the guard that forces it", () => {
    seedProvenanceFixture();
    const rows = PROVENANCE_MATRIX.flatMap((row) => row.equivalent.map(([name, read, invariant]) => ({ row, name, equal: read() === row.correct(), invariant })));
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => !r.equal).map((r) => `${r.row.field}<-${r.name}`)).toEqual([]);
    expect(rows.filter((r) => !r.invariant.includes("cancel#reject-")).map((r) => `${r.row.field}<-${r.name}`)).toEqual([]);
  });

  /**
   * Every value is snapshotted BEFORE the call. Cancel rewrites the panel document — it sets
   * `updatedByUserId` to the caller and bumps `revision` — so reading the store afterwards turns
   * two hostile sources into the correct value and silently un-discriminates the fixture. The
   * first draft of this test did exactly that and failed honestly on `byUid`.
   */
  const snapshotMatrix = () =>
    PROVENANCE_MATRIX.map((row) => Object.freeze({
      field: row.field,
      correct: row.correct(),
      discriminated: row.discriminated.map(([name, read]) => Object.freeze([name, read()] as const)),
    }));

  it("the cancel event's EVERY authority-bearing field equals its canonical PRE-MUTATION source and no wrong source", async () => {
    seedProvenanceFixture();
    const expected = snapshotMatrix();
    expect((await provenanceCancel()).ok).toBe(true);
    expect(panelEvents()).toHaveLength(1);
    const event = panelEvents()[0];
    for (const row of expected) {
      expect(`${row.field}:${JSON.stringify(event[row.field])}`).toBe(`${row.field}:${JSON.stringify(row.correct)}`);
      for (const [name, wrongValue] of row.discriminated) {
        expect(`${row.field}!=${name}:${JSON.stringify(event[row.field]) === JSON.stringify(wrongValue)}`).toBe(`${row.field}!=${name}:false`);
      }
    }
    expect(event.action).toBe("adaptive_review_panel_cancelled");
  });

  it("cancel really DOES rewrite the panel's actor and revision — which is why the snapshot above must precede the call", async () => {
    seedProvenanceFixture();
    const before = { updatedByUserId: storedPanel().updatedByUserId, revision: storedPanel().revision };
    expect((await provenanceCancel()).ok).toBe(true);
    expect(`beforeActor:${before.updatedByUserId} afterActor:${storedPanel().updatedByUserId}`).toBe(`beforeActor:${REVIEWER2_UID} afterActor:${CANCEL_PROVENANCE_CALLER}`);
    expect(`beforeRevision:${before.revision} afterRevision:${storedPanel().revision}`).toBe("beforeRevision:5 afterRevision:6");
  });

  it("the matrix is COMPLETE: the event has no field outside it, so a newly added field cannot escape the audit", async () => {
    seedProvenanceFixture();
    expect((await provenanceCancel()).ok).toBe(true);
    expect(Object.keys(panelEvents()[0]).sort()).toEqual(["action", ...PROVENANCE_MATRIX.map((r) => r.field)].sort());
  });
});

/**
 * ─── R3 §33–§36 — RETRY UNIQUENESS AND ATOMICITY AS COMMITTED REGRESSIONS ─────────────────────
 *
 * Both guarantees previously existed only as review-time probes, so nothing stopped a future
 * change from breaking them silently. They are now permanent.
 *
 * RETRY: the event id is generated INSIDE the transaction callback, so a retried attempt mints a
 * fresh one. Exactly one event survives — not because a check rejects the retry (the retry
 * SUCCEEDS), but because the aborted attempt's buffered writes are discarded. The `auto-1` /
 * `auto-2` assertion below pins that mechanism rather than just the count, so a fake that began
 * retaining aborted writes would fail here instead of silently making the test meaningless.
 */
describe("panel audit events — retry uniqueness", () => {
  const forceOneConflict = (collection: string, id: string, mutate: () => void) => {
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (!fired && ref.__collection === collection && ref.__id === id) { fired = true; mutate(); }
    };
  };

  it("a CREATE that conflicts once and then succeeds commits exactly one event", async () => {
    forceOneConflict("runs", RUN_ID, () => seedRun());
    const result = await putCall();
    expect(result.ok).toBe(true);
    expect(`attempts:${transactionAttemptCount.value >= 2}`).toBe("attempts:true");
    expect(panelEvents()).toHaveLength(1);
    // the aborted attempt's auto-id is ABSENT — this is the discard mechanism, not a count
    const keys = [...stores.governanceEvents.keys()].filter((k) => k.startsWith(`${RUN_ID}::`));
    expect(`keys:${keys.join(",")}`).toBe(`keys:${RUN_ID}::auto-2`);
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { revision: number }).revision).toBe(1);
  });

  it("a VOTE that conflicts once and then succeeds commits exactly one event and one vote", async () => {
    seedPanel({ revision: 1 });
    forceOneConflict("runs", RUN_ID, () => seedRun());
    expect((await voteCall()).ok).toBe(true);
    expect(`attempts:${transactionAttemptCount.value >= 2}`).toBe("attempts:true");
    expect(panelEvents()).toHaveLength(1);
    expect([...stores.humanReviewVotes.keys()].filter((k) => k.startsWith(`${RUN_ID}::`))).toHaveLength(1);
  });

  it("a CANCEL that conflicts once and then succeeds commits exactly one event", async () => {
    seedPanel({ revision: 1 });
    forceOneConflict("runs", RUN_ID, () => seedRun());
    expect((await deleteCall()).ok).toBe(true);
    expect(`attempts:${transactionAttemptCount.value >= 2}`).toBe("attempts:true");
    expect(panelEvents()).toHaveLength(1);
  });
});

/**
 * ATOMICITY: the audit event and the canonical mutation share one transaction, so an audit failure
 * must roll back the canonical write — the strict opposite of finalize/override's best-effort
 * post-commit pattern. Each case asserts the injected failure actually fired (the operation
 * returns `write_failed`), so a case where an earlier validation branch short-circuited before
 * reaching the injected write cannot pass silently.
 */
describe("panel audit events — atomicity: neither half survives a failure", () => {
  it("an EVENT-write failure rolls back the panel CREATE", async () => {
    throwOnSetCollection.value = "governanceEvents";
    expect(await putCall()).toEqual({ ok: false, reason: "write_failed" });
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
    expect(panelEvents()).toHaveLength(0);
  });

  it("a CANONICAL-write failure leaves no event on CREATE", async () => {
    throwOnSetCollection.value = "humanReviewPanel";
    expect(await putCall()).toEqual({ ok: false, reason: "write_failed" });
    expect(panelEvents()).toHaveLength(0);
  });

  it("an EVENT-write failure rolls back the CANCEL — the panel stays open", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "governanceEvents";
    expect(await deleteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { status: string }).status).toBe("open");
    expect(panelEvents()).toHaveLength(0);
  });

  it("an EVENT-write failure rolls back the VOTE — no vote is committed", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "governanceEvents";
    expect(await voteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect([...stores.humanReviewVotes.keys()].filter((k) => k.startsWith(`${RUN_ID}::`))).toHaveLength(0);
    expect(panelEvents()).toHaveLength(0);
  });

  it("a CANONICAL-write failure leaves no event on VOTE", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "humanReviewVotes";
    expect(await voteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect(panelEvents()).toHaveLength(0);
  });
});
