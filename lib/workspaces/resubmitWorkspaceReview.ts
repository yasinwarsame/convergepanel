/**
 * Phase 9B.3 — the ONE transactional primitive for the single genuinely
 * missing adaptive Deep Research governance transition:
 * `changes_requested -> unreviewed`, for a WORKSPACE_BOUND_TEAM run.
 *
 * Deliberately built as a single self-contained transaction function in its
 * own file — mirroring `lib/projects/associateTeamRunWithProject.ts`'s own
 * precedent — rather than another export bolted onto `lib/firestore/runs.ts`,
 * since this reuses the Workspace-authorization transaction pattern that
 * file established, not the legacy Team decision-route pattern.
 *
 * SCOPE: resubmission is NOT a review decision, NOT an assignment mutation,
 * and NOT a panel mutation. It only ever:
 *   1. re-authorizes the caller (creator-with-current-access, OR a Workspace
 *      manager via `reviews.manage`) fresh, inside this transaction;
 *   2. flips `governanceRecord.humanReview` from `changes_requested` back to
 *      a clean `unreviewed` state (clearing every stale decision-specific
 *      field by construction — `applyHumanReviewUpdate` always builds a
 *      brand-new `humanReview` object, never merges);
 *   3. appends one immutable `review_resubmitted` `governanceEvents` entry,
 *      in the SAME transaction as the canonical write (a stronger guarantee
 *      than the existing single-reviewer decision flow's own best-effort,
 *      post-commit `governanceEvents` write — deliberately so here, since
 *      Phase 9B.3 wants this evidence durable in exactly the same commit as
 *      the state transition it documents);
 *   4. re-derives (never persists) whether the CURRENT `humanReviewAssignment/
 *      current` document, if any, remains actionable under TODAY's Workspace
 *      membership/capability state — reusing Phase 9B.1's
 *      `isValidAssignmentTarget()` verbatim, never a stored eligibility
 *      snapshot from assignment time.
 *
 * It NEVER writes to `humanReviewAssignment/current` or `humanReviewPanel/
 * current` — assignment/panel documents are read-only from this function's
 * perspective (existence and — for the assignment only — its assignee's
 * CURRENT eligibility). No assignment revision bump, no assignment history,
 * no panel touch of any kind.
 *
 * PANEL/VOTE SAFETY (Phase 9B.3 spec §23/§24 — the mandatory hard-stop
 * analysis): audited directly against `lib/firestore/runs.ts` before writing
 * a single line here. A panel that reached `changes_requested` via
 * finalization/override is ALREADY `status: "finalized"` with its revision
 * already incremented past every vote's `panelRevision` — and BOTH existing
 * write paths independently refuse to touch it further:
 *   - `submitAdaptiveHumanReviewPanel()` (create/reconfigure) explicitly
 *     rejects any `current.status === "finalized"` panel with
 *     `panel_finalized`, unconditionally — there is no code path anywhere
 *     in this codebase that can move a finalized panel back to `"open"`.
 *   - `submitAdaptiveReviewVote()` requires `panel.status === "open"` before
 *     accepting any vote at all (`lib/firestore/runs.ts`, vote-submission
 *     transaction) — a finalized panel can never receive a new vote.
 *   - Vote documents are permanently keyed `r{panelRevision}:{reviewerUid}`
 *     (`buildAdaptiveHumanReviewVoteId`), and EVERY panel mutation in this
 *     codebase (reconfigure/cancel/finalize/override) increments `revision`
 *     unconditionally — so even a hypothetical FUTURE "reopen a finalized
 *     panel" mechanism would, by this codebase's own universal convention,
 *     necessarily mint a new, higher revision, making prior votes
 *     structurally unreachable by any query scoped to the new revision.
 * Net result: this phase requires ZERO panel/vote code changes to guarantee
 * safety — the guarantee already exists, enforced by code this function
 * never needs to touch. A future phase that wants to let a team re-run PANEL
 * review after resubmission must explicitly design a "reopen" mutation (new
 * scope, not 9B.3) — until then, the only review path available after a
 * panel-driven `changes_requested` resubmission is the single-reviewer
 * decision route, which is safe today with no changes.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "./teamWorkspacesRollout";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "./authorizeTeamWorkspaceMutationInTransaction";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { isValidAssignmentTarget, type WorkspaceReviewCandidate } from "./workspaceReviewEligibility";
import { roleHasCapability } from "./capabilities";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { parseGovernanceRecord, applyHumanReviewUpdate } from "@/lib/adaptiveSchema/governanceRecordParser";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";

export type ResubmitWorkspaceReviewFailureReason =
  | "team_workspaces_disabled"
  | "firestore_unavailable"
  | TeamMutationAuthorizationDenialReason
  /** Concealed — covers: run missing, not Workspace-bound, bound to a different Workspace, bound to a Personal Workspace, or malformed run-shape fields. Never distinguished externally, matching `associateTeamRunWithProject()`'s own established `run_not_found` concealment discipline. */
  | "run_not_found"
  | "governance_record_absent"
  | "governance_record_malformed"
  | "unsupported_version"
  /** Caller is neither the run's canonical creator (with current access) nor a Workspace manager (`reviews.manage`). */
  | "not_creator_or_manager"
  | "stale_expected_updated_at"
  | "not_changes_requested"
  | "write_failed";

export type ResubmitWorkspaceReviewResult =
  | {
      ok: true;
      record: GovernanceRecordV1;
      /**
       * `null` = no `humanReviewAssignment/current` document exists at all.
       * `true`/`false` = re-derived FRESH, right now, from the assignee's
       * CURRENT Workspace membership/capability/self-review state — never a
       * stored eligibility snapshot. NEVER persisted anywhere by this
       * function; a future queue/read layer must derive it the same way,
       * on demand, every time.
       */
      assignmentActionable: boolean | null;
    }
  | { ok: false; reason: ResubmitWorkspaceReviewFailureReason };

export async function resubmitWorkspaceReview(args: {
  uid: string;
  workspaceId: string;
  runId: string;
  /** OCC token — must equal the CURRENT `governanceRecord.updatedAt`, exactly like `submitAdaptiveHumanReview()`'s own `expectedUpdatedAt` contract. */
  expectedUpdatedAt: string;
  now?: string;
}): Promise<ResubmitWorkspaceReviewResult> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { ok: false, reason: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { ok: false, reason: "firestore_unavailable" };
  }

  const now = args.now ?? new Date().toISOString();

  let result: ResubmitWorkspaceReviewResult;
  try {
    result = await adminDb.runTransaction<ResubmitWorkspaceReviewResult>(async (tx) => {
      // ---- Reads, step 1: Workspace-authorization gate. `research.read` is
      // the lowest-common-denominator capability BOTH the creator and
      // manager paths need — every active role holds it, so this call's
      // job is purely to fetch+validate Workspace/membership integrity
      // (never to fully decide authorization on its own); the actual
      // creator-OR-manager business rule is applied below, once the run's
      // canonical creator is known. ----
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.read",
      });
      if (!auth.ok) {
        return { ok: false, reason: auth.reason };
      }

      // ---- Reads, step 2: the run itself, read fresh through this
      // transaction — never a route-level snapshot. ----
      const runRef = adminDb!.collection("runs").doc(args.runId);
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) {
        return { ok: false, reason: "run_not_found" };
      }
      const runData = runSnap.data() as Record<string, unknown>;

      const target = resolveWorkspaceReviewTarget({
        requestedWorkspaceId: args.workspaceId,
        hasWorkspaceIdField: "workspaceId" in runData,
        workspaceIdValue: runData.workspaceId,
        userId: runData.userId,
        hasProjectIdField: "projectId" in runData,
        projectIdValue: runData.projectId,
      });
      if (target.kind !== "valid_workspace_review_target") {
        // not_workspace_bound / not_team_workspace / wrong_workspace /
        // invalid_run all collapse to the same concealed result — never
        // opportunistically repaired, never distinguished externally.
        return { ok: false, reason: "run_not_found" };
      }

      // ---- Reads, step 3: canonical governance record. ----
      const parseResult = parseGovernanceRecord(runData.governanceRecord);
      if (!parseResult.ok) {
        if (parseResult.reason === "absent") return { ok: false, reason: "governance_record_absent" };
        if (parseResult.reason === "unsupported_version") return { ok: false, reason: "unsupported_version" };
        return { ok: false, reason: "governance_record_malformed" };
      }
      const record = parseResult.record;

      // ---- Authorization decision: creator (with current access, already
      // proven by the successful `research.read` gate above) OR manager
      // (`reviews.manage`). Resubmission is not a review action, so
      // `reviews.submit` plays no role here. ----
      const isCreator = args.uid === target.creatorUid;
      const isManager = roleHasCapability(auth.membership.role, "reviews.manage");
      if (!isCreator && !isManager) {
        return { ok: false, reason: "not_creator_or_manager" };
      }

      // ---- OCC — checked BEFORE the status check, matching
      // `submitAdaptiveHumanReview()`'s own established ordering (a stale-data
      // error must never be masked by a terminal-status error the caller's
      // UI hasn't even seen yet). ----
      if (record.updatedAt !== args.expectedUpdatedAt) {
        return { ok: false, reason: "stale_expected_updated_at" };
      }

      // ---- The ONE transition this function exists for. Denies every
      // other status uniformly — approved/approved_with_conditions/
      // rejected/unreviewed/pending all fail here identically; no new
      // "pending" transition is revived. ----
      if (record.humanReview.status !== "changes_requested") {
        return { ok: false, reason: "not_changes_requested" };
      }

      // ---- Reads, step 4: current assignment projection, if any — read
      // ONLY, to re-derive (never persist) actionability. Still a READ,
      // still happens before any write below (Phase 9B.2-R1's own lesson:
      // every transaction read must precede every transaction write). ----
      const assignmentRef = runRef.collection("humanReviewAssignment").doc("current");
      const assignmentSnap = await tx.get(assignmentRef);
      let assignmentActionable: boolean | null = null;
      if (assignmentSnap.exists) {
        const assignment = assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1 | undefined;
        const assignedReviewerUserId = assignment?.assignedReviewerUserId;
        if (typeof assignedReviewerUserId !== "string" || assignedReviewerUserId.length === 0) {
          // Unassigned (or malformed) assignment document — nothing to
          // re-derive eligibility FOR. Fail-safe: non-actionable, never
          // trusted as if it named a real, live reviewer.
          assignmentActionable = false;
        } else {
          const assigneeMembershipId = computeMembershipId(args.workspaceId, assignedReviewerUserId);
          const assigneeSnap = await tx.get(adminDb!.collection("workspaceMemberships").doc(assigneeMembershipId));
          const assigneeMembership = assigneeSnap.exists
            ? validateMembershipBinding(assigneeSnap.data(), { workspaceId: args.workspaceId, uid: assignedReviewerUserId })
            : null;
          const candidate: WorkspaceReviewCandidate | null = assigneeMembership
            ? { uid: assigneeMembership.uid, workspaceId: assigneeMembership.workspaceId, role: assigneeMembership.role, status: assigneeMembership.status }
            : null;
          const eligibility = isValidAssignmentTarget({ candidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid });
          assignmentActionable = eligibility.eligible;
        }
      }

      // ---- Writes — every read above has already completed. ----
      const updateResult = applyHumanReviewUpdate(record, { status: "unreviewed" }, now);
      if (!updateResult.ok) {
        // Structurally unreachable ("unreviewed" is always a valid status
        // with no required fields) — kept as an explicit, typed fail-closed
        // branch rather than a non-null assertion.
        logger.warn("[workspaces/resubmitWorkspaceReview] applyHumanReviewUpdate unexpectedly rejected the unreviewed transition", {
          runId: args.runId,
          reason: updateResult.reason,
        });
        return { ok: false, reason: "write_failed" };
      }

      tx.update(runRef, {
        "governanceRecord.humanReview": updateResult.record.humanReview,
        "governanceRecord.updatedAt": now,
      });

      // Same generic `governanceEvents` sink the existing decision/finalization
      // flows already write to, auto-generated id (matching
      // `writeAdaptiveHumanReviewEvent()`'s own `.add()`-equivalent
      // convention for this collection) — but written INSIDE this
      // transaction, atomically with the canonical write, a stronger
      // guarantee than that best-effort post-commit precedent. Duplicate
      // events on a stale retry are impossible by construction: a retry
      // reusing the old `expectedUpdatedAt` fails the OCC check above,
      // before this write is ever reached — no deterministic event id is
      // needed for that guarantee here.
      const eventRef = runRef.collection("governanceEvents").doc();
      tx.set(eventRef, {
        action: "review_resubmitted",
        byUid: args.uid,
        at: now,
        // No `teamId` — this is a pure Workspace-native event (no legacy
        // Team concept applies on this path at all), unlike
        // `writeAdaptiveHumanReviewEvent()`'s own `teamId` field, which
        // exists for the legacy Team decision flow this function never
        // touches. `workspaceId`/`projectId` are metadata/projection only,
        // matching every other Phase 9B.2 discovery-metadata field —
        // `runs/{runId}` remains the sole authority for both.
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        schemaId: record.schemaId,
        answerShape: record.answerShape,
        prevStatus: "changes_requested",
        nextStatus: "unreviewed",
      });

      return { ok: true, record: updateResult.record, assignmentActionable };
    });
  } catch (err) {
    logger.warn("[workspaces/resubmitWorkspaceReview] Transaction failed", {
      workspaceId: args.workspaceId,
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "write_failed" };
  }

  return result;
}
