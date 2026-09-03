/**
 * Team Member Management, Phase 12A — `workspaceMembershipEvents`, a new
 * top-level, append-only collection for Team Workspace membership lifecycle
 * events. Structural mirror of `lib/projects/projectEvents.ts` (same
 * rationale: deliberately NOT `admin_audit_logs`, which has a closed,
 * governance-specific action vocabulary and an admin-only reader — a
 * membership removal is an ordinary Team Workspace product event, not a
 * governance decision, and reusing that collection would either silently
 * drop the write from every existing reader's filter or incorrectly imply
 * this event IS governance-relevant).
 *
 * Workspace Governance Audit Durability, Phase TEAM-GOV-I1C1 — CORRECTED.
 * Previously this module wrote the event via its own best-effort,
 * post-commit `.add()` call, matching every other event writer in this
 * codebase (the same pattern `writeProjectEvent()` still uses). For a
 * governance audit record tied to an authorization-changing operation
 * (a Team member removal), that shape allowed a real split-brain state:
 * `removeWorkspaceMembership()`'s transaction could commit successfully
 * while the subsequent, separate event write failed (network blip,
 * transient Firestore error), leaving a genuine removal with NO audit
 * trail — silently defeating the entire purpose of the Workspace Audit
 * Log PHASE TEAM-GOV-I1 built to close exactly this visibility gap.
 *
 * This module now exports ONLY a pure, zero-I/O document-data builder.
 * The actual Firestore write happens via `tx.set()` INSIDE
 * `removeWorkspaceMembership()`'s own transaction
 * (`lib/firestore/workspaceMemberships.ts`), so the membership mutation
 * and its governance event are one atomic unit: both commit or neither
 * does. `TECH_DEBT_GOVERNANCE_AUDIT_DURABILITY = OPEN_NON_BLOCKING`
 * remains accurate for every OTHER best-effort event writer in this
 * codebase (`writeProjectEvent()`, `writeAuditEvent()`, etc.) — this
 * correction is scoped to Team member removal only, per this phase's
 * explicit non-goal of a repository-wide durability refactor.
 *
 * Metadata-only, by construction — no parameter through which a display
 * name, email, or any other PII could reach a written document; identities
 * are UIDs only, matching this event's server-derived actor/target.
 *
 * Phase TEAM-MGMT-12C — `"workspace_ownership_transferred"` added
 * alongside `"workspace_member_removed"`. The SAME durability invariant
 * applies: `transferTeamWorkspaceOwnership()`
 * (`lib/firestore/workspaceMemberships.ts`) writes this event via its own
 * `tx.set()`, inside the SAME transaction as the ownership mutation —
 * `TRANSFER COMMITTED IFF AUDIT EVENT COMMITTED`. No new fields were
 * needed: the existing generic `previousRole` field is reused as-is to
 * hold the NEW Owner's role immediately before the transfer (never
 * `"owner"`, since a non-owner is always the transfer target); `actorUid`
 * is the PREVIOUS Owner (who performed the transfer), `targetUid` is the
 * NEW Owner.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import type { WorkspaceMembershipRole } from "./membershipTypes";

export type WorkspaceMembershipEventType = "workspace_member_removed" | "workspace_ownership_transferred";

export interface WorkspaceMembershipEventArgs {
  eventType: WorkspaceMembershipEventType;
  actorUid: string;
  targetUid: string;
  workspaceId: string;
  previousRole: WorkspaceMembershipRole;
}

export interface WorkspaceMembershipEventDocData {
  eventType: WorkspaceMembershipEventType;
  actorUid: string;
  targetUid: string;
  workspaceId: string;
  previousRole: WorkspaceMembershipRole;
  at: Timestamp;
}

/**
 * Pure — no I/O, never throws. `at` is caller-supplied (never generated
 * here) so the event's timestamp can be the EXACT SAME `Timestamp.now()`
 * instant already computed for the membership's own `removedAt`/
 * `updatedAt` fields inside the same transaction, rather than a second,
 * independently-drifted clock read.
 */
export function buildWorkspaceMembershipEventDocData(args: WorkspaceMembershipEventArgs & { at: Timestamp }): WorkspaceMembershipEventDocData {
  return {
    eventType: args.eventType,
    actorUid: args.actorUid,
    targetUid: args.targetUid,
    workspaceId: args.workspaceId,
    previousRole: args.previousRole,
    at: args.at,
  };
}
