/**
 * ADD-TO-TEAM-PROJECT — `createTeamRunSnapshotFromPersonal()` tests.
 * In-memory Firestore fake, structural mirror of `teamWorkspaceRuns.spec.ts`'s
 * buffered-transaction fake, extended with `runSnapshotLocks` and
 * `workspaceMembershipEvents` stores, a transactional `set`, a per-ref read
 * log, and a `concurrentMutationHook` for the same-tuple race. Authorization
 * is exercised against the REAL `authorizeTeamWorkspaceMutationInTransaction()`
 * (never mocked); `roleHasCapability` is a passthrough spy so the SECOND
 * capability check (`research.organize`) can be falsified independently of
 * the first without inventing a role the matrix does not have.
 *
 * Every "X is not written / not called" assertion in this file sits next to
 * a positive control on the same fixture that shows X IS written / called
 * when it should be (docs/operations/security-test-falsifiability.md).
 */

import { Timestamp } from "firebase-admin/firestore";
import type { PersistedAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import { SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";
import type { CommonResponseMeta, DecisionSupportResult, QueryClassification } from "@/lib/adaptiveSchema/types";

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
  runSnapshotLocks: new Map(),
  workspaceMembershipEvents: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
}

class FirestoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Plain (NON-transactional) refs also support `update()`/`add()` that apply
 * IMMEDIATELY — so a mutation that moves a write out of the transaction and
 * into a post-commit call genuinely succeeds against this fake, and only a
 * test that inspects the transaction's own buffered writes (`txCreateLog` /
 * `txSetLog`) can tell the difference. That is the point.
 */
function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    get: async () => {
      const entry = stores[collectionName].get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, id: docId };
    },
    update: async (data: Record<string, unknown>) => {
      const store = stores[collectionName];
      const entry = store.get(docId);
      if (!entry) throw new FirestoreError("5", "NOT_FOUND");
      store.set(docId, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() });
    },
  };
}

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
let forceCreateFailureForCollection: string | null = null;
let forceSetFailureForCollection: string | null = null;
const readLog: Array<{ collection: string; id: string }> = [];
/** Every payload handed to the TRANSACTION's `create`/`set` — the only evidence a write was atomic with the run. */
const txCreateLog: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
const txSetLog: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
    add: async (data: Record<string, unknown>) => {
      const id = `auto-${++autoIdCounter}`;
      stores[name].set(id, { data, updateTime: nextUpdateTime() });
      return makeDocRef(name, id);
    },
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const pendingWrites: Array<() => void> = [];
    let writesStarted = false;
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (writesStarted) throw new Error("Firestore: reads are not allowed after writes in a transaction");
        readLog.push({ collection: ref.__collection, id: ref.__id });
        const store = stores[ref.__collection];
        if (!store) throw new Error(`unexpected collection ${ref.__collection}`);
        const entry = store.get(ref.__id);
        const snapshot = { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
        if (concurrentMutationHook) concurrentMutationHook(ref);
        return snapshot;
      },
      create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        writesStarted = true;
        if (forceCreateFailureForCollection === ref.__collection) {
          throw new FirestoreError("14", "UNAVAILABLE: simulated transient failure");
        }
        const store = stores[ref.__collection];
        if (store.has(ref.__id)) {
          throw new FirestoreError("6", "ALREADY_EXISTS");
        }
        txCreateLog.push({ collection: ref.__collection, id: ref.__id, data });
        pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
      set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        writesStarted = true;
        if (forceSetFailureForCollection === ref.__collection) {
          throw new FirestoreError("14", "UNAVAILABLE: simulated transient failure");
        }
        const store = stores[ref.__collection];
        txSetLog.push({ collection: ref.__collection, id: ref.__id, data });
        pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        // Applied like a real transactional update — a mutation that writes
        // to the SOURCE succeeds here and is caught by the byte-equivalence
        // test, not by a harness exception.
        writesStarted = true;
        const store = stores[ref.__collection];
        pendingWrites.push(() => {
          const entry = store.get(ref.__id);
          if (entry) store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() });
        });
      },
    };
    const result = await fn(txn);
    for (const applyWrite of pendingWrites) applyWrite();
    return result;
  }),
};

const firestoreUnavailableFlag = { value: false };
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
let teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
let workspacesEnabled = true;
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
  get WORKSPACES_ENABLED() {
    return workspacesEnabled;
  },
}));

const mockRoleHasCapability = jest.fn();
jest.mock("@/lib/workspaces/capabilities", () => {
  const actual = jest.requireActual("@/lib/workspaces/capabilities");
  return { ...actual, roleHasCapability: (...args: unknown[]) => mockRoleHasCapability(...args) };
});
const actualCapabilities = jest.requireActual("@/lib/workspaces/capabilities");

const mockedLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { createTeamRunSnapshotFromPersonal } from "@/lib/firestore/teamRunSnapshots";
import { computeRunSnapshotLockId } from "@/lib/workspaces/runSnapshotLock";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { MAX_TOTAL_DOC_SIZE } from "@/lib/panel/sanitizeText";
import { readFileSync } from "fs";
import { join } from "path";

const WS_ID = "ws-team-1";
const WS2_ID = "ws-team-2";
const OWNER_UID = "owner-1";
const MEMBER_UID = "member-1";
const ADMIN_UID = "admin-1";
const REVIEWER_UID = "reviewer-1";
const VIEWER_UID = "viewer-1";
const OTHER_UID = "other-1";
const PROJECT_ID = "proj-1";
const PROJECT2_ID = "proj-2";
const SRC = "run-11111111-1111-4111-8111-111111111111";
const personalWs = (uid: string) => {
  const r = getPersonalWorkspaceId(uid);
  if (!r.ok) throw new Error("bad uid");
  return r.workspaceId;
};

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function seedWorkspace(id = WS_ID, overrides: Record<string, unknown> = {}) {
  const data = { schemaVersion: 1, id, type: "team", name: "Acme Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000), ...overrides };
  stores.workspaces.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedPersonalWorkspace(uid: string, overrides: Record<string, unknown> = {}) {
  const id = personalWs(uid);
  const data = { schemaVersion: 1, id, type: "personal", name: "Personal Workspace", ownerUserId: uid, createdAt: ts(1000), updatedAt: ts(1000), ...overrides };
  stores.workspaces.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedMembership(uid: string, role: string, workspaceId = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const data = { schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides };
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedProject(id = PROJECT_ID, overrides: Record<string, unknown> = {}) {
  const data = { schemaVersion: 1, id, workspaceId: WS_ID, name: "Due Diligence", status: "active", createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000), ...overrides };
  stores.projects.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

const decisionSupportResult: DecisionSupportResult = {
  decisionQuestion: "Which CRM should we choose?",
  options: [{ id: "hubspot", label: "HubSpot", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  criteria: [{ id: "cost", label: "Total cost", source: "user", coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: [] }],
  assessments: [],
  recommendation: { action: "choose_option", recommendedOptionId: "hubspot", rationale: "Lower cost fits the stated budget.", caveats: [], isContested: false, supportCount: 2, totalModelsWithRecommendation: 2 },
  assumptions: [],
  uncertainties: [],
  risks: [],
  sensitivityFindings: [],
  reversibleNextStep: "Run a 2-week pilot with HubSpot.",
  humanReviewNeeded: false,
  sourceBacked: false,
  sources: [],
  totalModels: 2,
};
function classification(): QueryClassification {
  return { queryType: "decision_support", domain: "test", answerShape: "decision_support_view", quantExpected: false, timeSensitivity: "low", userIntent: "make_decision", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless", inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, rationale: "test fixture" };
}
function meta(): CommonResponseMeta {
  return { schemaVersion: 1, queryType: "decision_support", answerShape: "decision_support_view", dataBasis: "training_prior", freshness: "timeless", riskLevel: "professional", evidenceQuality: "not_applicable", uncertainties: [], blindSpots: [], humanReviewNeeded: false, generatedAt: "2026-07-29T00:00:00.000Z" };
}
export function adaptiveOutput(): PersistedAdaptiveOutputV1 {
  return { version: 1, schemaId: "decision_support", answerShape: SCHEMA_ANSWER_SHAPE.decision_support, classification: classification(), meta: meta(), result: decisionSupportResult, generatedAt: "2026-07-29T00:00:00.000Z" };
}

function runDocument(runId: string, userId: string, text = "Nairobi is the capital.") {
  return {
    runId,
    userId,
    createdAt: ts(500),
    question: "What is the capital of Kenya?",
    selectedModels: ["chatgpt", "claude"],
    perModel: [
      { modelId: "chatgpt", status: "ok", rawTextTruncated: text, latencyMs: 10, tokenUsage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, totalTokens: 2 }, wasTruncated: false },
      { modelId: "claude", status: "ok", rawTextTruncated: text, latencyMs: 12, tokenUsage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, totalTokens: 2 }, wasTruncated: false },
    ],
    totals: { promptTokens: 2, completionTokens: 2, reasoningTokens: 0, totalTokens: 4 },
    flags: { storageTruncated: false, synthesisTruncated: false },
  };
}

/** A COMPLETE, Personal-Workspace-bound, ADAPTIVE source run owned by MEMBER_UID, with every field a snapshot must NOT copy present. */
function seedSource(id = SRC, overrides: Record<string, unknown> = {}, opts: { legacy?: boolean } = {}) {
  const data: Record<string, unknown> = {
    userId: MEMBER_UID,
    ...(opts.legacy ? {} : { workspaceId: personalWs(MEMBER_UID), projectId: null }),
    question: "What is the capital of Kenya?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    createdAt: ts(500),
    completedAt: ts(600),
    runDocument: runDocument(id, MEMBER_UID),
    tokenUsage: { byModel: {}, totals: { promptTokens: 2, completionTokens: 2, reasoningTokens: 0, totalTokens: 4 } },
    totalTokens: 4,
    tokensByModel: { chatgpt: 2, claude: 2 },
    tokensByProvider: { openai: 2, anthropic: 2 },
    adaptiveOutput: adaptiveOutput(),
    // Personal-only state that must never cross the Workspace boundary:
    governanceStatus: "approved",
    governanceRecord: { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "approved", reviewerId: "personal-reviewer-9", reviewedAt: "2026-08-01T00:00:00.000Z" }, createdAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
    teamGovernance: { blocked: false, governanceReviewRequired: false, evaluatedAt: ts(700) },
    adaptiveExportCounter: 3,
    ...overrides,
  };
  stores.runs.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function args(overrides: Record<string, unknown> = {}) {
  return { uid: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT_ID, sourceRunId: SRC, ...overrides };
}

const lockIdFor = (sourceRunId = SRC, workspaceId = WS_ID, projectId = PROJECT_ID) => computeRunSnapshotLockId({ sourceRunId, workspaceId, projectId });

function onlyCreatedRun(excludeIds: string[] = [SRC]) {
  const created = Array.from(stores.runs.entries()).filter(([id]) => !excludeIds.includes(id));
  expect(created).toHaveLength(1);
  return { id: created[0][0], data: created[0][1].data };
}

beforeEach(() => {
  resetStores();
  readLog.length = 0;
  txCreateLog.length = 0;
  txSetLog.length = 0;
  concurrentMutationHook = null;
  forceCreateFailureForCollection = null;
  forceSetFailureForCollection = null;
  firestoreUnavailableFlag.value = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  workspacesEnabled = true;
  mockAdminDb.runTransaction.mockClear();
  mockedLogger.error.mockClear();
  mockedCheckAndIncrementUsage.mockClear();
  mockRoleHasCapability.mockReset();
  mockRoleHasCapability.mockImplementation((...a: unknown[]) => actualCapabilities.roleHasCapability(...a));
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
  seedPersonalWorkspace(MEMBER_UID);
  seedProject();
  seedSource();
});

describe("rollout + infrastructure", () => {
  it("disabled: team_workspaces_disabled with ZERO Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    expect(readLog).toHaveLength(0);
  });

  it("workspace-id canary alone admits the target", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result.status).toBe("created");
  });

  it("firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "firestore_unavailable" });
  });
});

describe("Z1/Z16/Z17/Z18/Z19/Z27 — an owner's bound Personal source is snapshotted completely, atomically", () => {
  it("creates ONE complete Team run + ONE lock + ONE audit event in ONE transaction; nothing else", async () => {
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result).toEqual({ status: "created", runId: result.runId, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(result.runId).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(result.runId).not.toBe(SRC);
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);

    const { id, data } = onlyCreatedRun();
    expect(id).toBe(result.runId);
    // Z16 — complete on first visibility, fresh Team timestamps.
    expect(data.status).toBe("complete");
    expect(data.createdAt).toBeInstanceOf(Timestamp);
    expect(data.completedAt).toBe(data.createdAt);
    expect((data.createdAt as Timestamp).seconds).not.toBe(500);
    // Destination identity.
    expect(data.userId).toBe(MEMBER_UID);
    expect(data.workspaceId).toBe(WS_ID);
    // Z17 — projectId PRESENT, and the row passes the Team validator the list route uses.
    expect(Object.prototype.hasOwnProperty.call(data, "projectId")).toBe(true);
    expect(data.projectId).toBe(PROJECT_ID);
    expect(validateTeamRunRowShape(data, WS_ID)).toEqual({ ok: true, userId: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    // Content copied.
    expect(data.question).toBe("What is the capital of Kenya?");
    expect(data.selectedModels).toEqual(["chatgpt", "claude"]);
    expect(data.tokenUsage).toBe(stores.runs.get(SRC)!.data.tokenUsage);
    expect(data.totalTokens).toBe(4);
    expect(data.adaptiveOutput).toBe(stores.runs.get(SRC)!.data.adaptiveOutput);
    // Z18 — embedded identity rewritten to the destination.
    const rd = data.runDocument as Record<string, unknown>;
    expect(rd.runId).toBe(result.runId);
    expect(rd.userId).toBe(MEMBER_UID);
    expect(rd.perModel).toBe((stores.runs.get(SRC)!.data.runDocument as Record<string, unknown>).perModel);
    // Z19 — provenance inside the SAME created document.
    expect(data.origin).toEqual({ type: "personal_research", runId: SRC, sourceCreatedAt: ts(500), sourceCompletedAt: ts(600) });

    // Lock.
    const lock = stores.runSnapshotLocks.get(lockIdFor());
    expect(lock).toBeDefined();
    expect(lock!.data).toEqual({ version: 1, sourceRunId: SRC, workspaceId: WS_ID, projectId: PROJECT_ID, snapshotRunId: result.runId, createdBy: MEMBER_UID, createdAt: data.createdAt });
    expect(stores.runSnapshotLocks.size).toBe(1);

    // Z27 — audit event, same instant as the run.
    expect(stores.workspaceMembershipEvents.size).toBe(1);
    const event = Array.from(stores.workspaceMembershipEvents.values())[0].data;
    expect(event).toEqual({
      eventType: "workspace_research_snapshot_created",
      actorUid: MEMBER_UID,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      projectName: "Due Diligence",
      runId: result.runId,
      runQuestion: "What is the capital of Kenya?",
      at: data.createdAt,
    });
    expect(JSON.stringify(event)).not.toContain(SRC);
  });

  it("Z19b/Z22b/Z27b — provenance, the fresh governance record and the audit event are all in the TRANSACTION's own buffered writes (never a post-commit call)", async () => {
    const result = await createTeamRunSnapshotFromPersonal(args());
    if (result.status !== "created") throw new Error("expected created");
    // Exactly two tx.create calls (run + lock) and one tx.set (audit event).
    expect(txCreateLog.map((c) => c.collection).sort()).toEqual(["runSnapshotLocks", "runs"]);
    expect(txSetLog.map((s) => s.collection)).toEqual(["workspaceMembershipEvents"]);
    const runCreate = txCreateLog.find((c) => c.collection === "runs")!;
    expect(runCreate.id).toBe(result.runId);
    // Z19b — origin is INSIDE the create payload.
    expect(runCreate.data.origin).toEqual({ type: "personal_research", runId: SRC, sourceCreatedAt: ts(500), sourceCompletedAt: ts(600) });
    // Z22b — the fresh governance record is INSIDE the create payload.
    expect((runCreate.data.governanceRecord as Record<string, unknown>).humanReview).toEqual({ status: "unreviewed" });
    // Z27b — the audit event is a buffered tx.set, carrying the created run id.
    expect(txSetLog[0].data).toMatchObject({ eventType: "workspace_research_snapshot_created", runId: result.runId });
    // Positive control for the fake: a post-commit non-transactional write WOULD have landed in the store,
    // so the store alone could never distinguish atomic from post-commit — only the logs can.
    await mockAdminDb.collection("runs").doc(result.runId).update({ probe: true });
    expect(stores.runs.get(result.runId)!.data.probe).toBe(true);
    expect(txCreateLog.find((c) => c.collection === "runs")!.data.probe).toBeUndefined();
  });

  it("Z14 — the source and the Project are read THROUGH the transaction, after authorization, before any write", async () => {
    await createTeamRunSnapshotFromPersonal(args());
    const order = readLog.map((r) => `${r.collection}/${r.id}`);
    const membershipIdx = order.findIndex((r) => r.startsWith("workspaceMemberships/"));
    const projectIdx = order.indexOf(`projects/${PROJECT_ID}`);
    const sourceIdx = order.indexOf(`runs/${SRC}`);
    const lockIdx = order.indexOf(`runSnapshotLocks/${lockIdFor()}`);
    expect(membershipIdx).toBeGreaterThanOrEqual(0);
    expect(projectIdx).toBeGreaterThan(membershipIdx);
    expect(sourceIdx).toBeGreaterThan(projectIdx);
    expect(lockIdx).toBeGreaterThan(sourceIdx);
  });

  it("Z15 — the source document is byte-equivalent and the SAME stored object afterwards; no update() was ever issued", async () => {
    const entryBefore = stores.runs.get(SRC)!;
    const jsonBefore = JSON.stringify(entryBefore.data);
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result.status).toBe("created");
    const entryAfter = stores.runs.get(SRC)!;
    expect(entryAfter).toBe(entryBefore);
    expect(JSON.stringify(entryAfter.data)).toBe(jsonBefore);
    expect(entryAfter.updateTime).toBe(entryBefore.updateTime);
    // Positive control: the same fixture DID produce a different, new document.
    const created = onlyCreatedRun();
    expect(JSON.stringify(created.data)).not.toBe(jsonBefore);
  });

  it("Z25 — zero quota: the inference quota writer is never called (positive control: the module is mockable and starts at zero)", async () => {
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(0);
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result.status).toBe("created");
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(0);
    const source = readFileSync(join(__dirname, "..", "teamRunSnapshots.ts"), "utf8");
    expect(source).not.toContain("checkAndIncrementUsageForRun");
    expect(source).not.toContain("usageCheck");
  });

  it("Z26 — zero model execution: the primitive imports no connector, execution engine, classifier, router or synthesis module", async () => {
    const source = readFileSync(join(__dirname, "..", "teamRunSnapshots.ts"), "utf8");
    for (const forbidden of ["@/lib/connectors", "@/lib/runPanelExecution", "@/lib/adaptiveSchema/classifier", "@/lib/adaptiveSchema/routeClassifiedQuery", "@/lib/adaptiveSchema/orchestrate", "@/lib/synthesis", "@/lib/panel\"", "run-panel"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("Z2 — a LEGACY Personal source (no workspaceId field) qualifies", () => {
  it("created, with provenance and no Personal Workspace read", async () => {
    stores.runs.delete(SRC);
    seedSource(SRC, {}, { legacy: true });
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result.status).toBe("created");
    const { data } = onlyCreatedRun();
    expect(data.workspaceId).toBe(WS_ID);
    expect(data.origin).toMatchObject({ type: "personal_research", runId: SRC });
    expect(readLog.some((r) => r.collection === "workspaces" && r.id === personalWs(MEMBER_UID))).toBe(false);
  });
});

describe("Z20–Z23 — governance boundary", () => {
  it("Z20/Z21 — the Personal governanceRecord, governanceStatus, teamGovernance and adaptiveExportCounter are NOT copied (positive control: the source has all four)", async () => {
    const src = stores.runs.get(SRC)!.data;
    expect(src.governanceStatus).toBe("approved");
    expect((src.governanceRecord as Record<string, unknown>).humanReview).toMatchObject({ status: "approved" });
    expect(src.teamGovernance).toBeDefined();
    expect(src.adaptiveExportCounter).toBe(3);

    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(Object.prototype.hasOwnProperty.call(data, "governanceStatus")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "teamGovernance")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "adaptiveExportCounter")).toBe(false);
    expect(data.governanceRecord).not.toBe(src.governanceRecord);
    expect(JSON.stringify(data.governanceRecord)).not.toContain("personal-reviewer-9");
    expect(JSON.stringify(data.governanceRecord)).not.toContain("approved");
  });

  it("Z22 — an adaptive source gets a FRESH unreviewed governanceRecord keyed to the NEW run, inside the same created document", async () => {
    const result = await createTeamRunSnapshotFromPersonal(args());
    if (result.status !== "created") throw new Error("expected created");
    const { data } = onlyCreatedRun();
    const record = data.governanceRecord as Record<string, unknown>;
    expect(record).toMatchObject({ version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "unreviewed" } });
    expect(record.decisionReceipt).toBeDefined();
    expect(record.createdAt).toBe((data.createdAt as Timestamp).toDate().toISOString());
    expect(record.updatedAt).toBe(record.createdAt);
    // Only ONE run was created in ONE transaction — there was no second write to add it.
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("Z23 — a non-adaptive source produces NO governanceRecord", async () => {
    const src = stores.runs.get(SRC)!.data;
    delete src.adaptiveOutput;
    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(Object.prototype.hasOwnProperty.call(data, "governanceRecord")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "adaptiveOutput")).toBe(false);
  });

  it("an adaptive source whose adaptiveOutput does not parse is copied without a governanceRecord (never fabricated)", async () => {
    stores.runs.get(SRC)!.data.adaptiveOutput = { version: 99, garbage: true };
    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(data.adaptiveOutput).toEqual({ version: 99, garbage: true });
    expect(Object.prototype.hasOwnProperty.call(data, "governanceRecord")).toBe(false);
  });
});

describe("content fidelity", () => {
  it("copies legacyAdaptiveOutput and the synthesis cache when present, as the same references", async () => {
    const src = stores.runs.get(SRC)!.data;
    src.legacyAdaptiveOutput = { version: 1, schemaId: "factual_lookup", results: [] };
    src.synthesizedStructuredReport = { headline: "x" };
    src.schemaVersion = 1;
    src.synthesizedAt = ts(650);
    src.synthesizedBy = "claude";
    src.synthesisInputHash = "abc";
    src.synthesisConsensusSummary = { score: 0.9 };
    src.synthesisConsensusAudit = { a: 1 };
    src.synthesisMetadata = { cached: false };
    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(data.legacyAdaptiveOutput).toBe(src.legacyAdaptiveOutput);
    expect(data.synthesizedStructuredReport).toBe(src.synthesizedStructuredReport);
    expect(data.schemaVersion).toBe(1);
    expect(data.synthesizedAt).toBe(src.synthesizedAt);
    expect(data.synthesisConsensusSummary).toBe(src.synthesisConsensusSummary);
  });

  it("does NOT copy synthesis sibling fields when the report itself is absent", async () => {
    const src = stores.runs.get(SRC)!.data;
    src.synthesizedBy = "claude";
    src.synthesisInputHash = "abc";
    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(Object.prototype.hasOwnProperty.call(data, "synthesizedBy")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "synthesisInputHash")).toBe(false);
  });

  it("a legacy-format source with `results` but no runDocument is copied through the results fallback", async () => {
    const src = stores.runs.get(SRC)!.data;
    delete src.runDocument;
    src.results = [{ modelId: "chatgpt", status: "ok", rawText: "answer" }];
    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(data.results).toBe(src.results);
    expect(Object.prototype.hasOwnProperty.call(data, "runDocument")).toBe(false);
  });

  it("a source with neither runDocument nor results has nothing to snapshot → concealed source_not_found, nothing written", async () => {
    const src = stores.runs.get(SRC)!.data;
    delete src.runDocument;
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "source_not_found" });
    expect(stores.runs.size).toBe(1);
    expect(stores.runSnapshotLocks.size).toBe(0);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
  });

  it("origin.sourceCompletedAt is null when the source carries no completedAt", async () => {
    delete stores.runs.get(SRC)!.data.completedAt;
    await createTeamRunSnapshotFromPersonal(args());
    const { data } = onlyCreatedRun();
    expect(data.origin).toEqual({ type: "personal_research", runId: SRC, sourceCreatedAt: ts(500), sourceCompletedAt: null });
  });
});

describe("Z3–Z7 — source authorization (every failure is the SAME concealed outcome, nothing written)", () => {
  const expectConcealedAndClean = async (a = args()) => {
    const result = await createTeamRunSnapshotFromPersonal(a);
    expect(result).toEqual({ status: "source_not_found" });
    expect(stores.runs.size).toBe(1);
    expect(stores.runSnapshotLocks.size).toBe(0);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
  };

  it("Z3 — a Personal reviewer of the source (Team member, but NOT the source owner) is refused on ownership", async () => {
    seedMembership(OTHER_UID, "member");
    // OTHER_UID can legitimately READ the source as a Personal reviewer elsewhere; that grant is irrelevant here.
    await expectConcealedAndClean(args({ uid: OTHER_UID }));
  });

  it("Z4 — a foreign Personal source (owned by someone else, bound to THEIR Personal Workspace) is concealed even though the caller is an authorized Team member", async () => {
    seedPersonalWorkspace(OTHER_UID);
    stores.runs.delete(SRC);
    seedSource(SRC, { userId: OTHER_UID, workspaceId: personalWs(OTHER_UID), runDocument: runDocument(SRC, OTHER_UID) });
    await expectConcealedAndClean();
  });

  it("Z4b — a foreign LEGACY source (no workspaceId, owned by someone else) is concealed: for a legacy run the owner check is the ONLY thing standing (mutation M1 survived without this)", async () => {
    stores.runs.delete(SRC);
    seedSource(SRC, { userId: OTHER_UID, runDocument: runDocument(SRC, OTHER_UID) }, { legacy: true });
    await expectConcealedAndClean();
    // No Personal Workspace document is consulted for a legacy source, so nothing else could have refused it.
    expect(readLog.some((r) => r.collection === "workspaces" && r.id.startsWith("personal-"))).toBe(false);
    // Positive control: the same legacy fixture owned by the caller is created.
    stores.runs.delete(SRC);
    seedSource(SRC, {}, { legacy: true });
    expect((await createTeamRunSnapshotFromPersonal(args())).status).toBe("created");
  });

  it("Z5 — a Team-bound source (even one the caller created in this very Workspace) is refused BEFORE any owner comparison", async () => {
    stores.runs.delete(SRC);
    seedSource(SRC, { userId: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT_ID });
    await expectConcealedAndClean();
    // The owner check never ran on this source: the deterministic Personal Workspace was never read either.
    expect(readLog.some((r) => r.collection === "workspaces" && r.id === personalWs(MEMBER_UID))).toBe(false);
  });

  it("Z6 — an invalidly-bound source (workspaceId present but empty) is concealed", async () => {
    stores.runs.delete(SRC);
    seedSource(SRC, { workspaceId: "" });
    await expectConcealedAndClean();
  });

  it("Z6b — a bound source whose Personal Workspace is missing, malformed, wrong type, or not the caller's is concealed", async () => {
    stores.workspaces.delete(personalWs(MEMBER_UID));
    await expectConcealedAndClean();
    seedPersonalWorkspace(MEMBER_UID, { ownerUserId: OTHER_UID });
    await expectConcealedAndClean();
    seedPersonalWorkspace(MEMBER_UID, { type: "team", createdByUserId: MEMBER_UID });
    await expectConcealedAndClean();
  });

  it("Z6c — a bound source with WORKSPACES_ENABLED off is concealed (a flag can only narrow access; positive control: on → created)", async () => {
    workspacesEnabled = false;
    await expectConcealedAndClean();
    workspacesEnabled = true;
    expect((await createTeamRunSnapshotFromPersonal(args())).status).toBe("created");
  });

  it("Z7 — running / error / queued sources are refused", async () => {
    for (const status of ["running", "error", "queued"]) {
      stores.runs.get(SRC)!.data.status = status;
      await expectConcealedAndClean();
    }
  });

  it("a missing source is concealed identically", async () => {
    stores.runs.delete(SRC);
    const result = await createTeamRunSnapshotFromPersonal(args());
    expect(result).toEqual({ status: "source_not_found" });
    expect(stores.runs.size).toBe(0);
  });

  it("a source read fails closed even when the source owner is also the Workspace owner (no owner shortcut)", async () => {
    seedPersonalWorkspace(OWNER_UID);
    stores.runs.delete(SRC);
    seedSource(SRC, { userId: OWNER_UID, workspaceId: personalWs(OWNER_UID), runDocument: runDocument(SRC, OWNER_UID) });
    // MEMBER_UID (an authorized member) tries to snapshot the OWNER's Personal run.
    await expectConcealedAndClean();
    // Positive control: the owner themselves can.
    expect((await createTeamRunSnapshotFromPersonal(args({ uid: OWNER_UID }))).status).toBe("created");
  });
});

describe("Z8–Z12 — destination authorization", () => {
  it("Z8/Z10 — reviewer and viewer lack research.create → insufficient_capability, nothing written", async () => {
    for (const uid of [REVIEWER_UID, VIEWER_UID]) {
      seedPersonalWorkspace(uid);
      stores.runs.delete(SRC);
      seedSource(SRC, { userId: uid, workspaceId: personalWs(uid), runDocument: runDocument(SRC, uid) });
      expect(await createTeamRunSnapshotFromPersonal(args({ uid }))).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
      expect(stores.runs.size).toBe(1);
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    }
  });

  it("Z9 — research.organize is required from the SAME membership even when research.create passes (falsified by denying organize alone)", async () => {
    mockRoleHasCapability.mockImplementation((role: unknown, cap: unknown) => (cap === "research.organize" ? false : actualCapabilities.roleHasCapability(role, cap)));
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.runs.size).toBe(1);
    // The Project and the source were never read — the capability gate is first.
    expect(readLog.some((r) => r.collection === "projects")).toBe(false);
    expect(readLog.some((r) => r.collection === "runs")).toBe(false);
    // Positive control: with the real matrix, the same membership passes.
    mockRoleHasCapability.mockImplementation((...a: unknown[]) => actualCapabilities.roleHasCapability(...a));
    expect((await createTeamRunSnapshotFromPersonal(args())).status).toBe("created");
  });

  it("owner and admin succeed", async () => {
    for (const uid of [OWNER_UID, ADMIN_UID]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(ADMIN_UID, "admin");
      seedProject();
      seedPersonalWorkspace(uid);
      seedSource(SRC, { userId: uid, workspaceId: personalWs(uid), runDocument: runDocument(SRC, uid) });
      expect((await createTeamRunSnapshotFromPersonal(args({ uid }))).status).toBe("created");
    }
  });

  it("non-member, removed member → concealed authorization reasons, nothing written", async () => {
    expect(await createTeamRunSnapshotFromPersonal(args({ uid: OTHER_UID }))).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    seedMembership(MEMBER_UID, "member", WS_ID, { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.runs.size).toBe(1);
  });

  it("Z11 — a Project that belongs to a different Workspace is concealed as project_not_found (positive control: same Project id in the right Workspace → created)", async () => {
    seedProject(PROJECT_ID, { workspaceId: WS2_ID });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "project_not_found" });
    expect(stores.runs.size).toBe(1);
    seedProject(PROJECT_ID, { workspaceId: WS_ID });
    expect((await createTeamRunSnapshotFromPersonal(args())).status).toBe("created");
  });

  it("missing / malformed / embedded-id-mismatch Project → project_not_found", async () => {
    stores.projects.delete(PROJECT_ID);
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "project_not_found" });
    seedProject(PROJECT_ID, { name: "" });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "project_not_found" });
    seedProject(PROJECT_ID, { id: "some-other-id" });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "project_not_found" });
  });

  it("Z12 — an archived Project cannot receive a snapshot", async () => {
    seedProject(PROJECT_ID, { status: "archived" });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "project_archived" });
    expect(stores.runs.size).toBe(1);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
  });
});

describe("Z24 — aggregate size guard", () => {
  it("a payload over MAX_TOTAL_DOC_SIZE is refused BEFORE any write and never truncated", async () => {
    const src = stores.runs.get(SRC)!.data;
    src.runDocument = runDocument(SRC, MEMBER_UID, "x".repeat(MAX_TOTAL_DOC_SIZE));
    const before = JSON.stringify(src);
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "snapshot_too_large" });
    expect(stores.runs.size).toBe(1);
    expect(stores.runSnapshotLocks.size).toBe(0);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
    expect(JSON.stringify(stores.runs.get(SRC)!.data)).toBe(before);
    // Positive control: just under the budget is created.
    src.runDocument = runDocument(SRC, MEMBER_UID, "x".repeat(1000));
    expect((await createTeamRunSnapshotFromPersonal(args())).status).toBe("created");
  });
});

describe("Z28 — atomicity", () => {
  it("an audit-event write failure aborts the run AND the lock", async () => {
    forceSetFailureForCollection = "workspaceMembershipEvents";
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "transaction_failed" });
    expect(stores.runs.size).toBe(1);
    expect(stores.runSnapshotLocks.size).toBe(0);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
  });

  it("a lock write failure aborts the run AND the audit event", async () => {
    forceCreateFailureForCollection = "runSnapshotLocks";
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "transaction_failed" });
    expect(stores.runs.size).toBe(1);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
  });

  it("a run write failure aborts the lock AND the audit event", async () => {
    forceCreateFailureForCollection = "runs";
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "transaction_failed" });
    expect(stores.runSnapshotLocks.size).toBe(0);
    expect(stores.workspaceMembershipEvents.size).toBe(0);
  });
});

describe("Z29–Z35 — idempotency", () => {
  it("Z29/Z35 — the same tuple repeated returns already_exists with the SAME run id: no second run, lock, or audit event", async () => {
    const first = await createTeamRunSnapshotFromPersonal(args());
    if (first.status !== "created") throw new Error("expected created");
    const second = await createTeamRunSnapshotFromPersonal(args());
    expect(second).toEqual({ status: "already_exists", runId: first.runId, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(stores.runs.size).toBe(2);
    expect(stores.runSnapshotLocks.size).toBe(1);
    expect(stores.workspaceMembershipEvents.size).toBe(1);
  });

  it("the lock is READ in the read phase, and on a hit the destination run is read too — before any write", async () => {
    await createTeamRunSnapshotFromPersonal(args());
    readLog.length = 0;
    const second = await createTeamRunSnapshotFromPersonal(args());
    if (second.status !== "already_exists") throw new Error("expected already_exists");
    const order = readLog.map((r) => `${r.collection}/${r.id}`);
    expect(order).toContain(`runSnapshotLocks/${lockIdFor()}`);
    expect(order.indexOf(`runs/${second.runId}`)).toBeGreaterThan(order.indexOf(`runSnapshotLocks/${lockIdFor()}`));
  });

  it("Z30 — two same-tuple requests racing: the loser's create collides on the lock and commits nothing; exactly ONE destination exists and the retry converges on it", async () => {
    let injected = false;
    concurrentMutationHook = (ref) => {
      if (ref.__collection === "runSnapshotLocks" && !injected) {
        injected = true;
        // The "other" request commits between our lock read and our writes.
        const otherRunId = "run-22222222-2222-4222-8222-222222222222";
        stores.runs.set(otherRunId, {
          data: { userId: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT_ID, question: "q", status: "complete", createdAt: ts(900), completedAt: ts(900), origin: { type: "personal_research", runId: SRC, sourceCreatedAt: ts(500), sourceCompletedAt: ts(600) } },
          updateTime: nextUpdateTime(),
        });
        stores.runSnapshotLocks.set(lockIdFor(), {
          data: { version: 1, sourceRunId: SRC, workspaceId: WS_ID, projectId: PROJECT_ID, snapshotRunId: otherRunId, createdBy: MEMBER_UID, createdAt: ts(900) },
          updateTime: nextUpdateTime(),
        });
      }
    };
    const loser = await createTeamRunSnapshotFromPersonal(args());
    expect(loser).toEqual({ status: "transaction_failed" });
    expect(stores.runs.size).toBe(2); // source + the other request's snapshot only
    expect(stores.workspaceMembershipEvents.size).toBe(0);
    concurrentMutationHook = null;
    const retry = await createTeamRunSnapshotFromPersonal(args());
    expect(retry).toEqual({ status: "already_exists", runId: "run-22222222-2222-4222-8222-222222222222", workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(stores.runs.size).toBe(2);
  });

  it("Z31 — the same source into a DIFFERENT Project is allowed (two runs, two locks)", async () => {
    seedProject(PROJECT2_ID);
    const a = await createTeamRunSnapshotFromPersonal(args());
    const b = await createTeamRunSnapshotFromPersonal(args({ projectId: PROJECT2_ID }));
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    if (a.status !== "created" || b.status !== "created") throw new Error("expected created");
    expect(a.runId).not.toBe(b.runId);
    expect(stores.runSnapshotLocks.size).toBe(2);
    expect(stores.workspaceMembershipEvents.size).toBe(2);
  });

  it("Z32 — the same source into a different Workspace/Project is allowed", async () => {
    seedWorkspace(WS2_ID);
    seedMembership(OWNER_UID, "owner", WS2_ID);
    seedMembership(MEMBER_UID, "member", WS2_ID);
    stores.projects.set(PROJECT2_ID, { data: { ...seedProject(PROJECT2_ID), workspaceId: WS2_ID }, updateTime: nextUpdateTime() });
    const a = await createTeamRunSnapshotFromPersonal(args());
    const b = await createTeamRunSnapshotFromPersonal(args({ workspaceId: WS2_ID, projectId: PROJECT2_ID }));
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(stores.runSnapshotLocks.size).toBe(2);
  });

  it("Z33 — a malformed lock fails closed as integrity_failure: nothing written, no arbitrary id returned, no repair", async () => {
    stores.runSnapshotLocks.set(lockIdFor(), { data: { version: 1, sourceRunId: SRC, workspaceId: WS_ID, projectId: PROJECT_ID, snapshotRunId: "" }, updateTime: nextUpdateTime() });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "integrity_failure" });
    expect(stores.runs.size).toBe(1);
    expect(stores.runSnapshotLocks.get(lockIdFor())!.data.snapshotRunId).toBe("");
    expect(mockedLogger.error).toHaveBeenCalled();
  });

  it("Z33b — a lock whose stored tuple disagrees with the request is integrity_failure", async () => {
    stores.runSnapshotLocks.set(lockIdFor(), { data: { version: 1, sourceRunId: "run-other", workspaceId: WS_ID, projectId: PROJECT_ID, snapshotRunId: "run-x", createdBy: MEMBER_UID, createdAt: ts(1) }, updateTime: nextUpdateTime() });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "integrity_failure" });
    expect(stores.runs.size).toBe(1);
  });

  it("Z34 — a lock naming a MISSING destination, or one in the wrong Project, or one whose origin points at a different source, is integrity_failure — its id is never returned", async () => {
    const lock = { version: 1, sourceRunId: SRC, workspaceId: WS_ID, projectId: PROJECT_ID, snapshotRunId: "run-33333333-3333-4333-8333-333333333333", createdBy: MEMBER_UID, createdAt: ts(1) };
    stores.runSnapshotLocks.set(lockIdFor(), { data: lock, updateTime: nextUpdateTime() });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "integrity_failure" });

    const dest = { userId: MEMBER_UID, workspaceId: WS_ID, projectId: PROJECT2_ID, status: "complete", origin: { type: "personal_research", runId: SRC, sourceCreatedAt: ts(500), sourceCompletedAt: null } };
    stores.runs.set(lock.snapshotRunId, { data: dest, updateTime: nextUpdateTime() });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "integrity_failure" });

    stores.runs.set(lock.snapshotRunId, { data: { ...dest, projectId: PROJECT_ID, origin: { ...dest.origin, runId: "run-someone-else" } }, updateTime: nextUpdateTime() });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "integrity_failure" });

    // Positive control: the SAME lock with a structurally correct destination is a hit.
    stores.runs.set(lock.snapshotRunId, { data: { ...dest, projectId: PROJECT_ID }, updateTime: nextUpdateTime() });
    expect(await createTeamRunSnapshotFromPersonal(args())).toEqual({ status: "already_exists", runId: lock.snapshotRunId, workspaceId: WS_ID, projectId: PROJECT_ID });
    expect(stores.runs.size).toBe(2);
  });
});
