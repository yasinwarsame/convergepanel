/**
 * SYNTHESIS_LEGACY_OWNERSHIP_HARDENING — the single access contract for every
 * `/api/synthesize-panel` surface that can generate a synthesis, return a
 * cached one, or let a request await another request's in-flight synthesis.
 *
 * A caller may use a run only when ownership is POSITIVELY confirmed:
 *
 *   typeof run.userId === "string" && run.userId === uid
 *
 * Anything else — absent, undefined, null, empty, a number, an object, an
 * array, or another user's id — is denied. There is no legacy allowance:
 * every current writer of a synthesis-eligible run (`createRun`,
 * `createTeamWorkspaceRun`, the Team snapshot writer) writes a string userId,
 * and no owner is ever inferred (workspace, membership, provenance) or
 * backfilled. Workspace integrity is an ADDITIONAL check after the owner
 * matches, never a substitute for it.
 *
 * External behaviour is deliberately coarse: every denial — malformed runId,
 * missing run, missing/non-string/foreign owner, invalid Workspace binding —
 * is the same concealed 403, so no response reveals which one occurred or
 * whether the run exists. Only a genuine inability to check (no Firestore,
 * a read or integrity lookup throwing) is 503. `reason` is for internal logs.
 */
import { adminDb } from "@/lib/firebase/admin";
import { ERROR_CODES } from "@/lib/api/errorResponse";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";

export type SynthesisRunDenialReason =
  | "malformed_run_id"
  | "run_not_found"
  | "owner_missing"
  | "owner_non_string"
  | "owner_mismatch"
  | `workspace_run_integrity_failed:${string}`;

export type SynthesisRunUnavailableReason = "admin_db_unavailable" | "run_lookup_threw" | "workspace_integrity_check_threw";

export type SynthesisRunAccess =
  | { outcome: "authorized"; runData: Record<string, unknown> }
  | { outcome: "forbidden"; reason: SynthesisRunDenialReason }
  | { outcome: "unavailable"; reason: SynthesisRunUnavailableReason };

/** The concealed response every denial maps to (unchanged established wording). */
export const SYNTHESIS_RUN_FORBIDDEN = {
  status: 403,
  errorCode: ERROR_CODES.FORBIDDEN,
  message: "You don't have access to this run.",
} as const;

/** The response when ownership genuinely cannot be checked right now. */
export const SYNTHESIS_RUN_UNAVAILABLE = {
  status: 503,
  errorCode: ERROR_CODES.RUN_LOOKUP_UNAVAILABLE,
  message: "Could not verify this run right now. Please try again shortly.",
} as const;

/**
 * Path safety for `collection("runs").doc(runId)`: a non-empty string with no
 * "/". A slash would make Firestore resolve a NESTED document (e.g.
 * `runs/X/humanReviewPanel/current`), which is never a run. Never normalized.
 */
export function isPathSafeRunId(runId: unknown): runId is string {
  return typeof runId === "string" && runId.length > 0 && !runId.includes("/");
}

/** Exact, positive owner confirmation on untyped stored data. */
export function classifyRunOwner(runData: Record<string, unknown>, uid: string): "owner" | "owner_missing" | "owner_non_string" | "owner_mismatch" {
  if (!Object.prototype.hasOwnProperty.call(runData, "userId") || runData.userId === undefined) return "owner_missing";
  const owner = runData.userId;
  if (typeof owner !== "string") return "owner_non_string";
  return uid.length > 0 && owner === uid ? "owner" : "owner_mismatch";
}

/** One read: shape → availability → existence → owner → Workspace integrity. Never throws. */
export async function resolveSynthesisRunAccess(runId: unknown, uid: string): Promise<SynthesisRunAccess> {
  if (!isPathSafeRunId(runId)) return { outcome: "forbidden", reason: "malformed_run_id" };
  if (!adminDb) return { outcome: "unavailable", reason: "admin_db_unavailable" };

  let snapshot;
  try {
    snapshot = await adminDb.collection("runs").doc(runId).get();
  } catch {
    return { outcome: "unavailable", reason: "run_lookup_threw" };
  }
  if (!snapshot.exists) return { outcome: "forbidden", reason: "run_not_found" };

  const data = snapshot.data();
  const runData = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const owner = classifyRunOwner(runData, uid);
  if (owner !== "owner") return { outcome: "forbidden", reason: owner };

  let integrity;
  try {
    integrity = await validateRunWorkspaceAssociation(runData);
  } catch {
    return { outcome: "unavailable", reason: "workspace_integrity_check_threw" };
  }
  if (integrity.classification === "invalid") {
    return { outcome: "forbidden", reason: `workspace_run_integrity_failed:${integrity.reason}` };
  }
  return { outcome: "authorized", runData };
}
