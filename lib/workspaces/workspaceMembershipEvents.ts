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
 * Best-effort, non-blocking in the same sense `writeProjectEvent()`
 * documents: called only AFTER the canonical membership mutation has
 * already committed, always `await`ed (so the write is attempted for the
 * full request lifetime rather than risking being frozen/aborted after the
 * response is sent), and always resolves via its own internal try/catch —
 * a failure here can never turn a successful removal into a failed
 * response. Continue tracking `TECH_DEBT_GOVERNANCE_AUDIT_DURABILITY =
 * OPEN_NON_BLOCKING`: this event is not written atomically with the
 * membership mutation, matching every other best-effort event writer
 * already in this codebase — not a gap introduced by this module.
 *
 * Metadata-only, by construction — no parameter through which a display
 * name, email, or any other PII could reach a written document; identities
 * are UIDs only, matching this event's server-derived actor/target.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { Timestamp } from "firebase-admin/firestore";
import type { WorkspaceMembershipRole } from "./membershipTypes";

export type WorkspaceMembershipEventType = "workspace_member_removed";

export interface WorkspaceMembershipEventArgs {
  eventType: WorkspaceMembershipEventType;
  actorUid: string;
  targetUid: string;
  workspaceId: string;
  previousRole: WorkspaceMembershipRole;
}

/** Always resolves — never throws, never rejects. Callers MUST `await` this before returning their success response. */
export async function writeWorkspaceMembershipEvent(args: WorkspaceMembershipEventArgs): Promise<void> {
  if (!adminDb) {
    logger.warn("[workspaces/membershipEvents] Skipped membership event write — Firestore unavailable", { eventType: args.eventType });
    return;
  }
  try {
    await adminDb.collection("workspaceMembershipEvents").add({
      eventType: args.eventType,
      actorUid: args.actorUid,
      targetUid: args.targetUid,
      workspaceId: args.workspaceId,
      previousRole: args.previousRole,
      at: Timestamp.now(),
    });
  } catch (err) {
    logger.warn("[workspaces/membershipEvents] Failed to write membership event — canonical mutation is unaffected", {
      eventType: args.eventType,
      workspaceId: args.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
