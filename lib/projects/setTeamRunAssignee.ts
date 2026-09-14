/**
 * Project/Research Assignment — `setTeamRunAssignee()`, the ONE primitive
 * that sets or clears a Team run's primary assignee. Structural sibling of
 * `associateTeamRunWithProject.ts` (same callback purity, same one-field
 * write discipline), with the AUTHORITATIVE ORDER frozen in the R0 brief
 * (§2.3 / §6.4), designed so the "same reviewer skips re-validation" defect
 * class is structurally impossible to copy:
 *
 *   0. Team target admission, then Project Assignment admission — before
 *      any Firestore access.
 *   1. `research.organize` via `authorizeTeamWorkspaceMutationInTransaction`.
 *   2. Canonical Team run read through `tx` + `validateTeamRunRowShape`
 *      (legacy / Personal / foreign ⇒ concealed `run_not_found`).
 *   3. `expectedAssigneeUid` compared with the NORMALIZED current assignee
 *      (`normalizeStoredAssigneeUid`); mismatch ⇒ `conflict`. A malformed
 *      stored value normalizes to `null`, so an authorized caller sending
 *      `expectedAssigneeUid: null` repairs it — no unrecoverable loop.
 *   4. When the requested assignee is non-null: transaction-read that
 *      membership, bind it, require `status === "active"` and a role that
 *      currently holds `research.create` (D2). THIS RUNS EVEN WHEN THE
 *      REQUESTED ASSIGNEE EQUALS THE CURRENT ASSIGNEE (D4).
 *   5. Only after validation: semantic no-op determination. Equal ⇒
 *      `unchanged`: zero writes, zero events (D6).
 *   6. Real change: Project metadata for the audit event read through the
 *      same `tx` BEFORE the first write (Unfiled ⇒ `null`/`null`; a
 *      missing/malformed/foreign Project ⇒ stored `projectId`,
 *      `projectName: null`, a logged warning, and NO distinguishable
 *      result — assignment must not become a Project existence oracle).
 *   7. Writes, together: `tx.update(runRef, {assigneeUid})` — exactly one
 *      field, no `updatedAt`, no mirrors — and the
 *      `workspace_research_assignee_changed` event via `tx.set()`.
 *
 * ASSIGNMENT IS NOT AUTHORIZATION: `run.userId` and `assigneeUid` are never
 * read for authorization; only current membership/capability is. Zero
 * quota, zero seat, zero model interaction.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS, PROJECT_ASSIGNMENT_ENABLED, PROJECT_ASSIGNMENT_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { resolveProjectAssignmentAdmission } from "@/lib/workspaces/projectAssignmentRollout";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { validateMembershipBinding } from "@/lib/workspaces/membershipBinding";
import { isEligibleAssignmentTarget } from "@/lib/workspaces/assignmentTargetEligibility";
import { isValidAssigneeUidShape, normalizeStoredAssigneeUid } from "@/lib/workspaces/assignmentNormalization";
import { buildWorkspaceMembershipEventDocData } from "@/lib/workspaces/workspaceMembershipEvents";
import { isWellFormedProjectV1 } from "./types";

export type SetTeamRunAssigneeResult =
  | { status: "assigned"; runId: string; workspaceId: string; previousAssigneeUid: string | null; assigneeUid: string | null }
  | { status: "unchanged"; runId: string; workspaceId: string; assigneeUid: string | null }
  | { status: "team_workspaces_disabled" }
  | { status: "project_assignment_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "run_not_found" }
  | { status: "conflict" }
  | { status: "assignee_not_eligible" }
  | { status: "transaction_failed" };

const RUN_QUESTION_FALLBACK = "Untitled research";

/** The established sanitized, fail-safe string posture: a non-string or blank question yields the fixed fallback, never a crash, never a request-body value. */
function safeRunQuestion(raw: unknown): string {
  if (typeof raw !== "string") return RUN_QUESTION_FALLBACK;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : RUN_QUESTION_FALLBACK;
}

export async function setTeamRunAssignee(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  assigneeUid: string | null;
  expectedAssigneeUid: string | null;
}): Promise<SetTeamRunAssigneeResult> {
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
  const assignmentAdmission = resolveProjectAssignmentAdmission({ uid: args.uid, globalEnabled: PROJECT_ASSIGNMENT_ENABLED, canaryUidsRaw: PROJECT_ASSIGNMENT_CANARY_UIDS });
  if (!assignmentAdmission.admitted) {
    return { status: "project_assignment_disabled" };
  }
  // A requested assignee that is not even uid-shaped can never be a member;
  // concealed as the same one-shape ineligibility, with no Firestore read.
  if (args.assigneeUid !== null && !isValidAssigneeUidShape(args.assigneeUid)) {
    return { status: "assignee_not_eligible" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  let result: SetTeamRunAssigneeResult;
  try {
    result = await adminDb.runTransaction<SetTeamRunAssigneeResult>(async (tx) => {
      // 1. Authorization, re-derived inside THIS transaction.
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.organize",
      });
      if (!auth.ok) {
        return { status: "unauthorized", reason: auth.reason };
      }

      // 2. The run, read fresh through this transaction, bound to this Workspace.
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) {
        return { status: "run_not_found" };
      }
      const runData = runSnap.data() as Record<string, unknown>;
      const validated = validateTeamRunRowShape(runData, args.workspaceId);
      if (!validated.ok) {
        return { status: "run_not_found" };
      }

      // 3. Expected-state OCC against the NORMALIZED current value.
      const current = normalizeStoredAssigneeUid(runData.assigneeUid);
      if (current.malformed) {
        logger.warn("[projects/setTeamRunAssignee] Malformed stored assigneeUid normalized to null (integrity anomaly)", { workspaceId: args.workspaceId, runId: args.runId });
      }
      if (current.uid !== args.expectedAssigneeUid) {
        return { status: "conflict" };
      }

      // 4. Target validation — ALWAYS, including a same-value repeat.
      if (args.assigneeUid !== null) {
        const membershipSnap = await tx.get(adminDb!.collection("workspaceMemberships").doc(computeMembershipId(args.workspaceId, args.assigneeUid)));
        const membership = membershipSnap.exists ? validateMembershipBinding(membershipSnap.data(), { workspaceId: args.workspaceId, uid: args.assigneeUid }) : null;
        if (!isEligibleAssignmentTarget("run", membership)) {
          return { status: "assignee_not_eligible" };
        }
      }

      // 5. Semantic no-op — only now.
      if (current.uid === args.assigneeUid && !current.malformed) {
        return { status: "unchanged", runId: args.runId, workspaceId: args.workspaceId, assigneeUid: current.uid };
      }

      // 6. Project metadata for the audit event — transaction-consistent, before the first write.
      let projectName: string | null = null;
      if (validated.projectId !== null) {
        const projectSnap = await tx.get(adminDb!.collection("projects").doc(validated.projectId));
        const projectData = projectSnap.exists ? projectSnap.data() : undefined;
        if (isWellFormedProjectV1(projectData) && projectData.id === validated.projectId && projectData.workspaceId === args.workspaceId) {
          projectName = projectData.name;
        } else {
          logger.warn("[projects/setTeamRunAssignee] Run references a Project that is missing, malformed, or foreign — audit event carries projectName: null", { workspaceId: args.workspaceId, runId: args.runId });
        }
      }

      // 7. Writes, together.
      const now = Timestamp.now();
      tx.update(runRef, { assigneeUid: args.assigneeUid });
      const eventRef = adminDb!.collection("workspaceMembershipEvents").doc();
      tx.set(
        eventRef,
        buildWorkspaceMembershipEventDocData({
          eventType: "workspace_research_assignee_changed",
          actorUid: auth.membership.uid,
          workspaceId: args.workspaceId,
          projectId: validated.projectId,
          projectName,
          runId: args.runId,
          runQuestion: safeRunQuestion(runData.question),
          previousAssigneeUid: current.uid,
          assigneeUid: args.assigneeUid,
          at: now,
        })
      );

      return { status: "assigned", runId: args.runId, workspaceId: args.workspaceId, previousAssigneeUid: current.uid, assigneeUid: args.assigneeUid };
    });
  } catch (err) {
    // Logged exactly once, outside the (potentially internally-retried) callback.
    logger.warn("[projects/setTeamRunAssignee] Transaction failed", {
      workspaceId: args.workspaceId,
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "transaction_failed" };
  }

  return result;
}
