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
// Resolves to the mocked module above, so calling these goes through the observing wrappers —
// which is exactly what the §10 channel-liveness cases need to exercise each writer channel.
import { writeAdaptivePanelFinalizationGovernanceEvent, writeAdaptivePanelOverrideGovernanceEvent, writeAdaptiveHumanReviewEvent } from "@/lib/firestore/runs";
// Real, unmocked — the site witnesses interrogate fixture state through the SAME predicates
// production uses, so a witness cannot agree with a case that arranged its twin's state.
import { resolveWorkspaceReviewTarget } from "@/lib/workspaces/resolveWorkspaceReviewTarget";
import { parseAdaptiveHumanReviewPanel } from "@/lib/governance/adaptiveHumanReviewPanel";
import { parseSubmitAdaptiveReviewVoteRequest } from "@/lib/governance/adaptiveHumanReviewVote";

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
  for (const name of lazilyCreatedCollections) delete stores[name];
  lazilyCreatedCollections.clear();
  autoIdCounter = 0;
  governanceEventLog.length = 0;
  disabledEventObservers.clear();
  harnessViolations.length = 0;
}

/**
 * ─── R8 §19/§20 — UNSUPPORTED WRITE APIs FAIL CLOSED EVEN WHEN PRODUCTION SWALLOWS ────────────
 *
 * R7 BLOCKER: `BulkWriter` was simply absent from the fake, so calling it threw a `TypeError` that
 * the module's swallow-and-warn house style discarded — an entire real write surface was silent.
 * Implementing more methods is necessary but can never be future-complete, so an unrecognised
 * write-capable API now records a violation HERE, independently of whether the thrown sentinel ever
 * reaches the test. The assertion is on this array, not on the production promise.
 */
const harnessViolations: string[] = [];
function recordHarnessViolation(what: string): void {
  harnessViolations.push(what);
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

/**
 * Sub-collections of `runs/{runId}` are flattened into one map per collection, keyed
 * `${runId}::${subId}`. The set lives in one place so `subKey` (which builds the key) and
 * `canonicalPathOf` (which reconstructs the Firestore path from it) cannot drift apart.
 */
const RUN_SUBCOLLECTIONS: ReadonlySet<string> = new Set(["humanReviewVotes", "humanReviewAssignment", "humanReviewPanel", "governanceEvents"]);

function subKey(collection: string, parentId: string, subId: string): string {
  return RUN_SUBCOLLECTIONS.has(collection) ? `${parentId}::${subId}` : subId;
}

let autoIdCounter = 0;

/**
 * ─── R5 §4–§11 — WHOLE-EVENT-STORE OBSERVATION ────────────────────────────────────────────────
 *
 * R4 BLOCKER: the previous oracle read ONE channel — the in-memory fake's `tx.set` store, filtered
 * to keys prefixed `${RUN_ID}::`. Four independent escapes survived the entire suite: a
 * governance event minted through an imported (mocked) writer helper on a rejection path, on the
 * CREATE success path, and on the idempotent vote-replay path; a write to a TOP-LEVEL
 * `governanceEvents` collection (whose key carries no run prefix); and a write to a
 * `${runId}-shadow` document. "Writes no event via appendPanelGovernanceEvent" was being reported
 * as "writes no event".
 *
 * The write surface below is derived from the PRODUCTION module's own source — its Firestore write
 * mechanisms and its imported persistence dependencies — never from what the old test ledger
 * happened to observe. `PRODUCTION_EVENT_CHANNEL_CONTRACT` re-derives it from source at run time
 * and fails closed if the module gains a governance-event-capable dependency this harness does not
 * instrument.
 */
type GovernanceEventChannel =
  | "transaction.set"
  | "transaction.update"
  | "transaction.create"
  | "direct.set"
  | "direct.create"
  | "direct.update"
  | "batch.set"
  | "batch.update"
  | "bulkwriter.set"
  | "bulkwriter.create"
  | "bulkwriter.update"
  | "writer.panelFinalizationGovernanceEvent"
  | "writer.panelOverrideGovernanceEvent"
  | "writer.adaptiveHumanReviewEvent";

type GovernanceEventObservation = {
  channel: GovernanceEventChannel;
  mode: "transaction" | "direct-writer";
  /** Full resource identity, never collapsed to a leaf id — a shadow run document must stay visible as one. */
  path: string;
  collection: string;
  /** The fake's own store key, when the write lands in a store; `null` for a writer-helper call. */
  storeKey: string | null;
  action: unknown;
  actor: unknown;
  /** A DEEP CLONE taken at write time. See `snapshotPayload`. */
  payload: Record<string, unknown>;
  /**
   * Set when the write actually lands — by the pending-write closure for a transactional channel,
   * immediately for a direct one. R5 MAJOR: the previous commit test compared
   * `stores[c].get(key) === payload` by object IDENTITY, which is false unconditionally for
   * `transaction.update` (the fake's update path builds a NEW object via `applyDottedFieldUpdate`),
   * so a second event on one of the oracle's own declared channels could never be seen as committed.
   */
  committed: boolean;
  /** Why this write counts as a governance event — recorded so the classification is reviewable. */
  classifiedBy: "governanceEvents-collection" | "audit-shaped-payload";
};

/**
 * R5 MAJOR: the fake stored a LIVE REFERENCE, so every payload assertion — including the whole
 * provenance matrix — described the object's FINAL state rather than what was persisted. Real
 * Firestore serialises at `set()` time, so forging a field, writing, then repairing the object
 * survived the suite while production would have persisted the forged value. Both the store and the
 * observation now hold a deep clone taken at write time.
 */
function snapshotPayload(data: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(data) as Record<string, unknown>;
}

const governanceEventLog: GovernanceEventObservation[] = [];
/**
 * §10 — the oracle's own falsifier. Disabling a channel here must make the channel-liveness
 * mechanism control fail, which is what proves each observer is load-bearing rather than decorative.
 */
const disabledEventObservers = new Set<GovernanceEventChannel>();

/** Returns the observation when it was recorded, so a caller can later mark it committed. */
function observeGovernanceEvent(observation: GovernanceEventObservation): GovernanceEventObservation | null {
  if (disabledEventObservers.has(observation.channel)) return null;
  governanceEventLog.push(observation);
  return observation;
}

const GOVERNANCE_EVENT_COLLECTION = "governanceEvents";

/**
 * R5 BLOCKER: the previous oracle recorded a write only when its collection name was literally
 * `governanceEvents`. Six other collections are registered in this fake, and each was a silent sink
 * — a duplicate durable audit record written to `humanReviewAssignment` survived on every success
 * path, and a forged `vote_cast` written there survived on every rejection path. The oracle was
 * scoped to a name, not to the store.
 *
 * A write is now a governance-event write if EITHER its collection is a `governanceEvents`
 * collection (whatever the path) OR its payload is audit-shaped — it carries a string `action`.
 * That second clause is what closes the sink, and it is safe here because NO canonical write in the
 * audited module carries an `action` field: the panel document, the vote document and the
 * `governanceRecord.humanReview` update have no such property, so there are no false positives.
 * `assertNoCanonicalWriteIsAuditShaped` below pins that precondition rather than assuming it.
 */
function isAuditShapedPayload(data: unknown): boolean {
  return typeof data === "object" && data !== null && typeof (data as { action?: unknown }).action === "string";
}

/**
 * §7 — the imported writer helpers are a SECOND, independent channel into the very same
 * `runs/{runId}/governanceEvents` collection: they are `await`ed outside the transaction and write
 * through the real Firestore client, which this suite mocks. Observing them here is what makes
 * "exactly one event" and "zero events" statements hold across channels rather than within one.
 * Declared as a `function` so the hoisted `jest.mock` factories below can reach it.
 */
function observeWriterGovernanceEvent(channel: GovernanceEventChannel, runId: unknown, eventId: string, payload: Record<string, unknown>): void {
  observeGovernanceEvent({
    channel,
    mode: "direct-writer",
    path: `runs/${String(runId)}/${GOVERNANCE_EVENT_COLLECTION}/${eventId}`,
    collection: GOVERNANCE_EVENT_COLLECTION,
    storeKey: null,
    action: payload?.action,
    actor: payload?.byUid,
    payload: snapshotPayload(payload),
    // these writers persist immediately through the real client, so the call IS the commit
    committed: true,
    classifiedBy: "governanceEvents-collection",
  });
}

/**
 * ─── R8 §5 — EVERY COLLECTION IS VISIBLE, INCLUDING ONE CREATED DURING EXECUTION ──────────────
 *
 * R7 BLOCKER: the previous version threw for an unregistered collection. That is fail-closed only
 * when the exception escapes — and the audited module's own house style for post-commit audit
 * writes is `try { await write } catch { logger.warn(...) }`, which swallows it. A collection is now
 * created on demand and therefore appears in the final-state diff, so an unexpected durable write
 * is caught by the DELTA rather than by an exception production is free to discard.
 */
function storeFor(collectionName: string): Map<string, StoredDoc> {
  let store = stores[collectionName];
  if (!store) {
    store = new Map();
    stores[collectionName] = store;
    lazilyCreatedCollections.add(collectionName);
  }
  return store;
}

/** Collections that did not exist when the suite started — reset with the stores. */
const lazilyCreatedCollections = new Set<string>();

/**
 * The Firestore path a flattened store key corresponds to. Derived, never registered, so a document
 * seeded directly into a store is described exactly like one written through a reference.
 */
function canonicalPathOf(collectionName: string, key: string): string {
  if (RUN_SUBCOLLECTIONS.has(collectionName)) {
    const separator = key.indexOf("::");
    if (separator >= 0) return `runs/${key.slice(0, separator)}/${collectionName}/${key.slice(separator + 2)}`;
  }
  return `${collectionName}/${key}`;
}

/**
 * ─── R8 §3–§6 — THE SECURITY ORACLE IS THE FINAL STORE, NOT THE WRITE LOG ─────────────────────
 *
 * R7 BLOCKER 1, and the organizing defect of the whole series: every cardinality and payload
 * conclusion was drawn from `governanceEventLog`, a derived accounting artifact. Exactly ONE
 * assertion in 343 tests read the store. So an event could be written and DELETED in the same
 * transaction — the log said "one committed event", the store held none, and the suite passed.
 *
 * The verdict now comes from a complete before/after snapshot of every collection, diffed by
 * canonical path. Nothing is classified by collection name, by an `action` field, or by any guess
 * at what an audit record looks like: an unexpected durable change of ANY shape, anywhere, is a
 * delta. `governanceEventLog` survives for channel liveness and retry diagnostics ONLY, and no
 * security assertion may read it.
 */
type StoreSnapshot = ReadonlyMap<string, string>;

/** Deterministic serialisation: object keys sorted recursively, so a diff reflects value changes only. */
function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      const source = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(source).sort()) out[k] = normalize(source[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value)) ?? "undefined";
}

function snapshotStore(): StoreSnapshot {
  const snapshot = new Map<string, string>();
  for (const [collectionName, store] of Object.entries(stores)) {
    for (const [key, doc] of store.entries()) snapshot.set(canonicalPathOf(collectionName, key), stableJson(doc));
  }
  return snapshot;
}

type StoreDelta = {
  added: string[];
  deleted: string[];
  modified: { path: string; before: string; after: string }[];
};

function diffStore(before: StoreSnapshot, after: StoreSnapshot): StoreDelta {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: { path: string; before: string; after: string }[] = [];
  for (const [path, afterJson] of after) {
    const beforeJson = before.get(path);
    if (beforeJson === undefined) added.push(path);
    else if (beforeJson !== afterJson) modified.push({ path, before: beforeJson, after: afterJson });
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { added: added.sort(), deleted: deleted.sort(), modified: modified.sort((a, b) => a.path.localeCompare(b.path)) };
}

const describeDelta = (d: StoreDelta) => `added:[${d.added.join(" ")}] modified:[${d.modified.map((m) => m.path).join(" ")}] deleted:[${d.deleted.join(" ")}]`;

/**
 * ─── R8 §19/§20 — A FAIL-CLOSED SURFACE, SO "UNIMPLEMENTED" CANNOT MEAN "SILENT" ──────────────
 *
 * Modelling more of the SDK is necessary but can never be future-complete. Any property this fake
 * does not implement is now recorded as a harness violation on access and then throws a sentinel.
 * The assertion is on `harnessViolations`, never on whether the sentinel escaped — which is the
 * whole point, because the audited module's house style swallows exceptions from audit writes.
 */
const HARNESS_INFRASTRUCTURE_PROPS: readonly string[] = [
  "then", "catch", "finally", "toJSON", "inspect", "constructor", "valueOf", "toString",
  "asymmetricMatch", "$$typeof", "nodeType", "tagName", "hasAttribute", "_isMockFunction", "mock",
  "length", "name", "prototype",
];

function failClosedSurface<T extends object>(target: T, label: string): T {
  const allow = new Set<string>(HARNESS_INFRASTRUCTURE_PROPS);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "symbol" || prop in obj || allow.has(prop)) return Reflect.get(obj, prop, receiver);
      recordHarnessViolation(`${label}.${String(prop)}`);
      return (...args: unknown[]) => {
        void args;
        throw new Error(`R8 harness: ${label}.${String(prop)} is a write-capable API this fake does not model`);
      };
    },
  }) as T;
}

/**
 * ─── R8 §7–§9 — THE OPERATION-SPECIFIC ALLOWED DELTA ──────────────────────────────────────────
 *
 * Each audited operation declares the EXACT durable change it is allowed to make. Anything else —
 * an extra document in any collection, a modification to any other document, any deletion — fails,
 * with no dependence on what an audit record is shaped like. `oneAddedUnder` matches the event
 * structurally because its id is a Firestore auto-id, while still pinning the parent resource.
 */
type ExpectedDelta = {
  /** Exactly one added document directly under this canonical parent path. */
  oneAddedUnder?: string;
  /** Additional exact canonical paths expected to be added. */
  added?: readonly string[];
  modified?: readonly string[];
  deleted?: readonly string[];
};

function assertNoHarnessViolation(label: string): void {
  expect(`${label}:unsupportedWriteApiUsed:${[...new Set(harnessViolations)].join(",")}`).toBe(`${label}:unsupportedWriteApiUsed:`);
}

function expectStoreDelta(label: string, before: StoreSnapshot, expected: ExpectedDelta): StoreDelta {
  assertNoHarnessViolation(label);
  const delta = diffStore(before, snapshotStore());
  const parent = expected.oneAddedUnder;
  const underParent = parent ? delta.added.filter((p) => p.startsWith(`${parent}/`) && !p.slice(parent.length + 1).includes("/")) : [];
  if (parent) {
    expect(`${label}:addedUnder(${parent}):${underParent.length}`).toBe(`${label}:addedUnder(${parent}):1`);
  }
  const otherAdded = delta.added.filter((p) => !underParent.includes(p));
  expect(`${label}:added:${otherAdded.join(" ")}`).toBe(`${label}:added:${[...(expected.added ?? [])].sort().join(" ")}`);
  expect(`${label}:modified:${delta.modified.map((m) => m.path).join(" ")}`).toBe(`${label}:modified:${[...(expected.modified ?? [])].sort().join(" ")}`);
  expect(`${label}:deleted:${delta.deleted.join(" ")}`).toBe(`${label}:deleted:${[...(expected.deleted ?? [])].sort().join(" ")}`);
  return delta;
}

/** §8/§9 — the durable state is byte-identical to the pre-call snapshot. */
function expectNoDurableChange(label: string, before: StoreSnapshot): void {
  assertNoHarnessViolation(label);
  const delta = diffStore(before, snapshotStore());
  expect(`${label}:${describeDelta(delta)}`).toBe(`${label}:added:[] modified:[] deleted:[]`);
}

/**
 * §63 — provenance is asserted against the FINAL PERSISTED DOCUMENT, never a helper's call
 * arguments, never the write log's payload, and never a source object that may since have been
 * mutated. Resolves the single event document the operation added and returns what the store holds.
 */
function soleStoredPanelEvent(delta: StoreDelta, parent: string): { path: string; payload: Record<string, unknown> } {
  const under = delta.added.filter((p) => p.startsWith(`${parent}/`) && !p.slice(parent.length + 1).includes("/"));
  if (under.length !== 1) {
    throw new Error(`expected exactly ONE added document under ${parent}, saw ${under.length}: ${JSON.stringify(under)} (full delta ${describeDelta(delta)})`);
  }
  const path = under[0];
  const subId = path.slice(parent.length + 1);
  const runId = parent.split("/")[1];
  const payload = stores.governanceEvents.get(`${runId}::${subId}`);
  if (!payload) throw new Error(`the added event document ${path} is not present in the store`);
  return { path, payload: payload as Record<string, unknown> };
}

/** The canonical governanceEvents parent for a run. */
const eventParentPath = (runId: string) => `runs/${runId}/governanceEvents`;

function recordFirestoreWrite(
  channel: GovernanceEventChannel,
  mode: "transaction" | "direct-writer",
  ref: { __collection: string; __id: string; __path: string },
  data: Record<string, unknown>
): GovernanceEventObservation | null {
  const byCollection = ref.__collection === GOVERNANCE_EVENT_COLLECTION;
  if (!byCollection && !isAuditShapedPayload(data)) return null;
  const observation: GovernanceEventObservation = {
    channel,
    mode,
    path: ref.__path,
    collection: ref.__collection,
    storeKey: ref.__id,
    action: (data as { action?: unknown })?.action,
    actor: (data as { byUid?: unknown })?.byUid,
    payload: snapshotPayload(data),
    committed: false,
    classifiedBy: byCollection ? "governanceEvents-collection" : "audit-shaped-payload",
  };
  return observeGovernanceEvent(observation) ? observation : null;
}

function makeSubDocRef(subCollectionName: string, parentCollectionName: string, parentDocId: string, subDocId: string) {
  // R5 NIT — the fake flattens every run's subcollection into one map under a `${parentId}::${subId}`
  // key, so a document id that itself contains `::` could collide with another run's event and
  // overwrite it while still being classified committed. Fail closed rather than allow the ambiguity.
  if (subDocId.includes("::") || parentDocId.includes("::")) {
    throw new Error(`R5 harness: document id contains the composite key separator "::" (${parentDocId}/${subDocId}) — the flattened store cannot represent it unambiguously`);
  }
  const key = subKey(subCollectionName, parentDocId, subDocId);
  const ref = {
    __collection: subCollectionName,
    __id: key,
    __path: `${parentCollectionName}/${parentDocId}/${subCollectionName}/${subDocId}`,
    get: async () => {
      const data = stores[subCollectionName].get(key);
      return { exists: data !== undefined, data: () => data, id: subDocId };
    },
    id: subDocId,
    path: `${parentCollectionName}/${parentDocId}/${subCollectionName}/${subDocId}`,
    ...directWriteMethods(() => ref, subCollectionName, key),
  };
  return failClosedSurface(ref, `DocumentReference(${subCollectionName})`);
}

/**
 * R5 BLOCKER: the fake implemented only the write methods the audited production code happens to
 * call today. `add()`, `Transaction.create`/`delete` and `batch()` were absent — so a write through
 * any of them threw a `TypeError`, and the module's own established house style for post-commit
 * audit writes (`try { await write } catch { logger.warn(...) }`) swallowed it. Three real Admin SDK
 * write APIs were therefore silent channels, and `.add()` is the idiom two other governance-event
 * writers in this repo already use. The full surface is now implemented and observed, so an
 * unimplemented method cannot be the thing that hides a write.
 */
function directWriteMethods(getRef: () => { __collection: string; __id: string; __path: string }, collectionName: string, key: string) {
  return {
    set: async (data: Record<string, unknown>) => {
      const o = recordFirestoreWrite("direct.set", "direct-writer", getRef(), data);
      storeFor(collectionName).set(key, snapshotPayload(data));
      if (o) o.committed = true;
    },
    create: async (data: Record<string, unknown>) => {
      const o = recordFirestoreWrite("direct.create", "direct-writer", getRef(), data);
      if (storeFor(collectionName).has(key)) {
        const err = new Error("ALREADY_EXISTS") as Error & { code: number };
        err.code = 6;
        throw err;
      }
      storeFor(collectionName).set(key, snapshotPayload(data));
      if (o) o.committed = true;
    },
    update: async (data: Record<string, unknown>) => {
      const o = recordFirestoreWrite("direct.update", "direct-writer", getRef(), data);
      const store = storeFor(collectionName);
      store.set(key, applyDottedFieldUpdate(store.get(key) ?? {}, snapshotPayload(data)));
      if (o) o.committed = true;
    },
    delete: async () => {
      storeFor(collectionName).delete(key);
    },
  };
}

function makeDocRef(collectionName: string, docId: string) {
  const ref = {
    __collection: collectionName,
    __id: docId,
    __path: `${collectionName}/${docId}`,
    collection: (subCollectionName: string) => failClosedSurface({
      // Phase 9C.5 — `.doc()` with no argument mirrors real Firestore's
      // auto-ID generation, needed by `resubmitWorkspaceReview()`'s
      // `runRef.collection("governanceEvents").doc()` call.
      doc: (subDocId?: string) => makeSubDocRef(subCollectionName, collectionName, docId, subDocId ?? `auto-${++autoIdCounter}`),
      // R5 BLOCKER — `CollectionReference.add()`, the idiom the other governance-event writers use.
      add: async (data: Record<string, unknown>) => {
        const subRef = makeSubDocRef(subCollectionName, collectionName, docId, `auto-${++autoIdCounter}`);
        await subRef.set(data);
        return subRef;
      },
    }, `CollectionReference(${subCollectionName})`),
    get: async () => {
      const data = stores[collectionName].get(docId);
      return { exists: data !== undefined, data: () => data, id: docId };
    },
    id: docId,
    path: `${collectionName}/${docId}`,
    ...directWriteMethods(() => ref, collectionName, docId),
  };
  return failClosedSurface(ref, `DocumentReference(${collectionName})`);
}

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
const firestoreUnavailableFlag = { value: false };
/** R3: when set to a collection name, the fake transaction's `set` throws for that collection. */
const throwOnSetCollection: { value: string | null } = { value: null };
const transactionShouldThrow = { value: false };
const transactionAttemptCount = { value: 0 };
const MAX_TRANSACTION_ATTEMPTS = 5;

const mockAdminDb: any = {
  collection: (name: string) => failClosedSurface({
    doc: (docId: string) => makeDocRef(name, docId),
    add: async (data: Record<string, unknown>) => {
      const ref = makeDocRef(name, `auto-${++autoIdCounter}`);
      await ref.set(data);
      return ref;
    },
  }, `CollectionReference(${name})`),
  /**
   * R5 BLOCKER — `WriteBatch`. Absent before, so a batched governance-event write threw a
   * `TypeError` that the module's swallow-and-warn style hid. Batched writes commit as a unit, so
   * they are observed at `set()` time and marked committed on `commit()`.
   */
  batch: () => {
    const queued: Array<() => void> = [];
    return failClosedSurface({
      set: (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
        const observation = recordFirestoreWrite("batch.set", "direct-writer", ref, data);
        const snapshot = snapshotPayload(data);
        queued.push(() => {
          storeFor(ref.__collection).set(ref.__id, snapshot);
          if (observation) observation.committed = true;
        });
      },
      update: (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
        const observation = recordFirestoreWrite("batch.update", "direct-writer", ref, data);
        const snapshot = snapshotPayload(data);
        queued.push(() => {
          const store = storeFor(ref.__collection);
          store.set(ref.__id, applyDottedFieldUpdate(store.get(ref.__id) ?? {}, snapshot));
          if (observation) observation.committed = true;
        });
      },
      delete: (ref: { __collection: string; __id: string }) => {
        queued.push(() => storeFor(ref.__collection).delete(ref.__id));
      },
      commit: async () => {
        for (const apply of queued) apply();
        return [];
      },
    }, "WriteBatch");
  },

  /**
   * R8 §21 — BulkWriter. R7 proved its absence made an entire real write surface silent: the
   * `TypeError` was swallowed by the module's own house style. Modelled here as APPLYING
   * IMMEDIATELY rather than buffering until `flush()`/`close()`. That is a deliberate choice and
   * strictly more detecting than the real SDK: a write production never flushes is still visible in
   * the final-state diff, so a forged record cannot hide behind a missing flush.
   */
  bulkWriter: () => failClosedSurface({
    set: async (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
      const o = recordFirestoreWrite("bulkwriter.set", "direct-writer", ref, data);
      storeFor(ref.__collection).set(ref.__id, snapshotPayload(data));
      if (o) o.committed = true;
    },
    create: async (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
      const o = recordFirestoreWrite("bulkwriter.create", "direct-writer", ref, data);
      const store = storeFor(ref.__collection);
      if (store.has(ref.__id)) { const err = new Error("ALREADY_EXISTS") as Error & { code: number }; err.code = 6; throw err; }
      store.set(ref.__id, snapshotPayload(data));
      if (o) o.committed = true;
    },
    update: async (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
      const o = recordFirestoreWrite("bulkwriter.update", "direct-writer", ref, data);
      const store = storeFor(ref.__collection);
      store.set(ref.__id, applyDottedFieldUpdate(store.get(ref.__id) ?? {}, snapshotPayload(data)));
      if (o) o.committed = true;
    },
    delete: async (ref: { __collection: string; __id: string }) => { storeFor(ref.__collection).delete(ref.__id); },
    flush: async () => undefined,
    close: async () => undefined,
  }, "BulkWriter"),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    if (transactionShouldThrow.value) throw new Error("simulated transaction failure");
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
      transactionAttemptCount.value++;
      const pendingWrites: Array<() => void> = [];
      const readSnapshots = new Map<string, unknown>();
      let hasWritten = false;
      const txn = failClosedSurface({
        get: async (ref: { __collection: string; __id: string }) => {
          if (hasWritten) throw new Error("Firestore transactions require all reads to be executed before all writes.");
          const store = stores[ref.__collection];
          const data = store.get(ref.__id);
          readSnapshots.set(`${ref.__collection}/${ref.__id}`, data);
          if (concurrentMutationHook) concurrentMutationHook(ref);
          return { exists: data !== undefined, data: () => data, id: ref.__id };
        },
        update: (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          const observation = recordFirestoreWrite("transaction.update", "transaction", ref, data);
          const snapshot = snapshotPayload(data);
          pendingWrites.push(() => {
            const store = storeFor(ref.__collection);
            const existing = store.get(ref.__id) ?? {};
            store.set(ref.__id, applyDottedFieldUpdate(existing, snapshot));
            // marked HERE, when the write actually lands — not inferred from object identity
            if (observation) observation.committed = true;
          });
        },
        set: (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          // R3 §35/§36 — MODELLED transactional write failure, so the atomicity guarantees are
          // COMMITTED regressions instead of review-time probes. Throwing here aborts the callback
          // before any `pendingWrites` are applied.
          //
          // R5 §49 — precise language: the real Admin SDK's `set()` only appends to the write
          // batch and performs no I/O, so a PER-DOCUMENT write rejection is not a failure mode the
          // real SDK exposes; a real commit fails as a whole. This injection models "the audit
          // write does not land" at the earliest point the module could observe it, and the
          // guarantee it pins — the module never commits the canonical mutation when its audit
          // write does not land — is if anything STRONGER under real Firestore's single atomic
          // commit. The injection is a modelling device, not a claimed SDK behaviour.
          if (throwOnSetCollection.value !== null && ref.__collection === throwOnSetCollection.value) {
            throw new Error(`modelled transactional write failure for ${ref.__collection}`);
          }
          // Observed at ATTEMPT time, not at commit time: an aborted attempt's buffered writes are
          // discarded, so the retry suite distinguishes "attempted" from "committed" itself.
          const observation = recordFirestoreWrite("transaction.set", "transaction", ref, data);
          const snapshot = snapshotPayload(data);
          pendingWrites.push(() => {
            storeFor(ref.__collection).set(ref.__id, snapshot);
            if (observation) observation.committed = true;
          });
        },
        // R5 BLOCKER — the remaining Transaction write methods, so neither can be a silent channel.
        create: (ref: { __collection: string; __id: string; __path: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          const observation = recordFirestoreWrite("transaction.create", "transaction", ref, data);
          const snapshot = snapshotPayload(data);
          pendingWrites.push(() => {
            const store = storeFor(ref.__collection);
            if (store.has(ref.__id)) {
              const err = new Error("ALREADY_EXISTS") as Error & { code: number };
              err.code = 6;
              throw err;
            }
            store.set(ref.__id, snapshot);
            if (observation) observation.committed = true;
          });
        },
        delete: (ref: { __collection: string; __id: string; __path: string }) => {
          hasWritten = true;
          pendingWrites.push(() => storeFor(ref.__collection).delete(ref.__id));
        },
      }, "Transaction");
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

/** R8 §19 — the Firestore ROOT is fail-closed too: `adminDb.recursiveDelete(...)` must record a violation, not be an undefined property whose TypeError production swallows. */
const failClosedAdminDb: any = failClosedSurface(mockAdminDb, "Firestore");

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : failClosedAdminDb;
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
  // R5 §4/§7 — these three write into runs/{runId}/governanceEvents through the real client, so
  // they are instrumented channels of the whole-event-store oracle, not merely call-count spies.
  writeAdaptivePanelFinalizationGovernanceEvent: (...args: unknown[]) => {
    const a = (args[0] ?? {}) as Record<string, unknown>;
    observeWriterGovernanceEvent("writer.panelFinalizationGovernanceEvent", a.runId, `panel-finalized:${String(a.finalDecisionId)}`, { action: "multi_reviewer_panel_finalized", byUid: a.actorUserId, at: a.finalizedAt, ...a });
    return mockedWriteAdaptivePanelFinalizationGovernanceEvent(...args);
  },
  writeAdaptivePanelOverrideGovernanceEvent: (...args: unknown[]) => {
    const a = (args[0] ?? {}) as Record<string, unknown>;
    observeWriterGovernanceEvent("writer.panelOverrideGovernanceEvent", a.runId, `panel-owner-overridden:${String(a.finalDecisionId)}`, { action: "multi_reviewer_panel_owner_overridden", byUid: a.overrideByUserId, at: a.finalizedAt, ...a });
    return mockedWriteAdaptivePanelOverrideGovernanceEvent(...args);
  },
  createAdaptiveHumanReviewAssignmentHistory: (...args: unknown[]) => mockedCreateAdaptiveHumanReviewAssignmentHistory(...args),
  writeAdaptiveHumanReviewEvent: (...args: unknown[]) => {
    const a = (args[0] ?? {}) as Record<string, unknown>;
    observeWriterGovernanceEvent("writer.adaptiveHumanReviewEvent", a.runId, "auto-writer", { action: "human_review_decision", byUid: a.actorUserId ?? a.byUid, at: a.at, ...a });
    return mockedWriteAdaptiveHumanReviewEvent(...args);
  },
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
  seedBaseFixture();
});

/**
 * The per-test baseline, extracted so the witness meta-test can re-establish it between arranging
 * one site's state and its twin's. It also restores the capability mock, because the synthetic
 * capability split is the discriminator for three of the witnessed sites.
 */
function seedBaseFixture() {
  resetStores();
  mockedRoleHasCapability.mockImplementation(actualCapabilities.roleHasCapability);
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
}

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
/**
 * ─── R5 §6/§11 — THE ALL-CHANNEL CARDINALITY CONTRACT ─────────────────────────────────────────
 *
 * R4 BLOCKER BL1. The previous helper was:
 *
 *     [...stores.governanceEvents.entries()].filter(([k]) => k.startsWith(`${RUN_ID}::`))
 *
 * which observes ONE channel (the fake's transactional set store) at ONE key shape. Four escapes
 * survived it: an event minted through an imported writer helper (rejection path, CREATE success
 * path, and idempotent vote replay), a write to a TOP-LEVEL `governanceEvents` collection whose key
 * carries no run prefix, and a write to a `${runId}-shadow` document. Every "exactly one event" and
 * "no event" statement in this file was therefore scoped to one collection path, not to the store.
 *
 * ATTEMPTED vs COMMITTED, deliberately separated:
 *   • `attemptedGovernanceEventCount()` counts every write ATTEMPT on every channel. Zero-event
 *     claims use it, because a rejection path must not even attempt an audit write.
 *   • `committedGovernanceEvents()` keeps only the attempts that survived — for a transactional
 *     channel, the store still holds that exact payload object. Exactly-one claims use it, because
 *     a retried transaction legitimately ATTEMPTS twice and COMMITS once (the aborted attempt's
 *     buffered writes are discarded), and conflating the two would break the retry proof.
 */
const PANEL_MUTATION_ACTIONS: readonly string[] = Object.freeze([
  "adaptive_review_panel_created",
  "adaptive_review_panel_reconfigured",
  "adaptive_review_panel_cancelled",
  "adaptive_review_panel_vote_cast",
]);

const attemptedGovernanceEventCount = () => governanceEventLog.length;
const committedGovernanceEvents = (): readonly GovernanceEventObservation[] => governanceEventLog.filter((o) => o.committed);

/**
 * §11 — positive tests resolve THE sole accepted event from the all-channel committed ledger and
 * assert its canonical path, rather than asking a narrow helper for "the event" and thereby
 * reintroducing the observation gap. Throws (rather than returning a default) when cardinality is
 * violated, so a second event on any channel surfaces here instead of being silently ignored.
 */
function soleCommittedGovernanceEvent(): GovernanceEventObservation {
  const committed = committedGovernanceEvents();
  if (committed.length !== 1) {
    throw new Error(`expected exactly ONE committed governance event across all channels, saw ${committed.length}: ${JSON.stringify(committed.map((o) => ({ channel: o.channel, path: o.path, action: o.action })))}`);
  }
  return committed[0];
}

/** The payloads of the committed panel-mutation events, for shape assertions. */
const panelEvents = (): Record<string, unknown>[] => committedGovernanceEvents().filter((o) => PANEL_MUTATION_ACTIONS.includes(String(o.action))).map((o) => o.payload);

/**
 * §7 — OPERATION-SCOPED. The target module also imports the finalization/override governance,
 * history and admin-audit writers. None of them is called by create/reconfigure/cancel/vote (they
 * are reached only from `finalizeWorkspaceReviewPanel` at lines 917-957 and
 * `overrideWorkspaceReviewPanel` at lines 1162-1178). This asserts that for the four audited
 * operations only — it makes no claim that those helpers are forbidden anywhere else, and the
 * finalize/override suites below legitimately assert they ARE called.
 */
function expectNoForeignPersistenceWriters(): void {
  const foreign: Record<string, jest.Mock> = {
    writeAdaptivePanelFinalizationGovernanceEvent: mockedWriteAdaptivePanelFinalizationGovernanceEvent,
    writeAdaptivePanelOverrideGovernanceEvent: mockedWriteAdaptivePanelOverrideGovernanceEvent,
    writeAdaptiveHumanReviewEvent: mockedWriteAdaptiveHumanReviewEvent,
    createAdaptiveHumanReviewHistory: mockedCreateAdaptiveHumanReviewHistory,
    createAdaptivePanelFinalizationHistory: mockedCreateAdaptivePanelFinalizationHistory,
    createAdaptivePanelOverrideHistory: mockedCreateAdaptivePanelOverrideHistory,
    writeAdaptivePanelFinalizationAdminAuditEvent: mockedWriteAdaptivePanelFinalizationAdminAuditEvent,
    writeAdaptivePanelOverrideAdminAuditEvent: mockedWriteAdaptivePanelOverrideAdminAuditEvent,
  };
  const called = Object.entries(foreign).filter(([, m]) => m.mock.calls.length > 0).map(([name, m]) => `${name}x${m.mock.calls.length}`);
  expect(`foreignPersistenceWritersCalled:${called.join(",")}`).toBe("foreignPersistenceWritersCalled:");
}

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

/**
 * ─── R5 §9/§10 — THE CHANNEL INVENTORY FAILS CLOSED, AND THE ORACLE IS ITSELF FALSIFIABLE ──────
 *
 * Two distinct obligations, easy to conflate:
 *   §9 COVERAGE — every governance-event-capable mechanism the PRODUCTION module can reach must be
 *     represented in the harness. Derived from the module's own source (its persistence imports and
 *     the write methods it invokes), never from what the harness happens to instrument, so adding a
 *     new writer dependency in production fails this suite instead of silently escaping the oracle.
 *   §10 LIVENESS — each instrumented channel's observer must actually fire. Without this, "we
 *     observe eight channels" is an unfalsifiable claim: an observer could be disabled or wired to
 *     the wrong hook and every zero-event assertion would pass for the wrong reason. Disabling any
 *     single channel's observation breaks exactly that channel's case below.
 */
const INSTRUMENTED_EVENT_CHANNELS: readonly GovernanceEventChannel[] = Object.freeze([
  "transaction.set",
  "transaction.update",
  "transaction.create",
  "direct.set",
  "direct.create",
  "direct.update",
  "batch.set",
  "batch.update",
  "bulkwriter.set",
  "bulkwriter.create",
  "bulkwriter.update",
  "writer.panelFinalizationGovernanceEvent",
  "writer.panelOverrideGovernanceEvent",
  "writer.adaptiveHumanReviewEvent",
]);

/** Modules whose exports PERSIST something. A new import from one of these must be classified. */
const PERSISTENCE_MODULES: readonly string[] = Object.freeze(["@/lib/firestore/runs", "@/lib/governance/auditLog"]);

/**
 * Every persistence import the production module takes, classified. An entry naming a channel is
 * instrumented by the oracle; `"not-a-governance-event-writer"` records a reviewed judgement that
 * the export writes somewhere other than `governanceEvents` (history and admin-audit collections),
 * and those are still asserted un-called for the four audited operations by
 * `expectNoForeignPersistenceWriters()`.
 */
const PERSISTENCE_IMPORT_CLASSIFICATION: Readonly<Record<string, GovernanceEventChannel | "not-a-governance-event-writer">> = Object.freeze({
  writeAdaptivePanelFinalizationGovernanceEvent: "writer.panelFinalizationGovernanceEvent",
  writeAdaptivePanelOverrideGovernanceEvent: "writer.panelOverrideGovernanceEvent",
  writeAdaptiveHumanReviewEvent: "writer.adaptiveHumanReviewEvent",
  createAdaptivePanelFinalizationHistory: "not-a-governance-event-writer",
  createAdaptivePanelOverrideHistory: "not-a-governance-event-writer",
  createAdaptiveHumanReviewHistory: "not-a-governance-event-writer",
  createAdaptiveHumanReviewAssignmentHistory: "not-a-governance-event-writer",
  writeAdaptivePanelFinalizationAdminAuditEvent: "not-a-governance-event-writer",
  writeAdaptivePanelOverrideAdminAuditEvent: "not-a-governance-event-writer",
  writeAdaptiveAdminAuditEvent: "not-a-governance-event-writer",
});

/** Write methods that, on a Firestore reference, persist something. */
const FIRESTORE_WRITE_METHODS: readonly string[] = Object.freeze(["set", "create", "update", "delete", "add"]);

type ProductionWriteSurface = {
  persistenceImports: string[];
  transactionMethods: string[];
  directWriteCalls: string[];
  /** EVERY module the production file imports, with its bindings. R5 MAJOR: the guard previously
   *  walked only a two-module allow-list, so a persistence dependency imported from any third module
   *  contributed nothing and "unclassifiedPersistenceImports" could never flag it. */
  allImports: string[];
};

/** Derived from the production source, scoped to the four audited operations for call analysis. */
function deriveProductionWriteSurface(sourceText: string, targetFunctions: readonly string[]): ProductionWriteSurface {
  const sf = tsApi.createSourceFile("subject.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const persistenceImports: string[] = [];
  const transactionMethods = new Set<string>();
  const directWriteCalls: string[] = [];
  const allImports: string[] = [];

  tsApi.forEachChild(sf, (node) => {
    if (!tsApi.isImportDeclaration(node) || !tsApi.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    const names: string[] = [];
    if (clause?.name) names.push(`default:${clause.name.text}`);
    const bindings = clause?.namedBindings;
    if (bindings && tsApi.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.push(element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text);
    } else if (bindings && tsApi.isNamespaceImport(bindings)) {
      names.push(`* as ${bindings.name.text}`);
    }
    allImports.push(`${specifier} :: ${names.sort().join(", ")}`);
    if (PERSISTENCE_MODULES.includes(specifier)) {
      // the LOCAL name is what production calls, so an aliased import is classified under its alias
      for (const name of names) persistenceImports.push(name.includes(" as ") ? name.split(" as ")[1] : name);
    }
  });

  const analyseFunction = (fnNode: tsApi.Node) => {
    // the transaction callback's own parameter name, whatever it is called
    const txParamNames = new Set<string>();
    const findTxParam = (n: tsApi.Node) => {
      if (tsApi.isCallExpression(n) && n.expression.getText(sf).endsWith("runTransaction") && n.arguments[0]) {
        const cb = n.arguments[0];
        if ((tsApi.isArrowFunction(cb) || tsApi.isFunctionExpression(cb)) && cb.parameters[0] && tsApi.isIdentifier(cb.parameters[0].name)) {
          txParamNames.add(cb.parameters[0].name.text);
        }
      }
      tsApi.forEachChild(n, findTxParam);
    };
    findTxParam(fnNode);

    const visit = (n: tsApi.Node) => {
      if (tsApi.isCallExpression(n) && tsApi.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const receiver = n.expression.expression;
        if (tsApi.isIdentifier(receiver) && txParamNames.has(receiver.text)) transactionMethods.add(method);
        else if (FIRESTORE_WRITE_METHODS.includes(method) || method === "commit" || method === "batch") {
          // R5 MAJOR — STRUCTURAL, not a text match on `adminDb`. The previous check required the
          // receiver's source text to contain `adminDb`, so assigning the reference to a local first
          // (`const r = adminDb.collection(...); r.collection(...).add(...)`) defeated it entirely.
          // Every write-shaped call on ANY receiver inside the audited functions is now reported, and
          // the expected set is pinned empty — so a new direct write must be declared deliberately.
          directWriteCalls.push(`${receiver.getText(sf).replace(/\s+/g, " ").slice(0, 60)}.${method}`);
        }
      }
      tsApi.forEachChild(n, visit);
    };
    tsApi.forEachChild(fnNode, visit);
  };

  const walk = (node: tsApi.Node) => {
    if (tsApi.isFunctionDeclaration(node) && node.name && targetFunctions.includes(node.name.text)) analyseFunction(node);
    tsApi.forEachChild(node, walk);
  };
  tsApi.forEachChild(sf, walk);

  return { persistenceImports: [...new Set(persistenceImports)].sort(), transactionMethods: [...transactionMethods].sort(), directWriteCalls: directWriteCalls.sort(), allImports: allImports.sort() };
}

/**
 * ─── R8 §61 — THE DIFF ENGINE'S OWN SELF-TEST ─────────────────────────────────────────────────
 *
 * The oracle is now the store diff, so the diff itself needs a mechanism test. Every case below is
 * synthetic: it drives the fake directly and asserts the delta the engine reports, so a diff that
 * silently missed a deletion, a dotted-field modification, or a document in a collection that did
 * not exist at snapshot time would fail here rather than in a security assertion months later.
 */
describe("final-store diff engine — mechanism self-test (§61)", () => {
  const doc = (collection: string, id: string) => mockAdminDb.collection(collection).doc(id);

  it("detects an ADDED document", async () => {
    const before = snapshotStore();
    await doc("runs", "r-new").set({ a: 1 });
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe("added:[runs/r-new] modified:[] deleted:[]");
  });

  it("detects a MODIFIED document, and reports before/after", async () => {
    await doc("runs", "r-mod").set({ a: 1 });
    const before = snapshotStore();
    await doc("runs", "r-mod").set({ a: 2 });
    const delta = diffStore(before, snapshotStore());
    expect(describeDelta(delta)).toBe("added:[] modified:[runs/r-mod] deleted:[]");
    expect(`${delta.modified[0].before} -> ${delta.modified[0].after}`).toBe('{"a":1} -> {"a":2}');
  });

  it("detects a DELETED document", async () => {
    await doc("runs", "r-del").set({ a: 1 });
    const before = snapshotStore();
    await doc("runs", "r-del").delete();
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe("added:[] modified:[] deleted:[runs/r-del]");
  });

  it("detects a document in a collection that did NOT exist at snapshot time", async () => {
    const before = snapshotStore();
    expect(stores.brandNewCollection).toBeUndefined();
    await doc("brandNewCollection", "x").set({ a: 1 });
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe("added:[brandNewCollection/x] modified:[] deleted:[]");
  });

  it("detects a DOTTED-FIELD modification", async () => {
    await doc("runs", "r-dot").set({ outer: { keep: 1 } });
    const before = snapshotStore();
    await mockAdminDb.runTransaction(async (tx: any) => tx.update(doc("runs", "r-dot"), { "outer.injected": "forged" }));
    const delta = diffStore(before, snapshotStore());
    expect(describeDelta(delta)).toBe("added:[] modified:[runs/r-dot] deleted:[]");
    expect(delta.modified[0].after).toContain("forged");
  });

  it("ADD-then-DELETE leaves no final document, so an expected-addition contract FAILS", async () => {
    const before = snapshotStore();
    await mockAdminDb.runTransaction(async (tx: any) => {
      const ref = doc("runs", RUN_ID).collection("governanceEvents").doc("transient");
      tx.set(ref, { action: "adaptive_review_panel_cancelled" });
      tx.delete(ref);
    });
    // the store is unchanged …
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe("added:[] modified:[] deleted:[]");
    // … so a contract demanding one added event under the run's parent path cannot be satisfied
    expect(() => expectStoreDelta("addThenDelete", before, { oneAddedUnder: eventParentPath(RUN_ID) })).toThrow();
  });

  it("is INSENSITIVE to key order but SENSITIVE to value change — the serialisation is stable", async () => {
    await doc("runs", "r-ord").set({ a: 1, b: 2 });
    const before = snapshotStore();
    await doc("runs", "r-ord").set({ b: 2, a: 1 });
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe("added:[] modified:[] deleted:[]");
    await doc("runs", "r-ord").set({ b: 3, a: 1 });
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe("added:[] modified:[runs/r-ord] deleted:[]");
  });

  it("canonical paths reconstruct run sub-collections, so two runs' events never collide", () => {
    expect(canonicalPathOf("governanceEvents", "run-1::auto-7")).toBe("runs/run-1/governanceEvents/auto-7");
    expect(canonicalPathOf("governanceEvents", "run-2::auto-7")).toBe("runs/run-2/governanceEvents/auto-7");
    expect(canonicalPathOf("workspaces", "ws-1")).toBe("workspaces/ws-1");
  });

  /** §62 — the expected side must never be derived from the observed side. */
  it("§62 — a contract that simply accepts whatever happened is not expressible: extras always fail", async () => {
    const before = snapshotStore();
    await doc("runs", "r-a").set({ a: 1 });
    await doc("runs", "r-b").set({ b: 1 });
    expect(() => expectStoreDelta("extras", before, { added: ["runs/r-a"] })).toThrow();
  });
});

describe("whole-event-store oracle — channel inventory fails closed (§9)", () => {
  const surface = () => deriveProductionWriteSurface(PANEL_MUTATIONS_SOURCE, Object.keys(PANEL_OPERATION_FUNCTIONS));

  it("every persistence import the production module takes is classified", () => {
    const unclassified = surface().persistenceImports.filter((name) => !Object.prototype.hasOwnProperty.call(PERSISTENCE_IMPORT_CLASSIFICATION, name));
    expect(`unclassifiedPersistenceImports:${unclassified.join(",")}`).toBe("unclassifiedPersistenceImports:");
    // and the derivation is not vacuously empty
    expect(surface().persistenceImports.length).toBeGreaterThanOrEqual(7);
  });

  it("every persistence import classified as a governance-event writer has an instrumented channel", () => {
    const missing = surface().persistenceImports
      .map((name) => PERSISTENCE_IMPORT_CLASSIFICATION[name])
      .filter((c): c is GovernanceEventChannel => c !== "not-a-governance-event-writer" && c !== undefined)
      .filter((channel) => !INSTRUMENTED_EVENT_CHANNELS.includes(channel));
    expect(`governanceWritersWithoutAnObserver:${missing.join(",")}`).toBe("governanceWritersWithoutAnObserver:");
  });

  it("every transaction write method the audited operations invoke is observed", () => {
    const methods = surface().transactionMethods;
    expect(methods).toEqual(["get", "set"]);
    const writeMethods = methods.filter((m) => FIRESTORE_WRITE_METHODS.includes(m));
    const uninstrumented = writeMethods.filter((m) => !INSTRUMENTED_EVENT_CHANNELS.includes(`transaction.${m}` as GovernanceEventChannel));
    expect(`uninstrumentedTransactionWrites:${uninstrumented.join(",")}`).toBe("uninstrumentedTransactionWrites:");
  });

  it("the audited operations take no DIRECT (non-transactional) write path, on ANY receiver", () => {
    expect(`directWriteCalls:${surface().directWriteCalls.join(" | ")}`).toBe("directWriteCalls:");
  });

  /**
   * R6 — the guard is fail-closed against a persistence dependency from ANY module, not just the two
   * the previous version allow-listed. The production module's ENTIRE import list is pinned, so
   * adding an import of any shape — named, aliased, default or namespace, from any module — fails
   * here until it is reviewed and classified. That is the only version of this check that cannot be
   * side-stepped by choosing a different module to import the writer from.
   */
  it("the production module's COMPLETE import list is pinned — any new dependency fails until classified", () => {
    const imports = surface().allImports;
    expect(imports.length).toBe(24);
    expect(imports).toEqual([
      "./authorizeTeamWorkspaceMutationInTransaction :: TeamMutationAuthorizationDenialReason, authorizeTeamWorkspaceMutationInTransaction",
      "./capabilities :: roleHasCapability",
      "./membershipBinding :: validateMembershipBinding",
      "./membershipId :: computeMembershipId",
      "./resolveWorkspaceReviewTarget :: resolveWorkspaceReviewTarget",
      "./teamWorkspaceTargetAdmission :: resolveTeamWorkspaceTargetAdmission",
      "./workspaceReviewEligibility :: AssignmentTargetIneligibilityReason, WorkspaceReviewCandidate, isValidAssignmentTarget, violatesDecisionSelfReviewGuard",
      "@/lib/adaptiveSchema/decisionReceiptUsability :: isSubstantiveDecisionReceiptConclusion",
      "@/lib/adaptiveSchema/governanceRecord :: GovernanceRecordV1",
      "@/lib/adaptiveSchema/governanceRecordParser :: isHumanReviewStatusReviewable, parseGovernanceRecord",
      "@/lib/adaptiveSchema/persistedOutput :: PersistedAdaptiveSchemaId",
      "@/lib/env :: TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS, TEAM_WORKSPACES_ENABLED",
      "@/lib/firebase/admin :: adminDb",
      "@/lib/firestore/runs :: createAdaptiveHumanReviewHistory, createAdaptivePanelFinalizationHistory, createAdaptivePanelOverrideHistory, writeAdaptivePanelFinalizationGovernanceEvent, writeAdaptivePanelOverrideGovernanceEvent",
      "@/lib/governance/adaptiveHumanReviewHistory :: buildAdaptiveHumanReviewHistoryEntry, isAdaptiveReviewNonTerminalStatus",
      "@/lib/governance/adaptiveHumanReviewPanel :: AdaptiveHumanReviewPanelV1, AdaptiveReviewFinalStatus, MAX_ADAPTIVE_PANEL_REVIEWERS, MIN_ADAPTIVE_PANEL_REVIEWERS, buildCancelledAdaptiveHumanReviewPanel, buildFinalizedAdaptiveHumanReviewPanel, buildNextAdaptiveHumanReviewPanel, buildOwnerOverriddenAdaptiveHumanReviewPanel, normalizeAdaptivePanelReviewerUserIds, parseAdaptiveHumanReviewPanel",
      "@/lib/governance/adaptiveHumanReviewRequest :: AdaptiveReviewDecisionStatus",
      "@/lib/governance/adaptiveHumanReviewVote :: AdaptiveHumanReviewVoteV1, buildAdaptiveHumanReviewVote, buildAdaptiveHumanReviewVoteId, isSemanticallyEquivalentAdaptiveHumanReviewVote, parseAdaptiveHumanReviewVote",
      "@/lib/governance/adaptivePanelFinalization :: buildAdaptivePanelFinalizationHistoryEntry, buildFinalConditionsUnion, buildFinalizedMultiReviewerHumanReview, buildWorkspacePanelFinalDecisionId",
      "@/lib/governance/adaptivePanelOverride :: buildAdaptivePanelOverrideHistoryEntry, buildOverriddenMultiReviewerHumanReview, buildWorkspacePanelOverrideDecisionId, parseSubmitAdaptiveReviewOverrideRequest",
      "@/lib/governance/adaptiveReviewAggregation :: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION, aggregateAdaptiveReviewVotes",
      "@/lib/governance/auditLog :: writeAdaptivePanelFinalizationAdminAuditEvent, writeAdaptivePanelOverrideAdminAuditEvent",
      "@/lib/logger :: logger",
      "server-only :: ",
    ]);
  });
});

describe("whole-event-store oracle — every instrumented channel is LIVE (§10)", () => {
  const eventRef = (runId: string, id: string) => mockAdminDb.collection("runs").doc(runId).collection("governanceEvents").doc(id);
  const seen = (channel: GovernanceEventChannel) => governanceEventLog.filter((o) => o.channel === channel);

  it("transaction.set", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.set(eventRef(RUN_ID, "live-tx-set"), { action: "LIVENESS" }));
    expect(`observed:${seen("transaction.set").length} path:${seen("transaction.set")[0]?.path}`).toBe(`observed:1 path:runs/${RUN_ID}/governanceEvents/live-tx-set`);
  });

  it("transaction.update", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.update(eventRef(RUN_ID, "live-tx-update"), { action: "LIVENESS" }));
    expect(`observed:${seen("transaction.update").length}`).toBe("observed:1");
  });

  it("direct.set", async () => {
    await eventRef(RUN_ID, "live-direct-set").set({ action: "LIVENESS" });
    expect(`observed:${seen("direct.set").length}`).toBe("observed:1");
  });

  it("direct.create", async () => {
    await eventRef(RUN_ID, "live-direct-create").create({ action: "LIVENESS" });
    expect(`observed:${seen("direct.create").length}`).toBe("observed:1");
  });

  it("direct.update", async () => {
    await eventRef(RUN_ID, "live-direct-update").update({ action: "LIVENESS" });
    expect(`observed:${seen("direct.update").length}`).toBe("observed:1");
  });

  it("writer.panelFinalizationGovernanceEvent", async () => {
    await writeAdaptivePanelFinalizationGovernanceEvent({ runId: RUN_ID, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view", finalStatus: "approved", finalDecisionId: "live-1", aggregationPolicyVersion: 1, supportingReviewerCount: 2, actorUserId: OWNER_UID, finalizedAt: MUTATE_NOW });
    expect(`observed:${seen("writer.panelFinalizationGovernanceEvent").length} path:${seen("writer.panelFinalizationGovernanceEvent")[0]?.path}`).toBe(`observed:1 path:runs/${RUN_ID}/governanceEvents/panel-finalized:live-1`);
  });

  it("writer.panelOverrideGovernanceEvent", async () => {
    await writeAdaptivePanelOverrideGovernanceEvent({ runId: RUN_ID, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view", finalStatus: "approved", finalDecisionId: "live-2", overrideByUserId: OWNER_UID, finalizedAt: MUTATE_NOW });
    expect(`observed:${seen("writer.panelOverrideGovernanceEvent").length}`).toBe("observed:1");
  });

  it("writer.adaptiveHumanReviewEvent", async () => {
    await writeAdaptiveHumanReviewEvent({ runId: RUN_ID, teamId: null, actorUserId: OWNER_UID, at: MUTATE_NOW } as never);
    expect(`observed:${seen("writer.adaptiveHumanReviewEvent").length}`).toBe("observed:1");
  });

  /**
   * §8 — PATH coverage, distinct from CHANNEL coverage. R4 showed two escapes that used the ordinary
   * transactional channel but a path the old helper's `${RUN_ID}::` key filter could not see.
   */
  it("a TOP-LEVEL governanceEvents collection write is observed, with its path preserved", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.set(mockAdminDb.collection("governanceEvents").doc("live-top"), { action: "LIVENESS" }));
    expect(governanceEventLog.map((o) => o.path)).toEqual(["governanceEvents/live-top"]);
    expect(`attempted:${attemptedGovernanceEventCount()}`).toBe("attempted:1");
  });

  it("a SHADOW run document's governanceEvents write is observed, and is not confused with the real run", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.set(eventRef(`${RUN_ID}-shadow`, "live-shadow"), { action: "LIVENESS" }));
    expect(governanceEventLog.map((o) => o.path)).toEqual([`runs/${RUN_ID}-shadow/governanceEvents/live-shadow`]);
    expect(`attempted:${attemptedGovernanceEventCount()}`).toBe("attempted:1");
  });

  it("bulkwriter.set is observed AND lands in the store — R7 proved its absence made a whole surface silent", async () => {
    const w = mockAdminDb.bulkWriter();
    await w.set(eventRef(RUN_ID, "bulk-1"), { action: "LIVENESS" });
    await w.close();
    expect(`observed:${seen("bulkwriter.set").length} stored:${stores.governanceEvents.has(`${RUN_ID}::bulk-1`)}`).toBe("observed:1 stored:true");
  });

  it("transaction.create", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.create(eventRef(RUN_ID, "live-tx-create"), { action: "LIVENESS" }));
    expect(`observed:${seen("transaction.create").length} committed:${committedGovernanceEvents().length}`).toBe("observed:1 committed:1");
  });

  it("batch.set", async () => {
    const b = mockAdminDb.batch();
    b.set(eventRef(RUN_ID, "live-batch-set"), { action: "LIVENESS" });
    await b.commit();
    expect(`observed:${seen("batch.set").length} committed:${committedGovernanceEvents().length}`).toBe("observed:1 committed:1");
  });

  it("batch.update", async () => {
    const b = mockAdminDb.batch();
    b.update(eventRef(RUN_ID, "live-batch-update"), { action: "LIVENESS" });
    await b.commit();
    expect(`observed:${seen("batch.update").length}`).toBe("observed:1");
  });

  it("a CollectionReference.add() write is observed — the idiom the other governance-event writers use", async () => {
    await mockAdminDb.collection("runs").doc(RUN_ID).collection("governanceEvents").add({ action: "LIVENESS" });
    expect(`observed:${seen("direct.set").length} committed:${committedGovernanceEvents().length}`).toBe("observed:1 committed:1");
  });

  /**
   * ─── R6 — EACH OBSERVER SHIPS WITH ITS OWN FALSIFIER ─────────────────────────────────────────
   *
   * R5 MINOR: `disabledEventObservers` existed, carried the comment "the oracle's own falsifier …
   * which is what proves each observer is load-bearing", and was never written by any test. The
   * mechanism was dead weight holding a proof claim. Each channel is now disabled in turn, a write
   * performed on it, and the absence of the observation asserted — so the observer is proved to be
   * the thing that records that channel, and a hook wired to the wrong channel fails here.
   */
  let exerciseSeq = 0;
  const nextId = () => `x-${++exerciseSeq}`;
  const exerciseChannel: Readonly<Record<GovernanceEventChannel, () => Promise<void>>> = {
    "transaction.set": async () => { await mockAdminDb.runTransaction(async (tx: any) => tx.set(eventRef(RUN_ID, nextId()), { action: "X" })); },
    "transaction.update": async () => { await mockAdminDb.runTransaction(async (tx: any) => tx.update(eventRef(RUN_ID, nextId()), { action: "X" })); },
    "transaction.create": async () => { await mockAdminDb.runTransaction(async (tx: any) => tx.create(eventRef(RUN_ID, nextId()), { action: "X" })); },
    "direct.set": async () => { await eventRef(RUN_ID, nextId()).set({ action: "X" }); },
    "direct.create": async () => { await eventRef(RUN_ID, nextId()).create({ action: "X" }); },
    "direct.update": async () => { await eventRef(RUN_ID, nextId()).update({ action: "X" }); },
    "batch.set": async () => { const b = mockAdminDb.batch(); b.set(eventRef(RUN_ID, nextId()), { action: "X" }); await b.commit(); },
    "batch.update": async () => { const b = mockAdminDb.batch(); b.update(eventRef(RUN_ID, nextId()), { action: "X" }); await b.commit(); },
    "bulkwriter.set": async () => { const w = mockAdminDb.bulkWriter(); await w.set(eventRef(RUN_ID, nextId()), { action: "X" }); await w.close(); },
    "bulkwriter.create": async () => { const w = mockAdminDb.bulkWriter(); await w.create(eventRef(RUN_ID, nextId()), { action: "X" }); await w.close(); },
    "bulkwriter.update": async () => { const w = mockAdminDb.bulkWriter(); await w.update(eventRef(RUN_ID, nextId()), { action: "X" }); await w.close(); },
    "writer.panelFinalizationGovernanceEvent": async () => { await writeAdaptivePanelFinalizationGovernanceEvent({ runId: RUN_ID, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view", finalStatus: "approved", finalDecisionId: "x", aggregationPolicyVersion: 1, supportingReviewerCount: 1, actorUserId: OWNER_UID, finalizedAt: MUTATE_NOW }); },
    "writer.panelOverrideGovernanceEvent": async () => { await writeAdaptivePanelOverrideGovernanceEvent({ runId: RUN_ID, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view", finalStatus: "approved", finalDecisionId: "x", overrideByUserId: OWNER_UID, finalizedAt: MUTATE_NOW }); },
    "writer.adaptiveHumanReviewEvent": async () => { await writeAdaptiveHumanReviewEvent({ runId: RUN_ID, teamId: null, actorUserId: OWNER_UID, at: MUTATE_NOW } as never); },
  };

  it.each(INSTRUMENTED_EVENT_CHANNELS.map((c) => [c] as const))("%s — the observer is load-bearing: disabling it hides exactly that channel", async (channel) => {
    await exerciseChannel[channel]();
    const recorded = governanceEventLog.filter((o) => o.channel === channel).length;
    expect(`${channel}:recordedWhenEnabled:${recorded}`).toBe(`${channel}:recordedWhenEnabled:1`);
    governanceEventLog.length = 0;
    disabledEventObservers.add(channel);
    await exerciseChannel[channel]();
    expect(`${channel}:recordedWhenDisabled:${governanceEventLog.filter((o) => o.channel === channel).length}`).toBe(`${channel}:recordedWhenDisabled:0`);
  });

  it("every instrumented channel has an exerciser — the list cannot grow without one", () => {
    const missing = INSTRUMENTED_EVENT_CHANNELS.filter((c) => typeof exerciseChannel[c] !== "function");
    expect(`channelsWithoutAnExerciser:${missing.join(",")}`).toBe("channelsWithoutAnExerciser:");
    const extra = Object.keys(exerciseChannel).filter((c) => !INSTRUMENTED_EVENT_CHANNELS.includes(c as GovernanceEventChannel));
    expect(`exercisersWithoutAChannel:${extra.join(",")}`).toBe("exercisersWithoutAChannel:");
    expect(INSTRUMENTED_EVENT_CHANNELS.length).toBe(14);
  });

  /**
   * R6 — the PRECONDITION for classifying by payload shape, pinned rather than assumed. Audit-shape
   * detection keys on a string `action`, which is only safe because no canonical write in the
   * audited module carries one. This drives all four operations and asserts that every non-event
   * write observed by the fake is free of that field.
   */
  it("no CANONICAL write in the audited module is audit-shaped, so payload-shape classification has no false positives", async () => {
    const shapes: string[] = [];
    // one valid sequence covering all four audited operations: create -> reconfigure -> vote -> cancel
    expect((await putCall()).ok).toBe(true);
    expect((await putCall({ expectedRevision: 1 })).ok).toBe(true);
    expect((await voteCall({ panelRevision: 2 })).ok).toBe(true);
    expect((await deleteCall({ expectedRevision: 2 })).ok).toBe(true);
    for (const [collection, store] of Object.entries(stores)) {
      if (collection === GOVERNANCE_EVENT_COLLECTION) continue;
      for (const [key, doc] of store.entries()) {
        if (isAuditShapedPayload(doc)) shapes.push(`${collection}/${key}`);
      }
    }
    expect(`canonicalDocumentsCarryingAnActionField:${shapes.join(",")}`).toBe("canonicalDocumentsCarryingAnActionField:");
  });

  it("a payload mutated AFTER the write does not change what was observed — the fake snapshots, like the real SDK", async () => {
    const payload: Record<string, unknown> = { action: "adaptive_review_panel_created", byUid: "attacker-uid" };
    await mockAdminDb.runTransaction(async (tx: any) => tx.set(eventRef(RUN_ID, "snap"), payload));
    payload.byUid = OWNER_UID;
    expect(`observedActor:${committedGovernanceEvents()[0]?.actor} storedActor:${(stores.governanceEvents.get(`${RUN_ID}::snap`) as { byUid?: string })?.byUid}`).toBe("observedActor:attacker-uid storedActor:attacker-uid");
  });

  it("a transaction.update write into governanceEvents IS classified COMMITTED — the identity test could never see it", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.update(eventRef(RUN_ID, "upd"), { action: "adaptive_review_panel_cancelled", byUid: OWNER_UID }));
    expect(`attempted:${attemptedGovernanceEventCount()} committed:${committedGovernanceEvents().length}`).toBe("attempted:1 committed:1");
  });

  it("a write to ANY registered collection with an audit-shaped payload is observed — no collection is a silent sink", async () => {
    const sinks = ["humanReviewAssignment", "humanReviewPanel", "humanReviewVotes", "runs", "workspaces", "workspaceMemberships"];
    for (const sink of sinks) {
      governanceEventLog.length = 0;
      await mockAdminDb.runTransaction(async (tx: any) => tx.set(mockAdminDb.collection(sink).doc("ghost-audit"), { action: "adaptive_review_panel_vote_cast", byUid: OWNER_UID, at: MUTATE_NOW }));
      expect(`${sink}:observed:${governanceEventLog.length} classifiedBy:${governanceEventLog[0]?.classifiedBy}`).toBe(`${sink}:observed:1 classifiedBy:audit-shaped-payload`);
    }
  });

  it("no fake store key can be ambiguous: a sub-document id containing the composite separator is rejected", () => {
    expect(() => makeSubDocRef("governanceEvents", "runs", RUN_ID, "a::b")).toThrow(/composite key separator/);
  });
});

describe("panel mutation audit coverage — successful mutations", () => {
  it("panel CREATE makes exactly its allowed durable delta, and the stored event has its COMPLETE shape", async () => {
    const before = snapshotStore();
    expect((await putCall()).ok).toBe(true);
    // R8 §7 — the verdict is the FINAL STORE DELTA: the canonical panel added, exactly one event
    // added under the run's governanceEvents, and nothing else added, modified or deleted anywhere.
    const delta = expectStoreDelta("CREATE", before, {
      oneAddedUnder: eventParentPath(RUN_ID),
      added: [`runs/${RUN_ID}/humanReviewPanel/current`],
    });
    expectNoForeignPersistenceWriters();
    expect(soleStoredPanelEvent(delta, eventParentPath(RUN_ID)).payload).toEqual({
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
    const before = snapshotStore();
    expect((await putCall({ expectedRevision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID, REVIEWER_UID] })).ok).toBe(true);
    const delta = expectStoreDelta("RECONFIGURE", before, {
      oneAddedUnder: eventParentPath(RUN_ID),
      modified: [`runs/${RUN_ID}/humanReviewPanel/current`],
    });
    expectNoForeignPersistenceWriters();
    expect(soleStoredPanelEvent(delta, eventParentPath(RUN_ID)).payload).toEqual({
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
    const before = snapshotStore();
    expect((await deleteCall()).ok).toBe(true);
    const delta = expectStoreDelta("CANCEL", before, {
      oneAddedUnder: eventParentPath(RUN_ID),
      modified: [`runs/${RUN_ID}/humanReviewPanel/current`],
    });
    expectNoForeignPersistenceWriters();
    expect(soleStoredPanelEvent(delta, eventParentPath(RUN_ID)).payload).toEqual({
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
    const before = snapshotStore();
    expect((await voteCall({ status: "changes_requested", comment: "needs work", conditions: ["c1", "c2"] })).ok).toBe(true);
    const delta = expectStoreDelta("VOTE", before, {
      oneAddedUnder: eventParentPath(RUN_ID),
      added: [`runs/${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`],
    });
    expectNoForeignPersistenceWriters();
    expect(soleStoredPanelEvent(delta, eventParentPath(RUN_ID)).payload).toEqual({
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

  it("an IDEMPOTENT vote replay attempts NO second event on ANY channel — one vote, one record", async () => {
    seedPanel({ revision: 1 });
    expect((await voteCall()).ok).toBe(true);
    expect(panelEvents()).toHaveLength(1);
    // R8 §9 — the replay's DURABLE delta must be empty. The previous version counted attempted log
    // entries, which a write-then-delete or an unmodelled surface could sidestep entirely.
    const before = snapshotStore();
    expect(await voteCall()).toMatchObject({ ok: true, submissionStatus: "already_submitted" });
    expectNoDurableChange("VOTE-replay", before);
    expectNoForeignPersistenceWriters();
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
 * MUTATION DISCIPLINE. Every claim in this file was made to fail before it was believed. Batteries
 * run from an immutable committed SHA in a private sandbox; every patch is verified present on disk
 * before scoring and the file verified byte-identical to the commit afterwards; verdicts are read
 * from the process EXIT CODE, never from the printed `Tests:` tally (a failing `afterAll` gives
 * exit 1 while every individual test prints as passed — and this file now has exactly such an
 * `afterAll`). The R5 battery results are recorded in the PR description rather than duplicated
 * here, so they cannot drift out of step with it.
 *
 * THREE EARLIER BATTERIES WERE DISCARDED, and all three lessons are worth keeping:
 *   · Three reviewers were once given ONE shared worktree, so each could revert another's in-flight
 *     patch mid-run and observe a third party's mutation as its own. Every result from that round was
 *     invalid until each reviewer rebuilt a private sandbox and re-ran it. A reviewer's starting
 *     commit and file hashes are now recorded and re-verified at exit.
 *   · The first ghost-event sweep inserted its write before the `return` of a brace-less
 *     `if (c) return x;`, which makes the return UNCONDITIONAL and breaks success paths instead of
 *     testing a ghost write on the rejection path. Every site "died" and none of it was evidence.
 *     A valid sweep wraps the then-branch in a block so control flow is unchanged.
 *   · R4's sweep then concluded from three survivors that "nothing reaches them". That inference
 *     was false for one of the three: an existing test in this file DOES execute
 *     `create#reject-04` through the synthetic capability split, and the ghost survived only
 *     because that test never counted events. Survival proves a mutation was not caught; it does
 *     not prove the branch was not executed. Reachability needs its own probe — an
 *     AST-shape-preserving one, since deleting the return changes the inventory and fails the
 *     suite for an unrelated reason.
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

  // ── §19/§20 — the census fails CLOSED on every shape the classifier does not support ──
  it("a DUPLICATE `ok` key is UNSUPPORTED — the classifier must not silently pick one of two", () => {
    const source = `export async function synthOp(a: number) { if (a < 0) return { ok: true, ok: false, reason: "sneaky" }; return { ok: true }; }`;
    expect(censusReturnStatements(source, SYNTH_MAP).map((r) => r.classification)).toEqual(["unsupported", "success"]);
  });

  it("§19 — an alias-based `ok` is COUNTED as a return and classified UNSUPPORTED, not ignored", () => {
    const source = `export async function synthOp(a: number) { const f = false as const; if (a < 0) return { ok: f, reason: "sneaky" }; return { ok: true }; }`;
    expect(discoverRejectionSites(source, SYNTH_MAP)).toEqual([]); // the narrow discoverer still cannot see it …
    const census = censusReturnStatements(source, SYNTH_MAP);
    // … but the census does, and refuses to classify it as anything safe
    expect(census.map((r) => r.classification)).toEqual(["unsupported", "success"]);
  });

  it("§20D — a function with no rejection still has EVERY return classified", () => {
    const census = censusReturnStatements(SYNTHETIC.noRejection, SYNTH_MAP);
    expect(census.map((r) => r.classification)).toEqual(["success"]);
    expect(discoverRejectionSites(SYNTHETIC.noRejection, SYNTH_MAP)).toEqual([]);
  });

  it("§20F — a relay return is classified explicitly and marked rejection-capable", () => {
    const source = `export async function synthOp() { const r = await go(); if (!r.ok) return r; return { ok: true }; }`;
    const census = censusReturnStatements(source, SYNTH_MAP);
    expect(census.map((r) => `${r.classification}/${r.propagates}`)).toEqual(["relay/rejection-capable", "success/n/a"]);
  });

  it("a spread, a shorthand `ok`, and a bare return are each UNSUPPORTED rather than silently dropped", () => {
    const spread = `export async function synthOp(a: number) { if (a < 0) return { ...DENY, reason: "x" }; return { ok: true }; }`;
    const shorthand = `export async function synthOp(a: number) { const ok = false; if (a < 0) return { ok, reason: "x" }; return { ok: true }; }`;
    const bare = `export async function synthOp(a: number) { if (a < 0) return; return { ok: true }; }`;
    expect(censusReturnStatements(spread, SYNTH_MAP).map((r) => r.classification)).toEqual(["unsupported", "success"]);
    expect(censusReturnStatements(shorthand, SYNTH_MAP).map((r) => r.classification)).toEqual(["unsupported", "success"]);
    expect(censusReturnStatements(bare, SYNTH_MAP).map((r) => r.classification)).toEqual(["unsupported", "success"]);
  });
});

/**
 * ─── R5 §18/§21 — THE PRODUCTION CENSUS, AND THE FAIL-CLOSED META-TEST ────────────────────────
 */
// Lazy + memoized: this block sits above `PANEL_MUTATIONS_SOURCE`'s declaration in source order, and
// the tests below only need the census at run time.
let returnCensusCache: readonly CensusedReturn[] | null = null;
const RETURN_CENSUS = (): readonly CensusedReturn[] => (returnCensusCache ??= Object.freeze(censusReturnStatements(PANEL_MUTATIONS_SOURCE, PANEL_OPERATION_FUNCTIONS).map((r) => Object.freeze(r))));

describe("production ReturnStatement census — fails closed on unrecognised shapes (§18–§21)", () => {
  it("EVERY return in the audited functions is classified — an unsupported shape fails here", () => {
    const unsupported = RETURN_CENSUS().filter((r) => r.classification === "unsupported").map((r) => `${r.operation}#return-${r.ordinal}: ${r.expr}`);
    expect(`unsupportedReturnShapes:${unsupported.join(" | ")}`).toBe("unsupportedReturnShapes:");
    expect(RETURN_CENSUS().length).toBeGreaterThan(DISCOVERED_REJECTION_SITES.length);
  });

  it("§28–§31 — every assignment to a relayed result is classified, and none is a rejection today", () => {
    const byClass = (c: ResultAssignment["classification"]) => RESULT_ASSIGNMENTS.filter((a) => a.classification === c);
    expect(RESULT_ASSIGNMENTS.map((a) => `${a.operation}:${a.target}:${a.classification}`)).toEqual([
      "create:transactionResult:transaction-result",
      "cancel:transactionResult:transaction-result",
      "vote:transactionResult:transaction-result",
    ]);
    expect(`unsupportedResultAssignments:${byClass("unsupported").map((a) => `${a.operation}#assign-${a.ordinal}: ${a.expr}`).join(" | ")}`).toBe("unsupportedResultAssignments:");
    expect(`rejectionAssignmentsPromotedToSites:${ASSIGNMENT_DECISION_SITES.length}`).toBe("rejectionAssignmentsPromotedToSites:0");
    // and the detector is not vacuously blind
    const synthetic = `export async function synthOp(a: number) { let r: Res; r = await db.runTransaction(async () => ({ ok: true })); if (a < 0) { r = { ok: false, reason: "assigned_rejection" }; } return r; }`;
    expect(censusResultAssignments(synthetic, SYNTH_MAP).map((x) => `${x.classification}/${x.reasonLiteral}`)).toEqual(["transaction-result/null", "rejection/assigned_rejection"]);
  });

  it("the audited functions contain NO `throw` — a rejection routed through one would be outside the model", () => {
    const throws = censusThrowStatements(PANEL_MUTATIONS_SOURCE, PANEL_OPERATION_FUNCTIONS);
    expect(`throwStatementsInAuditedFunctions:${throws.map((x) => `${x.operation}: ${x.expr}`).join(" | ")}`).toBe("throwStatementsInAuditedFunctions:");
    // and the detector is not vacuously blind
    expect(censusThrowStatements(`export async function synthOp() { throw new Error("x"); }`, SYNTH_MAP).length).toBe(1);
  });

  it("the census reconciles with the rejection inventory: rejections + successes + relays = every return", () => {
    const byClass = (c: ReturnClassification) => RETURN_CENSUS().filter((r) => r.classification === c).length;
    expect(`total:${RETURN_CENSUS().length} rejection:${byClass("rejection")} success:${byClass("success")} relay:${byClass("relay")} unsupported:${byClass("unsupported")}`).toBe("total:53 rejection:44 success:6 relay:3 unsupported:0");
    // the rejection class IS the discoverer's inventory, counted independently
    expect(byClass("rejection")).toBe(DISCOVERED_REJECTION_SITES.length);
  });

  /**
   * §21 — the three relay returns propagate a rejection onward, so their relationship to the
   * obligation model must be explicit rather than an unexplained omission. Each sits AFTER its
   * function's `runTransaction` call has settled: the decision it relays was already counted at the
   * site that constructed it, and no Firestore write is reachable between the relay and the
   * function's exit. They are therefore not independent decision points, and carry no obligation of
   * their own — stated here rather than left to the reader.
   */
  it("every relay return is rejection-capable, sits after the transaction, and relays an already-counted decision", () => {
    const relays = RETURN_CENSUS().filter((r) => r.classification === "relay");
    expect(relays.map((r) => `${r.operation}:${r.propagates}`)).toEqual(["create:rejection-capable", "cancel:rejection-capable", "vote:rejection-capable"]);
    for (const relay of relays) {
      expect(`${relay.operation}:relayIsAfterTransaction:${relay.start > relay.transactionEnd}`).toBe(`${relay.operation}:relayIsAfterTransaction:true`);
    }
    expect(relays.map((r) => r.expr)).toEqual(["return transactionResult;", "return transactionResult;", "return transactionResult;"]);
  });
});

/**
 * ─── R5 §18–§21 — EVERY ReturnStatement IS CENSUSED AND CLASSIFIED ────────────────────────────
 *
 * R4 MAJOR: `discoverRejectionSites` recognises exactly one syntactic shape — a returned object
 * literal whose `ok` property is the literal `false`. A new production rejection written any other
 * way was INVISIBLE, and R4 demonstrated it: adding
 *
 *     const mjFalse = false as const;
 *     return { ok: mjFalse, reason: "vote_malformed" as const };
 *
 * together with a forged `vote_cast` write left the suite green at an unchanged 44/41/59/56. The
 * discoverer failed OPEN.
 *
 * The fix is not a general-purpose static analyser. It is a total census: every `ReturnStatement`
 * in the audited functions is classified, and anything the classifier does not explicitly support
 * is `unsupported`, which FAILS the suite until support is added deliberately. The discoverer may
 * still only understand one rejection shape — it simply may no longer ignore the shapes it cannot.
 */
type ReturnClassification = "rejection" | "success" | "relay" | "unsupported";

type CensusedThrow = { operation: "create" | "cancel" | "vote"; expr: string };

type CensusedReturn = {
  operation: "create" | "cancel" | "vote";
  ordinal: number;
  classification: ReturnClassification;
  expr: string;
  /** For a relay: whether it can propagate a rejection result onward. */
  propagates: "rejection-capable" | "success-only" | "n/a";
  start: number;
  /** End offset of the enclosing function's `runTransaction` call, for the §21 ordering check. */
  transactionEnd: number;
};

/**
 * R5 MINOR — the census covered only `ReturnStatement`, so a rejection expressed as a `throw` was
 * outside the decision-site model entirely: it would surface to the caller as `write_failed`, and no
 * `write_failed` site carries a zero-event obligation, so no throw-reachable branch would be swept.
 * There are none today, and this is what keeps it that way.
 */
function censusThrowStatements(sourceText: string, functionToOperation: Readonly<Record<string, "create" | "cancel" | "vote">>): CensusedThrow[] {
  const sf = tsApi.createSourceFile("subject.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const out: CensusedThrow[] = [];
  const collect = (fnNode: tsApi.Node, operation: "create" | "cancel" | "vote") => {
    const visit = (n: tsApi.Node) => {
      if (n !== fnNode && (tsApi.isFunctionDeclaration(n) || tsApi.isMethodDeclaration(n))) return;
      if (tsApi.isThrowStatement(n)) out.push({ operation, expr: n.getText(sf).replace(/\s+/g, " ").slice(0, 120) });
      tsApi.forEachChild(n, visit);
    };
    tsApi.forEachChild(fnNode, visit);
  };
  const walk = (node: tsApi.Node) => {
    if (tsApi.isFunctionDeclaration(node) && node.name && Object.prototype.hasOwnProperty.call(functionToOperation, node.name.text)) {
      collect(node, functionToOperation[node.name.text]);
    }
    tsApi.forEachChild(node, walk);
  };
  tsApi.forEachChild(sf, walk);
  return out;
}

function censusReturnStatements(sourceText: string, functionToOperation: Readonly<Record<string, "create" | "cancel" | "vote">>): CensusedReturn[] {
  const sf = tsApi.createSourceFile("subject.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const out: CensusedReturn[] = [];
  const textOf = (n: tsApi.Node) => n.getText(sf).replace(/\s+/g, " ").trim();
  const unwrap = (node: tsApi.Expression): tsApi.Expression => {
    let current: tsApi.Expression = node;
    for (;;) {
      if (tsApi.isAsExpression(current) || tsApi.isSatisfiesExpression(current) || tsApi.isParenthesizedExpression(current)) { current = current.expression; continue; }
      return current;
    }
  };

  const collect = (fnNode: tsApi.Node, operation: "create" | "cancel" | "vote") => {
    let ordinal = 0;
    let transactionEnd = -1;
    const findTx = (n: tsApi.Node) => {
      if (tsApi.isCallExpression(n) && n.expression.getText(sf).endsWith("runTransaction")) transactionEnd = Math.max(transactionEnd, n.getEnd());
      tsApi.forEachChild(n, findTx);
    };
    findTx(fnNode);

    const visit = (n: tsApi.Node) => {
      if (n !== fnNode && (tsApi.isFunctionDeclaration(n) || tsApi.isMethodDeclaration(n))) return;
      if (tsApi.isReturnStatement(n)) {
        ordinal += 1;
        let classification: ReturnClassification = "unsupported";
        let propagates: CensusedReturn["propagates"] = "n/a";
        const expression = n.expression ? unwrap(n.expression) : undefined;
        if (!expression) {
          classification = "unsupported"; // a bare `return;` in a result-returning function
        } else if (tsApi.isObjectLiteralExpression(expression)) {
          const hasSpread = expression.properties.some((p) => tsApi.isSpreadAssignment(p));
          const okProps = expression.properties.filter((p) => p.name?.getText(sf) === "ok");
          const okProp = okProps[0];
          // R5 MINOR — the classifier resolved `ok` by FIRST occurrence while JavaScript takes the
          // LAST, so `{ ok: true, ok: false, … }` was classified `success` and a count-preserving
          // substitution of a success return for a rejection was invisible to the census. More than
          // one `ok` is now unsupported outright rather than resolved by either rule.
          if (okProps.length > 1) classification = "unsupported";
          else if (hasSpread || !okProp) classification = "unsupported";
          else if (!tsApi.isPropertyAssignment(okProp)) classification = "unsupported"; // shorthand `{ ok }`
          else {
            const okValue = unwrap(okProp.initializer);
            if (okValue.kind === tsApi.SyntaxKind.FalseKeyword) classification = "rejection";
            else if (okValue.kind === tsApi.SyntaxKind.TrueKeyword) classification = "success";
            else classification = "unsupported"; // e.g. `ok: someIdentifier`
          }
        } else if (tsApi.isIdentifier(expression)) {
          classification = "relay";
          propagates = "rejection-capable";
        }
        out.push({ operation, ordinal, classification, expr: textOf(n).slice(0, 160), propagates, start: n.getStart(sf), transactionEnd });
      }
      tsApi.forEachChild(n, visit);
    };
    tsApi.forEachChild(fnNode, visit);
  };

  const walk = (node: tsApi.Node) => {
    if (tsApi.isFunctionDeclaration(node) && node.name && Object.prototype.hasOwnProperty.call(functionToOperation, node.name.text)) {
      collect(node, functionToOperation[node.name.text]);
    }
    tsApi.forEachChild(node, walk);
  };
  tsApi.forEachChild(sf, walk);
  return out;
}

/**
 * ─── R8 §28–§31 — THE CENSUS UNIT IS THE DECISION, NOT THE ReturnStatement ─────────────────────
 *
 * R7 MAJOR: a rejection can be introduced with no `ReturnStatement` at all, by assigning to the
 * variable a relay later returns:
 *
 *     transactionResult = { ok: false, reason: "panel_unreadable" };
 *
 * That added a production decision point with zero census entries, zero obligations, no required
 * case, and every committed number unmoved. The census counted the wrong unit.
 *
 * DELIBERATELY NOT a general dataflow engine (§29). For each audited function this identifies the
 * identifiers its relay returns hand back, finds every assignment to them, and classifies each. The
 * only classification treated as safe is "the awaited transaction result"; a rejection assignment
 * becomes a decision site requiring its own executable obligation, and anything the classifier does
 * not understand is UNSUPPORTED and fails the suite.
 */
type ResultAssignment = {
  operation: "create" | "cancel" | "vote";
  ordinal: number;
  target: string;
  classification: "transaction-result" | "rejection" | "success" | "unsupported";
  reasonLiteral: string | null;
  expr: string;
};

function censusResultAssignments(sourceText: string, functionToOperation: Readonly<Record<string, "create" | "cancel" | "vote">>): ResultAssignment[] {
  const sf = tsApi.createSourceFile("subject.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const out: ResultAssignment[] = [];
  const textOf = (n: tsApi.Node) => n.getText(sf).replace(/\s+/g, " ").trim();
  const unwrap = (node: tsApi.Expression): tsApi.Expression => {
    let c: tsApi.Expression = node;
    for (;;) {
      if (tsApi.isAsExpression(c) || tsApi.isSatisfiesExpression(c) || tsApi.isParenthesizedExpression(c)) { c = c.expression; continue; }
      return c;
    }
  };

  const collect = (fnNode: tsApi.Node, operation: "create" | "cancel" | "vote") => {
    // 1. which identifiers do this function's relay returns hand back?
    const relayed = new Set<string>();
    const findRelays = (n: tsApi.Node) => {
      if (n !== fnNode && (tsApi.isFunctionDeclaration(n) || tsApi.isMethodDeclaration(n))) return;
      if (tsApi.isReturnStatement(n) && n.expression) {
        const e = unwrap(n.expression);
        if (tsApi.isIdentifier(e)) relayed.add(e.text);
      }
      tsApi.forEachChild(n, findRelays);
    };
    tsApi.forEachChild(fnNode, findRelays);

    // 2. every assignment to one of them, classified
    let ordinal = 0;
    const visit = (n: tsApi.Node) => {
      if (n !== fnNode && (tsApi.isFunctionDeclaration(n) || tsApi.isMethodDeclaration(n))) return;
      const record = (target: string, rhs: tsApi.Expression | undefined, node: tsApi.Node) => {
        ordinal += 1;
        let classification: ResultAssignment["classification"] = "unsupported";
        let reasonLiteral: string | null = null;
        if (rhs) {
          const value = unwrap(rhs);
          if (tsApi.isAwaitExpression(value) && /runTransaction/.test(textOf(value))) classification = "transaction-result";
          else if (tsApi.isObjectLiteralExpression(value)) {
            const okProps = value.properties.filter((p) => p.name?.getText(sf) === "ok");
            const ok = okProps.length === 1 && tsApi.isPropertyAssignment(okProps[0]) ? unwrap((okProps[0] as tsApi.PropertyAssignment).initializer) : undefined;
            if (ok && ok.kind === tsApi.SyntaxKind.FalseKeyword) {
              classification = "rejection";
              const reason = value.properties.find((p): p is tsApi.PropertyAssignment => tsApi.isPropertyAssignment(p) && p.name.getText(sf) === "reason");
              const rv = reason ? unwrap(reason.initializer) : undefined;
              reasonLiteral = rv && tsApi.isStringLiteralLike(rv) ? rv.text : null;
            } else if (ok && ok.kind === tsApi.SyntaxKind.TrueKeyword) classification = "success";
          }
        }
        out.push({ operation, ordinal, target, classification, reasonLiteral, expr: textOf(node).slice(0, 140) });
      };
      if (tsApi.isBinaryExpression(n) && n.operatorToken.kind === tsApi.SyntaxKind.EqualsToken && tsApi.isIdentifier(n.left) && relayed.has(n.left.text)) {
        record(n.left.text, n.right, n);
      }
      if (tsApi.isVariableDeclaration(n) && tsApi.isIdentifier(n.name) && relayed.has(n.name.text) && n.initializer) {
        record(n.name.text, n.initializer, n);
      }
      tsApi.forEachChild(n, visit);
    };
    tsApi.forEachChild(fnNode, visit);
  };

  const walk = (node: tsApi.Node) => {
    if (tsApi.isFunctionDeclaration(node) && node.name && Object.prototype.hasOwnProperty.call(functionToOperation, node.name.text)) {
      collect(node, functionToOperation[node.name.text]);
    }
    tsApi.forEachChild(node, walk);
  };
  tsApi.forEachChild(sf, walk);
  return out;
}

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

/** §28/§30 — a rejection ASSIGNED to the relayed result is a decision site and carries an obligation. */
const RESULT_ASSIGNMENTS: readonly ResultAssignment[] = Object.freeze(censusResultAssignments(PANEL_MUTATIONS_SOURCE, PANEL_OPERATION_FUNCTIONS));
const ASSIGNMENT_DECISION_SITES: readonly DiscoveredRejectionSite[] = Object.freeze(
  RESULT_ASSIGNMENTS.filter((a) => a.classification === "rejection").map((a) => Object.freeze({
    operation: a.operation,
    functionName: "",
    siteId: `${a.operation}#assign-${String(a.ordinal).padStart(2, "0")}`,
    ordinal: a.ordinal,
    reasonExpr: a.reasonLiteral ?? "<propagated>",
    reasonLiteral: a.reasonLiteral,
    isPassthrough: a.reasonLiteral === null,
    guardExpr: a.expr,
    guardKind: "none" as const,
  }))
);

const DECISION_SITES: readonly DiscoveredRejectionSite[] = [
  ...DISCOVERED_REJECTION_SITES.filter((s) => s.guardKind !== "catch"),
  ...ASSIGNMENT_DECISION_SITES,
];

/**
 * ─── R5 §27/§28 — THE AUTH DENIAL UNION IS PINNED TO PRODUCTION SOURCE ────────────────────────
 *
 * R4 MINOR: this list was hand-written on BOTH sides of the reconciliation — once when expanding
 * the passthrough obligations and once in the three `...AUTH_DENIAL_REASONS.map(...)` case spreads
 * — so "the expected side comes from the AST, never from the case table" held for 38 of 59
 * obligations but not for these 21. Nothing tied the list to production's own union, and because
 * `tsconfig` excludes `*.spec.ts` and ts-jest is transpile-only, a TypeScript `satisfies` here
 * would enforce nothing at all. An eighth denial reason added in production would have been
 * discovered by neither side.
 *
 * The members are now parsed out of the authoritative production declaration. The hand-written
 * list below remains — the executable cases need a literal to iterate — but a test asserts exact
 * set equality with the source-derived union, so adding or removing a production reason fails this
 * suite until an executable case exists for it.
 */
const AUTH_MODULE_PATH = joinPath(__dirname, "..", "authorizeTeamWorkspaceMutationInTransaction.ts");
const AUTH_DENIAL_UNION_TYPE_NAME = "TeamMutationAuthorizationDenialReason";

function deriveStringUnionMembers(sourceText: string, typeName: string): string[] {
  const sf = tsApi.createSourceFile("auth.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const members: string[] = [];
  const walk = (node: tsApi.Node) => {
    if (tsApi.isTypeAliasDeclaration(node) && node.name.text === typeName && tsApi.isUnionTypeNode(node.type)) {
      for (const member of node.type.types) {
        if (tsApi.isLiteralTypeNode(member) && tsApi.isStringLiteralLike(member.literal)) members.push(member.literal.text);
      }
    }
    tsApi.forEachChild(node, walk);
  };
  tsApi.forEachChild(sf, walk);
  return members;
}

const AUTH_DENIAL_REASONS_FROM_SOURCE: readonly string[] = Object.freeze(deriveStringUnionMembers(readFileSync(AUTH_MODULE_PATH, "utf8"), AUTH_DENIAL_UNION_TYPE_NAME));

const AUTH_DENIAL_REASONS = ["workspace_not_found", "workspace_malformed", "membership_not_found", "membership_malformed", "membership_removed", "owner_integrity_violation", "insufficient_capability"] as const;

/**
 * ─── R5 §22–§25 — THE EXCLUSION LIST IS EMPTY ─────────────────────────────────────────────────
 *
 * R4 dismantled the previous classification. Three sites were excused as "structurally unreachable
 * under the shipped role matrix", and the doc comment inferred that from their ghost mutations
 * surviving. That inference was wrong for `create#reject-04`, which an existing test in this very
 * file DOES execute through the synthetic capability split at spec:465 — the ghost survived only
 * because that test asserts no panel write and never counts events. So a branch the suite reached
 * carried no zero-event obligation, excused by a justification that did not hold for it. R4 also
 * showed the `vote#reject-13` exclusion's `cross_workspace` leg was prose only: re-sourcing the
 * candidate's workspace id from the panel's stale discovery mirror opens that branch and survived
 * the whole file.
 *
 * The correct fix is not a better exclusion argument. The same synthetic capability split reaches
 * all three sites, so all three now have executable cases, independent site witnesses and
 * whole-store zero-event assertions. Nothing is excused, and nothing rests on prose.
 *
 * The role-matrix containment facts (`reviews.manage` and `reviews.submit` both imply
 * `research.read`) are still asserted below, but as what they are — facts about the shipped matrix
 * that explain why these branches are unreachable through a REAL role, in PRODUCTION. They no
 * longer carry any coverage claim, so they cannot excuse anything if they change.
 */
const STRUCTURALLY_UNREACHABLE_SITES: Readonly<Record<string, { guardExpr: string; reason: string; invariant: string }>> = Object.freeze({});

/**
 * §7 — the expanded runtime obligation layer, derived from the AST inventory. A passthrough site
 * carries the whole propagated union; every other site carries exactly its own reason.
 */
const obligationKey = (siteId: string, reason: string) => `${siteId}::${reason}`;

/** The reasons a site can actually return at run time: its own literal, or the whole propagated union. */
const reachableReasonsOf = (site: DiscoveredRejectionSite): readonly string[] => (site.isPassthrough ? AUTH_DENIAL_REASONS : [site.reasonLiteral as string]);
const EXPANDED_OBLIGATIONS: readonly string[] = Object.freeze(
  DECISION_SITES.flatMap((site) => (site.isPassthrough ? AUTH_DENIAL_REASONS.map((reason) => obligationKey(site.siteId, reason)) : [obligationKey(site.siteId, site.reasonLiteral as string)]))
);
const EXECUTABLE_OBLIGATIONS: readonly string[] = Object.freeze(
  EXPANDED_OBLIGATIONS.filter((obligation) => !Object.prototype.hasOwnProperty.call(STRUCTURALLY_UNREACHABLE_SITES, obligation.slice(0, obligation.indexOf("::"))))
);

/**
 * R5 MAJOR — TWIN DETECTION OVER THE EXPANDED REASON UNION, not the reason EXPRESSION.
 *
 * The previous version grouped sites by `${operation}:${reasonExpr}`, so the authorization
 * passthrough site (`auth.reason`) never collided with the inline `"insufficient_capability" as
 * const` site in the same operation — and the two obligations
 * `create#reject-03::insufficient_capability` and `cancel#reject-03::insufficient_capability` could
 * therefore be credited to a site the fixture never drove, invisibly to the very test meant to catch
 * it. Two sites in one operation are twins when the reasons they can RETURN overlap, which is what
 * the runtime obligation is keyed on.
 */
const REASON_TWIN_PAIRS: readonly (readonly [string, string, string])[] = (() => {
  const byOperationReason = new Map<string, string[]>();
  for (const site of DECISION_SITES) {
    for (const reason of reachableReasonsOf(site)) {
      const key = `${site.operation}::${reason}`;
      byOperationReason.set(key, [...(byOperationReason.get(key) ?? []), site.siteId]);
    }
  }
  const directed: (readonly [string, string, string])[] = [];
  for (const [key, siteIds] of byOperationReason) {
    if (siteIds.length < 2) continue;
    const reason = key.slice(key.indexOf("::") + 2);
    for (const a of siteIds) for (const b of siteIds) if (a !== b) directed.push([a, b, reason] as const);
  }
  return Object.freeze(directed);
})();

/**
 * §13/§14 — INDEPENDENT SITE WITNESSES. Deliberately a SEPARATE structure from `REJECTION_CASES`:
 * R4 BLOCKER BL2 was that a case's declared site id was never observed. The runner checked the
 * returned reason and then recorded the DECLARED id, and for a duplicate-reason pair the reason
 * cannot say which of the two returns fired — so re-pointing a case's fixture at its twin left the
 * reconciliation reporting full coverage while the twin branch had none. Three such misaims
 * survived the whole suite.
 *
 * A witness runs AFTER `arrange()` and BEFORE the production call, and interrogates canonical
 * fixture state through the REAL production predicates — `resolveWorkspaceReviewTarget`,
 * `parseAdaptiveHumanReviewPanel`, the live capability mock — never the case's own declaration. A
 * case that arranges its twin's state therefore fails its own witness before the production result
 * can be credited to the site it claims.
 */
function storedRunTargetKind(): string {
  const run = stores.runs.get(RUN_ID) as Record<string, unknown> | undefined;
  if (!run) return "run_document_absent";
  return resolveWorkspaceReviewTarget({
    requestedWorkspaceId: WS_ID,
    hasWorkspaceIdField: "workspaceId" in run,
    workspaceIdValue: run.workspaceId,
    userId: run.userId,
    hasProjectIdField: "projectId" in run,
    projectIdValue: run.projectId,
  }).kind;
}

function storedPanelState(): { parse: string; status: string | null; reviewers: string[] } {
  const raw = stores.humanReviewPanel.get(`${RUN_ID}::current`);
  const parsed = parseAdaptiveHumanReviewPanel(raw, { expectedRunId: RUN_ID });
  return parsed.status === "valid"
    ? { parse: "valid", status: parsed.panel.status, reviewers: parsed.panel.reviewerUserIds }
    : { parse: parsed.status, status: null, reviewers: [] };
}

/** True when the ACTIVE capability mock denies `capability` to `role` — i.e. a split is installed. */
const capabilityDeniedTo = (role: string, capability: string) => mockedRoleHasCapability(role, capability) === false;

const witnessed = (label: string, actual: unknown, expected: unknown) => expect(`${label}:${String(actual)}`).toBe(`${label}:${String(expected)}`);

/** R5 NIT — the caller's role is read from the seeded membership, never hardcoded, so a witness tracks a case whose caller changes. */
function seededRoleOf(callerUid: string): string | null {
  const membership = stores.workspaceMemberships.get(computeMembershipId(WS_ID, callerUid)) as { role?: string } | undefined;
  return membership?.role ?? null;
}

/**
 * R5 MAJOR — the three authorization PASSTHROUGH sites had no witness at all, so an obligation could
 * be credited to `<op>#reject-03` while the fixture actually drove the inline `research.read` check at
 * `<op>#reject-04`. Two obligations were exploitable (`create`/`cancel` `insufficient_capability`),
 * and §13's duplicate detection could not see the collision because it grouped on the reason
 * EXPRESSION — `auth.reason` never equals `"insufficient_capability" as const`.
 *
 * This witness is reason-specific and reads only canonical fixture state, plus the one fact that
 * separates site 03 from site 04: site 04 requires the synthetic capability split, site 03 must NOT
 * have it installed.
 */
/** The capability each audited operation's authorization call actually requires. */
const OPERATION_REQUIRED_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({ create: "reviews.manage", cancel: "reviews.manage", vote: "reviews.submit" });

function authDenialWitness(reason: string, callerUid: string, operation: string): void {
  witnessed("noCapabilitySplitInstalled", capabilityDeniedTo("owner", "research.read"), false);
  const workspace = stores.workspaces.get(WS_ID) as { type?: string; ownerUserId?: string } | undefined;
  const membership = stores.workspaceMemberships.get(computeMembershipId(WS_ID, callerUid)) as { uid?: string; role?: string; status?: string } | undefined;
  switch (reason) {
    case "workspace_not_found":
      return witnessed("workspaceDocumentPresent", Boolean(workspace), false);
    case "workspace_malformed":
      witnessed("workspaceDocumentPresent", Boolean(workspace), true);
      return witnessed("workspaceIsTeamType", workspace?.type === "team", false);
    case "membership_not_found":
      return witnessed("callerMembershipPresent", Boolean(membership), false);
    case "membership_malformed":
      witnessed("callerMembershipPresent", Boolean(membership), true);
      return witnessed("membershipUidMatchesCaller", membership?.uid === callerUid, false);
    case "membership_removed":
      return witnessed("callerMembershipStatus", membership?.status, "removed");
    case "owner_integrity_violation":
      witnessed("callerMembershipRole", membership?.role, "owner");
      return witnessed("callerIsTheWorkspaceOwner", workspace?.ownerUserId === callerUid, false);
    case "insufficient_capability": {
      const required = OPERATION_REQUIRED_CAPABILITY[operation];
      witnessed("callerMembershipStatus", membership?.status, "active");
      return witnessed(`callerRoleHolds:${required}`, actualCapabilities.roleHasCapability(membership?.role as never, required as never), false);
    }
    default:
      throw new Error(`authDenialWitness: unhandled reason "${reason}"`);
  }
}

type WitnessContext = { callerUid: string; reason: string; operation: "create" | "cancel" | "vote" };
const SITE_WITNESSES: Readonly<Record<string, (ctx: WitnessContext) => void>> = Object.freeze({
  // ── the three authorization passthrough sites, one witness per reachable reason ──
  "create#reject-03": ({ reason, callerUid, operation }) => authDenialWitness(reason, callerUid, operation),
  "cancel#reject-03": ({ reason, callerUid, operation }) => authDenialWitness(reason, callerUid, operation),
  "vote#reject-03": ({ reason, callerUid, operation }) => authDenialWitness(reason, callerUid, operation),
  // ── the two `run_not_found` twins in each operation: absent document vs present-but-not-ours ──
  "create#reject-05": () => witnessed("targetKind", storedRunTargetKind(), "run_document_absent"),
  "create#reject-06": () => witnessed("targetKind", storedRunTargetKind(), "wrong_workspace"),
  "cancel#reject-05": () => { witnessed("targetKind", storedRunTargetKind(), "run_document_absent"); witnessed("panelParse", storedPanelState().parse, "valid"); },
  "cancel#reject-06": () => { witnessed("targetKind", storedRunTargetKind(), "wrong_workspace"); witnessed("panelParse", storedPanelState().parse, "valid"); },
  "vote#reject-04": () => witnessed("targetKind", storedRunTargetKind(), "run_document_absent"),
  "vote#reject-05": () => witnessed("targetKind", storedRunTargetKind(), "wrong_workspace"),
  // ── create's two `panel_finalized` twins: genuinely finalized vs cancelled-and-never-reopened ──
  "create#reject-10": () => { const p = storedPanelState(); witnessed("panelParse", p.parse, "valid"); witnessed("panelStatus", p.status, "finalized"); },
  "create#reject-11": () => { const p = storedPanelState(); witnessed("panelParse", p.parse, "valid"); witnessed("panelStatus", p.status, "cancelled"); },
  // ── vote's two `not_reviewer` twins: not on the roster vs on it but ineligible ──
  "vote#reject-12": ({ callerUid }) => { const p = storedPanelState(); witnessed("panelParse", p.parse, "valid"); witnessed("callerOnRoster", p.reviewers.includes(callerUid), false); },
  "vote#reject-13": ({ callerUid }) => {
    const p = storedPanelState();
    witnessed("panelParse", p.parse, "valid");
    witnessed("callerOnRoster", p.reviewers.includes(callerUid), true);
    witnessed("callerRoleDeniedResearchRead", capabilityDeniedTo(seededRoleOf(callerUid) as string, "research.read"), true);
    witnessed("callerRoleStillHoldsReviewsSubmit", capabilityDeniedTo(seededRoleOf(callerUid) as string, "reviews.submit"), false);
  },
  // ── the two inline research.read checks, now executable rather than excused ──
  "create#reject-04": ({ callerUid }) => { witnessed("roleDeniedResearchRead", capabilityDeniedTo(seededRoleOf(callerUid) as string, "research.read"), true); witnessed("roleStillHoldsReviewsManage", capabilityDeniedTo(seededRoleOf(callerUid) as string, "reviews.manage"), false); },
  "cancel#reject-04": ({ callerUid }) => { witnessed("roleDeniedResearchRead", capabilityDeniedTo(seededRoleOf(callerUid) as string, "research.read"), true); witnessed("roleStillHoldsReviewsManage", capabilityDeniedTo(seededRoleOf(callerUid) as string, "reviews.manage"), false); },
});

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
    // §50 — the expected side is built from the COUNT, not from the actual array: the previous
    // version mapped the actual ordinals to their own indices, so it passed vacuously (including on
    // an empty inventory) instead of constraining density.
    const expectedFor = (count: number) => Array.from({ length: count }, (_, i) => i + 1).join(",");
    for (const [operation, count] of [["create", 14], ["cancel", 13], ["vote", 17]] as const) {
      const ordinals = DISCOVERED_REJECTION_SITES.filter((s) => s.operation === operation).map((s) => s.ordinal);
      expect(`${operation}:${ordinals.join(",")}`).toBe(`${operation}:${expectedFor(count)}`);
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

  it("the obligation layers reconcile: 41 decision sites -> 59 expanded -> 0 excluded -> 59 executable", () => {
    expect(`expanded:${EXPANDED_OBLIGATIONS.length} excludedSites:${Object.keys(STRUCTURALLY_UNREACHABLE_SITES).length} executable:${EXECUTABLE_OBLIGATIONS.length}`).toBe("expanded:59 excludedSites:0 executable:59");
    expect(new Set(EXPANDED_OBLIGATIONS).size).toBe(EXPANDED_OBLIGATIONS.length);
  });

  it("§27 — the auth denial union used by the executable cases equals the one PRODUCTION declares", () => {
    expect([...AUTH_DENIAL_REASONS].sort()).toEqual([...AUTH_DENIAL_REASONS_FROM_SOURCE].sort());
    // and the derivation is not vacuously empty, which would make the equality meaningless
    expect(`sourceDerivedMembers:${AUTH_DENIAL_REASONS_FROM_SOURCE.length}`).toBe("sourceDerivedMembers:7");
  });

  it("§28 — the passthrough obligation count is DERIVED, not hard-coded", () => {
    const passthroughSites = DECISION_SITES.filter((s) => s.isPassthrough).length;
    expect(`sites:${passthroughSites} x reasons:${AUTH_DENIAL_REASONS_FROM_SOURCE.length} = obligations:${passthroughSites * AUTH_DENIAL_REASONS_FROM_SOURCE.length}`).toBe("sites:3 x reasons:7 = obligations:21");
    const passthroughObligations = EXPANDED_OBLIGATIONS.filter((o) => DECISION_SITES.some((s) => s.isPassthrough && o.startsWith(`${s.siteId}::`)));
    expect(passthroughObligations.length).toBe(passthroughSites * AUTH_DENIAL_REASONS_FROM_SOURCE.length);
  });

  it("§22 — an exclusion, if ever reintroduced, must match the discovered site's guard exactly", () => {
    // Dead while the map is empty, by design — but without it a future repopulation could silently
    // re-point an exclusion at a different branch after ordinal drift.
    for (const [siteId, classification] of Object.entries(STRUCTURALLY_UNREACHABLE_SITES)) {
      const site = DISCOVERED_REJECTION_SITES.find((s) => s.siteId === siteId);
      expect(`${siteId}:found:${Boolean(site)}`).toBe(`${siteId}:found:true`);
      expect(`${siteId}:guard:${site?.guardExpr}`).toBe(`${siteId}:guard:${classification.guardExpr}`);
      expect(`${siteId}:reason:${site?.reasonLiteral}`).toBe(`${siteId}:reason:${classification.reason}`);
    }
    expect(Object.keys(STRUCTURALLY_UNREACHABLE_SITES)).toEqual([]);
  });

  it("§22 — NOTHING is excluded: every decision site carries an executable obligation", () => {
    expect(Object.keys(STRUCTURALLY_UNREACHABLE_SITES)).toEqual([]);
    // R5 NIT — the previous form derived both sides from `EXPANDED_OBLIGATIONS.length`, so it could
    // only fail when the line above already had. Pinned to the literal instead.
    expect(`executable:${EXECUTABLE_OBLIGATIONS.length} expanded:${EXPANDED_OBLIGATIONS.length}`).toBe("executable:59 expanded:59");
    // and the three sites R4 proved were wrongly excused each have a real case AND a witness
    for (const siteId of ["create#reject-04", "cancel#reject-04", "vote#reject-13"]) {
      expect(`${siteId}:hasCase:${REJECTION_CASES.some((c) => c.siteId === siteId)}`).toBe(`${siteId}:hasCase:true`);
      expect(`${siteId}:hasWitness:${Boolean(SITE_WITNESSES[siteId])}`).toBe(`${siteId}:hasWitness:true`);
    }
  });

  /**
   * §13 — a duplicate-reason site MUST have a witness: it is the only place where the returned
   * reason cannot identify which branch fired, so it is the only place a self-declared label can
   * silently un-cover a branch. Derived from the AST, so a NEW duplicate pair introduced in
   * production fails here until witnesses exist for both of its sites.
   */
  it("§13 — every site that shares a reachable reason with another site in its operation has a witness", () => {
    const twinSites = [...new Set(REASON_TWIN_PAIRS.flatMap(([a, b]) => [a, b]))].sort();
    expect(`twinSites:${twinSites.length}`).toBe("twinSites:14");
    expect(twinSites).toEqual([
      "cancel#reject-03", "cancel#reject-04", "cancel#reject-05", "cancel#reject-06",
      "create#reject-03", "create#reject-04", "create#reject-05", "create#reject-06", "create#reject-10", "create#reject-11",
      "vote#reject-04", "vote#reject-05", "vote#reject-12", "vote#reject-13",
    ]);
    const unwitnessed = twinSites.filter((siteId) => !SITE_WITNESSES[siteId]);
    expect(`twinSitesWithoutAWitness:${unwitnessed.join(",")}`).toBe("twinSitesWithoutAWitness:");
    // and every passthrough site is witnessed, whether or not it happens to have a twin
    const unwitnessedPassthrough = DECISION_SITES.filter((s) => s.isPassthrough && !SITE_WITNESSES[s.siteId]).map((s) => s.siteId);
    expect(`passthroughSitesWithoutAWitness:${unwitnessedPassthrough.join(",")}`).toBe("passthroughSitesWithoutAWitness:");
  });

  /**
   * ─── R6 — THE WITNESS LAYER'S OWN FALSIFIER ──────────────────────────────────────────────────
   *
   * R5 MAJOR: every witness body could be replaced with `() => {}` and the suite still exited 0.
   * §13 and the postcondition checked only that a witness EXISTED BY KEY, never that it constrained
   * anything — so hollowing a body silently restored R4's BL2 while the suite reported clean. That
   * is the "record the assertion, not the name" failure mode, reproduced in the mechanism built to
   * fix the previous round's blocker.
   *
   * A witness is now required to DISCRIMINATE: for every twin pair it must accept the state its own
   * case arranges and REJECT the state its twin's case arranges, invoked with the twin's own caller
   * and reason — which is precisely the mislabelling attack. An empty body fails the second half
   * immediately, so no witness can be present without being load-bearing.
   */
  const caseFor = (siteId: string, reason: string) => REJECTION_CASES.find((c) => c.siteId === siteId && c.reason === reason);
  const contextFor = (testCase: RejectionCase): WitnessContext => ({
    callerUid: testCase.resolveCallerUid?.() ?? testCase.callerUid ?? OWNER_UID,
    reason: testCase.reason,
    operation: testCase.siteId.split("#")[0] as "create" | "cancel" | "vote",
  });

  it.each(REASON_TWIN_PAIRS)("the %s witness accepts its own arranged state and REJECTS its %s twin's (%s)", (site, twin, reason) => {
    const own = caseFor(site, reason);
    const other = caseFor(twin, reason);
    expect(`bothCasesRegistered:${Boolean(own)}/${Boolean(other)}`).toBe("bothCasesRegistered:true/true");
    const witness = SITE_WITNESSES[site];
    expect(`witnessPresent:${site}:${Boolean(witness)}`).toBe(`witnessPresent:${site}:true`);

    seedBaseFixture();
    (own as RejectionCase).arrange?.();
    expect(() => witness(contextFor(own as RejectionCase))).not.toThrow();

    seedBaseFixture();
    (other as RejectionCase).arrange?.();
    expect(() => witness(contextFor(other as RejectionCase))).toThrow();
  });

  /**
   * §22 — RETAINED AS A ROLE-MATRIX FACT, not as an exclusion proof. It explains why these two
   * branches cannot be reached through a REAL shipped role in production; it no longer excuses any
   * missing coverage, because both sites now have executable cases reached through the synthetic
   * capability split. If the matrix changes, this fails and the fact is restated — nothing silently
   * becomes uncovered either way.
   */
  it("ROLE-MATRIX FACT: every shipped role with reviews.manage also has research.read", () => {
    const roles = Object.keys(actualCapabilities.ROLE_CAPABILITIES) as (keyof typeof actualCapabilities.ROLE_CAPABILITIES)[];
    expect(roles.length).toBeGreaterThan(0);
    const managers = roles.filter((role) => actualCapabilities.roleHasCapability(role, "reviews.manage"));
    expect(`rolesWithReviewsManage:${managers.join(",")}`).toBe("rolesWithReviewsManage:owner,admin");
    const violating = managers.filter((role) => !actualCapabilities.roleHasCapability(role, "research.read"));
    expect(`managersLackingResearchRead:${violating.join(",")}`).toBe("managersLackingResearchRead:");
  });

  /**
   * §25/§52 — the previous version of this test named FOUR exclusion legs in prose while asserting
   * two. The exclusion is gone, so there is nothing left to over-claim: what remains are two
   * independently useful facts, each fully asserted — the capability containment, and that the
   * assignment and decision self-review guards really are one predicate.
   */
  it("ROLE-MATRIX FACT: every shipped role with reviews.submit also has research.read, and the two self-review predicates are the same predicate", () => {
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
/**
 * §14 — `setup` runs BEFORE the whole-store event snapshot, for sites whose prerequisites include a
 * genuinely successful prior mutation (`vote_conflict` needs an accepted first vote, which
 * legitimately writes its own event). `arrange` mutates fixture state AFTER the snapshot;
 * `callerUid` is the identity the operation will run as, which the witness needs; `act` performs
 * the call and nothing else. Splitting arrange from act is what makes room for the witness to run
 * between them — the old single `run()` did both, so there was no point at which independent state
 * could be interrogated.
 */
type RejectionCase = {
  siteId: string;
  reason: string;
  callerUid?: string;
  /** For cases whose caller is only determined during `arrange` (the authorization denials). */
  resolveCallerUid?: () => string;
  setup?: () => Promise<void> | void;
  arrange?: () => void;
  act: () => Promise<{ ok: boolean; reason?: unknown }>;
};

/** §22–§24 — the synthetic capability split this suite already uses at spec:465, reused to reach the three sites R4 proved were wrongly excused. */
function installCapabilitySplit(role: string, deniedCapability: string): void {
  mockedRoleHasCapability.mockImplementation((r: string, c: string) => (r === role && c === deniedCapability ? false : actualCapabilities.roleHasCapability(r, c)));
}

const REJECTION_CASES: readonly RejectionCase[] = [
  // ── create ──
  { siteId: "create#reject-01", reason: "team_workspaces_disabled", arrange: () => { teamWorkspacesEnabled = false; }, act: () => putCall() },
  { siteId: "create#reject-02", reason: "firestore_unavailable", arrange: () => { firestoreUnavailableFlag.value = true; }, act: () => putCall() },
  ...AUTH_DENIAL_REASONS.map((reason) => { let uid = OWNER_UID; return { siteId: "create#reject-03", reason, resolveCallerUid: () => uid, arrange: () => { uid = seedAuthDenial(reason, OWNER_UID, "owner"); }, act: () => putCall({ uid }) }; }),
  { siteId: "create#reject-04", reason: "insufficient_capability", arrange: () => installCapabilitySplit("owner", "research.read"), act: () => putCall() },
  { siteId: "create#reject-05", reason: "run_not_found", arrange: () => { stores.runs.delete(RUN_ID); }, act: () => putCall() },
  { siteId: "create#reject-06", reason: "run_not_found", arrange: () => { foreignWorkspaceRun(); }, act: () => putCall() },
  { siteId: "create#reject-07", reason: "not_pending", arrange: () => { notPendingRun(); }, act: () => putCall() },
  { siteId: "create#reject-08", reason: "single_review_active", arrange: () => { seedAssignment({ assignedReviewerUserId: REVIEWER_UID }); }, act: () => putCall() },
  { siteId: "create#reject-09", reason: "panel_unreadable", arrange: () => { stores.humanReviewPanel.set(`${RUN_ID}::current`, { kind: "not-a-panel" }); }, act: () => putCall() },
  { siteId: "create#reject-10", reason: "panel_finalized", arrange: () => { seedPanel({ revision: 1, ...FINALIZED }); }, act: () => putCall({ expectedRevision: 1 }) },
  { siteId: "create#reject-11", reason: "panel_finalized", arrange: () => { seedPanel({ revision: 1, status: "cancelled" }); }, act: () => putCall({ expectedRevision: 1 }) },
  { siteId: "create#reject-12", reason: "stale_revision", arrange: () => { seedPanel({ revision: 3 }); }, act: () => putCall({ expectedRevision: 0 }) },
  { siteId: "create#reject-13", reason: "target_not_eligible", act: () => putCall({ reviewerUserIds: [OWNER_UID, VIEWER_UID] }) },
  // ── cancel ──
  { siteId: "cancel#reject-01", reason: "team_workspaces_disabled", arrange: () => { teamWorkspacesEnabled = false; }, act: () => deleteCall() },
  { siteId: "cancel#reject-02", reason: "firestore_unavailable", arrange: () => { firestoreUnavailableFlag.value = true; }, act: () => deleteCall() },
  ...AUTH_DENIAL_REASONS.map((reason) => { let uid = OWNER_UID; return { siteId: "cancel#reject-03", reason, resolveCallerUid: () => uid, arrange: () => { seedPanel({ revision: 1 }); uid = seedAuthDenial(reason, OWNER_UID, "owner"); }, act: () => deleteCall({ uid }) }; }),
  { siteId: "cancel#reject-04", reason: "insufficient_capability", arrange: () => { seedPanel({ revision: 1 }); installCapabilitySplit("owner", "research.read"); }, act: () => deleteCall() },
  { siteId: "cancel#reject-05", reason: "run_not_found", arrange: () => { seedPanel({ revision: 1 }); stores.runs.delete(RUN_ID); }, act: () => deleteCall() },
  { siteId: "cancel#reject-06", reason: "run_not_found", arrange: () => { seedPanel({ revision: 1 }); foreignWorkspaceRun(); }, act: () => deleteCall() },
  { siteId: "cancel#reject-07", reason: "not_pending", arrange: () => { seedPanel({ revision: 1 }); notPendingRun(); }, act: () => deleteCall() },
  { siteId: "cancel#reject-08", reason: "panel_absent", act: () => deleteCall() },
  { siteId: "cancel#reject-09", reason: "panel_unreadable", arrange: () => { stores.humanReviewPanel.set(`${RUN_ID}::current`, { kind: "not-a-panel" }); }, act: () => deleteCall() },
  { siteId: "cancel#reject-10", reason: "panel_finalized", arrange: () => { seedPanel({ revision: 1, ...FINALIZED }); }, act: () => deleteCall() },
  { siteId: "cancel#reject-11", reason: "panel_already_cancelled", arrange: () => { seedPanel({ revision: 1, status: "cancelled" }); }, act: () => deleteCall() },
  { siteId: "cancel#reject-12", reason: "stale_revision", arrange: () => { seedPanel({ revision: 3 }); }, act: () => deleteCall({ expectedRevision: 1 }) },
  // ── vote ──
  { siteId: "vote#reject-01", reason: "team_workspaces_disabled", arrange: () => { teamWorkspacesEnabled = false; }, act: () => voteCall() },
  { siteId: "vote#reject-02", reason: "firestore_unavailable", arrange: () => { firestoreUnavailableFlag.value = true; }, act: () => voteCall() },
  ...AUTH_DENIAL_REASONS.map((reason) => { let uid = OWNER_UID; return { siteId: "vote#reject-03", reason, resolveCallerUid: () => uid, arrange: () => { seedPanel({ revision: 1 }); uid = seedAuthDenial(reason, OWNER_UID, "owner"); }, act: () => voteCall({ uid }) }; }),
  { siteId: "vote#reject-04", reason: "run_not_found", arrange: () => { seedPanel({ revision: 1 }); stores.runs.delete(RUN_ID); }, act: () => voteCall() },
  // The worst ghost-event case in the whole module: a REJECTED cross-Workspace vote must not mint
  // `vote_cast` on a foreign Workspace's run document.
  { siteId: "vote#reject-05", reason: "run_not_found", arrange: () => { seedPanel({ revision: 1 }); foreignWorkspaceRun(); }, act: () => voteCall() },
  { siteId: "vote#reject-06", reason: "not_pending", arrange: () => { seedPanel({ revision: 1 }); notPendingRun(); }, act: () => voteCall() },
  { siteId: "vote#reject-07", reason: "panel_absent", act: () => voteCall() },
  { siteId: "vote#reject-08", reason: "panel_unreadable", arrange: () => { stores.humanReviewPanel.set(`${RUN_ID}::current`, { kind: "not-a-panel" }); }, act: () => voteCall() },
  { siteId: "vote#reject-09", reason: "panel_not_open", arrange: () => { seedPanel({ revision: 1, status: "cancelled" }); }, act: () => voteCall() },
  { siteId: "vote#reject-10", reason: "panel_stale", arrange: () => { seedPanel({ revision: 2 }); }, act: () => voteCall({ panelRevision: 1 }) },
  { siteId: "vote#reject-11", reason: "self_review", callerUid: CREATOR_UID, arrange: () => { seedPanel({ revision: 1, reviewerUserIds: [CREATOR_UID, OWNER_UID] }); }, act: () => voteCall({ uid: CREATOR_UID }) },
  { siteId: "vote#reject-12", reason: "not_reviewer", callerUid: REVIEWER2_UID, arrange: () => { seedPanel({ revision: 1 }); }, act: () => voteCall({ uid: REVIEWER2_UID }) },
  // On the roster, but the eligibility predicate denies — the twin of #12, reached through the
  // synthetic capability split rather than excused as unreachable.
  { siteId: "vote#reject-13", reason: "not_reviewer", arrange: () => { seedPanel({ revision: 1 }); installCapabilitySplit("owner", "research.read"); }, act: () => voteCall() },
  { siteId: "vote#reject-14", reason: "review_content_unavailable", arrange: () => { seedPanel({ revision: 1 }); seedRun({ governanceRecord: validGovernanceRecord({ decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false } }) }); }, act: () => voteCall() },
  { siteId: "vote#reject-15", reason: "vote_malformed", arrange: () => { seedPanel({ revision: 1 }); stores.humanReviewVotes.set(`${RUN_ID}::${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`, { kind: "not-a-vote" }); }, act: () => voteCall() },
  { siteId: "vote#reject-16", reason: "vote_conflict", setup: async () => { seedPanel({ revision: 1 }); expect((await voteCall({ status: "approved" })).ok).toBe(true); }, act: () => voteCall({ status: "changes_requested" }) },
];

/** The per-run execution ledger. Asserted against the AST INVENTORY, never against the case table. */
const executedObligations: string[] = [];
/**
 * §31 — set by the in-describe reconciliation. The postcondition requires it, so the exact command
 * R4 demonstrated — `-t "rejects with its own reason"`, which ran every case but FILTERED OUT the
 * reconciliation and exited 0 — can no longer report a clean result.
 */
let reconciliationExecuted = false;
const reasonOf = (r: { reason?: unknown }) => (typeof r.reason === "string" ? r.reason : (r.reason as { kind?: string } | undefined)?.kind);

describe("panel mutation audit coverage — zero ghost events at every discovered decision site", () => {
  it.each(REJECTION_CASES.map((c) => [`${c.siteId} -> ${c.reason}`, c] as const))("%s rejects with its own reason and writes no event", async (label, testCase) => {
    if (testCase.setup) await testCase.setup();
    if (testCase.arrange) testCase.arrange();
    // §14 — the WITNESS runs here: after the fixture is arranged, before production is called, and
    // it interrogates canonical state through the real predicates rather than trusting the label.
    const witness = SITE_WITNESSES[testCase.siteId];
    if (witness) witness({ callerUid: testCase.resolveCallerUid?.() ?? testCase.callerUid ?? OWNER_UID, reason: testCase.reason, operation: testCase.siteId.split("#")[0] as "create" | "cancel" | "vote" });
    // R8 §8 — snapshotted AFTER arrange, so the contract is "the OPERATION changed nothing durable".
    const before = snapshotStore();
    const result = await testCase.act();
    expect(`${label}:rejected:${result.ok}`).toBe(`${label}:rejected:false`);
    expect(`${label}:reason:${reasonOf(result)}`).toBe(`${label}:reason:${testCase.reason}`);
    // The whole store, by canonical path — not a log, not a collection name, not a payload shape.
    expectNoDurableChange(label, before);
    expectNoForeignPersistenceWriters();
    executedObligations.push(obligationKey(testCase.siteId, testCase.reason));
  });

  /**
   * §43 — THE RECONCILIATION. The expected side is the AST inventory, maintained by the compiler
   * rather than by hand, so this fails on a deleted case, a skipped case, a duplicated case, a
   * case aimed at a non-existent site, a NEW production decision point with no case, and — the
   * property R3's contract could not express — two duplicate-reason sites collapsed into one.
   */
  it("every executable obligation discovered in the source was executed exactly once", () => {
    reconciliationExecuted = true;
    expect([...executedObligations].sort()).toEqual([...EXECUTABLE_OBLIGATIONS].sort());
    expect(`executed:${executedObligations.length} executable:${EXECUTABLE_OBLIGATIONS.length} duplicates:${executedObligations.length - new Set(executedObligations).size}`).toBe(`executed:59 executable:59 duplicates:0`);
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
    expect(`bySite:${new Set(EXECUTABLE_OBLIGATIONS).size} byOperationReason:${new Set(EXECUTABLE_OBLIGATIONS.map(collapse)).size}`).toBe("bySite:59 byOperationReason:52");
    // 59 -> 52 is SEVEN masked sites, not five: collapsing additionally merges each inline
    // `insufficient_capability` twin (create#reject-04, cancel#reject-04) onto the authorization
    // passthrough's own `insufficient_capability`, and vote#reject-13 onto vote#reject-12. A
    // reason-keyed proof cannot even express those three sites separately.
    expect(`allExpandedBySite:${new Set(EXPANDED_OBLIGATIONS).size} allExpandedCollapsed:${new Set(EXPANDED_OBLIGATIONS.map(collapse)).size}`).toBe("allExpandedBySite:59 allExpandedCollapsed:52");
  });

  /**
   * §50 / R4 N1 — the twin is DERIVED from the AST, not supplied by hand. The previous version took
   * the twin as a literal column that no assertion consumed, so substituting a same-reason twin from
   * a DIFFERENT operation went undetected. Every duplicate-reason pair in the source now generates
   * its own case in both directions, so a new pair added in production is covered automatically and
   * a wrong twin cannot be written down at all.
   */
  /**
   * R5 NIT — the previous "same-operation by construction" assertion could not fail: the grouping key
   * embedded the operation, so a cross-operation group was unconstructable and the test constrained
   * itself rather than the subject. Replaced with a statement ABOUT THE SUBJECT: ten reasons really
   * are shared across operations, and none of them produces a twin pair, because a twin is
   * operation-scoped by definition.
   */
  it("reasons ARE shared across operations, yet no twin pair spans two operations", () => {
    const byReason = new Map<string, Set<string>>();
    for (const site of DECISION_SITES) {
      for (const reason of reachableReasonsOf(site)) {
        byReason.set(reason, new Set([...(byReason.get(reason) ?? []), site.operation]));
      }
    }
    const sharedAcrossOperations = [...byReason.entries()].filter(([, ops]) => ops.size > 1).map(([reason]) => reason).sort();
    expect(sharedAcrossOperations.length).toBeGreaterThanOrEqual(10);
    const crossOperation = REASON_TWIN_PAIRS.filter(([a, b]) => a.split("#")[0] !== b.split("#")[0]);
    expect(`crossOperationTwins:${crossOperation.map(([a, b]) => `${a}/${b}`).join(",")}`).toBe("crossOperationTwins:");
  });

  it.each(REASON_TWIN_PAIRS)("deleting %s's coverage is caught by site identity and MASKED by its %s twin (both return %s)", (deleted, twin, reason) => {
    const collapse = (obligation: string) => `${obligation.slice(0, obligation.indexOf("#"))}::${obligation.slice(obligation.indexOf("::") + 2)}`;
    // Only the specific (site, reason) obligation is dropped — a passthrough site carries seven, and
    // removing all of them would not model the single-obligation deletion this falsifier is about.
    const ledgerWithDeletion = executedObligations.filter((o) => o !== obligationKey(deleted, reason));
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
 * ─── R5 §32–§40, §47 — SYMMETRIC EVENT PROVENANCE FOR ALL FOUR ACTIONS ────────────────────────
 *
 * R4 MAJOR, twice over. The previous round built a rigorous per-field matrix for CANCEL only, and
 * the reviewer who looked at the other three actions found exactly what asymmetry predicts:
 *   • the VOTE event's `byUid` — the one field whose entire purpose is "who cast this vote" — could
 *     be re-sourced from `panel.createdByUserId` or `panel.updatedByUserId` and survive, because
 *     `seedPanel()` defaults BOTH to `OWNER_UID` and every vote assertion votes as `OWNER_UID`, who
 *     is also `workspace.ownerUserId`: a four-way identity collapse.
 *   • `workspaceId` could be re-sourced from the panel's STALE discovery mirror on both the VOTE and
 *     the RECONFIGURE events, because those fixtures always seeded the mirror equal to the run's own
 *     Workspace. The panel's `workspaceId`/`projectId` are documented discovery metadata and are
 *     explicitly NOT authority; the parser never compares them to the run.
 *
 * So the fix is not "add the two mutations the reviewer named". It is to enumerate every
 * authority-bearing and state-bearing field of ALL FOUR actions, and to de-collapse the fixtures so
 * that every plausible competing source holds a DIFFERENT value (§40). A provenance assertion is
 * only meaningful when the wrong answer would look different from the right one.
 *
 * THE DE-COLLAPSED IDENTITY SET, distinct by construction and asserted so before every call:
 *   workspace owner      owner-1     run creator          creator-1
 *   panel createdBy      reviewer-1  panel updatedBy      reviewer-2
 *   create/reconfigure/cancel caller admin-1  (holds reviews.manage + research.read)
 *   vote caller                      reviewer-3 (on the roster, holds reviews.submit; not the
 *                                    creator, not the owner, not the panel's creator or updater,
 *                                    and not the roster's first entry)
 * plus: panel revision 5 ≠ reviewer count 3 ≠ quorum 2; a non-null Project distinct from the
 * Workspace id; a deliberately STALE panel Workspace/Project mirror; and a non-default governance
 * context.
 *
 * §47 — "canonical, not the request" is only claimed where it is observable. Where a builder is a
 * pure projection of the request (`nextVote.status` is literally `args.status`), the alternative is
 * classified EQUIVALENT with the projection named, rather than dressed up as a security property.
 */
const PROV_CALLER_MANAGE = ADMIN_UID;
const PROV_CALLER_VOTE = REVIEWER3_UID;
const PROV_PANEL_CREATED_BY = REVIEWER_UID;
const PROV_PANEL_UPDATED_BY = REVIEWER2_UID;
const PROV_PANEL_REVISION = 5;
const PROV_PANEL_CREATED_AT = "2026-07-02T00:00:00.000Z";
const PROV_PANEL_UPDATED_AT = "2026-07-03T00:00:00.000Z";
/** The panel's Workspace/Project mirror is DISCOVERY metadata, never authority — so it is seeded STALE on purpose. */
const STALE_PANEL_WORKSPACE_MIRROR = "wsPanelMirrorStale01";
const STALE_PANEL_PROJECT_MIRROR = "projPanelMirrorStale01";

type ProvenanceRow = {
  field: string;
  correctSource: string;
  correct: () => unknown;
  /** Every OTHER value reachable at the event site that this field could plausibly have come from. */
  discriminated: readonly (readonly [string, () => unknown])[];
  /** Sources a preceding guard or a pure projection proves equal, each with that reason named. */
  equivalent: readonly (readonly [string, () => unknown, string])[];
};

type ProvenanceSubject = {
  action: string;
  label: string;
  /**
   * True when the event's canonical sources are the panel this transaction COMMITS, which does not
   * exist until the call returns (create and reconfigure both project `nextPanel`). For those the
   * de-collapse of the FIXTURE is still asserted beforehand; only the committed-panel values are
   * necessarily read afterwards. Cancel and vote project a panel that already exists, so their
   * snapshot is taken strictly before the call — which is what caught the earlier draft's
   * post-mutation read of `updatedByUserId`.
   */
  canonicalIsCommitted?: boolean;
  /** Establishes the de-collapsed fixture. Runs before the snapshot and before the call. */
  seed: () => void;
  call: () => Promise<{ ok: boolean }>;
  rows: () => readonly ProvenanceRow[];
};

const provRun = () => stores.runs.get(RUN_ID) as { userId: string; workspaceId: string; projectId: string | null; governanceRecord: { schemaId: string; answerShape: string; updatedAt: string } };
const provPanel = () => stores.humanReviewPanel.get(`${RUN_ID}::current`) as { revision: number; reviewerUserIds: string[]; requiredReviewerCount: number; quorum: number; createdByUserId: string; updatedByUserId: string; createdAt: string; updatedAt: string; workspaceId: string; projectId: string | null } | undefined;
const provWorkspace = () => stores.workspaces.get(WS_ID) as { ownerUserId: string };

/** The run, with a non-null Project and a non-default governance context. Shared by all four. */
function seedProvenanceRun() {
  provPanelAtSeed = null;
  seedRun({ projectId: PROJECT_ID, governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
}

/**
 * ─── R6 (R5 BLOCKER) — HOSTILE VALUES COME FROM THE ARTIFACT, NOT FROM CONSTANTS ───────────────
 *
 * The `byUid` rows' hostile values and the distinctness check both read module constants
 * (`PROV_PANEL_CREATED_BY`, `PROV_PANEL_UPDATED_BY`), and nothing asserted those constants matched
 * the seeded document. So editing `seedProvenancePanel` to collapse the panel's actor onto the caller
 * passed the entire suite, and a production re-sourcing of `byUid` to that now-collapsed field then
 * SURVIVED — reopening the exact R4 blocker this section exists to close, from a one-line innocent
 * fixture edit.
 *
 * Every hostile value is now read from a snapshot of the real panel document taken at seed time
 * (before any mutation rewrites `updatedByUserId` or bumps the revision). A collapsed fixture is then
 * caught by the discrimination check itself, because the hostile value really does equal the correct
 * one and the collision is observable.
 */
let provPanelAtSeed: Record<string, unknown> | null = null;
const seededPanel = <T,>(field: string): T => (provPanelAtSeed?.[field] as T);

/** An existing panel whose every actor/number/mirror field differs from the caller's and the run's. */
function seedProvenancePanel(reviewerUserIds: string[]) {
  seedPanel({
    revision: PROV_PANEL_REVISION,
    reviewerUserIds,
    createdByUserId: PROV_PANEL_CREATED_BY,
    updatedByUserId: PROV_PANEL_UPDATED_BY,
    createdAt: PROV_PANEL_CREATED_AT,
    updatedAt: PROV_PANEL_UPDATED_AT,
    workspaceId: STALE_PANEL_WORKSPACE_MIRROR,
    projectId: STALE_PANEL_PROJECT_MIRROR,
  });
  provPanelAtSeed = structuredClone(stores.humanReviewPanel.get(`${RUN_ID}::current`)) as Record<string, unknown>;
}

const GOV_ROWS = (): ProvenanceRow[] => [
  {
    field: "schemaId",
    correctSource: "govParse.record.schemaId",
    correct: () => provRun().governanceRecord.schemaId,
    discriminated: [
      ["the default fixture literal", () => "decision_support"],
      ["govParse.record.answerShape", () => provRun().governanceRecord.answerShape],
    ],
    equivalent: [],
  },
  {
    field: "answerShape",
    correctSource: "govParse.record.answerShape",
    correct: () => provRun().governanceRecord.answerShape,
    discriminated: [
      ["the default fixture literal", () => "decision_support_view"],
      ["govParse.record.schemaId", () => provRun().governanceRecord.schemaId],
    ],
    equivalent: [],
  },
];

/** `workspaceId`/`projectId` rows differ per action only in which panel object is in scope. */
const BINDING_ROWS = (panelMirror: () => { workspaceId: string | undefined; projectId: string | null | undefined }, rejectSiteForEquality: string): ProvenanceRow[] => [
  {
    field: "workspaceId",
    correctSource: "target.workspaceId (the run's stored, authoritative binding)",
    correct: () => provRun().workspaceId,
    discriminated: [["the panel's stale discovery mirror", () => panelMirror().workspaceId]].filter(([, read]) => read() !== undefined) as ProvenanceRow["discriminated"],
    equivalent: [["args.workspaceId", () => WS_ID, `resolveWorkspaceReviewTarget yields wrong_workspace unless run.workspaceId === args.workspaceId, and ${rejectSiteForEquality} returns on any non-valid target`]],
  },
  {
    field: "projectId",
    correctSource: "target.projectId (the run's stored Project)",
    correct: () => provRun().projectId,
    discriminated: ([
      ["the panel's stale discovery mirror", () => panelMirror().projectId],
      ["hardcoded null", () => null],
      ["target.workspaceId", () => provRun().workspaceId],
    ] as ProvenanceRow["discriminated"]).filter(([, read]) => read() !== undefined),
    equivalent: [],
  },
];

const PROVENANCE_SUBJECTS: readonly ProvenanceSubject[] = [
  // ────────────────────────────── CREATE ──────────────────────────────
  {
    action: "adaptive_review_panel_created",
    label: "CREATE",
    canonicalIsCommitted: true,
    seed: () => { seedProvenanceRun(); },
    // A DUPLICATED reviewer in the request, so `args.reviewerUserIds.length` (4) is distinguishable
    // from the normalized roster the panel actually committed (3).
    call: () => putCall({ uid: PROV_CALLER_MANAGE, expectedRevision: 0, reviewerUserIds: [REVIEWER_UID, REVIEWER_UID, REVIEWER2_UID, REVIEWER3_UID] }),
    rows: () => [
      {
        field: "byUid",
        correctSource: "args.uid (the authenticated caller)",
        correct: () => PROV_CALLER_MANAGE,
        discriminated: [
          ["target.creatorUid", () => provRun().userId],
          ["workspace.ownerUserId", () => provWorkspace().ownerUserId],
          ["args.reviewerUserIds[0]", () => REVIEWER_UID],
          ["nextPanel.reviewerUserIds[0]", () => provPanel()?.reviewerUserIds[0]],
        ],
        equivalent: [
          ["nextPanel.createdByUserId", () => provPanel()?.createdByUserId, "buildNextAdaptiveHumanReviewPanel sets `createdByUserId: args.current?.createdByUserId ?? args.actorUserId`, and on a CREATE `current` is null, so it resolves to actorUserId = args.uid. NOTE: create and reconfigure share ONE production line, and the builder PRESERVES createdByUserId on a reconfigure — so re-sourcing this line is in fact KILLED by the RECONFIGURE matrix. A per-action equivalence at a shared site is a statement about that action's values, never a claim that the mutant survives."],
          ["nextPanel.updatedByUserId", () => provPanel()?.updatedByUserId, "buildNextAdaptiveHumanReviewPanel sets updatedByUserId from actorUserId, and the call site passes args.uid"],
          ["auth.membership.uid", () => PROV_CALLER_MANAGE, "validateMembershipBinding rejects a membership whose uid differs from the requested one, and authorization is called with args.uid"],
        ],
      },
      {
        field: "at",
        correctSource: "now (the request's own clock)",
        correct: () => MUTATE_NOW,
        discriminated: [["govParse.record.updatedAt", () => provRun().governanceRecord.updatedAt]],
        equivalent: [
          ["nextPanel.createdAt", () => provPanel()?.createdAt, "buildNextAdaptiveHumanReviewPanel sets createdAt from `now` on a first-time panel"],
          ["nextPanel.updatedAt", () => provPanel()?.updatedAt, "buildNextAdaptiveHumanReviewPanel sets updatedAt from `now`"],
        ],
      },
      ...BINDING_ROWS(() => ({ workspaceId: undefined, projectId: undefined }), "create#reject-06"),
      {
        field: "panelRevision",
        correctSource: "nextPanel.revision (the panel this transaction committed)",
        correct: () => provPanel()?.revision,
        discriminated: [
          ["args.expectedRevision", () => 0],
          ["nextPanel.quorum", () => provPanel()?.quorum],
          ["nextPanel.reviewerUserIds.length", () => provPanel()?.reviewerUserIds.length],
          ["hardcoded 0", () => 0],
        ],
        equivalent: [["args.expectedRevision + 1", () => 1, "buildNextAdaptiveHumanReviewPanel derives revision as (current?.revision ?? 0) + 1, and create#reject-12 rejects any mismatch with args.expectedRevision"]],
      },
      {
        field: "priorPanelRevision",
        correctSource: "current?.revision ?? null (no prior panel on a create)",
        correct: () => null,
        discriminated: [
          ["nextPanel.revision", () => provPanel()?.revision],
          ["hardcoded 0", () => 0],
        ],
        equivalent: [],
      },
      {
        field: "reviewerCount",
        correctSource: "nextPanel.reviewerUserIds.length (the normalized, committed roster)",
        correct: () => provPanel()?.reviewerUserIds.length,
        discriminated: [
          ["args.reviewerUserIds.length (the RAW request, with its duplicate)", () => 4],
          ["nextPanel.quorum", () => provPanel()?.quorum],
          ["nextPanel.revision", () => provPanel()?.revision],
        ],
        equivalent: [["nextPanel.requiredReviewerCount", () => provPanel()?.requiredReviewerCount, "buildNextAdaptiveHumanReviewPanel derives requiredReviewerCount from the same normalized array, and parseAdaptiveHumanReviewPanel rejects any panel where they differ"]],
      },
      ...GOV_ROWS(),
    ],
  },
  // ───────────────────────────── RECONFIGURE ─────────────────────────────
  {
    action: "adaptive_review_panel_reconfigured",
    label: "RECONFIGURE",
    canonicalIsCommitted: true,
    // current roster of FOUR (quorum 3) against a new roster of three (quorum 2), so revision 5,
    // reviewer count and quorum are pairwise distinct on BOTH the old and the new panel
    seed: () => { seedProvenanceRun(); seedProvenancePanel([REVIEWER_UID, REVIEWER2_UID, REVIEWER3_UID, MEMBER_UID]); },
    call: () => putCall({ uid: PROV_CALLER_MANAGE, expectedRevision: PROV_PANEL_REVISION, reviewerUserIds: [OWNER_UID, MEMBER_UID, REVIEWER_UID] }),
    rows: () => [
      {
        field: "byUid",
        correctSource: "args.uid (the authenticated caller)",
        correct: () => PROV_CALLER_MANAGE,
        discriminated: [
          ["current.createdByUserId", () => seededPanel<string>("createdByUserId")],
          ["current.updatedByUserId", () => seededPanel<string>("updatedByUserId")],
          ["target.creatorUid", () => provRun().userId],
          ["workspace.ownerUserId", () => provWorkspace().ownerUserId],
          ["current.reviewerUserIds[0]", () => seededPanel<string[]>("reviewerUserIds")[0]],
        ],
        equivalent: [
          ["nextPanel.updatedByUserId", () => provPanel()?.updatedByUserId, "buildNextAdaptiveHumanReviewPanel sets updatedByUserId from actorUserId, and the call site passes args.uid"],
          ["auth.membership.uid", () => PROV_CALLER_MANAGE, "validateMembershipBinding rejects a uid mismatch, and authorization is called with args.uid"],
        ],
      },
      {
        field: "at",
        correctSource: "now",
        correct: () => MUTATE_NOW,
        discriminated: [
          ["current.createdAt", () => seededPanel<string>("createdAt")],
          ["current.updatedAt", () => seededPanel<string>("updatedAt")],
          ["govParse.record.updatedAt", () => provRun().governanceRecord.updatedAt],
        ],
        equivalent: [["nextPanel.updatedAt", () => provPanel()?.updatedAt, "buildNextAdaptiveHumanReviewPanel sets updatedAt from `now`"]],
      },
      ...BINDING_ROWS(() => ({ workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR }), "create#reject-06"),
      {
        field: "panelRevision",
        correctSource: "nextPanel.revision (the revision this transaction committed)",
        correct: () => provPanel()?.revision,
        discriminated: [
          ["current.revision", () => seededPanel<number>("revision")],
          ["args.expectedRevision", () => PROV_PANEL_REVISION],
          ["nextPanel.quorum", () => provPanel()?.quorum],
          ["nextPanel.reviewerUserIds.length", () => provPanel()?.reviewerUserIds.length],
        ],
        equivalent: [["args.expectedRevision + 1", () => PROV_PANEL_REVISION + 1, "buildNextAdaptiveHumanReviewPanel derives revision as current.revision + 1, and create#reject-12 rejects any mismatch with args.expectedRevision"]],
      },
      {
        field: "priorPanelRevision",
        correctSource: "current.revision (the panel being replaced)",
        correct: () => seededPanel<number>("revision"),
        discriminated: [
          ["nextPanel.revision", () => provPanel()?.revision],
          ["hardcoded null", () => null],
        ],
        equivalent: [["args.expectedRevision", () => PROV_PANEL_REVISION, "create#reject-12 returns stale_revision unless current.revision === args.expectedRevision"]],
      },
      {
        field: "reviewerCount",
        correctSource: "nextPanel.reviewerUserIds.length (the NEW committed roster)",
        correct: () => provPanel()?.reviewerUserIds.length,
        discriminated: [
          ["current.reviewerUserIds.length (the roster being replaced)", () => seededPanel<string[]>("reviewerUserIds").length],
          ["nextPanel.quorum", () => provPanel()?.quorum],
          ["nextPanel.revision", () => provPanel()?.revision],
        ],
        equivalent: [["nextPanel.requiredReviewerCount", () => provPanel()?.requiredReviewerCount, "buildNextAdaptiveHumanReviewPanel derives it from the same normalized array, and parseAdaptiveHumanReviewPanel rejects any panel where they differ"]],
      },
      ...GOV_ROWS(),
    ],
  },
  // ────────────────────────────── CANCEL ──────────────────────────────
  {
    action: "adaptive_review_panel_cancelled",
    label: "CANCEL",
    seed: () => { seedProvenanceRun(); seedProvenancePanel([OWNER_UID, REVIEWER_UID, REVIEWER2_UID]); },
    call: () => deleteCall({ uid: PROV_CALLER_MANAGE, expectedRevision: PROV_PANEL_REVISION }),
    rows: () => [
      {
        field: "byUid",
        correctSource: "args.uid (the authenticated caller)",
        correct: () => PROV_CALLER_MANAGE,
        discriminated: [
          ["current.createdByUserId", () => seededPanel<string>("createdByUserId")],
          ["current.updatedByUserId", () => seededPanel<string>("updatedByUserId")],
          ["target.creatorUid", () => provRun().userId],
          ["current.reviewerUserIds[0]", () => seededPanel<string[]>("reviewerUserIds")[0]],
          ["workspace.ownerUserId", () => provWorkspace().ownerUserId],
        ],
        equivalent: [["auth.membership.uid", () => PROV_CALLER_MANAGE, "validateMembershipBinding rejects a uid mismatch, and authorization is called with args.uid"]],
      },
      {
        field: "at",
        correctSource: "now",
        correct: () => MUTATE_NOW,
        discriminated: [
          ["current.createdAt", () => seededPanel<string>("createdAt")],
          ["current.updatedAt", () => seededPanel<string>("updatedAt")],
          ["govParse.record.updatedAt", () => provRun().governanceRecord.updatedAt],
        ],
        // R5 MINOR — `nextPanel` is in scope at the cancel event site, so its fields are reachable
        // sources and belong in this enumeration rather than being caught only incidentally.
        equivalent: [["nextPanel.updatedAt", () => MUTATE_NOW, "buildCancelledAdaptiveHumanReviewPanel sets updatedAt from the same `now` the event uses"]],
      },
      ...BINDING_ROWS(() => ({ workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR }), "cancel#reject-06"),
      {
        field: "panelRevision",
        correctSource: "current.revision (the canonical panel being cancelled)",
        correct: () => seededPanel<number>("revision"),
        discriminated: [
          ["current.quorum", () => seededPanel<number>("quorum")],
          ["current.reviewerUserIds.length", () => seededPanel<string[]>("reviewerUserIds").length],
          ["current.requiredReviewerCount", () => seededPanel<number>("requiredReviewerCount")],
          ["nextPanel.revision (the CANCELLED panel this transaction commits, which is current + 1)", () => seededPanel<number>("revision") + 1],
          ["hardcoded 0", () => 0],
        ],
        equivalent: [["args.expectedRevision", () => seededPanel<number>("revision"), "cancel#reject-12 returns stale_revision unless current.revision === args.expectedRevision"]],
      },
      {
        field: "reviewerCount",
        correctSource: "current.reviewerUserIds.length (the canonical roster)",
        correct: () => seededPanel<string[]>("reviewerUserIds").length,
        discriminated: [
          ["current.quorum", () => seededPanel<number>("quorum")],
          ["current.revision", () => seededPanel<number>("revision")],
          ["hardcoded 0", () => 0],
        ],
        equivalent: [
          ["current.requiredReviewerCount", () => seededPanel<number>("requiredReviewerCount"), "parseAdaptiveHumanReviewPanel yields malformed unless requiredReviewerCount === reviewerUserIds.length, and cancel#reject-09 returns panel_unreadable on a malformed panel"],
          ["nextPanel.reviewerUserIds.length", () => seededPanel<string[]>("reviewerUserIds").length, "buildCancelledAdaptiveHumanReviewPanel preserves the roster verbatim, so the cancelled panel's length equals the current one's"],
        ],
      },
      ...GOV_ROWS(),
    ],
  },
  // ─────────────────────────────── VOTE ───────────────────────────────
  {
    action: "adaptive_review_panel_vote_cast",
    label: "VOTE",
    seed: () => { seedProvenanceRun(); seedProvenancePanel([REVIEWER_UID, REVIEWER2_UID, PROV_CALLER_VOTE]); },
    // FOUR conditions, so conditionsCount (4) is distinct from the revision (5), the roster (3) and the quorum (2)
    call: () => voteCall({ uid: PROV_CALLER_VOTE, panelRevision: PROV_PANEL_REVISION, status: "changes_requested", comment: "needs work", conditions: ["c1", "c2", "c3", "c4"] }),
    rows: () => [
      {
        field: "byUid",
        correctSource: "args.uid (the authenticated voter)",
        correct: () => PROV_CALLER_VOTE,
        discriminated: [
          ["panel.createdByUserId", () => seededPanel<string>("createdByUserId")],
          ["panel.updatedByUserId", () => seededPanel<string>("updatedByUserId")],
          ["target.creatorUid", () => provRun().userId],
          ["panel.reviewerUserIds[0]", () => seededPanel<string[]>("reviewerUserIds")[0]],
          ["workspace.ownerUserId", () => provWorkspace().ownerUserId],
        ],
        equivalent: [
          ["nextVote.reviewerUserId", () => PROV_CALLER_VOTE, "buildAdaptiveHumanReviewVote sets reviewerUserId from its reviewerUserId argument, and the call site passes args.uid"],
          ["auth.membership.uid", () => PROV_CALLER_VOTE, "validateMembershipBinding rejects a uid mismatch, and authorization is called with args.uid"],
        ],
      },
      {
        field: "at",
        correctSource: "now",
        correct: () => MUTATE_NOW,
        discriminated: [
          ["panel.createdAt", () => seededPanel<string>("createdAt")],
          ["panel.updatedAt", () => seededPanel<string>("updatedAt")],
          ["govParse.record.updatedAt", () => provRun().governanceRecord.updatedAt],
        ],
        equivalent: [["nextVote.submittedAt", () => MUTATE_NOW, "buildAdaptiveHumanReviewVote sets submittedAt from `now`"]],
      },
      ...BINDING_ROWS(() => ({ workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR }), "vote#reject-05"),
      {
        field: "panelRevision",
        correctSource: "panel.revision (the panel the vote was accepted ON)",
        correct: () => seededPanel<number>("revision"),
        discriminated: [
          ["panel.quorum", () => seededPanel<number>("quorum")],
          ["panel.reviewerUserIds.length", () => seededPanel<string[]>("reviewerUserIds").length],
          ["hardcoded 0", () => 0],
        ],
        equivalent: [
          ["args.panelRevision", () => PROV_PANEL_REVISION, "vote#reject-10 returns panel_stale unless panel.revision === args.panelRevision"],
          ["nextVote.panelRevision", () => PROV_PANEL_REVISION, "buildAdaptiveHumanReviewVote sets panelRevision from args.panelRevision, which vote#reject-10 has already proved equal"],
        ],
      },
      {
        field: "voteStatus",
        correctSource: "nextVote.status",
        correct: () => "changes_requested",
        discriminated: [["hardcoded approved", () => "approved"]],
        equivalent: [["args.status", () => "changes_requested", "§47 — buildAdaptiveHumanReviewVote sets `status` as a pure projection of args.status: no validation, normalisation or defaulting, so the two expressions cannot differ. Classified equivalent rather than presented as canonical provenance."]],
      },
      {
        field: "commentPresent",
        correctSource: "nextVote.commentPresent",
        correct: () => true,
        discriminated: [["hardcoded false", () => false]],
        equivalent: [["args.comment !== undefined", () => true, "§41/§42 — equivalent under the SHIPPED CALL CONTRACT: the sole production caller passes `comment` through validateAdaptiveReviewCommentAndConditions, which maps an empty or whitespace-only string to `undefined` ('An empty string becomes absent, not an empty comment'), so Boolean(args.comment) and args.comment !== undefined agree for every value that can reach this module. See the call-site regression below."]],
      },
      {
        field: "conditionsCount",
        correctSource: "nextVote.conditionsCount",
        correct: () => 4,
        discriminated: [
          ["panel.reviewerUserIds.length", () => seededPanel<string[]>("reviewerUserIds").length],
          ["panel.quorum", () => seededPanel<number>("quorum")],
          ["hardcoded 0", () => 0],
        ],
        equivalent: [["args.conditions?.length ?? 0", () => 4, "§47 — buildAdaptiveHumanReviewVote computes `conditionsCount` as literally that expression: a pure projection of the request, not a normalisation, so the two cannot differ."]],
      },
      ...GOV_ROWS(),
    ],
  },
];

describe.each(PROVENANCE_SUBJECTS.map((s) => [s.label, s] as const))("panel mutation audit coverage — %s event provenance", (label, subject) => {
  /**
   * §40 — every value is snapshotted BEFORE the call. The mutations rewrite the panel document
   * (`updatedByUserId` becomes the caller, the revision is bumped), so reading the store afterwards
   * turns hostile sources into the correct value and silently un-discriminates the fixture. An
   * earlier draft of the cancel matrix did exactly that and failed honestly on `byUid`.
   */
  const snapshotRows = (rows: readonly ProvenanceRow[]) =>
    rows.map((row) => Object.freeze({
      field: row.field,
      correct: row.correct(),
      discriminated: row.discriminated.map(([name, read]) => Object.freeze([name, read()] as const)),
    }));

  it("the fixture DISCRIMINATES: every field's correct source differs from every plausible wrong source — asserted before the production call", async () => {
    subject.seed();
    // for CREATE the canonical values only exist after the call, so discrimination is checked on the
    // post-call snapshot for that action; for the others the panel already exists beforehand.
    if (subject.canonicalIsCommitted) expect((await subject.call()).ok).toBe(true);
    const collisions = subject.rows().flatMap((row) => row.discriminated.filter(([, read]) => read() === row.correct()).map(([name]) => `${row.field}<-${name}`));
    expect(`${label}:indistinguishableSources:${collisions.join(",")}`).toBe(`${label}:indistinguishableSources:`);
  });

  it("the de-collapsed identity set really is distinct", () => {
    subject.seed();
    const identities = {
      manageCaller: PROV_CALLER_MANAGE,
      voteCaller: PROV_CALLER_VOTE,
      workspaceOwner: provWorkspace().ownerUserId,
      runCreator: provRun().userId,
      panelCreatedBy: provPanelAtSeed ? seededPanel<string>("createdByUserId") : PROV_PANEL_CREATED_BY,
      panelUpdatedBy: provPanelAtSeed ? seededPanel<string>("updatedByUserId") : PROV_PANEL_UPDATED_BY,
    };
    expect(new Set(Object.values(identities)).size).toBe(Object.keys(identities).length);
    expect(`runWorkspace:${provRun().workspaceId} runProject:${provRun().projectId} govSchema:${provRun().governanceRecord.schemaId}`).toBe(`runWorkspace:${WS_ID} runProject:${PROJECT_ID} govSchema:${ALT_GOV.schemaId}`);
    if (provPanelAtSeed) {
      // R5 MAJOR — the previous version built its expected side from the SAME reads it checked, via
      // `"revision:5 reviewers:2 quorum:2".replace(...)`, so only `revision` was pinned and a
      // reviewers/quorum collapse went undetected by the test named for the property.
      const revision = seededPanel<number>("revision");
      const reviewers = seededPanel<string[]>("reviewerUserIds").length;
      const quorum = seededPanel<number>("quorum");
      expect(`seededRevision:${revision}`).toBe(`seededRevision:${PROV_PANEL_REVISION}`);
      expect(`revisionReviewersQuorumPairwiseDistinct:${new Set([revision, reviewers, quorum]).size}`).toBe("revisionReviewersQuorumPairwiseDistinct:3");
      expect(`mirrorIsStale:${seededPanel<string>("workspaceId") !== provRun().workspaceId && seededPanel<string | null>("projectId") !== provRun().projectId}`).toBe("mirrorIsStale:true");
      expect(`seededActorsDifferFromBothCallers:${![PROV_CALLER_MANAGE, PROV_CALLER_VOTE].includes(seededPanel<string>("createdByUserId")) && ![PROV_CALLER_MANAGE, PROV_CALLER_VOTE].includes(seededPanel<string>("updatedByUserId"))}`).toBe("seededActorsDifferFromBothCallers:true");
    }
  });

  it("every source classified EQUIVALENT really is equal, and names the reason it cannot differ", async () => {
    subject.seed();
    if (subject.canonicalIsCommitted) expect((await subject.call()).ok).toBe(true);
    const rows = subject.rows().flatMap((row) => row.equivalent.map(([name, read, reason]) => ({ field: row.field, name, equal: read() === row.correct(), reason })));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.equal).map((r) => `${r.field}<-${r.name}`)).toEqual([]);
    // R5 NIT — a prose-length assertion polices nothing; what matters is that the reason NAMES the
    // mechanism that forces the equality, so it must cite a guard site, a parser, or a builder.
    const citesAMechanism = (reason: string) => /#reject-|parse[A-Z]|build[A-Z]|validate[A-Z]|§4[12]/.test(reason);
    expect(rows.filter((r) => !citesAMechanism(r.reason)).map((r) => `${r.field}<-${r.name}`)).toEqual([]);
  });

  it("the event's EVERY authority-bearing field equals its canonical source and no wrong source", async () => {
    subject.seed();
    const preCall = subject.canonicalIsCommitted ? null : snapshotRows(subject.rows());
    expect((await subject.call()).ok).toBe(true);
    const sole = soleCommittedGovernanceEvent();
    expect(`${label}:action:${sole.action} path:${sole.path}`).toBe(`${label}:action:${subject.action} path:runs/${RUN_ID}/governanceEvents/auto-1`);
    expectNoForeignPersistenceWriters();
    const event = sole.payload;
    for (const row of preCall ?? snapshotRows(subject.rows())) {
      expect(`${label}:${row.field}:${JSON.stringify(event[row.field])}`).toBe(`${label}:${row.field}:${JSON.stringify(row.correct)}`);
      for (const [name, wrongValue] of row.discriminated) {
        expect(`${label}:${row.field}!=${name}:${JSON.stringify(event[row.field]) === JSON.stringify(wrongValue)}`).toBe(`${label}:${row.field}!=${name}:false`);
      }
    }
  });

  it("the matrix is COMPLETE: the event has no field outside it, so a newly added field cannot escape the audit", async () => {
    subject.seed();
    expect((await subject.call()).ok).toBe(true);
    expect(Object.keys(soleCommittedGovernanceEvent().payload).sort()).toEqual(["action", ...subject.rows().map((r) => r.field)].sort());
  });
});

/**
 * §41/§42 — THE commentPresent CALL-SITE CONTRACT, proved rather than assumed.
 *
 * R4 found that re-sourcing `commentPresent` from `args.comment !== undefined` survives, because
 * `submitWorkspaceReviewPanelVote` itself performs no comment validation: for `comment: ""` the
 * builder's `Boolean("")` is `false` while `"" !== undefined` is `true`.
 *
 * Production was NOT changed, because the mutant is unreachable through every shipped caller.
 * `submitWorkspaceReviewPanelVote` has exactly ONE production call site — the vote route — which
 * passes only the output of `parseSubmitAdaptiveReviewVoteRequest`, and that delegates to
 * `validateAdaptiveReviewCommentAndConditions`, whose own comment says "An empty string becomes
 * absent, not an empty comment" and which returns `comment = trimmed.length > 0 ? trimmed :
 * undefined`. So an empty or whitespace-only comment can never arrive as `""`.
 *
 * The regression below pins that boundary property directly, so the equivalence classification
 * rests on an asserted contract rather than on a reading of the code. If the validator ever stopped
 * collapsing empty to absent, this fails and the classification must be revisited — at which point
 * the correct fix is production, not the test.
 */
describe("commentPresent — the shipped call-site contract that makes the alternative equivalent", () => {
  it("the request validator collapses an empty or whitespace-only comment to ABSENT, so `\"\"` cannot reach the module", () => {
    for (const raw of ["", "   ", "\t\n "]) {
      const parsed = parseSubmitAdaptiveReviewVoteRequest({ status: "approved", panelRevision: 1, comment: raw });
      expect(`parsed:${parsed.ok}`).toBe("parsed:true");
      if (parsed.ok) expect(`comment:${JSON.stringify(parsed.value.comment)}`).toBe("comment:undefined");
    }
  });

  it("a non-empty comment survives, trimmed — so the two predicates agree on every reachable value", () => {
    const parsed = parseSubmitAdaptiveReviewVoteRequest({ status: "approved", panelRevision: 1, comment: "  looks fine  " });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.comment).toBe("looks fine");
      expect(`boolean:${Boolean(parsed.value.comment)} notUndefined:${parsed.value.comment !== undefined}`).toBe("boolean:true notUndefined:true");
    }
  });

  it("and with the comment omitted entirely both predicates are false", () => {
    const parsed = parseSubmitAdaptiveReviewVoteRequest({ status: "approved", panelRevision: 1 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(`boolean:${Boolean(parsed.value.comment)} notUndefined:${parsed.value.comment !== undefined}`).toBe("boolean:false notUndefined:false");
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
  /**
   * R5 MINOR — the matrix had an EVENT-write failure case for create/cancel/vote but a
   * CANONICAL-write failure case only for create and vote. Reconfigure shares create's code path and
   * cancel's canonical write precedes its event write, so both were arguably equivalent — but that
   * was an argument, not a test, so both are now asserted.
   */
  it("a CANONICAL-write failure leaves no event on RECONFIGURE", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "humanReviewPanel";
    expect(await putCall({ expectedRevision: 1 })).toEqual({ ok: false, reason: "write_failed" });
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { revision: number }).revision).toBe(1);
    expect(committedGovernanceEvents()).toHaveLength(0);
  });

  it("a CANONICAL-write failure leaves no event on CANCEL — the panel stays open", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "humanReviewPanel";
    expect(await deleteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { status: string }).status).toBe("open");
    expect(committedGovernanceEvents()).toHaveLength(0);
  });

  it("an EVENT-write failure rolls back the panel CREATE", async () => {
    throwOnSetCollection.value = "governanceEvents";
    expect(await putCall()).toEqual({ ok: false, reason: "write_failed" });
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
    expect(committedGovernanceEvents()).toHaveLength(0);
  });

  it("a CANONICAL-write failure leaves no event on CREATE", async () => {
    throwOnSetCollection.value = "humanReviewPanel";
    expect(await putCall()).toEqual({ ok: false, reason: "write_failed" });
    expect(committedGovernanceEvents()).toHaveLength(0);
  });

  it("an EVENT-write failure rolls back the CANCEL — the panel stays open", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "governanceEvents";
    expect(await deleteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { status: string }).status).toBe("open");
    expect(committedGovernanceEvents()).toHaveLength(0);
  });

  it("an EVENT-write failure rolls back the VOTE — no vote is committed", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "governanceEvents";
    expect(await voteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect([...stores.humanReviewVotes.keys()].filter((k) => k.startsWith(`${RUN_ID}::`))).toHaveLength(0);
    expect(committedGovernanceEvents()).toHaveLength(0);
  });

  it("a CANONICAL-write failure leaves no event on VOTE", async () => {
    seedPanel({ revision: 1 });
    throwOnSetCollection.value = "humanReviewVotes";
    expect(await voteCall()).toEqual({ ok: false, reason: "write_failed" });
    expect(committedGovernanceEvents()).toHaveLength(0);
  });
});

/**
 * ─── R5 §29–§31 — THE RECONCILIATION IS AN UNCONDITIONAL POSTCONDITION ────────────────────────
 *
 * R4 MINOR, and a real one: the reconciliation lived in an `it(...)`, so
 *
 *     npx jest <this file> -t "rejects with its own reason"
 *
 * ran all of the rejection cases, FILTERED OUT the reconciliation, and exited 0 — a partial
 * configuration reporting a clean result. The in-describe `it` remains (it gives a precise failure
 * message), but the binding check is this top-level `afterAll`: it is registered at module scope, so
 * no `describe` selection and no `-t` pattern can remove it, and it runs whenever this file is
 * loaded.
 *
 * §30 — INTENDED PARTIAL-RUN BEHAVIOUR, stated precisely. Any filtered invocation that runs at least
 * one test in this file but not the whole rejection matrix FAILS here. That is deliberate and
 * fail-closed.
 *
 * ONE EXCEPTION, corrected from an earlier overstatement: a `-t` pattern matching ZERO tests exits 0,
 * because Jest skips the file entirely and never runs a module-scope `afterAll`. That is outside this
 * hook's reach and cannot be closed from here. It is also not mistakable for coverage — such a run
 * reports `0 passed` — but the earlier claim that "including one that executes no rejection case at
 * all" fails was simply wrong.
 *
 * A `-t` run of this security suite is a debugging aid and is NOT evidence of rejection coverage;
 * only a full run of the file is. CI runs the file in full.
 */
/**
 * R8 §19 — unconditional. A harness violation recorded by ANY test fails that test, whether or not
 * it happens to call `expectStoreDelta`. Without this the fail-closed surface would only bind where
 * someone remembered to assert it.
 */
afterEach(() => {
  expect(`unsupportedWriteApiUsed:${[...new Set(harnessViolations)].join(",")}`).toBe("unsupportedWriteApiUsed:");
});

afterAll(() => {
  const executed = [...executedObligations];
  const expected = [...EXECUTABLE_OBLIGATIONS];
  const executedSet = new Set(executed);
  const expectedSet = new Set(expected);
  const missing = expected.filter((o) => !executedSet.has(o)).sort();
  const unexpected = executed.filter((o) => !expectedSet.has(o)).sort();
  const duplicates = executed.length - executedSet.size;

  // passthrough coverage, per site, against the union PRODUCTION declares
  const passthroughSites = DECISION_SITES.filter((s) => s.isPassthrough).map((s) => s.siteId);
  const passthroughGaps = passthroughSites.flatMap((siteId) => {
    const covered = new Set(executed.filter((o) => o.startsWith(`${siteId}::`)).map((o) => o.slice(siteId.length + 2)));
    return AUTH_DENIAL_REASONS_FROM_SOURCE.filter((reason) => !covered.has(reason)).map((reason) => `${siteId}::${reason}`);
  }).sort();

  expect(
    [
      `registeredCases:${REJECTION_CASES.length}`,
      `executedObligations:${executed.length}`,
      `expectedObligations:${expected.length}`,
      `missing:${missing.join(",")}`,
      `unexpected:${unexpected.join(",")}`,
      `duplicates:${duplicates}`,
      `passthroughGaps:${passthroughGaps.join(",")}`,
      `witnessedSites:${Object.keys(SITE_WITNESSES).length}`,
      `reconciliationExecuted:${reconciliationExecuted}`,
    ].join(" ")
  ).toBe(
    [
      "registeredCases:59",
      "executedObligations:59",
      "expectedObligations:59",
      "missing:",
      "unexpected:",
      "duplicates:0",
      "passthroughGaps:",
      "witnessedSites:15",
      "reconciliationExecuted:true",
    ].join(" ")
  );
});
