"use client";

import PersonalReviewDetail from "@/components/personalReview/PersonalReviewDetail";

export default function ReviewDetailPage({ params }: { params: { runId: string } }) {
  return <PersonalReviewDetail runId={params.runId} />;
}
