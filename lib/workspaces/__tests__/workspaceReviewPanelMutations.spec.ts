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
import { readFileSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
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
// R8 §38 — the witnesses invoke the REAL authorization mechanism and the REAL eligibility predicate
// against the seeded stores, rather than asserting a fact about a mock.
import { authorizeTeamWorkspaceMutationInTransaction } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { isValidAssignmentTarget } from "@/lib/workspaces/workspaceReviewEligibility";

type StoredDoc = Record<string, unknown>;
/**
 * R10 (A's F5) — a NULL-PROTOTYPE object. As a plain literal, `storeFor("__proto__")` returned
 * `Object.prototype`: the escape failed closed only by accident (a `TypeError` on
 * `Object.prototype.set` aborted the transaction) and such a collection was invisible to
 * `snapshotStore`'s `Object.entries(stores)`. With a null prototype there is no inherited property to
 * return, so a prototype-named collection is an ordinary lazily-created store the diff can see.
 */
const stores: Record<string, Map<string, StoredDoc>> = Object.assign(Object.create(null) as Record<string, Map<string, StoredDoc>>, {
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
});

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
  for (const name of lazilyCreatedCollections) delete stores[name];
  lazilyCreatedCollections.clear();
  autoIdCounter = 0;
  governanceEventLog.length = 0;
  disabledEventObservers.clear();
  // R9 §21 — the harness-integrity ledger is deliberately NOT cleared here. See below.
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
/**
 * ─── R9 §21–§24 — THE VIOLATION LEDGER IS APPEND-ONLY, AND FIXTURE RESET CANNOT ERASE IT ──────
 *
 * R8 MAJOR: `resetStores()` ended with `harnessViolations.length = 0`, and `seedBaseFixture()` calls
 * `resetStores()`. So a test that provoked an unsupported-write violation and then reseeded — the
 * single most ordinary thing a test does — destroyed the evidence before the postcondition ran. The
 * "unconditional" fail-closed guarantee was conditional on nobody reseeding, which every multi-phase
 * test does.
 *
 * The ledger is now strictly APPEND-ONLY. Nothing truncates it, so no reset path can shorten it.
 * Instead of clearing, a self-test of the fail-closed machinery ACKNOWLEDGES the specific violations
 * it provoked, by substring match, and acknowledgement only ever marks an EXISTING index as expected.
 * Two properties follow, and both are what §22 asks for:
 *   • a violation raised AFTER an acknowledgement is still pending, because indexes are marked, not
 *     truncated — so acknowledgement cannot pre-authorise a future escape;
 *   • a violation the self-test did not name stays pending even in the very test that acknowledges,
 *     because only matching entries are marked — so there is no catch-all drain.
 * The `afterEach` postcondition reads `pendingHarnessViolations()`, never the raw array.
 */
const harnessViolations: string[] = [];
const acknowledgedViolationIndexes = new Set<number>();
function recordHarnessViolation(what: string): void {
  harnessViolations.push(what);
}
/** The ledger's length, for the append-only regression. Read-only by construction. */
function harnessLedgerLength(): number {
  return harnessViolations.length;
}
/** Every recorded violation no self-test has explicitly claimed. The postcondition's only input. */
function pendingHarnessViolations(): string[] {
  return harnessViolations.filter((_, index) => !acknowledgedViolationIndexes.has(index));
}
/**
 * Claims the violations a fail-closed self-test deliberately provoked. Returns exactly what it
 * claimed, so the caller can assert on the content rather than trust the count. Entries matching no
 * expected substring are left pending on purpose.
 */
function acknowledgeExpectedViolations(expected: readonly string[]): string[] {
  /**
   * R10 — A CATCH-ALL IS NOT AN ACKNOWLEDGEMENT.
   *
   * R9 matched by `violation.includes(substring)`, so `[""]` matched everything. Placed at the head of
   * the module-scope `afterEach`, one line disabled the "unconditional" fail-closed postcondition
   * entirely: a swallowed unmodelled-API call in a test that never calls `expectStoreDelta` failed the
   * suite alone and passed with the drain. An acknowledgement must NAME what it is claiming, so a
   * substring that could match an unrelated future violation is rejected outright rather than honoured.
   */
  const pending = pendingHarnessViolations();
  for (const substring of expected) {
    // (a) it must LOOK like a label, not a wildcard
    if (substring.trim().length < 8 || !/[.:]/.test(substring)) {
      throw new Error(`R10 harness: "${substring}" is too weak to be an acknowledgement — name the violation (>= 8 chars, qualified with "." or ":"), never a catch-all`);
    }
    // (b) and it must be SPECIFIC: a substring that sweeps up more than one distinct pending label is a
    // drain wearing a label's clothes. This is the breadth limit, and it is what `[""]` really violated.
    const matched = new Set(pending.filter((violation) => violation.includes(substring)));
    if (matched.size > 1) {
      throw new Error(`R10 harness: "${substring}" matches ${matched.size} distinct pending violations (${[...matched].join(" | ")}) — acknowledge each by name`);
    }
  }
  const claimed: string[] = [];
  harnessViolations.forEach((violation, index) => {
    if (acknowledgedViolationIndexes.has(index)) return;
    if (expected.some((substring) => violation.includes(substring))) {
      acknowledgedViolationIndexes.add(index);
      claimed.push(violation);
    }
  });
  return claimed;
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
  // R9 §19/§20 — every delete-capable channel. R8 left all five delete SITES (top-level and
  // sub-collection `DocumentReference.delete`, `Transaction.delete`, `WriteBatch.delete`,
  // `BulkWriter.delete`) recording nothing at all, so a write-then-delete inside one transaction
  // was invisible to every log-based assertion. The store always saw the removal; the log did not.
  | "direct.delete"
  | "transaction.delete"
  | "batch.delete"
  | "bulkwriter.delete"
  | "writer.panelFinalizationGovernanceEvent"
  | "writer.panelOverrideGovernanceEvent"
  | "writer.adaptiveHumanReviewEvent";

type GovernanceEventObservation = {
  channel: GovernanceEventChannel;
  mode: "transaction" | "direct-writer";
  /** R9 §19 — a removal is an observation in its own right, not the absence of one. */
  op: "write" | "delete";
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
  classifiedBy: "governanceEvents-collection" | "audit-shaped-payload" | "audit-shaped-stored-doc";
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
 * The committed test "no CANONICAL write in the audited module is audit-shaped, so payload-shape
 * classification has no false positives" pins that precondition rather than assuming it. (R7 found
 * this comment previously cited `assertNoCanonicalWriteIsAuditShaped`, an identifier that exists
 * nowhere — the test was real, the citation was not.)
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
    op: "write",
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
  expect(`${label}:unsupportedWriteApiUsed:${[...new Set(pendingHarnessViolations())].join(",")}`).toBe(`${label}:unsupportedWriteApiUsed:`);
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

/**
 * ─── R9 §3/§6/§11 — ONE SECURITY AUTHORITY, AND NO WAY TO REACH THE EVENT WITHOUT IT ───────────
 *
 * R8 shipped the final-store oracle and then used it in SIX tests. Everything else — provenance,
 * Project binding, governance context, actor authority, 7 of 8 atomicity assertions, 2 of 3 retry
 * assertions — still concluded from `governanceEventLog`, so the write-then-delete escape that
 * blocker A found was invisible to almost the whole suite. Adding the oracle without removing the
 * old authority bought nothing; the accessors that made the old authority reachable are gone.
 *
 * This is now the ONLY route by which a security assertion obtains an audited event: run the
 * operation, prove its complete durable delta, and read the document the store holds. Cardinality
 * and payload therefore come from one artifact, and an event that is written and then deleted inside
 * the transaction has no payload to read.
 */
type AuditedSuccess = { event: Record<string, unknown>; path: string; delta: StoreDelta };

const PANEL_DOC_PATH = () => `runs/${RUN_ID}/humanReviewPanel/current`;
const VOTE_DOC_PATH = (uid: string, revision: number) => `runs/${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(revision, uid)}`;
const CREATE_DELTA = () => ({ added: [PANEL_DOC_PATH()] });
const RECONFIGURE_DELTA = () => ({ modified: [PANEL_DOC_PATH()] });
const CANCEL_DELTA = () => ({ modified: [PANEL_DOC_PATH()] });
const VOTE_DELTA = (uid: string = OWNER_UID, revision: number = 1) => ({ added: [VOTE_DOC_PATH(uid, revision)] });

async function auditedSuccess(
  label: string,
  expected: Omit<ExpectedDelta, "oneAddedUnder">,
  call: () => Promise<{ ok: boolean }>
): Promise<AuditedSuccess> {
  const before = snapshotStore();
  const result = await call();
  expect(`${label}:ok:${result.ok}`).toBe(`${label}:ok:true`);
  const delta = expectStoreDelta(label, before, { ...expected, oneAddedUnder: eventParentPath(RUN_ID) });
  expectNoForeignPersistenceWriters();
  const sole = soleStoredPanelEvent(delta, eventParentPath(RUN_ID));
  return { event: sole.payload, path: sole.path, delta };
}

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
    op: "write",
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

/**
 * R9 §19/§20 — a delete through ANY channel is observed, classified by the collection it targets or by
 * the shape of the document it is about to remove. The store mutation was already visible to the
 * final-state diff; this makes the channel itself falsifiable, so "this fake models `X.delete`" is a
 * claim a disable-one-channel control can break rather than an assertion about unreached code.
 */
function recordFirestoreDelete(
  channel: GovernanceEventChannel,
  mode: "transaction" | "direct-writer",
  ref: { __collection: string; __id: string; __path: string }
): GovernanceEventObservation | null {
  const existing = stores[ref.__collection]?.get(ref.__id);
  const byCollection = ref.__collection === GOVERNANCE_EVENT_COLLECTION;
  if (!byCollection && !isAuditShapedPayload(existing)) return null;
  const observation: GovernanceEventObservation = {
    channel,
    mode,
    op: "delete",
    path: ref.__path,
    collection: ref.__collection,
    storeKey: ref.__id,
    action: (existing as { action?: unknown } | undefined)?.action,
    actor: (existing as { byUid?: unknown } | undefined)?.byUid,
    payload: existing ? snapshotPayload(existing as Record<string, unknown>) : {},
    committed: false,
    classifiedBy: byCollection ? "governanceEvents-collection" : "audit-shaped-stored-doc",
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
 * audit writes (`try { await write } catch { logger.warn(...) }`) swallowed it. `.add()` is in fact
 * used at FIVE [[count:addSites=5]] `.collection("governanceEvents").add(` sites in this repo: two in
 * `lib/firestore/runs.ts`, one in `lib/governance/governanceBackfill.ts`, one in
 * `lib/governance/evaluateAndStore.ts`, and one in `app/api/governance/review/route.ts`.
 *
 * R9 §60 — this count has now been wrong twice (see RETRACTED_PHRASES entry 5, then "FOUR", which missed
 * the `app/` route because the search was scoped to `lib/`). It is no longer a
 * prose number: `countGovernanceEventAddSites()` walks the repository and the test below pins it, so a
 * sixth site fails the suite instead of quietly outdating a comment.
 * Modelling more methods can never be future-complete, so R8 pairs the fuller surface with the
 * fail-closed guard below: an unmodelled write API records a violation even when the sentinel is
 * swallowed.
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
      const o = recordFirestoreDelete("direct.delete", "direct-writer", getRef());
      storeFor(collectionName).delete(key);
      if (o) o.committed = true;
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

/**
 * ─── R9 §25–§27 — ATOMICITY EXECUTION EVIDENCE IS OWNED BY THE FAKE, NOT BY THE TEST BODY ──────
 *
 * R8 MAJOR: the atomicity suite's own census proved coverage by reading TEST TITLES and counting
 * `throwOnSetCollection.value = "` occurrences in its own source. Both survive a body that has been
 * emptied: the title still exists, and the count is of source text, not of execution. A hollowed case
 * passed, and the census still said the direction was covered.
 *
 * The fake now records, for each armed injection, whether the target write was REACHED and whether
 * the modelled failure FIRED. That telemetry is written inside the transaction implementation, so no
 * test body can produce it without actually driving production into the injected write. The required
 * matrix is reconciled against these records in an unconditional postcondition.
 */
type InjectionSiteId = "canonical-panel" | "canonical-vote" | "event";
const INJECTION_TARGET_COLLECTION: Readonly<Record<InjectionSiteId, string>> = Object.freeze({
  "canonical-panel": "humanReviewPanel",
  "canonical-vote": "humanReviewVotes",
  event: "governanceEvents",
});
type ArmedInjection = { caseId: string; siteId: InjectionSiteId; targetCollection: string; reached: boolean; fired: boolean };
let armedInjection: ArmedInjection | null = null;

function armWriteFailureInjection(caseId: string, siteId: InjectionSiteId): void {
  if (armedInjection) recordHarnessViolation(`atomicity:injection-already-armed:${armedInjection.caseId}`);
  armedInjection = { caseId, siteId, targetCollection: INJECTION_TARGET_COLLECTION[siteId], reached: false, fired: false };
  throwOnSetCollection.value = armedInjection.targetCollection;
}

/**
 * ─── R10 — THE INJECTION JOURNAL IS FAKE-OWNED AND APPEND-ONLY ──────────────────────────────────
 *
 * R9 said "`runAtomicityCase` is the only way a case is registered". It was not: `atomicityResults` is
 * a module-scope Map and any test body can `.set()` into it. A hand-written result claiming
 * `reached/fired: true` with an empty delta passed the whole reconciliation while production was never
 * driven for that direction. Same shape as every other defect this series produced — a guard whose
 * INPUT is controlled by the thing being guarded.
 *
 * The journal below is written ONLY here, inside the injection machinery, at the moment the fake
 * disarms. A test body cannot append to it, cannot alter an entry (each is frozen), and cannot shorten
 * it. The reconciliation cross-checks `atomicityResults` against the journal, so a fabricated result
 * has no journal counterpart and is named.
 */
type InjectionJournalEntry = Readonly<{ caseId: string; siteId: InjectionSiteId; targetCollection: string; reached: boolean; fired: boolean; sequence: number }>;
const injectionJournal: InjectionJournalEntry[] = [];
let injectionSequence = 0;
/** Read-only view. There is deliberately no writer other than `disarmWriteFailureInjection`. */
const injectionJournalEntries = (): readonly InjectionJournalEntry[] => injectionJournal.slice();

function disarmWriteFailureInjection(): ArmedInjection {
  if (!armedInjection) throw new Error("R9 harness: disarm called with no armed injection");
  const state = armedInjection;
  armedInjection = null;
  throwOnSetCollection.value = null;
  injectionJournal.push(Object.freeze({
    caseId: state.caseId,
    siteId: state.siteId,
    targetCollection: state.targetCollection,
    reached: state.reached,
    fired: state.fired,
    sequence: ++injectionSequence,
  }));
  return state;
}
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
      delete: (ref: { __collection: string; __id: string; __path: string }) => {
        const observation = recordFirestoreDelete("batch.delete", "direct-writer", ref);
        queued.push(() => {
          storeFor(ref.__collection).delete(ref.__id);
          if (observation) observation.committed = true;
        });
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
    delete: async (ref: { __collection: string; __id: string; __path: string }) => {
      const o = recordFirestoreDelete("bulkwriter.delete", "direct-writer", ref);
      storeFor(ref.__collection).delete(ref.__id);
      if (o) o.committed = true;
    },
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
          // R9 §25 — FAKE-OWNED telemetry: the injection's own implementation records that production
          // reached the targeted write and that the modelled failure actually fired. A test body
          // cannot fabricate either, and an emptied body produces neither.
          if (armedInjection && ref.__collection === armedInjection.targetCollection) armedInjection.reached = true;
          if (throwOnSetCollection.value !== null && ref.__collection === throwOnSetCollection.value) {
            if (armedInjection && ref.__collection === armedInjection.targetCollection) armedInjection.fired = true;
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
          const observation = recordFirestoreDelete("transaction.delete", "transaction", ref);
          pendingWrites.push(() => {
            storeFor(ref.__collection).delete(ref.__id);
            if (observation) observation.committed = true;
          });
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

/**
 * ─── R8 §25–§27 — NO MODULE-LOADING FORM CAN REACH A LIVE FIRESTORE HANDLE ────────────────────
 *
 * R7 BLOCKER: `require("firebase-admin/firestore").getFirestore()` bypassed BOTH the import pin (which
 * walked only `ImportDeclaration` nodes) and the `adminDb` mock. In production that returns a real,
 * live handle — `initFirebaseAdmin()` has already run — so the write would land, while under Jest it
 * threw and was swallowed, giving the suite no signal at all on a channel that is live in production.
 *
 * `firebase-admin/firestore` is now mocked so every handle-producing entry point returns the SAME fake
 * the oracle observes. `requireActual` is spread first so `Timestamp` and the other value exports keep
 * working for the fixtures.
 */
jest.mock("firebase-admin/firestore", () => ({
  ...(jest.requireActual("firebase-admin/firestore") as Record<string, unknown>),
  getFirestore: () => failClosedAdminDb,
  initializeFirestore: () => failClosedAdminDb,
}));

/**
 * R9 §57 — the firebase-admin ROOT is a handle-producing entry point too. R8 mocked
 * `firebase-admin/firestore` but left `require("firebase-admin").firestore()` resolving to the real
 * package, which in production returns a live handle because `initFirebaseAdmin()` has already run.
 * Under Jest it threw and the module's swallow-and-warn style hid it — the same silent-channel shape
 * R7 found for BulkWriter, one module up.
 */
jest.mock("firebase-admin", () => {
  const actual = jest.requireActual("firebase-admin") as Record<string, unknown>;
  return { ...actual, firestore: () => failClosedAdminDb };
});

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
 *
 * ─── R9 §7–§9 — AND IT IS NOW THE DEFAULT, NOT AN OPT-IN ──────────────────────────────────────
 *
 * R8 BLOCKER A: R3 added this constant but only ONE describe block opted into it, so every
 * store-oracle contract still ran against `projectId: null`. A hostile write-then-delete gated on
 * `typeof event.projectId === "string"` — the ORDINARY Team Project case, and the only one that
 * matters in production — left no durable audit record for any of the four operations and the suite
 * exited 0. Fixing the oracle without fixing the fixture bought nothing.
 *
 * `seedRun()` and `seedPanel()` are Project-backed by DEFAULT. A test that genuinely needs a
 * Project-less run — a Personal-shaped run, or a rejection precondition — overrides `projectId`
 * explicitly and locally, which is the §9 deviation contract: visible at the call site, never a
 * silent fallback to whatever is easiest to seed.
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
  stores.runs.set(RUN_ID, asPersisted({ userId: CREATOR_UID, workspaceId: WS_ID, projectId: PROJECT_ID, createdAt: NOW, governanceRecord: validGovernanceRecord(), ...overrides }));
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
      projectId: PROJECT_ID,
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
  armedInjection = null;
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
 * ─── R9 §3 — AND THE LEDGER IS NO LONGER A SECURITY AUTHORITY AT ALL ──────────────────────────
 *
 * R5–R8 kept an ATTEMPTED/COMMITTED split over this ledger and used it as the verdict for almost
 * every durable claim. That was the organizing defect of the series, and relocating six assertions to
 * the store in R8 did not close it: `panelEvents()` and `soleCommittedGovernanceEvent()` remained
 * reachable, so a future author — or a hostile patch — could satisfy any cardinality or payload claim
 * from a log the store contradicts. THE ACCESSORS ARE DELETED. What remains is explicitly named for
 * diagnostics, is used only by the oracle's own channel-liveness and mechanism self-tests, and is
 * forbidden inside security-contract sections by a source-level guard (§4) that ships with its own
 * falsifier (§5).
 *
 * The attempt log still earns its place for one thing the store cannot show: that an aborted
 * transaction ATTEMPTED a write which was then discarded. That is a statement about retry mechanics,
 * not about what is durable, and the retry suite pairs it with the store delta.
 */
const PANEL_MUTATION_ACTIONS: readonly string[] = Object.freeze([
  "adaptive_review_panel_created",
  "adaptive_review_panel_reconfigured",
  "adaptive_review_panel_cancelled",
  "adaptive_review_panel_vote_cast",
]);

/** DIAGNOSTIC ONLY — every write ATTEMPT the fake saw, on any channel. Never a durable-state verdict. */
const diagnosticAttemptedEventCount = () => governanceEventLog.length;
/** DIAGNOSTIC ONLY — the attempts the fake saw land. Never a durable-state verdict; use the store delta. */
const diagnosticLandedEventObservations = (): readonly GovernanceEventObservation[] => governanceEventLog.filter((o) => o.committed);

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
/**
 * R9 §7/§8 — the Workspace/Project binding the audited event must carry, READ BACK from the canonical
 * run document. R8 restated `workspaceId: WS_ID, projectId: null` as literals in all four success
 * payloads, which pinned the values and not their provenance — and pinned the Project against the one
 * value (`null`) that no ordinary Team run has.
 */
const canonicalRunBinding = () => {
  const run = stores.runs.get(RUN_ID) as { workspaceId: string; projectId: string | null };
  return { workspaceId: run.workspaceId, projectId: run.projectId };
};
/** The panel document's own (possibly stale) mirror of that binding — never the event's source. */
const panelMirrorBinding = () => {
  const panel = stores.humanReviewPanel.get(`${RUN_ID}::current`) as { workspaceId?: string; projectId?: string | null } | undefined;
  return { workspaceId: panel?.workspaceId, projectId: panel?.projectId };
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
  // R9 §19/§20 — the four delete channels, each with its own liveness case and its own
  // disable-one-observer falsifier below — [[count:instrumentedChannels=18]] instrumented channels,
  // [[count:deleteChannels=4]] of them deletes. R8 shipped all five
  // delete SITES unobserved.
  "direct.delete",
  "transaction.delete",
  "batch.delete",
  "bulkwriter.delete",
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
  /**
   * R9 §16/§17 — every same-module function REACHABLE from the audited operations, transitively.
   *
   * R8 MAJOR: the census analysed ONLY the four exported operations, so it was positionally blind to
   * `appendPanelGovernanceEvent` — the local helper that performs the panel audit write. Adding a
   * `.delete()` there was invisible to the write surface, which is the one place a forged-then-removed
   * audit record would be introduced. The graph starts at the operations and follows local calls.
   */
  reachableLocalFunctions: string[];
  /**
   * §16 — every transactional write ATTRIBUTED to the function that makes it, `owner::method`. A
   * method-name set alone cannot show that the event helper's write is in the census, because the
   * audited operations write the canonical document with the same method. Attribution can.
   */
  transactionWriteSites: string[];
  /**
   * §17 — a call this analysis cannot resolve to a local function, an imported binding or an
   * allow-listed intrinsic. It fails the surface closed rather than being silently skipped.
   */
  unresolvedLocalCalls: string[];
};

/**
 * §17 — intrinsics a call may resolve to without being a persistence concern. Pinned, and asserted
 * against the production source, so the escape hatch cannot be widened silently.
 */
const ALLOWED_INTRINSIC_CALLEES: readonly string[] = Object.freeze([
  "Array", "Boolean", "Error", "JSON", "Map", "Number", "Object", "Promise", "Set", "String",
  "isNaN", "parseFloat", "parseInt", "require", "structuredClone", "Symbol", "BigInt", "Date",
]);



/** Derived from the production source, scoped to the four audited operations for call analysis. */
function deriveProductionWriteSurface(sourceText: string, targetFunctions: readonly string[]): ProductionWriteSurface {
  const sf = tsApi.createSourceFile("subject.ts", sourceText, tsApi.ScriptTarget.ES2020, true);
  const persistenceImports: string[] = [];
  const transactionMethods = new Set<string>();
  const directWriteCalls: string[] = [];
  const allImports: string[] = [];

  /**
   * §23 — `require("...")` and dynamic `import("...")` with a static string literal are dependency
   * introductions exactly like a static import, and the previous version saw neither. Discovered
   * anywhere in the file, at any nesting depth, so they cannot hide inside a function body.
   */
  const walkForDynamicDeps = (node: tsApi.Node) => {
    if (tsApi.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = tsApi.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === tsApi.SyntaxKind.ImportKeyword;
      const arg = node.arguments[0];
      if (isRequire || isDynamicImport) {
        const form = isRequire ? "require" : "dynamic import";
        if (arg && tsApi.isStringLiteralLike(arg)) {
          allImports.push(`${arg.text} :: <${form}>`);
        } else {
          // R9 §17 — a COMPUTED specifier (`require(spec)`, `import(modulePath)`) is a dependency
          // introduction whose target this analysis cannot know. R8 required a string literal and
          // therefore recorded nothing at all for this shape: the pinned import list stayed clean while
          // an arbitrary module — including a live Firestore handle — was being loaded. It now fails
          // closed by appearing in the pinned list as an unresolved specifier.
          allImports.push(`<UNRESOLVED-SPECIFIER> :: <${form} ${arg ? arg.getText(sf).replace(/\s+/g, " ").slice(0, 40) : "no argument"}>`);
        }
      }
    }
    tsApi.forEachChild(node, walkForDynamicDeps);
  };
  walkForDynamicDeps(sf);

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

  /**
   * §16/§17 — the LOCAL CALL GRAPH. Module-scope functions by name (declarations and
   * function-valued consts), so a call from an audited operation into a local helper is followed.
   */
  const localFunctions = new Map<string, tsApi.Node>();
  tsApi.forEachChild(sf, (node) => {
    if (tsApi.isFunctionDeclaration(node) && node.name) localFunctions.set(node.name.text, node);
    if (tsApi.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (tsApi.isIdentifier(d.name) && d.initializer && (tsApi.isArrowFunction(d.initializer) || tsApi.isFunctionExpression(d.initializer))) localFunctions.set(d.name.text, d.initializer);
      }
    }
  });
  const importedBindings = new Set<string>();
  tsApi.forEachChild(sf, (node) => {
    if (!tsApi.isImportDeclaration(node)) return;
    const clause = node.importClause;
    if (clause?.name) importedBindings.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && tsApi.isNamedImports(bindings)) for (const e of bindings.elements) importedBindings.add(e.name.text);
    if (bindings && tsApi.isNamespaceImport(bindings)) importedBindings.add(bindings.name.text);
  });

  /** Every name declared at MODULE scope — the only place a module's own functions can be parked. */
  const moduleScopeBindings = new Set<string>();
  tsApi.forEachChild(sf, (node) => {
    if (tsApi.isVariableStatement(node)) for (const d of node.declarationList.declarations) if (tsApi.isIdentifier(d.name)) moduleScopeBindings.add(d.name.text);
    if (tsApi.isFunctionDeclaration(node) && node.name) moduleScopeBindings.add(node.name.text);
    if (tsApi.isClassDeclaration(node) && node.name) moduleScopeBindings.add(node.name.text);
  });

  const unresolvedLocalCalls = new Set<string>();
  /** Local functions called from `fnNode`, plus any callee this analysis cannot account for. */
  const localCalleesOf = (fnNode: tsApi.Node, owner: string): string[] => {
    const called: string[] = [];
    const visit = (n: tsApi.Node) => {
      if (tsApi.isCallExpression(n)) {
        const callee = n.expression;
        if (tsApi.isIdentifier(callee)) {
          if (localFunctions.has(callee.text)) called.push(callee.text);
          else if (!importedBindings.has(callee.text) && !ALLOWED_INTRINSIC_CALLEES.includes(callee.text)) {
            // a local parameter, a closure variable or an unknown global — not resolvable here
            unresolvedLocalCalls.add(`${owner}->${callee.text}`);
          }
        } else if (tsApi.isPropertyAccessExpression(callee)) {
          // R10 — a method call whose RECEIVER is a local, non-imported binding can reach a local
          // helper the identifier walk never sees. R9 excluded this shape from BOTH branches, so a
          // transactional write inside a helper reached via `shadowWriters.append(...)` produced no
          // reachable-function entry, no attributed write site, and no unresolved entry either —
          // making §17's "no call is unresolvable" false as written.
          //
          // The discriminator is DERIVED, not a list: a method call can hide a local-helper dispatch only
          // when its receiver is a MODULE-SCOPE binding, because that is the only place a module's own
          // functions can be parked (`const shadowWriters = { append: appendShadowAudit }`). A receiver
          // that is function-LOCAL — a Firestore snapshot, a parsed panel, an array — holds values that
          // came from somewhere this analysis already accounts for.
          const receiverRoot = (function rootOf(e: tsApi.Expression): tsApi.Expression { return tsApi.isPropertyAccessExpression(e) ? rootOf(e.expression) : e; })(callee.expression);
          if (tsApi.isIdentifier(receiverRoot) && moduleScopeBindings.has(receiverRoot.text) && !importedBindings.has(receiverRoot.text) && !localFunctions.has(receiverRoot.text)) {
            unresolvedLocalCalls.add(`${owner}->${callee.getText(sf).replace(/\s+/g, " ").slice(0, 60)}`);
          }
        } else if (callee.kind !== tsApi.SyntaxKind.ImportKeyword) {
          // computed/element-access or a call on a call result: unresolvable by construction
          unresolvedLocalCalls.add(`${owner}->${callee.getText(sf).replace(/\s+/g, " ").slice(0, 60)}`);
        }
      }
      tsApi.forEachChild(n, visit);
    };
    tsApi.forEachChild(fnNode, visit);
    return called;
  };

  const transactionWriteSites = new Set<string>();

  const analyseFunction = (fnNode: tsApi.Node, ownerName: string) => {
    // the transaction callback's own parameter name, whatever it is called
    const txParamNames = new Set<string>();
    /**
     * R9 §16 — a helper that RECEIVES the transaction writes transactionally through its own
     * parameter. Recognised STRUCTURALLY, from the parameter's type annotation, not from its name:
     * `appendPanelGovernanceEvent(tx: FirebaseFirestore.Transaction, ...)` does `tx.set(...)`, and
     * before the call graph existed that call was outside the census entirely. Once it came into
     * scope it had to be classified as transactional, or the surface would report a phantom direct
     * write on every run. A write on a genuine `Transaction` IS a transactional write.
     */
    const declaredParameters = (fnNode as { parameters?: tsApi.NodeArray<tsApi.ParameterDeclaration> }).parameters ?? [];
    for (const parameter of declaredParameters) {
      if (!tsApi.isIdentifier(parameter.name) || !parameter.type) continue;
      const annotation = parameter.type.getText(sf).replace(/\s+/g, "");
      if (/(^|\.)Transaction$/.test(annotation)) txParamNames.add(parameter.name.text);
    }
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
        if (tsApi.isIdentifier(receiver) && txParamNames.has(receiver.text)) {
          transactionMethods.add(method);
          if (FIRESTORE_WRITE_METHODS.includes(method)) transactionWriteSites.add(`${ownerName}::${method}`);
        }
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

  // §16 — transitive closure from the audited operations over the LOCAL call graph, then analyse
  // every function in it. R8 analysed only the roots.
  const reachable = new Set<string>();
  const queue = targetFunctions.filter((name) => localFunctions.has(name));
  for (const name of queue) reachable.add(name);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    for (const callee of localCalleesOf(localFunctions.get(name) as tsApi.Node, name)) {
      if (!reachable.has(callee)) { reachable.add(callee); queue.push(callee); }
    }
  }
  for (const name of reachable) analyseFunction(localFunctions.get(name) as tsApi.Node, name);

  return {
    persistenceImports: [...new Set(persistenceImports)].sort(),
    transactionMethods: [...transactionMethods].sort(),
    directWriteCalls: directWriteCalls.sort(),
    allImports: allImports.sort(),
    reachableLocalFunctions: [...reachable].sort(),
    transactionWriteSites: [...transactionWriteSites].sort(),
    unresolvedLocalCalls: [...unresolvedLocalCalls].sort(),
  };
}

/**
 * ─── R8 §61 — THE DIFF ENGINE'S OWN SELF-TEST ─────────────────────────────────────────────────
 *
 * The oracle is now the store diff, so the diff itself needs a mechanism test. Every case below is
 * synthetic: it drives the fake directly and asserts the delta the engine reports, so a diff that
 * silently missed a deletion, a dotted-field modification, or a document in a collection that did
 * not exist at snapshot time would fail here rather than in a security assertion months later.
 */
/**
 * ─── R8 §49 — THE CITATION RESOLVER'S OWN NEGATIVE CONTROLS ────────────────────────────────────
 *
 * A resolver that accepts everything is worse than no resolver, because it launders prose as proof.
 * These prove it rejects each way a citation can be wrong.
 */
/**
 * ─── R8 §56–§58 — THE RUNBOOK ROW IS PARSED, NOT EYEBALLED ────────────────────────────────────
 *
 * R7 MAJOR: the debt row was a FOUR-cell row in a three-column table. The Status cell was never
 * updated and Markdown silently dropped the fourth cell — which carried the Tier 2 / Tier 3 gating
 * rationale — in the one document whose job is rollout gating. A prose review missed it twice, so it
 * is parsed here instead.
 */
describe("governance canary runbook — the debt table parses and says what the PR claims (§57/§58)", () => {
  const RUNBOOK = readFileSync(joinPath(__dirname, "..", "..", "..", "docs", "operations", "workspace-governance-canary-runbook.md"), "utf8");
  const cellsOf = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

  /** Every contiguous block of table rows, so a malformed row is found wherever it is. */
  const tables = (() => {
    const out: string[][] = [];
    let current: string[] = [];
    for (const line of RUNBOOK.split("\n")) {
      if (line.trim().startsWith("|")) current.push(line);
      else if (current.length) { out.push(current); current = []; }
    }
    if (current.length) out.push(current);
    return out;
  })();

  it("every table row has exactly as many cells as its own header — no row silently drops a cell", () => {
    const problems: string[] = [];
    for (const table of tables) {
      const width = cellsOf(table[0]).length;
      for (const row of table) {
        const n = cellsOf(row).length;
        if (n !== width) problems.push(`"${row.trim().slice(0, 70)}" has ${n} cells, header has ${width}`);
      }
    }
    expect(`malformedRunbookRows:${problems.join(" | ")}`).toBe("malformedRunbookRows:");
    expect(tables.length).toBeGreaterThan(0);
  });

  it("the write-side debt row states PARTIALLY CLOSED and keeps its Tier 2 / Tier 3 gating rationale", () => {
    const row = RUNBOOK.split("\n").find((l) => l.includes("TECH_DEBT_WORKSPACE_PANEL_MUTATION_AUDIT_COVERAGE") && l.trim().startsWith("|"));
    expect(row).toBeDefined();
    const cells = cellsOf(row as string);
    expect(`cells:${cells.length}`).toBe("cells:3");
    expect(cells[1]).toContain("PARTIALLY CLOSED — WRITE SIDE ONLY");
    // the gating rationale must survive in the rendered cell, not a dropped fourth one
    expect(cells[2]).toContain("Tier 2");
    expect(cells[2]).toContain("Tier 3");
    expect(cells[2]).toContain("TECH_DEBT_PANEL_MUTATION_AUDIT_READ_SURFACING");
  });

  it("the reader-surfacing debt is recorded under ONE canonical label, and customer-visible coverage is NOT claimed closed", () => {
    expect(RUNBOOK).toContain("TECH_DEBT_PANEL_MUTATION_AUDIT_READ_SURFACING");
    // exactly one label for this debt — no synonym anywhere in the runbook
    expect(RUNBOOK.match(/TECH_DEBT_PANEL_MUTATION_AUDIT_READ[A-Z_]*/g)?.every((m) => m === "TECH_DEBT_PANEL_MUTATION_AUDIT_READ_SURFACING")).toBe(true);
    // and the production comment uses the same phrase as the runbook
    expect(PANEL_MUTATIONS_SOURCE).toContain("TECH_DEBT_PANEL_MUTATION_AUDIT_READ_SURFACING");
    expect(PANEL_MUTATIONS_SOURCE).toContain("PARTIALLY CLOSED — WRITE SIDE ONLY");
  });
});

/**
 * ─── R8 §25–§27 — EVERY FIRESTORE HANDLE IS THE SAME FAKE ─────────────────────────────────────
 */
describe("module boundary — no loading form reaches a live Firestore (§25–§27)", () => {
  it("require(\"firebase-admin/firestore\").getFirestore() returns the observed fake, not a live handle", async () => {
    const { getFirestore } = require("firebase-admin/firestore") as { getFirestore: () => typeof mockAdminDb };
    const db = getFirestore();
    const before = snapshotStore();
    await db.collection("runs").doc(RUN_ID).collection("governanceEvents").doc("via-require").set({ action: "adaptive_review_panel_created" });
    // it wrote into the SAME store the oracle diffs
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe(`added:[runs/${RUN_ID}/governanceEvents/via-require] modified:[] deleted:[]`);
  });

  it("a dynamic import of the same module resolves to the same fake", async () => {
    const mod = (await import("firebase-admin/firestore")) as unknown as { getFirestore: () => typeof mockAdminDb };
    const before = snapshotStore();
    await mod.getFirestore().collection("runs").doc(RUN_ID).collection("governanceEvents").doc("via-import").set({ action: "adaptive_review_panel_cancelled" });
    expect(describeDelta(diffStore(before, snapshotStore()))).toBe(`added:[runs/${RUN_ID}/governanceEvents/via-import] modified:[] deleted:[]`);
  });

  it("every handle-producing entry point yields the SAME store — there is no second hidden Firestore", async () => {
    const viaRequire = (require("firebase-admin/firestore") as { getFirestore: () => typeof mockAdminDb }).getFirestore();
    const viaImport = ((await import("firebase-admin/firestore")) as unknown as { getFirestore: () => typeof mockAdminDb }).getFirestore();
    const before = snapshotStore();
    await viaRequire.collection("runs").doc(RUN_ID).collection("governanceEvents").doc("h1").set({ action: "x" });
    await viaImport.collection("runs").doc(RUN_ID).collection("governanceEvents").doc("h2").set({ action: "y" });
    expect(diffStore(before, snapshotStore()).added.sort()).toEqual([`runs/${RUN_ID}/governanceEvents/h1`, `runs/${RUN_ID}/governanceEvents/h2`]);
  });

  it("§23 — a require() or dynamic import() in the production module is DISCOVERED by the dependency pin", () => {
    const surface = (source: string) => deriveProductionWriteSurface(source, Object.keys(PANEL_OPERATION_FUNCTIONS)).allImports;
    const withRequire = `import "server-only";\nexport async function putWorkspaceReviewPanel() { const { getFirestore } = require("firebase-admin/firestore"); return { ok: true }; }`;
    expect(surface(withRequire)).toContain("firebase-admin/firestore :: <require>");
    const withDynamic = `import "server-only";\nexport async function putWorkspaceReviewPanel() { const m = await import("firebase-admin/firestore"); return { ok: true }; }`;
    expect(surface(withDynamic)).toContain("firebase-admin/firestore :: <dynamic import>");
    // and the production module itself takes neither form today
    expect(surface(PANEL_MUTATIONS_SOURCE).filter((i) => i.includes("<require>") || i.includes("<dynamic import>"))).toEqual([]);
  });

  /**
   * R9 §17 — R8 MINOR: the dependency pin required a STRING LITERAL specifier, so
   * `require(spec)` with a computed specifier — a real CallExpression that `isStringLiteralLike`
   * rejects — recorded nothing, and the pinned import list stayed clean while an arbitrary module was
   * loaded. It is now reported as an unresolved specifier and therefore fails the pin.
   */
  it("§17 — a COMPUTED require()/import() specifier fails the dependency pin closed", () => {
    const surface = (source: string) => deriveProductionWriteSurface(source, Object.keys(PANEL_OPERATION_FUNCTIONS)).allImports;
    const computedRequire = `import "server-only";\nconst spec = "firebase-admin/firestore";\nexport async function putWorkspaceReviewPanel() { const m = require(spec); return { ok: true, m }; }`;
    expect(surface(computedRequire).filter((i) => i.startsWith("<UNRESOLVED-SPECIFIER>"))).toEqual(["<UNRESOLVED-SPECIFIER> :: <require spec>"]);
    const computedImport = `import "server-only";\nconst spec = "x";\nexport async function putWorkspaceReviewPanel() { const m = await import(spec); return { ok: true, m }; }`;
    expect(surface(computedImport).filter((i) => i.startsWith("<UNRESOLVED-SPECIFIER>"))).toEqual(["<UNRESOLVED-SPECIFIER> :: <dynamic import spec>"]);
    // POSITIVE CONTROL — a literal specifier is still resolved by name, not swept into the bucket
    expect(surface(`import "server-only";\nexport async function putWorkspaceReviewPanel() { return require("firebase-admin/firestore"); }`)).toContain("firebase-admin/firestore :: <require>");
    // and the real module has no unresolved specifier
    expect(surface(PANEL_MUTATIONS_SOURCE).filter((i) => i.startsWith("<UNRESOLVED-SPECIFIER>"))).toEqual([]);
  });

  it("§57 — require(\"firebase-admin\").firestore() also resolves to the observed fake", () => {
    const admin = require("firebase-admin") as { firestore: () => typeof mockAdminDb };
    expect(`sameHandle:${admin.firestore() === failClosedAdminDb}`).toBe("sameHandle:true");
  });
});

/**
 * ─── R9 §21–§24 — THE VIOLATION LEDGER SURVIVES FIXTURE RESET ───────────────────────────────────
 *
 * R8 MAJOR: `resetStores()` ended with `harnessViolations.length = 0`, and `seedBaseFixture()` calls
 * `resetStores()`. A test that provoked an unsupported-write violation and then reseeded — which most
 * multi-phase tests do — destroyed the evidence before the unconditional postcondition read it. The
 * fail-closed guarantee was conditional on nobody reseeding.
 */
describe("harness-integrity ledger — append-only, and reset-proof (§21–§24)", () => {
  it("§23 — a violation provoked BEFORE resetStores() and seedBaseFixture() is still pending after both", () => {
    expect(() => failClosedAdminDb.recursiveDelete("runs")).toThrow(/does not model/);
    expect(`pendingBeforeReset:${pendingHarnessViolations().length}`).toBe("pendingBeforeReset:1");
    resetStores();
    seedBaseFixture();
    // THE ASSERTION R8 COULD NOT MAKE: the evidence outlived the reseed
    expect(`pendingAfterReset:${pendingHarnessViolations().join(",")}`).toBe("pendingAfterReset:Firestore.recursiveDelete");
    expect(acknowledgeExpectedViolations(["Firestore.recursiveDelete"])).toEqual(["Firestore.recursiveDelete"]);
  });

  it("§24 — the ledger still fails closed when PRODUCTION swallows the sentinel", () => {
    // the audited module's house style for audit writes: try { ... } catch { logger.warn(...) }
    try {
      failClosedAdminDb.bulkWriterWithRetries();
    } catch {
      // swallowed, exactly as production would
    }
    expect(`pendingDespiteSwallow:${pendingHarnessViolations().join(",")}`).toBe("pendingDespiteSwallow:Firestore.bulkWriterWithRetries");
    expect(acknowledgeExpectedViolations(["Firestore.bulkWriterWithRetries"])).toEqual(["Firestore.bulkWriterWithRetries"]);
  });

  it("§22 — acknowledgement is by CONTENT: an unnamed violation stays pending even in the acknowledging test", () => {
    expect(() => failClosedAdminDb.namedOne()).toThrow();
    expect(() => failClosedAdminDb.unnamedOne()).toThrow();
    // only the named one is claimed; there is no catch-all drain
    expect(acknowledgeExpectedViolations(["Firestore.namedOne"])).toEqual(["Firestore.namedOne"]);
    expect(`stillPending:${pendingHarnessViolations().join(",")}`).toBe("stillPending:Firestore.unnamedOne");
    expect(acknowledgeExpectedViolations(["Firestore.unnamedOne"])).toEqual(["Firestore.unnamedOne"]);
    expect(`drained:${pendingHarnessViolations().length}`).toBe("drained:0");
  });

  it("§22 — acknowledgement marks INDEXES, so a violation raised afterwards cannot be pre-authorised", () => {
    expect(() => failClosedAdminDb.firstCall()).toThrow();
    expect(acknowledgeExpectedViolations(["Firestore.firstCall", "Firestore.secondCall"])).toEqual(["Firestore.firstCall"]);
    // the same label, raised AFTER the acknowledgement, is a new entry and is pending
    expect(() => failClosedAdminDb.secondCall()).toThrow();
    expect(`pendingAfterwards:${pendingHarnessViolations().join(",")}`).toBe("pendingAfterwards:Firestore.secondCall");
    expect(acknowledgeExpectedViolations(["Firestore.secondCall"])).toEqual(["Firestore.secondCall"]);
  });

  it("the ledger is APPEND-ONLY: nothing in the suite shortens it", () => {
    const lengthBefore = harnessLedgerLength();
    expect(() => failClosedAdminDb.somethingElse()).toThrow();
    resetStores();
    seedBaseFixture();
    expect(`grewBy:${harnessLedgerLength() - lengthBefore}`).toBe("grewBy:1");
    acknowledgeExpectedViolations(["Firestore.somethingElse"]);
    // acknowledgement does not shorten it either
    expect(`lengthAfterAcknowledgement:${harnessLedgerLength() - lengthBefore}`).toBe("lengthAfterAcknowledgement:1");
  });
});

/**
 * ─── R9 §4/§5 — THE OLD AUTHORITY IS STATICALLY UNREACHABLE FROM A SECURITY ASSERTION ──────────
 *
 * Deleting `panelEvents()` and `soleCommittedGovernanceEvent()` closes today's holes. This closes
 * tomorrow's: a future author cannot write
 *
 *     expect(diagnosticLandedEventObservations()).toHaveLength(1)
 *
 * inside a security-contract section and thereby take the verdict from the attempt log again. The
 * guard reads THIS FILE through the TypeScript parser and looks at IDENTIFIER TOKENS, so a mention in
 * a doc comment — of which there are several, deliberately, recording why the accessors are gone — is
 * not a violation while a real reference is.
 *
 * Two scopes are checked, because a helper is the obvious way round a per-section ban:
 *   • every top-level `describe` block except the oracle's own diagnostic self-tests;
 *   • every module-scope function except the small set that OWNS the log.
 */
describe("R9 §4/§5 — log-based authority is statically unreachable from security-contract sections", () => {
  const BAN_SOURCE = readFileSync(__filename, "utf8");
  const BAN_SF = tsApi.createSourceFile("spec.ts", BAN_SOURCE, tsApi.ScriptTarget.ES2020, true);

  /** Identifiers that read or mutate the diagnostic attempt log, plus the deleted R8 accessors. */
  const FORBIDDEN_LOG_IDENTIFIERS: readonly string[] = Object.freeze([
    "governanceEventLog",
    "diagnosticAttemptedEventCount",
    "diagnosticLandedEventObservations",
    "panelEvents",
    "committedGovernanceEvents",
    "soleCommittedGovernanceEvent",
    "attemptedGovernanceEventCount",
  ]);

  /** The ONLY describe blocks permitted to touch it: the oracle's own liveness and mechanism tests. */
  const DIAGNOSTIC_ONLY_SECTIONS: readonly string[] = Object.freeze([
    "whole-event-store oracle — every instrumented channel is LIVE (§10)",
  ]);

  /** The ONLY module-scope functions permitted to touch it: the ones that OWN it. */
  const LOG_OWNING_FUNCTIONS: readonly string[] = Object.freeze([
    "resetStores",
    "observeGovernanceEvent",
    "observeWriterGovernanceEvent",
    "diagnosticAttemptedEventCount",
    "diagnosticLandedEventObservations",
  ]);

  type Region = { kind: "describe" | "function"; name: string; start: number; end: number };

  /**
   * R9 — EVERY `describe` CALL, at any depth and in any form.
   *
   * The first version of this guard walked only TOP-LEVEL `describe("...", fn)` statements with an
   * IDENTIFIER callee. The provenance matrix is declared as `describe.each(...)("...%s...", fn)`, whose
   * callee is a CallExpression, so it matched no region at all — and an identifier inside it fell
   * through to a module-scope fallback that blanket-allowed `governanceEventLog`. Re-sourcing the
   * provenance verdict from the attempt log then SURVIVED the guard that exists to prevent exactly
   * that. Found by R9's own mutation R9-M6, and it is the same one-level-down relocation this series
   * keeps producing: the ban was real, its notion of "a section" was not.
   *
   * `describe`, `describe.only`, `describe.skip`, `describe.each(table)(...)` and any nesting of them
   * are all collected, and the INNERMOST enclosing region decides.
   */
  const describeTitleOf = (call: tsApi.CallExpression): string | null => {
    const callee = call.expression;
    const isDescribeRoot = (n: tsApi.Node): boolean => tsApi.isIdentifier(n) && n.text === "describe";
    const looksLikeDescribe =
      isDescribeRoot(callee) ||
      (tsApi.isPropertyAccessExpression(callee) && isDescribeRoot(callee.expression)) ||
      (tsApi.isCallExpression(callee) && tsApi.isPropertyAccessExpression(callee.expression) && isDescribeRoot(callee.expression.expression));
    if (!looksLikeDescribe) return null;
    const title = call.arguments[0];
    if (!title) return null;
    if (tsApi.isStringLiteral(title)) return title.text;
    if (tsApi.isNoSubstitutionTemplateLiteral(title)) return title.text;
    // a template literal with substitutions still names a real section; use its raw text
    if (tsApi.isTemplateExpression(title)) return title.getText(BAN_SF);
    return null;
  };

  const regions: Region[] = [];
  const collectRegions = (node: tsApi.Node): void => {
    if (tsApi.isCallExpression(node)) {
      const title = describeTitleOf(node);
      if (title !== null) regions.push({ kind: "describe", name: title, start: node.getStart(BAN_SF), end: node.getEnd() });
    }
    tsApi.forEachChild(node, collectRegions);
  };
  collectRegions(BAN_SF);
  for (const statement of BAN_SF.statements) {
    if (tsApi.isFunctionDeclaration(statement) && statement.name) {
      regions.push({ kind: "function", name: statement.name.text, start: statement.getStart(BAN_SF), end: statement.getEnd() });
    }
    if (tsApi.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (tsApi.isIdentifier(declaration.name) && declaration.initializer && (tsApi.isArrowFunction(declaration.initializer) || tsApi.isFunctionExpression(declaration.initializer))) {
          regions.push({ kind: "function", name: declaration.name.text, start: statement.getStart(BAN_SF), end: statement.getEnd() });
        }
      }
    }
  }
  /**
   * The declaration statements of the log and of each log-owning accessor — the ONLY module-scope
   * positions where a bare reference is permitted. Derived by walking the file, so adding an accessor
   * does not widen the exemption unless it is also added to `LOG_OWNING_FUNCTIONS`.
   */
  const ownDeclarationRanges = (() => {
    const owned = new Set<string>(["governanceEventLog", ...LOG_OWNING_FUNCTIONS]);
    const ranges: { name: string; start: number; end: number }[] = [];
    for (const statement of BAN_SF.statements) {
      if (tsApi.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (tsApi.isIdentifier(declaration.name) && owned.has(declaration.name.text)) {
            ranges.push({ name: declaration.name.text, start: statement.getStart(BAN_SF), end: statement.getEnd() });
          }
        }
      }
      if (tsApi.isFunctionDeclaration(statement) && statement.name && owned.has(statement.name.text)) {
        ranges.push({ name: statement.name.text, start: statement.getStart(BAN_SF), end: statement.getEnd() });
      }
    }
    return ranges;
  })();
  /** Innermost wins: a describe nested inside another is the section that governs its contents. */
  const regionFor = (position: number): Region | undefined =>
    regions
      .filter((r) => position >= r.start && position < r.end)
      .sort((a, b) => b.start - a.start || a.end - b.end)[0];

  /** Every forbidden identifier TOKEN, with the region that encloses it. Comments carry no tokens. */
  const offences: string[] = [];
  const visit = (node: tsApi.Node): void => {
    if (tsApi.isIdentifier(node) && FORBIDDEN_LOG_IDENTIFIERS.includes(node.text)) {
      const position = node.getStart(BAN_SF);
      const region = regionFor(position);
      const allowed = region
        ? region.kind === "describe"
          ? DIAGNOSTIC_ONLY_SECTIONS.includes(region.name)
          : LOG_OWNING_FUNCTIONS.includes(region.name)
        : // Outside any describe and any named module-scope function. The ONLY permitted bare references
          // are inside the DECLARATION STATEMENTS of the log and of the log-owning accessors.
          //
          // R10 — the trailing `LOG_OWNING_FUNCTIONS.includes(node.text)` clause that used to sit here
          // allowed a bare reference to any accessor NAME anywhere at module scope, so
          // `const landedAlias = diagnosticLandedEventObservations;` created an unpoliced alias and every
          // later use of it was invisible. That clause was added while fixing R9-M6 and reopened the hole
          // one level down — the same shape as the other three defects of that round.
          ownDeclarationRanges.some((range) => position >= range.start && position < range.end);
      if (!allowed) offences.push(`${region ? `${region.kind}(${region.name})` : "module-scope"}::${node.text}@${BAN_SF.getLineAndCharacterOfPosition(position).line + 1}`);
    }
    tsApi.forEachChild(node, visit);
  };
  visit(BAN_SF);

  it("both allow-lists are PINNED by content, so widening one is a visible change and not a quiet one", () => {
    expect([...DIAGNOSTIC_ONLY_SECTIONS]).toEqual(["whole-event-store oracle — every instrumented channel is LIVE (§10)"]);
    expect([...LOG_OWNING_FUNCTIONS].sort()).toEqual([
      "diagnosticAttemptedEventCount",
      "diagnosticLandedEventObservations",
      "observeGovernanceEvent",
      "observeWriterGovernanceEvent",
      "resetStores",
    ]);
    expect([...FORBIDDEN_LOG_IDENTIFIERS].sort()).toEqual([
      "attemptedGovernanceEventCount",
      "committedGovernanceEvents",
      "diagnosticAttemptedEventCount",
      "diagnosticLandedEventObservations",
      "governanceEventLog",
      "panelEvents",
      "soleCommittedGovernanceEvent",
    ]);
    // NEGATIVE CONTROL on the section allow-list: exactly ONE describe block is exempt, and it is the
    // oracle's channel-liveness suite. Every other describe block in the file is policed.
    const policed = regions.filter((r) => r.kind === "describe" && !DIAGNOSTIC_ONLY_SECTIONS.includes(r.name)).length;
    expect(`exemptSections:${DIAGNOSTIC_ONLY_SECTIONS.length} policedSections:${policed > 30}`).toBe("exemptSections:1 policedSections:true");
  });

  it("the guard can SEE the source it polices — regions and identifier tokens were both found", () => {
    expect(`describeRegions:${regions.filter((r) => r.kind === "describe").length > 20} functionRegions:${regions.filter((r) => r.kind === "function").length > 20}`).toBe("describeRegions:true functionRegions:true");
    // a positive control: the diagnostic accessors really are referenced somewhere, so a guard that
    // simply found nothing at all cannot masquerade as a clean result
    const anyReference = [...BAN_SOURCE.matchAll(/diagnosticLandedEventObservations/g)].length;
    expect(`diagnosticAccessorIsReferenced:${anyReference > 1}`).toBe("diagnosticAccessorIsReferenced:true");
  });

  it("NO security-contract section and NO non-owning helper references the diagnostic attempt log", () => {
    expect(`logAuthorityOffences:${offences.sort().join(" | ")}`).toBe("logAuthorityOffences:");
  });

  it("a comment MENTIONING the removed accessors is not an offence — the guard reads tokens, not prose", () => {
    // this block's own doc comment names `panelEvents()` and `diagnosticLandedEventObservations`, and
    // several others do too; if prose counted, the previous test could never pass
    const proseMentions = [...BAN_SOURCE.matchAll(/`panelEvents\(\)`/g)].length;
    expect(`proseMentionsOfARemovedAccessor:${proseMentions > 0}`).toBe("proseMentionsOfARemovedAccessor:true");
  });

  /**
   * §5 — THE FALSIFIER. A forbidden reference is planted in a synthetic security-contract section and
   * the SAME region/identifier analysis is run over it. The guard must name it. This is the analysis
   * itself failing, not a lint rule and not a type error.
   */
  it("§5 FALSIFIER — a forbidden assertion planted in a security section is named by this exact analysis", () => {
    const planted = [
      'describe("panel mutation audit coverage — planted", () => {',
      '  it("reads the log", () => {',
      "    expect(diagnosticLandedEventObservations()).toHaveLength(1);",
      "  });",
      "});",
      "",
      "function aHelperThatLaundersIt() {",
      "  return governanceEventLog.length;",
      "}",
    ].join("\n");
    const sf = tsApi.createSourceFile("planted.ts", planted, tsApi.ScriptTarget.ES2020, true);
    const plantedRegions: Region[] = [];
    for (const statement of sf.statements) {
      if (tsApi.isExpressionStatement(statement) && tsApi.isCallExpression(statement.expression)) {
        const callee = statement.expression.expression;
        const title = statement.expression.arguments[0];
        if (tsApi.isIdentifier(callee) && callee.text === "describe" && title && tsApi.isStringLiteral(title)) {
          plantedRegions.push({ kind: "describe", name: title.text, start: statement.getStart(sf), end: statement.getEnd() });
        }
      }
      if (tsApi.isFunctionDeclaration(statement) && statement.name) {
        plantedRegions.push({ kind: "function", name: statement.name.text, start: statement.getStart(sf), end: statement.getEnd() });
      }
    }
    const found: string[] = [];
    const walk = (node: tsApi.Node): void => {
      if (tsApi.isIdentifier(node) && FORBIDDEN_LOG_IDENTIFIERS.includes(node.text)) {
        const position = node.getStart(sf);
        const region = plantedRegions.filter((r) => position >= r.start && position < r.end).sort((a, b) => b.start - a.start || a.end - b.end)[0];
        const allowed = region ? (region.kind === "describe" ? DIAGNOSTIC_ONLY_SECTIONS.includes(region.name) : LOG_OWNING_FUNCTIONS.includes(region.name)) : false;
        if (!allowed) found.push(`${region?.kind}(${region?.name})::${node.text}`);
      }
      tsApi.forEachChild(node, walk);
    };
    walk(sf);
    expect(found.sort()).toEqual([
      "describe(panel mutation audit coverage — planted)::diagnosticLandedEventObservations",
      "function(aHelperThatLaundersIt)::governanceEventLog",
    ]);
  });

  /**
   * R9-M6 — THE REGRESSION FOR THE HOLE THIS GUARD SHIPPED WITH. A `describe.each(...)("...")` section,
   * and a section nested inside another describe, must both be recognised. The first version of the
   * region finder matched only top-level `describe("...", fn)` with an identifier callee, so the
   * provenance matrix — declared with `describe.each` — was in no region at all and its contents were
   * silently exempt. Found by mutation, not by review.
   */
  it("§5 FALSIFIER — a forbidden reference inside `describe.each(...)` or a NESTED describe is named", () => {
    const planted = [
      'describe.each([[1], [2]])("panel mutation audit coverage — %s provenance", (n) => {',
      '  it("reads the log", () => {',
      "    expect(governanceEventLog.length).toBe(n);",
      "  });",
      "});",
      "",
      'describe("an outer security section", () => {',
      '  describe("an inner one", () => {',
      '    it("also reads the log", () => {',
      "      expect(diagnosticAttemptedEventCount()).toBe(0);",
      "    });",
      "  });",
      "});",
    ].join("\n");
    const sf = tsApi.createSourceFile("nested.ts", planted, tsApi.ScriptTarget.ES2020, true);
    const nestedRegions: Region[] = [];
    const collect = (node: tsApi.Node): void => {
      if (tsApi.isCallExpression(node)) {
        const callee = node.expression;
        const isRoot = (n: tsApi.Node) => tsApi.isIdentifier(n) && n.text === "describe";
        const isDescribe = isRoot(callee)
          || (tsApi.isPropertyAccessExpression(callee) && isRoot(callee.expression))
          || (tsApi.isCallExpression(callee) && tsApi.isPropertyAccessExpression(callee.expression) && isRoot(callee.expression.expression));
        const title = node.arguments[0];
        if (isDescribe && title && tsApi.isStringLiteral(title)) nestedRegions.push({ kind: "describe", name: title.text, start: node.getStart(sf), end: node.getEnd() });
      }
      tsApi.forEachChild(node, collect);
    };
    collect(sf);
    expect(nestedRegions.map((r) => r.name).sort()).toEqual(["an inner one", "an outer security section", "panel mutation audit coverage — %s provenance"]);
    const found: string[] = [];
    const walk = (node: tsApi.Node): void => {
      if (tsApi.isIdentifier(node) && FORBIDDEN_LOG_IDENTIFIERS.includes(node.text)) {
        const position = node.getStart(sf);
        const region = nestedRegions.filter((r) => position >= r.start && position < r.end).sort((a, b) => b.start - a.start || a.end - b.end)[0];
        const allowed = region ? DIAGNOSTIC_ONLY_SECTIONS.includes(region.name) : false;
        if (!allowed) found.push(`${region?.name}::${node.text}`);
      }
      tsApi.forEachChild(node, walk);
    };
    walk(sf);
    // the `describe.each` section AND the innermost nested one are both named
    expect(found.sort()).toEqual([
      "an inner one::diagnosticAttemptedEventCount",
      "panel mutation audit coverage — %s provenance::governanceEventLog",
    ]);
  });

  it("§5 NEGATIVE CONTROL — the same planted reference inside an ALLOW-LISTED diagnostic section is not an offence", () => {
    const planted = [
      `describe("${DIAGNOSTIC_ONLY_SECTIONS[0]}", () => {`,
      '  it("reads the log", () => {',
      "    expect(diagnosticLandedEventObservations()).toHaveLength(1);",
      "  });",
      "});",
    ].join("\n");
    const sf = tsApi.createSourceFile("allowed.ts", planted, tsApi.ScriptTarget.ES2020, true);
    const statement = sf.statements[0];
    const title = tsApi.isExpressionStatement(statement) && tsApi.isCallExpression(statement.expression) ? statement.expression.arguments[0] : undefined;
    const name = title && tsApi.isStringLiteral(title) ? title.text : "";
    expect(`allowListed:${DIAGNOSTIC_ONLY_SECTIONS.includes(name)}`).toBe("allowListed:true");
  });
});

/**
 * R9 §60 — THE `.add()` SITE COUNT IS DERIVED FROM THE REPOSITORY, NOT WRITTEN IN A COMMENT.
 *
 * The number in the fake's doc comment has been wrong twice. It is now computed by walking `lib/` and
 * `app/`, which is also why this does not shell out to `git ls-files`: a source tree without a `.git`
 * is a legitimate way to run this suite, and a proof that only works inside a git checkout is a proof
 * with an environmental precondition nobody declared.
 */
function countGovernanceEventAddSites(): string[] {
  const repoRoot = joinPath(__dirname, "..", "..", "..");
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
      const full = joinPath(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || full.includes("__tests__")) continue;
      const source = readFileSync(full, "utf8");
      // the write form is `.collection("governanceEvents")` followed by `.add(`, across a line break
      for (const match of source.matchAll(/\.collection\("governanceEvents"\)\s*\.add\(/g)) {
        const line = source.slice(0, match.index ?? 0).split("\n").length;
        found.push(`${full.slice(repoRoot.length + 1)}:${line}`);
      }
    }
  };
  for (const top of ["lib", "app"]) walk(joinPath(repoRoot, top));
  return found.sort();
}

/**
 * ─── R9 §61/§62 — EVERY QUANTITATIVE CLAIM THE PR BODY MAKES IS RE-DERIVED HERE ─────────────────
 *
 * Four of R8's claims were false, and each was false in the same way: a number was correct when it was
 * written and then restated by hand after the thing it counted changed. The remedy is not more care in
 * prose. It is that the PR body quotes numbers this suite computes, so a stale number fails CI.
 *
 * Anything that cannot be computed here does not belong in the PR body as a measured count. The
 * §62 categories — production behaviour / executable proof / measured count / architectural rationale /
 * known limitation / follow-up debt — are kept distinct in the body, and only MEASURED COUNTS appear
 * below.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  LIMITATIONS — WHAT THIS PROOF DOES NOT ESTABLISH
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ten rounds of adversarial review, three independent reviewers per round, found ZERO production
 * defects in these four audit writes. Every defect found was in the apparatus built to prove them. That
 * asymmetry is the reason this section exists rather than an eleventh round.
 *
 * THE TERMINATION RULE, set deliberately: a finding that requires WRITE ACCESS TO THIS TEST HARNESS to
 * exploit, and that no reviewer can tie to a reachable production defect, is recorded here and does not
 * block. The threat model those findings defend against is a future contributor editing the proof to
 * conceal a production defect. That is a real risk on a team; it is not the risk this repository runs
 * today, and defending against it has no natural stopping point — a sufficiently creative reviewer with
 * harness write access can always find one more shape. "Clean" is declared, not reached.
 *
 * KNOWN LIMITATIONS, each verified by a reviewer and left open on purpose:
 *
 *  L1  The proof of "no forged event on a rejection path" covers the THREE audited operations. An INLINE
 *      `tx.set(runRef.collection("governanceEvents").doc(), …)` on a rejected
 *      `finalizeWorkspaceReviewPanel` or `overrideWorkspaceReviewPanel` branch is not detected, and those
 *      branches are reachable — verified by mutation: such a ghost on the override `panel_absent` branch
 *      survives the full 740-suite run. Audit scope is pinned at [[count:auditedOperations=3]] and
 *      finalize/override keep their pre-existing best-effort post-commit pattern, so this is a scope
 *      boundary rather than a regression. It is the largest remaining hole in the "zero ghost events"
 *      claim, and the denied-Owner-Override path is the most consequential part of it.
 *
 *      NARROWER THAN IT SOUNDS, and the distinction is load-bearing: a ghost routed through
 *      `appendPanelGovernanceEvent` at the SAME site IS killed, by the write-site census that pins
 *      4 transactional write sites and 3 helper call sites. The escape requires bypassing the helper.
 *      Verified in both directions by mutation at the override `panel_absent` branch.
 *
 *  L2  A citation resolving proves only that the referenced artifact EXISTS. It is a navigation aid. A
 *      reason may carry a valid citation and a false claim, and the resolver will accept it — including
 *      when the citation sits inside a URL. Claim validity comes from the mutation, never the citation.
 *
 *  L3  The PROVEN vs DOCUMENTATION-ONLY equivalence split compares reader SOURCE TEXT, normalised for
 *      comments, coercion wrappers and containment. It is a structural check, not a semantic one: two
 *      genuinely different expressions that happen to read the same thing would still be counted PROVEN.
 *
 *  L4  Guard witnesses prove the arranged PRECONDITIONS of a rejection, not that the target source line
 *      executed. Execution binding rests on the twin-direction checks and on direct site-local ghost
 *      mutation during review, which is a review-time activity and not a committed regression.
 *
 *  L5  The atomicity injection models "the audit write does not land" by throwing at the earliest point
 *      the module could observe it. Real Firestore commits as a whole and exposes no per-document write
 *      rejection, so the injection is a modelling device. The guarantee it pins is if anything stronger
 *      under a single atomic commit.
 *
 *  L6  No Production canary backs this. There is no isolated Firebase project and seed users hold no
 *      credentials, so a stateful canary cannot run without creating ad-hoc Production identities. The
 *      storage-level recanary is a post-merge obligation.
 *
 *  L7  Prose numbers are checked only where they carry a `[[count:id=value]]` marker. Unmarked prose in
 *      this file is commentary and may drift. Marked numbers cannot. This also covers numbers that live
 *      only in the PR body: nothing in this repository reads that body, so diff-line figures, suite
 *      totals and review tallies are measured by hand at review time and are NOT CI-checked.
 *
 *  L8  The scope and `.add(`-site checks walk the WORKING TREE, not the committed tree. An untracked or
 *      generated `.ts`/`.tsx` file under `lib`/`app`/`components` containing one of the four action
 *      strings, or the `governanceEvents` `.add(` shape, turns this suite red — confirmed by adding such
 *      a file and observing exit 1. It fails CLOSED, so it can only ever produce a false failure and
 *      never a false pass, and it therefore cannot conceal a defect. But a dirty working tree is part of
 *      this suite's input, which qualifies the claim that the scope property "holds identically in any
 *      checkout": it holds for any clean checkout.
 *
 *  L9  `commentPresent` is proved correct against inputs the ROUTE can produce, not against every input
 *      the module's signature admits. Expressions that differ from production only on `comment: ""` —
 *      `args.comment !== undefined`, `nextVote.comment !== undefined` — are indistinguishable here,
 *      because `validateAdaptiveReviewCommentAndConditions` normalises an empty or whitespace-only
 *      comment to `undefined` before this module is entered. That guarantee lives in the route validator
 *      and is pinned by the call-site contract regression, NOT in this module. A future direct,
 *      non-route caller passing `comment: ""` would record `commentPresent: true` for a vote carrying no
 *      comment — the exact audit lie §44 exists to prevent. Production is correct today
 *      (`nextVote.commentPresent` is `Boolean(args.comment)`); the limitation is the boundary, not the
 *      expression.
 *
 * Nothing in this list is a statement about whether the four events are written correctly. They are, and
 * that is what the 500-odd committed regressions below establish.
 */

/**
 * R10 — THE PROOF'S OWN NUMBERS, each carrying a discovered marker so none can rot.
 *
 * The audited surface is [[count:auditedOperations=3]] operations writing [[count:auditedActions=4]]
 * actions, proved by [[count:registeredCases=59]] rejection cases over [[count:returnSites=44]] discovered
 * return sites, [[count:declaredWitnesses=15]] guard witnesses reading [[count:guardOperandReaders=8]]
 * registry operands, [[count:atomicityCases=8]] atomicity directions, [[count:provenanceSubjects=4]]
 * provenance subjects with [[count:equivalenceEntries=30]] declared equivalences,
 * [[count:pinnedImports=24]] pinned imports and [[count:mechanismIds=6]] citable harness mechanisms.
 */
describe("PR claim re-derivation — every measured count is computed from source (§61)", () => {
  const surface = () => deriveProductionWriteSurface(PANEL_MUTATIONS_SOURCE, Object.keys(PANEL_OPERATION_FUNCTIONS));

  it("the production-module counts", () => {
    const sf = tsApi.createSourceFile("p.ts", PANEL_MUTATIONS_SOURCE, tsApi.ScriptTarget.ES2020, true);
    let txGetCalls = 0;
    const walk = (n: tsApi.Node) => {
      if (tsApi.isCallExpression(n) && tsApi.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get" && /^(tx|txn|transaction)$/.test(n.expression.expression.getText(sf))) txGetCalls += 1;
      tsApi.forEachChild(n, walk);
    };
    tsApi.forEachChild(sf, walk);
    expect(`txGetCalls:${txGetCalls}`).toBe("txGetCalls:14");
    expect(`auditedOperations:${Object.keys(PANEL_OPERATION_FUNCTIONS).length}`).toBe("auditedOperations:3");
    expect(`auditedActions:${PANEL_MUTATION_ACTIONS.length}`).toBe("auditedActions:4");
    expect(`appendHelperCallSites:${[...PANEL_MUTATIONS_SOURCE.matchAll(/appendPanelGovernanceEvent\(tx,/g)].length}`).toBe("appendHelperCallSites:3");
    expect(`pinnedImports:${surface().allImports.length}`).toBe("pinnedImports:24");
    expect(`transactionWriteSites:${surface().transactionWriteSites.length}`).toBe("transactionWriteSites:4");
    expect(`reachableLocalFunctions:${surface().reachableLocalFunctions.join(",")}`).toBe("reachableLocalFunctions:appendPanelGovernanceEvent,deleteWorkspaceReviewPanel,isAssignmentActive,putWorkspaceReviewPanel,readAndParsePanel,readVotesForRevision,submitWorkspaceReviewPanelVote,toWorkspacePanelDto");
    expect(`directWriteCalls:${surface().directWriteCalls.length}`).toBe("directWriteCalls:0");
    expect(`unresolvedLocalCalls:${surface().unresolvedLocalCalls.length}`).toBe("unresolvedLocalCalls:0");
  });

  it("the decision-inventory counts", () => {
    const uniquePairs = new Set(DISCOVERED_REJECTION_SITES.map((x) => `${x.operation}:${x.reasonExpr}`)).size;
    expect(
      [
        `returnSites:${DISCOVERED_REJECTION_SITES.length}`,
        `uniqueOperationReasonPairs:${uniquePairs}`,
        `duplicateReasonSites:${DISCOVERED_REJECTION_SITES.length - uniquePairs}`,
        `writeFailedCatchSites:${WRITE_FAILED_SITES.length}`,
        `decisionSites:${DECISION_SITES.length}`,
        `expandedObligations:${EXPANDED_OBLIGATIONS.length}`,
        `executableObligations:${EXECUTABLE_OBLIGATIONS.length}`,
        `excludedSites:${Object.keys(STRUCTURALLY_UNREACHABLE_SITES).length}`,
        `registeredCases:${REJECTION_CASES.length}`,
        `authDenialReasons:${AUTH_DENIAL_REASONS_FROM_SOURCE.length}`,
        `returnCensusEntries:${RETURN_CENSUS().length}`,
        `resultAssignments:${RESULT_ASSIGNMENTS.length}`,
        `assignmentDecisionSites:${ASSIGNMENT_DECISION_SITES.length}`,
      ].join(" ")
    ).toBe(
      [
        "returnSites:44",
        "uniqueOperationReasonPairs:39",
        "duplicateReasonSites:5",
        "writeFailedCatchSites:3",
        "decisionSites:41",
        "expandedObligations:59",
        "executableObligations:59",
        "excludedSites:0",
        "registeredCases:59",
        "authDenialReasons:7",
        "returnCensusEntries:53",
        "resultAssignments:3",
        "assignmentDecisionSites:0",
      ].join(" ")
    );
  });

  it("the proof-layer counts", () => {
    const equivalenceTotals = Object.values(EXPECTED_EQUIVALENT_SPLIT).reduce(
      (acc, v) => ({ proven: acc.proven + v.proven, documented: acc.documented + v.documented.length }),
      { proven: 0, documented: 0 }
    );
    expect(
      [
        `declaredWitnesses:${Object.keys(SITE_GUARD_FACTS).length}`,
        `instrumentedChannels:${INSTRUMENTED_EVENT_CHANNELS.length}`,
        `deleteChannels:${INSTRUMENTED_EVENT_CHANNELS.filter((c) => c.endsWith(".delete")).length}`,
        `requiredAtomicityCases:${Object.keys(REQUIRED_ATOMICITY_CASES).length}`,
        `provenanceSubjects:${PROVENANCE_SUBJECTS.length}`,
        `provenEquivalents:${equivalenceTotals.proven}`,
        `documentationOnlyAlternatives:${equivalenceTotals.documented}`,
        `harnessMechanismIds:${HARNESS_MECHANISM_IDS.size}`,
        `twinDirectedChecks:${REASON_TWIN_PAIRS.length}`,
        `twinUnorderedPairs:${new Set(REASON_TWIN_PAIRS.map(([a, b, r]) => `${[a, b].sort().join("|")}::${r}`)).size}`,
        `governanceEventAddSites:${countGovernanceEventAddSites().length}`,
      ].join(" ")
    ).toBe(
      [
        "declaredWitnesses:15",
        "instrumentedChannels:18",
        "deleteChannels:4",
        "requiredAtomicityCases:8",
        "provenanceSubjects:4",
        "provenEquivalents:18",
        "documentationOnlyAlternatives:12",
        "harnessMechanismIds:6",
        "twinDirectedChecks:14",
        "twinUnorderedPairs:7",
        "governanceEventAddSites:5",
      ].join(" ")
    );
  });

  /**
   * ─── R10 — SCOPE IS A PROPERTY OF THE TREE, NOT OF git HISTORY ──────────────────────────────────
   *
   * Two wrong versions preceded this one, and both are worth recording.
   *
   *   R9 hardcoded the three filenames in an array and deferred verification to "the pre-push gate, which
   *   is the only place git is available". Both halves were wrong: swapping in a nonexistent path
   *   survived, and there IS no pre-push gate in this repo (no `.husky`; the Quality Gate workflow runs
   *   tsc/lint/build/jest only).
   *
   *   R10's first attempt asked `git diff --name-only abd032a5 HEAD` and recorded a harness violation
   *   when git could not answer. Fail-closed, but ENVIRONMENT-DEPENDENT: CI checks out shallow, the merge
   *   base is absent, the violation fires, and the pinned acknowledgement count moved 8 -> 9 — a red
   *   Quality Gate on a green local run. A pinned absolute count that differs between a full clone and a
   *   shallow checkout is a defect in the proof, not in the product.
   *
   * What "audit-reader scope is closed" MEANS is a property of the source tree, and it holds identically
   * in any checkout: the four action strings exist only in the audited module, and no reader, display map,
   * backfill or audit API references them. That is what is asserted. The git-derived file list remains as
   * a bonus when the merge base happens to be present, and contributes to no pinned count.
   */
  const changedFilesFromGit = (): { files: string[]; gitAvailable: boolean } => {
    try {
      const out = execFileSync("git", ["diff", "--name-only", "abd032a5", "HEAD"], { cwd: joinPath(__dirname, "..", "..", ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { files: out.split("\n").map((l) => l.trim()).filter(Boolean).sort(), gitAvailable: true };
    } catch {
      return { files: [], gitAvailable: false };
    }
  };

  const repoRootPath = () => joinPath(__dirname, "..", "..", "..");
  const readIfPresent = (relative: string): string | null => {
    try {
      return readFileSync(joinPath(repoRootPath(), relative), "utf8");
    } catch {
      return null;
    }
  };

  it("the four new actions exist ONLY in the audited module — audit-reader scope is closed, in any checkout", () => {
    const owners: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
        const full = joinPath(directory, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (PANEL_MUTATION_ACTIONS.some((action) => readFileSync(full, "utf8").includes(`"${action}"`))) owners.push(full.slice(repoRootPath().length + 1));
      }
    };
    for (const top of ["lib", "app", "components"]) walk(joinPath(repoRootPath(), top));
    expect(owners.sort()).toEqual([
      "lib/workspaces/__tests__/workspaceReviewPanelMutations.spec.ts",
      "lib/workspaces/workspaceReviewPanelMutations.ts",
    ]);
  });

  it("no audit READER, display map, backfill or audit API mentions any of the four actions", () => {
    const readers = [
      "lib/governance/auditLog.ts",
      "lib/governance/governanceBackfill.ts",
      "lib/workspaces/listWorkspaceAuditEvents.ts",
      "app/api/governance/audit/route.ts",
      "app/api/governance/audit/backfill/route.ts",
    ];
    const present = readers.filter((r) => readIfPresent(r) !== null);
    expect(`readerFilesFound:${present.length}`).toBe(`readerFilesFound:${readers.length}`);
    const mentions = present.filter((r) => PANEL_MUTATION_ACTIONS.some((action) => (readIfPresent(r) as string).includes(action)));
    expect(`readersMentioningTheNewActions:${mentions.join(",")}`).toBe("readersMentioningTheNewActions:");
    // NEGATIVE CONTROL — the predicate can say yes, against the module that DOES own them
    const owner = readIfPresent("lib/workspaces/workspaceReviewPanelMutations.ts") as string;
    expect(`ownerMentionsThem:${PANEL_MUTATION_ACTIONS.every((a) => owner.includes(a))}`).toBe("ownerMentionsThem:true");
  });

  it("L8 — the tree walk fails CLOSED: a planted action string is DETECTED, so it can never yield a false pass", () => {
    // the mechanism, exercised directly on synthetic input rather than by writing a file into the repo
    const detect = (sources: readonly { path: string; text: string }[]) =>
      sources.filter((f) => PANEL_MUTATION_ACTIONS.some((a) => f.text.includes(`"${a}"`))).map((f) => f.path);
    expect(detect([{ path: "lib/x/__scratch.ts", text: 'export const P = "adaptive_review_panel_created";' }])).toEqual(["lib/x/__scratch.ts"]);
    expect(detect([{ path: "lib/x/clean.ts", text: "export const P = 1;" }])).toEqual([]);
    // so the only failure direction is a FALSE RED, never a false green — which is what L8 records
    expect(`failsClosed:${detect([{ path: "a", text: '"adaptive_review_panel_vote_cast"' }]).length > 0}`).toBe("failsClosed:true");
  });

  it("L9 — the commentPresent boundary is the ROUTE's, and the module's own signature admits the divergence", () => {
    // production's expression and the indistinguishable alternative agree on every value the route emits
    for (const raw of ["", "   ", "\t\n "]) {
      const parsed = parseSubmitAdaptiveReviewVoteRequest({ status: "approved", panelRevision: 1, comment: raw });
      expect(`parsed:${parsed.ok}`).toBe("parsed:true");
      if (parsed.ok) expect(`normalised:${JSON.stringify(parsed.value.comment)}`).toBe("normalised:undefined");
    }
    // and they DISAGREE on the one value the route can never produce — which is why L9 exists
    const empty = "" as string | undefined;
    expect(`boolean:${Boolean(empty)} notUndefined:${empty !== undefined}`).toBe("boolean:false notUndefined:true");
  });

  it("BONUS, skipped without ceremony when the merge base is absent: git agrees the change is three files", () => {
    const { files, gitAvailable } = changedFilesFromGit();
    if (!gitAvailable) {
      // a shallow checkout (CI) has no merge base. This contributes to NO pinned count — pinning an
      // absolute number here is what turned a green local run into a red Quality Gate.
      expect("gitScopeCheck:unavailable").toBe("gitScopeCheck:unavailable");
      return;
    }
    expect(files).toEqual([
      "docs/operations/workspace-governance-canary-runbook.md",
      "lib/workspaces/__tests__/workspaceReviewPanelMutations.spec.ts",
      "lib/workspaces/workspaceReviewPanelMutations.ts",
    ]);
  });
});

/**
 * ─── R9 §59/§60/§62 — PROSE COUNTS ARE CHECKED AGAINST DERIVED ONES, AND RETRACTED CLAIMS STAY GONE ─
 *
 * Four of R8's defects were numbers in comments that had been correct once. A count written in prose
 * has no test, so it rots silently — and this series has now produced that failure five times across
 * three different numbers. Every count this file states in prose is extracted from its own source and
 * compared with the derived value, and phrases that were RETRACTED are asserted absent, so restoring
 * one fails CI rather than waiting for a reviewer to notice.
 */
describe("documented counts and retracted claims (§59/§60)", () => {
  // built lazily: `PANEL_MUTATIONS_SOURCE` is declared further down the file, so reading it during
  // this describe's own evaluation would hit the temporal dead zone.
  const sources = (): Readonly<Record<"spec" | "production" | "runbook", string>> => ({
    spec: readFileSync(__filename, "utf8"),
    production: PANEL_MUTATIONS_SOURCE,
    runbook: readFileSync(joinPath(__dirname, "..", "..", "..", "docs", "operations", "workspace-governance-canary-runbook.md"), "utf8"),
  });

  /**
   * ─── R10 — PROSE COUNTS ARE DISCOVERED, NOT LISTED ──────────────────────────────────────────────
   *
   * R9 listed six claims and asserted "every number this file states in prose is extracted from its own
   * source and compared with the derived value". That was false: five other prose numbers were
   * unchecked and could be falsified silently. A list of claims to check is the same shape as a list of
   * write forms to recognise — it omits what nobody thought of.
   *
   * The polarity is inverted. Any prose number that matters carries an inline marker
   * `[[count:<id>=<value>]]`, the scan DISCOVERS every marker in the file, and a marker with no
   * registered deriver — or a value that disagrees with its deriver — fails. So the registry cannot
   * silently fall behind the prose: a new marker demands a deriver, and a changed number is caught.
   */
  const DERIVERS: Readonly<Record<string, () => string>> = Object.freeze({
    executableObligations: () => String(EXECUTABLE_OBLIGATIONS.length),
    expandedObligations: () => String(EXPANDED_OBLIGATIONS.length),
    registeredCases: () => String(REJECTION_CASES.length),
    returnSites: () => String(DISCOVERED_REJECTION_SITES.length),
    addSites: () => String(countGovernanceEventAddSites().length),
    instrumentedChannels: () => String(INSTRUMENTED_EVENT_CHANNELS.length),
    deleteChannels: () => String(INSTRUMENTED_EVENT_CHANNELS.filter((c) => c.endsWith(".delete")).length),
    twinUnorderedPairs: () => String(new Set(REASON_TWIN_PAIRS.map(([a, b, r]) => `${[a, b].sort().join("|")}::${r}`)).size),
    twinSites: () => String(new Set(REASON_TWIN_PAIRS.flatMap(([a, b]) => [a, b])).size),
    twinDirectedChecks: () => String(REASON_TWIN_PAIRS.length),
    declaredWitnesses: () => String(Object.keys(SITE_GUARD_FACTS).length),
    guardOperandReaders: () => String(Object.keys(GUARD_OPERAND_READERS).length),
    atomicityCases: () => String(Object.keys(REQUIRED_ATOMICITY_CASES).length),
    pinnedImports: () => String(deriveProductionWriteSurface(PANEL_MUTATIONS_SOURCE, Object.keys(PANEL_OPERATION_FUNCTIONS)).allImports.length),
    provenanceSubjects: () => String(PROVENANCE_SUBJECTS.length),
    mechanismIds: () => String(HARNESS_MECHANISM_IDS.size),
    auditedOperations: () => String(Object.keys(PANEL_OPERATION_FUNCTIONS).length),
    auditedActions: () => String(PANEL_MUTATION_ACTIONS.length),
    equivalenceEntries: () => String(Object.values(EXPECTED_EQUIVALENT_SPLIT).reduce((n, v) => n + v.proven + v.documented.length, 0)),
  });

  const discoveredMarkers = () => {
    const found: { id: string; value: string; line: number }[] = [];
    sources().spec.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/\[\[count:([A-Za-z]+)=([0-9]+)\]\]/g)) found.push({ id: match[1], value: match[2], line: index + 1 });
    });
    return found;
  };

  it("R10 — every DISCOVERED prose-count marker has a deriver and agrees with it", () => {
    const markers = discoveredMarkers();
    expect(`markersFound:${markers.length > 8}`).toBe("markersFound:true");
    const orphans = markers.filter((m) => !(m.id in DERIVERS)).map((m) => `${m.id}@${m.line}`);
    expect(`markersWithNoDeriver:${orphans.join(",")}`).toBe("markersWithNoDeriver:");
    const wrong = markers.filter((m) => DERIVERS[m.id]() !== m.value).map((m) => `${m.id}@${m.line}:written=${m.value} derived=${DERIVERS[m.id]()}`);
    expect(`markersDisagreeingWithSource:${wrong.join(" | ")}`).toBe("markersDisagreeingWithSource:");
  });

  it("R10 — the marker scan is not vacuous, and a wrong or unregistered marker IS reported", () => {
    const scan = (text: string) => [...text.matchAll(/\[\[count:([A-Za-z]+)=([0-9]+)\]\]/g)].map((m) => ({ id: m[1], value: m[2] }));
    // the probe markers are ASSEMBLED, never written literally: a literal here would be discovered by the
    // scan as a real claim about this file, which is exactly what happened on the first attempt.
    const marker = (id: string, value: string) => `[${"["}count:${id}=${value}]${"]"}`;
    expect(scan(`there are ${marker("executableObligations", "59")} of them`)).toEqual([{ id: "executableObligations", value: "59" }]);
    expect(scan("no markers here")).toEqual([]);
    // a wrong value is caught
    const wrongOne = scan(marker("executableObligations", "99"))[0];
    expect(`caught:${DERIVERS[wrongOne.id]() !== wrongOne.value}`).toBe("caught:true");
    // an unregistered id is caught
    expect(`orphanCaught:${!("aCountNobodyRegistered" in DERIVERS)}`).toBe("orphanCaught:true");
  });

  it("R10 — every deriver is USED by at least one marker, so the registry cannot carry dead entries", () => {
    const used = new Set(discoveredMarkers().map((m) => m.id));
    expect(`deriversWithNoMarker:${Object.keys(DERIVERS).filter((id) => !used.has(id)).sort().join(",")}`).toBe("deriversWithNoMarker:");
  });

  /**
   * §59 — CLAIMS THAT WERE RETRACTED. Each was stated, found false, and withdrawn. Restoring the
   * wording fails here. The compiled-output claim is the one R8 got wrong: production changed twice
   * AFTER the audit writes landed (`reviewerCount`/`schemaId`/`answerShape`, then `panelRevision`), so
   * The compiled-output claim is the one R8 got wrong (see RETRACTED_PHRASES entry 1): production changed
   * twice AFTER the audit writes landed, so the universal form was false. The bounded form is true and is
   * what the PR body now says.
   */
  const RETRACTED_PHRASES: readonly { phrase: string; why: string }[] = [
    { phrase: "byte-identical across every reviewed head", why: "false: production changed twice after the audit writes landed" },
    { phrase: "leaving 56 executable", why: "false since R5 made all three excluded sites reachable; the count is 59" },
    { phrase: "3 are classified STRUCTURALLY UNREACHABLE", why: "false since R5; the exclusion map is empty" },
    { phrase: "14 reason-twin pairs", why: "conflates 14 directed checks with 7 unordered pairs" },
    { phrase: "two other governance-event writers", why: "there are five `.add(` sites, not two" },
    { phrase: "every hostile value is read from a pre-call snapshot", why: "about 20 of 93 hostile entries are, correctly, literals" },
  ];

  /**
   * ─── R10 — THE RETRACTED WORDING LIVES IN EXACTLY ONE PLACE ────────────────────────────────────
   *
   * R9 used a line-level `[RETRACTED]` marker as the licence to quote a withdrawn claim. That is an
   * opt-out, and an opt-out can be taken: C restated the compiled-output claim verbatim on a line that
   * also carried the marker and the suite exited 0. Requiring the marker to PRECEDE the phrase does not
   * help either — writing the marker first is the natural way to write the exploit, and I confirmed that
   * "fix" leaves the escape open.
   *
   * There is no marker now. A retracted phrase may appear ONLY inside the table below, which is the
   * single record of what was withdrawn and why. Every other mention anywhere in the spec, in production
   * or in the runbook fails, regardless of how the line is decorated. The doc comments that used to
   * quote these phrases now refer to the table instead.
   */

  /** The line range of the RETRACTED_PHRASES table — the only place the wording may appear. */
  // lazy: `sources()` reads PANEL_MUTATIONS_SOURCE, declared further down the file
  const tableRange = () => {
    const lines = readFileSync(__filename, "utf8").split("\n");
    const start = lines.findIndex((l) => l.includes("const RETRACTED_PHRASES: readonly"));
    const end = lines.findIndex((l, i) => i > start && l.trim() === "];");
    return { start: start + 1, end: end + 1 };
  };

  it("the table's own line range was located, so the exemption is a real region and not the whole file", () => {
    const range = tableRange();
    expect(`tableLocated:${range.start > 0 && range.end > range.start}`).toBe("tableLocated:true");
    expect(`tableIsSmall:${range.end - range.start < 20}`).toBe("tableIsSmall:true");
  });

  it.each(RETRACTED_PHRASES.map((r) => [r.phrase, r.why] as const))('the retracted claim "%s" appears ONLY in the table that records it (%s)', (phrase) => {
    const offenders: string[] = [];
    const range = tableRange();
    for (const [name, text] of Object.entries(sources())) {
      text.split("\n").forEach((line, index) => {
        if (!line.includes(phrase)) return;
        const lineNumber = index + 1;
        const insideTable = name === "spec" && lineNumber >= range.start && lineNumber <= range.end;
        if (!insideTable) offenders.push(`${name}:${lineNumber}`);
      });
    }
    expect(`retractedClaimOutsideItsTable:${offenders.join(",")}`).toBe("retractedClaimOutsideItsTable:");
  });

  it("every retracted phrase IS still quoted somewhere — the check is over real strings, not an empty list", () => {
    const missing = RETRACTED_PHRASES.filter(({ phrase }) => !Object.values(sources()).some((text) => text.includes(phrase))).map((r) => r.phrase);
    expect(`retractedPhrasesNotFoundAnywhere:${missing.join(" | ")}`).toBe("retractedPhrasesNotFoundAnywhere:");
    expect(RETRACTED_PHRASES.length).toBe(6);
  });

  it("R10 — NO decoration excuses a restatement: the region is the only exemption", () => {
    // the phrase is taken FROM the table, never written here — a literal copy on these lines would
    // itself be an occurrence outside the table, which is how the first version of this control failed
    const phrase = RETRACTED_PHRASES[0].phrase;
    const outsideTable = (line: string) => line.includes(phrase);
    // every decoration C's escape used, and the one my first fix used, are all still occurrences
    for (const decorated of [
      `production compiled output is ${phrase}`,
      `// [RETRACTED] historical note. Production compiled output is ${phrase}.`,
      `${phrase} [RETRACTED] historical note`,
      `/* [RETRACTED] */ ${phrase}`,
    ]) {
      expect(`decoratedStillCounts:${outsideTable(decorated)}`).toBe("decoratedStillCounts:true");
    }
    expect(`aLineWithoutIt:${outsideTable("a line with no claim")}`).toBe("aLineWithoutIt:false");
  });
});

describe("governance-event `.add()` write sites — derived from the repository (§60)", () => {
  it("there are exactly FIVE, and they are these — a sixth fails here instead of outdating a comment", () => {
    const sites = countGovernanceEventAddSites();
    expect(sites).toEqual([
      "app/api/governance/review/route.ts:345",
      "lib/firestore/runs.ts:721",
      "lib/governance/evaluateAndStore.ts:88",
      "lib/governance/governanceBackfill.ts:63",
      "lib/firestore/runs.ts:963",
    ].sort());
    expect(`addSiteCount:${sites.length}`).toBe("addSiteCount:5");
  });

  it("the R8 count of FOUR was wrong because it searched only `lib/` — the app route is the fifth", () => {
    const sites = countGovernanceEventAddSites();
    expect(sites.filter((s) => s.startsWith("lib/")).length).toBe(4);
    expect(sites.filter((s) => s.startsWith("app/"))).toEqual(["app/api/governance/review/route.ts:345"]);
  });

  it("the detector is not vacuously blind: it finds nothing in a tree with no such call, and finds one when there is one", () => {
    // a direct unit check of the pattern the walker uses, so an empty result cannot be a broken regex
    const pattern = /\.collection\("governanceEvents"\)\s*\.add\(/g;
    expect([...'const x = ref.collection("governanceEvents")\n  .add({ action: "y" });'.matchAll(pattern)].length).toBe(1);
    expect([...'const x = ref.collection("governanceEvents").doc(id).set({});'.matchAll(pattern)].length).toBe(0);
    expect([...'const x = ref.collection("humanReviewVotes").add({});'.matchAll(pattern)].length).toBe(0);
  });
});

describe("citation resolver — typed references, positive and negative controls (§50)", () => {
  it("§50 POSITIVE — a real site id, a real production symbol, a real test title and a real mechanism all resolve", () => {
    expect(unresolvedCitations("site:cancel#reject-12 returns stale_revision")).toEqual([]);
    expect(unresolvedCitations("symbol:parseAdaptiveHumanReviewPanel yields malformed")).toEqual([]);
    expect(unresolvedCitations("symbol:buildNextAdaptiveHumanReviewPanel derives revision")).toEqual([]);
    // R8 REJECTED this one, and it is real: `parseGovernanceRecord` is imported by the audited module
    expect(unresolvedCitations("symbol:parseGovernanceRecord parses the record")).toEqual([]);
    expect(unresolvedCitations('test:"§17 — the intrinsic escape hatch is PINNED by content, so it cannot be widened to swallow a helper" proves it')).toEqual([]);
    expect(unresolvedCitations("mechanism:final-store-delta-oracle is the authority")).toEqual([]);
  });

  it("§50 NEGATIVE — FREE PROSE carries no typed citation and is rejected, however plausible it reads", () => {
    // R8's resolver ACCEPTED all three of these, because none contains a verb-prefixed token
    expect(unresolvedCitations("equal because the moon is made of cheese")).toEqual(["<no-typed-citation>"]);
    expect(unresolvedCitations("this is obviously equivalent, as any reader can see")).toEqual(["<no-typed-citation>"]);
    expect(unresolvedCitations("the builder guarantees it")).toEqual(["<no-typed-citation>"]);
  });

  it("§50 NEGATIVE — a RANDOM VERB-PREFIXED SENTENCE is prose, not a citation", () => {
    // the exact string R7 used to defeat the token check. Under the typed model it is simply untyped.
    expect(unresolvedCitations("buildAbsolutelyNothing: equal because the moon is made of cheese")).toEqual(["<no-typed-citation>"]);
    expect(unresolvedCitations("validateNothingAtAll forces equality")).toEqual(["<no-typed-citation>"]);
    // and the same fabrication AS a typed reference is rejected on resolution
    expect(unresolvedCitations("symbol:buildAbsolutelyNothing forces equality")).toEqual(["symbol:buildAbsolutelyNothing"]);
  });

  it("§50 NEGATIVE — a nonexistent site id is rejected", () => {
    expect(unresolvedCitations("site:cancel#reject-99 guarantees it")).toEqual(["site:cancel#reject-99"]);
  });

  it("§50 NEGATIVE — a nonexistent source symbol is rejected", () => {
    expect(unresolvedCitations("symbol:parseAdaptiveHumanReviewPanelV2 rejects it")).toEqual(["symbol:parseAdaptiveHumanReviewPanelV2"]);
  });

  it("§50 NEGATIVE — a symbol in a module OUTSIDE the pinned universe is rejected", () => {
    // `checkAndIncrementUsageForRun` is a real exported symbol in this repo, in a module the audited
    // module does not import. The universe is the pinned dependency set, not "anything in the repo".
    expect(unresolvedCitations("symbol:checkAndIncrementUsageForRun enforces the plan")).toEqual(["symbol:checkAndIncrementUsageForRun"]);
    expect(CITATION_SYMBOL_UNIVERSE.symbols.has("checkAndIncrementUsageForRun")).toBe(false);
  });

  it("§50 NEGATIVE — a NONEXISTENT test title is rejected, and a STALE renamed one no longer resolves", () => {
    expect(unresolvedCitations('test:"a test that was never written" proves it')).toEqual(['test:a test that was never written']);
    // the R8-era name of a test this round renamed: it is gone, so a citation to it must fail
    expect(unresolvedCitations('test:"atomicity coverage census (§51/§52)" proves it')).toEqual(['test:atomicity coverage census (§51/§52)']);
    expect(unresolvedCitations('test:"the matrix is COMPLETE: the event has no field outside it, so a newly added field cannot escape the audit" proves it')).toEqual(['test:the matrix is COMPLETE: the event has no field outside it, so a newly added field cannot escape the audit']);
  });

  it("§50 NEGATIVE — a fabricated mechanism ID is rejected even though it is correctly typed", () => {
    expect(unresolvedCitations("mechanism:a-mechanism-that-does-not-exist is the authority")).toEqual(["mechanism:a-mechanism-that-does-not-exist"]);
  });

  it("§49 — deleting or renaming a mechanism invalidates its citation: the registry is the only source", () => {
    expect([...HARNESS_MECHANISM_IDS].sort()).toEqual([
      "append-only-violation-ledger",
      "atomicity-injection-telemetry",
      "final-store-delta-oracle",
      "guard-fact-operand-falsifier",
      "local-call-graph-write-census",
      "log-authority-static-ban",
    ]);
    expect(unresolvedCitations("mechanism:final-store-delta-oracle")).toEqual([]);
    expect(unresolvedCitations("mechanism:final-store-delta-oracle-v2")).toEqual(["mechanism:final-store-delta-oracle-v2"]);
  });

  it("§48 — the symbol universe is the PRODUCTION MODULE plus its PINNED IMPORTS, and nothing was unreadable", () => {
    expect(`unreadableCitedModules:${CITATION_SYMBOL_UNIVERSE.unreadable.join(",")}`).toBe("unreadableCitedModules:");
    // R8 hardcoded eight module paths while the dependency pin knew twenty-four imports
    expect(`modulesInUniverse:${CITATION_SYMBOL_UNIVERSE.modules.length >= 20}`).toBe("modulesInUniverse:true");
    expect(CITATION_SYMBOL_UNIVERSE.symbols.size).toBeGreaterThan(100);
    for (const real of [
      "parseAdaptiveHumanReviewPanel", "buildAdaptiveHumanReviewVote", "resolveWorkspaceReviewTarget",
      "validateMembershipBinding", "validateAdaptiveReviewCommentAndConditions", "isValidAssignmentTarget",
      "parseGovernanceRecord", "roleHasCapability", "putWorkspaceReviewPanel", "aggregateAdaptiveReviewVotes",
    ]) {
      expect(`resolvable:${real}:${CITATION_SYMBOL_UNIVERSE.symbols.has(real)}`).toBe(`resolvable:${real}:true`);
    }
  });

  it("§47 — the test-title registry is populated from this spec's own AST and contains this very test", () => {
    // 292 distinct string-literal titles at the time of writing; `it.each` expansions share one title,
    // which is why this is below the reported test count. Bounded, not pinned, so adding a test is not
    // a failure — the load-bearing half is the self-reference below and the stale-title control above.
    expect(DECLARED_TEST_TITLES.size).toBeGreaterThan(250);
    expect(DECLARED_TEST_TITLES.has("§47 — the test-title registry is populated from this spec's own AST and contains this very test")).toBe(true);
  });

  /**
   * §51 — WHAT A RESOLVED CITATION DOES NOT PROVE. Stated as an executable statement so the limitation
   * is part of the suite rather than a sentence in a PR body. `symbol:putWorkspaceReviewPanel` resolves,
   * and says nothing whatever about any equivalence claim it might be attached to.
   */
  it("§51 — a resolved citation proves only that the artifact EXISTS, never that it establishes the claim", () => {
    const nonsenseWithARealCitation = "symbol:putWorkspaceReviewPanel, therefore 1 === 2";
    expect(unresolvedCitations(nonsenseWithARealCitation)).toEqual([]);
    // the citation resolves; the claim is false. Claim validation is the mutation's job, not the resolver's.
    expect(`resolverAcceptsIt:${unresolvedCitations(nonsenseWithARealCitation).length === 0} claimIsTrue:${1 === (2 as number)}`).toBe("resolverAcceptsIt:true claimIsTrue:false");
  });
});

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
   * ─── R9 §16–§18 — THE CENSUS FOLLOWS THE LOCAL CALL GRAPH, INCLUDING THE EVENT HELPER ──────────
   *
   * R8 MAJOR: `deriveProductionWriteSurface` analysed only the functions named in `targetFunctions`,
   * so `appendPanelGovernanceEvent` — the helper that performs the panel audit write, and therefore
   * the single most likely place to introduce a forge-then-remove — contributed NOTHING to the write
   * surface. A `.delete()` added inside it was invisible to every census assertion.
   */
  it("§16 — the reachable-function graph INCLUDES appendPanelGovernanceEvent, the helper that writes the event", () => {
    const reachable = surface().reachableLocalFunctions;
    expect(reachable).toContain("appendPanelGovernanceEvent");
    // the roots themselves, so the graph is anchored where the audit scope is
    for (const root of Object.keys(PANEL_OPERATION_FUNCTIONS)) expect(reachable).toContain(root);
    // and it is a real closure, not just the roots
    expect(`graphIsLargerThanItsRoots:${reachable.length > Object.keys(PANEL_OPERATION_FUNCTIONS).length}`).toBe("graphIsLargerThanItsRoots:true");
  });

  it("§16 FALSIFIER — omitting the event helper from the graph loses a real write, so the graph is load-bearing", () => {
    // the same derivation run with the helper's own source REMOVED: the surviving surface no longer
    // reports the transactional `set` that writes the audit record, which is exactly what R8 shipped.
    const source = PANEL_MUTATIONS_SOURCE;
    const helperStart = source.indexOf("function appendPanelGovernanceEvent(");
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf("\n}\n", helperStart) + 3;
    const withoutHelperBody = `${source.slice(0, helperStart)}function appendPanelGovernanceEvent(tx: FirebaseFirestore.Transaction, runRef: FirebaseFirestore.DocumentReference, event: Readonly<Record<string, unknown>>): void { void tx; void runRef; void event; }\n${source.slice(helperEnd)}`;
    const blinded = deriveProductionWriteSurface(withoutHelperBody, Object.keys(PANEL_OPERATION_FUNCTIONS));
    // ATTRIBUTED write sites, not a method-name set: the audited operations write the canonical
    // document with `set` too, so only attribution can show the helper's own write is in the census.
    expect(surface().transactionWriteSites).toContain("appendPanelGovernanceEvent::set");
    expect(blinded.transactionWriteSites).not.toContain("appendPanelGovernanceEvent::set");
    expect(`realSites:${surface().transactionWriteSites.length} blindedSites:${blinded.transactionWriteSites.length}`).toBe(`realSites:${blinded.transactionWriteSites.length + 1} blindedSites:${blinded.transactionWriteSites.length}`);
  });

  it("§16 — every transactional write site is attributed to a reachable function, and the audit write is one of them", () => {
    const sites = surface().transactionWriteSites;
    const owners = [...new Set(sites.map((s) => s.split("::")[0]))];
    expect(owners.filter((o) => !surface().reachableLocalFunctions.includes(o))).toEqual([]);
    expect(sites).toEqual([
      "appendPanelGovernanceEvent::set",
      "deleteWorkspaceReviewPanel::set",
      "putWorkspaceReviewPanel::set",
      "submitWorkspaceReviewPanelVote::set",
    ]);
  });

  it("§17 — no call reachable from the audited operations is unresolvable, so the graph cannot silently stop", () => {
    expect(`unresolvedLocalCalls:${surface().unresolvedLocalCalls.join(" | ")}`).toBe("unresolvedLocalCalls:");
  });

  it("§17 FALSIFIER — a computed-callee call IS reported unresolved rather than skipped", () => {
    const synthetic = [
      "const writers: Record<string, (t: unknown) => void> = {};",
      "export async function putWorkspaceReviewPanel(args: { k: string }): Promise<void> {",
      "  writers[args.k](null);",
      "}",
    ].join("\n");
    const derived = deriveProductionWriteSurface(synthetic, ["putWorkspaceReviewPanel"]);
    expect(derived.unresolvedLocalCalls.map((c) => c.split("->")[0])).toEqual(["putWorkspaceReviewPanel"]);
    expect(`unresolvedCount:${derived.unresolvedLocalCalls.length}`).toBe("unresolvedCount:1");
  });

  it("§17 — the intrinsic escape hatch is PINNED by content, so it cannot be widened to swallow a helper", () => {
    expect([...ALLOWED_INTRINSIC_CALLEES].sort()).toEqual([
      "Array", "BigInt", "Boolean", "Date", "Error", "JSON", "Map", "Number", "Object", "Promise",
      "Set", "String", "Symbol", "isNaN", "parseFloat", "parseInt", "require", "structuredClone",
    ]);
    // NEGATIVE CONTROL: a local helper name is NOT an intrinsic, so it cannot be excused as one
    expect(ALLOWED_INTRINSIC_CALLEES).not.toContain("appendPanelGovernanceEvent");
  });

  it("§18 — the DELETE-capable channels are derived from the fake's real surface, not hardcoded as a number", () => {
    // every write method the census recognises has an instrumented channel for every mode the fake
    // models, so a delete through any of them is observed. Derived from the two lists, not restated.
    const modes = ["transaction", "direct", "batch", "bulkwriter"] as const;
    const missing = modes.filter((mode) => !INSTRUMENTED_EVENT_CHANNELS.includes(`${mode}.delete` as GovernanceEventChannel));
    expect(`modesWithoutADeleteChannel:${missing.join(",")}`).toBe("modesWithoutADeleteChannel:");
    expect(`deleteChannels:${INSTRUMENTED_EVENT_CHANNELS.filter((c) => c.endsWith(".delete")).sort().join(",")}`).toBe("deleteChannels:batch.delete,bulkwriter.delete,direct.delete,transaction.delete");
    expect(FIRESTORE_WRITE_METHODS).toContain("delete");
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
    expect(`attempted:${diagnosticAttemptedEventCount()}`).toBe("attempted:1");
  });

  it("a SHADOW run document's governanceEvents write is observed, and is not confused with the real run", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.set(eventRef(`${RUN_ID}-shadow`, "live-shadow"), { action: "LIVENESS" }));
    expect(governanceEventLog.map((o) => o.path)).toEqual([`runs/${RUN_ID}-shadow/governanceEvents/live-shadow`]);
    expect(`attempted:${diagnosticAttemptedEventCount()}`).toBe("attempted:1");
  });

  it("bulkwriter.set is observed AND lands in the store — R7 proved its absence made a whole surface silent", async () => {
    const w = mockAdminDb.bulkWriter();
    await w.set(eventRef(RUN_ID, "bulk-1"), { action: "LIVENESS" });
    await w.close();
    expect(`observed:${seen("bulkwriter.set").length} stored:${stores.governanceEvents.has(`${RUN_ID}::bulk-1`)}`).toBe("observed:1 stored:true");
  });

  it("transaction.create", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.create(eventRef(RUN_ID, "live-tx-create"), { action: "LIVENESS" }));
    expect(`observed:${seen("transaction.create").length} committed:${diagnosticLandedEventObservations().length}`).toBe("observed:1 committed:1");
  });

  it("batch.set", async () => {
    const b = mockAdminDb.batch();
    b.set(eventRef(RUN_ID, "live-batch-set"), { action: "LIVENESS" });
    await b.commit();
    expect(`observed:${seen("batch.set").length} committed:${diagnosticLandedEventObservations().length}`).toBe("observed:1 committed:1");
  });

  it("batch.update", async () => {
    const b = mockAdminDb.batch();
    b.update(eventRef(RUN_ID, "live-batch-update"), { action: "LIVENESS" });
    await b.commit();
    expect(`observed:${seen("batch.update").length}`).toBe("observed:1");
  });

  it("a CollectionReference.add() write is observed — the idiom the other governance-event writers use", async () => {
    await mockAdminDb.collection("runs").doc(RUN_ID).collection("governanceEvents").add({ action: "LIVENESS" });
    expect(`observed:${seen("direct.set").length} committed:${diagnosticLandedEventObservations().length}`).toBe("observed:1 committed:1");
  });

  /**
   * ─── R9 §19/§20 — EVERY DELETE CHANNEL IS OBSERVED AND REMOVES THE DOCUMENT FROM THE STORE ───
   *
   * R8 MAJOR: all five delete sites recorded nothing. The store mutation was always real — which is
   * why the final-state diff catches a write-then-delete — but "this fake models Transaction.delete"
   * was an unfalsifiable claim, and the log-based assertions that still dominated the suite were
   * blind to a removal by construction. Each case asserts BOTH halves: the channel observed it, and
   * the canonical path is gone from the final state.
   */
  const seedEventDirectly = (id: string) => { stores.governanceEvents.set(`${RUN_ID}::${id}`, { action: "LIVENESS", byUid: OWNER_UID }); };
  const eventStillStored = (id: string) => stores.governanceEvents.has(`${RUN_ID}::${id}`);

  it("direct.delete is observed AND removes the document", async () => {
    seedEventDirectly("del-direct");
    await eventRef(RUN_ID, "del-direct").delete();
    expect(`observed:${seen("direct.delete").length} committed:${seen("direct.delete")[0]?.committed} op:${seen("direct.delete")[0]?.op} path:${seen("direct.delete")[0]?.path} stillStored:${eventStillStored("del-direct")}`)
      .toBe(`observed:1 committed:true op:delete path:runs/${RUN_ID}/governanceEvents/del-direct stillStored:false`);
  });

  it("transaction.delete is observed AND removes the document", async () => {
    seedEventDirectly("del-tx");
    await mockAdminDb.runTransaction(async (tx: any) => tx.delete(eventRef(RUN_ID, "del-tx")));
    expect(`observed:${seen("transaction.delete").length} committed:${seen("transaction.delete")[0]?.committed} stillStored:${eventStillStored("del-tx")}`).toBe("observed:1 committed:true stillStored:false");
  });

  it("batch.delete is observed AND removes the document", async () => {
    seedEventDirectly("del-batch");
    const b = mockAdminDb.batch();
    b.delete(eventRef(RUN_ID, "del-batch"));
    expect(`beforeCommit committed:${seen("batch.delete")[0]?.committed} stillStored:${eventStillStored("del-batch")}`).toBe("beforeCommit committed:false stillStored:true");
    await b.commit();
    expect(`observed:${seen("batch.delete").length} committed:${seen("batch.delete")[0]?.committed} stillStored:${eventStillStored("del-batch")}`).toBe("observed:1 committed:true stillStored:false");
  });

  it("bulkwriter.delete is observed AND removes the document", async () => {
    seedEventDirectly("del-bulk");
    const w = mockAdminDb.bulkWriter();
    await w.delete(eventRef(RUN_ID, "del-bulk"));
    await w.close();
    expect(`observed:${seen("bulkwriter.delete").length} committed:${seen("bulkwriter.delete")[0]?.committed} stillStored:${eventStillStored("del-bulk")}`).toBe("observed:1 committed:true stillStored:false");
  });

  it("a delete ABORTED with its transaction neither removes the document nor counts as committed", async () => {
    seedEventDirectly("del-aborted");
    throwOnSetCollection.value = "humanReviewPanel";
    await expect(mockAdminDb.runTransaction(async (tx: any) => {
      tx.delete(eventRef(RUN_ID, "del-aborted"));
      tx.set(mockAdminDb.collection("runs").doc(RUN_ID).collection("humanReviewPanel").doc("current"), { kind: "x" });
    })).rejects.toThrow("modelled transactional write failure");
    expect(`observed:${seen("transaction.delete").length} committed:${seen("transaction.delete")[0]?.committed} stillStored:${eventStillStored("del-aborted")}`).toBe("observed:1 committed:false stillStored:true");
  });

  it("a delete of a NON-event document outside governanceEvents is correctly NOT classified as a governance event", async () => {
    stores.humanReviewVotes.set(`${RUN_ID}::ordinary`, { kind: "adaptive_human_review_vote", status: "approved" });
    await mockAdminDb.collection("runs").doc(RUN_ID).collection("humanReviewVotes").doc("ordinary").delete();
    expect(`observed:${seen("direct.delete").length} stillStored:${stores.humanReviewVotes.has(`${RUN_ID}::ordinary`)}`).toBe("observed:0 stillStored:false");
  });

  it("a delete of an AUDIT-SHAPED document in another collection IS classified, so no collection is a silent sink", async () => {
    stores.humanReviewAssignment.set(`${RUN_ID}::forged`, { action: "adaptive_review_panel_created", byUid: "attacker" });
    await mockAdminDb.collection("runs").doc(RUN_ID).collection("humanReviewAssignment").doc("forged").delete();
    const o = seen("direct.delete")[0];
    expect(`observed:${seen("direct.delete").length} classifiedBy:${o?.classifiedBy} action:${o?.action}`).toBe("observed:1 classifiedBy:audit-shaped-stored-doc action:adaptive_review_panel_created");
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
    // R9 §20 — a delete exerciser seeds the document DIRECTLY into the store (not through an
    // observed write channel), so the single observation the assertion counts is the delete's own.
    "direct.delete": async () => { const id = nextId(); stores.governanceEvents.set(`${RUN_ID}::${id}`, { action: "X" }); await eventRef(RUN_ID, id).delete(); },
    "transaction.delete": async () => { const id = nextId(); stores.governanceEvents.set(`${RUN_ID}::${id}`, { action: "X" }); await mockAdminDb.runTransaction(async (tx: any) => tx.delete(eventRef(RUN_ID, id))); },
    "batch.delete": async () => { const id = nextId(); stores.governanceEvents.set(`${RUN_ID}::${id}`, { action: "X" }); const b = mockAdminDb.batch(); b.delete(eventRef(RUN_ID, id)); await b.commit(); },
    "bulkwriter.delete": async () => { const id = nextId(); stores.governanceEvents.set(`${RUN_ID}::${id}`, { action: "X" }); const w = mockAdminDb.bulkWriter(); await w.delete(eventRef(RUN_ID, id)); await w.close(); },
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
    expect(INSTRUMENTED_EVENT_CHANNELS.length).toBe(18);
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
    expect(`observedActor:${diagnosticLandedEventObservations()[0]?.actor} storedActor:${(stores.governanceEvents.get(`${RUN_ID}::snap`) as { byUid?: string })?.byUid}`).toBe("observedActor:attacker-uid storedActor:attacker-uid");
  });

  it("a transaction.update write into governanceEvents IS classified COMMITTED — the identity test could never see it", async () => {
    await mockAdminDb.runTransaction(async (tx: any) => tx.update(eventRef(RUN_ID, "upd"), { action: "adaptive_review_panel_cancelled", byUid: OWNER_UID }));
    expect(`attempted:${diagnosticAttemptedEventCount()} committed:${diagnosticLandedEventObservations().length}`).toBe("attempted:1 committed:1");
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
    const binding = canonicalRunBinding();
    // R9 §7/§8 — an ORDINARY Team Project run: the binding under test is a real non-null Project id,
    // not the `null` R8 pinned against.
    expect(`projectIsNonNull:${typeof binding.projectId === "string" && binding.projectId.length > 0}`).toBe("projectIsNonNull:true");
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
      ...binding,
      panelRevision: 1,
      priorPanelRevision: null,
      reviewerCount: 2,
      ...canonicalGovContext(),
    });
  });

  it("panel RECONFIGURE writes exactly one reconfigured event, with its COMPLETE shape", async () => {
    // R9 §8 — the panel's OWN mirror of the binding is seeded STALE, so `...binding` below is only
    // satisfiable from the run document. Echoing the panel mirror fails.
    seedPanel({ revision: 1, workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR });
    const before = snapshotStore();
    const binding = canonicalRunBinding();
    expect(`mirrorIsStale:${panelMirrorBinding().projectId !== binding.projectId && panelMirrorBinding().workspaceId !== binding.workspaceId}`).toBe("mirrorIsStale:true");
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
      ...binding,
      panelRevision: 2,
      priorPanelRevision: 1,
      reviewerCount: 3,
      ...canonicalGovContext(),
    });
  });

  it("panel CANCEL writes exactly one cancelled event, with its COMPLETE shape", async () => {
    seedPanel({ revision: 1, workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR });
    const before = snapshotStore();
    const binding = canonicalRunBinding();
    expect(`mirrorIsStale:${panelMirrorBinding().projectId !== binding.projectId && panelMirrorBinding().workspaceId !== binding.workspaceId}`).toBe("mirrorIsStale:true");
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
      ...binding,
      panelRevision: 1,
      reviewerCount: 3,
      ...canonicalGovContext(),
    });
  });

  it("VOTE writes exactly one vote_cast event, with its COMPLETE shape", async () => {
    seedPanel({ revision: 1, workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR });
    const before = snapshotStore();
    const binding = canonicalRunBinding();
    expect(`mirrorIsStale:${panelMirrorBinding().projectId !== binding.projectId && panelMirrorBinding().workspaceId !== binding.workspaceId}`).toBe("mirrorIsStale:true");
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
      ...binding,
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
    const { event } = await auditedSuccess("CREATE-actor", CREATE_DELTA(), () => putCall({ uid: OWNER_UID, reviewerUserIds: reviewers }));
    expect(event.byUid).toBe(OWNER_UID);
    expect(`actorIsNotTheFirstReviewer:${event.byUid !== reviewers[0]}`).toBe("actorIsNotTheFirstReviewer:true");
  });

  it("the reconfigured event's actor is the AUTHENTICATED caller, not any client-supplied reviewer", async () => {
    seedPanel({ revision: 1 });
    const reviewers = [OWNER_UID, REVIEWER_UID];
    expect(`callerIsNotTheFirstReviewer:${reviewers[0] !== ADMIN_UID}`).toBe("callerIsNotTheFirstReviewer:true");
    const { event } = await auditedSuccess("RECONFIGURE-actor", RECONFIGURE_DELTA(), () => putCall({ uid: ADMIN_UID, expectedRevision: 1, reviewerUserIds: reviewers }));
    expect(event.byUid).toBe(ADMIN_UID);
  });

  // ── reviewerCount provenance (R1) ──
  it("reviewerCount comes from the COMMITTED panel, not the raw request array", async () => {
    const raw = [OWNER_UID, OWNER_UID, ADMIN_UID];
    const { event } = await auditedSuccess("CREATE-reviewerCount", CREATE_DELTA(), () => putCall({ reviewerUserIds: raw }));
    const panel = stores.humanReviewPanel.get(`${RUN_ID}::current`) as { reviewerUserIds: string[] };
    expect(`canonicalDiffersFromRaw:${panel.reviewerUserIds.length !== raw.length}`).toBe("canonicalDiffersFromRaw:true");
    expect(event.reviewerCount).toBe(panel.reviewerUserIds.length);
    expect(`eventDoesNotEchoRawLength:${event.reviewerCount !== raw.length}`).toBe("eventDoesNotEchoRawLength:true");
  });

  /**
   * ─── R8 §42/§43 — commentPresent IS SEPARATED FROM conditionsCount ────────────────────────────
   *
   * R7 MAJOR: every event-level `commentPresent` assertion in the repo expected `true`, and the only
   * vote fixture supplied BOTH a comment and conditions. So `commentPresent: true`,
   * `commentPresent: eligibility.eligible` and `commentPresent: nextVote.conditionsCount > 0` all
   * survived the full 740-suite run — and the third genuinely inverts the field's meaning.
   *
   * The route contract allows conditions ONLY for `approved_with_conditions` (and requires them
   * there), and requires a comment only for `changes_requested`/`rejected`. These two cases are
   * therefore both reachable through the real contract and pin the two axes independently.
   */
  it("a vote with a COMMENT and NO conditions records commentPresent true, conditionsCount 0", async () => {
    seedPanel({ revision: 1 });
    const before = snapshotStore();
    expect((await voteCall({ status: "changes_requested", comment: "needs work" })).ok).toBe(true);
    const delta = expectStoreDelta("VOTE-comment-only", before, {
      oneAddedUnder: eventParentPath(RUN_ID),
      added: [`runs/${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`],
    });
    expect(soleStoredPanelEvent(delta, eventParentPath(RUN_ID)).payload).toMatchObject({ voteStatus: "changes_requested", commentPresent: true, conditionsCount: 0 });
  });

  it("a vote with CONDITIONS and NO comment records commentPresent false, conditionsCount 1", async () => {
    seedPanel({ revision: 1 });
    const before = snapshotStore();
    expect((await voteCall({ status: "approved_with_conditions", conditions: ["ship behind a flag"] })).ok).toBe(true);
    const delta = expectStoreDelta("VOTE-conditions-only", before, {
      oneAddedUnder: eventParentPath(RUN_ID),
      added: [`runs/${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, OWNER_UID)}`],
    });
    expect(soleStoredPanelEvent(delta, eventParentPath(RUN_ID)).payload).toMatchObject({ voteStatus: "approved_with_conditions", commentPresent: false, conditionsCount: 1 });
  });

  /**
   * ─── R9 §43–§45 — commentPresent IS INDEPENDENT OF BOTH conditions AND STATUS ───────────────────
   *
   * R8 closed the conditions axis and opened a status one. Across every vote fixture in the repo
   * `commentPresent` happened to equal `status !== "approved_with_conditions"`, so that expression
   * survived the full repo-wide suite — and it is wrong in BOTH directions for reachable votes:
   * `approved` with no comment would record `true` (an audit record asserting a comment that does not
   * exist), and `approved_with_conditions` with a comment would record `false`.
   *
   * PRODUCTION IS UNCHANGED. `nextVote.commentPresent` is correct; the survivor was a harness gap. The
   * two cases below are both reachable through the real route contract — the validator requires a
   * comment only for `changes_requested`/`rejected`, and permits one alongside conditions — and they
   * break the status expression in each direction. With the two conditions-axis cases above, the
   * reachable truth table now has all four (comment × conditions) corners it can have.
   */
  it("§44A — APPROVED with NO comment records commentPresent false, breaking `status !== approved_with_conditions` one way", async () => {
    seedPanel({ revision: 1 });
    const { event } = await auditedSuccess("VOTE-approved-no-comment", VOTE_DELTA(), () => voteCall({ status: "approved" }));
    expect(event).toMatchObject({ voteStatus: "approved", commentPresent: false, conditionsCount: 0 });
    // the surviving R8 expression would have said `true` here — recorded explicitly so the case's
    // discriminating power is visible at the assertion, not only in the comment above
    expect(`wrongStatusExpressionWouldSay:${"approved" !== "approved_with_conditions"} truth:${event.commentPresent}`).toBe("wrongStatusExpressionWouldSay:true truth:false");
  });

  it("§44B — APPROVED_WITH_CONDITIONS *with* a comment records commentPresent true, breaking it the other way", async () => {
    seedPanel({ revision: 1 });
    const { event } = await auditedSuccess("VOTE-conditions-and-comment", VOTE_DELTA(), () => voteCall({ status: "approved_with_conditions", conditions: ["ship behind a flag"], comment: "and update the runbook" }));
    expect(event).toMatchObject({ voteStatus: "approved_with_conditions", commentPresent: true, conditionsCount: 1 });
    expect(`wrongStatusExpressionWouldSay:${"approved_with_conditions" !== "approved_with_conditions"} truth:${event.commentPresent}`).toBe("wrongStatusExpressionWouldSay:false truth:true");
  });

  it("§44 — both new cases are REACHABLE through the real route validator, not harness-only shapes", () => {
    const approvedNoComment = parseSubmitAdaptiveReviewVoteRequest({ status: "approved", panelRevision: 1 });
    expect(`approvedNoComment:${approvedNoComment.ok}`).toBe("approvedNoComment:true");
    if (approvedNoComment.ok) expect(`comment:${JSON.stringify(approvedNoComment.value.comment)} conditions:${JSON.stringify(approvedNoComment.value.conditions)}`).toBe("comment:undefined conditions:undefined");
    const conditionsWithComment = parseSubmitAdaptiveReviewVoteRequest({ status: "approved_with_conditions", panelRevision: 1, conditions: ["ship behind a flag"], comment: "and update the runbook" });
    expect(`conditionsWithComment:${conditionsWithComment.ok}`).toBe("conditionsWithComment:true");
    if (conditionsWithComment.ok) expect(`comment:${JSON.stringify(conditionsWithComment.value.comment)}`).toBe('comment:"and update the runbook"');
  });

  /**
   * R9 §45 — THE TRUTH TABLE, stated as data so a future fixture change cannot quietly re-collapse an
   * axis. Every candidate wrong source is evaluated against all four reachable corners; a source that
   * agrees with the truth on all four would be genuinely indistinguishable and is named here.
   */
  it("§45 — every plausible wrong source for commentPresent disagrees with the truth on at least one reachable corner", () => {
    type Corner = { status: string; comment?: string; conditions?: string[] };
    const corners: readonly Corner[] = [
      { status: "changes_requested", comment: "needs work" },
      { status: "approved_with_conditions", conditions: ["c1"] },
      { status: "approved" },
      { status: "approved_with_conditions", conditions: ["c1"], comment: "and a note" },
    ];
    const truth = (c: Corner) => Boolean(c.comment && c.comment.trim().length > 0);
    const wrongSources: Readonly<Record<string, (c: Corner) => boolean>> = {
      "conditionsCount > 0": (c) => (c.conditions?.length ?? 0) > 0,
      'status !== "approved_with_conditions"': (c) => c.status !== "approved_with_conditions",
      'status === "approved"': (c) => c.status === "approved",
      "hardcoded true": () => true,
      "hardcoded false": () => false,
    };
    const indistinguishable = Object.entries(wrongSources)
      .filter(([, source]) => corners.every((c) => source(c) === truth(c)))
      .map(([name]) => name);
    expect(`indistinguishableCommentPresentSources:${indistinguishable.join(" | ")}`).toBe("indistinguishableCommentPresentSources:");
    // and the corners really are four distinct (comment, conditions) combinations
    expect(new Set(corners.map((c) => `${truth(c)}/${(c.conditions?.length ?? 0) > 0}/${c.status}`)).size).toBe(4);
  });

  it("an IDEMPOTENT vote replay attempts NO second event on ANY channel — one vote, one record", async () => {
    seedPanel({ revision: 1 });
    // R9 §3 — the FIRST vote's exactly-one-event guarantee is itself proved from the store delta,
    // where R8 read it from the committed-event log.
    await auditedSuccess("VOTE-first", VOTE_DELTA(), () => voteCall());
    // R8 §9 — the replay's DURABLE delta must be empty. The previous version counted attempted log
    // entries, which a write-then-delete or an unmodelled surface could sidestep entirely.
    const before = snapshotStore();
    expect(await voteCall()).toMatchObject({ ok: true, submissionStatus: "already_submitted" });
    expectNoDurableChange("VOTE-replay", before);
    expectNoForeignPersistenceWriters();
  });
});

/**
 * R3 §18–§22 / R9 §8/§12 — PROJECT BINDING on an ORDINARY non-null Team Project, asserted from the
 * FINAL STORED DOCUMENT and the whole-store delta.
 *
 * Three separate defects were layered here across rounds and all three are now closed:
 *   • R2 — every fixture seeded `projectId: null`, so the field was pinned vacuously;
 *   • R3 — a non-null Project existed but only inside this one describe block;
 *   • R8 — these assertions read `panelEvents()[0]`, the COMMITTED-EVENT LOG, so a write-then-delete
 *     gated on a non-null Project satisfied every one of them while the store held no record.
 *
 * The panel's own mirror of the binding is seeded STALE in the three cases where a panel pre-exists,
 * so echoing the mirror instead of projecting the run document fails.
 */
describe("panel mutation audit coverage — canonical Project binding", () => {
  const canonicalProjectId = () => (stores.runs.get(RUN_ID) as { projectId: string | null }).projectId;
  const stalePanel = (overrides: Record<string, unknown> = {}) =>
    seedPanel({ revision: 1, workspaceId: STALE_PANEL_WORKSPACE_MIRROR, projectId: STALE_PANEL_PROJECT_MIRROR, ...overrides });
  const expectBoundToCanonicalProject = (event: Record<string, unknown>) => {
    expect(`eventProject:${String(event.projectId)} canonicalProject:${String(canonicalProjectId())}`).toBe(`eventProject:${String(canonicalProjectId())} canonicalProject:${String(canonicalProjectId())}`);
    expect(`eventWorkspace:${String(event.workspaceId)}`).toBe(`eventWorkspace:${String((stores.runs.get(RUN_ID) as { workspaceId: string }).workspaceId)}`);
    expect(`projectIsNonNull:${typeof event.projectId === "string" && (event.projectId as string).length > 0}`).toBe("projectIsNonNull:true");
  };

  it("the DEFAULT base fixture is Project-backed, and the Project is distinct from every other identifier", () => {
    expect(canonicalProjectId()).toBe(PROJECT_ID);
    expect([WS_ID, RUN_ID, OWNER_UID, ADMIN_UID, REVIEWER_UID, REVIEWER2_UID, REVIEWER3_UID, MEMBER_UID, VIEWER_UID, CREATOR_UID, STALE_PANEL_PROJECT_MIRROR, STALE_PANEL_WORKSPACE_MIRROR]).not.toContain(PROJECT_ID);
  });

  it("CREATE binds the event to the canonical Project", async () => {
    const { event } = await auditedSuccess("CREATE-project", CREATE_DELTA(), () => putCall());
    expectBoundToCanonicalProject(event);
  });

  it("RECONFIGURE binds the event to the canonical Project, not the panel's stale mirror", async () => {
    stalePanel();
    expect(`mirrorIsStale:${panelMirrorBinding().projectId !== canonicalProjectId()}`).toBe("mirrorIsStale:true");
    const { event } = await auditedSuccess("RECONFIGURE-project", RECONFIGURE_DELTA(), () => putCall({ expectedRevision: 1 }));
    expectBoundToCanonicalProject(event);
    expect(`eventDoesNotEchoStaleMirror:${event.projectId !== STALE_PANEL_PROJECT_MIRROR && event.workspaceId !== STALE_PANEL_WORKSPACE_MIRROR}`).toBe("eventDoesNotEchoStaleMirror:true");
  });

  it("CANCEL binds the event to the canonical Project, not the panel's stale mirror", async () => {
    stalePanel();
    const { event } = await auditedSuccess("CANCEL-project", CANCEL_DELTA(), () => deleteCall());
    expectBoundToCanonicalProject(event);
    expect(`eventDoesNotEchoStaleMirror:${event.projectId !== STALE_PANEL_PROJECT_MIRROR && event.workspaceId !== STALE_PANEL_WORKSPACE_MIRROR}`).toBe("eventDoesNotEchoStaleMirror:true");
  });

  it("VOTE binds the event to the canonical Project, not the panel's stale mirror", async () => {
    stalePanel();
    const { event } = await auditedSuccess("VOTE-project", VOTE_DELTA(), () => voteCall());
    expectBoundToCanonicalProject(event);
    expect(`eventDoesNotEchoStaleMirror:${event.projectId !== STALE_PANEL_PROJECT_MIRROR && event.workspaceId !== STALE_PANEL_WORKSPACE_MIRROR}`).toBe("eventDoesNotEchoStaleMirror:true");
  });

  /**
   * ─── R9 §9 — A Project-LESS run is an EXPLICIT, LOCAL deviation, and still audited ─────────────
   *
   * §7 makes Project-backed the default; §9 requires any deviation to be visible at the call site.
   * A Personal-shaped run (`projectId: null`) is a real production shape, so it keeps a case — one
   * that OVERRIDES the base fixture in the open, rather than the whole suite silently inheriting it.
   */
  it("a Project-LESS run still records the event, with a null Project — an explicit local override", async () => {
    seedRun({ projectId: null });
    expect(`canonicalProject:${String(canonicalProjectId())}`).toBe("canonicalProject:null");
    const { event } = await auditedSuccess("CREATE-projectless", CREATE_DELTA(), () => putCall());
    expect(`eventProject:${JSON.stringify(event.projectId)}`).toBe("eventProject:null");
  });
});

/**
 * R3 §23–§27 / R9 §13 — GOVERNANCE CONTEXT PROVENANCE. A second canonical context proves the event
 * projects the record rather than echoing a historical literal, and the expected side is read from
 * the PRE-CALL canonical governance record while the actual side is read from the FINAL STORED event.
 * R8 read the actual side from the committed-event log.
 */
describe("panel mutation audit coverage — governance context provenance", () => {
  it("a NON-DEFAULT canonical governance context appears in the stored event", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
    // the fixture is only discriminating if it differs from the default the other tests use
    expect(`contextIsNonDefault:${canonicalGovContext().schemaId !== "decision_support"}`).toBe("contextIsNonDefault:true");
    const expected = canonicalGovContext();
    const { event } = await auditedSuccess("CREATE-govcontext", CREATE_DELTA(), () => putCall());
    expect(`schemaId:${String(event.schemaId)} answerShape:${String(event.answerShape)}`).toBe(`schemaId:${expected.schemaId} answerShape:${expected.answerShape}`);
  });

  it("the vote event carries the same non-default canonical context, read from the stored document", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
    seedPanel({ revision: 1 });
    const expected = canonicalGovContext();
    const { event } = await auditedSuccess("VOTE-govcontext", VOTE_DELTA(), () => voteCall());
    expect(`schemaId:${String(event.schemaId)} answerShape:${String(event.answerShape)}`).toBe(`schemaId:${expected.schemaId} answerShape:${expected.answerShape}`);
  });

  it("CANCEL and RECONFIGURE carry it too, so no audited action projects a historical literal", async () => {
    seedRun({ governanceRecord: validGovernanceRecord({ schemaId: ALT_GOV.schemaId, answerShape: ALT_GOV.answerShape }) });
    seedPanel({ revision: 1 });
    const expected = canonicalGovContext();
    const reconfigured = await auditedSuccess("RECONFIGURE-govcontext", RECONFIGURE_DELTA(), () => putCall({ expectedRevision: 1 }));
    expect(`schemaId:${String(reconfigured.event.schemaId)} answerShape:${String(reconfigured.event.answerShape)}`).toBe(`schemaId:${expected.schemaId} answerShape:${expected.answerShape}`);
    const cancelled = await auditedSuccess("CANCEL-govcontext", CANCEL_DELTA(), () => deleteCall({ expectedRevision: 2 }));
    expect(`schemaId:${String(cancelled.event.schemaId)} answerShape:${String(cancelled.event.answerShape)}`).toBe(`schemaId:${expected.schemaId} answerShape:${expected.answerShape}`);
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
 *     so 38 + 21 = 59 [[count:expandedObligations=59]]. NOTHING is excluded: all 59
 *     [[count:executableObligations=59]] are executable, and the exclusion map
 *     is empty. (R9 §60 — this paragraph carried a stale exclusion count for four rounds after R5 made all
 *     three sites reachable; see RETRACTED_PHRASES entries 2 and 3. The code and the assertions were
 *     right; the comment describing them was three rounds stale.)
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

  /**
   * ─── R9 §29–§32 — EVERY RESULT-CARRIER WRITE FORM IS SEEN, OR FAILS CLOSED ─────────────────────
   *
   * R8 MAJOR: the census recognised exactly two shapes — `EqualsToken` onto a bare `Identifier`, and
   * a `VariableDeclaration` with an identifier name. Four other shapes that really can carry a
   * rejection to the returned result were invisible, so introducing one added a production decision
   * point with ZERO census entries, ZERO obligations and every committed number unmoved. One of the
   * four was live: `return holder.result` did not even discover a carrier, because the relay detector
   * required the returned expression to be an identifier.
   *
   * Each shape below is now either UNDERSTOOD (plain assignment) or reported as
   * `UNSUPPORTED_RESULT_WRITE`, which fails the census. Never silently omitted.
   */
  const censusOf = (source: string) => censusResultAssignments(source, SYNTH_MAP);
  const shapesOf = (source: string) => censusOf(source).map((x) => `${x.target}:${x.classification}`);

  it("§32 — a PROPERTY-TARGET carrier is discovered from the relay and its plain assignment is classified", () => {
    // R8 saw neither the relay (`return holder.result`) nor the write (`holder.result = ...`)
    const source = `export async function synthOp(a: number) { const holder: { result?: Res } = {}; holder.result = await db.runTransaction(async () => ({ ok: true })); if (a < 0) { holder.result = { ok: false, reason: "prop_rejection" }; } return holder.result; }`;
    expect(shapesOf(source)).toEqual(["holder.result:transaction-result", "holder.result:rejection"]);
    expect(censusOf(source)[1].reasonLiteral).toBe("prop_rejection");
  });

  it("§32 — a DESTRUCTURING assignment onto the carrier is reported UNSUPPORTED, not skipped", () => {
    const object = `export async function synthOp(a: number) { let result: Res; ({ result } = pick(a)); return result; }`;
    const array = `export async function synthOp(a: number) { let result: Res; [result] = pickAll(a); return result; }`;
    expect(shapesOf(object)).toEqual(["result:unsupported"]);
    expect(shapesOf(array)).toEqual(["result:unsupported"]);
    expect(censusOf(object)[0].expr).toContain("UNSUPPORTED_RESULT_WRITE(destructuring-assignment)");
    expect(censusOf(array)[0].expr).toContain("UNSUPPORTED_RESULT_WRITE(destructuring-assignment)");
  });

  it("§32 — a DESTRUCTURING declaration of the carrier is reported UNSUPPORTED, not skipped", () => {
    const source = `export async function synthOp(a: number) { const { result } = pick(a); return result; }`;
    expect(shapesOf(source)).toEqual(["result:unsupported"]);
    expect(censusOf(source)[0].expr).toContain("UNSUPPORTED_RESULT_WRITE(destructuring-declaration)");
  });

  it("§32 — a COMPOUND-OPERATOR write to the carrier is reported UNSUPPORTED for every such operator", () => {
    for (const operator of ["||=", "&&=", "??=", "+="]) {
      const source = `export async function synthOp(a: number) { let result: Res = seed(a); result ${operator} { ok: false, reason: "compound_rejection" }; return result; }`;
      expect(`${operator}:${shapesOf(source).join(",")}`).toBe(`${operator}:result:unsupported,result:unsupported`);
      const compound = censusOf(source).find((x) => x.expr.includes("compound-operator"));
      expect(`${operator}:reported:${compound !== undefined}`).toBe(`${operator}:reported:true`);
    }
  });

  it("§32 — an ordinary plain assignment is still UNDERSTOOD, so fail-closed did not become fail-always", () => {
    const source = `export async function synthOp(a: number) { let result: Res; result = await db.runTransaction(async () => ({ ok: true })); if (a < 0) { result = { ok: false, reason: "plain_rejection" }; } return result; }`;
    expect(shapesOf(source)).toEqual(["result:transaction-result", "result:rejection"]);
  });

  it("§31 — an unsupported carrier write FAILS the census, which is what makes the four shapes above load-bearing", () => {
    // the real module's census has no unsupported entry; a synthetic one does, and the assertion that
    // polices the real module is the same expression
    const unsupportedIn = (source: string) => censusOf(source).filter((a) => a.classification === "unsupported").map((a) => `${a.operation}#assign-${a.ordinal}`);
    expect(unsupportedIn(PANEL_MUTATIONS_SOURCE.replace(/export async function putWorkspaceReviewPanel/, "export async function synthOp"))).toEqual([]);
    expect(unsupportedIn(`export async function synthOp() { let result: Res; ({ result } = pick()); return result; }`)).toEqual(["create#assign-1"]);
  });

  /**
   * ─── R10 — THE THREE R9 SURVIVORS, EACH WITH A CONTROL ─────────────────────────────────────────
   *
   * These are the shapes that escaped R9 entirely — no census entry of any kind — while a forged
   * governance event rode the invisible branch at exit 0. Each is now UNSUPPORTED, and each case pairs
   * the negative with a positive control so "the census reports nothing" can never be mistaken for
   * "the census is fine".
   */
  it("R10 — `for (result of …)` reaches the carrier and is UNSUPPORTED", () => {
    const forOf = `export async function synthOp(a: number) { let result: Res = seed(a); for (result of [{ ok: false, reason: "r" }]) { break; } return result; }`;
    const entries = censusOf(forOf);
    expect(entries.map((x) => x.classification)).toContain("unsupported");
    expect(entries.find((x) => x.expr.includes("for-of-loop-binding"))).toBeDefined();
    // CONTROL — the same loop over a NON-carrier binding is correctly silent
    const unrelated = `export async function synthOp(a: number) { let other: number = 0; let result: Res = seed(a); for (other of [1, 2]) { break; } return result; }`;
    expect(censusOf(unrelated).filter((x) => x.expr.includes("for-of-loop-binding"))).toEqual([]);
  });

  it("R10 — a PROPERTY-PATH write through the carrier (`result.ok = false`) is UNSUPPORTED", () => {
    const through = `export async function synthOp(a: number) { let result: Res = seed(a); if (a < 0) { (result as { ok: boolean }).ok = false; } return result; }`;
    expect(censusOf(through).find((x) => x.expr.includes("property-path-write"))).toBeDefined();
    // CONTROL — a write to an unrelated object's `.ok` is silent
    const unrelated = `export async function synthOp(a: number) { const other = { ok: true }; let result: Res = seed(a); other.ok = false; return result; }`;
    expect(censusOf(unrelated).filter((x) => x.expr.includes("property-path-write"))).toEqual([]);
  });

  it("R10 — the carrier handed to a CALL that can mutate it is UNSUPPORTED", () => {
    const assigned = `export async function synthOp(a: number) { let result: Res = seed(a); if (a < 0) { Object.assign(result, { ok: false, reason: "r" }); } return result; }`;
    expect(censusOf(assigned).find((x) => x.expr.includes("carrier-passed-to-call"))).toBeDefined();
    // and a PREFIX of the carrier counts, because the callee can replace the carrier wholesale
    const prefix = `export async function synthOp(a: number) { const holder: { result: Res } = { result: seed(a) }; mutate(holder); return holder.result; }`;
    expect(censusOf(prefix).find((x) => x.expr.includes("carrier-passed-to-call"))).toBeDefined();
    // CONTROL — an argument strictly BELOW the carrier cannot rewrite ok/reason and is silent. This is
    // production's own shape: `toWorkspacePanelDto(ref, transactionResult.panel)`.
    const below = `export async function synthOp(a: number) { const result: Res = seed(a); await render(result.panel); return result; }`;
    expect(censusOf(below).filter((x) => x.expr.includes("carrier-passed-to-call"))).toEqual([]);
    expect(RESULT_ASSIGNMENTS.filter((x) => x.expr.includes("carrier-passed-to-call"))).toEqual([]);
  });

  it("R10 — `delete result.ok` and `result.n++` reach the carrier and are UNSUPPORTED, with controls", () => {
    const deleted = `export async function synthOp(a: number) { const result: Res = seed(a); delete (result as { ok?: boolean }).ok; return result; }`;
    expect(censusOf(deleted).find((x) => x.expr.includes("delete-on-carrier-path"))).toBeDefined();
    const bumped = `export async function synthOp(a: number) { const result: Res = seed(a); (result as { n: number }).n++; return result; }`;
    expect(censusOf(bumped).find((x) => x.expr.includes("increment-on-carrier-path"))).toBeDefined();
    // CONTROL — the same two operators on an UNRELATED object produce neither entry. (The control still
    // has one `unsupported` entry, for `const result = seed(a)`: a carrier initialised from an unknown
    // call is correctly unsupported, which is the census working rather than a false positive — so the
    // control is scoped to the two mechanisms under test, not to the whole classification.)
    const control = `export async function synthOp(a: number) { const other = { n: 0 }; const result: Res = seed(a); other.n++; delete (other as { n?: number }).n; return result; }`;
    expect(censusOf(control).filter((x) => /delete-on-carrier-path|increment-on-carrier-path/.test(x.expr))).toEqual([]);
    expect(censusOf(control).filter((x) => x.classification === "unsupported").map((x) => x.expr)).toEqual(["UNSUPPORTED_RESULT_WRITE(unclassified-initializer) result: Res = seed(a)"]);
  });

  it("R10 — THE ESCAPE R9 SHIPPED: the invisible branch that also forges an event is now named", () => {
    // B's E3, reduced to the census input it presented: an Object.assign rejection on a new branch
    const escape = `export async function synthOp(a: number) { let result: Res = await db.runTransaction(async () => ({ ok: true })); if (a < 0) { Object.assign(result, { ok: false, reason: "panel_unreadable" }); void writeAudit({}); } return result; }`;
    const entries = censusOf(escape);
    expect(entries.map((x) => x.classification).sort()).toEqual(["transaction-result", "unsupported"]);
    // and the assertion that polices the REAL module is the same expression
    expect(`unsupportedInRealModule:${RESULT_ASSIGNMENTS.filter((a) => a.classification === "unsupported").length}`).toBe("unsupportedInRealModule:0");
  });

  it("§29 — a carrier reached only through a property chain is still discovered, so the relay detector is not identifier-only", () => {
    const deep = `export async function synthOp(a: number) { const box: { inner: { result?: Res } } = { inner: {} }; box.inner.result = { ok: false, reason: "deep_rejection" }; return box.inner.result; }`;
    expect(shapesOf(deep)).toEqual(["box.inner.result:rejection"]);
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

  /** A relay/assignment target expressed as a dotted name: `result`, `holder.result`. */
  const carrierName = (e: tsApi.Expression): string | null => {
    const value = unwrap(e);
    if (tsApi.isIdentifier(value)) return value.text;
    if (tsApi.isPropertyAccessExpression(value)) {
      const base = carrierName(value.expression);
      return base ? `${base}.${value.name.text}` : null;
    }
    return null;
  };

  /**
   * R9 §30 — every assignment operator that can write a result carrier. A COMPOUND operator is
   * recognised so it can be classified, not so it can be treated as a plain assignment: the value
   * that lands is a function of the previous value, which this classifier deliberately does not model,
   * so it is reported UNSUPPORTED and fails the suite closed.
   */
  const ASSIGNMENT_OPERATORS: ReadonlySet<tsApi.SyntaxKind> = new Set([
    tsApi.SyntaxKind.EqualsToken,
    tsApi.SyntaxKind.PlusEqualsToken,
    tsApi.SyntaxKind.MinusEqualsToken,
    tsApi.SyntaxKind.AsteriskEqualsToken,
    tsApi.SyntaxKind.AsteriskAsteriskEqualsToken,
    tsApi.SyntaxKind.SlashEqualsToken,
    tsApi.SyntaxKind.PercentEqualsToken,
    tsApi.SyntaxKind.AmpersandEqualsToken,
    tsApi.SyntaxKind.BarEqualsToken,
    tsApi.SyntaxKind.CaretEqualsToken,
    tsApi.SyntaxKind.LessThanLessThanEqualsToken,
    tsApi.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    tsApi.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    tsApi.SyntaxKind.AmpersandAmpersandEqualsToken,
    tsApi.SyntaxKind.BarBarEqualsToken,
    tsApi.SyntaxKind.QuestionQuestionEqualsToken,
  ]);

  /** Every name a destructuring pattern writes, so a pattern targeting the carrier is visible. */
  const namesWrittenByPattern = (node: tsApi.Node): string[] => {
    const names: string[] = [];
    const walkPattern = (n: tsApi.Node) => {
      if (tsApi.isIdentifier(n)) names.push(n.text);
      else if (tsApi.isPropertyAccessExpression(n)) { const dotted = carrierName(n as tsApi.Expression); if (dotted) names.push(dotted); return; }
      tsApi.forEachChild(n, walkPattern);
    };
    tsApi.forEachChild(node, walkPattern);
    return names;
  };

  const collect = (fnNode: tsApi.Node, operation: "create" | "cancel" | "vote") => {
    // 1. which carriers do this function's relay returns hand back? An identifier OR a dotted
    //    property chain — R8 saw only the identifier form, so `return holder.result` discovered no
    //    carrier at all and every write to it was outside the census by construction.
    const relayed = new Set<string>();
    const findRelays = (n: tsApi.Node) => {
      if (n !== fnNode && (tsApi.isFunctionDeclaration(n) || tsApi.isMethodDeclaration(n))) return;
      if (tsApi.isReturnStatement(n) && n.expression) {
        const name = carrierName(n.expression);
        if (name) relayed.add(name);
      }
      tsApi.forEachChild(n, findRelays);
    };
    tsApi.forEachChild(fnNode, findRelays);

    // 2. every assignment to one of them, classified
    let ordinal = 0;
    const visit = (n: tsApi.Node) => {
      if (n !== fnNode && (tsApi.isFunctionDeclaration(n) || tsApi.isMethodDeclaration(n))) return;
      const recordUnsupported = (target: string, node: tsApi.Node, shape: string) => {
        ordinal += 1;
        out.push({ operation, ordinal, target, classification: "unsupported", reasonLiteral: null, expr: `UNSUPPORTED_RESULT_WRITE(${shape}) ${textOf(node).slice(0, 120)}` });
      };
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
        // R10 — one label for one meaning: an initializer the classifier cannot account for carries the
        // same `UNSUPPORTED_RESULT_WRITE` marker as every other unsupported shape, so a grep or an
        // assertion for the marker sees all of them.
        const label = classification === "unsupported" ? `UNSUPPORTED_RESULT_WRITE(unclassified-initializer) ${textOf(node)}` : textOf(node);
        out.push({ operation, ordinal, target, classification, reasonLiteral, expr: label.slice(0, 160) });
      };
      /**
       * ─── R10 — THE RULE IS "DOES THIS REACH A CARRIER", NOT "IS THIS A KNOWN FORM" ───────────────
       *
       * R7, R8 and R9 each enumerated the write forms they knew and each was defeated by shapes not in
       * the list. R9's three survivors were `for (result of …)`, `(result as {ok:boolean}).ok = false`
       * and `Object.assign(result, …)`: none is a BinaryExpression assignment to a carrier NAME and
       * none is a VariableDeclaration, so all three produced no entry at all — not `rejection`, not
       * `unsupported` — and a forged governance event rode an invisible branch at exit 0.
       *
       * The polarity is now inverted. ONE shape is understood — a plain `=` whose left-hand side is
       * exactly a relayed carrier name — and EVERY other syntactic position that can reach a carrier
       * is `UNSUPPORTED_RESULT_WRITE`. "Reaches a carrier" means: the node writes a name that is a
       * carrier, or a name a carrier is a dotted PREFIX of (so `result.ok` counts), or it hands a bare
       * carrier identifier to a callee that could mutate it. New syntax therefore fails closed by
       * default instead of being invisible until someone thinks of it.
       */
      const carrierOrItsProperty = (name: string | null): string | null => {
        if (!name) return null;
        if (relayed.has(name)) return name;
        // a dotted path THROUGH a carrier: `transactionResult.ok`, `holder.result.reason`
        for (const carrier of relayed) if (name === carrier || name.startsWith(`${carrier}.`)) return carrier;
        return null;
      };

      if (tsApi.isBinaryExpression(n) && ASSIGNMENT_OPERATORS.has(n.operatorToken.kind)) {
        const isPlainAssignment = n.operatorToken.kind === tsApi.SyntaxKind.EqualsToken;
        const leftName = carrierName(n.left);
        const reached = carrierOrItsProperty(leftName);
        if (reached) {
          if (isPlainAssignment && leftName === reached) record(reached, n.right, n);
          else if (!isPlainAssignment && leftName === reached) recordUnsupported(reached, n, `compound-operator ${tsApi.tokenToString(n.operatorToken.kind)}`);
          // R9 SURVIVOR: a write THROUGH the carrier, e.g. `(result as {ok:boolean}).ok = false`.
          else recordUnsupported(reached, n, `property-path-write ${leftName}`);
        } else if (!leftName) {
          // DESTRUCTURING assignment: `({ result } = ...)`, `[result] = ...`
          const written = namesWrittenByPattern(n.left).map(carrierOrItsProperty).filter((x): x is string => x !== null);
          if (written.length > 0) recordUnsupported([...new Set(written)].sort().join("+"), n, "destructuring-assignment");
        }
      }
      if (tsApi.isVariableDeclaration(n)) {
        if (tsApi.isIdentifier(n.name) && relayed.has(n.name.text) && n.initializer) {
          record(n.name.text, n.initializer, n);
        } else if (!tsApi.isIdentifier(n.name)) {
          // DESTRUCTURING declaration: `const { result } = ...`, `let [result] = ...`
          const written = namesWrittenByPattern(n.name).map(carrierOrItsProperty).filter((x): x is string => x !== null);
          if (written.length > 0) recordUnsupported([...new Set(written)].sort().join("+"), n, "destructuring-declaration");
        }
      }
      // R9 SURVIVOR: `for (result of […])` / `for (result in …)` — the initializer is an EXISTING
      // lvalue, so the node is neither a BinaryExpression nor a VariableDeclaration.
      if (tsApi.isForOfStatement(n) || tsApi.isForInStatement(n)) {
        const initializer = n.initializer;
        if (!tsApi.isVariableDeclarationList(initializer)) {
          const written = carrierOrItsProperty(carrierName(initializer as tsApi.Expression)) ?? namesWrittenByPattern(initializer).map(carrierOrItsProperty).find((x) => x !== null) ?? null;
          if (written) recordUnsupported(written, n, tsApi.isForOfStatement(n) ? "for-of-loop-binding" : "for-in-loop-binding");
        }
      }
      /**
       * R9 SURVIVOR: `Object.assign(result, {...})` and any other call handed the carrier ITSELF,
       * which mutates it in place with no assignment node anywhere.
       *
       * THE BOUNDARY, stated rather than left implicit. Flagged: an argument that IS a carrier, or that
       * is a strict dotted PREFIX of one (`mutate(holder)` where the carrier is `holder.result` can
       * replace `holder.result` wholesale). NOT flagged: an argument strictly BELOW the carrier, such as
       * production's own `toWorkspacePanelDto(ref, transactionResult.panel)` — a callee handed
       * `.panel` can mutate that object but cannot rewrite `ok`/`reason`, so it cannot forge or conceal
       * a rejection, which is the only property this census exists to protect. Narrowing to exactly
       * that boundary is what keeps the rule fail-closed without being fail-always.
       */
      const carrierReachableByCallee = (name: string | null): string | null => {
        if (!name) return null;
        for (const carrier of relayed) if (name === carrier || carrier.startsWith(`${name}.`)) return carrier;
        return null;
      };
      if (tsApi.isCallExpression(n)) {
        for (const argument of n.arguments) {
          const reached = carrierReachableByCallee(carrierName(argument));
          if (reached) {
            recordUnsupported(reached, n, `carrier-passed-to-call ${n.expression.getText(sf).replace(/\s+/g, " ").slice(0, 40)}`);
            break;
          }
        }
      }
      // R10 — a unary/postfix mutation of a carrier path, e.g. `delete result.ok`, `result.n++`.
      if (tsApi.isDeleteExpression(n)) {
        const reached = carrierOrItsProperty(carrierName(n.expression));
        if (reached) recordUnsupported(reached, n, "delete-on-carrier-path");
      }
      if ((tsApi.isPostfixUnaryExpression(n) || tsApi.isPrefixUnaryExpression(n)) && (n.operator === tsApi.SyntaxKind.PlusPlusToken || n.operator === tsApi.SyntaxKind.MinusMinusToken)) {
        const reached = carrierOrItsProperty(carrierName(n.operand));
        if (reached) recordUnsupported(reached, n, "increment-on-carrier-path");
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

type WitnessContext = { callerUid: string; reason: string; operation: "create" | "cancel" | "vote" };

/**
 * ─── R8 §32–§39 — WITNESSES ARE ANCHORED TO REAL GUARD EXPRESSIONS ────────────────────────────
 *
 * R7 BLOCKER: the previous meta-test only required a witness to distinguish TWO fixtures, so a
 * witness keyed on `panel.createdByUserId` — a field appearing in no guard anywhere — satisfied it,
 * and a real ghost event on the never-executed branch then survived. Separating two fixtures is not
 * the property; proving the guard's own preconditions is.
 *
 * WHAT A WITNESS NOW IS. Each witnessed site declares a list of GUARD FACTS. Every fact names the
 * production guard expression it is an operand of, and that string is checked against the AST
 * inventory: it must be this site's own `guardExpr`, or the `guardExpr` of a LOWER-ordinal site in
 * the same operation (a short-circuit predecessor that must be false for control to arrive here).
 * A fact that corresponds to no real guard cannot be declared at all, which is exactly what makes
 * the incidental-field attack inexpressible rather than merely unlikely.
 *
 * WHAT A WITNESS IS NOT (§32). It is not by itself proof that a particular branch executed. Its
 * committed job is to prove the canonical pre-call and dependency facts the claimed control flow
 * requires. Case-to-source binding is additionally established by targeted site-local ghost
 * mutations during independent review (§40), which remain the direct execution evidence.
 *
 * §36 — deliberately NOT global mutual exclusion. Two sites may legitimately share most facts;
 * requiring a witness to reject every other case's fixture would manufacture incompatibilities
 * production does not have. Twins are separated by their own distinguishing guard, nothing more.
 */
type GuardFact = {
  /** The production guard expression this fact is an operand of. Verified against the AST. */
  fromGuard: string;
  /**
   * R10 — WHICH registry reader supplies this operand. The fact chooses the guard, never the expression.
   * `actual` is filled in by `resolveGuardFacts` from `GUARD_OPERAND_READERS[operand]`.
   */
  operand: GuardOperandKey;
  label: string;
  actual?: unknown;
  expected: unknown;
  /**
   * R10 §34 — the RELATION the production guard applies to this operand. `current.status === "finalized"`
   * and `current.status !== "open"` read the SAME operand through the same registry reader and differ
   * only here, so both are expressible without letting a fact invent its own expression.
   */
  relation?: "equals" | "notEquals";
  /**
   * ─── R9 §33/§36/§37 — THE BEHAVIORAL FALSIFIER, WITHOUT WHICH A FACT IS NOT PROOF ─────────────
   *
   * R8 BLOCKER B: a fact had to NAME a real guard expression, and that was all. The name was checked
   * against the AST; the PREDICATE was not checked against anything. So a fact could cite
   * `!runSnap.exists` and then assert something incidental, or assert a `String()`-coerced tautology
   * over the right operand, and the meta-test — which only required a witness to separate two
   * fixtures — accepted it. Incidental facts plus a repointed twin plus a real ghost event exited 0;
   * the ghost alone died with 16 failures. Emptiness resistance (15/15 in R8) does not help, because
   * a non-empty tautology is not empty.
   *
   * `flipOperand` mutates the CANONICAL ARTIFACT or the MOCKED DEPENDENCY that production reads this
   * operand from — never the fact, never its label, never its expected value. The §37 meta-test then
   * requires, for every fact of every witnessed site: the operand's value CHANGED, the fact no longer
   * satisfies its own expectation, and the witness rejects. A tautology survives none of the three.
   */
  flipOperand: () => void;
};

/** Runs the REAL authorizer against the seeded stores (§38) — the actual dependency, not a stand-in. */
async function realAuthOutcome(uid: string, requiredCapability: string) {
  const tx = {
    get: async (ref: { __collection: string; __id: string }) => {
      const data = stores[ref.__collection]?.get(ref.__id);
      return { exists: data !== undefined, data: () => data, id: ref.__id };
    },
  };
  return authorizeTeamWorkspaceMutationInTransaction(tx as never, { uid, workspaceId: WS_ID, requiredCapability: requiredCapability as never });
}

const OPERATION_REQUIRED_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({ create: "reviews.manage", cancel: "reviews.manage", vote: "reviews.submit" });

/**
 * R9 §35/§37 — the operand flips. Each one mutates a CANONICAL ARTIFACT (a seeded document) or the
 * MOCKED DEPENDENCY production reads the operand from, chosen so the guard's truth value inverts.
 */
const restoreRealCapabilities = () => { mockedRoleHasCapability.mockImplementation(actualCapabilities.roleHasCapability); };
/**
 * Makes the REAL authorizer succeed for this caller: a well-formed Workspace this caller canonically
 * owns, and a matching owner membership. Owning it is what keeps the owner-integrity check satisfied —
 * granting the base fixture's Workspace owner an `admin` membership instead flips `workspace_not_found`
 * into `owner_integrity_violation` rather than into success, which is how the first version of this
 * flip failed the operand-change step honestly.
 */
const grantRealAuthTo = (uid: string) => () => {
  seedWorkspace({ ownerUserId: uid, createdByUserId: uid });
  seedMembership(uid, "owner");
  restoreRealCapabilities();
};
/** Makes the REAL authorizer deny: the Workspace document is gone. */
const revokeRealAuth = () => { stores.workspaces.delete(WS_ID); };
/** Changes WHICH denial the real authorizer returns, in whichever direction is a change. */
const changeRealAuthReason = (expected: unknown) => () => {
  if (expected === "workspace_not_found") {
    seedWorkspace();
    stores.workspaceMemberships.clear();
  } else {
    stores.workspaces.delete(WS_ID);
  }
};
const canonicalRunCreatorUid = () => (stores.runs.get(RUN_ID) as { userId: string } | undefined)?.userId ?? CREATOR_UID;

/**
 * ─── R10 — A FACT NAMES ITS GUARD; THE REGISTRY SUPPLIES THE READ ───────────────────────────────
 *
 * R9's §37 required a fact's operand to CHANGE when `flipOperand` ran, and that is a test of
 * co-variation, not of provenance. A fact reading `typeof panel.finalDecisionId === "string"` — a field
 * appearing in no guard anywhere — co-varies with the finalized/open fixtures perfectly, so it passed
 * §37, passed §33's name check, and passed both twin directions at exit 0. The fact still got to choose
 * its own reader, which is the same shape as every other defect in this series.
 *
 * The operand READER is now a property of the GUARD, declared once here, next to the guard text it
 * belongs to. A site's fact supplies the guard key and the truth value required to reach it; it cannot
 * supply the expression. An incidental field is no longer expressible, rather than merely detectable.
 */
const GUARD_OPERAND_READERS: Readonly<Record<string, (ctx: WitnessContext) => Promise<unknown> | unknown>> = Object.freeze({
  // `!auth.ok` — the REAL authorizer's outcome, invoked against the seeded stores
  authOk: async (ctx: WitnessContext) => (await realAuthOutcome(ctx.callerUid, OPERATION_REQUIRED_CAPABILITY[ctx.operation])).ok,
  authReason: async (ctx: WitnessContext) => {
    const auth = await realAuthOutcome(ctx.callerUid, OPERATION_REQUIRED_CAPABILITY[ctx.operation]);
    return auth.ok ? null : auth.reason;
  },
  // `!roleHasCapability(auth.membership.role, "research.read")` — through the live capability dependency
  researchRead: async (ctx: WitnessContext) => {
    const auth = await realAuthOutcome(ctx.callerUid, OPERATION_REQUIRED_CAPABILITY[ctx.operation]);
    return auth.ok ? mockedRoleHasCapability(auth.membership.role, "research.read") : null;
  },
  // `!runSnap.exists`
  runExists: () => stores.runs.has(RUN_ID),
  // `target.kind !== "valid_workspace_review_target"` — through the REAL resolver
  targetIsValid: () => storedRunTargetKind() === "valid_workspace_review_target",
  // `current.status === "finalized"` / `!== "open"` — through the REAL panel parser
  panelStatus: () => storedPanelState().status,
  // `!panel.reviewerUserIds.includes(args.uid)` — through the REAL panel parser
  callerOnRoster: (ctx: WitnessContext) => storedPanelState().reviewers.includes(ctx.callerUid),
  // `!eligibility.eligible` — through the REAL eligibility predicate, with the run's own creator
  eligible: async (ctx: WitnessContext) => {
    const auth = await realAuthOutcome(ctx.callerUid, OPERATION_REQUIRED_CAPABILITY[ctx.operation]);
    if (!auth.ok) return null;
    return isValidAssignmentTarget({
      candidate: { uid: ctx.callerUid, workspaceId: WS_ID, role: auth.membership.role, status: "active" },
      runWorkspaceId: WS_ID,
      creatorUid: canonicalRunCreatorUid(),
    }).eligible;
  },
});
type GuardOperandKey = keyof typeof GUARD_OPERAND_READERS;

/** Guard expressions, verbatim from the production source — asserted against the AST inventory below. */
const G = Object.freeze({
  authDenied: "!auth.ok",
  researchRead: '!roleHasCapability(auth.membership.role, "research.read")',
  runAbsent: "!runSnap.exists",
  targetInvalid: 'target.kind !== "valid_workspace_review_target"',
  panelFinalized: 'current.status === "finalized"',
  panelNotOpen: 'current.status !== "open"',
  notOnRoster: "!panel.reviewerUserIds.includes(args.uid)",
  notEligible: "!eligibility.eligible",
});

type SiteGuardFacts = (ctx: WitnessContext) => Promise<readonly GuardFact[]>;

const SITE_GUARD_FACTS: Readonly<Record<string, SiteGuardFacts>> = Object.freeze({
  // ── the three authorization passthrough sites: the REAL authorizer must deny, with this reason ──
  ...Object.fromEntries((["create", "cancel", "vote"] as const).map((op) => [`${op}#reject-03`, async ({ callerUid, reason }: WitnessContext) => [
    { fromGuard: G.authDenied, operand: "authOk" as const, label: "auth.ok", expected: false, flipOperand: grantRealAuthTo(callerUid) },
    { fromGuard: G.authDenied, operand: "authReason" as const, label: "auth.reason", expected: reason, flipOperand: changeRealAuthReason(reason) },
  ]])),
  // ── the inline research.read checks: authorization SUCCEEDS, then the capability is denied ──
  ...(["create", "cancel"] as const).reduce((acc, op) => ({ ...acc, [`${op}#reject-04`]: async () => [
    { fromGuard: G.authDenied, operand: "authOk" as const, label: "auth.ok (predecessor: the operand must be TRUE so `!auth.ok` is false)", expected: true, flipOperand: revokeRealAuth },
    { fromGuard: G.researchRead, operand: "researchRead" as const, label: "roleHasCapability(role, research.read)", expected: false, flipOperand: restoreRealCapabilities },
  ] }), {} as Record<string, SiteGuardFacts>),
  // ── run_not_found twins: absent document vs present-but-not-this-Workspace ──
  ...(["create", "cancel", "vote"] as const).reduce((acc, op) => ({
    ...acc,
    [`${op}#reject-0${op === "vote" ? 4 : 5}`]: async () => [
      { fromGuard: G.runAbsent, operand: "runExists" as const, label: "runSnap.exists", expected: false, flipOperand: () => { seedRun(); } },
    ],
    [`${op}#reject-0${op === "vote" ? 5 : 6}`]: async () => [
      { fromGuard: G.runAbsent, operand: "runExists" as const, label: "runSnap.exists (predecessor: the operand must be TRUE)", expected: true, flipOperand: () => { stores.runs.delete(RUN_ID); } },
      { fromGuard: G.targetInvalid, operand: "targetIsValid" as const, label: "target.kind is valid", expected: false, flipOperand: () => { seedRun(); } },
    ],
  }), {} as Record<string, SiteGuardFacts>),
  // ── create's panel_finalized twins: genuinely finalized vs cancelled-and-never-reopened ──
  "create#reject-10": async () => [
    { fromGuard: G.panelFinalized, operand: "panelStatus" as const, label: "current.status", expected: "finalized", flipOperand: () => { seedPanel({ revision: 1 }); } },
  ],
  "create#reject-11": async () => [
    { fromGuard: G.panelFinalized, operand: "panelStatus" as const, relation: "notEquals" as const, label: "current.status (predecessor: NOT finalized)", expected: "finalized", flipOperand: () => { seedPanel({ revision: 1, ...FINALIZED }); } },
    { fromGuard: G.panelNotOpen, operand: "panelStatus" as const, relation: "notEquals" as const, label: "current.status (its own guard: NOT open)", expected: "open", flipOperand: () => { seedPanel({ revision: 1 }); } },
  ],
  // ── vote's not_reviewer twins: off the roster vs on it but ineligible ──
  "vote#reject-12": async ({ callerUid }: WitnessContext) => [
    { fromGuard: G.notOnRoster, operand: "callerOnRoster" as const, label: "panel.reviewerUserIds.includes(caller)", expected: false, flipOperand: () => { seedPanel({ revision: 1, reviewerUserIds: [callerUid, OWNER_UID, ADMIN_UID].sort() }); } },
  ],
  "vote#reject-13": async ({ callerUid }: WitnessContext) => [
    { fromGuard: G.notOnRoster, operand: "callerOnRoster" as const, label: "panel.reviewerUserIds.includes(caller) (predecessor: the operand must be TRUE)", expected: true, flipOperand: () => { seedPanel({ revision: 1, reviewerUserIds: [REVIEWER_UID, REVIEWER2_UID, REVIEWER3_UID].sort() }); } },
    { fromGuard: G.notEligible, operand: "eligible" as const, label: "eligibility.eligible", expected: false, flipOperand: restoreRealCapabilities },
  ],
});

/**
 * R10 — resolves each declared fact's `actual` from the GUARD REGISTRY, and proves the read is PURE:
 * the reader is invoked twice with no intervening mutation and must agree. A stateful reader — R9's
 * monotone-counter attack shape — fails here rather than sliding through the operand-change step.
 */
async function resolveGuardFacts(siteId: string, ctx: WitnessContext): Promise<GuardFact[]> {
  const declared = await SITE_GUARD_FACTS[siteId](ctx);
  const resolved: GuardFact[] = [];
  for (const fact of declared) {
    resolved.push({ ...fact, actual: await readOperandPurely(`${siteId}/${fact.operand}`, GUARD_OPERAND_READERS[fact.operand], ctx) });
  }
  return resolved;
}

/**
 * Invokes an operand reader twice with no intervening mutation and requires agreement. R9's
 * monotone-counter attack — a fact whose value "changes" on every read, so the operand-change step is
 * satisfied without reading production state at all — fails here. Extracted so the check itself is
 * directly testable: the registry is frozen, so a test cannot install an impure reader into it.
 */
async function readOperandPurely(
  label: string,
  reader: (ctx: WitnessContext) => Promise<unknown> | unknown,
  ctx: WitnessContext
): Promise<unknown> {
  const first = await reader(ctx);
  const second = await reader(ctx);
  if (String(first) !== String(second)) {
    throw new Error(`R10 harness: the operand reader for ${label} is not PURE (${String(first)} then ${String(second)}) — a guard fact may not depend on harness state`);
  }
  return first;
}

/** The witness: assert every declared guard fact. A witness with no facts is rejected by §35. */
/** True when the fact's resolved operand satisfies the relation its production guard applies. */
function guardFactHolds(fact: GuardFact): boolean {
  return (fact.relation ?? "equals") === "notEquals"
    ? String(fact.actual) !== String(fact.expected)
    : String(fact.actual) === String(fact.expected);
}

async function runSiteWitness(siteId: string, ctx: WitnessContext): Promise<void> {
  /**
   * R10 (A's F6) — the witness ledger is written HERE and nowhere else. R9 had four test bodies calling
   * `executedWitnessIds.add(...)`, so the ledger the module `afterAll` reconciles was writable by the
   * thing it audits — the same shape as the atomicity results. Recording on entry means a witness is
   * credited only by actually running, and the source guard below pins that this is the sole writer.
   */
  executedWitnessIds.add(siteId);
  const facts = await resolveGuardFacts(siteId, ctx);
  expect(`${siteId}:factCount>0:${facts.length > 0}`).toBe(`${siteId}:factCount>0:true`);
  for (const fact of facts) {
    const relation = (fact.relation ?? "equals") === "notEquals" ? "!==" : "===";
    expect(`${siteId}:${fact.label}:${String(fact.actual)} ${relation} ${String(fact.expected)}:${guardFactHolds(fact)}`)
      .toBe(`${siteId}:${fact.label}:${String(fact.actual)} ${relation} ${String(fact.expected)}:true`);
  }
}

const SITE_WITNESSES = SITE_GUARD_FACTS;

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
  /**
   * R9 §60 — TERMINOLOGY, pinned. `REASON_TWIN_PAIRS` holds DIRECTED pairs: each unordered twin pair
   * appears twice, once per direction, because a witness must be proved to reject its twin's state in
   * both directions. Earlier PR text conflated the directed-entry count with a pair count (see
   * RETRACTED_PHRASES entry 4). The correct statement is SEVEN unordered pairs spanning FOURTEEN sites,
   * exercised as FOURTEEN directed checks — [[count:twinUnorderedPairs=7]] pairs,
   * [[count:twinSites=14]] sites, [[count:twinDirectedChecks=14]] checks. All three are pinned so no one guesses
   * which of them a later sentence means.
   */
  it("§60 — the twin structure is 7 unordered pairs over 14 sites, exercised as 14 directed checks", () => {
    const directed = REASON_TWIN_PAIRS.length;
    const unordered = new Set(REASON_TWIN_PAIRS.map(([a, b, reason]) => `${[a, b].sort().join("|")}::${reason}`)).size;
    const sites = new Set(REASON_TWIN_PAIRS.flatMap(([a, b]) => [a, b])).size;
    expect(`directedEntries:${directed} unorderedPairs:${unordered} distinctSites:${sites}`).toBe("directedEntries:14 unorderedPairs:7 distinctSites:14");
    // and the two keyings are genuinely different, so the distinction is not pedantry
    expect(`directedIsTwiceUnordered:${directed === unordered * 2}`).toBe("directedIsTwiceUnordered:true");
  });

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

  /**
   * ─── R9 §36/§37 — EVERY GUARD FACT HAS A BEHAVIORAL OPERAND FALSIFIER ──────────────────────────
   *
   * This is the test R8 did not have, and its absence is why blocker B stood. For every witnessed
   * site, for EVERY case at that site, for EVERY declared fact:
   *
   *   1. the witness accepts the arranged state (baseline);
   *   2. `flipOperand()` mutates the canonical artifact or mocked dependency the operand comes from;
   *   3. the operand's OBSERVED VALUE must have changed — a fact that reports a constant, a coerced
   *      tautology, or an incidental field it does not actually read cannot pass this;
   *   4. THAT fact must no longer satisfy its own expectation — so a flip cannot be credited because
   *      some other fact broke, which is the mistake that made R8's own MAJOR-2 check invalid;
   *   5. the witness must reject.
   *
   * §39 stands unchanged: this proves the arranged PRECONDITIONS, not that the target source line
   * executed. Direct site-local ghost mutation remains the execution anchor.
   */
  it.each(Object.keys(SITE_GUARD_FACTS).sort().map((siteId) => [siteId] as const))(
    "§37 — every guard fact at %s is load-bearing: flipping its real operand breaks that fact and the witness",
    async (siteId) => {
      const cases = REJECTION_CASES.filter((c) => c.siteId === siteId);
      expect(`${siteId}:casesRegistered:${cases.length > 0}`).toBe(`${siteId}:casesRegistered:true`);
      let factsChecked = 0;
      for (const testCase of cases) {
        seedBaseFixture();
        testCase.arrange?.();
        const ctx = contextFor(testCase);
        const arranged = await resolveGuardFacts(siteId, ctx);
        expect(`${siteId}/${testCase.reason}:factCount>0:${arranged.length > 0}`).toBe(`${siteId}/${testCase.reason}:factCount>0:true`);
        // (1) baseline — the witness accepts what this case arranges
        await runSiteWitness(siteId, ctx);

        for (let index = 0; index < arranged.length; index += 1) {
          seedBaseFixture();
          testCase.arrange?.();
          const before = await resolveGuardFacts(siteId, ctx);
          const tag = `${siteId}/${testCase.reason}#${index}(${before[index].label})`;
          const beforeValue = String(before[index].actual);
          // (2) flip the REAL operand
          before[index].flipOperand();
          const after = await resolveGuardFacts(siteId, ctx);
          // (3) the operand's observed value really moved
          expect(`${tag}:operandChanged:${String(after[index].actual) !== beforeValue}`).toBe(`${tag}:operandChanged:true`);
          // (4) and THIS fact is the one that no longer holds, judged by its own guard RELATION
          expect(`${tag}:stillSatisfiesItsExpectation:${guardFactHolds(after[index])}`).toBe(`${tag}:stillSatisfiesItsExpectation:false`);
          // (5) so the witness rejects
          await expect(runSiteWitness(siteId, ctx)).rejects.toThrow();
          factsChecked += 1;
        }
      }
      expect(`${siteId}:factsFalsified:${factsChecked > 0}`).toBe(`${siteId}:factsFalsified:true`);
    }
  );

  /**
   * ─── R10 — THE ATTACKS THAT DEFEATED §37, NOW INEXPRESSIBLE ────────────────────────────────────
   *
   * R9 gave a fact a free-form `actual`, so it could read anything and merely had to CO-VARY with the
   * fixtures. Two attacks passed: an incidental field (`panel.finalDecisionId`, present in no guard) and
   * a stateful reader. Both are now impossible by construction rather than caught after the fact — a
   * fact supplies a guard key, and the registry supplies the read. These tests pin that.
   */
  it("R10 — a fact can only name a reader the GUARD REGISTRY provides, so an incidental field is inexpressible", () => {
    // every declared fact's operand must be a registry key: there is nowhere else to get a value from
    const keys = new Set(Object.keys(GUARD_OPERAND_READERS));
    expect([...keys].sort()).toEqual(["authOk", "authReason", "callerOnRoster", "eligible", "panelStatus", "researchRead", "runExists", "targetIsValid"]);
    // NEGATIVE CONTROL — the field R9's surviving attack used is not a readable operand
    expect(keys.has("finalDecisionId" as never)).toBe(false);
    expect(keys.has("createdByUserId" as never)).toBe(false);
    // and every reader is reachable from a declared fact, so the registry cannot carry dead entries
    const declaredOperands = new Set<string>();
    for (const siteId of Object.keys(SITE_GUARD_FACTS)) {
      void siteId;
    }
    expect(keys.size).toBe(8);
  });

  it("R10 — every declared fact's operand resolves through the registry, and no fact carries its own expression", async () => {
    const used = new Set<string>();
    for (const siteId of Object.keys(SITE_GUARD_FACTS)) {
      const example = REJECTION_CASES.find((c) => c.siteId === siteId);
      expect(`${siteId}:hasCase:${Boolean(example)}`).toBe(`${siteId}:hasCase:true`);
      seedBaseFixture();
      (example as RejectionCase).arrange?.();
      for (const fact of await SITE_GUARD_FACTS[siteId](contextFor(example as RejectionCase))) {
        expect(`${siteId}:operandIsARegistryKey:${fact.operand in GUARD_OPERAND_READERS}`).toBe(`${siteId}:operandIsARegistryKey:true`);
        // the DECLARED fact has no value of its own — it cannot smuggle one in
        expect(`${siteId}:factCarriesNoOwnValue:${fact.actual === undefined}`).toBe(`${siteId}:factCarriesNoOwnValue:true`);
        used.add(fact.operand);
      }
    }
    // no dead registry entry: every reader is exercised by a real site
    expect(`unusedRegistryReaders:${Object.keys(GUARD_OPERAND_READERS).filter((k) => !used.has(k)).sort().join(",")}`).toBe("unusedRegistryReaders:");
  });

  it("R10 — a STATEFUL operand reader is rejected as impure, which is R9's monotone-counter attack", async () => {
    const impure: Readonly<Record<string, () => unknown>> = { counter: (() => { let n = 0; return () => n++; })() };
    // the same purity check `resolveGuardFacts` applies, run against a deliberately stateful reader
    const first = impure.counter();
    const second = impure.counter();
    expect(`statefulReaderDisagreesWithItself:${String(first) !== String(second)}`).toBe("statefulReaderDisagreesWithItself:true");
    // POSITIVE CONTROL — every real registry reader agrees with itself under the same check
    seedBaseFixture();
    const ctx: WitnessContext = { callerUid: OWNER_UID, reason: "run_not_found", operation: "create" };
    for (const [key, reader] of Object.entries(GUARD_OPERAND_READERS)) {
      const a = await reader(ctx);
      const b = await reader(ctx);
      expect(`${key}:pure:${String(a) === String(b)}`).toBe(`${key}:pure:true`);
    }
  });

  it("R10 — the purity check really rejects an impure reader, and accepts a real one", async () => {
    seedBaseFixture();
    const ctx: WitnessContext = { callerUid: OWNER_UID, reason: "panel_finalized", operation: "create" };
    let n = 0;
    await expect(readOperandPurely("synthetic/counter", () => `drifting-${n++}`, ctx)).rejects.toThrow(/is not PURE/);
    // POSITIVE CONTROL — the real reader for the same guard passes the identical check
    seedPanel({ revision: 1, ...FINALIZED });
    await expect(readOperandPurely("real/panelStatus", GUARD_OPERAND_READERS.panelStatus, ctx)).resolves.toBe("finalized");
  });

  it("R10 — the guard registry is FROZEN, so no test can install a reader of its own", () => {
    expect(Object.isFrozen(GUARD_OPERAND_READERS)).toBe(true);
    expect(() => {
      "use strict";
      (GUARD_OPERAND_READERS as Record<string, unknown>).panelStatus = () => "forged";
    }).toThrow();
    expect(GUARD_OPERAND_READERS.panelStatus).toBeInstanceOf(Function);
  });

  /**
   * R9 §36 — THE COERCED-TAUTOLOGY ATTACK, reproduced against the meta-test above rather than
   * asserted to be impossible. A fact naming the correct guard whose predicate is `String(x) ===
   * String(x)` passes R8's name check and R8's two-fixture separation; it cannot survive step (3),
   * because flipping the operand does not change a self-comparison's value.
   */
  it("§36 — a String()-coerced tautology over a REAL operand fails the operand-change step", async () => {
    seedBaseFixture();
    stores.runs.delete(RUN_ID);
    const tautology: GuardFact = {
      fromGuard: G.runAbsent,
      label: "runSnap.exists (tautology)",
      actual: String(stores.runs.has(RUN_ID)) === String(stores.runs.has(RUN_ID)),
      expected: true,
      flipOperand: () => { seedRun(); },
    };
    const reread = (): GuardFact => ({ ...tautology, actual: String(stores.runs.has(RUN_ID)) === String(stores.runs.has(RUN_ID)) });
    const beforeValue = String(reread().actual);
    tautology.flipOperand();
    // the operand moved in reality, but the tautology's value did not — step (3) fails
    expect(`realOperandMoved:${stores.runs.has(RUN_ID)}`).toBe("realOperandMoved:true");
    expect(`tautologyOperandChanged:${String(reread().actual) !== beforeValue}`).toBe("tautologyOperandChanged:false");
  });

  it("§36 — a CONSTANT-TRUE predicate naming a real guard fails the same step", async () => {
    seedBaseFixture();
    stores.runs.delete(RUN_ID);
    const constantFact: GuardFact = { fromGuard: G.runAbsent, label: "runSnap.exists (constant)", actual: true, expected: true, flipOperand: () => { seedRun(); } };
    const beforeValue = String(constantFact.actual);
    constantFact.flipOperand();
    expect(`constantOperandChanged:${String(constantFact.actual) !== beforeValue}`).toBe("constantOperandChanged:false");
  });

  /**
   * R9 §36 — AN INCIDENTAL-FIELD predicate. R8's own blocker used facts keyed on fields that appear in
   * no guard; the name check could not see it because the `fromGuard` string was a real guard's text.
   * Here the operand is `panel.createdByUserId` — a field in no guard — and flipping the guard's REAL
   * operand (the run document) leaves it unmoved.
   */
  it("§36 — an INCIDENTAL-field predicate is unmoved by a flip of the guard's real operand", async () => {
    seedBaseFixture();
    seedPanel({ revision: 1 });
    stores.runs.delete(RUN_ID);
    const incidental = () => (stores.humanReviewPanel.get(`${RUN_ID}::current`) as { createdByUserId: string }).createdByUserId;
    const beforeValue = incidental();
    seedRun(); // the REAL operand of `!runSnap.exists`
    expect(`realOperandMoved:${stores.runs.has(RUN_ID)}`).toBe("realOperandMoved:true");
    expect(`incidentalOperandChanged:${incidental() !== beforeValue}`).toBe("incidentalOperandChanged:false");
  });

  it.each(REASON_TWIN_PAIRS)("the %s witness accepts its own arranged state and REJECTS its %s twin's (%s)", async (site, twin, reason) => {
    const own = caseFor(site, reason);
    const other = caseFor(twin, reason);
    expect(`bothCasesRegistered:${Boolean(own)}/${Boolean(other)}`).toBe("bothCasesRegistered:true/true");
    expect(`witnessPresent:${site}:${Boolean(SITE_GUARD_FACTS[site])}`).toBe(`witnessPresent:${site}:true`);

    seedBaseFixture();
    (own as RejectionCase).arrange?.();
    await runSiteWitness(site, contextFor(own as RejectionCase));

    seedBaseFixture();
    (other as RejectionCase).arrange?.();
    await expect(runSiteWitness(site, contextFor(other as RejectionCase))).rejects.toThrow();
  });

  /**
   * §33 — THE ANCHORING CHECK, and the reason an incidental discriminator is now inexpressible.
   * Every guard fact names the production guard expression it is an operand of, and that string must
   * be this site's own `guardExpr` or that of a LOWER-ordinal site in the same operation — a
   * short-circuit predecessor control had to pass. A fact about `panel.createdByUserId`, which
   * appears in no guard anywhere, cannot be declared.
   */
  /**
   * R10 (B's F-m2) — `realAuthOutcome`'s "invokes the REAL authorization mechanism" was enforced by
   * nothing: replacing its body with a hand-rolled classifier that never calls the production authorizer
   * left the suite green. The claim is now checked against this file's own AST, the same way the log ban
   * is, so a body that stops calling the dependency fails here.
   */
  it("R10 — `runSiteWitness` is the ONLY writer of the witness ledger, so no test body can credit a witness", () => {
    // counted over the AST, so a prose mention in a doc comment is not an occurrence — the same
    // read-tokens-not-text discipline the log ban uses, and the reason a regex count was wrong here
    const source = readFileSync(__filename, "utf8");
    const sf = tsApi.createSourceFile("spec.ts", source, tsApi.ScriptTarget.ES2020, true);
    const writers: string[] = [];
    const walk = (node: tsApi.Node, owner: string): void => {
      const nextOwner = tsApi.isFunctionDeclaration(node) && node.name ? node.name.text : owner;
      if (tsApi.isCallExpression(node) && tsApi.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "add"
          && node.expression.expression.getText(sf) === "executedWitnessIds") {
        writers.push(nextOwner || "<module-scope>");
      }
      tsApi.forEachChild(node, (child) => walk(child, nextOwner));
    };
    walk(sf, "");
    expect(`witnessLedgerWriters:${writers.join(",")}`).toBe("witnessLedgerWriters:runSiteWitness");
  });

  it("R10 — a prototype-named collection is an ORDINARY store the diff can see, not Object.prototype", async () => {
    const before = snapshotStore();
    await mockAdminDb.collection("__proto__").doc("forged").set({ action: "adaptive_review_panel_created", byUid: "attacker" });
    expect(diffStore(before, snapshotStore()).added).toEqual(["__proto__/forged"]);
    expect(`storeIsNotObjectPrototype:${(storeFor("__proto__") as unknown) !== (Object.prototype as unknown)}`).toBe("storeIsNotObjectPrototype:true");
    expect(`nullPrototype:${Object.getPrototypeOf(stores) === null}`).toBe("nullPrototype:true");
  });

  it("R10 — `realAuthOutcome` really calls authorizeTeamWorkspaceMutationInTransaction, and every auth reader routes through it", () => {
    const sf = tsApi.createSourceFile("spec.ts", readFileSync(__filename, "utf8"), tsApi.ScriptTarget.ES2020, true);
    const callsInside = (functionName: string): string[] => {
      const found: string[] = [];
      const walk = (node: tsApi.Node): void => {
        const isTarget =
          (tsApi.isFunctionDeclaration(node) && node.name?.text === functionName) ||
          (tsApi.isVariableDeclaration(node) && tsApi.isIdentifier(node.name) && node.name.text === functionName);
        if (isTarget) {
          const inner = (n: tsApi.Node): void => {
            if (tsApi.isCallExpression(n) && tsApi.isIdentifier(n.expression)) found.push(n.expression.text);
            tsApi.forEachChild(n, inner);
          };
          tsApi.forEachChild(node, inner);
        }
        tsApi.forEachChild(node, walk);
      };
      walk(sf);
      return found;
    };
    expect(callsInside("realAuthOutcome")).toContain("authorizeTeamWorkspaceMutationInTransaction");
    // NEGATIVE CONTROL — the detector can say no
    expect(callsInside("storedRunTargetKind")).not.toContain("authorizeTeamWorkspaceMutationInTransaction");
    // and every auth-derived registry reader goes through `realAuthOutcome`
    const registrySource = [GUARD_OPERAND_READERS.authOk, GUARD_OPERAND_READERS.authReason, GUARD_OPERAND_READERS.researchRead, GUARD_OPERAND_READERS.eligible].map((f) => f.toString()).join("");
    expect(`authReadersUsingTheRealAuthorizer:${(registrySource.match(/realAuthOutcome/g) ?? []).length}`).toBe("authReadersUsingTheRealAuthorizer:4");
  });

  it("§33 — every guard fact names a REAL guard: this site's own, or a preceding one in the same operation", async () => {
    const bySite = new Map(DISCOVERED_REJECTION_SITES.map((s) => [s.siteId, s]));
    const problems: string[] = [];
    for (const siteId of Object.keys(SITE_GUARD_FACTS)) {
      const site = bySite.get(siteId);
      if (!site) { problems.push(`${siteId}:notADiscoveredSite`); continue; }
      const permitted = new Set(DISCOVERED_REJECTION_SITES.filter((s) => s.operation === site.operation && s.ordinal <= site.ordinal).map((s) => s.guardExpr));
      const example = REJECTION_CASES.find((c) => c.siteId === siteId);
      seedBaseFixture();
      example?.arrange?.();
      const facts = await resolveGuardFacts(siteId, contextFor(example as RejectionCase));
      if (facts.length === 0) problems.push(`${siteId}:noFacts`);
      if (!facts.some((fact) => fact.fromGuard === site.guardExpr)) problems.push(`${siteId}:noFactOnItsOwnGuard`);
      for (const fact of facts) {
        if (!permitted.has(fact.fromGuard)) problems.push(`${siteId}:factCitesAGuardThatIsNotItsOwnOrPreceding(${fact.fromGuard})`);
      }
    }
    expect(`guardAnchoringProblems:${problems.join(" | ")}`).toBe("guardAnchoringProblems:");
  });

  /**
   * §39 — EVERY AUTH REASON LEG IS LOAD-BEARING. R7 found all seven reason legs of the old
   * passthrough witness could be deleted with the suite green: it only asserted a fact about the
   * capability mock, which is true for every reason, so the 21 expanded obligations were protected by
   * table membership alone. Each leg is now proved individually: with the fixture arranged for reason
   * A, the witness invoked with any OTHER reason must REJECT. A witness that stops comparing the
   * reason therefore fails 42 ways, not zero.
   */
  it.each((["create", "cancel", "vote"] as const).flatMap((op) => AUTH_DENIAL_REASONS.map((reason) => [`${op}#reject-03`, reason] as const)))(
    "%s — the witness rejects a context claiming any reason other than %s",
    async (siteId, reason) => {
      const own = caseFor(siteId, reason);
      expect(`caseRegistered:${siteId}/${reason}:${Boolean(own)}`).toBe(`caseRegistered:${siteId}/${reason}:true`);
      seedBaseFixture();
      (own as RejectionCase).arrange?.();
      const ctx = contextFor(own as RejectionCase);
      await runSiteWitness(siteId, ctx);
      for (const other of AUTH_DENIAL_REASONS.filter((r) => r !== reason)) {
        await expect(runSiteWitness(siteId, { ...ctx, reason: other })).rejects.toThrow();
      }
    }
  );

  /**
   * §41 — a witness count is bookkeeping. Every witness included in a security claim must actually be
   * invoked by a committed test. The declared side is the map's keys; the executed side is recorded by
   * the runner and the twin meta-test. R7 found the 15th witness was never invoked and could be emptied.
   */
  // §41 is asserted in the module-scope `afterAll` below: it is a statement about the whole run, and
  // an `it` placed here would evaluate before the rejection cases had executed any witness.

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
  /**
   * R10 (B's F-m3) — the vote path's required capability was not discriminated. Changing
   * `OPERATION_REQUIRED_CAPABILITY.vote` from `reviews.submit` to `reviews.manage` left the suite green,
   * because the `insufficient_capability` leg is arranged with a VIEWER who holds neither. A `member`
   * holds `reviews.submit` and NOT `reviews.manage`, so it separates them.
   */
  it("R10 — the vote path demands reviews.submit, not reviews.manage: a member separates the two", async () => {
    const roleHas = (role: string, capability: string) => actualCapabilities.roleHasCapability(role, capability);
    // the discriminating role really is discriminating
    expect(`member:submit=${roleHas("member", "reviews.submit")} manage=${roleHas("member", "reviews.manage")}`).toBe("member:submit=true manage=false");
    expect(`viewer:submit=${roleHas("viewer", "reviews.submit")} manage=${roleHas("viewer", "reviews.manage")}`).toBe("viewer:submit=false manage=false");
    // and the constant under test matches what production actually demands of the vote path
    expect(`declared:${OPERATION_REQUIRED_CAPABILITY.vote}`).toBe("declared:reviews.submit");
    expect(PANEL_MUTATIONS_SOURCE).toContain('requiredCapability: "reviews.submit"');
    // BEHAVIOURAL: a member on the roster passes authorization (so the capability is submit, not manage)
    // and is rejected later, for eligibility — never `insufficient_capability`.
    seedBaseFixture();
    seedPanel({ revision: 1, reviewerUserIds: [MEMBER_UID, REVIEWER_UID, REVIEWER2_UID].sort() });
    const auth = await realAuthOutcome(MEMBER_UID, "reviews.submit");
    expect(`memberPassesSubmit:${auth.ok}`).toBe("memberPassesSubmit:true");
    const asManage = await realAuthOutcome(MEMBER_UID, "reviews.manage");
    expect(`memberFailsManage:${asManage.ok === false && !asManage.ok && asManage.reason === "insufficient_capability"}`).toBe("memberFailsManage:true");
  });

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
/** §41 — which witnesses a committed test actually invoked. */
const executedWitnessIds = new Set<string>();
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
    if (SITE_GUARD_FACTS[testCase.siteId]) {
      await runSiteWitness(testCase.siteId, { callerUid: testCase.resolveCallerUid?.() ?? testCase.callerUid ?? OWNER_UID, reason: testCase.reason, operation: testCase.siteId.split("#")[0] as "create" | "cancel" | "vote" });
    }
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
/**
 * ─── R8 §48–§50 — A REAL CITATION RESOLVER, NOT A SPELL-CHECK ─────────────────────────────────
 *
 * R7 MAJOR: the previous check was `/#reject-|parse[A-Z]|build[A-Z]|.../.test(reason)`, which tests
 * for a TOKEN, not a mechanism. A flatly false reason — "buildAbsolutelyNothing: equal because the
 * moon is made of cheese" — passed, while only a reason containing no matching token failed.
 *
 * A citation must now RESOLVE. Site ids are resolved against the AST inventory; mechanism
 * identifiers are resolved against the exported symbols of the modules the production file actually
 * imports, parsed from their sources. A fabricated or renamed identifier is unresolved and fails.
 */
/**
 * ─── R9 §46–§51 — CITATIONS ARE TYPED REFERENCES RESOLVED AGAINST REAL ARTIFACTS ────────────────
 *
 * R8's resolver was a DENY-LIST over seven verb prefixes applied to free prose, and it failed in both
 * directions:
 *   • it ACCEPTED any sentence containing no verb-prefixed token, so plain prose passed as a citation —
 *     which is the laundering R7's own blocker was supposed to have closed;
 *   • it REJECTED real mechanisms, `parseGovernanceRecord` among them, because its module universe was
 *     a HARDCODED list of eight paths while the dependency pin already knew the production module's
 *     twenty-four imports. A correct citation failed and a fabricated one passed.
 *
 * A citation is now a TYPED REFERENCE with an explicit kind marker, and every reason must carry at
 * least one:
 *   site:<op>#reject-NN   resolved against the AST rejection-site inventory
 *   symbol:<Name>         resolved against the production module's own exports plus the exports of
 *                         EVERY module it imports — the same pinned inventory, not a second list
 *   test:"<exact title>"  resolved against this spec's own `it(...)` titles, parsed from the AST
 *   mechanism:<ID>        resolved against harness mechanism IDs declared beside their implementation
 *
 * §51 — WHAT A RESOLVED CITATION PROVES: that the referenced artifact EXISTS. Nothing more. It is a
 * navigation aid. Whether the artifact establishes the claim is settled by the mutation, test or
 * invariant itself, never by the citation resolving.
 */

/**
 * §48 — the symbol universe: the production module plus every module it imports, derived from the SAME
 * pinned import inventory the dependency guard uses. Relative specifiers resolve next to the module;
 * `@/`-prefixed ones resolve from the repository root. A module that cannot be read is recorded so the
 * universe cannot silently shrink.
 */
const CITATION_SYMBOL_UNIVERSE: { symbols: ReadonlySet<string>; modules: string[]; unreadable: string[] } = (() => {
  const symbols = new Set<string>();
  const modules: string[] = [];
  const unreadable: string[] = [];
  const repoRoot = joinPath(__dirname, "..", "..", "..");
  /**
   * R10 — `export { X as Y }` and module-LOCAL symbols are part of the universe too.
   *
   * R9 walked only declarations carrying an `export` modifier, so a re-export statement was invisible:
   * `symbol:ELIGIBLE_PANEL_REVIEWER_ROLES` — a genuine export of a directly-imported pinned module —
   * did not resolve. And because only exports were collected, this PR's own new helper
   * `appendPanelGovernanceEvent` could not be cited at all, which is the same "rejects real mechanisms"
   * failure R9 credited itself with fixing. `includeLocals` is used for the audited module, whose
   * internal helpers are legitimate citation targets for its own proof.
   */
  const collect = (source: string, includeLocals = false) => {
    const sf = tsApi.createSourceFile("m.ts", source, tsApi.ScriptTarget.ES2020, true);
    tsApi.forEachChild(sf, (node) => {
      // `export { A, B as C }` — a re-export statement carries no modifier on a declaration
      if (tsApi.isExportDeclaration(node) && node.exportClause && tsApi.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) symbols.add(element.name.text);
        return;
      }
      const exported = tsApi.canHaveModifiers(node) && tsApi.getModifiers(node)?.some((m) => m.kind === tsApi.SyntaxKind.ExportKeyword);
      if (!exported && !includeLocals) return;
      if (tsApi.isFunctionDeclaration(node) && node.name) symbols.add(node.name.text);
      if (tsApi.isClassDeclaration(node) && node.name) symbols.add(node.name.text);
      if (tsApi.isVariableStatement(node)) for (const d of node.declarationList.declarations) if (tsApi.isIdentifier(d.name)) symbols.add(d.name.text);
      if ((tsApi.isTypeAliasDeclaration(node) || tsApi.isInterfaceDeclaration(node)) && node.name) symbols.add(node.name.text);
    });
  };
  // the production module itself — INCLUDING its module-local helpers, which its own proof may cite
  collect(readFileSync(PANEL_MUTATIONS_SOURCE_PATH, "utf8"), true);
  modules.push("<the audited module>");
  // and every module it imports, taken from the pinned inventory
  for (const entry of deriveProductionWriteSurface(PANEL_MUTATIONS_SOURCE, Object.keys(PANEL_OPERATION_FUNCTIONS)).allImports) {
    const specifier = entry.split(" :: ")[0];
    if (specifier === "server-only" || specifier.startsWith("<") || !(specifier.startsWith("./") || specifier.startsWith("@/"))) continue;
    const candidate = specifier.startsWith("./")
      ? joinPath(__dirname, "..", `${specifier.slice(2)}.ts`)
      : joinPath(repoRoot, `${specifier.slice(2)}.ts`);
    try {
      collect(readFileSync(candidate, "utf8"));
      modules.push(specifier);
    } catch {
      unreadable.push(specifier);
    }
  }
  return { symbols, modules: modules.sort(), unreadable: unreadable.sort() };
})();

/**
 * §49 — harness mechanism IDs, declared HERE beside the mechanisms they name. A citation to a mechanism
 * resolves only if its ID is registered; deleting or renaming a mechanism invalidates the citation, and
 * a prose phrase that merely resembles one does not resolve.
 */
const HARNESS_MECHANISM_IDS: ReadonlySet<string> = new Set([
  "final-store-delta-oracle",
  "append-only-violation-ledger",
  "atomicity-injection-telemetry",
  "guard-fact-operand-falsifier",
  "local-call-graph-write-census",
  "log-authority-static-ban",
]);

/** §47 — every `it(...)` title this spec declares, parsed from its own AST. A renamed test invalidates its citations. */
const DECLARED_TEST_TITLES: ReadonlySet<string> = (() => {
  const titles = new Set<string>();
  const sf = tsApi.createSourceFile("spec.ts", readFileSync(__filename, "utf8"), tsApi.ScriptTarget.ES2020, true);
  const walk = (node: tsApi.Node) => {
    if (tsApi.isCallExpression(node)) {
      const callee = node.expression;
      const name = tsApi.isIdentifier(callee) ? callee.text : tsApi.isPropertyAccessExpression(callee) && tsApi.isIdentifier(callee.expression) ? callee.expression.text : null;
      if (name === "it" || name === "test") {
        const first = node.arguments[0];
        if (first && tsApi.isStringLiteral(first)) titles.add(first.text);
      }
    }
    tsApi.forEachChild(node, walk);
  };
  tsApi.forEachChild(sf, walk);
  return titles;
})();

type CitationReference = { kind: "site" | "symbol" | "test" | "mechanism"; value: string };

/** Extracts the TYPED references from a reason. Untyped prose yields none, which §50 then rejects. */
function parseCitations(reason: string): CitationReference[] {
  const references: CitationReference[] = [];
  for (const match of reason.matchAll(/\bsite:((?:create|cancel|vote)#reject-\d+)/g)) references.push({ kind: "site", value: match[1] });
  for (const match of reason.matchAll(/\bsymbol:([A-Za-z_$][A-Za-z0-9_$]*)/g)) references.push({ kind: "symbol", value: match[1] });
  for (const match of reason.matchAll(/\bmechanism:([a-z0-9-]+)/g)) references.push({ kind: "mechanism", value: match[1] });
  for (const match of reason.matchAll(/\btest:"([^"]+)"/g)) references.push({ kind: "test", value: match[1] });
  return references;
}

/** Returns the references that do NOT resolve, plus `<no-typed-citation>` when the reason carries none. */
function unresolvedCitations(reason: string): string[] {
  const references = parseCitations(reason);
  if (references.length === 0) return ["<no-typed-citation>"];
  const unresolved: string[] = [];
  for (const reference of references) {
    const resolves =
      reference.kind === "site" ? DISCOVERED_REJECTION_SITES.some((s) => s.siteId === reference.value)
      : reference.kind === "symbol" ? CITATION_SYMBOL_UNIVERSE.symbols.has(reference.value)
      : reference.kind === "mechanism" ? HARNESS_MECHANISM_IDS.has(reference.value)
      : DECLARED_TEST_TITLES.has(reference.value);
    if (!resolves) unresolved.push(`${reference.kind}:${reference.value}`);
  }
  return unresolved;
}

/**
 * §46 — the pinned split per action. A self-comparison joining or leaving this set fails, so proof
 * cannot silently become prose and prose cannot silently be counted as proof.
 */
const EXPECTED_EQUIVALENT_SPLIT: Readonly<Record<string, { proven: number; documented: readonly string[] }>> = Object.freeze({
  CREATE: { proven: 7, documented: ["byUid<-auth.membership.uid"] },
  RECONFIGURE: { proven: 6, documented: ["byUid<-auth.membership.uid"] },
  CANCEL: {
    proven: 2,
    documented: ["at<-nextPanel.updatedAt", "byUid<-auth.membership.uid", "panelRevision<-args.expectedRevision", "reviewerCount<-nextPanel.reviewerUserIds.length"],
  },
  VOTE: {
    proven: 3,
    documented: [
      "at<-nextVote.submittedAt",
      "byUid<-auth.membership.uid",
      "byUid<-nextVote.reviewerUserId",
      "commentPresent<-args.comment !== undefined",
      "conditionsCount<-args.conditions?.length ?? 0",
      "voteStatus<-args.status",
    ],
  },
});

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
  /**
   * R9 §11 — the COMPLETE durable change this action is allowed to make, besides its one event.
   * The provenance verdict is now taken from the final stored document resolved out of this delta,
   * so the matrix consumes the same authority as every other durable contract instead of reading
   * `soleCommittedGovernanceEvent()` — the attempted-write log — as R8 did.
   */
  allowedDelta: () => Omit<ExpectedDelta, "oneAddedUnder">;
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
 * The ACTOR, TIMESTAMP, NUMBER and MIRROR rows now read a snapshot of the real panel document taken
 * at seed time, before any mutation rewrites `updatedByUserId` or bumps the revision. A collapsed
 * fixture is then caught by the discrimination check itself, because the hostile value really does
 * equal the correct one and the collision is observable.
 *
 * R8 §44 — WHAT IS *NOT* CLAIMED. An earlier revision of this comment and of the PR body said "every
 * hostile value is read from a pre-call snapshot of the real panel document". That was false: roughly
 * 20 of the 93 hostile entries are, correctly, explicit constants — `hardcoded null`, `hardcoded 0`,
 * `the default fixture literal`, `hardcoded approved`. Those model a WRONG CONSTANT, not an alternate
 * artifact, and a literal is the right input for them. The honest statement is: an entry that models
 * an alternate CANONICAL SOURCE reads that source from the artifact; an entry that models a hardcoded
 * wrong answer is a literal and is labelled as one. The universal claim is retracted.
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
    equivalent: [["args.workspaceId", () => WS_ID, `symbol:resolveWorkspaceReviewTarget yields wrong_workspace unless run.workspaceId === args.workspaceId, and site:${rejectSiteForEquality} returns on any non-valid target`]],
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
    allowedDelta: () => ({ added: [PANEL_DOC_PATH()] }),
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
          ["nextPanel.createdByUserId", () => provPanel()?.createdByUserId, "symbol:buildNextAdaptiveHumanReviewPanel sets `createdByUserId: args.current?.createdByUserId ?? args.actorUserId`, and on a CREATE `current` is null, so it resolves to actorUserId = args.uid. NOTE: create and reconfigure share ONE production line, and the builder PRESERVES createdByUserId on a reconfigure — so re-sourcing this line is in fact KILLED by the RECONFIGURE matrix. A per-action equivalence at a shared site is a statement about that action's values, never a claim that the mutant survives."],
          ["nextPanel.updatedByUserId", () => provPanel()?.updatedByUserId, "symbol:buildNextAdaptiveHumanReviewPanel sets updatedByUserId from actorUserId, and the call site passes args.uid"],
          ["auth.membership.uid", () => PROV_CALLER_MANAGE, "symbol:validateMembershipBinding rejects a membership whose uid differs from the requested one, and authorization is called with args.uid"],
        ],
      },
      {
        field: "at",
        correctSource: "now (the request's own clock)",
        correct: () => MUTATE_NOW,
        discriminated: [["govParse.record.updatedAt", () => provRun().governanceRecord.updatedAt]],
        equivalent: [
          ["nextPanel.createdAt", () => provPanel()?.createdAt, "symbol:buildNextAdaptiveHumanReviewPanel sets createdAt from `now` on a first-time panel"],
          ["nextPanel.updatedAt", () => provPanel()?.updatedAt, "symbol:buildNextAdaptiveHumanReviewPanel sets updatedAt from `now`"],
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
        equivalent: [["args.expectedRevision + 1", () => 1, "symbol:buildNextAdaptiveHumanReviewPanel derives revision as (current?.revision ?? 0) + 1, and site:create#reject-12 rejects any mismatch with args.expectedRevision"]],
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
        equivalent: [["nextPanel.requiredReviewerCount", () => provPanel()?.requiredReviewerCount, "symbol:buildNextAdaptiveHumanReviewPanel derives requiredReviewerCount from the same normalized array, and symbol:parseAdaptiveHumanReviewPanel rejects any panel where they differ"]],
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
    allowedDelta: () => ({ modified: [PANEL_DOC_PATH()] }),
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
          ["nextPanel.updatedByUserId", () => provPanel()?.updatedByUserId, "symbol:buildNextAdaptiveHumanReviewPanel sets updatedByUserId from actorUserId, and the call site passes args.uid"],
          ["auth.membership.uid", () => PROV_CALLER_MANAGE, "symbol:validateMembershipBinding rejects a uid mismatch, and authorization is called with args.uid"],
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
        equivalent: [["nextPanel.updatedAt", () => provPanel()?.updatedAt, "symbol:buildNextAdaptiveHumanReviewPanel sets updatedAt from `now`"]],
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
        equivalent: [["args.expectedRevision + 1", () => PROV_PANEL_REVISION + 1, "symbol:buildNextAdaptiveHumanReviewPanel derives revision as current.revision + 1, and site:create#reject-12 rejects any mismatch with args.expectedRevision"]],
      },
      {
        field: "priorPanelRevision",
        correctSource: "current.revision (the panel being replaced)",
        correct: () => seededPanel<number>("revision"),
        discriminated: [
          ["nextPanel.revision", () => provPanel()?.revision],
          ["hardcoded null", () => null],
        ],
        equivalent: [["args.expectedRevision", () => PROV_PANEL_REVISION, "site:create#reject-12 returns stale_revision unless current.revision === args.expectedRevision"]],
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
        equivalent: [["nextPanel.requiredReviewerCount", () => provPanel()?.requiredReviewerCount, "symbol:buildNextAdaptiveHumanReviewPanel derives it from the same normalized array, and symbol:parseAdaptiveHumanReviewPanel rejects any panel where they differ"]],
      },
      ...GOV_ROWS(),
    ],
  },
  // ────────────────────────────── CANCEL ──────────────────────────────
  {
    action: "adaptive_review_panel_cancelled",
    label: "CANCEL",
    seed: () => { seedProvenanceRun(); seedProvenancePanel([OWNER_UID, REVIEWER_UID, REVIEWER2_UID]); },
    allowedDelta: () => ({ modified: [PANEL_DOC_PATH()] }),
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
        equivalent: [["auth.membership.uid", () => PROV_CALLER_MANAGE, "symbol:validateMembershipBinding rejects a uid mismatch, and authorization is called with args.uid"]],
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
        equivalent: [["nextPanel.updatedAt", () => MUTATE_NOW, "symbol:buildCancelledAdaptiveHumanReviewPanel sets updatedAt from the same `now` the event uses"]],
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
        equivalent: [["args.expectedRevision", () => seededPanel<number>("revision"), "site:cancel#reject-12 returns stale_revision unless current.revision === args.expectedRevision"]],
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
          ["current.requiredReviewerCount", () => seededPanel<number>("requiredReviewerCount"), "symbol:parseAdaptiveHumanReviewPanel yields malformed unless requiredReviewerCount === reviewerUserIds.length, and site:cancel#reject-09 returns panel_unreadable on a malformed panel"],
          ["nextPanel.reviewerUserIds.length", () => seededPanel<string[]>("reviewerUserIds").length, "symbol:buildCancelledAdaptiveHumanReviewPanel preserves the roster verbatim, so the cancelled panel's length equals the current one's"],
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
    allowedDelta: () => ({ added: [VOTE_DOC_PATH(PROV_CALLER_VOTE, PROV_PANEL_REVISION)] }),
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
          ["nextVote.reviewerUserId", () => PROV_CALLER_VOTE, "symbol:buildAdaptiveHumanReviewVote sets reviewerUserId from its reviewerUserId argument, and the call site passes args.uid"],
          ["auth.membership.uid", () => PROV_CALLER_VOTE, "symbol:validateMembershipBinding rejects a uid mismatch, and authorization is called with args.uid"],
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
        equivalent: [["nextVote.submittedAt", () => MUTATE_NOW, "symbol:buildAdaptiveHumanReviewVote sets submittedAt from `now`"]],
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
          ["args.panelRevision", () => PROV_PANEL_REVISION, "site:vote#reject-10 returns panel_stale unless panel.revision === args.panelRevision"],
          ["nextVote.panelRevision", () => PROV_PANEL_REVISION, "symbol:buildAdaptiveHumanReviewVote sets panelRevision from args.panelRevision, which site:vote#reject-10 has already proved equal"],
        ],
      },
      {
        field: "voteStatus",
        correctSource: "nextVote.status",
        correct: () => "changes_requested",
        discriminated: [["hardcoded approved", () => "approved"]],
        equivalent: [["args.status", () => "changes_requested", "§47 — symbol:buildAdaptiveHumanReviewVote sets `status` as a pure projection of args.status: no validation, normalisation or defaulting, so the two expressions cannot differ. Classified equivalent rather than presented as canonical provenance."]],
      },
      {
        field: "commentPresent",
        correctSource: "nextVote.commentPresent",
        correct: () => true,
        discriminated: [["hardcoded false", () => false]],
        equivalent: [["args.comment !== undefined", () => true, "§41/§42 — equivalent under the SHIPPED CALL CONTRACT: the sole production caller passes `comment` through symbol:validateAdaptiveReviewCommentAndConditions, which maps an empty or whitespace-only string to `undefined` ('An empty string becomes absent, not an empty comment'), so Boolean(args.comment) and args.comment !== undefined agree for every value that can reach this module. See the call-site regression below."]],
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
        equivalent: [["args.conditions?.length ?? 0", () => 4, "§47 — symbol:buildAdaptiveHumanReviewVote computes `conditionsCount` as literally that expression: a pure projection of the request, not a normalisation, so the two cannot differ."]],
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

  /**
   * ─── R8 §46/§47 — A SELF-COMPARISON IS NOT PROOF, AND IS NEVER COUNTED AS ONE ──────────────────
   *
   * R7 MAJOR: 12 of 30 equivalence entries compared an expression to ITSELF — `read` and `correct`
   * were the same literal, constant or expression text — so `X === X` could not fail. Falsifying one
   * such premise in production went unnoticed by this very test. That is the same self-refuting shape
   * the corrections table already records for the distinctness test, recurring unacknowledged.
   *
   * Entries are now partitioned by comparing the two reader functions' SOURCE TEXT, so the rule
   * cannot go stale as entries are edited:
   *   • PROVEN — two genuinely different reads, asserted equal. Real evidence.
   *   • DOCUMENTED — a self-comparison: the harness cannot read the alternative independently, so it
   *     is recorded as documentation and explicitly NOT counted as a proven equivalent mutant.
   * Both counts are pinned, so silently converting proof into prose fails here.
   */
  /**
   * ─── R10 — A SELF-COMPARISON CANNOT BE DRESSED UP AS PROOF ───────────────────────────────────────
   *
   * R9 compared `fn.toString()` with whitespace stripped. Two edits defeated that: inserting a COMMENT
   * into one reader, and wrapping one in `String(...)`. Either re-labelled a tautology as PROVEN, and
   * with the pinned counts adjusted the suite exited 0 — so `provenEquivalents:18` measured textual
   * difference between two closures rather than independent evidence, while the PR body presented that
   * bucket as "Real evidence". `String(x)` dressed as a read is the same shape the guard-fact registry
   * exists to prevent, left unguarded one section over.
   *
   * Normalisation now strips comments and the coercion wrappers that add no read, and a pair counts as a
   * self-comparison when the normalised bodies are equal OR one CONTAINS the other — so wrapping,
   * padding or commenting a reader cannot manufacture a difference.
   */
  const readerSource = (fn: () => unknown) =>
    fn
      .toString()
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/\/\/[^\n]*/g, "")          // line comments
      .replace(/\s+/g, "")
      .replace(/^\(\)=>/, "")
      .replace(/^(?:String|Boolean|Number|JSON\.stringify)\((.*)\)$/, "$1")
      .replace(/^!!/, "")
      .replace(/^\((.*)\)$/, "$1");

  /** Two readers are the SAME read when one normalises to the other, or contains it. */
  const isSelfComparison = (a: () => unknown, b: () => unknown) => {
    const left = readerSource(a);
    const right = readerSource(b);
    return left === right || left.includes(right) || right.includes(left);
  };

  it("every EQUIVALENT entry is either PROVEN by two independent reads or declared DOCUMENTATION-ONLY", async () => {
    subject.seed();
    if (subject.canonicalIsCommitted) expect((await subject.call()).ok).toBe(true);
    const rows = subject.rows().flatMap((row) =>
      row.equivalent.map(([name, read, reason]) => ({
        field: row.field,
        name,
        reason,
        selfComparison: isSelfComparison(read, row.correct),
        equal: read() === row.correct(),
      }))
    );
    expect(rows.length).toBeGreaterThan(0);
    const proven = rows.filter((r) => !r.selfComparison);
    const documented = rows.filter((r) => r.selfComparison).map((r) => `${r.field}<-${r.name}`).sort();
    // the PROVEN ones must genuinely hold
    expect(proven.filter((r) => !r.equal).map((r) => `${r.field}<-${r.name}`)).toEqual([]);
    // the DOCUMENTED ones are pinned by name, so one cannot quietly join or leave the set
    expect(`${label}:provenEquivalents:${proven.length}`).toBe(`${label}:provenEquivalents:${EXPECTED_EQUIVALENT_SPLIT[label].proven}`);
    expect(`${label}:documentationOnly:${documented.join(",")}`).toBe(`${label}:documentationOnly:${EXPECTED_EQUIVALENT_SPLIT[label].documented.join(",")}`);
    // §48 — every mechanism a reason cites must RESOLVE to something that exists in this repo
    const unresolved = rows.flatMap((r) => unresolvedCitations(r.reason).map((c) => `${r.field}<-${r.name}:${c}`));
    expect(`${label}:unresolvedCitations:${unresolved.join(" | ")}`).toBe(`${label}:unresolvedCitations:`);
  });

  it("R10 — a self-comparison stays DOCUMENTATION-ONLY when dressed with a comment, a coercion or padding", () => {
    const base = () => MUTATE_NOW;
    // C's EQ1: a comment inserted into one reader
    const commented = () => /* a note that adds no read */ MUTATE_NOW;
    // C's EQ2: a coercion wrapper
    const coerced = () => String(MUTATE_NOW);
    const doubleNegated = () => !!MUTATE_NOW;
    const parenthesised = () => (MUTATE_NOW);
    for (const [name, variant] of [["comment", commented], ["String()", coerced], ["!!", doubleNegated], ["parens", parenthesised]] as const) {
      expect(`${name}:stillASelfComparison:${isSelfComparison(variant as () => unknown, base)}`).toBe(`${name}:stillASelfComparison:true`);
    }
    // POSITIVE CONTROL — a genuinely different read is NOT a self-comparison, so the rule is not "always true"
    expect(`independentRead:${isSelfComparison(() => provPanel()?.updatedAt, base)}`).toBe("independentRead:false");
    expect(`anotherIndependentRead:${isSelfComparison(() => provRun().workspaceId, () => provRun().projectId)}`).toBe("anotherIndependentRead:false");
  });

  it("the event's EVERY authority-bearing field equals its canonical source and no wrong source", async () => {
    subject.seed();
    const preCall = subject.canonicalIsCommitted ? null : snapshotRows(subject.rows());
    // R9 §11 — the FINAL STORE, resolved out of the operation's complete allowed delta.
    const sole = await auditedSuccess(`PROV-${label}`, subject.allowedDelta(), () => subject.call());
    expect(`${label}:action:${String(sole.event.action)} path:${sole.path}`).toBe(`${label}:action:${subject.action} path:runs/${RUN_ID}/governanceEvents/auto-1`);
    const event = sole.event;
    for (const row of preCall ?? snapshotRows(subject.rows())) {
      expect(`${label}:${row.field}:${JSON.stringify(event[row.field])}`).toBe(`${label}:${row.field}:${JSON.stringify(row.correct)}`);
      for (const [name, wrongValue] of row.discriminated) {
        expect(`${label}:${row.field}!=${name}:${JSON.stringify(event[row.field]) === JSON.stringify(wrongValue)}`).toBe(`${label}:${row.field}!=${name}:false`);
      }
    }
  });

  it("the matrix is COMPLETE: the stored event has no field outside it, so a newly added field cannot escape the audit", async () => {
    subject.seed();
    const { event } = await auditedSuccess(`PROV-complete-${label}`, subject.allowedDelta(), () => subject.call());
    expect(Object.keys(event).sort()).toEqual(["action", ...subject.rows().map((r) => r.field)].sort());
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
    const beforeSnapshot = snapshotStore();
    forceOneConflict("runs", RUN_ID, () => seedRun());
    const result = await putCall();
    expect(result.ok).toBe(true);
    expect(`attempts:${transactionAttemptCount.value >= 2}`).toBe("attempts:true");
    // R8 §54 — the FINAL STORE is the commit verdict: the panel plus exactly one event document and
    // nothing else, so an aborted attempt's event cannot be counted from the log's auto-ids alone.
    // The conflict hook re-seeds an IDENTICAL run document, so the value-based diff correctly
    // reports no modification — a re-write of the same bytes is not a durable change.
    expectStoreDelta("CREATE-retry", beforeSnapshot, {
      oneAddedUnder: eventParentPath(RUN_ID),
      added: [`runs/${RUN_ID}/humanReviewPanel/current`],
    });
    // the aborted attempt's auto-id is ABSENT — this is the discard mechanism, not a count
    const keys = [...stores.governanceEvents.keys()].filter((k) => k.startsWith(`${RUN_ID}::`));
    expect(`keys:${keys.join(",")}`).toBe(`keys:${RUN_ID}::auto-2`);
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { revision: number }).revision).toBe(1);
  });

  it("a VOTE that conflicts once and then succeeds commits exactly one event and one vote", async () => {
    seedPanel({ revision: 1 });
    forceOneConflict("runs", RUN_ID, () => seedRun());
    // R9 §15 — the FINAL STORE is the verdict. R8 counted committed log entries here, which is the one
    // place the aborted attempt's discarded write is indistinguishable from a write that never landed.
    const { delta } = await auditedSuccess("VOTE-retry", VOTE_DELTA(), () => voteCall());
    expect(`attempts:${transactionAttemptCount.value >= 2}`).toBe("attempts:true");
    // the aborted attempt's auto-id is ABSENT from the store — the discard mechanism, not a count
    expect(`storedEventIds:${[...stores.governanceEvents.keys()].filter((k) => k.startsWith(`${RUN_ID}::`)).join(",")}`).toBe(`storedEventIds:${RUN_ID}::auto-2`);
    expect(`addedPaths:${delta.added.join(" ")}`).toBe(`addedPaths:runs/${RUN_ID}/governanceEvents/auto-2 ${VOTE_DOC_PATH(OWNER_UID, 1)}`);
    expect([...stores.humanReviewVotes.keys()].filter((k) => k.startsWith(`${RUN_ID}::`))).toHaveLength(1);
  });

  it("a CANCEL that conflicts once and then succeeds commits exactly one event", async () => {
    seedPanel({ revision: 1 });
    forceOneConflict("runs", RUN_ID, () => seedRun());
    const { delta } = await auditedSuccess("CANCEL-retry", CANCEL_DELTA(), () => deleteCall());
    expect(`attempts:${transactionAttemptCount.value >= 2}`).toBe("attempts:true");
    expect(`storedEventIds:${[...stores.governanceEvents.keys()].filter((k) => k.startsWith(`${RUN_ID}::`)).join(",")}`).toBe(`storedEventIds:${RUN_ID}::auto-2`);
    expect(`addedPaths:${delta.added.join(" ")}`).toBe(`addedPaths:runs/${RUN_ID}/governanceEvents/auto-2`);
  });
});

/**
 * ATOMICITY: the audit event and the canonical mutation share one transaction, so an audit failure
 * must roll back the canonical write — the strict opposite of finalize/override's best-effort
 * post-commit pattern.
 *
 * ─── R9 §25–§28 — THE VERDICT IS HARNESS-OWNED TELEMETRY PLUS THE FINAL STORE ──────────────────
 *
 * Two independent R8 defects met here. First (MAJOR): coverage was proved from TEST TITLES and from a
 * count of `throwOnSetCollection.value = "` in this file's own source, so a case body emptied to a
 * no-op kept its title, kept the count, and the census still reported the direction covered. Second:
 * 6 of 8 assertions concluded "no partial state survived" from `diagnosticLandedEventObservations()` — the
 * attempted-write log — rather than from the store, and a log-invisible partial write satisfied them.
 *
 * `runAtomicityCase` is the only way a case is registered. It arms the injection, drives production,
 * and then asserts, from evidence the FAKE produced and from a complete before/after store diff:
 *   • the injection was armed, its target write was REACHED, and the modelled failure FIRED;
 *   • the operation rejected with `write_failed`;
 *   • the durable state is byte-identical to the pre-call snapshot, in every collection.
 * A hollowed body registers no result and fires no injection, and the unconditional reconciliation
 * below names it.
 */
type AtomicityCaseResult = {
  caseId: string;
  siteId: InjectionSiteId;
  injectionArmed: boolean;
  targetReached: boolean;
  injectionFired: boolean;
  outcome: string;
  delta: StoreDelta;
};
const atomicityResults = new Map<string, AtomicityCaseResult>();

/** The required matrix: both failure directions for all four audited operations. */
const REQUIRED_ATOMICITY_CASES: Readonly<Record<string, InjectionSiteId>> = Object.freeze({
  "CREATE:canonical": "canonical-panel",
  "CREATE:event": "event",
  "RECONFIGURE:canonical": "canonical-panel",
  "RECONFIGURE:event": "event",
  "CANCEL:canonical": "canonical-panel",
  "CANCEL:event": "event",
  "VOTE:canonical": "canonical-vote",
  "VOTE:event": "event",
});

async function runAtomicityCase(caseId: string, call: () => Promise<unknown>): Promise<AtomicityCaseResult> {
  const siteId = REQUIRED_ATOMICITY_CASES[caseId];
  expect(`atomicityCaseIsDeclared:${caseId}:${siteId !== undefined}`).toBe(`atomicityCaseIsDeclared:${caseId}:true`);
  const before = snapshotStore();
  armWriteFailureInjection(caseId, siteId);
  let outcome: string;
  try {
    outcome = JSON.stringify(await call());
  } catch (error) {
    outcome = `threw:${(error as Error).message}`;
  }
  const state = disarmWriteFailureInjection();
  const delta = diffStore(before, snapshotStore());
  const result: AtomicityCaseResult = {
    caseId,
    siteId,
    injectionArmed: true,
    targetReached: state.reached,
    injectionFired: state.fired,
    outcome,
    delta,
  };
  if (atomicityResults.has(caseId)) recordHarnessViolation(`atomicity:duplicate-case:${caseId}`);
  atomicityResults.set(caseId, result);
  // the three postconditions the HARNESS owns — no case body can substitute a boolean for any of them
  expect(`${caseId}:armed:${result.injectionArmed} reached:${result.targetReached} fired:${result.injectionFired}`).toBe(`${caseId}:armed:true reached:true fired:true`);
  expect(`${caseId}:outcome:${result.outcome}`).toBe(`${caseId}:outcome:{"ok":false,"reason":"write_failed"}`);
  expect(`${caseId}:durableDelta:${describeDelta(delta)}`).toBe(`${caseId}:durableDelta:added:[] modified:[] deleted:[]`);
  assertNoHarnessViolation(caseId);
  return result;
}

describe("panel audit events — atomicity: neither half survives a failure", () => {
  /**
   * R5 MINOR — the matrix had an EVENT-write failure case for create/cancel/vote but a
   * CANONICAL-write failure case only for create and vote. Reconfigure shares create's code path and
   * cancel's canonical write precedes its event write, so both were arguably equivalent — but that
   * was an argument, not a test, so both are asserted.
   */
  it("a CANONICAL-write failure leaves no event on RECONFIGURE", async () => {
    seedPanel({ revision: 1 });
    await runAtomicityCase("RECONFIGURE:canonical", () => putCall({ expectedRevision: 1 }));
  });

  it("a CANONICAL-write failure leaves no event on CANCEL — the panel stays open", async () => {
    seedPanel({ revision: 1 });
    await runAtomicityCase("CANCEL:canonical", () => deleteCall());
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { status: string }).status).toBe("open");
  });

  it("a MODELLED EVENT-write failure rolls back the panel RECONFIGURE — the prior revision stands", async () => {
    seedPanel({ revision: 1 });
    await runAtomicityCase("RECONFIGURE:event", () => putCall({ expectedRevision: 1, reviewerUserIds: [OWNER_UID, ADMIN_UID, REVIEWER_UID] }));
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { revision: number }).revision).toBe(1);
  });

  it("an EVENT-write failure rolls back the panel CREATE", async () => {
    await runAtomicityCase("CREATE:event", () => putCall());
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
  });

  it("a CANONICAL-write failure leaves no event on CREATE", async () => {
    await runAtomicityCase("CREATE:canonical", () => putCall());
    expect(stores.humanReviewPanel.get(`${RUN_ID}::current`)).toBeUndefined();
  });

  it("an EVENT-write failure rolls back the CANCEL — the panel stays open", async () => {
    seedPanel({ revision: 1 });
    await runAtomicityCase("CANCEL:event", () => deleteCall());
    expect((stores.humanReviewPanel.get(`${RUN_ID}::current`) as { status: string }).status).toBe("open");
  });

  it("an EVENT-write failure rolls back the VOTE — no vote is committed", async () => {
    seedPanel({ revision: 1 });
    await runAtomicityCase("VOTE:event", () => voteCall());
    expect([...stores.humanReviewVotes.keys()].filter((k) => k.startsWith(`${RUN_ID}::`))).toHaveLength(0);
  });

  it("a CANONICAL-write failure leaves no event on VOTE", async () => {
    seedPanel({ revision: 1 });
    await runAtomicityCase("VOTE:canonical", () => voteCall());
    expect([...stores.humanReviewVotes.keys()].filter((k) => k.startsWith(`${RUN_ID}::`))).toHaveLength(0);
  });

  /**
   * R9 §27 — the FALSIFIER for the telemetry itself, run inline so the mechanism is proved load-bearing
   * rather than asserted to be. A case that arms an injection production never reaches produces
   * `reached:false fired:false`, which is exactly what a hollowed body would produce.
   */
  it("an injection production never reaches records reached:false fired:false — the hollow-body signature", async () => {
    // `humanReviewVotes` is never written on a CREATE, so arming there cannot fire
    armWriteFailureInjection("SELFTEST:unreached", "canonical-vote");
    expect((await putCall()).ok).toBe(true);
    const state = disarmWriteFailureInjection();
    expect(`reached:${state.reached} fired:${state.fired}`).toBe("reached:false fired:false");
  });

  it("arming twice without disarming is itself a harness violation, so a case cannot silently inherit another's injection", async () => {
    armWriteFailureInjection("SELFTEST:double-a", "event");
    armWriteFailureInjection("SELFTEST:double-b", "event");
    disarmWriteFailureInjection();
    expect(acknowledgeExpectedViolations(["atomicity:injection-already-armed:SELFTEST:double-a"])).toEqual(["atomicity:injection-already-armed:SELFTEST:double-a"]);
  });
});

/**
 * R9 §26/§28 — THE ATOMICITY RECONCILIATION, from harness telemetry and nothing else.
 *
 * R8's census read test titles and counted source text. This reads the RESULTS the fake produced. A
 * case that was renamed, emptied, skipped, or never reached its injection has no result, or a result
 * whose `fired` is false, and is named here. The title-based census survives only for the one property
 * titles genuinely establish — that nothing is `it.skip`ped — and is explicitly labelled as such.
 */
describe("atomicity coverage census (§26/§28)", () => {
  const SPEC_SOURCE = readFileSync(__filename, "utf8");
  const atomicityBlock = (() => {
    // anchored on a leading newline so this line's own text is not what gets found
    const start = SPEC_SOURCE.indexOf('\ndescribe("panel audit events — atomicity');
    expect(start).toBeGreaterThan(-1);
    const end = SPEC_SOURCE.indexOf("\ndescribe(", start + 1);
    return SPEC_SOURCE.slice(start, end === -1 ? undefined : end);
  })();

  it("DIAGNOSTIC ONLY — no atomicity case is skipped, todo'd or `only`'d. This proves nothing about execution.", () => {
    const skipped = [...atomicityBlock.matchAll(/\n  it\.(?:skip|todo|only)\("([^"]+)"/g)].map((m) => m[1]);
    expect(`skippedAtomicityCases:${skipped.join(" | ")}`).toBe("skippedAtomicityCases:");
  });

  it("the required matrix is exactly both failure directions for all four audited operations", () => {
    expect(Object.keys(REQUIRED_ATOMICITY_CASES).sort()).toEqual([
      "CANCEL:canonical", "CANCEL:event",
      "CREATE:canonical", "CREATE:event",
      "RECONFIGURE:canonical", "RECONFIGURE:event",
      "VOTE:canonical", "VOTE:event",
    ]);
    // and each direction targets the write it claims to
    const targets = Object.entries(REQUIRED_ATOMICITY_CASES).map(([id, site]) => `${id}->${INJECTION_TARGET_COLLECTION[site]}`).sort();
    expect(targets).toEqual([
      "CANCEL:canonical->humanReviewPanel", "CANCEL:event->governanceEvents",
      "CREATE:canonical->humanReviewPanel", "CREATE:event->governanceEvents",
      "RECONFIGURE:canonical->humanReviewPanel", "RECONFIGURE:event->governanceEvents",
      "VOTE:canonical->humanReviewVotes", "VOTE:event->governanceEvents",
    ]);
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
 * ONE EXCEPTION, measured precisely (§60). A `-t` pattern matching ZERO tests exits 0. The file IS
 * loaded and all of its tests ARE registered — Jest reports `Tests: N skipped, N total` — but because
 * no test in the file executes, Jest never runs a module-scope `afterAll`, so this hook cannot fire.
 * That is a test-runner lifecycle limitation, not a production defect, and it is outside this hook's
 * reach. Two earlier descriptions of it were wrong: that the file is "skipped entirely", and that such
 * a run "reports 0 passed". A run reporting only skips is not mistakable for coverage, and CI runs the
 * file in full; no recursive workaround is warranted.
 *
 * A `-t` run of this security suite is a debugging aid and is NOT evidence of rejection coverage;
 * only a full run of the file is. CI runs the file in full.
 */
/**
 * R8 §19 / R9 §21 — unconditional, and now also reset-proof. A harness violation recorded by ANY test
 * fails that test, whether or not it happens to call `expectStoreDelta`. It reads the PENDING set, so
 * a violation raised before a `resetStores()`/`seedBaseFixture()` reseed is still here: the ledger is
 * append-only and only an explicit, substring-matched acknowledgement removes an entry from this view.
 */
afterEach(() => {
  expect(`unsupportedWriteApiUsed:${[...new Set(pendingHarnessViolations())].join(",")}`).toBe("unsupportedWriteApiUsed:");
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
      `declaredWitnesses:${Object.keys(SITE_GUARD_FACTS).length}`,
      `witnessesNeverExecuted:${Object.keys(SITE_GUARD_FACTS).filter((id) => !executedWitnessIds.has(id)).sort().join(",")}`,
      `witnessesExecutedButNotDeclared:${[...executedWitnessIds].filter((id) => !SITE_GUARD_FACTS[id]).sort().join(",")}`,
      // R9 §26/§28 — atomicity coverage reconciled from HARNESS TELEMETRY, unconditionally. A case
      // whose body was emptied registers no result; one that never drove production into the injected
      // write registers a result with `fired:false`. Both are named here, and neither a preserved test
      // title nor a source-text count of injections can satisfy this.
      `atomicityCasesRequired:${Object.keys(REQUIRED_ATOMICITY_CASES).length}`,
      // R10 — cross-checked against the FAKE-OWNED journal. A result no injection produced is named
      // here, which is what makes `runAtomicityCase` the only registration route in fact and not by
      // convention. A journal entry whose `fired` is false is named too, wherever it came from.
      // R10 — the ledger's acknowledgement count is PINNED. An extra drain anywhere — a hook, a helper,
      // a new test — moves this number and fails, which the per-test postcondition cannot see.
      `acknowledgedViolations:${acknowledgedViolationIndexes.size}`,
      `harnessLedgerTotal:${harnessLedgerLength()}`,
      `atomicityCasesWithNoJournalEntry:${Object.keys(REQUIRED_ATOMICITY_CASES).filter((id) => !injectionJournalEntries().some((e) => e.caseId === id && e.fired)).sort().join(",")}`,
      `atomicityResultsWithoutAMatchingJournalEntry:${[...atomicityResults.values()].filter((r) => !injectionJournalEntries().some((e) => e.caseId === r.caseId && e.reached === r.targetReached && e.fired === r.injectionFired)).map((r) => r.caseId).sort().join(",")}`,
      `atomicityCasesWithNoResult:${Object.keys(REQUIRED_ATOMICITY_CASES).filter((id) => !atomicityResults.has(id)).sort().join(",")}`,
      `atomicityCasesWhoseInjectionNeverFired:${[...atomicityResults.values()].filter((r) => !r.injectionFired).map((r) => r.caseId).sort().join(",")}`,
      `atomicityCasesWhoseTargetWasNeverReached:${[...atomicityResults.values()].filter((r) => !r.targetReached).map((r) => r.caseId).sort().join(",")}`,
      `atomicityCasesWithADurableDelta:${[...atomicityResults.values()].filter((r) => r.delta.added.length + r.delta.modified.length + r.delta.deleted.length > 0).map((r) => r.caseId).sort().join(",")}`,
      `atomicityResultsNotRequired:${[...atomicityResults.keys()].filter((id) => !(id in REQUIRED_ATOMICITY_CASES)).sort().join(",")}`,
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
      "declaredWitnesses:15",
      "witnessesNeverExecuted:",
      "witnessesExecutedButNotDeclared:",
      "atomicityCasesRequired:8",
      "acknowledgedViolations:8",
      "harnessLedgerTotal:8",
      "atomicityCasesWithNoJournalEntry:",
      "atomicityResultsWithoutAMatchingJournalEntry:",
      "atomicityCasesWithNoResult:",
      "atomicityCasesWhoseInjectionNeverFired:",
      "atomicityCasesWhoseTargetWasNeverReached:",
      "atomicityCasesWithADurableDelta:",
      "atomicityResultsNotRequired:",
      "reconciliationExecuted:true",
    ].join(" ")
  );
});
