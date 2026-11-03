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
 *
 * Project Archive/Restore Audit Visibility, Phase PROJECT-AUDIT-AR-I1 —
 * `"workspace_project_archived"` / `"workspace_project_restored"` added as
 * the first PROJECT-shaped event types. `validateRow()` is restructured
 * into COMMON checks (recognized `eventType`, `workspaceId`, `actorUid`,
 * `at`) followed by a per-shape branch: MEMBER events keep their exact
 * pre-existing requirements (`targetUid`, `previousRole`, and `newRole`
 * for role-changed — byte-for-byte the same checks as before, only moved
 * under the member branch); PROJECT events require a non-empty string
 * `projectId` and `projectName` and are never forced through the member
 * target/role schema. The DTO for a Project event exposes only
 * `{eventType, occurredAt, actor.displayName, project.name}` — the stored
 * `projectId` is NOT surfaced (same allow-list posture as `actorUid`/
 * `targetUid`). `projectEvents` is still deliberately NOT read here.
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { decodeWorkspaceAuditEventsCursor, encodeWorkspaceAuditEventsCursor } from "./workspaceAuditEventsCursor";
import { firestoreSecondsNanos } from "@/lib/runs/runSummary";
import { resolveWorkspaceReviewerDisplayNames } from "./workspaceReviewerIdentity";
import type { WorkspaceMembershipRole } from "./membershipTypes";
import { REPORT_REVIEW_PURPOSES, REPORT_REVIEW_DECISION_STATUSES } from "@/lib/governance/reportReviewCopy";

export const AUDIT_LOG_DEFAULT_LIMIT = 20;
export const AUDIT_LOG_MAX_LIMIT = 50;

export const UNKNOWN_AUDIT_ACTOR_LABEL = "Unknown user";
export const UNKNOWN_AUDIT_TARGET_LABEL = "Unknown member";

const VALID_PREVIOUS_ROLES: ReadonlySet<string> = new Set(["admin", "member", "reviewer", "viewer"]);

export type WorkspaceAuditPreviousRole = Exclude<WorkspaceMembershipRole, "owner">;

export type WorkspaceAuditMemberEventType = "workspace_member_removed" | "workspace_ownership_transferred" | "workspace_member_role_changed";
export type WorkspaceAuditProjectEventType = "workspace_project_archived" | "workspace_project_restored";
/**
 * ADD-TO-TEAM-PROJECT §P — the first RESEARCH-shaped event: requires
 * `projectId`/`projectName` (like Project events) PLUS `runId`/`runQuestion`.
 * The DTO exposes `project.name` and `research.question` only — never
 * `projectId`, never `runId`, and the Personal source run id is not even
 * on the stored row.
 */
export type WorkspaceAuditResearchEventType = "workspace_research_snapshot_created";
/**
 * Project/Research Assignment (brief §6.8) — two ASSIGNMENT-shaped events.
 * `workspace_project_assignees_changed` carries the Project name snapshot
 * plus the uid diff (resolved to display names only — uids never leave the
 * server). `workspace_research_assignee_changed` carries the run question
 * snapshot, a NULLABLE Project name snapshot (Unfiled / missing / malformed
 * Project at mutation time ⇒ `null`, by contract §2.4), and the previous /
 * new assignee as nullable display names. No ids of any kind are surfaced.
 */
export type WorkspaceAuditAssignmentEventType = "workspace_project_assignees_changed" | "workspace_research_assignee_changed";
/**
 * Order B, Stage B3 — Report Review events (written in the mutation's own transaction by
 * lib/workspaces/reportReviewWorkspaceAudit.ts). The DTO exposes the run question snapshot, the cycle, the purpose code,
 * statuses and display names only — never `runId`, `projectId` or a uid.
 */
export type WorkspaceAuditReportReviewEventType =
  | "workspace_report_review_submitted"
  | "workspace_report_review_resubmitted"
  | "workspace_report_review_reviewer_changed"
  | "workspace_report_review_decided";
export type WorkspaceAuditEventType = WorkspaceAuditMemberEventType | WorkspaceAuditProjectEventType | WorkspaceAuditResearchEventType | WorkspaceAuditAssignmentEventType | WorkspaceAuditReportReviewEventType;

const VALID_MEMBER_EVENT_TYPES: ReadonlySet<string> = new Set(["workspace_member_removed", "workspace_ownership_transferred", "workspace_member_role_changed"]);
const VALID_PROJECT_EVENT_TYPES: ReadonlySet<string> = new Set(["workspace_project_archived", "workspace_project_restored"]);
const VALID_RESEARCH_EVENT_TYPES: ReadonlySet<string> = new Set(["workspace_research_snapshot_created"]);
const VALID_ASSIGNMENT_EVENT_TYPES: ReadonlySet<string> = new Set(["workspace_project_assignees_changed", "workspace_research_assignee_changed"]);
const VALID_REPORT_REVIEW_EVENT_TYPES: ReadonlySet<string> = new Set([
  "workspace_report_review_submitted",
  "workspace_report_review_resubmitted",
  "workspace_report_review_reviewer_changed",
  "workspace_report_review_decided",
]);
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([...VALID_MEMBER_EVENT_TYPES, ...VALID_PROJECT_EVENT_TYPES, ...VALID_RESEARCH_EVENT_TYPES, ...VALID_ASSIGNMENT_EVENT_TYPES, ...VALID_REPORT_REVIEW_EVENT_TYPES]);
const VALID_RR_PURPOSES: ReadonlySet<string> = new Set(REPORT_REVIEW_PURPOSES);
const VALID_RR_DECISIONS: ReadonlySet<string> = new Set(REPORT_REVIEW_DECISION_STATUSES);
const VALID_RR_PRIOR_STATUSES: ReadonlySet<string> = new Set(["unreviewed", "pending"]);
/**
 * Order 4 Slice 2a — RECOGNISED but not surfaced: Source Standing audit rows
 * are written by the (dark) Source Standing writer and will be presented by a
 * later UI slice. Until then they are skipped quietly — they are not
 * malformed, so they must not raise the malformed-row warning.
 */
const KNOWN_NOT_SURFACED_EVENT_TYPES: ReadonlySet<string> = new Set(["workspace_source_standing_changed"]);

interface WorkspaceAuditEventDtoBase {
  occurredAt: string;
  actor: { displayName: string };
}

interface WorkspaceAuditMemberEventDtoBase extends WorkspaceAuditEventDtoBase {
  target: { displayName: string };
}

/** Project events expose the mutation-time name snapshot only — never `projectId`, never a link target. */
interface WorkspaceAuditProjectEventDtoBase extends WorkspaceAuditEventDtoBase {
  project: { name: string };
}

/** Research events expose the Project name snapshot and the run's question snapshot only — never `projectId`, never `runId`. */
interface WorkspaceAuditResearchEventDtoBase extends WorkspaceAuditEventDtoBase {
  project: { name: string };
  research: { question: string };
}

/**
 * Assignment events: display names only.
 *
 * `repair: true` (PR #164 review C3) marks an INTEGRITY-REPAIR write — the
 * mutation normalized a malformed persisted value and committed a real
 * canonical write whose logical before/after are equal (Project: empty
 * diff on both sides; research: `previousAssignee === assignee`,
 * including `null === null`). These are real committed writes with real
 * events, NOT semantic no-ops (D6 no-ops write nothing and emit nothing).
 *
 * The research event's `project` (PR #164 review C2) mirrors the writer's
 * three forms: `{ name }` for a snapshotted Project, `null` for an Unfiled
 * run, and `{ unavailable: true }` when the run was filed but the Project
 * could not be snapshotted (missing / malformed / foreign at mutation
 * time) — the stored `projectId` is NEVER surfaced, and this is
 * deliberately not presented as "Unfiled".
 */
interface WorkspaceAuditProjectAssignmentEventDto extends WorkspaceAuditEventDtoBase {
  eventType: "workspace_project_assignees_changed";
  project: { name: string };
  added: { displayName: string }[];
  removed: { displayName: string }[];
  repair: boolean;
}
export type WorkspaceAuditResearchProjectRef = { name: string } | { unavailable: true } | null;
interface WorkspaceAuditResearchAssignmentEventDto extends WorkspaceAuditEventDtoBase {
  eventType: "workspace_research_assignee_changed";
  project: WorkspaceAuditResearchProjectRef;
  research: { question: string };
  previousAssignee: { displayName: string } | null;
  assignee: { displayName: string } | null;
  repair: boolean;
}

/** Report Review rows: the run question snapshot (null when the run had none — never invented), cycle, display names only. */
interface WorkspaceAuditReportReviewDtoBase extends WorkspaceAuditEventDtoBase {
  research: { question: string | null };
  cycle: number;
}
export type WorkspaceAuditReportReviewEventDto =
  | (WorkspaceAuditReportReviewDtoBase & { eventType: "workspace_report_review_submitted"; purpose: string })
  | (WorkspaceAuditReportReviewDtoBase & { eventType: "workspace_report_review_resubmitted"; fromCycle: number; purpose: string; clearedReviewer: { displayName: string } | null })
  | (WorkspaceAuditReportReviewDtoBase & {
      eventType: "workspace_report_review_reviewer_changed";
      /** Decided from uids on the server (never from display names): a same-reviewer write is an assignment update (e.g. due date). */
      change: "assigned" | "reassigned" | "removed" | "updated";
      previousReviewer: { displayName: string } | null;
      reviewer: { displayName: string } | null;
    })
  | (WorkspaceAuditReportReviewDtoBase & { eventType: "workspace_report_review_decided"; status: string; purpose: string });

export type WorkspaceAuditEventDto =
  | WorkspaceAuditReportReviewEventDto
  | WorkspaceAuditProjectAssignmentEventDto
  | WorkspaceAuditResearchAssignmentEventDto
  | (WorkspaceAuditMemberEventDtoBase & { eventType: "workspace_member_removed"; previousRole: WorkspaceAuditPreviousRole })
  | (WorkspaceAuditMemberEventDtoBase & { eventType: "workspace_ownership_transferred"; previousRole: WorkspaceAuditPreviousRole })
  | (WorkspaceAuditMemberEventDtoBase & { eventType: "workspace_member_role_changed"; previousRole: WorkspaceAuditPreviousRole; newRole: WorkspaceAuditPreviousRole })
  | (WorkspaceAuditProjectEventDtoBase & { eventType: "workspace_project_archived" })
  | (WorkspaceAuditProjectEventDtoBase & { eventType: "workspace_project_restored" })
  | (WorkspaceAuditResearchEventDtoBase & { eventType: "workspace_research_snapshot_created" });

export type ListWorkspaceAuditEventsResult =
  | { status: "ok"; items: WorkspaceAuditEventDto[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "query_failed" };

type ValidatedRow =
  | { eventType: "workspace_member_removed"; occurredAtIso: string; actorUid: string; targetUid: string; previousRole: WorkspaceAuditPreviousRole }
  | { eventType: "workspace_ownership_transferred"; occurredAtIso: string; actorUid: string; targetUid: string; previousRole: WorkspaceAuditPreviousRole }
  | { eventType: "workspace_member_role_changed"; occurredAtIso: string; actorUid: string; targetUid: string; previousRole: WorkspaceAuditPreviousRole; newRole: WorkspaceAuditPreviousRole }
  | { eventType: "workspace_project_archived"; occurredAtIso: string; actorUid: string; projectId: string; projectName: string }
  | { eventType: "workspace_project_restored"; occurredAtIso: string; actorUid: string; projectId: string; projectName: string }
  | { eventType: "workspace_research_snapshot_created"; occurredAtIso: string; actorUid: string; projectId: string; projectName: string; runId: string; runQuestion: string }
  | { eventType: "workspace_project_assignees_changed"; occurredAtIso: string; actorUid: string; projectId: string; projectName: string; addedUids: string[]; removedUids: string[] }
  | { eventType: "workspace_research_assignee_changed"; occurredAtIso: string; actorUid: string; projectId: string | null; projectName: string | null; runId: string; runQuestion: string; previousAssigneeUid: string | null; assigneeUid: string | null }
  | ReportReviewValidatedRow;

type ReportReviewRowBase = { occurredAtIso: string; actorUid: string; runQuestion: string | null; cycle: number };
type ReportReviewValidatedRow =
  | (ReportReviewRowBase & { eventType: "workspace_report_review_submitted"; purposeCode: string })
  | (ReportReviewRowBase & { eventType: "workspace_report_review_resubmitted"; fromCycle: number; purposeCode: string; clearedReviewerUid: string | null })
  | (ReportReviewRowBase & { eventType: "workspace_report_review_reviewer_changed"; previousReviewerUid: string | null; reviewerUid: string | null })
  | (ReportReviewRowBase & { eventType: "workspace_report_review_decided"; status: string; purposeCode: string });

function isReportReviewRow(row: ValidatedRow): row is ReportReviewValidatedRow {
  return VALID_REPORT_REVIEW_EVENT_TYPES.has(row.eventType);
}

const isCycle = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const isUidOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0);

/** Report Review rows: every field the writer always sets must be present and well-formed, or the row is skipped. */
function validateReportReviewRow(eventType: string, raw: Record<string, unknown>, occurredAtIso: string, actorUid: string): ReportReviewValidatedRow | null {
  if (typeof raw.runId !== "string" || raw.runId.length === 0) return null;
  if (!(raw.projectId === null || (typeof raw.projectId === "string" && raw.projectId.length > 0))) return null;
  const runQuestion = raw.runQuestion;
  if (!(runQuestion === null || (typeof runQuestion === "string" && runQuestion.length > 0))) return null;
  if (!isCycle(raw.cycle)) return null;
  const base: ReportReviewRowBase = { occurredAtIso, actorUid, runQuestion: runQuestion as string | null, cycle: raw.cycle };
  switch (eventType) {
    case "workspace_report_review_submitted":
      if (typeof raw.purposeCode !== "string" || !VALID_RR_PURPOSES.has(raw.purposeCode)) return null;
      if (raw.cycle !== 1) return null;
      return { ...base, eventType, purposeCode: raw.purposeCode };
    case "workspace_report_review_resubmitted":
      if (typeof raw.purposeCode !== "string" || !VALID_RR_PURPOSES.has(raw.purposeCode)) return null;
      if (!isCycle(raw.fromCycle) || raw.cycle !== raw.fromCycle + 1) return null;
      if (!isUidOrNull(raw.clearedReviewerUid)) return null;
      return { ...base, eventType, fromCycle: raw.fromCycle, purposeCode: raw.purposeCode, clearedReviewerUid: raw.clearedReviewerUid };
    case "workspace_report_review_reviewer_changed":
      if (!isUidOrNull(raw.previousReviewerUid) || !isUidOrNull(raw.reviewerUid)) return null;
      return { ...base, eventType, previousReviewerUid: raw.previousReviewerUid, reviewerUid: raw.reviewerUid };
    case "workspace_report_review_decided":
      if (typeof raw.purposeCode !== "string" || !VALID_RR_PURPOSES.has(raw.purposeCode)) return null;
      if (typeof raw.status !== "string" || !VALID_RR_DECISIONS.has(raw.status)) return null;
      if (typeof raw.priorStatus !== "string" || !VALID_RR_PRIOR_STATUSES.has(raw.priorStatus)) return null;
      return { ...base, eventType, status: raw.status, purposeCode: raw.purposeCode };
    default:
      return null;
  }
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

/**
 * COMMON checks first (recognized `eventType`, exact `workspaceId`,
 * non-empty `actorUid`, a Timestamp-like `at`), then ONE shape branch:
 *   - MEMBER events (`workspace_member_removed`,
 *     `workspace_ownership_transferred`, `workspace_member_role_changed`)
 *     require non-empty `targetUid` + valid `previousRole`, and
 *     role-changed additionally requires a valid `newRole` — exactly the
 *     pre-AR-I1 requirements, unchanged.
 *   - PROJECT events (`workspace_project_archived`,
 *     `workspace_project_restored`) require non-empty string `projectId`
 *     + `projectName` and have NO dependency on `targetUid`/
 *     `previousRole`/`newRole`.
 * Any failure returns `null` — the row is skipped, never repaired or
 * rendered with a manufactured value.
 */
function validateRow(id: string, raw: Record<string, unknown> | undefined, workspaceId: string): ValidatedRow | null {
  if (!raw) return null;
  const eventType = raw.eventType;
  if (typeof eventType !== "string" || !VALID_EVENT_TYPES.has(eventType)) return null;
  if (raw.workspaceId !== workspaceId) return null;
  const actorUid = raw.actorUid;
  const at = raw.at;
  if (typeof actorUid !== "string" || actorUid.length === 0) return null;
  if (!at || typeof at !== "object" || typeof (at as { toDate?: unknown }).toDate !== "function") return null;

  let occurredAtIso: string;
  try {
    occurredAtIso = (at as { toDate: () => Date }).toDate().toISOString();
  } catch {
    return null;
  }

  if (VALID_REPORT_REVIEW_EVENT_TYPES.has(eventType)) return validateReportReviewRow(eventType, raw, occurredAtIso, actorUid);

  if (VALID_PROJECT_EVENT_TYPES.has(eventType)) {
    const projectId = raw.projectId;
    const projectName = raw.projectName;
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    if (typeof projectName !== "string" || projectName.length === 0) return null;
    return { eventType: eventType as WorkspaceAuditProjectEventType, occurredAtIso, actorUid, projectId, projectName };
  }

  if (VALID_RESEARCH_EVENT_TYPES.has(eventType)) {
    const projectId = raw.projectId;
    const projectName = raw.projectName;
    const runId = raw.runId;
    const runQuestion = raw.runQuestion;
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    if (typeof projectName !== "string" || projectName.length === 0) return null;
    if (typeof runId !== "string" || runId.length === 0) return null;
    if (typeof runQuestion !== "string" || runQuestion.length === 0) return null;
    return { eventType: "workspace_research_snapshot_created", occurredAtIso, actorUid, projectId, projectName, runId, runQuestion };
  }

  if (eventType === "workspace_project_assignees_changed") {
    // ASSIGNMENT-shaped (Project): name snapshot + uid diff. An EMPTY diff
    // on both sides is a legitimate writer shape: an integrity-repair write
    // (a malformed / over-cap persisted list canonicalized to `[]`) — a
    // real committed write, projected as `repair: true` (review C3).
    const projectId = raw.projectId;
    const projectName = raw.projectName;
    const addedUids = raw.addedUids;
    const removedUids = raw.removedUids;
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    if (typeof projectName !== "string" || projectName.length === 0) return null;
    if (!isNonEmptyStringArray(addedUids) || !isNonEmptyStringArray(removedUids)) return null;
    return { eventType, occurredAtIso, actorUid, projectId, projectName, addedUids, removedUids };
  }

  if (eventType === "workspace_research_assignee_changed") {
    // ASSIGNMENT-shaped (research). The writer's THREE Project forms are
    // all accepted (review C2): `null/null` (Unfiled), `string/string`
    // (snapshotted), `string/null` (filed, Project unavailable at mutation
    // time). `null/string` is malformed. The two assignee fields are each
    // `string | null`; EQUAL values are a legitimate integrity-repair
    // write (review C3), projected as `repair: true`.
    const projectId = raw.projectId;
    const projectName = raw.projectName;
    const runId = raw.runId;
    const runQuestion = raw.runQuestion;
    const previousAssigneeUid = raw.previousAssigneeUid;
    const assigneeUid = raw.assigneeUid;
    const idValid = projectId === null || (typeof projectId === "string" && projectId.length > 0);
    const nameValid = projectName === null || (typeof projectName === "string" && projectName.length > 0);
    if (!idValid || !nameValid) return null;
    if (projectId === null && projectName !== null) return null;
    if (typeof runId !== "string" || runId.length === 0) return null;
    if (typeof runQuestion !== "string" || runQuestion.length === 0) return null;
    const uidOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0);
    if (!uidOrNull(previousAssigneeUid) || !uidOrNull(assigneeUid)) return null;
    return { eventType, occurredAtIso, actorUid, projectId: projectId as string | null, projectName: projectName as string | null, runId, runQuestion, previousAssigneeUid, assigneeUid };
  }

  const targetUid = raw.targetUid;
  const previousRole = raw.previousRole;
  if (typeof targetUid !== "string" || targetUid.length === 0) return null;
  if (typeof previousRole !== "string" || !VALID_PREVIOUS_ROLES.has(previousRole)) return null;

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
      const data = doc.data() as Record<string, unknown>;
      if (typeof data?.eventType === "string" && KNOWN_NOT_SURFACED_EVENT_TYPES.has(data.eventType)) continue;
      const row = validateRow(doc.id, data, args.workspaceId);
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
      if ("targetUid" in row) uids.add(row.targetUid);
      if (row.eventType === "workspace_project_assignees_changed") {
        for (const u of row.addedUids) uids.add(u);
        for (const u of row.removedUids) uids.add(u);
      }
      if (row.eventType === "workspace_research_assignee_changed") {
        if (row.previousAssigneeUid !== null) uids.add(row.previousAssigneeUid);
        if (row.assigneeUid !== null) uids.add(row.assigneeUid);
      }
      if (row.eventType === "workspace_report_review_reviewer_changed") {
        if (row.previousReviewerUid !== null) uids.add(row.previousReviewerUid);
        if (row.reviewerUid !== null) uids.add(row.reviewerUid);
      }
      if (row.eventType === "workspace_report_review_resubmitted" && row.clearedReviewerUid !== null) uids.add(row.clearedReviewerUid);
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
      const actor = { displayName: actorNames.get(row.actorUid) ?? UNKNOWN_AUDIT_ACTOR_LABEL };
      if (isReportReviewRow(row)) {
        // Allow-list projection: question snapshot, cycle, purpose code, statuses and display names — no runId, projectId or uid.
        const r = row;
        const toName = (u: string | null) => (u === null ? null : { displayName: targetNames.get(u) ?? UNKNOWN_AUDIT_TARGET_LABEL });
        const base = { occurredAt: r.occurredAtIso, actor, research: { question: r.runQuestion }, cycle: r.cycle };
        switch (r.eventType) {
          case "workspace_report_review_submitted":
            return { ...base, eventType: r.eventType, purpose: r.purposeCode };
          case "workspace_report_review_resubmitted":
            return { ...base, eventType: r.eventType, fromCycle: r.fromCycle, purpose: r.purposeCode, clearedReviewer: toName(r.clearedReviewerUid) };
          case "workspace_report_review_reviewer_changed":
            return {
              ...base,
              eventType: r.eventType,
              change: r.reviewerUid === null ? "removed" : r.previousReviewerUid === null ? "assigned" : r.previousReviewerUid === r.reviewerUid ? "updated" : "reassigned",
              previousReviewer: toName(r.previousReviewerUid),
              reviewer: toName(r.reviewerUid),
            };
          case "workspace_report_review_decided":
            return { ...base, eventType: r.eventType, status: r.status, purpose: r.purposeCode };
        }
      }
      if (row.eventType === "workspace_project_archived" || row.eventType === "workspace_project_restored") {
        // Allow-list projection: name snapshot only — `projectId` is never surfaced.
        return { eventType: row.eventType, occurredAt: row.occurredAtIso, actor, project: { name: row.projectName } };
      }
      if (row.eventType === "workspace_research_snapshot_created") {
        // Allow-list projection: name + question snapshots only — neither `projectId` nor `runId` is surfaced.
        return { eventType: row.eventType, occurredAt: row.occurredAtIso, actor, project: { name: row.projectName }, research: { question: row.runQuestion } };
      }
      if (row.eventType === "workspace_project_assignees_changed") {
        // Allow-list projection: display names only — no `projectId`, no uids.
        const toName = (u: string) => ({ displayName: targetNames.get(u) ?? UNKNOWN_AUDIT_TARGET_LABEL });
        const repair = row.addedUids.length === 0 && row.removedUids.length === 0;
        return { eventType: row.eventType, occurredAt: row.occurredAtIso, actor, project: { name: row.projectName }, added: row.addedUids.map(toName), removed: row.removedUids.map(toName), repair };
      }
      if (row.eventType === "workspace_research_assignee_changed") {
        // Allow-list projection: nullable name snapshot, question snapshot, nullable display names — no `projectId`, no `runId`, no uids.
        const toName = (u: string | null) => (u === null ? null : { displayName: targetNames.get(u) ?? UNKNOWN_AUDIT_TARGET_LABEL });
        // `projectId` is NEVER surfaced: a filed run whose Project could not
        // be snapshotted projects as `{ unavailable: true }`, never as Unfiled.
        const project: WorkspaceAuditResearchProjectRef = row.projectName !== null ? { name: row.projectName } : row.projectId !== null ? { unavailable: true } : null;
        return {
          eventType: row.eventType,
          occurredAt: row.occurredAtIso,
          actor,
          project,
          research: { question: row.runQuestion },
          previousAssignee: toName(row.previousAssigneeUid),
          assignee: toName(row.assigneeUid),
          repair: row.previousAssigneeUid === row.assigneeUid,
        };
      }
      const base = {
        occurredAt: row.occurredAtIso,
        actor,
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
