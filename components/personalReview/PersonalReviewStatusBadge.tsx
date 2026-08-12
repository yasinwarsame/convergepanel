"use client";

/**
 * Personal Reviewer Inbox + Action Flow — status badge for the inbox's own
 * status vocabulary (Part 32): assigned/approved/approved_with_conditions/
 * changes_requested/rejected. Deliberately NOT humanReviewStatusLabel's
 * "unreviewed"/"pending" — "assigned" is a reviewer-inbox-specific label
 * for "this is yours to review," never a raw HumanReviewStatus value.
 * Never invents "In review" — no canonical started-reading state exists.
 */

import type { PersonalReviewInboxStatus } from "@/lib/governance/personalReviewInbox";

const LABELS: Record<PersonalReviewInboxStatus, string> = {
  assigned: "Assigned",
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

const TONE: Record<PersonalReviewInboxStatus, string> = {
  assigned: "bg-cp-raised text-cp-muted ring-1 ring-cp-border",
  approved: "bg-emerald-900/30 text-emerald-400 ring-1 ring-emerald-700/40",
  approved_with_conditions: "bg-emerald-900/30 text-emerald-400 ring-1 ring-emerald-700/40",
  changes_requested: "bg-amber-900/30 text-amber-400 ring-1 ring-amber-700/40",
  rejected: "bg-red-900/30 text-red-400 ring-1 ring-red-700/40",
};

export default function PersonalReviewStatusBadge({ status }: { status: PersonalReviewInboxStatus }) {
  return <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${TONE[status]}`}>{LABELS[status]}</span>;
}
