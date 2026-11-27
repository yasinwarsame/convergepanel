/**
 * Approval Workflow, Phase 9C.1-R1C — `GET /workspace/reviews/[runId]`,
 * the new PERMANENT, Workspace-native, read-only run-detail route. This
 * is the corrected queue-row navigation target (see
 * `components/workspace/ReviewQueueRow.tsx`) — the previous target,
 * `/reviews/{runId}`, is the Personal reviewer surface and rejects every
 * Workspace viewer role; `/team/reviews/{runId}` is the separate legacy
 * Team namespace. Neither is reused here, for auth OR presentation.
 *
 * `WORKSPACE_REVIEW_DETAIL_ROUTE = /workspace/reviews/[runId]` is frozen
 * as the canonical Phase 9 Approval Workflow run-detail surface — 9C.2+
 * will add the real single-review/panel/override controls onto this SAME
 * route rather than migrating users to a new URL later.
 *
 * Gated exactly like `/workspace/reviews` itself (since ZCA L-3 the gate runs in the
 * bearer-authorized `GET /api/user/workspace-review-runs/[runId]`, not in this server render): identity ->
 * Approval Workflow admission (pure, passed through) -> `getWorkspaceRunDetail()`,
 * which independently resolves the run's OWN canonical `workspaceId` (never
 * a route/query param), revalidates Team Workspace access + `research.read`
 * from scratch, and — Phase 9C.4 — makes the actual normal-vs-drain
 * admission decision itself (mirroring `getReviewContext()`'s drain rule:
 * not-admitted is still admitted when an existing panel makes the run
 * drain-eligible). This page therefore does NOT 404 merely because Approval
 * Workflow admission failed — see `getWorkspaceRunDetail()`'s own doc
 * comment for the full rationale. Every denial path returns the identical
 * `notFound()` — no message ever reveals whether a run exists.
 */

import WorkspaceRunDetailClient from "@/components/workspace/WorkspaceRunDetailClient";

export const dynamic = "force-dynamic";

/**
 * ZCA L-3: a NEUTRAL shell. This server render resolves no identity and reads no cookie; it sends the
 * same markup to every visitor for every runId. The run's detail (and the 404 for every denial) comes
 * from the bearer-authorized `GET /api/user/workspace-review-runs/[runId]`, called by the client.
 */
export default function WorkspaceRunDetailPage({ params }: { params: { runId: string } }) {
  return <WorkspaceRunDetailClient runId={params.runId} />;
}
