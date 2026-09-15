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
 *
 * Team Member Management, Phase 12B — `"workspace_member_role_changed"`
 * added, and the module's shape widened from a single flat interface to a
 * discriminated union keyed on `eventType`. Unlike ownership transfer
 * (whose destination role is structurally implied by the event type
 * itself, so the existing single `previousRole` field was always
 * sufficient), a role change's destination genuinely varies per event and
 * must be recorded explicitly as `newRole`. A flat interface with
 * `newRole` merely optional would let a malformed/mistyped role-change
 * event compile with `newRole` silently missing; the discriminated union
 * makes that a compile-time error at every construction site instead.
 * `workspace_member_removed` and `workspace_ownership_transferred` keep
 * their original single-`previousRole` shape, byte-identical to what is
 * already persisted for those two event types.
 *
 * Project Archive/Restore Audit Visibility, Phase PROJECT-AUDIT-AR-I1 —
 * `"workspace_project_archived"` / `"workspace_project_restored"` added as
 * the first NON-member-shaped Workspace Audit events. They deliberately do
 * NOT carry `targetUid`/`previousRole`/`newRole` (there is no member
 * target and no role); instead they carry `projectId` plus a
 * `projectName` SNAPSHOT taken from the transaction-read Project at
 * mutation time, so the audit row stays historically legible after a
 * later rename and the reader never needs a per-event Project lookup.
 * Archive-vs-restore is encoded entirely by `eventType` — no
 * `previousStatus`/`newStatus`. Written ONLY via `tx.set()` inside
 * `updateTeamProjectFields()`'s own transaction (`lib/firestore/
 * teamProjects.ts`) — never through the separate, best-effort
 * `projectEvents` writer, which remains unchanged and unread by Workspace
 * Audit. The collection keeps its `workspaceMembershipEvents` name: it is
 * the single Workspace Audit source (one query, one cursor, one existing
 * composite index), and renaming a live collection is out of scope.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import type { WorkspaceMembershipRole } from "./membershipTypes";

/**
 * ADD-TO-TEAM-PROJECT §P — `"workspace_research_snapshot_created"` added as
 * the first RESEARCH-shaped Workspace Audit event: a Team Project received
 * a research artifact copied from a member's Personal workspace. Carries
 * the destination Project (`projectId` + `projectName` snapshot, exactly
 * like the Project lifecycle events) plus the DESTINATION run (`runId` +
 * `runQuestion` snapshot). The Personal SOURCE run id is deliberately NOT
 * on the event: the authoritative provenance lives on
 * `runs/{snapshotRunId}.origin`, and the user-facing audit DTO would have
 * no legitimate use for a Personal identifier. Written ONLY via `tx.set()`
 * inside `createTeamRunSnapshotFromPersonal()`'s own transaction
 * (`lib/firestore/teamRunSnapshots.ts`) — SNAPSHOT COMMITTED IFF AUDIT
 * EVENT COMMITTED.
 */
/**
 * Project/Research Assignment (D5) — `"workspace_project_assignees_changed"`
 * and `"workspace_research_assignee_changed"` added: the first events that
 * carry BOTH a Project/run subject AND member targets. Written ONLY via
 * `tx.set()` inside the assignment mutation's own transaction
 * (`updateTeamProjectFields()` / `setTeamRunAssignee()`) — ASSIGNMENT
 * COMMITTED IFF AUDIT EVENT COMMITTED. Never written on a semantic no-op
 * (D6). Identities are uids only; display names resolve at read time.
 * The research event's `projectId`/`projectName` are nullable because a
 * canonical Team run may be Unfiled; when filed, `projectName` is the
 * transaction-read Project's name snapshot (or `null` if that Project was
 * missing/malformed/foreign — never a post-commit lookup).
 */
export type WorkspaceMembershipEventType =
  | "workspace_member_removed"
  | "workspace_ownership_transferred"
  | "workspace_member_role_changed"
  | "workspace_project_archived"
  | "workspace_project_restored"
  | "workspace_research_snapshot_created"
  | "workspace_project_assignees_changed"
  | "workspace_research_assignee_changed";

interface WorkspaceMembershipEventIdentity {
  actorUid: string;
  targetUid: string;
  workspaceId: string;
}

/** Project lifecycle events have an actor and a Workspace but NO member target — `targetUid` is structurally absent, never `null`/empty. */
interface WorkspaceProjectEventIdentity {
  actorUid: string;
  workspaceId: string;
  projectId: string;
  /** Snapshot of the transaction-read Project name at mutation time — never resolved at read time, never client-supplied. */
  projectName: string;
}

/** Research snapshot events carry the destination Project AND the destination run — never the Personal source run id, never a member target. */
interface WorkspaceResearchSnapshotEventIdentity {
  actorUid: string;
  workspaceId: string;
  projectId: string;
  /** Snapshot of the transaction-read Project name at mutation time. */
  projectName: string;
  /** The DESTINATION (Team) run id created by the snapshot. */
  runId: string;
  /** Snapshot of the destination run's question at creation time — the human-legible run identity. */
  runQuestion: string;
}

/** Project assignee changes: the transaction-read Project plus the bounded change set (≤ 20 each side; one side may be empty). */
interface WorkspaceProjectAssignmentEventIdentity {
  actorUid: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  addedUids: string[];
  removedUids: string[];
}

/** Run assignee changes: the DESTINATION run, its Project (nullable — Unfiled runs are canonical), and the previous/new assignee (nullable). */
interface WorkspaceResearchAssignmentEventIdentity {
  actorUid: string;
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  runId: string;
  runQuestion: string;
  previousAssigneeUid: string | null;
  assigneeUid: string | null;
}

export type WorkspaceMembershipEventArgs =
  | (WorkspaceMembershipEventIdentity & { eventType: "workspace_member_removed"; previousRole: WorkspaceMembershipRole })
  | (WorkspaceMembershipEventIdentity & { eventType: "workspace_ownership_transferred"; previousRole: WorkspaceMembershipRole })
  | (WorkspaceMembershipEventIdentity & { eventType: "workspace_member_role_changed"; previousRole: WorkspaceMembershipRole; newRole: WorkspaceMembershipRole })
  | (WorkspaceProjectEventIdentity & { eventType: "workspace_project_archived" })
  | (WorkspaceProjectEventIdentity & { eventType: "workspace_project_restored" })
  | (WorkspaceResearchSnapshotEventIdentity & { eventType: "workspace_research_snapshot_created" })
  | (WorkspaceProjectAssignmentEventIdentity & { eventType: "workspace_project_assignees_changed" })
  | (WorkspaceResearchAssignmentEventIdentity & { eventType: "workspace_research_assignee_changed" });

export type WorkspaceMembershipEventDocData =
  | (WorkspaceMembershipEventIdentity & { eventType: "workspace_member_removed"; previousRole: WorkspaceMembershipRole; at: Timestamp })
  | (WorkspaceMembershipEventIdentity & { eventType: "workspace_ownership_transferred"; previousRole: WorkspaceMembershipRole; at: Timestamp })
  | (WorkspaceMembershipEventIdentity & { eventType: "workspace_member_role_changed"; previousRole: WorkspaceMembershipRole; newRole: WorkspaceMembershipRole; at: Timestamp })
  | (WorkspaceProjectEventIdentity & { eventType: "workspace_project_archived"; at: Timestamp })
  | (WorkspaceProjectEventIdentity & { eventType: "workspace_project_restored"; at: Timestamp })
  | (WorkspaceResearchSnapshotEventIdentity & { eventType: "workspace_research_snapshot_created"; at: Timestamp })
  | (WorkspaceProjectAssignmentEventIdentity & { eventType: "workspace_project_assignees_changed"; at: Timestamp })
  | (WorkspaceResearchAssignmentEventIdentity & { eventType: "workspace_research_assignee_changed"; at: Timestamp });

/**
 * Pure — no I/O, never throws. `at` is caller-supplied (never generated
 * here) so the event's timestamp can be the EXACT SAME `Timestamp.now()`
 * instant already computed for the membership's own `removedAt`/
 * `updatedAt`/`role` fields (or a Project's own `updatedAt`) inside the
 * same transaction, rather than a second, independently-drifted clock read. The return type is the exact
 * matching union member — TypeScript narrows through `args`'s own
 * discriminant, so this can never construct a `workspace_member_role_changed`
 * doc missing `newRole`.
 */
export function buildWorkspaceMembershipEventDocData(args: WorkspaceMembershipEventArgs & { at: Timestamp }): WorkspaceMembershipEventDocData {
  return { ...args };
}
