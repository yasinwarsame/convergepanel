/**
 * Phase 7D — client-safe mirror of the *shape check* performed by
 * `lib/projects/updateTimeToken.ts`'s `validateUpdateTimeToken()`. That
 * module cannot be imported into client bundles at all (`import "server-only"`
 * plus a direct `firebase-admin/firestore` import) — this file intentionally
 * duplicates only the pure `{seconds, nanoseconds}` shape validation, never
 * the Firestore `Timestamp` construction.
 *
 * The client always treats a valid token as fully opaque: it is never
 * regenerated, reconstructed from a `Date`, precision-reduced, or
 * "synthesized as current" — it is only ever round-tripped exactly as
 * received from a `ProjectSummaryDto.updateTime` back into a mutation's
 * `expectedUpdateTime` field.
 */

const MAX_NANOSECONDS = 999_999_999;

export interface UpdateTimeToken {
  seconds: number;
  nanoseconds: number;
}

export function isValidUpdateTimeTokenShape(raw: unknown): raw is UpdateTimeToken {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.seconds !== "number" || !Number.isFinite(r.seconds) || !Number.isInteger(r.seconds) || r.seconds < 0) return false;
  if (typeof r.nanoseconds !== "number" || !Number.isFinite(r.nanoseconds) || !Number.isInteger(r.nanoseconds) || r.nanoseconds < 0 || r.nanoseconds > MAX_NANOSECONDS) {
    return false;
  }
  return true;
}
