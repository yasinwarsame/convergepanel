/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — `GET /workspace/team/{workspaceId}/audit`,
 * server-gated. Structural mirror of the Members page: eligibility settled
 * server-side via `resolveWorkspaceAccess()` + `audit.read` BEFORE any UI
 * renders, never a client-side flash-then-hide. This page's own gate is
 * UX only — the audit-events API independently re-authorizes every request.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";
// Static, identity-free deployment flags (D-4 §1: allowed in the server render).
import { WORKSPACE_GOVERNANCE_SUMMARY_ENABLED, WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function WorkspaceAuditLogPage({ params }: { params: { workspaceId: string } }) {
  return (
    <TeamWorkspacePage
      kind="audit"
      workspaceId={params.workspaceId}
      showGovernanceSummary={WORKSPACE_GOVERNANCE_SUMMARY_ENABLED}
      showReviewIntegrityMetrics={WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED}
    />
  );
}
