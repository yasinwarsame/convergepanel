/**
 * Order B, Stage B2 — which Approval Queue views use MERGED (governed + report-review) cursors under the current
 * rollout. Separate from reviewQueue.ts so the route's cursor-mode check never depends on that module's mocks.
 */
import { isReportReviewEnabledForWorkspace } from "./reportReviewActivation";
import type { ReviewQueueView } from "./reviewQueueCursor";

export function isMergedReviewQueueView(view: ReviewQueueView, workspaceId: string): boolean {
  return isReportReviewEnabledForWorkspace(workspaceId) && (view === "needs_review" || view === "changes_requested" || view === "recently_approved");
}
