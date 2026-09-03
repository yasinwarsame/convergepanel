/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — the raw query + presentation-
 * safe projection for `GET /api/workspaces/{workspaceId}/audit-events`.
 *
 * v1 reads ONLY `workspaceMembershipEvents` (per PHASE TEAM-GOV-R1's
 * architecture audit — deliberately not `projectEvents`, not run-scoped
 * `governanceEvents`, to avoid premature multi-source complexity). The
 * query is exact-`workspaceId`-scoped, newest-first with a deterministic
 * secondary tie-breaker, and strictly bounded — never an unbounded scan.
 *
 * Malformed-row policy is DELIBERATELY DIFFERENT from
 * `listTeamWorkspaceRuns()`'s fail-WHOLE-WINDOW integrity policy: `runs`
 * has many writers and a real cross-boundary risk (a malformed row could
 * theoretically carry a wrong `workspaceId`/`projectId` reference this
 * route must not silently trust). `workspaceMembershipEvents` has exactly
 * ONE writer (`writeWorkspaceMembershipEvent()`, whose `previousRole` is
 * itself sourced from an already-validated `WorkspaceMembershipV1.role`
 * before the write) and the query's own `workspaceId ==` predicate already
 * prevents cross-Workspace leakage regardless of a row's other fields — a
 * malformed row here is realistically only reachable via post-write data
 * corruption, not a normal code path. This function therefore validates
 * and SKIPS (never emits, logs a warning) a malformed row rather than
 * aborting the entire page — consistent with Part H/AB's "fail closed in
 * normalization... do not manufacture a valid role label from malformed
 * data" instruction: skipping never fabricates a label.
 *
 * `hasMore`/the pagination cursor are derived from the RAW fetched window
 * (before validation-based skipping), exactly like `listTeamWorkspaceRuns()`
 * — the cursor must correspond to actual Firestore document order
 * regardless of a row's validation outcome, or a skipped/malformed row
 * between pages could cause a duplicate or gap on the next page.
 *
 * Phase TEAM-MGMT-12C — `"workspace_ownership_transferred"` added
 * alongside `"workspace_member_removed"` as a second recognized event
 * type. Both share an identical validated field set (`actorUid`,
 * `targetUid`, `previousRole`, `at`) so `validateRow()` branches only on
 * `eventType`, never duplicating the shared field checks. Identity
 * resolution (`resolveWorkspaceReviewerDisplayNames`) is unchanged — actor/
 * target uids from BOTH event types are added to the same `uids` Set
 * before the existing batched calls, so a mixed page never issues more
 * than the same two bounded calls.
 *
 * Team Member Management, Phase 12B — `"workspace_member_role_changed"`
 * added as a third recognized event type, and `ValidatedRow`/
 * `WorkspaceAuditEventDto` widened from a flat shape to a discriminated
 * union keyed on `eventType` (mirroring the write-side schema evolution in
 * `workspaceMembershipEvents.ts`), since this event type genuinely needs
 * an extra field (`newRole`) the other two do not. A row claiming
 * `workspace_member_role_changed` with a missing/invalid `newRole` is
 * malformed and skipped, same fail-closed posture as every other
 * validation branch here.
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { decodeWorkspaceAuditEventsCursor, encodeWorkspaceAuditEventsCursor } from "./workspaceAuditEventsCursor";
import { firestoreSecondsNanos } from "@/lib/runs/runSummary";
import { resolveWorkspaceReviewerDisplayNames } from "./workspaceReviewerIdentity";
import type { WorkspaceMembershipRole } from "./membershipTypes";

export const AUDIT_LOG_DEFAULT_LIMIT = 20;
export const AUDIT_LOG_MAX_LIMIT = 50;

export const UNKNOWN_AUDIT_ACTOR_LABEL = "Unknown user";
export const UNKNOWN_AUDIT_TARGET_LABEL = "Unknown member";

const VALID_PREVIOUS_ROLES: ReadonlySet<string> = new Set(["admin", "member", "reviewer", "viewer"]);

export type WorkspaceAuditPreviousRole = Exclude<WorkspaceMembershipRole, "owner">;

export type WorkspaceAuditEventType = "workspace_member_removed" | "workspace_ownership_transferred" | "workspace_member_role_changed";

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set(["workspace_member_removed", "workspace_ownership_transferred", "workspace_member_role_changed"]);

interface WorkspaceAuditEventDtoBase {
  occurredAt: string;
  actor: { displayName: string };
  target: { displayName: string };
}

export type WorkspaceAuditEventDto =
  | (WorkspaceAuditEventDtoBase & { eventType: "workspace_member_removed"; previousRole: WorkspaceAuditPreviousRole })
  | (WorkspaceAuditEventDtoBase & { eventType: "workspace_ownership_transferred"; previousRole: WorkspaceAuditPreviousRole })
  | (WorkspaceAuditEventDtoBase & { eventType: "workspace_member_role_changed"; previousRole: WorkspaceAuditPreviousRole; newRole: WorkspaceAuditPreviousRole });

export type ListWorkspaceAuditEventsResult =
  | { status: "ok"; items: WorkspaceAuditEventDto[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "query_failed" };

type ValidatedRow =
  | { eventType: "workspace_member_removed"; occurredAtIso: string; actorUid: string; targetUid: string; previousRole: WorkspaceAuditPreviousRole }
  | { eventType: "workspace_ownership_transferred"; occurredAtIso: string; actorUid: string; targetUid: string; previousRole: WorkspaceAuditPreviousRole }
  | { eventType: "workspace_member_role_changed"; occurredAtIso: string; actorUid: string; targetUid: string; previousRole: WorkspaceAuditPreviousRole; newRole: WorkspaceAuditPreviousRole };

/**
 * All three recognized event types share the same base validated fields
 * (`actorUid`/`targetUid`/`previousRole`/`at`) — validated once, before
 * branching on `eventType`. Only `workspace_member_role_changed` needs an
 * additional field (`newRole`), validated in its own branch; a row
 * claiming that event type with a missing/invalid `newRole` is malformed
 * and returns `null`, same as any other validation failure here.
 */
function validateRow(id: string, raw: Record<string, unknown> | undefined, workspaceId: string): ValidatedRow | null {
  if (!raw) return null;
  const eventType = raw.eventType;
  if (typeof eventType !== "string" || !VALID_EVENT_TYPES.has(eventType)) return null;
  if (raw.workspaceId !== workspaceId) return null;
  const actorUid = raw.actorUid;
  const targetUid = raw.targetUid;
  const previousRole = raw.previousRole;
  const at = raw.at;
  if (typeof actorUid !== "string" || actorUid.length === 0) return null;
  if (typeof targetUid !== "string" || targetUid.length === 0) return null;
  if (typeof previousRole !== "string" || !VALID_PREVIOUS_ROLES.has(previousRole)) return null;
  if (!at || typeof at !== "object" || typeof (at as { toDate?: unknown }).toDate !== "function") return null;

  let occurredAtIso: string;
  try {
    occurredAtIso = (at as { toDate: () => Date }).toDate().toISOString();
  } catch {
    return null;
  }

  if (eventType === "workspace_member_role_changed") {
    const newRole = raw.newRole;
    if (typeof newRole !== "string" || !VALID_PREVIOUS_ROLES.has(newRole)) return null;
    return { eventType, occurredAtIso, actorUid, targetUid, previousRole: previousRole as WorkspaceAuditPreviousRole, newRole: newRole as WorkspaceAuditPreviousRole };
  }

  return { eventType: eventType as "workspace_member_removed" | "workspace_ownership_transferred", occurredAtIso, actorUid, targetUid, previousRole: previousRole as WorkspaceAuditPreviousRole };
}

export async function listWorkspaceAuditEvents(args: { workspaceId: string; limit: number; cursorRaw?: string | null }): Promise<ListWorkspaceAuditEventsResult> {
  if (!adminDb) {
    return { status: "query_failed" };
  }

  let startAfter: { atSeconds: number; atNanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeWorkspaceAuditEventsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = decoded.cursor;
  }

  try {
    let query = adminDb
      .collection("workspaceMembershipEvents")
      .where("workspaceId", "==", args.workspaceId)
      .orderBy("at", "desc")
      .orderBy(FieldPath.documentId(), "desc");

    if (startAfter) {
      query = query.startAfter(new Timestamp(startAfter.atSeconds, startAfter.atNanoseconds), startAfter.lastDocId);
    }

    const snap = await query.limit(args.limit + 1).get();
    const allDocs = snap.docs;

    if (allDocs.length === 0) {
      return { status: "ok", items: [], hasMore: false };
    }

    const hasMore = allDocs.length > args.limit;
    const pageDocs = allDocs.slice(0, args.limit);

    const validated: ValidatedRow[] = [];
    for (const doc of pageDocs) {
      const row = validateRow(doc.id, doc.data() as Record<string, unknown>, args.workspaceId);
      if (!row) {
        logger.warn("[workspaces/listWorkspaceAuditEvents] Skipping malformed workspaceMembershipEvents row — never emitted", {
          workspaceId: args.workspaceId,
          docId: doc.id,
        });
        continue;
      }
      validated.push(row);
    }

    const uids = new Set<string>();
    for (const row of validated) {
      uids.add(row.actorUid);
      uids.add(row.targetUid);
    }
    // Two bounded batch calls (never per-event) — a uid appearing as both
    // an actor (in one event) and a target (in another) is fetched at
    // most twice, still O(1) Firestore round-trips relative to page size,
    // never N+1. Two calls (rather than one combined batch + label
    // remap) because actor/target need DIFFERENT fallback labels and this
    // keeps the label decision inside the existing, already-tested
    // resolver rather than introducing a sentinel-comparison layer here.
    const [actorNames, targetNames] = await Promise.all([
      resolveWorkspaceReviewerDisplayNames(args.workspaceId, Array.from(uids), UNKNOWN_AUDIT_ACTOR_LABEL),
      resolveWorkspaceReviewerDisplayNames(args.workspaceId, Array.from(uids), UNKNOWN_AUDIT_TARGET_LABEL),
    ]);

    const items: WorkspaceAuditEventDto[] = validated.map((row) => {
      const base = {
        occurredAt: row.occurredAtIso,
        actor: { displayName: actorNames.get(row.actorUid) ?? UNKNOWN_AUDIT_ACTOR_LABEL },
        target: { displayName: targetNames.get(row.targetUid) ?? UNKNOWN_AUDIT_TARGET_LABEL },
      };
      if (row.eventType === "workspace_member_role_changed") {
        return { ...base, eventType: row.eventType, previousRole: row.previousRole, newRole: row.newRole };
      }
      return { ...base, eventType: row.eventType, previousRole: row.previousRole };
    });

    const lastScanned = pageDocs[pageDocs.length - 1];
    const lastScannedTs = firestoreSecondsNanos(lastScanned.data().at);
    const nextCursor = hasMore
      ? encodeWorkspaceAuditEventsCursor({ atSeconds: lastScannedTs.seconds, atNanoseconds: lastScannedTs.nanoseconds, lastDocId: lastScanned.id })
      : undefined;

    return { status: "ok", items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (e: unknown) {
    logger.error("[workspaces/listWorkspaceAuditEvents] query failed", { workspaceId: args.workspaceId, error: e instanceof Error ? e.message : String(e) });
    return { status: "query_failed" };
  }
}
