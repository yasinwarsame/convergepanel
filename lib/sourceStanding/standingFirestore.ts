/**
 * Order 4, Slice 2a — the ONLY Firestore-touching part of Source Standing.
 *
 * Paths (Admin SDK only; firestore.rules denies every client):
 *   workspaces/{workspaceId}/sourceAuthority/{idHash}              current state
 *   workspaces/{workspaceId}/sourceAuthority/{idHash}/events/{id}  append-only history
 *   workspaceMembershipEvents/{id}                                 canonical Workspace audit
 *
 * READS on the presentation paths are exact-document only (`getAll` by known
 * id, level by level for successor chains). The writer issues at most two
 * single-field, limit-1 queries, both answered by Firestore's automatic
 * single-field indexes (no composite index):
 *   - history revision: `events` ordered by `revision` desc — on creation only,
 *     so revisions stay monotonic across withdraw → re-attest (ABA-safe);
 *   - inbound reference: `sourceAuthority` where `successorIdHash == id` — on
 *     WITHDRAWN / SUPERSEDED only (Slice 2a.1, P2): a source that is currently
 *     another standing's successor may not be withdrawn or newly superseded, so
 *     an ordinary mutation can never make an already-valid predecessor chain
 *     lose a link or exceed MAX_SUCCESSOR_CHAIN_DEPTH. It may still move between
 *     ACCEPTED and DISPUTED, or leave SUPERSEDED (which only shortens chains).
 *
 * WRITES happen in ONE transaction: re-authorize (`sources.attest`) through the
 * canonical Team authorizer, read the current state, check `expectedRevision`
 * exactly, run the inbound-reference check, validate the successor chain for
 * SUPERSEDED, then write the current state (or delete it for WITHDRAWN), create
 * one history event and create one Workspace audit event. Every read precedes
 * every write. Event and audit document ids are allocated BEFORE the
 * transaction, so a Firestore retry targets the same documents (`create`) and
 * can never leave duplicates.
 *
 * Bounds:
 *   - Review Context: ≤ 1 + MAX_SUCCESSOR_CHAIN_DEPTH `getAll` rounds, each over
 *     at most the displayed-source cap of ids.
 *   - Management GET: 1 head document read, then ≤ MAX_SUCCESSOR_CHAIN_DEPTH
 *     successor document reads (SUPERSEDED only). The head is never re-read.
 *   - Write transaction, worst case (create + supersede):
 *       authorization document reads   ≤ 3 (workspace, caller, canonical owner)
 *       current-state document read      1
 *       history revision query           1 (limit 1; create only)
 *       inbound-reference query          1 (limit 1; withdraw / supersede only)
 *       successor document reads       ≤ MAX_SUCCESSOR_CHAIN_DEPTH (8; supersede only)
 *     = ≤ 12 document reads + ≤ 2 queries (each returning ≤ 1 document), then
 *     3 writes (current set-or-delete, event create, audit create).
 *   - The `nothing_to_withdraw` result is an internal invariant: the route
 *     already rejects a withdraw without an expected revision, and the writer
 *     keeps the defence for any other caller.
 */
import "server-only";
import { Timestamp, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { buildWorkspaceMembershipEventDocData } from "@/lib/workspaces/workspaceMembershipEvents";
import type { SourceIdentityV1 } from "./sourceIdentity";
import { MAX_SUCCESSOR_CHAIN_DEPTH, SOURCE_STANDING_SCHEMA_VERSION, isReasonAllowed, parseSourceStandingCurrent, statusForOperation, type SourceStandingCurrentV1, type SourceStandingOperation, type SourceStandingPresentationV1, type SourceStandingReasonCode, type SourceStandingStatus } from "./standingTypes";
import { resolveFromParsedHead, resolveSourceStanding, toStandingPresentation, walkSuccessorChain, type ChainFailure, type SourceStandingResolution, type StandingLookupAnswer } from "./resolveStanding";

/** Thrown only when the Admin SDK is not configured; routes map it to their generic 500. */
export class SourceStandingUnavailableError extends Error {
  constructor() {
    super("Source Standing storage unavailable");
    this.name = "SourceStandingUnavailableError";
  }
}
function requireDb(): Firestore {
  if (!adminDb) throw new SourceStandingUnavailableError();
  return adminDb;
}

export function sourceStandingRef(db: Firestore, workspaceId: string, idHash: string): DocumentReference {
  return db.collection("workspaces").doc(workspaceId).collection("sourceAuthority").doc(idHash);
}

/** Resolve many ids with exact-document reads, one `getAll` round per chain level. */
async function resolveMany(db: Firestore, workspaceId: string, idHashes: readonly string[]): Promise<Map<string, Exclude<SourceStandingResolution, { kind: "needs" }>>> {
  const cache = new Map<string, StandingLookupAnswer>();
  const lookup = (id: string): StandingLookupAnswer => cache.get(id) ?? { state: "not_loaded" };
  const out = new Map<string, Exclude<SourceStandingResolution, { kind: "needs" }>>();
  let pending = Array.from(new Set(idHashes));
  for (let round = 0; round <= MAX_SUCCESSOR_CHAIN_DEPTH + 1 && pending.length > 0; round += 1) {
    const toLoad = Array.from(new Set(pending.map((id) => { const r = resolveSourceStanding(workspaceId, id, lookup); return r.kind === "needs" ? r.idHash : null; }).filter((x): x is string => x !== null)));
    if (toLoad.length > 0) {
      const snaps = await db.getAll(...toLoad.map((id) => sourceStandingRef(db, workspaceId, id)));
      snaps.forEach((snap, i) => cache.set(toLoad[i], snap.exists ? { state: "present", data: snap.data() } : { state: "absent" }));
    }
    const still: string[] = [];
    for (const id of pending) {
      const r = resolveSourceStanding(workspaceId, id, lookup);
      if (r.kind === "needs") still.push(id);
      else out.set(id, r);
    }
    pending = still;
  }
  for (const id of pending) out.set(id, { kind: "unresolved", reason: "chain_too_deep" }); // structurally unreachable; fail closed if it ever happens
  for (const [id, r] of out) {
    if (r.kind === "unresolved") logger.warn("[sourceStanding] unresolved Source Standing — not presented", { workspaceId, idHash: id, reason: r.reason });
  }
  return out;
}

/** Review Context read: one presentation (or null = no standing) per displayed URL. Labels / userinfo / reserved hosts never have an identity and are never looked up. */
export async function loadStandingPresentations(workspaceId: string, identities: ReadonlyArray<SourceIdentityV1 | null>): Promise<Array<SourceStandingPresentationV1 | null>> {
  const ids = identities.filter((x): x is SourceIdentityV1 => x !== null).map((x) => x.idHash);
  if (ids.length === 0) return identities.map(() => null);
  const resolved = await resolveMany(requireDb(), workspaceId, ids);
  return identities.map((identity) => (identity ? toStandingPresentation(resolved.get(identity.idHash) ?? { kind: "unresolved", reason: "chain_too_deep" }) : null));
}

export type ManagementStanding =
  | { kind: "absent" }
  | { kind: "unresolved" }
  | { kind: "current"; status: SourceStandingStatus; reasonCode: SourceStandingReasonCode; revision: number; asOf: string; successor: { resolved: true; url: string } | { resolved: false } | null };

/** Management read: current record (with its revision for optimistic concurrency) even when its successor chain no longer resolves, so it can be corrected. */
export async function readStandingForManagement(workspaceId: string, identity: SourceIdentityV1): Promise<ManagementStanding> {
  const db = requireDb();
  const snap = await sourceStandingRef(db, workspaceId, identity.idHash).get();
  if (!snap.exists) return { kind: "absent" };
  const parsed = parseSourceStandingCurrent(snap.data(), { expectedWorkspaceId: workspaceId, docId: identity.idHash });
  if (!parsed.ok) {
    logger.warn("[sourceStanding] malformed current Source Standing", { workspaceId, idHash: identity.idHash, reason: parsed.reason });
    return { kind: "unresolved" };
  }
  // Everything below derives from this ONE head snapshot; only successors are read further (P3).
  const c = parsed.current;
  let successor: Extract<ManagementStanding, { kind: "current" }>["successor"] = null;
  if (c.status === "SUPERSEDED") {
    const cache = new Map<string, StandingLookupAnswer>();
    const lookup = (id: string): StandingLookupAnswer => cache.get(id) ?? { state: "not_loaded" };
    let r = resolveFromParsedHead(workspaceId, c, lookup);
    // Bounded: each round loads one new successor; the walk itself stops after MAX_SUCCESSOR_CHAIN_DEPTH edges.
    for (let round = 0; r.kind === "needs" && round < MAX_SUCCESSOR_CHAIN_DEPTH; round += 1) {
      const [snap] = await db.getAll(sourceStandingRef(db, workspaceId, r.idHash));
      cache.set(r.idHash, snap.exists ? { state: "present", data: snap.data() } : { state: "absent" });
      r = resolveFromParsedHead(workspaceId, c, lookup);
    }
    successor = r.kind === "resolved" && r.successorCanonicalUrl ? { resolved: true, url: r.successorCanonicalUrl } : { resolved: false };
    if (r.kind === "unresolved") logger.warn("[sourceStanding] unresolved successor chain", { workspaceId, idHash: identity.idHash, reason: r.reason });
  }
  return { kind: "current", status: c.status, reasonCode: c.reasonCode, revision: c.revision, asOf: c.updatedAt.toDate().toISOString(), successor };
}

export type ApplyStandingResult =
  | { ok: true; status: SourceStandingStatus | "WITHDRAWN"; revision: number }
  | { ok: false; reason: "denied"; denial: TeamMutationAuthorizationDenialReason }
  | { ok: false; reason: "revision_conflict" }
  | { ok: false; reason: "current_unresolved" }
  | { ok: false; reason: "history_unresolved" }
  | { ok: false; reason: "nothing_to_withdraw" }
  | { ok: false; reason: "source_is_referenced" }
  | { ok: false; reason: "invalid_operation" }
  | { ok: false; reason: "successor_invalid"; detail: ChainFailure | "same_as_source" };

export type ApplyStandingArgs = {
  workspaceId: string;
  uid: string;
  operation: SourceStandingOperation;
  reasonCode: SourceStandingReasonCode;
  identity: SourceIdentityV1;
  successorIdentity: SourceIdentityV1 | null;
  expectedRevision: number | null;
};

/** Highest revision ever recorded in this source's history (0 when none); null when the history row is malformed. */
async function highestRecordedRevision(tx: Transaction, ref: DocumentReference): Promise<number | null> {
  const q = await tx.get(ref.collection("events").orderBy("revision", "desc").limit(1));
  if (q.empty) return 0;
  const r = q.docs[0].data().revision;
  return typeof r === "number" && Number.isSafeInteger(r) && r >= 1 ? r : null;
}

export async function applySourceStandingOperation(args: ApplyStandingArgs): Promise<ApplyStandingResult> {
  const toStatus = statusForOperation(args.operation);
  if (!isReasonAllowed(toStatus, args.reasonCode)) return { ok: false, reason: "invalid_operation" };
  if ((toStatus === "SUPERSEDED") !== (args.successorIdentity !== null)) return { ok: false, reason: "invalid_operation" };
  if (args.successorIdentity && args.successorIdentity.idHash === args.identity.idHash) return { ok: false, reason: "successor_invalid", detail: "same_as_source" };
  if (toStatus === "WITHDRAWN" && args.expectedRevision === null) return { ok: false, reason: "nothing_to_withdraw" };

  const db = requireDb();
  const currentRef = sourceStandingRef(db, args.workspaceId, args.identity.idHash);
  // Allocated once, outside the callback: a retried transaction re-targets the same documents.
  const eventRef = currentRef.collection("events").doc();
  const auditRef = db.collection("workspaceMembershipEvents").doc();

  return db.runTransaction(async (tx): Promise<ApplyStandingResult> => {
    const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "sources.attest" });
    if (!auth.ok) return { ok: false, reason: "denied", denial: auth.reason };
    // Authority is the capability check above (central ROLE_CAPABILITIES) — never a role-name comparison here.
    const actorRole = auth.membership.role;

    const currentSnap = await tx.get(currentRef);
    let current: SourceStandingCurrentV1 | null = null;
    if (currentSnap.exists) {
      const parsed = parseSourceStandingCurrent(currentSnap.data(), { expectedWorkspaceId: args.workspaceId, docId: args.identity.idHash });
      if (!parsed.ok) return { ok: false, reason: "current_unresolved" };
      current = parsed.current;
    }
    if (args.expectedRevision === null ? current !== null : current === null || current.revision !== args.expectedRevision) return { ok: false, reason: "revision_conflict" };

    let nextRevision: number;
    if (current) nextRevision = current.revision + 1;
    else {
      const highest = await highestRecordedRevision(tx, currentRef);
      if (highest === null) return { ok: false, reason: "history_unresolved" };
      nextRevision = highest + 1;
    }

    if (toStatus === "WITHDRAWN" || toStatus === "SUPERSEDED") {
      // P2: same-Workspace inbound reference, read inside this transaction before any write. Any
      // matching document counts — even a malformed one — and nothing about it is returned.
      const inbound = await tx.get(db.collection("workspaces").doc(args.workspaceId).collection("sourceAuthority").where("successorIdHash", "==", args.identity.idHash).limit(1));
      if (!inbound.empty) return { ok: false, reason: "source_is_referenced" };
    }

    if (toStatus === "SUPERSEDED" && args.successorIdentity) {
      // Same chain walk as the read side; every read happens before any write.
      const cache = new Map<string, StandingLookupAnswer>();
      for (;;) {
        const walk = walkSuccessorChain(args.workspaceId, args.identity.idHash, args.successorIdentity.idHash, (id) => cache.get(id) ?? { state: "not_loaded" });
        if (walk.ok === "needs") {
          const snap = await tx.get(sourceStandingRef(db, args.workspaceId, walk.idHash));
          cache.set(walk.idHash, snap.exists ? { state: "present", data: snap.data() } : { state: "absent" });
          continue;
        }
        if (!walk.ok) return { ok: false, reason: "successor_invalid", detail: walk.reason };
        break;
      }
    }

    const now = Timestamp.now();
    const fromStatus = current ? current.status : null;
    const successorIdHash = toStatus === "SUPERSEDED" && args.successorIdentity ? args.successorIdentity.idHash : null;
    const eventRevision = toStatus === "WITHDRAWN" ? (current as SourceStandingCurrentV1).revision : nextRevision;

    if (toStatus === "WITHDRAWN") {
      tx.delete(currentRef);
    } else {
      tx.set(currentRef, {
        schemaVersion: SOURCE_STANDING_SCHEMA_VERSION,
        workspaceId: args.workspaceId,
        identity: { identityVersion: args.identity.identityVersion, canonicalUrl: args.identity.canonicalUrl, idHash: args.identity.idHash },
        status: toStatus,
        reasonCode: args.reasonCode,
        ...(successorIdHash ? { successorIdHash } : {}),
        revision: nextRevision,
        updatedAt: now,
        updatedByUid: args.uid,
      });
    }
    tx.create(eventRef, {
      schemaVersion: SOURCE_STANDING_SCHEMA_VERSION,
      fromStatus,
      toStatus,
      reasonCode: args.reasonCode,
      ...(successorIdHash ? { successorIdHash } : {}),
      revision: eventRevision,
      actorUid: args.uid,
      actorRole,
      at: now,
    });
    tx.create(
      auditRef,
      buildWorkspaceMembershipEventDocData({
        eventType: "workspace_source_standing_changed",
        actorUid: args.uid,
        workspaceId: args.workspaceId,
        sourceIdHash: args.identity.idHash,
        previousStatus: fromStatus,
        newStatus: toStatus,
        reasonCode: args.reasonCode,
        revision: eventRevision,
        successorIdHash,
        at: now,
      })
    );
    return { ok: true, status: toStatus, revision: eventRevision };
  });
}
