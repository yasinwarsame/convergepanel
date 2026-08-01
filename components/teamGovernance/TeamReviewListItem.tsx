"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — dispatches a
 * `TeamRunListItemV1` to its kind-specific renderer. Never renders a mixed
 * or untagged shape; every item is guaranteed (by the versioned contract)
 * to carry exactly one `kind`.
 */

import type { TeamRunListItemV1 } from "@/lib/governance/teamRunListContract";
import AdaptiveReviewListItem from "./AdaptiveReviewListItem";
import LegacyReviewListItem from "./LegacyReviewListItem";

export default function TeamReviewListItem({ item }: { item: TeamRunListItemV1 }) {
  if (item.kind === "adaptive") return <AdaptiveReviewListItem item={item} />;
  return <LegacyReviewListItem item={item} />;
}
