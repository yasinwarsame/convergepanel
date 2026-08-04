"use client";

/**
 * Team review queue (read-only) — Query-Routing Redesign, Phase 2A,
 * Step 7, Part E1. A new System B interface, deliberately separate from
 * the existing System A Governance dashboard (/governance).
 */

import TeamReviewQueue from "@/components/teamGovernance/TeamReviewQueue";

export default function TeamReviewsPage() {
  return <TeamReviewQueue />;
}
