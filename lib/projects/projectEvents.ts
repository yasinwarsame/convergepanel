/**
 * Project Foundation, Phase 6C — `projectEvents`, a new top-level,
 * append-only collection for Project organizational events. Deliberately
 * NOT `admin_audit_logs`: that collection has a closed, governance-
 * specific action vocabulary (`GovernanceAuditLogAction`, plus the
 * separately-defined `AuditAction` set `app/api/governance/audit/route.ts`
 * filters on) and an admin-only reader (`resolveGovernanceRequestUser` ->
 * `isAdminEmail`) — inspected directly, not assumed from the name, during
 * Phase 6A.2. Project events are an ordinary end-user product surface
 * with a genuinely different vocabulary and audience; reusing
 * `admin_audit_logs` would mean either silently invisible writes (the
 * existing reader's `isGovernanceAuditDoc()` filter would simply ignore
 * them) or incorrectly implying Project events ARE governance-relevant.
 *
 * Secondary, best-effort, never blocking in the sense that matters (frozen
 * by Phase 6A.2, reversing an earlier draft that briefly coupled event
 * writes to the same transaction as the canonical mutation; corrected again
 * in Phase 6C.1): every call site in the Phase 6C routes calls this ONLY
 * after the canonical Project mutation has already committed successfully.
 * Callers DO `await` this call — the guarantee is not "the response returns
 * before the event attempt finishes," it is "an event failure can never
 * turn a successful canonical mutation into a failed response." Those are
 * different properties: on Vercel/serverless, an unawaited async Firestore
 * write can be frozen or aborted once the response has been sent, which
 * would silently degrade "best-effort" into "rarely attempted to
 * completion." This function's own internal try/catch is what makes
 * awaiting it safe — it always resolves, mirroring `writeAuditEvent()`'s
 * established best-effort shape (`lib/governance/auditLog.ts`). No
 * automatic retry.
 *
 * Append-only random-ID writes (`.add()`), not the deterministic-ID
 * `.create()`-idempotent style governance events use — deliberately: a
 * retried Project-event write isn't a correctness risk the way a retried
 * governance decision could be, and constructing a deterministic id for a
 * repeatable transition (e.g. archive -> restore -> archive) is real,
 * unnecessary complexity this collection has no reason to take on.
 *
 * Metadata-only, by construction — this module has no parameter through
 * which a Project name, question, answer, report body, synthesis, or
 * governance content could ever reach a written document.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { Timestamp } from "firebase-admin/firestore";

export type ProjectEventType = "project_created" | "project_renamed" | "project_archived" | "project_restored" | "project_run_association_changed";

interface ProjectEventBase {
  eventType: ProjectEventType;
  actorUid: string;
  workspaceId: string;
  projectId: string;
}

/** `project_run_association_changed` is reserved for Phase 6D (not emitted by any Phase 6C route) — its extra fields are typed now so the future writer doesn't need a payload-shape migration. */
export interface ProjectRunAssociationEventExtra {
  runId: string;
  fromProjectId: string | null;
  toProjectId: string | null;
}

export type WriteProjectEventArgs = ProjectEventBase & Partial<ProjectRunAssociationEventExtra>;

/** Always resolves — never throws, never rejects. Callers MUST `await` this before returning their success response, so the request lifetime covers the best-effort attempt; a failure here is logged internally and never propagates. */
export async function writeProjectEvent(args: WriteProjectEventArgs): Promise<void> {
  if (!adminDb) {
    logger.warn("[projects/events] Skipped project event write — Firestore unavailable", { eventType: args.eventType });
    return;
  }
  try {
    await adminDb.collection("projectEvents").add({
      eventType: args.eventType,
      actorUid: args.actorUid,
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
      ...(args.fromProjectId !== undefined ? { fromProjectId: args.fromProjectId } : {}),
      ...(args.toProjectId !== undefined ? { toProjectId: args.toProjectId } : {}),
      at: Timestamp.now(),
    });
  } catch (err) {
    logger.warn("[projects/events] Failed to write project event — canonical mutation is unaffected", {
      eventType: args.eventType,
      projectId: args.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
