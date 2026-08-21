/**
 * Team Workspace Run Creation, Phase 8C-D — the canonical Firestore
 * creation primitive for a Team-Workspace-bound ordinary research run.
 * Deliberately a NEW, separate file from `lib/firestore/teamRuns.ts` —
 * that existing module belongs to the legacy adaptive-governance
 * team-review PROJECTION system (a different Firestore collection,
 * `teamRuns`, keyed by `teamId`+`runId` for an unrelated "team" concept —
 * see that file's own doc comment) and remains completely untouched by
 * Phase 8C-D. This module writes ONLY to the canonical `runs` collection —
 * the exact same collection `lib/firestore/runs.ts`'s `createRun()`
 * writes for Personal runs, and the exact collection
 * `lib/workspaces/listTeamWorkspaceRuns.ts` (B2) and `GET
 * /api/user/runs/[runId]` (B3) already query for Team-bound rows.
 *
 * Mirrors `lib/firestore/teamProjects.ts`'s established pattern: the
 * opaque run id is allocated once, before `runTransaction()`, and passed
 * unchanged into every Firestore-internal retry; the authorization
 * decision is re-derived from state read through the SAME transaction
 * handle as the write (`authorizeTeamWorkspaceMutationInTransaction()`);
 * and the initial write uses true `tx.create()` semantics (never `.set()`
 * or `.set(..., {merge:true})`), so a run-id collision fails the
 * transaction rather than silently overwriting an existing document.
 *
 * Unlike `createRun()` (Personal), which tolerates an entirely absent
 * `workspaceId`/`projectId` for legacy-compatibility reasons, a Team run's
 * `projectId` field is ALWAYS written — either `null` (canonical Unfiled)
 * or a validated Project id — never omitted. This is not a style
 * preference: `lib/workspaces/teamRunRowValidation.ts`'s
 * `validateTeamRunRowShape()`, already used unconditionally by the B2
 * list route and B3 detail classification, treats an ABSENT `projectId`
 * field identically to a malformed one and fails the row closed. Omitting
 * the field would make every freshly created Team run invisible/erroring
 * on those already-shipped endpoints.
 */

import "server-only";
import { randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { ModelId } from "@/lib/types";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { roleHasCapability } from "@/lib/workspaces/capabilities";
import { isWellFormedProjectV1 } from "@/lib/projects/types";

export type CreateTeamWorkspaceRunResult =
  | { status: "created"; runId: string; workspaceId: string; projectId: string | null }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "project_not_found" }
  | { status: "project_archived" }
  | { status: "transaction_failed" };

/**
 * `args.projectId` must already be normalized by the caller (route) to
 * exactly `string | null` — omitted/explicit-null request bodies both
 * normalize to `null` (canonical Unfiled) before this function is ever
 * called; a malformed/empty-string request value is rejected by the
 * route's own body validation and never reaches here (Phase 8C-D.0.2/0.3
 * Correction 5).
 *
 * Read/validate/write order inside the one transaction (mirrors
 * `createTeamProject()`'s frozen pattern, extended for the Project
 * placement steps Phase 8C-D.0.1/0.2 froze):
 *   1. `authorizeTeamWorkspaceMutationInTransaction()` for `research.create`
 *      — one membership read, always required.
 *   2. If `args.projectId !== null`, additionally require
 *      `research.organize` from the SAME already-returned membership — no
 *      second read, no second authorization-helper call.
 *   3. If `args.projectId !== null`, read `projects/{projectId}` through
 *      the same transaction handle and validate: well-formed,
 *      `id === projectId`, `workspaceId === args.workspaceId`,
 *      `status === "active"`.
 *   4. `tx.create()` the canonical `runs/{runId}` document.
 */
export async function createTeamWorkspaceRun(args: {
  uid: string;
  workspaceId: string;
  question: string;
  selectedModels: ModelId[];
  projectId: string | null;
}): Promise<CreateTeamWorkspaceRunResult> {
  const rollout = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  // Allocated once, before runTransaction() — never regenerated on a
  // Firestore-internal retry of the callback, exactly like
  // createTeamProject()'s own frozen id-allocation invariant.
  const runId = `run-${randomUUID()}`;
  const runRef = adminDb.collection("runs").doc(runId);

  type TxResult =
    | { kind: "created" }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "project_not_found" }
    | { kind: "project_archived" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, {
        uid: args.uid,
        workspaceId: args.workspaceId,
        requiredCapability: "research.create",
      });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      if (args.projectId !== null) {
        if (!roleHasCapability(auth.membership.role, "research.organize")) {
          return { kind: "unauthorized", reason: "insufficient_capability" };
        }

        const projectRef = adminDb!.collection("projects").doc(args.projectId);
        const projectSnap = await tx.get(projectRef);
        if (!projectSnap.exists) {
          return { kind: "project_not_found" };
        }
        const projectData = projectSnap.data();
        if (!isWellFormedProjectV1(projectData) || projectData.id !== args.projectId || projectData.workspaceId !== args.workspaceId) {
          // Malformed / embedded-id mismatch / foreign Workspace all
          // conceal identically to a genuinely missing Project — never a
          // distinguishable response that would act as an existence oracle.
          return { kind: "project_not_found" };
        }
        if (projectData.status !== "active") {
          return { kind: "project_archived" };
        }
      }

      const now = Timestamp.now();
      tx.create(runRef, {
        userId: args.uid,
        workspaceId: args.workspaceId,
        // ALWAYS present — see this module's header comment.
        projectId: args.projectId,
        question: args.question,
        selectedModels: args.selectedModels,
        status: "running",
        createdAt: now,
      });

      return { kind: "created" };
    });
  } catch (err: unknown) {
    // The TRANSACTION ITSELF failed (including a run-id collision on
    // tx.create() — a UUID-level edge case with no dedicated client-visible
    // signal, mapped through this same existing internal-error path rather
    // than inventing new collision semantics) — genuinely nothing committed.
    logger.warn("[firestore/teamWorkspaceRuns] Team run creation transaction failed — no run was created", {
      workspaceId: args.workspaceId,
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
    case "created":
      return { status: "created", runId, workspaceId: args.workspaceId, projectId: args.projectId };
  }
}
