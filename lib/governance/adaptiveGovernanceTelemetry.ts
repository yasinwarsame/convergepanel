/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.8/5.9 —
 * production-safe, structured observability for multi-reviewer panel
 * operations. Deliberately a THIN wrapper around the EXISTING `logger`
 * (`@/lib/logger`) — never a second logging system. Every call site is
 * responsible for passing ONLY the allowed metadata shape below; this
 * module does not (and cannot) sanitize arbitrary caller-supplied objects,
 * so it is intentionally typed to make it structurally awkward to pass a
 * forbidden field (no `comment`/`conditions`/`justification`/`email`/
 * `displayName` key exists anywhere in `AdaptiveGovernanceTelemetryMetadata`).
 *
 * This complements, and does NOT replace, the existing per-writer
 * `logger.warn(...)` calls throughout `lib/firestore/runs.ts` and the two
 * repair services — those already cover secondary-artifact write failures
 * with safe metadata and are left exactly as they are. This module fills
 * the gaps the Step 5.1 audit found: no observability existed for
 * SUCCESSFUL operations, or for the specific non-error-but-notable
 * outcomes (waiting/deadlocked/stale), or for malformed-record/
 * unsupported-schema-version detection.
 */

import { logger } from "@/lib/logger";

export type AdaptiveGovernanceOperation =
  | "panel_created"
  | "panel_reconfigured"
  | "panel_cancelled"
  | "vote_submitted"
  | "vote_conflict"
  | "finalization_completed"
  | "finalization_waiting"
  | "finalization_deadlocked"
  | "finalization_stale"
  | "override_completed"
  | "override_stale"
  | "override_already_finalized"
  | "repair_completed"
  | "repair_inconsistent"
  | "malformed_record_detected"
  | "unsupported_schema_version_detected";

/**
 * Exhaustive allowlist (§5.8) — `runId`/`teamId`/`panelRevision`/
 * `operation`/`statusCategory`/`failureCategory`/`artifactStatus`/
 * `aggregationPolicyVersion` ONLY. No field for comment, conditions,
 * justification, prompt, receipt, sources, model output, reviewer email,
 * reviewer display name, raw request body, or a raw Firestore error exists
 * on this type at all — there is nothing to accidentally pass.
 */
export type AdaptiveGovernanceTelemetryMetadata = {
  runId?: string;
  teamId?: string;
  panelRevision?: number;
  statusCategory?: string;
  failureCategory?: string;
  artifactStatus?: string;
  aggregationPolicyVersion?: number;
};

export function logAdaptiveGovernanceEvent(operation: AdaptiveGovernanceOperation, metadata: AdaptiveGovernanceTelemetryMetadata): void {
  logger.info(`[adaptive-governance] ${operation}`, { operation, ...metadata });
}
