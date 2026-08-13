"use client";

/**
 * Personal reviewer experience navigation — every personal-review page
 * needs a way back to the main ConvergePanel application (Research/Verify
 * Claim/Verify Video/History), not just deeper into the review workflow.
 * Shared between `/reviews` (the inbox) and `/reviews/[runId]` (the
 * detail page) rather than two separate hardcoded links, so the two
 * surfaces can never drift on styling or destination.
 *
 * `showBackToReviews`: false on the inbox itself (there is no "reviews"
 * level above it to go back to — "Back to ConvergePanel" is the only,
 * primary link). true on the detail page, which keeps its existing
 * immediate-parent link ("Back to my reviews" -> /reviews) as the primary
 * action, with "Back to ConvergePanel" added as a secondary, muted link
 * in the same row — never replacing the existing hierarchy, never both
 * links pointing at the same destination.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

const LINK_CLASS = "inline-flex items-center gap-2 text-cp-text transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded";
const SECONDARY_LINK_CLASS = "text-cp-muted transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded";

export default function ReviewerNavigation({ showBackToReviews }: { showBackToReviews: boolean }) {
  return (
    <nav aria-label="Reviewer navigation" className="mb-6 flex flex-wrap items-center gap-3 text-sm font-medium">
      {showBackToReviews ? (
        <>
          <Link href="/reviews" className={LINK_CLASS}>
            <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
            Back to my reviews
          </Link>
          <span className="text-cp-faint" aria-hidden>
            &middot;
          </span>
          <Link href="/" className={SECONDARY_LINK_CLASS}>
            Back to ConvergePanel
          </Link>
        </>
      ) : (
        <Link href="/" className={LINK_CLASS}>
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          Back to ConvergePanel
        </Link>
      )}
    </nav>
  );
}
