"use client";

/**
 * Shared governance callout for research synthesis and claim verification surfaces.
 * Wraps OrgGovernanceStatusLine with a simpler prop shape.
 */

import {
  OrgGovernanceStatusLine,
  type OrgGovernanceEvalStatus,
} from "@/components/governance/OrgGovernanceStatusLine";

export type GovernanceBadgeProps = {
  status: string | OrgGovernanceEvalStatus | null | undefined;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewComment?: string | null;
  reviewerEmail?: string | null;
  theme?: "light" | "dark";
};

function normalizeStatus(
  status: GovernanceBadgeProps["status"]
): OrgGovernanceEvalStatus | null {
  if (status === "approved" || status === "needs_review" || status === "blocked") {
    return status;
  }
  return null;
}

export function GovernanceBadge({
  status,
  reviewedBy,
  reviewedAt,
  reviewComment,
  reviewerEmail,
  theme,
}: GovernanceBadgeProps) {
  const s = normalizeStatus(status);
  return (
    <OrgGovernanceStatusLine
      status={s}
      theme={theme}
      governanceReviewedByUid={reviewedBy ?? null}
      governanceReviewerEmail={reviewerEmail ?? null}
      governanceReviewedAt={reviewedAt ?? null}
      governanceReviewComment={reviewComment ?? null}
    />
  );
}
