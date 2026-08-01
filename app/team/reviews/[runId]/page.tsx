"use client";

/**
 * Adaptive review detail (read-only) — Query-Routing Redesign, Phase 2A,
 * Step 7, Part E1.
 */

import AdaptiveReviewDetail from "@/components/teamGovernance/AdaptiveReviewDetail";

export default function TeamReviewDetailPage({ params }: { params: { runId: string } }) {
  return <AdaptiveReviewDetail runId={params.runId} />;
}
