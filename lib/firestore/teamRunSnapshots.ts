/**
 * ADD-TO-TEAM-PROJECT — `createTeamRunSnapshotFromPersonal()`, the ONE
 * Firestore primitive that copies a member's own Personal research run
 * into a Team Project as a new, Team-owned run. Deliberately a sibling of
 * `teamWorkspaceRuns.ts` (the native Team run creator) rather than an
 * addition to it: that module's contract is "allocate, authorize, create a
 * RUNNING run for the execution engine to complete"; this one creates a
 * COMPLETE run from persisted content and never runs a model.
 *
 * COPY, NEVER MOVE. The source `runs/{sourceRunId}` is read once through
 * the transaction and never written — no `promotedTo`, no `updatedAt`,
 * nothing. The destination gets a fresh `run-${randomUUID()}` id, the
 * promoter's uid as `userId` (which is necessarily the source owner's uid,
 * see the source predicate), the target `workspaceId`/`projectId`, fresh
 * Team timestamps, the copied research content, and an immutable `origin`
 * pointing at the source — ALL inside one `tx.create()`.
 *
 * READ/VALIDATE/WRITE ORDER inside the ONE transaction (all reads before
 * any write — a Firestore requirement and the reason the idempotency lock
 * is READ, never created-and-recovered):
 *   1. `authorizeTeamWorkspaceMutationInTransaction()` for `research.create`.
 *   2. `research.organize` from the SAME returned membership (a snapshot is
 *      always filed into a Project — Unfiled is not offered, because the
 *      Team UI has no detail route for an Unfiled run).
 *   3. `projects/{projectId}`: exists, well-formed, `id` match,
 *      `workspaceId === args.workspaceId`, `status === "active"`.
 *   4. `runs/{sourceRunId}`: exists; binding shape is `legacy` or `personal`
 *      (classified BEFORE any owner comparison — a Team-bound or invalid
 *      source can never satisfy Personal ownership); for a `personal`
 *      binding the deterministic Personal Workspace is read through the
 *      same transaction and must be the caller's own; then
 *      `userId === args.uid`; then `status === "complete"`. Every failure is
 *      the same concealed `source_not_found`.
 *   5. `runSnapshotLocks/{lockId}` (deterministic, canonical-tuple hash).
 *      Present → validate the lock, read the run it names, validate that
 *      run is structurally THIS snapshot (workspace, project, `origin`).
 *      Valid → `already_exists`, zero writes. Malformed/mismatched →
 *      `integrity_failure`, zero writes, never repaired, never an arbitrary
 *      id returned.
 *   6. Build the COMPLETE payload (content + `origin` + fresh governance
 *      record when the source is adaptive) and enforce the repository's
 *      total-document budget. Over budget → `snapshot_too_large`, nothing
 *      written, nothing truncated.
 *   7. Writes, all-or-nothing: `tx.create(run)`, `tx.create(lock)`,
 *      `tx.set(workspaceMembershipEvents/{auto})` — SNAPSHOT COMMITTED IFF
 *      LOCK COMMITTED IFF AUDIT EVENT COMMITTED.
 *
 * NEVER COPIED: `governanceRecord`, `governanceStatus`, `teamGovernance`,
 * `adaptiveExportCounter`, and every subcollection (review assignment /
 * panel / votes / history, governance events, exports). A Personal policy
 * verdict does not cross the Workspace boundary. For an adaptive source a
 * FRESH `governanceRecord` (`humanReview.status = "unreviewed"`, the NEW
 * run id) is built by the pure `buildAdaptiveGovernanceRecord()` and
 * embedded in the same create — never a post-commit merge write.
 *
 * ZERO QUOTA. No inference-quota writer, no model, classifier, router, or
 * synthesis call. Copied token fields are historical attribution.
 */

import "server-only";
import { randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS, WORKSPACES_ENABLED } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { roleHasCapability } from "@/lib/workspaces/capabilities";
import { isWellFormedProjectV1 } from "@/lib/projects/types";
import { isWellFormedWorkspaceV1 } from "@/lib/workspaces/types";
import { classifyRunWorkspaceBindingShape } from "@/lib/workspaces/classifyRunWorkspaceBindingShape";
import { buildWorkspaceMembershipEventDocData } from "@/lib/workspaces/workspaceMembershipEvents";
import { RUN_SNAPSHOT_LOCK_COLLECTION, RUN_SNAPSHOT_LOCK_VERSION, computeRunSnapshotLockId, validateRunSnapshotLock } from "@/lib/workspaces/runSnapshotLock";
import { buildPersonalResearchSnapshotOrigin, isWellFormedPersonalResearchSnapshotOrigin } from "@/lib/workspaces/personalResearchSnapshotOrigin";
import { buildAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordBuilder";
import type { PersistedAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import { estimateDocumentSize, MAX_TOTAL_DOC_SIZE } from "@/lib/panel/sanitizeText";

export type CreateTeamRunSnapshotResult =
  | { status: "created"; runId: string; workspaceId: string; projectId: string }
  | { status: "already_exists"; runId: string; workspaceId: string; projectId: string }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "project_not_found" }
  | { status: "project_archived" }
  | { status: "source_not_found" }
  | { status: "snapshot_too_large" }
  | { status: "integrity_failure" }
  | { status: "transaction_failed" };

/**
 * Source fields copied VERBATIM (same object references — the source data
 * is never mutated and never deep-cloned, which would strip Firestore
 * `Timestamp` prototypes). Each is copied only when present on the source.
 */
const COPIED_CONTENT_FIELDS = ["selectedModels", "tokenUsage", "totalTokens", "tokensByModel", "tokensByProvider", "adaptiveOutput", "legacyAdaptiveOutput"] as const;

/** The synthesis cache written by `POST /api/synthesize-panel`; copied as a unit only when the report itself is present at the schema version readers accept. */
const SYNTHESIS_FIELDS = ["synthesizedStructuredReport", "schemaVersion", "synthesizedAt", "synthesizedBy", "synthesisInputHash", "synthesisConsensusSummary", "synthesisConsensusAudit", "synthesisMetadata"] as const;

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SnapshotBuildResult = { ok: true; payload: Record<string, unknown> } | { ok: false };

/**
 * Pure. Builds the complete destination document from an already-validated
 * source. Returns `ok: false` only when the source carries nothing worth
 * snapshotting (no `runDocument` and no legacy `results`) — concealed by
 * the caller as `source_not_found`.
 */
export function buildTeamRunSnapshotPayload(args: {
  source: Record<string, unknown>;
  sourceRunId: string;
  newRunId: string;
  uid: string;
  workspaceId: string;
  projectId: string;
  now: Timestamp;
  nowIso: string;
}): SnapshotBuildResult {
  const { source } = args;

  const question = typeof source.question === "string" ? source.question : "";
  if (question.length === 0) return { ok: false };

  const origin = buildPersonalResearchSnapshotOrigin({
    sourceRunId: args.sourceRunId,
    sourceCreatedAt: source.createdAt,
    sourceCompletedAt: source.completedAt,
  });
  if (!origin) return { ok: false };

  const payload: Record<string, unknown> = {
    userId: args.uid,
    workspaceId: args.workspaceId,
    // ALWAYS present — `validateTeamRunRowShape()` fails a Team row closed without it.
    projectId: args.projectId,
    question,
    status: "complete",
    createdAt: args.now,
    completedAt: args.now,
  };

  let hasContent = false;
  if (isPlainObject(source.runDocument)) {
    // Shallow copy with the embedded identity rewritten to the DESTINATION —
    // the source object itself is left untouched.
    payload.runDocument = { ...source.runDocument, runId: args.newRunId, userId: args.uid };
    hasContent = true;
  }
  if (Array.isArray(source.results)) {
    // Legacy pre-`runDocument` result format — copied so an older complete
    // run still renders through the same fallback readers already use.
    payload.results = source.results;
    hasContent = true;
  }
  if (!hasContent) return { ok: false };

  for (const field of COPIED_CONTENT_FIELDS) {
    if (hasOwn(source, field) && source[field] !== undefined) payload[field] = source[field];
  }
  if (hasOwn(source, "synthesizedStructuredReport") && source.synthesizedStructuredReport && source.schemaVersion === 1) {
    for (const field of SYNTHESIS_FIELDS) {
      if (hasOwn(source, field) && source[field] !== undefined) payload[field] = source[field];
    }
  }

  payload.origin = origin;

  if (hasOwn(source, "adaptiveOutput") && source.adaptiveOutput !== undefined) {
    const built = buildAdaptiveGovernanceRecord({
      runId: args.newRunId,
      adaptiveOutput: source.adaptiveOutput as PersistedAdaptiveOutputV1,
      now: args.nowIso,
    });
    if (built.ok) {
      payload.governanceRecord = built.record;
    }
    // Not applicable (unparseable adaptive output) → no record, exactly as
    // a native Team run whose adaptive output could not be persisted.
  }

  return { ok: true, payload };
}

export async function createTeamRunSnapshotFromPersonal(args: {
  uid: string;
  workspaceId: string;
  projectId: string;
  sourceRunId: string;
}): Promise<CreateTeamRunSnapshotResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  // Allocated once, before runTransaction() — never regenerated on a
  // Firestore-internal retry. The lock, not the run id, carries idempotency.
  const newRunId = `run-${randomUUID()}`;
  const newRunRef = adminDb.collection("runs").doc(newRunId);
  const lockId = computeRunSnapshotLockId({ sourceRunId: args.sourceRunId, workspaceId: args.workspaceId, projectId: args.projectId });
  const lockRef = adminDb.collection(RUN_SNAPSHOT_LOCK_COLLECTION).doc(lockId);
  const sourceRef = adminDb.collection("runs").doc(args.sourceRunId);
  const projectRef = adminDb.collection("projects").doc(args.projectId);

  type TxResult =
    | { kind: "created" }
    | { kind: "already_exists"; runId: string }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "project_not_found" }
    | { kind: "project_archived" }
    | { kind: "source_not_found" }
    | { kind: "snapshot_too_large" }
    | { kind: "integrity_failure" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      // 1. Destination authorization — re-derived inside THIS transaction.
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.create",
      });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }
      // 2. Filing into a Project needs research.organize from the SAME membership.
      if (!roleHasCapability(auth.membership.role, "research.organize")) {
        return { kind: "unauthorized", reason: "insufficient_capability" };
      }

      // 3. Target Project — same transaction handle, same containment rules
      // as native Team run creation.
      const projectSnap = await tx.get(projectRef);
      if (!projectSnap.exists) {
        return { kind: "project_not_found" };
      }
      const projectData = projectSnap.data();
      if (!isWellFormedProjectV1(projectData) || projectData.id !== args.projectId || projectData.workspaceId !== args.workspaceId) {
        return { kind: "project_not_found" };
      }
      if (projectData.status !== "active") {
        return { kind: "project_archived" };
      }

      // 4. Source — shape BEFORE owner, owner BEFORE status; one concealed outcome.
      const sourceSnap = await tx.get(sourceRef);
      if (!sourceSnap.exists) {
        return { kind: "source_not_found" };
      }
      const source = sourceSnap.data() as Record<string, unknown> | undefined;
      if (!source) {
        return { kind: "source_not_found" };
      }
      const shape = classifyRunWorkspaceBindingShape({
        hasWorkspaceIdField: hasOwn(source, "workspaceId"),
        workspaceIdValue: source.workspaceId,
        userId: source.userId,
      });
      if (shape.kind !== "legacy" && shape.kind !== "personal") {
        // Team-bound (`non_personal_bound`) or invalid — never Personal-owned.
        return { kind: "source_not_found" };
      }
      if (shape.kind === "personal") {
        // A bound Personal run is only readable when the binding resolves
        // (mirrors GET /api/user/runs/[runId]'s integrity posture): the
        // Workspace flag must honor bindings, and the deterministic
        // Personal Workspace must exist, be well-formed, be personal, and
        // be owned by the caller.
        if (!WORKSPACES_ENABLED) {
          return { kind: "source_not_found" };
        }
        const wsSnap = await tx.get(adminDb!.collection("workspaces").doc(shape.workspaceId));
        const ws = wsSnap.exists ? wsSnap.data() : undefined;
        if (!isWellFormedWorkspaceV1(ws) || ws.id !== shape.workspaceId || ws.type !== "personal" || ws.ownerUserId !== args.uid) {
          return { kind: "source_not_found" };
        }
      }
      if (typeof source.userId !== "string" || source.userId !== args.uid) {
        return { kind: "source_not_found" };
      }
      if (source.status !== "complete") {
        return { kind: "source_not_found" };
      }

      // 5. Idempotency lock — READ in the read phase, before any write.
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists) {
        const validated = validateRunSnapshotLock(lockSnap.data(), {
          sourceRunId: args.sourceRunId,
          workspaceId: args.workspaceId,
          projectId: args.projectId,
        });
        if (!validated.ok) {
          logger.error("[firestore/teamRunSnapshots] Snapshot lock exists but is corrupt — failing closed, no repair", {
            workspaceId: args.workspaceId,
            projectId: args.projectId,
            reason: validated.reason,
          });
          return { kind: "integrity_failure" };
        }
        const existingSnap = await tx.get(adminDb!.collection("runs").doc(validated.lock.snapshotRunId));
        const existing = existingSnap.exists ? (existingSnap.data() as Record<string, unknown> | undefined) : undefined;
        const existingIsThisSnapshot =
          !!existing &&
          existing.workspaceId === args.workspaceId &&
          existing.projectId === args.projectId &&
          isWellFormedPersonalResearchSnapshotOrigin(existing.origin, args.sourceRunId);
        if (!existingIsThisSnapshot) {
          logger.error("[firestore/teamRunSnapshots] Snapshot lock names a run that is missing or is not this snapshot — failing closed, no repair", {
            workspaceId: args.workspaceId,
            projectId: args.projectId,
          });
          return { kind: "integrity_failure" };
        }
        return { kind: "already_exists", runId: validated.lock.snapshotRunId };
      }

      // 6. Build the COMPLETE destination document, then budget-check it.
      const now = Timestamp.now();
      const built = buildTeamRunSnapshotPayload({
        source,
        sourceRunId: args.sourceRunId,
        newRunId,
        uid: args.uid,
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        now,
        nowIso: now.toDate().toISOString(),
      });
      if (!built.ok) {
        return { kind: "source_not_found" };
      }
      if (estimateDocumentSize(built.payload) > MAX_TOTAL_DOC_SIZE) {
        return { kind: "snapshot_too_large" };
      }

      // 7. Writes — all buffered in this SAME transaction attempt.
      tx.create(newRunRef, built.payload);
      tx.create(lockRef, {
        version: RUN_SNAPSHOT_LOCK_VERSION,
        sourceRunId: args.sourceRunId,
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        snapshotRunId: newRunId,
        createdBy: args.uid,
        createdAt: now,
      });
      const eventRef = adminDb!.collection("workspaceMembershipEvents").doc();
      tx.set(
        eventRef,
        buildWorkspaceMembershipEventDocData({
          eventType: "workspace_research_snapshot_created",
          actorUid: auth.membership.uid,
          workspaceId: projectData.workspaceId,
          projectId: projectData.id,
          projectName: projectData.name,
          runId: newRunId,
          runQuestion: built.payload.question as string,
          at: now,
        })
      );
      return { kind: "created" };
    });
  } catch (err: unknown) {
    // The TRANSACTION ITSELF failed (including a run-id or lock-id
    // collision on tx.create() — the lock was read as absent moments
    // earlier, so a concurrent same-tuple request racing us fails here and
    // its caller retries into the now-present lock) — nothing committed.
    logger.warn("[firestore/teamRunSnapshots] Team run snapshot transaction failed — nothing was created", {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "transaction_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "project_not_found":
      return { status: "project_not_found" };
    case "project_archived":
      return { status: "project_archived" };
    case "source_not_found":
      return { status: "source_not_found" };
    case "snapshot_too_large":
      return { status: "snapshot_too_large" };
    case "integrity_failure":
      return { status: "integrity_failure" };
    case "already_exists":
      return { status: "already_exists", runId: txResult.runId, workspaceId: args.workspaceId, projectId: args.projectId };
    case "created":
      return { status: "created", runId: newRunId, workspaceId: args.workspaceId, projectId: args.projectId };
  }
}
