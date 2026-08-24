/**
 * Approval Workflow, Phase 9C.1 — `GET /workspace/reviews`, server-gated.
 * The first Phase 9 frontend surface. Read-only: no assignment, decision,
 * panel, override, or resubmission control exists anywhere behind this
 * page in this phase.
 *
 * Eligibility is settled BEFORE any Reviews UI renders — never a
 * client-side flash-then-hide, matching `/workspace` and
 * `/workspace/projects`'s own established gating pattern.
 *
 * Gate order (cheapest/most-restrictive first, mirroring
 * `GET /api/workspaces/{workspaceId}/review-queue`'s own documented
 * ordering): identity -> Approval Workflow admission (pure, zero I/O) ->
 * Team Workspace discovery (`resolveViewerTeamWorkspaceId()`, Phase
 * 9C.1's new discovery-only resolver — see its own doc comment) -> Team
 * Workspace access + capability check (`resolveTeamRunWorkspaceAccess()`,
 * reused verbatim, same as every other Phase 9 route).
 *
 * Every ineligible case — unauthenticated, Approval Workflow not
 * admitted, no discoverable Team Workspace, Team Workspace access denied,
 * or insufficient capability — returns the IDENTICAL `notFound()`. The
 * response gives a non-canary authenticated user no signal distinguishing
 * any one of these from "this route doesn't exist," matching every
 * existing Workspace page's own concealment discipline.
 *
 * This gate has zero effect on `GET /api/workspaces/{workspaceId}/review-queue`
 * or any other Phase 9 API — all are independent Route Handlers with
 * their own control flow, unaffected by this page's existence.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveViewerTeamWorkspaceId } from "@/lib/workspaces/resolveViewerTeamWorkspaceId";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import WorkspaceReviewQueueShell from "@/components/workspace/WorkspaceReviewQueueShell";

export const dynamic = "force-dynamic";

export default async function WorkspaceReviewsPage() {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const admission = resolveApprovalWorkflowAdmission({ uid: identity.uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    notFound();
  }

  const workspaceResult = await resolveViewerTeamWorkspaceId(identity.uid);
  if (workspaceResult.status !== "found") {
    notFound();
  }

  const access = await resolveTeamRunWorkspaceAccess({ uid: identity.uid, workspaceId: workspaceResult.workspaceId });
  if (!access.granted) {
    notFound();
  }
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) {
    notFound();
  }

  return <WorkspaceReviewQueueShell workspaceId={workspaceResult.workspaceId} />;
}
