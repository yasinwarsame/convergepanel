/**
 * ADD-TO-TEAM-PROJECT §I — deterministic idempotency lock for "at most one
 * Team snapshot per (sourceRunId, workspaceId, projectId)".
 *
 * WHY A LOCK DOCUMENT, NOT A DETERMINISTIC RUN ID. Run ids stay
 * `run-${randomUUID()}` (§J) so a snapshot is an ordinary Team run to every
 * existing reader. Idempotency is carried by a side document whose id is
 * derived from the tuple, READ inside the creating transaction BEFORE any
 * write (never "create and recover from ALREADY_EXISTS after commit"): if
 * it exists and validates, the transaction returns the snapshot it names
 * without writing anything; if it is malformed or names a run that does
 * not match, that is an internal integrity failure — fail closed, never
 * return an arbitrary stored id, never repair.
 *
 * WHY A CANONICAL TUPLE ENCODING. `sha256(a + "|" + b + "|" + c)` is only
 * collision-free if none of the three ids can contain the separator, and
 * run/project ids are validated only syntactically here. A versioned JSON
 * object with a FIXED key order is unambiguous: every field is delimited
 * by the encoding itself. The `version` field is part of the hash so a
 * future change to the tuple can never alias an old lock.
 */

import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";

export const RUN_SNAPSHOT_LOCK_COLLECTION = "runSnapshotLocks";
export const RUN_SNAPSHOT_LOCK_VERSION = 1 as const;
const LOCK_ID_PREFIX = "rsl_";

export interface RunSnapshotLockTuple {
  sourceRunId: string;
  workspaceId: string;
  projectId: string;
}

export interface RunSnapshotLockV1 extends RunSnapshotLockTuple {
  version: typeof RUN_SNAPSHOT_LOCK_VERSION;
  snapshotRunId: string;
  createdBy: string;
  createdAt: Timestamp;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Pure. The canonical bytes are `JSON.stringify` of an object literal whose
 * keys are written in this exact order — insertion order is what
 * `JSON.stringify` serializes, so the encoding is deterministic by
 * construction, and `JSON.stringify` escapes every delimiter character an
 * id could contain.
 */
export function canonicalRunSnapshotLockEncoding(tuple: RunSnapshotLockTuple): string {
  return JSON.stringify({
    version: RUN_SNAPSHOT_LOCK_VERSION,
    sourceRunId: tuple.sourceRunId,
    workspaceId: tuple.workspaceId,
    projectId: tuple.projectId,
  });
}

export function computeRunSnapshotLockId(tuple: RunSnapshotLockTuple): string {
  if (!isNonEmptyString(tuple.sourceRunId) || !isNonEmptyString(tuple.workspaceId) || !isNonEmptyString(tuple.projectId)) {
    throw new Error("computeRunSnapshotLockId: every tuple member must be a non-empty string");
  }
  const digest = createHash("sha256").update(canonicalRunSnapshotLockEncoding(tuple), "utf8").digest("hex");
  return `${LOCK_ID_PREFIX}${digest}`;
}

export type ValidateRunSnapshotLockResult = { ok: true; lock: RunSnapshotLockV1 } | { ok: false; reason: "malformed" | "tuple_mismatch" };

/**
 * Pure. A lock read back from Firestore is trusted only if it is
 * well-formed AND its stored tuple equals the tuple the caller derived the
 * id from — a lock at the right id with the wrong tuple is corruption, not
 * a hit.
 */
export function validateRunSnapshotLock(data: unknown, expected: RunSnapshotLockTuple): ValidateRunSnapshotLockResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "malformed" };
  const d = data as Record<string, unknown>;
  if (d.version !== RUN_SNAPSHOT_LOCK_VERSION) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(d.sourceRunId) || !isNonEmptyString(d.workspaceId) || !isNonEmptyString(d.projectId)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(d.snapshotRunId) || !isNonEmptyString(d.createdBy)) return { ok: false, reason: "malformed" };
  if (!(d.createdAt instanceof Timestamp)) return { ok: false, reason: "malformed" };
  if (d.sourceRunId !== expected.sourceRunId || d.workspaceId !== expected.workspaceId || d.projectId !== expected.projectId) {
    return { ok: false, reason: "tuple_mismatch" };
  }
  return {
    ok: true,
    lock: {
      version: RUN_SNAPSHOT_LOCK_VERSION,
      sourceRunId: d.sourceRunId,
      workspaceId: d.workspaceId,
      projectId: d.projectId,
      snapshotRunId: d.snapshotRunId,
      createdBy: d.createdBy,
      createdAt: d.createdAt,
    },
  };
}
