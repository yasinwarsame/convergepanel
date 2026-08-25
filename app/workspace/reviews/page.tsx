/**
 * Approval Workflow, Phase 9C.1 (corrected 9C.1-R1C) — `GET /workspace/reviews`,
 * server-gated. The first Phase 9 frontend surface. Read-only: no
 * assignment, decision, panel, override, or resubmission control exists
 * anywhere behind this page in this phase.
 *
 * Eligibility is settled BEFORE any Reviews UI renders — never a
 * client-side flash-then-hide, matching `/workspace` and
 * `/workspace/projects`'s own established gating pattern.
 *
 * MULTI-WORKSPACE MODEL (Phase 9C.1-R1C — replaces a real defect, not a
 * design choice being revisited): the product supports a uid holding more
 * than one active Team Workspace membership (reachable today through
 * repeated `POST /api/workspaces` or Workspace-invitation acceptance —
 * both already merged, neither gated against a second membership). This
 * page therefore NEVER silently auto-selects among several — see
 * `resolveViewerTeamWorkspaceSelection()`'s `"none"/"single"/"multiple"`
 * discriminated result:
 *   - `"none"`: concealed `notFound()`.
 *   - `"single"`: unambiguous — that one Workspace is used directly.
 *   - `"multiple"`, no `?workspace=` param: renders
 *     `<WorkspaceReviewsChooser>`, an explicit selection UI. No queue
 *     data is fetched for any Workspace until the caller picks one.
 *   - `?workspace=<id>` present (any cardinality): that EXACT Workspace
 *     is independently revalidated via `resolveTeamRunWorkspaceAccess()`
 *     — a wrong/unrelated/unauthorized id is `notFound()`, never silently
 *     substituted for a different Workspace the caller does happen to
 *     belong to.
 *
 * Gate order (cheapest/most-restrictive first, mirroring
 * `GET /api/workspaces/{workspaceId}/review-queue`'s own documented
 * ordering): identity -> Approval Workflow admission (pure, zero I/O) ->
 * Team Workspace cardinality discovery (bounded) -> [chooser, if
 * ambiguous] -> Team Workspace access + capability check
 * (`resolveTeamRunWorkspaceAccess()`, reused verbatim, same as every
 * other Phase 9 route).
 *
 * Every ineligible case — unauthenticated, Approval Workflow not
 * admitted, no discoverable Team Workspace, an explicit `?workspace=`
 * the caller cannot access, Team Workspace access denied, or insufficient
 * capability — returns the IDENTICAL `notFound()`. The response gives a
 * non-canary authenticated user no signal distinguishing any one of these
 * from "this route doesn't exist," matching every existing Workspace
 * page's own concealment discipline. The multi-Workspace chooser is NOT
 * part of that concealment surface — it only ever renders once identity
 * and Approval Workflow admission have both already succeeded, and it
 * exposes nothing beyond Workspace names the caller is already an active
 * member of.
 *
 * This gate has zero effect on `GET /api/workspaces/{workspaceId}/review-queue`
 * or any other Phase 9 API — all are independent Route Handlers with
 * their own control flow, unaffected by this page's existence.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveViewerTeamWorkspaceSelection } from "@/lib/workspaces/resolveViewerTeamWorkspaceSelection";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import WorkspaceReviewQueueShell from "@/components/workspace/WorkspaceReviewQueueShell";
import WorkspaceReviewsChooser from "@/components/workspace/WorkspaceReviewsChooser";

export const dynamic = "force-dynamic";

function firstStringParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export default async function WorkspaceReviewsPage({ searchParams }: { searchParams: { [key: string]: string | string[] | undefined } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const admission = resolveApprovalWorkflowAdmission({ uid: identity.uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    notFound();
  }

  const explicitWorkspaceId = firstStringParam(searchParams.workspace);

  const selection = await resolveViewerTeamWorkspaceSelection(identity.uid);
  if (selection.kind === "none" || selection.kind === "lookup_failed") {
    notFound();
  }

  let targetWorkspaceId: string;
  if (explicitWorkspaceId) {
    // Independently revalidated below — an explicit id is never trusted
    // merely because SOME active membership exists (§9/§46: no fallback
    // to a different Workspace the caller happens to belong to).
    targetWorkspaceId = explicitWorkspaceId;
  } else if (selection.kind === "single") {
    targetWorkspaceId = selection.workspaceId;
  } else {
    // "multiple", no explicit selection: never silently pick one.
    return <WorkspaceReviewsChooser />;
  }

  const access = await resolveTeamRunWorkspaceAccess({ uid: identity.uid, workspaceId: targetWorkspaceId });
  if (!access.granted) {
    notFound();
  }
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) {
    notFound();
  }

  return <WorkspaceReviewQueueShell workspaceId={targetWorkspaceId} workspaceName={access.workspace.name} hasMultipleWorkspaces={selection.kind === "multiple"} />;
}
