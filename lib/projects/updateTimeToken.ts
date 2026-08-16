/**
 * Project Foundation, Phase 6C — the `expectedUpdateTime` optimistic-
 * concurrency wire token for Project mutations (rename/archive/restore).
 *
 * Deliberately named `expectedUpdateTime`, never `expectedUpdatedAt` (a
 * frozen naming decision from Phase 6A.2/6B): this token is Firestore's
 * own native document `updateTime` (`DocumentSnapshot.updateTime`, a real
 * `Timestamp` the Firestore server itself stamps on every write) — NOT
 * `ProjectV1.updatedAt`, an ordinary application field this codebase
 * happens to also set on every mutation. The two frequently agree in
 * value but are never the same concept: `updatedAt` is data a route
 * chooses to write; `updateTime` is metadata Firestore assigns
 * authoritatively regardless of what any route writes. Only the latter is
 * safe as a write precondition — see `@google-cloud/firestore`'s
 * `Precondition.lastUpdateTime` (verified against the actual installed
 * SDK types, `node_modules/@google-cloud/firestore/types/firestore.d.ts`,
 * not assumed).
 *
 * Serialized losslessly as `{seconds, nanoseconds}`, mirroring
 * `workspaceRunsCursor.ts`'s own seconds/nanoseconds discipline — never
 * milliseconds.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";

const MAX_NANOSECONDS = 999_999_999;

export interface UpdateTimeToken {
  seconds: number;
  nanoseconds: number;
}

export type ValidateUpdateTimeTokenResult = { ok: true; timestamp: Timestamp } | { ok: false; reason: "invalid_update_time" };

/** Validates a client-supplied `expectedUpdateTime` and reconstructs the exact `Timestamp` it represents — never `Timestamp.fromMillis()`, which would be lossy in the same way `workspaceRunsCursor.ts` already documents for cursors. */
export function validateUpdateTimeToken(raw: unknown): ValidateUpdateTimeTokenResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "invalid_update_time" };
  const r = raw as Record<string, unknown>;
  if (typeof r.seconds !== "number" || !Number.isFinite(r.seconds) || !Number.isInteger(r.seconds) || r.seconds < 0) {
    return { ok: false, reason: "invalid_update_time" };
  }
  if (typeof r.nanoseconds !== "number" || !Number.isFinite(r.nanoseconds) || !Number.isInteger(r.nanoseconds) || r.nanoseconds < 0 || r.nanoseconds > MAX_NANOSECONDS) {
    return { ok: false, reason: "invalid_update_time" };
  }
  return { ok: true, timestamp: new Timestamp(r.seconds, r.nanoseconds) };
}

/** The exact inverse — used when a route ever needs to hand a real `updateTime` back to a client as a fresh token (not currently done in any Phase 6C response, kept for symmetry/future use). */
export function serializeUpdateTimeToken(timestamp: Timestamp): UpdateTimeToken {
  return { seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds };
}

/** Lossless equality — the ONLY comparison used to decide a token is fresh. Never string/JSON equality on the Timestamp object itself. */
export function updateTimeTokensEqual(a: Timestamp, b: Timestamp): boolean {
  return a.seconds === b.seconds && a.nanoseconds === b.nanoseconds;
}
