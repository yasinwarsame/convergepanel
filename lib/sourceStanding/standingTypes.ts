/**
 * Order 4, Slice 2a — Source Standing v1 types and strict parsers.
 *
 * Question answered: "What standing has THIS Workspace explicitly recorded for
 * THIS exact cited document?" — human-authored (Owner/Admin, `sources.attest`),
 * Team Workspaces only, current state only. It is NOT truth, verification,
 * publisher reputation, model consensus, evidence quality, `sourceBacked` or
 * freshness, and it never derives from publisher class.
 *
 * Active statuses are exactly ACCEPTED / DISPUTED / SUPERSEDED. WITHDRAWN is an
 * audit transition only: it is recorded as an event and represented as the
 * ABSENCE of a current-state document — never stored as a current status.
 *
 * Every parser fails closed: unknown versions, enums, reason/status pairings,
 * extra keys, inherited (prototype) property names and malformed values are
 * rejected, never repaired and never defaulted.
 */
import { isSourceIdHash, sourceIdHash, sourceIdentityV1, SOURCE_IDENTITY_VERSION, type SourceIdentityV1 } from "./sourceIdentity";

export const SOURCE_STANDING_SCHEMA_VERSION = 1 as const;
/** Maximum successor edges walked from a SUPERSEDED record (read and write side). */
export const MAX_SUCCESSOR_CHAIN_DEPTH = 8;

export type SourceStandingStatus = "ACCEPTED" | "DISPUTED" | "SUPERSEDED";
export type SourceStandingEventStatus = SourceStandingStatus | "WITHDRAWN";
export type SourceStandingReasonCode = "primary_document" | "designated_reference" | "inaccurate_or_unreliable_for_workspace" | "replaced_by_successor" | "withdrawn";
export type SourceStandingOperation = "accept" | "dispute" | "supersede" | "withdraw";

/** Own-property allow-lists — `in`/indexing would let "toString", "__proto__" … through. */
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const STATUS_REASONS: Readonly<Record<SourceStandingStatus, readonly SourceStandingReasonCode[]>> = Object.freeze({
  ACCEPTED: Object.freeze(["primary_document", "designated_reference"] as const),
  DISPUTED: Object.freeze(["inaccurate_or_unreliable_for_workspace"] as const),
  SUPERSEDED: Object.freeze(["replaced_by_successor"] as const),
});
const OPERATION_STATUS: Readonly<Record<SourceStandingOperation, SourceStandingEventStatus>> = Object.freeze({
  accept: "ACCEPTED",
  dispute: "DISPUTED",
  supersede: "SUPERSEDED",
  withdraw: "WITHDRAWN",
});

export function isSourceStandingStatus(v: unknown): v is SourceStandingStatus {
  return typeof v === "string" && own(STATUS_REASONS, v);
}
export function isSourceStandingOperation(v: unknown): v is SourceStandingOperation {
  return typeof v === "string" && own(OPERATION_STATUS, v);
}
export function statusForOperation(op: SourceStandingOperation): SourceStandingEventStatus {
  return OPERATION_STATUS[op];
}
/** Status/reason compatibility, including WITHDRAWN → "withdrawn". */
export function isReasonAllowed(status: SourceStandingEventStatus, reason: unknown): reason is SourceStandingReasonCode {
  if (typeof reason !== "string") return false;
  if (status === "WITHDRAWN") return reason === "withdrawn";
  return own(STATUS_REASONS, status) && (STATUS_REASONS[status] as readonly string[]).includes(reason);
}

/** Firestore Timestamp-like: an own `toDate()` producing a valid date. */
export type TimestampLike = { toDate(): Date };
function isTimestampLike(v: unknown): v is TimestampLike {
  if (!v || typeof v !== "object" || typeof (v as { toDate?: unknown }).toDate !== "function") return false;
  try {
    const d = (v as TimestampLike).toDate();
    return d instanceof Date && !Number.isNaN(d.getTime());
  } catch {
    return false;
  }
}
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function hasOnlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

export type SourceStandingCurrentV1 = {
  schemaVersion: typeof SOURCE_STANDING_SCHEMA_VERSION;
  workspaceId: string;
  identity: SourceIdentityV1;
  status: SourceStandingStatus;
  reasonCode: SourceStandingReasonCode;
  successorIdHash?: string;
  revision: number;
  updatedAt: TimestampLike;
  updatedByUid: string;
};

export type ParseCurrentResult = { ok: true; current: SourceStandingCurrentV1 } | { ok: false; reason: SourceStandingMalformedReason };
export type SourceStandingMalformedReason =
  | "not_an_object"
  | "unexpected_keys"
  | "unknown_schema_version"
  | "workspace_mismatch"
  | "malformed_identity"
  | "unknown_identity_version"
  | "doc_id_mismatch"
  | "identity_hash_mismatch"
  | "unknown_status"
  | "reason_status_mismatch"
  | "successor_shape"
  | "malformed_revision"
  | "malformed_timestamp"
  | "malformed_actor";

const CURRENT_KEYS = ["schemaVersion", "workspaceId", "identity", "status", "reasonCode", "successorIdHash", "revision", "updatedAt", "updatedByUid"] as const;
const IDENTITY_KEYS = ["identityVersion", "canonicalUrl", "idHash"] as const;

/** Strictly parse a current-state document read from `workspaces/{expectedWorkspaceId}/sourceAuthority/{docId}`. */
export function parseSourceStandingCurrent(raw: unknown, ctx: { expectedWorkspaceId: string; docId: string }): ParseCurrentResult {
  const fail = (reason: SourceStandingMalformedReason): ParseCurrentResult => ({ ok: false, reason });
  if (!isPlainRecord(raw)) return fail("not_an_object");
  if (!hasOnlyKeys(raw, CURRENT_KEYS)) return fail("unexpected_keys");
  if (raw.schemaVersion !== SOURCE_STANDING_SCHEMA_VERSION) return fail("unknown_schema_version");
  if (raw.workspaceId !== ctx.expectedWorkspaceId) return fail("workspace_mismatch");

  const id = raw.identity;
  if (!isPlainRecord(id) || !hasOnlyKeys(id, IDENTITY_KEYS)) return fail("malformed_identity");
  if (id.identityVersion !== SOURCE_IDENTITY_VERSION) return fail("unknown_identity_version");
  if (typeof id.canonicalUrl !== "string" || !isSourceIdHash(id.idHash)) return fail("malformed_identity");
  if (id.idHash !== ctx.docId) return fail("doc_id_mismatch");
  if (sourceIdHash(id.canonicalUrl) !== id.idHash) return fail("identity_hash_mismatch");
  // The stored URL must itself be canonical (a matching hash of a non-canonical string is still not an identity).
  const recomputed = sourceIdentityV1(id.canonicalUrl);
  if (!recomputed || recomputed.canonicalUrl !== id.canonicalUrl) return fail("malformed_identity");

  if (!isSourceStandingStatus(raw.status)) return fail("unknown_status");
  if (!isReasonAllowed(raw.status, raw.reasonCode)) return fail("reason_status_mismatch");
  const hasSuccessor = own(raw, "successorIdHash");
  if (raw.status === "SUPERSEDED") {
    if (!hasSuccessor || !isSourceIdHash(raw.successorIdHash) || raw.successorIdHash === id.idHash) return fail("successor_shape");
  } else if (hasSuccessor) {
    return fail("successor_shape");
  }
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1) return fail("malformed_revision");
  if (!isTimestampLike(raw.updatedAt)) return fail("malformed_timestamp");
  if (typeof raw.updatedByUid !== "string" || raw.updatedByUid.length === 0) return fail("malformed_actor");

  return {
    ok: true,
    current: {
      schemaVersion: SOURCE_STANDING_SCHEMA_VERSION,
      workspaceId: raw.workspaceId as string,
      identity: { identityVersion: SOURCE_IDENTITY_VERSION, canonicalUrl: id.canonicalUrl, idHash: id.idHash },
      status: raw.status,
      reasonCode: raw.reasonCode,
      ...(raw.status === "SUPERSEDED" ? { successorIdHash: raw.successorIdHash as string } : {}),
      revision: raw.revision,
      updatedAt: raw.updatedAt,
      updatedByUid: raw.updatedByUid,
    },
  };
}

/** Append-only history entry under `…/sourceAuthority/{idHash}/events/{eventId}`. */
export type SourceStandingEventV1 = {
  schemaVersion: typeof SOURCE_STANDING_SCHEMA_VERSION;
  fromStatus: SourceStandingStatus | null;
  toStatus: SourceStandingEventStatus;
  reasonCode: SourceStandingReasonCode;
  successorIdHash?: string;
  /** The revision this event produced (or, for WITHDRAWN, the revision that was withdrawn). Monotonic across withdraw/re-attest. */
  revision: number;
  actorUid: string;
  /** The actor's Workspace membership role at write time — whichever role held `sources.attest` (today Owner or Admin). Recorded, never used for authority. */
  actorRole: string;
  at: TimestampLike;
};

/** Client-safe presentation. UNRESOLVED carries no timestamp: a malformed record has none that can be trusted. */
export type SourceStandingPresentationV1 =
  | { status: SourceStandingStatus; asOf: string; successorUrl?: string }
  | { status: "UNRESOLVED" };
