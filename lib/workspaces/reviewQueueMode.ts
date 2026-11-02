/**
 * Order B, Stage B2 — which Approval Queue views use MERGED (governed + report-review) cursors under the current
 * rollout. Separate from reviewQueue.ts so the route's cursor-mode check never depends on that module's mocks.
 */
import { REPORT_REVIEW_ENABLED } from "./reportReviewRollout";
import type { ReviewQueueView } from "./reviewQueueCursor";

export function isMergedReviewQueueView(view: ReviewQueueView): boolean {
  return REPORT_REVIEW_ENABLED && (view === "needs_review" || view === "changes_requested" || view === "recently_approved");
}
